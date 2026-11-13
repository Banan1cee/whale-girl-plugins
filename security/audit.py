"""Trusted market gate. Candidate repositories are read as data, never imported."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen
from zipfile import ZipFile

TRUSTED = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRUSTED))
from validate import CATALOGS, PREFIX, check, check_entry  # noqa: E402

CATALOG_NAMES = (*CATALOGS, 'index-personas.json')
MAX_ENTRIES = 64
MAX_SNAPSHOT = 128 * 1024 * 1024
REPOSITORY = re.compile(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}', re.ASCII)
COMMIT = re.compile(r'[a-f0-9]{40}', re.ASCII)


def json_data(data):
    def pairs(items):
        result = {}
        for key, value in items:
            check(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('invalid JSON number')))


def fetch(url, limit):
    # URL 只由经过校验的仓库名、完整 commit 与已验证路径组成。
    headers = {'User-Agent': 'WhaleGirl-Market-Security'}
    if url.startswith('https://api.github.com/') and os.environ.get('GH_READ_TOKEN'):
        headers['Authorization'] = 'Bearer ' + os.environ['GH_READ_TOKEN']
    with urlopen(Request(url, headers=headers), timeout=20) as response:
        data = response.read(limit + 1)
    check(len(data) <= limit, 'remote response exceeds limit')
    return data


def api(path):
    return json_data(fetch('https://api.github.com/' + path, 4 * 1024 * 1024))


def safe_path(value):
    check(isinstance(value, str) and 0 < len(value) <= 240
          and not value.startswith('/') and '\\' not in value
          and all(part not in ('', '.', '..') for part in value.split('/')), 'invalid relative path')
    return value


def snapshot(repo, commit, target):
    check(REPOSITORY.fullmatch(repo) and COMMIT.fullmatch(commit), 'invalid repository or commit')
    tree = api(f'repos/{repo}/git/trees/{commit}?recursive=1')
    check(not tree.get('truncated'), 'repository tree truncated')
    total = 0
    for item in tree['tree']:
        name = item['path']
        manifest = re.fullmatch(r'plugins/[a-z][a-z0-9-]{0,47}/plugin\.json', name)
        if name not in CATALOG_NAMES and not name.startswith(('packages/', 'provenance/')) and not manifest:
            continue
        safe_path(name)
        check(item['type'] == 'blob' and item['mode'] == '100644', 'market data must be ordinary files')
        limit = 16 * 1024 * 1024 if name.startswith('packages/') else 8192 if manifest else 256 * 1024
        check(item.get('size', limit + 1) <= limit, 'candidate file too large')
        total += item['size']
        check(total <= MAX_SNAPSHOT, 'candidate snapshot exceeds limit')
        content = fetch(f'https://raw.githubusercontent.com/{repo}/{commit}/{quote(name)}', limit)
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    return tree


def generate_catalogs(root):
    """Use trusted code and candidate JSON only; never run candidate build scripts."""
    if not (root / 'plugins').is_dir():
        return
    catalogs = {name: [] for name in CATALOG_NAMES}
    for file in sorted((root / 'plugins').glob('*/plugin.json')):
        check(file.is_file() and not file.is_symlink() and file.stat().st_size <= 8192, 'invalid source manifest')
        entry = json_data(file.read_bytes())
        check(isinstance(entry, dict), 'invalid source manifest')
        catalog = 'index-personas.json' if entry.get('Kind') == 'persona' else next(
            (name for name, version in CATALOGS.items() if version == entry.get('Api')), None)
        check(catalog is not None, 'unsupported source Api')
        check(re.fullmatch(r'[a-z][a-z0-9-]{0,47}', entry.get('Id', ''))
              and entry['Id'] == file.parent.name and re.fullmatch(r'\d+\.\d+\.\d+(\.\d+)?', entry.get('Version', '')),
              'invalid source identity')
        name = f"{entry['Id']}-{entry['Version']}.zip"
        package = root / 'packages' / name
        if not package.is_file():
            continue  # An explicit source draft has no package to install.
        check(not package.is_symlink(), 'invalid package file')
        catalogs[catalog].append({**entry, 'Download': PREFIX + name,
                                  'Sha256': hashlib.sha256(package.read_bytes()).hexdigest()})
    for name, catalog in catalogs.items():
        (root / name).write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def entries(root, legacy=False):
    found = []
    ids = set()
    for name in CATALOG_NAMES:
        if name == 'index-v4.json' and not (root / name).exists() or legacy and name == 'index-personas.json' and not (root / name).exists():
            continue
        check((root / name).is_file() and not (root / name).is_symlink(), f'missing catalog: {name}')
        raw = (root / name).read_bytes()
        check(len(raw) <= 256 * 1024, 'catalog too large')
        catalog = json_data(raw)
        check(isinstance(catalog, list), 'catalog must be an array')
        for item in catalog:
            check(isinstance(item, dict), 'invalid catalog entry')
            check(item.get('Id') not in ids, 'duplicate plugin Id across catalogs')
            ids.add(item.get('Id'))
            found.append((name, item))
            check(len(found) <= MAX_ENTRIES, 'too many entries for this policy')
    return found


def package_path(root, entry):
    check(re.fullmatch(r'[a-z][a-z0-9-]{0,47}', entry.get('Id', '')), 'invalid Id')
    check(re.fullmatch(r'\d+\.\d+\.\d+(\.\d+)?', entry.get('Version', ''), re.ASCII), 'invalid Version')
    name = f"{entry['Id']}-{entry['Version']}.zip"
    check(entry.get('Download') == PREFIX + name, 'security gate requires a market-hosted fixed-version package')
    file = root / 'packages' / name
    check(file.is_file() and not file.is_symlink() and not file.parent.is_symlink(), 'invalid package file')
    return file


def provenance(root, entry, online):
    file = root / 'provenance' / f"{entry['Id']}-{entry['Version']}.json"
    check(file.is_file() and not file.is_symlink() and not file.parent.is_symlink()
          and file.stat().st_size <= 8192, 'Api 3 requires provenance')
    data = json_data(file.read_bytes())
    publisher, source = data['publisher'], data['source']
    check(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}', publisher['login'])
          and type(publisher['id']) is int and publisher['id'] > 0, 'invalid publisher identity')
    check(REPOSITORY.fullmatch(source['repository']) and COMMIT.fullmatch(source['commit']), 'source must pin a full commit')
    safe_path(source['path'])
    if online:
        user = api('users/' + publisher['login'])
        repository = api('repos/' + source['repository'])
        check(user['id'] == publisher['id'] == repository['owner']['id'], 'publisher must match the source repository owner ID')
        # 核验实际存在的源文件树，不加载源码或作者提供的构建脚本。
        tree = api(f"repos/{source['repository']}/git/trees/{source['commit']}?recursive=1")
        check(not tree.get('truncated') and any(item['type'] == 'blob' and
              item['path'].startswith(source['path'] + '/') for item in tree['tree']), 'source commit/path not found')
    return {**data, 'identity_verified': online, 'identity_scope': 'GitHub account, not legal identity',
            'source_scope': 'declared source; reproducible build not asserted'}


def ensure_immutable(root, base):
    if base is None:
        return
    for old in (base / 'packages').glob('*.zip'):
        current = root / 'packages' / old.name
        check(current.is_file() and current.read_bytes() == old.read_bytes(), 'published package cannot be changed or deleted: ' + old.name)
    old_entries = {item['Id']: item for _, item in entries(base, legacy=True)}
    for _, item in entries(root):
        old = old_entries.get(item['Id'])
        if old:
            check(item.get('Kind', 'tool') == old.get('Kind', 'tool'), 'plugin kind cannot change')
            before = tuple(map(int, old['Version'].split('.')))
            after = tuple(map(int, item['Version'].split('.')))
            check(after >= before, 'version rollback is forbidden')
            if after == before:
                check(item['Sha256'] == old['Sha256'], 'same version cannot replace a package')
            old_proof = base / 'provenance' / f"{old['Id']}-{old['Version']}.json"
            if old_proof.exists() and item['Api'] in (3, 4):
                before_owner = json_data(old_proof.read_bytes())['publisher']['id']
                check(provenance(root, item, False)['publisher']['id'] == before_owner, 'publisher transfer requires a separate policy review')


def audit(root, output, runtime, *, online=False, base=None, node='node', context=None, native_runtime=None):
    output.mkdir(parents=True, exist_ok=True)
    report = {'schema': 1, 'status': 'failed', 'tested_at': datetime.now(timezone.utc).isoformat(),
              'context': context or {}, 'plugins': [],
              'scope': 'Automated policy and simulated runtime checks; not an antivirus certification'}
    try:
        ensure_immutable(root, base)
        seen = set()
        for catalog, entry in entries(root):
            file = package_path(root, entry)
            is_persona = catalog == 'index-personas.json'
            api_number = 1 if is_persona else CATALOGS[catalog]
            check_entry(root, entry, api_number, seen, is_persona)
            data = file.read_bytes()
            # validate.py 的 JSON 解析之外，再拒绝可能在不同客户端解析出歧义的重复键。
            with ZipFile(BytesIO(data)) as package:
                json_data(package.read('plugin.json'))
                if is_persona:
                    json_data(package.read('persona.json'))
                module = None if is_persona else package.read('plugin.js' if api_number == 4 else 'plugin.wasm')
            result = {'id': entry['Id'], 'version': entry['Version'], 'sha256': hashlib.sha256(data).hexdigest(),
                      'api': entry['Api'], 'kind': entry.get('Kind', 'tool'),
                      'mode': 'api4-container' if api_number == 4 else 'api3-runtime' if api_number == 3 else 'static', 'status': 'passed',
                      'permissions': entry.get('Permissions', []), 'hooks': entry.get('Hooks', [])}
            if api_number == 3:
                result['provenance'] = provenance(root, entry, online)
                check(runtime is not None, 'Api 3 requires the pinned host runtime')
                runtime_pin = json_data((TRUSTED / 'security/runtime.json').read_bytes())
                check(hashlib.sha256(runtime.read_bytes()).hexdigest() == runtime_pin['sha256'], 'host runtime hash mismatch')
                request = {'id': entry['Id'], 'hooks': entry['Hooks'], 'permissions': entry['Permissions'],
                           'wasm': base64.b64encode(module).decode('ascii')}
                # 环境中不传 token、密钥和仓库凭据；仅宿主提供的三个字节接口可用。
                env = {key: os.environ[key] for key in ('SystemRoot', 'PATH', 'TEMP', 'TMP', 'TMPDIR') if key in os.environ}
                child = subprocess.run([node, str(TRUSTED / 'security/probe.cjs'), str(runtime.resolve())],
                                       input=json.dumps(request), text=True, capture_output=True, timeout=35, env=env)
                check(child.returncode == 0, 'runtime rejected plugin: ' + child.stdout[-200:])
                result['runtime'] = json_data(child.stdout)
                check(result['runtime'].get('passed') is True, 'runtime did not pass')
                result['host_runtime'] = runtime_pin
            if api_number == 4:
                from native import probe_native
                result['provenance'] = provenance(root, entry, online)
                result['runtime'] = probe_native(entry, module, native_runtime)
            report['plugins'].append(result)
            (output / file.name).write_bytes(data)
        report['status'] = 'passed'
    except Exception as error:
        report['error'] = str(error)[:500]
        raise
    finally:
        (output / 'security-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--ref', required=True)
    parser.add_argument('--base')
    parser.add_argument('--submitter', default='')
    parser.add_argument('--submitter-id', default='')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    check(REPOSITORY.fullmatch(args.repo) and COMMIT.fullmatch(args.ref), 'invalid audit target')
    with tempfile.TemporaryDirectory(prefix='whale-audit-') as directory:
        root = Path(directory)
        candidate = root / 'candidate'
        candidate.mkdir()
        snapshot(args.repo, args.ref, candidate)
        generate_catalogs(candidate)
        base = None
        if args.base and args.base != '0' * 40:
            base = root / 'base'
            base.mkdir()
            snapshot(args.repo, args.base, base)
            generate_catalogs(base)
        pin = json_data((TRUSTED / 'security/runtime.json').read_bytes())
        runtime = root / 'host-runtime.cjs'
        runtime.write_bytes(fetch(f"https://raw.githubusercontent.com/{pin['repository']}/{pin['commit']}/{pin['path']}", 100000))
        context = {'repository': args.repo, 'commit': args.ref, 'base': args.base,
                   'submitter': args.submitter, 'submitter_id': args.submitter_id,
                   'run_url': os.environ.get('GITHUB_SERVER_URL', 'https://github.com') + '/' + args.repo + '/actions/runs/' + os.environ.get('GITHUB_RUN_ID', 'local'),
                   'runner_os': os.environ.get('RUNNER_OS', sys.platform),
                   'policy_commit': os.environ.get('POLICY_COMMIT', '')}
        native_runtime = None
        if any(item['Api'] == 4 for _, item in entries(candidate)):
            from native import prepare_runtime
            native_runtime = prepare_runtime(root / 'native-runtime', fetch)
        report = audit(candidate, args.output, runtime, online=True, base=base, context=context, native_runtime=native_runtime)
        lines = ['## 插件分级安全检测', '', f"检测版本：`{args.ref}`", '', '| 插件 | 类型 | 结果 | 包 SHA-256 |', '| --- | --- | --- | --- |']
        for item in report['plugins']:
            lines.append(f"| {item['id']} {item['version']} | {item['mode']} | {item['status']} | `{item['sha256']}` |")
        lines += ['', '检测通过不代表无恶意行为。报告与最终 ZIP 绑定；身份仅核验 GitHub 账号。']
        print('\n'.join(lines))
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
                summary.write('\n'.join(lines))


if __name__ == '__main__':
    main()
