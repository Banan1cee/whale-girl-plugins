import hashlib
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import audit
import native
from validate import check_entry


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'packages').mkdir()

    def package(self, **changes):
        manifest = {'Id': 'native-test', 'Name': 'Native', 'Author': 'Test', 'Version': '1.0.0',
                    'MinAppVersion': '4.1.2', 'Description': 'Full access test', 'ResultLabel': 'Result',
                    'Api': 4, 'Kind': 'tool', 'Hooks': ['tool.run'], 'Permissions': ['system.full'], **changes}
        data = BytesIO()
        with ZipFile(data, 'w') as package:
            package.writestr('plugin.json', json.dumps(manifest))
            package.writestr('plugin.js', 'exports.run = async () => ({ok:true});')
        file = self.root / 'packages/native-test-1.0.0.zip'
        file.write_bytes(data.getvalue())
        return {**manifest, 'Download': audit.PREFIX + file.name,
                'Sha256': hashlib.sha256(data.getvalue()).hexdigest()}

    def test_native_manifest_is_explicit_and_does_not_weaken_wasm(self):
        check_entry(self.root, self.package(), 4, set())
        for change in ({'MinAppVersion': '4.1.1'}, {'Permissions': []}, {'Permissions': ['chat.history']},
                       {'Hooks': ['unknown']}, {'ExecutionTimeoutMs': True}, {'IntervalSeconds': 0}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                check_entry(self.root, self.package(**change), 4, set())
        with self.assertRaises(ValueError):
            check_entry(self.root, self.package(), 3, set())

    def test_gate_generates_catalog_from_source_without_running_candidate_scripts(self):
        entry = self.package()
        source = self.root / 'plugins/native-test'
        source.mkdir(parents=True)
        manifest = {key: value for key, value in entry.items() if key not in ('Download', 'Sha256')}
        (source / 'plugin.json').write_text(json.dumps(manifest))
        (source / 'build.js').write_text('throw new Error("must never run");')
        audit.generate_catalogs(self.root)
        self.assertEqual(json.loads((self.root / 'index-v4.json').read_text())[0], entry)

    def test_native_requires_container_without_host_secrets(self):
        runtime = self.root / 'runtime'; runtime.mkdir()
        data = b'fixture-runtime'
        (runtime / 'javascriptPlugins.js').write_bytes(data)
        config = {'commit': 'a' * 40, 'image': 'node:24-bookworm-slim@sha256:' + 'a' * 64,
                  'files': {'javascriptPlugins.js': hashlib.sha256(data).hexdigest()}}
        calls = []
        def run(command, **options):
            calls.append((command, options))
            return subprocess.CompletedProcess(command, 0, '{"passed":true}', '')
        with patch.object(native, 'pin', return_value=config), patch.object(native.subprocess, 'run', side_effect=run):
            native.probe_native(self.package(), b'exports.run=()=>({});', runtime)
        command, options = calls[0]
        self.assertEqual(command[:2], ['docker', 'run'])
        for expected in ('none', '--read-only', '--cap-drop', 'ALL', 'no-new-privileges', '--pids-limit', '--memory', '65534:65534'):
            self.assertIn(expected, command)
        self.assertNotIn('GH_READ_TOKEN', options['env'])
        self.assertNotIn('--privileged', command)
        self.assertEqual(calls[-1][0][:3], ['docker', 'rm', '-f'])

    def test_container_timeout_always_cleans_up(self):
        runtime = self.root / 'runtime'; runtime.mkdir()
        config = {'commit': 'a' * 40, 'image': 'node:24-bookworm-slim@sha256:' + 'a' * 64, 'files': {}}
        with patch.object(native, 'pin', return_value=config), patch.object(native.subprocess, 'run',
                side_effect=[subprocess.TimeoutExpired('docker', 120), subprocess.CompletedProcess('docker', 0)]) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                native.probe_native(self.package(), b'while(true){}', runtime)
        self.assertEqual(run.call_args_list[-1].args[0][:3], ['docker', 'rm', '-f'])
