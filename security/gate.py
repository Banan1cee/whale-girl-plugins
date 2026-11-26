"""Trusted static gate for whale-plugin/1 market submissions.

Runs from the trusted base checkout only. The candidate branch is downloaded as
data (market JSON/ZIP/README/image bytes) into a temporary directory; no
candidate script, workflow, validator, build tool or test is executed/imported.

v5 entries are derived from candidate `plugins/` + `packages/` with the trusted
base `scripts/build-index.js`; a candidate-supplied `index-v5.json` is never
trusted. Isolation of executable levels happens later in a separate job with no
token, no secrets and no candidate checkout.

Not an antivirus result; never claims a plugin is harmless.
"""
import argparse
import contextlib
import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from io import BytesIO
from urllib.error import HTTPError, URLError
from zipfile import ZipFile

TRUSTED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRUSTED))
sys.path.insert(0, str(TRUSTED / 'security'))
from audit import COMMIT, REPOSITORY, api, fetch, json_data, referenced_packages, safe_path, snapshot  # noqa: E402

CATALOG = 'index-v5.json'
PACKAGE_NAME = re.compile(r'([a-z][a-z0-9-]{0,47})-(\d+\.\d+\.\d+(?:\.\d+)?)\.zip', re.ASCII)
PACKAGE_PATH = re.compile(r'packages/([a-z][a-z0-9-]{0,47})-(\d+\.\d+\.\d+(?:\.\d+)?)\.zip', re.ASCII)
ALLOWED_DATA = re.compile(r'(plugins/[a-z][a-z0-9-]{0,47}/|packages/|provenance/|discussion-issues\.json$|index-v5\.json$)', re.ASCII)
MAINTENANCE = re.compile(r'(security/|\.github/|docs/|scripts/|examples/|README\.md$|AGENTS\.md$|validate\.py$|test_validate\.py$|protocol\.json$|index[^/]*\.json$)', re.ASCII)
MAX_FILES = 500
LEVELS = {0: 'static', 1: 'wasm', 2: 'wasm', 3: 'wasm', 4: 'javascript'}


class GateError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def check(condition, code, message):
    if not condition:
        raise GateError(code, message)


@contextlib.contextmanager
def temp_root():
    """Workspace-configurable scratch dir; never a privileged or candidate path."""
    base = Path(os.environ.get('MARKET_GATE_TMP') or tempfile.gettempdir())
    work = base / ('whale-gate-' + uuid.uuid4().hex)
    work.mkdir(parents=True)
    try:
        yield work
    finally:
        shutil.rmtree(work, ignore_errors=True)


