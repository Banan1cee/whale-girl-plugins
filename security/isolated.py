"""Credential-less isolation gate for executable whale-plugin/1 levels.

Runs in a separate workflow job: no GitHub token, no secrets, no candidate
checkout, fixed OCI image and pinned host runtime. Fails closed when isolation,
the pinned runtime, or the verified harness is unavailable; it never silently
skips an executable level and never claims the plugin is safe.

Container result binding
------------------------
The container prints exactly one line:

    WHALE_ISOLATION_RESULT_V2 <json>

The JSON is HMAC-signed with a per-run secret that this module writes to the
container's stdin. The worker gets a fixed minimal environment, so normal plugin
code does not receive the secret. This binds the result to one run and rejects
tampered/mixed-up output; it is **not** a complete adversarial isolation claim:
candidate code runs under the same non-root uid and may still reach parent state
through OS-specific paths. The host therefore independently verifies package and
runtime hashes and revalidates every provider output schema. The host also
rejects duplicate markers, trailing text, oversized output and a result whose
subject (plugin id, version, level, manifest/entry SHA-256) does not match the
verified package.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile

SECURITY = Path(__file__).resolve().parent
ROOT = SECURITY.parent
DIGEST = re.compile(r'node:24-bookworm-slim@sha256:[a-f0-9]{64}', re.ASCII)
NAME = re.compile(r'[a-z][a-z0-9-]{0,47}-\d+\.\d+\.\d+(?:\.\d+)?\.zip', re.ASCII)
HASH = re.compile(r'[a-f0-9]{64}', re.ASCII)
RUNNABLE = (1, 2, 3, 4)
MARKER = 'WHALE_ISOLATION_RESULT_V2 '
MAX_STDOUT = 2 * 1024 * 1024
MAX_OUTPUT_JSON = 64 * 1024
CHECK_NAMES = ('schema', 'timeout', 'cancellation', 'revocation')
# The adapter itself must be covered by the pin. A pin that lacks any of these
# files cannot be flipped to verified without re-pinning and re-hashing.
HARNESS_FILES = (
    'src/services/capabilitySchema.js',
    'src/services/pluginProtocol.js',
    'src/services/pluginProtocolRegistry.json',
    'src/services/unifiedCapabilityDispatcher.js',
    'src/services/unifiedPluginRuntime.js',
    'src/services/unifiedPluginWorker.js',
    'src/services/unifiedWasm.js',
    'src/services/unifiedWasmWorker.js',
)


class Blocked(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def ascii_text(value, limit):
    """Mirror the adapter's safeText(): ASCII-only, let non-ASCII stay distinct."""
    text = value if isinstance(value, str) else ''
    cleaned = ''.join(ch if 0x20 <= ord(ch) <= 0x7e else '?' for ch in text)
    return cleaned[:limit]


def load_pin(path=None):
    source = path or SECURITY / 'plugin-runtime.json'
    try:
        pin = json.loads(source.read_text(encoding='utf-8'))
    except OSError:
        raise Blocked('runtime_pin_invalid', 'security/plugin-runtime.json is missing; isolation must fail closed')
    except ValueError:
        raise Blocked('runtime_pin_invalid', 'security/plugin-runtime.json is not valid JSON')
    if not isinstance(pin, dict):
        raise Blocked('runtime_pin_invalid', 'security/plugin-runtime.json must be an object')
    if not re.fullmatch(r'[a-f0-9]{40}', str(pin.get('commit', ''))):
        raise Blocked('runtime_pin_invalid', 'host runtime commit is not a full 40-character hash')
    image = pin.get('image')
    if not isinstance(image, str) or not DIGEST.fullmatch(image):
        raise Blocked('runtime_pin_invalid', 'container image is not pinned by digest')
    harness = pin.get('harness') or {}
    if not isinstance(harness, dict):
        raise Blocked('runtime_pin_invalid', 'harness policy must be an object')
    adapter = harness.get('adapter_sha256')
    if adapter is not None:
        if not isinstance(adapter, str) or not re.fullmatch(r'[a-f0-9]{64}', adapter):
            raise Blocked('runtime_pin_invalid', 'harness adapter hash is not SHA-256')
        adapter_path = SECURITY / 'harness' / 'run.cjs'
        try:
            actual = hashlib.sha256(adapter_path.read_bytes()).hexdigest()
        except OSError:
            actual = ''
        if actual != adapter:
            raise Blocked('harness_adapter_mismatch',
                          'pinned adapter hash does not match security/harness/run.cjs; re-verify and re-pin')
    if harness.get('state') != 'verified':
        raise Blocked('runtime_pin_pending', str(harness.get('reason') or 'isolated harness is not verified'))
    files = pin.get('files')
    if not isinstance(files, dict) or not files:
        raise Blocked('runtime_pin_invalid', 'pinned host runtime has no file hashes')
    missing = [name for name in HARNESS_FILES if name not in files]
    if missing:
        raise Blocked('runtime_pin_incomplete',
                      'pinned host runtime does not cover the isolation adapter file: ' + missing[0])
    return pin


