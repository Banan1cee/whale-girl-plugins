"""Api 4 execution is allowed only in a disposable container with no host secrets."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]


def pin():
    return json.loads((ROOT / 'security/native-runtime.json').read_text(encoding='utf-8'))


def prepare_runtime(directory, fetch):
    config = pin()
    if not re.fullmatch(r'[a-f0-9]{40}', config['commit']):
        raise ValueError('native host commit is not pinned')
    directory.mkdir(parents=True)
    for name, digest in config['files'].items():
        if name not in ('javascriptPlugins.js', 'javascriptPluginWorker.js', 'messagePlugins.js'):
            raise ValueError('unexpected native host file')
        data = fetch(f"https://raw.githubusercontent.com/{config['repository']}/{config['commit']}/src/services/{name}", 100000)
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('native host hash mismatch')
        (directory / name).write_bytes(data)
    return directory


def probe_native(entry, source, runtime):
    config = pin()
    if runtime is None or not runtime.is_dir():
        raise ValueError('Api 4 requires pinned host runtime and Docker isolation')
    for name, digest in config['files'].items():
        if hashlib.sha256((runtime / name).read_bytes()).hexdigest() != digest:
            raise ValueError('native host hash mismatch')
    if not re.fullmatch(r'node:24-bookworm-slim@sha256:[a-f0-9]{64}', config['image']):
        raise ValueError('native container image is not pinned')
    request = {'id': entry['Id'], 'kind': entry['Kind'], 'hooks': entry['Hooks'],
               'javascript': source.decode('utf-8'), 'executionTimeoutMs': min(entry.get('ExecutionTimeoutMs', 30000), 5000)}
    name = 'whale-plugin-audit-' + uuid.uuid4().hex
    env = {key: os.environ[key] for key in ('PATH', 'SystemRoot', 'TEMP', 'TMP') if key in os.environ}
    command = ['docker', 'run', '--rm', '--name', name, '--platform', 'linux/amd64', '-i',
               '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '--user', '65534:65534', '--memory', '384m', '--memory-swap', '384m', '--cpus', '1', '--pids-limit', '64',
               '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
               '--mount', f'type=bind,src={runtime.resolve()},dst=/host,readonly',
               '--mount', f'type=bind,src={(ROOT / "security/native-probe.cjs").resolve()},dst=/probe.cjs,readonly',
               config['image'], 'node', '/probe.cjs']
    try:
        child = subprocess.run(command, input=json.dumps(request), text=True, capture_output=True, timeout=120, env=env)
        if child.returncode != 0:
            # Never copy native stderr or stdout into a public report.
            raise ValueError('native isolated runtime rejected plugin')
        if len(child.stdout) > 8192:
            raise ValueError('native probe output exceeds limit')
        result = json.loads(child.stdout)
        if not isinstance(result, dict) or result.get('passed') is not True:
            raise ValueError('native isolated runtime did not pass')
        return {'passed': True, 'hooks': list(entry['Hooks']), 'isolation': 'no-network-container',
                'host_commit': config['commit'], 'image': config['image'],
                'scope': 'Synthetic compatibility check, not proof of harmlessness'}
    finally:
        # The outer timeout must also terminate the container, not only the Docker client.
        subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=15, env=env)