def safe_env():
    # 只给 Python/Node 本身需要的变量；不传 GH_READ_TOKEN、密钥或仓库凭据。
    return {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP', 'PYTHONUTF8') if key in os.environ}


def validator(root):
    """Run the trusted base validator against candidate data only."""
    command = [sys.executable, str(TRUSTED / 'validate.py'), '--root', str(root), '--json']
    try:
        child = subprocess.run(command, cwd=str(TRUSTED), capture_output=True, text=True, timeout=300, env=safe_env())
    except subprocess.TimeoutExpired:
        raise GateError('validator_timeout', 'trusted validator timed out')
    except OSError as error:
        raise GateError('validator_unavailable', 'trusted validator could not start: %s' % error)
    try:
        data = json.loads(child.stdout)
    except ValueError:
        raise GateError('validator_interface_not_ready',
                        'validate.py --root/--json is not available; refusing to parse human logs or run candidate code')
    check(isinstance(data, dict) and isinstance(data.get('entries'), list) and isinstance(data.get('ok'), bool),
          'validator_interface_not_ready', 'validator JSON is missing ok/entries')
    return data


def generate_index(root):
    """Derive index-v5 from candidate plugins/+packages with trusted base code.

    The candidate's own index-v5.json is deleted first and never trusted.
    """
    (root / CATALOG).unlink(missing_ok=True)
    script = TRUSTED / 'scripts/build-index.js'
    check(script.is_file(), 'trusted_build_missing', 'trusted scripts/build-index.js is missing')
    try:
        child = subprocess.run(['node', str(script), '--root', str(root), '--out', str(root)],
                               cwd=str(root), capture_output=True, text=True,
                               timeout=180, env=safe_env())
    except subprocess.TimeoutExpired:
        raise GateError('index_generation_timeout', 'trusted index generation timed out')
    except OSError as error:
        raise GateError('index_generation_failed', 'node is required to derive index-v5: %s' % error)
    check(child.returncode == 0, 'index_generation_failed',
          'trusted build-index failed: ' + ((child.stderr or child.stdout or '').strip()[-240:]))
    check((root / CATALOG).is_file() and not (root / CATALOG).is_symlink(),
          'index_generation_failed', 'trusted build-index did not produce index-v5.json')


def trusted_protocol(base_repo, commit):
    """protocol.json comes from the trusted base commit, never from the candidate."""
    check(REPOSITORY.fullmatch(base_repo) and COMMIT.fullmatch(commit), 'invalid_target', 'invalid policy target')
    try:
        raw = fetch(f'https://raw.githubusercontent.com/{base_repo}/{commit}/protocol.json', 256 * 1024)
        data = json_data(raw)
    except (HTTPError, URLError, OSError, ValueError) as error:
        raise GateError('protocol_policy_missing',
                        'trusted base protocol.json is missing or unreadable: %s' % str(error)[:120])
    registry = data.get('registry') if isinstance(data.get('registry'), dict) else data
    check(isinstance(registry, dict) and isinstance(registry.get('levels'), dict)
          and isinstance(registry.get('limits'), dict)
          and registry.get('format') in (None, 'whale-plugin/1'),
          'protocol_policy_missing', 'trusted base protocol.json lacks levels/limits or has a foreign format')
    return {'levels': registry['levels'], 'limits': registry['limits'], 'manifest': registry.get('manifest') or {}}


def read_changed_files(path):
    if path is None:
        return None
    raw = json_data(path.read_text(encoding='utf-8'))
    check(isinstance(raw, list) and len(raw) <= MAX_FILES, 'change_too_large', 'invalid or oversized changed-file list')
    paths = []
    for item in raw:
        name = item.get('filename') if isinstance(item, dict) else None
        safe_path(name)
        status = item.get('status') if isinstance(item, dict) else None
        check(status in ('added', 'modified', 'removed', 'renamed', 'copied', 'changed'), 'invalid_compare',
              'invalid changed-file status')
        paths.append((name, 'removed' if status == 'removed' else status))
    return paths


def compare_paths(base_repo, base, ref):
    if base is None:
        return None
    check(REPOSITORY.fullmatch(base_repo) and COMMIT.fullmatch(base) and COMMIT.fullmatch(ref),
          'invalid_target', 'invalid repository/commit')
    try:
        data = api(f'repos/{base_repo}/compare/{base}...{ref}')
    except Exception as error:  # fork commits are not comparable on the base repo
        raise GateError('compare_unavailable',
                        'changed-file list is required for this PR (fork compare failed: %s)' % str(error)[:120])
    files = data.get('files')
    check(isinstance(files, list), 'invalid_compare', 'compare API returned no file list')
    check(len(files) <= MAX_FILES, 'change_too_large', 'too many changed files for one submission')
    return [(item['filename'], 'removed' if item.get('status') == 'removed' else item.get('status'))
            for item in files if safe_path(item.get('filename'))]


def _deletion_objection(path, referenced, root):
    """已发布数据默认不可删；只有候选里没有任何目录再引用时才放行。

    plugins/ 下的源码仍然一律不可删（删源码不等于撤回，属于丢实现）。
    """
    if path.startswith('plugins/'):
        return 'published plugin source cannot be deleted in a submission: ' + path
    if root is None:
        return 'published plugin data cannot be deleted without candidate data: ' + path
    if path.startswith('packages/'):
        if Path(path).name in referenced:
            return 'published package is still referenced and cannot be deleted: ' + path
        return None
    package = Path(path).with_suffix('.zip').name
    if package in referenced or (root / 'packages' / package).exists():
        return 'published provenance cannot be deleted while its package is still referenced: ' + path
    return None


def classify(paths, root=None):
    if paths is None:
        return 'maintenance'
    data = [path for path, _ in paths if ALLOWED_DATA.search(path)]
    maintenance = [path for path, _ in paths if MAINTENANCE.search(path) and not ALLOWED_DATA.search(path)]
    unknown = [path for path, _ in paths if path not in data and path not in maintenance]
    if unknown:
        raise GateError('outside_allowed_scope', 'changed path outside submission scope: ' + unknown[0])
    if data and maintenance:
        raise GateError('mixed_change_scope', 'plugin submission and repository maintenance must be separate pull requests')
    removed = [(path, status) for path, status in paths
               if status == 'removed' and re.match(r'(packages/|provenance/|plugins/)', path)]
    if removed:
        referenced = referenced_packages(root) if root is not None else set()
        for path, _ in removed:
            objection = _deletion_objection(path, referenced, root)
            if objection:
                raise GateError('deletion_forbidden', objection)
    return 'submission' if data else 'maintenance'


def base_entries(root):
    if not (root / CATALOG).exists():
        return {}
    data = validator(root)
    return {(entry.get('id'), entry.get('version')): entry for entry in data['entries']}


def immutable(candidate_entries, base_root, root=None):
    if base_root is None:
        return
    if root is not None:
        # 与 classify 同一套规则的第二道闸：base 里已发布的包/溯源只有在候选
        # 任何目录都不再引用时才允许消失。
        referenced = referenced_packages(root)
        for old in (base_root / 'packages').glob('*.zip'):
            if (root / 'packages' / old.name).is_file():
                continue
            if old.name in referenced:
                raise GateError('deletion_forbidden',
                                'published package is still referenced and cannot be deleted: ' + old.name)
        for old in (base_root / 'provenance').glob('*.json'):
            if (root / 'provenance' / old.name).is_file():
                continue
            package = old.name[:-len('.json')] + '.zip'
            if package in referenced or (root / 'packages' / package).exists():
                raise GateError('deletion_forbidden',
                                'published provenance cannot be deleted while its package is still referenced: ' + old.name)
    old = base_entries(base_root)
    for entry in candidate_entries:
        key = (entry.get('id'), entry.get('version'))
        before = old.get(key)
        if before and before.get('sha256') != entry.get('sha256'):
            raise GateError('immutable_version', 'same id/version cannot replace a published package')
        for other, published in old.items():
            if other[0] == entry['id']:
                def parts(value):
                    return tuple(int(piece) for piece in str(value).split('.'))
                if parts(entry['version']) < parts(published['version']):
                    raise GateError('version_rollback', 'version rollback is forbidden')


def verify_package(root, entry):
    name = entry.get('package')
    check(isinstance(name, str) and PACKAGE_PATH.fullmatch(name), 'invalid_entry', 'invalid package path')
    file = root / name
    check(file.is_file() and not file.is_symlink(), 'invalid_package', 'package must be an ordinary file')
    data = file.read_bytes()
    check(len(data) <= 16 * 1024 * 1024, 'package_too_large', 'package exceeds 16 MiB')
    check(len(data) == entry.get('packageBytes'), 'package_size_mismatch', 'package size differs from catalog')
    check(hashlib.sha256(data).hexdigest() == entry.get('sha256'), 'package_hash_mismatch',
          'package sha256 differs from catalog')
    wanted = ['plugin.json', entry.get('entry')]
    with ZipFile(BytesIO(data)) as package:
        names = package.namelist()
        check(sorted(names) == sorted(wanted), 'unexpected_zip_entries',
              'package must contain exactly plugin.json and the entry file')
        check(len(set(names)) == len(names), 'duplicate_zip_entry', 'duplicate ZIP entries are forbidden')
        for item in package.infolist():
            check(not item.flag_bits & 1, 'encrypted_zip_entry', 'encrypted ZIP entries are forbidden')
            check((item.external_attr >> 16) & 0o170000 != 0o120000, 'symlink_zip_entry', 'symlink entries are forbidden')
        manifest = package.read('plugin.json')
        check(len(manifest) <= 32768, 'manifest_too_large', 'manifest exceeds protocol limit')
        check(hashlib.sha256(manifest).hexdigest() == entry.get('manifestSha256'),
              'manifest_hash_mismatch', 'manifest sha256 differs from catalog')
    return data


def verify_entries(root, data, policy_data):
    entries = []
    levels = policy_data['levels']
    ids = set()
    for entry in data['entries']:
        check(isinstance(entry, dict), 'invalid_entry', 'invalid entry')
        level = entry.get('level')
        check(type(level) is int and str(level) in levels, 'invalid_level', 'level is not declared in protocol.json')
        check(entry.get('runtime') == levels[str(level)].get('runtime'), 'runtime_mismatch',
              'runtime does not match protocol level')
        check(entry.get('entry') == levels[str(level)].get('entry'), 'entry_mismatch',
              'entry file does not match protocol level')
        check(entry.get('id') not in ids, 'duplicate_id', 'duplicate plugin id')
        ids.add(entry.get('id'))
        verify_package(root, entry)
        entries.append({'id': entry['id'], 'version': entry['version'], 'level': level,
                        'runtime': entry['runtime'], 'entry': entry['entry'],
                        'package': entry['package'], 'sha256': entry['sha256'],
                        'manifestSha256': entry['manifestSha256'],
                        'packageBytes': entry['packageBytes'],
                        'provides': entry.get('provides', []), 'calls': entry.get('calls', []),
                        'dataAccess': entry.get('dataAccess', []),
                        'scan': LEVELS[level]})
    return entries


def subjects(output, entries, root, reported=None):
    """copy every verified package for isolation; signature list may be a subset."""
    directory = output / 'attest-subjects'
    directory.mkdir(parents=True, exist_ok=True)
    verified = output / 'verified-packages'
    verified.mkdir(parents=True, exist_ok=True)
    for entry in entries:
        (verified / f"{entry['id']}-{entry['version']}.zip").write_bytes((root / entry['package']).read_bytes())
    listed = []
    for entry in (reported if reported is not None else entries):
        name = f"{entry['id']}-{entry['version']}.zip"
        check(PACKAGE_NAME.fullmatch(name) is not None, 'invalid_subject_name', 'unsafe attestation subject name')
        (directory / name).write_bytes((root / entry['package']).read_bytes())
        listed.append({'path': f'attest-subjects/{name}', 'sha256': entry['sha256']})
    (output / 'subjects.json').write_text(json.dumps(listed, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return listed


def only_changed_packages(entries, paths):
    if paths is None:
        return entries
    changed = {path for path, status in paths if status != 'removed'}
    return [entry for entry in entries if entry['package'] in changed]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, help='candidate (head) repository')
    parser.add_argument('--ref', required=True)
    parser.add_argument('--base-repo', help='trusted base repository; defaults to --repo')
    parser.add_argument('--base')
    parser.add_argument('--changed-files', type=Path)
    parser.add_argument('--only-changed', action='store_true')
    parser.add_argument('--submitter', default='')
    parser.add_argument('--submitter-id', default='')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    base_repo = args.base_repo or args.repo
    check(REPOSITORY.fullmatch(args.repo) and REPOSITORY.fullmatch(base_repo) and COMMIT.fullmatch(args.ref),
          'invalid_target', 'invalid audit target')
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    report = {'schema': 3, 'status': 'failed', 'mode': 'unknown', 'entries': [],
              'scope': 'Static gate on candidate data only. Not an antivirus certification.',
              'submitter': args.submitter[:80], 'submitter_id': str(args.submitter_id)[:20],
              'repository': args.repo, 'base_repository': base_repo, 'commit': args.ref, 'base': args.base or None,
              'policy': 'trusted base; candidate code/workflows/scanners never executed'}
    try:
        with temp_root() as directory:
            root = Path(directory) / 'candidate'
            root.mkdir()
            # P0-1：快照同时抓 plugins/ 下的 README/market.json/图片；index-v5 由可信脚本派生。
            snapshot(args.repo, args.ref, root)
            base = None
            if args.base and args.base != '0' * 40:
                base = Path(directory) / 'base'
                base.mkdir()
                snapshot(base_repo, args.base, base)
                # P0-3：先取可信 protocol，再让 validator/index 生成看到它。
                protocol_data = trusted_protocol(base_repo, args.base)
                for target in (root, base):
                    (target / 'protocol.json').write_text(
                        json.dumps(protocol_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                paths = read_changed_files(args.changed_files) or compare_paths(base_repo, args.base, args.ref)
            else:
                check(args.changed_files is not None, 'maintenance_without_base',
                      'review requires a base commit or an explicit changed-file list')
                protocol_data = trusted_protocol(base_repo, args.ref)
                (root / 'protocol.json').write_text(
                    json.dumps(protocol_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                paths = read_changed_files(args.changed_files)
            mode = classify(paths, root)
            report['mode'] = mode
            if mode == 'submission':
                generate_index(root)
            data = validator(root)
            check(data['ok'], 'static_validation_failed',
                  '; '.join(str(item.get('message', ''))[:160] for item in data['errors'][:5])
                  or 'static validation failed')
            if mode == 'maintenance':
                report['entries'] = []
                report['status'] = 'passed'
            else:
                # P0-1：派生后仍为 0 条说明投稿内容没有被校验，必须 fail closed，不能“空绿”。
                check(data['entries'], 'no_v5_entries',
                      'submission has no derivable whale-plugin/1 entries; refusing an empty green result')
                entries = verify_entries(root, data, protocol_data)
                immutable(entries, base, root)
                reported = only_changed_packages(entries, paths) if args.only_changed else entries
                report['entries'] = entries
                report['subjects'] = subjects(output, entries, root, reported)
                report['status'] = 'passed'
    except GateError as error:
        report['error'] = {'code': error.code, 'message': str(error)[:300]}
        raise
    finally:
        (output / 'security-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n',
                                                     encoding='utf-8')
    check(report['status'] == 'passed', 'gate_blocked',
          (report.get('error') or {}).get('message', 'gate did not pass'))
    print(f"static gate passed ({report['mode']}): {len(report['entries'])} whale-plugin/1 entries, "
          f"{len(report.get('subjects', []))} attested subjects")
    return 0


if __name__ == '__main__':
    sys.exit(main())