def verify_runtime(runtime, pin):
    if runtime is None or not runtime.is_dir():
        raise Blocked('isolation_unavailable', 'pinned host runtime directory is missing')
    for name, digest in pin['files'].items():
        path = runtime / name
        if not path.is_file() or path.is_symlink():
            raise Blocked('runtime_pin_mismatch', 'missing pinned runtime file: ' + name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise Blocked('runtime_pin_mismatch', 'runtime file hash mismatch: ' + name)


def runtime_digest(pin):
    """The adapter prints the same digest from the bytes it re-hashed in-container."""
    pairs = [[name, pin['files'][name]] for name in sorted(pin['files'])]
    return hashlib.sha256(json.dumps(pairs, separators=(',', ':')).encode('ascii')).hexdigest()


def pinned_registry(runtime):
    path = runtime / 'src/services/pluginProtocolRegistry.json'
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise Blocked('runtime_pin_invalid', 'pinned runtime registry is missing or unreadable')


def verify_runtime_supports(entries, runtime, pin):
    """The ABI must actually be in the pin, not assumed from a newer local tree."""
    registry = pinned_registry(runtime)
    if not isinstance(registry, dict) or registry.get('format') != pin.get('protocol', 'whale-plugin/1'):
        raise Blocked('runtime_pin_abi_mismatch', 'pinned runtime registry format does not match the pin')
    providers = registry.get('providers')
    if not isinstance(providers, dict):
        raise Blocked('runtime_pin_abi_mismatch', 'pinned runtime registry has no providers')
    for entry in entries:
        for name in entry.get('provides') or []:
            if name not in providers:
                raise Blocked('runtime_pin_abi_mismatch',
                              'pinned runtime does not implement provider: ' + str(name))


def docker_available():
    try:
        subprocess.run(['docker', 'version', '--format', '{{.Server.Version}}'],
                       capture_output=True, timeout=20, check=True)
        return True
    except Exception:
        return False


def container_command(name, pin, package_dir, runtime, harness, timeout_ms):
    limits = pin.get('container') or {}
    pin_file = (SECURITY / 'plugin-runtime.json').resolve()
    return ['docker', 'run', '--rm', '--interactive', '--name', name,
            '--pull=never', '--platform', 'linux/amd64',
            '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--user', limits.get('user', '65534:65534'),
            '--pids-limit', str(limits.get('pids_limit', 64)),
            '--memory', limits.get('memory', '256m'), '--memory-swap', limits.get('memory', '256m'),
            '--cpus', limits.get('cpus', '0.5'),
            '--tmpfs', limits.get('tmpfs', '/tmp:rw,noexec,nosuid,size=16m'),
            '--mount', 'type=bind,src=%s,dst=/candidate,readonly' % package_dir.resolve(),
            '--mount', 'type=bind,src=%s,dst=/runtime,readonly' % runtime.resolve(),
            '--mount', 'type=bind,src=%s,dst=/harness,readonly' % harness.resolve(),
            '--mount', 'type=bind,src=%s,dst=/harness/plugin-runtime.json,readonly' % pin_file,
            '--env', 'HARNESS_TIMEOUT_MS=%d' % int(timeout_ms),
            pin['image'], 'node', '/harness/run.cjs']


def fetch_runtime(pin, destination, fetch=None):
    """Download the pinned host runtime as data and verify every hash.

    Runs in CI only, without a GitHub token. A mismatch blocks the gate; no
    candidate-provided URL or file is ever used here.
    """
    from urllib.request import Request, urlopen
    repository = pin.get('repository')
    commit = pin.get('commit')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', str(repository)) or not re.fullmatch(r'[a-f0-9]{40}', str(commit)):
        raise Blocked('runtime_pin_invalid', 'invalid pinned repository or commit')
    destination.mkdir(parents=True, exist_ok=True)
    for name, digest in pin['files'].items():
        if not isinstance(name, str) or name.startswith('/') or '..' in name.split('/'):
            raise Blocked('runtime_pin_invalid', 'unsafe pinned runtime path')
        url = 'https://raw.githubusercontent.com/%s/%s/%s' % (repository, commit, name)
        if fetch is not None:
            data = fetch(url, 4 * 1024 * 1024)
        else:
            with urlopen(Request(url, headers={'User-Agent': 'WhaleGirl-Market-Isolation'}), timeout=30) as response:
                data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise Blocked('runtime_pin_mismatch', 'pinned runtime file too large: ' + name)
        if hashlib.sha256(data).hexdigest() != digest:
            raise Blocked('runtime_pin_mismatch', 'runtime file hash mismatch: ' + name)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return destination


def safe_env():
    # 只给 Docker 客户端本身需要的变量；不传 GH token、密钥或仓库凭据。
    return {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME') if key in os.environ}


def verify_package_set(entries, packages):
    """Report entries and the verified package directory must describe the same bytes.

    A subset is allowed because push/main only isolates the changed packages.
    Every expected file must be present with the recorded hash; the directory
    must contain no symlinks/non-regular entries, and duplicate report entries
    are refused instead of silently collapsing to one ZIP.
    """
    if not isinstance(entries, list) or not entries:
        raise Blocked('entries_missing', 'submission report has no entries')
    if not packages.is_dir():
        raise Blocked('invalid_package', 'verified package directory is missing')
    expected = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise Blocked('invalid_package', 'report entry is not an object')
        name = '%s-%s.zip' % (entry.get('id'), entry.get('version'))
        if not NAME.fullmatch(name):
            raise Blocked('invalid_package', 'report entry has an unsafe package name')
        if name in expected:
            raise Blocked('invalid_package', 'report contains a duplicate entry: ' + name)
        digest = entry.get('sha256')
        if not isinstance(digest, str) or not HASH.fullmatch(digest):
            raise Blocked('invalid_package', 'report entry has no package sha256')
        expected[name] = digest
    for item in packages.iterdir():
        if item.is_symlink() or not item.is_file():
            raise Blocked('invalid_package', 'package directory contains a non-regular entry: ' + item.name)
    for name, digest in expected.items():
        path = packages / name
        if not path.is_file() or path.is_symlink():
            raise Blocked('invalid_package', 'verified package artifact is missing: ' + name)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise Blocked('package_hash_mismatch', 'package bytes differ from the static gate report: ' + name)


def extract_package(package, destination):
    from zipfile import ZipFile
    with ZipFile(package) as archive:
        names = archive.namelist()
        if len(set(names)) != len(names):
            raise Blocked('invalid_package', 'duplicate ZIP entries are forbidden')
        entry_name = next((name for name in names if name != 'plugin.json'), '')
        if len(names) != 2 or 'plugin.json' not in names or not entry_name or '/' in entry_name or '\\' in entry_name:
            raise Blocked('invalid_package', 'package must contain exactly plugin.json and one flat entry file')
        for item in archive.infolist():
            if item.flag_bits & 1 or (item.external_attr >> 16) & 0o170000 in (0o120000, 0o040000):
                raise Blocked('invalid_package', 'encrypted files, symlinks and directories are forbidden')
            target = destination / item.filename
            if destination not in target.parents:
                raise Blocked('invalid_package', 'unsafe ZIP entry path')
            target.write_bytes(archive.read(item.filename))
    return destination


def _json_equal(left, right):
    return json.dumps(left, ensure_ascii=False, sort_keys=True, separators=(',', ':')) == \
        json.dumps(right, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _matches_type(value, kind):
    if isinstance(kind, list):
        return any(_matches_type(value, item) for item in kind)
    if kind == 'object':
        return isinstance(value, dict)
    if kind == 'array':
        return isinstance(value, list)
    if kind == 'string':
        return isinstance(value, str)
    if kind == 'integer':
        return type(value) is int
    if kind == 'number':
        return type(value) in (int, float)
    if kind == 'boolean':
        return type(value) is bool
    if kind == 'null':
        return value is None
    if kind == 'json':
        return True
    return False


def matches_schema(value, schema, registry, depth=0):
    """Host-side copy of the capability schema rules; candidate never supplies it."""
    if depth > 16:
        return False
    if isinstance(schema, str):
        if schema == 'json':
            return True
        named = (registry.get('schemas') or {}).get(schema)
        return named is not None and matches_schema(value, named, registry, depth + 1)
    if not isinstance(schema, dict):
        return False
    ref = schema.get('$ref')
    if ref is not None:
        name = str(ref).replace('#/schemas/', '', 1)
        named = (registry.get('schemas') or {}).get(name)
        return named is not None and matches_schema(value, named, registry, depth + 1)
    kind = schema.get('type')
    if isinstance(kind, list):
        return any(_matches_type(value, item) for item in kind)
    if not _matches_type(value, kind):
        return False
    if 'const' in schema and not _json_equal(value, schema['const']):
        return False
    if isinstance(schema.get('enum'), list) and not any(_json_equal(value, item) for item in schema['enum']):
        return False
    if isinstance(value, str):
        length = len(value)
        if isinstance(schema.get('minLength'), int) and length < schema['minLength']:
            return False
        if isinstance(schema.get('maxLength'), int) and length > schema['maxLength']:
            return False
    if type(value) is int or type(value) is float:
        if isinstance(schema.get('minimum'), (int, float)) and value < schema['minimum']:
            return False
        if isinstance(schema.get('maximum'), (int, float)) and value > schema['maximum']:
            return False
    if isinstance(value, list):
        if isinstance(schema.get('minItems'), int) and len(value) < schema['minItems']:
            return False
        if isinstance(schema.get('maxItems'), int) and len(value) > schema['maxItems']:
            return False
        if 'items' in schema and any(not matches_schema(item, schema['items'], registry, depth + 1) for item in value):
            return False
    if isinstance(value, dict):
        required = schema.get('required')
        if isinstance(required, list) and any(key not in value for key in required):
            return False
        props = schema.get('properties') if isinstance(schema.get('properties'), dict) else {}
        if schema.get('additionalProperties') is False and any(key not in props for key in value):
            return False
        for key, child in props.items():
            if key in value and not matches_schema(value[key], child, registry, depth + 1):
                return False
    return True


def parse_harness_stdout(stdout):
    if not isinstance(stdout, str):
        raise Blocked('isolation_failed', 'isolated runtime returned no textual result')
    if len(stdout.encode('utf-8', 'replace')) > MAX_STDOUT:
        raise Blocked('isolation_failed', 'isolated runtime output exceeds limit')
    if stdout.count(MARKER) != 1:
        raise Blocked('isolation_output_unauthenticated',
                      'isolated runtime did not produce exactly one authenticated result line')
    raw = stdout.split(MARKER, 1)[1].strip()
    try:
        outcome = json.loads(raw)
    except ValueError:
        raise Blocked('isolation_failed', 'isolated runtime did not return a single JSON result')
    if not isinstance(outcome, dict) or outcome.get('schema') != 2:
        raise Blocked('isolation_failed', 'isolated runtime result has an unsupported schema')
    return outcome


def mac_text(outcome, secret):
    subject = outcome.get('subject') if isinstance(outcome.get('subject'), dict) else {}
    checks = outcome.get('checks') if isinstance(outcome.get('checks'), dict) else {}
    providers = outcome.get('providers') if isinstance(outcome.get('providers'), list) else []
    level = subject.get('level')
    rows = ','.join(ascii_text(row.get('name'), 64) + '='
                    + ('ok:' + ascii_text(row.get('outputSha256'), 64) if row.get('ok') is True else 'fail:')
                    for row in providers if isinstance(row, dict))
    return '\n'.join([
        'whale-isolation/2',
        hashlib.sha256(secret.encode('utf-8')).hexdigest(),
        ascii_text(outcome.get('status'), 16),
        ascii_text(outcome.get('code'), 64),
        ascii_text(subject.get('id'), 48),
        ascii_text(subject.get('version'), 32),
        str(level) if type(level) is int else '',
        ascii_text(subject.get('manifestSha256'), 64),
        ascii_text(subject.get('entrySha256'), 64),
        ascii_text(outcome.get('runtime_digest'), 64),
        rows,
        ''.join('1' if checks.get(name) is True else '0' for name in CHECK_NAMES),
    ])


def verify_auth(outcome, secret):
    auth = outcome.get('auth')
    if not isinstance(auth, dict) or auth.get('algo') != 'hmac-sha256':
        raise Blocked('isolation_output_unauthenticated', 'isolated result is missing its HMAC envelope')
    nonce_hash = hashlib.sha256(secret.encode('utf-8')).hexdigest()
    if auth.get('nonceHash') != nonce_hash:
        raise Blocked('isolation_output_unauthenticated', 'isolated result was signed for a different run')
    expected = hmac.new(secret.encode('utf-8'), mac_text(outcome, secret).encode('utf-8'),
                        hashlib.sha256).hexdigest()
    mac = auth.get('mac')
    if not isinstance(mac, str) or not hmac.compare_digest(mac, expected):
        raise Blocked('isolation_output_unauthenticated',
                      'isolated result signature does not match its content')


def verify_outcome(outcome, secret, entry, source, pin, registry=None):
    """Bind the authenticated container result to the package the static gate verified.

    The host revalidates every provider output schema from the pinned registry and
    checks the exact output digest included in the signed result. This keeps the
    schema verdict on the trusted host instead of trusting the container's own
    dispatcher report.
    """
    registry = registry if isinstance(registry, dict) else {}
    if not isinstance(outcome.get('auth'), dict) and outcome.get('status') == 'blocked' \
            and outcome.get('code') == 'harness_secret_invalid':
        # stdin delivery failed; this is the one unsigned blocked code the adapter
        # can produce. It can only deny, never pass.
        raise Blocked('harness_secret_invalid', 'container could not receive the per-run isolation secret')
    verify_auth(outcome, secret)
    if outcome.get('status') != 'passed':
        detail = ascii_text(outcome.get('code') or 'blocked', 64)
        reason = ascii_text(outcome.get('reason'), 160)
        raise Blocked('isolation_blocked', (detail + ': ' + reason).strip(': '))
    subject = outcome.get('subject')
    if not isinstance(subject, dict):
        raise Blocked('isolation_subject_mismatch', 'isolated result has no subject binding')
    for key, expected in (('id', entry.get('id')), ('version', entry.get('version')),
                          ('level', entry.get('level')), ('entry', entry.get('entry'))):
        if subject.get(key) != expected:
            raise Blocked('isolation_subject_mismatch', 'isolated result subject does not match the report entry: ' + key)
    manifest = source / 'plugin.json'
    if not manifest.is_file() or manifest.is_symlink():
        raise Blocked('invalid_package', 'extracted package has no regular plugin.json')
    if subject.get('manifestSha256') != hashlib.sha256(manifest.read_bytes()).hexdigest():
        raise Blocked('isolation_subject_mismatch', 'isolated result is bound to a different manifest')
    entry_path = source / str(entry.get('entry'))
    if not entry_path.is_file() or entry_path.is_symlink():
        raise Blocked('invalid_package', 'extracted package has no regular entry file')
    if subject.get('entrySha256') != hashlib.sha256(entry_path.read_bytes()).hexdigest():
        raise Blocked('isolation_subject_mismatch', 'isolated result is bound to a different entry file')
    if outcome.get('runtime_digest') != runtime_digest(pin):
        raise Blocked('runtime_pin_mismatch', 'isolated result was produced by a different runtime pin')
    providers = outcome.get('providers')
    if not isinstance(providers, list):
        raise Blocked('isolation_failed', 'isolated result has no provider results')
    names = sorted(ascii_text(row.get('name'), 64) for row in providers if isinstance(row, dict))
    expected_names = sorted(entry.get('provides') or [])
    if len(providers) != len(names) or names != expected_names:
        raise Blocked('isolation_subject_mismatch', 'isolated provider set does not match the declared providers')
    declared = (registry.get('providers') or {}) if isinstance(registry.get('providers'), dict) else {}
    for row in providers:
        if not isinstance(row, dict):
            raise Blocked('isolation_failed', 'isolated provider result is not an object')
        name = ascii_text(row.get('name'), 64)
        if row.get('ok') is not True:
            raise Blocked('isolation_blocked', 'declared provider did not pass: ' + name)
        raw = row.get('outputJson')
        digest = row.get('outputSha256')
        if not isinstance(raw, str) or not isinstance(digest, str) or not HASH.fullmatch(digest):
            raise Blocked('isolation_subject_mismatch', 'provider output is not bound to the package: ' + name)
        encoded = raw.encode('utf-8')
        if len(encoded) > MAX_OUTPUT_JSON or hashlib.sha256(encoded).hexdigest() != digest:
            raise Blocked('isolation_output_unauthenticated', 'provider output digest does not match: ' + name)
        try:
            value = json.loads(raw)
        except ValueError:
            raise Blocked('invalid_capability_output', 'provider output is not valid JSON: ' + name)
        rule = declared.get(name)
        if not isinstance(rule, dict):
            raise Blocked('runtime_pin_abi_mismatch', 'pinned runtime has no provider schema: ' + name)
        if not matches_schema(value, rule.get('outputSchema'), registry):
            raise Blocked('invalid_capability_output', 'provider output fails the pinned schema: ' + name)
    checks = outcome.get('checks')
    if not isinstance(checks, dict) or not all(checks.get(name) is True for name in CHECK_NAMES):
        raise Blocked('isolation_checks_failed', 'timeout/cancellation/revocation checks did not all pass')
    return {'id': entry.get('id'), 'version': entry.get('version'), 'level': entry.get('level'),
            'status': 'passed', 'sha256': entry.get('sha256'), 'manifestSha256': entry.get('manifestSha256'),
            'isolation': 'container-no-network-read-only', 'host_commit': pin['commit'],
            'image': pin['image'], 'runtime_digest': runtime_digest(pin),
            'providers': [ascii_text(row.get('name'), 64) for row in providers if isinstance(row, dict)],
            'scope': 'Synthetic isolated run; not an antivirus certification'}


def isolate(entries, packages, runtime, pin=None, docker=docker_available, run=subprocess.run):
    if not isinstance(entries, list) or not entries:
        raise Blocked('entries_missing', 'submission report has no entries; refusing an empty isolation pass')
    verify_package_set(entries, packages)
    runnable = [entry for entry in entries if entry.get('level') in RUNNABLE]
    if not runnable:
        # 纯静态/主题投稿不接触容器，也不需要 pending pin；先证明包集合一致即可。
        return {'status': 'passed', 'reason': 'no executable levels in this submission (all static)', 'entries': []}
    pin = load_pin() if pin is None else pin
    if not docker():
        raise Blocked('isolation_unavailable', 'Docker is unavailable; executable levels must not run on the host')
    verify_runtime(runtime, pin)
    verify_runtime_supports(runnable, runtime, pin)
    registry = pinned_registry(runtime)
    harness = SECURITY / 'harness'
    results = []
    for index, entry in enumerate(runnable):
        if not entry.get('provides'):
            raise Blocked('invalid_report', 'executable report entry declares no providers')
        filename = str(entry.get('package', '')).split('/')[-1]
        if not NAME.fullmatch(filename):
            raise Blocked('invalid_package', 'package artifact name is not a fixed-version market ZIP')
        package = packages / filename
        if not package.is_file() or package.is_symlink():
            raise Blocked('invalid_package', 'verified package artifact is missing: ' + filename)
        digest = str(entry.get('sha256') or '')
        if not HASH.fullmatch(digest) or hashlib.sha256(package.read_bytes()).hexdigest() != digest:
            raise Blocked('package_hash_mismatch', 'package bytes changed after the static gate: ' + filename)
        secret = secrets.token_hex(32)
        name = 'whale-plugin-isolation-' + hashlib.sha256(
            f"{entry.get('id')}:{entry.get('version')}:{secret}".encode()).hexdigest()[:16]
        with tempfile.TemporaryDirectory(prefix='whale-isolated-') as directory:
            source = Path(directory) / 'candidate'
            source.mkdir()
            extract_package(package, source)
            limits = pin.get('container') or {}
            timeout = int(entry.get('executionTimeoutMs') or limits.get('timeout_ms') or 60000)
            command = container_command(name, pin, source, runtime, harness, timeout)
            try:
                child = run(command, capture_output=True, text=True, timeout=min(180, max(10, timeout // 1000 + 30)),
                            env=safe_env(), input=secret + '\n')
            except subprocess.TimeoutExpired:
                raise Blocked('isolation_timeout', 'isolated container timed out for ' + str(entry.get('id')))
            except OSError as error:
                raise Blocked('isolation_unavailable', 'isolated container could not start: ' + str(error)[:120])
            finally:
                subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15, env=safe_env())
            if child.returncode != 0:
                tail = ascii_text((child.stderr or child.stdout or ''), 160)
                raise Blocked('isolation_failed', 'isolated runtime exited with an error: ' + tail)
            outcome = parse_harness_stdout(child.stdout)
            results.append(verify_outcome(outcome, secret, entry, source, pin, registry))
    return {'status': 'passed', 'entries': results}


def reported_entries(report):
    """PRs report every entry; push/main only reports the changed packages."""
    entries = report.get('entries') or []
    if not isinstance(entries, list) or not all(isinstance(entry, dict) for entry in entries):
        raise Blocked('invalid_report', 'static report entries must be a list of objects')
    subjects = report.get('subjects')
    if subjects is None:
        return entries
    if not isinstance(subjects, list) or not subjects:
        raise Blocked('invalid_report', 'submission report has no attested subjects')
    by_name = {}
    for entry in entries:
        by_name['%s-%s.zip' % (entry.get('id'), entry.get('version'))] = entry
    selected, seen = [], set()
    for item in subjects:
        if not isinstance(item, dict):
            raise Blocked('invalid_report', 'subject list contains a non-object')
        raw = str(item.get('path') or '')
        name = raw.rsplit('/', 1)[-1]
        if '/' in name or '\\' in name or not NAME.fullmatch(name):
            raise Blocked('invalid_report', 'subject name is not a fixed-version market ZIP')
        if name in seen:
            raise Blocked('invalid_report', 'duplicate subject in the static report: ' + name)
        seen.add(name)
        entry = by_name.get(name)
        if entry is None:
            raise Blocked('invalid_report', 'subject is not among the report entries: ' + name)
        if item.get('sha256') != entry.get('sha256'):
            raise Blocked('invalid_report', 'subject hash differs from the report entry: ' + name)
        selected.append(entry)
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--packages', required=True, type=Path)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--fetch-runtime', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding='utf-8'))
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    result = {'schema': 1, 'status': 'failed', 'entries': [],
              'scope': 'Isolated execution only; not an antivirus certification'}
    code = 1
    try:
        if report.get('status') != 'passed':
            raise Blocked('static_gate_failed', 'static gate did not pass; isolation is not attempted')
        if report.get('mode') != 'submission':
            result.update(status='skipped', reason='maintenance change has no executable plugin entries')
            code = 0
        else:
            entries = reported_entries(report)
            if not entries:
                raise Blocked('entries_missing', 'submission report has no entries; refusing an empty isolation pass')
            verify_package_set(entries, args.packages)
            runnable = [entry for entry in entries if entry.get('level') in RUNNABLE]
            if not runnable:
                # 主题/纯静态投稿不能因为尚未验证的可执行 harness 被挡住。
                result.update(status='passed', reason='no executable levels in this submission (all static)', entries=[])
                code = 0
            else:
                pin = load_pin()
                runtime = args.runtime
                if args.fetch_runtime is not None:
                    runtime = fetch_runtime(pin, args.fetch_runtime)
                outcome = isolate(entries, args.packages, runtime, pin)
                result.update(outcome)
                code = 0
    except Blocked as error:
        result.update(status='blocked', error={'code': error.code, 'message': str(error)[:300]})
        code = 2
    finally:
        (output / 'isolation-report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n',
                                                       encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == '__main__':
    sys.exit(main())
