"""Self-tests for the trusted static gate, isolation gate and attestation list.

Synthetic fixtures only. No real plugin, container, image or candidate script is
executed; network access is mocked.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attest_subjects
import gate
import isolated

import contextlib

@contextlib.contextmanager
def _tmp():
    """每次调用一个系统临时目录。

    以前所有用例共用仓库内的 security/_tmp/，并发跑测试或工作区只读时会互相干扰；
    临时目录落在系统 tmp 下，名字由 tempfile 分配，用完即删，不依赖仓库路径。
    """
    with tempfile.TemporaryDirectory(prefix='market-gate-') as directory:
        yield Path(directory)

POLICY = {
    'levels': {
        '0': {'runtime': 'none', 'entry': ''},
        '4': {'runtime': 'javascript', 'entry': 'plugin.js'},
    },
    'limits': {'maxPackageBytes': 16777216},
}


def make_package(directory, plugin_id='sample', version='1.0.0', extra=None, entry='plugin.js', source=b'export {}'):
    manifest = json.dumps({'format': 'whale-plugin/1', 'id': plugin_id, 'version': version,
                           'level': 4, 'runtime': 'javascript', 'entry': entry}).encode()
    (directory / 'packages').mkdir(parents=True, exist_ok=True)
    file = directory / 'packages' / ('%s-%s.zip' % (plugin_id, version))
    with ZipFile(file, 'w') as package:
        package.writestr('plugin.json', manifest)
        package.writestr(entry, source)
        if extra:
            package.writestr(extra, b'never executed')
    return file, manifest


def entry_for(file, manifest, level=4, entry='plugin.js'):
    return {'id': 'sample', 'version': '1.0.0', 'level': level, 'runtime': 'javascript',
            'entry': entry, 'package': 'packages/' + file.name,
            'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
            'manifestSha256': hashlib.sha256(manifest).hexdigest(),
            'packageBytes': len(file.read_bytes()), 'provides': [], 'calls': [], 'dataAccess': []}


class GateTests(unittest.TestCase):
    def test_submission_scope_only_allows_plugin_data(self):
        self.assertEqual(gate.classify([('packages/a-1.0.0.zip', 'added')]), 'submission')
        with self.assertRaisesRegex(gate.GateError, 'outside submission scope'):
            gate.classify([('unknown/thing.txt', 'modified')])
        with self.assertRaisesRegex(gate.GateError, 'separate pull requests'):
            gate.classify([('packages/a-1.0.0.zip', 'added'), ('docs/api4.md', 'modified')])
        with self.assertRaisesRegex(gate.GateError, 'separate pull requests'):
            gate.classify([('packages/a-1.0.0.zip', 'added'), ('README.md', 'modified')])
        with self.assertRaisesRegex(gate.GateError, 'cannot be deleted'):
            gate.classify([('packages/a-1.0.0.zip', 'removed')])

    def test_maintenance_change_has_no_plugin_scope(self):
        self.assertEqual(gate.classify([('security/gate.py', 'added')]), 'maintenance')

    def _candidate(self, directory, entries=()):
        root = Path(directory)
        for name in ('index.json', 'index-v2.json', 'index-v3.json', 'index-v4.json', 'index-personas.json'):
            (root / name).write_text('[]', encoding='utf-8')
        if entries:
            (root / 'index-v4.json').write_text(json.dumps(list(entries)), encoding='utf-8')
        return root

    def test_unreferenced_package_and_provenance_deletion_is_allowed(self):
        with _tmp() as directory:
            root = self._candidate(directory)
            mode = gate.classify([('packages/a-1.0.0.zip', 'removed'),
                                  ('provenance/a-1.0.0.json', 'removed')], root)
        self.assertEqual(mode, 'submission')

    def test_referenced_package_deletion_is_rejected(self):
        with _tmp() as directory:
            root = self._candidate(directory, [{'Id': 'a', 'Version': '1.0.0'}])
            with self.assertRaisesRegex(gate.GateError, 'cannot be deleted'):
                gate.classify([('packages/a-1.0.0.zip', 'removed')], root)
            with self.assertRaisesRegex(gate.GateError, 'cannot be deleted'):
                gate.classify([('provenance/a-1.0.0.json', 'removed')], root)

    def test_provenance_cannot_be_deleted_while_its_package_stays(self):
        with _tmp() as directory:
            root = self._candidate(directory)
            (root / 'packages').mkdir()
            (root / 'packages/a-1.0.0.zip').write_bytes(b'PK')
            with self.assertRaisesRegex(gate.GateError, 'cannot be deleted'):
                gate.classify([('provenance/a-1.0.0.json', 'removed')], root)

    def test_package_source_deletion_is_still_forbidden(self):
        with _tmp() as directory:
            root = self._candidate(directory)
            with self.assertRaisesRegex(gate.GateError, 'source cannot be deleted'):
                gate.classify([('plugins/a/plugin.js', 'removed')], root)

    def test_immutable_allows_unreferenced_deletions_only(self):
        with _tmp() as directory:
            root = self._candidate(directory, [{'Id': 'kept', 'Version': '1.0.0'}])
            (root / 'packages').mkdir()
            (root / 'packages/kept-1.0.0.zip').write_bytes(b'PK')
            base = Path(directory) / 'base'
            (base / 'packages').mkdir(parents=True)
            (base / 'packages/kept-1.0.0.zip').write_bytes(b'PK')
            (base / 'packages/old-1.0.0.zip').write_bytes(b'PK')
            with patch.object(gate, 'base_entries', return_value={}):
                gate.immutable([], base, root)
                (root / 'packages/kept-1.0.0.zip').unlink()
                with self.assertRaisesRegex(gate.GateError, 'still referenced'):
                    gate.immutable([], base, root)

    def test_package_bytes_hash_size_and_entries_are_checked(self):
        with _tmp() as directory:
            root = Path(directory)
            file, manifest = make_package(root)
            entry = entry_for(file, manifest)
            self.assertTrue(gate.verify_package(root, entry).startswith(b'PK'))
            for field, value, message in (
                    ('sha256', '0' * 64, 'sha256 differs'), ('packageBytes', 1, 'size differs'),
                    ('manifestSha256', '0' * 64, 'manifest sha256 differs')):
                with self.subTest(field):
                    with self.assertRaisesRegex(gate.GateError, message):
                        gate.verify_package(root, {**entry, field: value})

    def test_package_cannot_smuggle_extra_files(self):
        with _tmp() as directory:
            root = Path(directory)
            file, manifest = make_package(root, extra='install.ps1')
            with self.assertRaisesRegex(gate.GateError, 'exactly'):
                gate.verify_package(root, entry_for(file, manifest))

    def test_same_version_cannot_replace_published_package(self):
        candidate = [{'id': 'sample', 'version': '1.0.0', 'sha256': 'a' * 64}]
        with _tmp() as directory:
            base = Path(directory)
            (base / 'index-v5.json').write_text('[]', encoding='utf-8')
            with patch.object(gate, 'base_entries', return_value={('sample', '1.0.0'): {'id': 'sample', 'version': '1.0.0', 'sha256': 'b' * 64}}):
                with self.assertRaisesRegex(gate.GateError, 'immutable|cannot replace'):
                    gate.immutable(candidate, base)

    def test_validator_interface_missing_fails_closed(self):
        with _tmp() as directory, patch.object(gate.subprocess, 'run') as run:
            run.return_value = type('Result', (), {'returncode': 2, 'stdout': 'Validated 3 entries.', 'stderr': ''})()
            with self.assertRaises(gate.GateError) as raised:
                gate.validator(Path(directory))
            self.assertEqual(raised.exception.code, 'validator_interface_not_ready')

    def test_validator_json_is_consumed_without_candidate_code(self):
        with _tmp() as directory, patch.object(gate.subprocess, 'run') as run:
            run.return_value = type('Result', (), {'returncode': 0,
                                                    'stdout': json.dumps({'ok': True, 'errors': [], 'entries': []}),
                                                    'stderr': ''})()
            self.assertEqual(gate.validator(Path(directory))['entries'], [])
            command = run.call_args[0][0]
            self.assertEqual(command[1], str(gate.TRUSTED / 'validate.py'))
            self.assertIn('--json', command)


class ProtocolPolicyTests(unittest.TestCase):
    def test_task53_registry_wrapped_protocol_is_accepted(self):
        wrapped = {'_source': {'commit': 'a' * 40}, 'registry': dict(POLICY, format='whale-plugin/1')}
        with patch.object(gate, 'fetch', return_value=json.dumps(wrapped).encode()):
            data = gate.trusted_protocol('Banan1cee/whale_girl', 'a' * 40)
        self.assertEqual(sorted(data['levels']), ['0', '4'])
        self.assertIn('maxPackageBytes', data['limits'])

    def test_flat_protocol_is_still_accepted_and_foreign_format_rejected(self):
        with patch.object(gate, 'fetch', return_value=json.dumps(dict(POLICY, format='whale-plugin/1')).encode()):
            self.assertIn('levels', gate.trusted_protocol('Banan1cee/whale_girl', 'a' * 40))
        with patch.object(gate, 'fetch', return_value=json.dumps(dict(POLICY, format='whale-plugin/2')).encode()):
            with self.assertRaises(gate.GateError):
                gate.trusted_protocol('Banan1cee/whale_girl', 'a' * 40)


class IsolationTests(unittest.TestCase):
    def pin(self, state='pending'):
        return {'repository': 'Banan1cee/whale_girl', 'commit': 'a' * 40,
                'image': 'node:24-bookworm-slim@sha256:' + 'b' * 64,
                'harness': {'state': state, 'reason': 'ADAPTER_NOT_VERIFIED'},
                'files': {'package.json': 'c' * 64}}

    def test_unverified_harness_and_isolated_job_fail_closed(self):
        with _tmp() as directory:
            path = Path(directory) / 'pin.json'
            path.write_text(json.dumps(self.pin()), encoding='utf-8')
            with self.assertRaisesRegex(isolated.Blocked, 'ADAPTER_NOT_VERIFIED'):
                isolated.load_pin(path)

    def test_missing_pin_file_fails_closed(self):
        with _tmp() as directory:
            with self.assertRaises(isolated.Blocked) as raised:
                isolated.load_pin(directory / 'nope.json')
        self.assertEqual(raised.exception.code, 'runtime_pin_invalid')

    def test_tag_only_image_is_refused(self):
        pin = self.pin('verified')
        pin['image'] = 'node:24-bookworm-slim'
        with _tmp() as directory:
            path = Path(directory) / 'pin.json'
            path.write_text(json.dumps(pin), encoding='utf-8')
            with self.assertRaisesRegex(isolated.Blocked, 'pinned by digest'):
                isolated.load_pin(path)

    def test_container_command_drops_privileges_and_has_no_credentials(self):
        pin = self.pin('verified')
        command = isolated.container_command('name', pin, Path('.'), Path('.'), Path('.'), 3000)
        joined = ' '.join(command)
        for flag in ('--network none', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges',
                     '--user 65534:65534', '--pids-limit 64', '--memory 256m'):
            self.assertIn(flag, joined)
        self.assertNotIn('GH_TOKEN', joined)
        self.assertNotIn('GITHUB_TOKEN', joined)
        # 候选目录必须以只读 bind 挂进来：这是「候选代码改不了宿主文件」的唯一保证。
        # 旧行写成 `assertNotIn(<真实存在的挂载串>) if False else None`，符号反了又没执行；
        # 现在正面断言它存在，并额外要求每个 bind 都带 readonly（写成可写就等于开洞）。
        candidate_src = str(Path('.').resolve())
        self.assertIn('type=bind,src=' + candidate_src + ',dst=/candidate,readonly', joined,
                      'candidate directory must be bind-mounted read-only')
        binds = [item for item in command if item.startswith('type=bind,')]
        self.assertTrue(binds, 'container must bind candidate/runtime/harness')
        for bind in binds:
            self.assertTrue(bind.endswith(',readonly'), 'every bind mount must be read-only: ' + bind)

    def test_executable_level_without_docker_blocks(self):
        pin = self.pin('verified')
        with _tmp() as root:
            file, manifest = make_package(root)
            entries = [entry_for(file, manifest)]
            with self.assertRaisesRegex(isolated.Blocked, 'Docker is unavailable'):
                isolated.isolate(entries, root / 'packages', Path('.'), pin, docker=lambda: False)

    def test_static_only_submission_skips_isolation(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = {**entry_for(file, manifest), 'level': 0}
            result = isolated.isolate([entry], root / 'packages', Path('.'), self.pin('verified'))
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['entries'], [])

    def test_empty_submission_entries_fail_closed(self):
        with self.assertRaises(isolated.Blocked) as raised:
            isolated.isolate([], Path('.'), Path('.'), self.pin('verified'))
        self.assertEqual(raised.exception.code, 'entries_missing')

    def test_package_set_must_match_report_and_hash(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = entry_for(file, manifest)
            with self.assertRaises(isolated.Blocked):
                isolated.verify_package_set([{**entry, 'sha256': '0' * 64}], root / 'packages')
            with self.assertRaises(isolated.Blocked):
                isolated.verify_package_set([entry, {'id': 'other', 'version': '1.0.0', 'sha256': '0' * 64}], root / 'packages')

    def test_extract_rejects_symlink_and_traversal_names(self):
        with _tmp() as directory:
            root = Path(directory)
            file = root / 'bad.zip'
            with ZipFile(file, 'w') as package:
                package.writestr('plugin.json', '{}')
                package.writestr('../escape.js', 'x')
            with self.assertRaisesRegex(isolated.Blocked, 'flat entry|unsafe'):
                isolated.extract_package(file, root / 'out')

    # ---- task-107: pending pin, subject binding, authenticated harness ----

    def test_static_only_main_never_loads_pending_pin(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = {**entry_for(file, manifest), 'level': 0, 'runtime': 'theme-data',
                     'entry': 'theme.json'}
            report = root / 'security-report.json'
            report.write_text(json.dumps({'status': 'passed', 'mode': 'submission', 'entries': [entry]}),
                              encoding='utf-8')
            output = root / 'out'
            argv = ['isolated.py', '--report', str(report), '--packages', str(root / 'packages'),
                    '--output', str(output)]
            with patch.object(isolated, 'load_pin',
                              side_effect=AssertionError('static-only submissions must not require the pending pin')):
                with patch.object(sys, 'argv', argv):
                    code = isolated.main()
            self.assertEqual(code, 0)
            result = json.loads((output / 'isolation-report.json').read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'passed')
            self.assertEqual(result['entries'], [])

    def test_executable_submission_fails_closed_when_pin_is_pending(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = entry_for(file, manifest)
            report = root / 'security-report.json'
            report.write_text(json.dumps({'status': 'passed', 'mode': 'submission', 'entries': [entry]}),
                              encoding='utf-8')
            output = root / 'out'
            argv = ['isolated.py', '--report', str(report), '--packages', str(root / 'packages'),
                    '--output', str(output)]
            with patch.object(isolated, 'load_pin',
                              side_effect=isolated.Blocked('runtime_pin_pending', 'PENDING_BINDING')):
                with patch.object(sys, 'argv', argv):
                    code = isolated.main()
            self.assertEqual(code, 2)
            result = json.loads((output / 'isolation-report.json').read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'blocked')
            self.assertEqual(result['error']['code'], 'runtime_pin_pending')

    def test_verified_pin_must_cover_adapter_files(self):
        pin = self.pin('verified')
        with _tmp() as directory:
            path = Path(directory) / 'pin.json'
            path.write_text(json.dumps(pin), encoding='utf-8')
            with self.assertRaises(isolated.Blocked) as raised:
                isolated.load_pin(path)
        self.assertEqual(raised.exception.code, 'runtime_pin_incomplete')

    def test_adapter_hash_mismatch_blocks_before_anything_runs(self):
        pin = self.pin('pending')
        pin['harness']['adapter_sha256'] = 'f' * 64
        with _tmp() as directory:
            path = Path(directory) / 'pin.json'
            path.write_text(json.dumps(pin), encoding='utf-8')
            with self.assertRaises(isolated.Blocked) as raised:
                isolated.load_pin(path)
        self.assertEqual(raised.exception.code, 'harness_adapter_mismatch')

    def test_duplicate_report_entries_are_rejected(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = entry_for(file, manifest)
            with self.assertRaisesRegex(isolated.Blocked, 'duplicate entry'):
                isolated.verify_package_set([entry, entry], root / 'packages')

    def test_package_directory_rejects_symlinks_and_directories(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = entry_for(file, manifest)
            (root / 'packages' / 'nested').mkdir()
            with self.assertRaisesRegex(isolated.Blocked, 'non-regular entry'):
                isolated.verify_package_set([entry], root / 'packages')
            (root / 'packages' / 'nested').rmdir()
            try:
                os.symlink(file, root / 'packages' / 'linked.zip')
            except (OSError, NotImplementedError):
                self.skipTest('symlinks are unavailable on this platform')
            with self.assertRaisesRegex(isolated.Blocked, 'non-regular entry'):
                isolated.verify_package_set([entry], root / 'packages')

    def test_reported_entries_are_the_attested_subset_only(self):
        first = {'id': 'one', 'version': '1.0.0', 'sha256': 'a' * 64, 'level': 4, 'provides': []}
        second = {'id': 'two', 'version': '2.0.0', 'sha256': 'b' * 64, 'level': 4, 'provides': []}
        report = {'entries': [first, second],
                  'subjects': [{'path': 'attest-subjects/one-1.0.0.zip', 'sha256': 'a' * 64}]}
        selected = isolated.reported_entries(report)
        self.assertEqual([entry['id'] for entry in selected], ['one'])
        report['subjects'].append({'path': 'attest-subjects/one-1.0.0.zip', 'sha256': 'a' * 64})
        with self.assertRaisesRegex(isolated.Blocked, 'duplicate subject'):
            isolated.reported_entries(report)
        report['subjects'] = [{'path': 'attest-subjects/one-1.0.0.zip', 'sha256': 'c' * 64}]
        with self.assertRaisesRegex(isolated.Blocked, 'hash differs'):
            isolated.reported_entries(report)
        report['subjects'] = [{'path': 'attest-subjects/missing-9.9.9.zip', 'sha256': 'a' * 64}]
        with self.assertRaisesRegex(isolated.Blocked, 'not among'):
            isolated.reported_entries(report)

    def _signed_outcome(self, entry, source, pin, secret):
        body = {
            'schema': 2, 'status': 'passed', 'code': '',
            'subject': {'id': entry['id'], 'version': entry['version'], 'level': entry['level'],
                        'entry': entry['entry'],
                        'manifestSha256': hashlib.sha256((source / 'plugin.json').read_bytes()).hexdigest(),
                        'entrySha256': hashlib.sha256((source / entry['entry']).read_bytes()).hexdigest()},
            'runtime_digest': isolated.runtime_digest(pin),
            'providers': [{'name': name, 'ok': True, 'outputJson': '{}', 'outputSha256': hashlib.sha256(b'{}').hexdigest()} for name in entry['provides']],
            'checks': {name: True for name in isolated.CHECK_NAMES},
        }
        body['auth'] = {'algo': 'hmac-sha256',
                        'nonceHash': hashlib.sha256(secret.encode()).hexdigest(),
                        'mac': hmac.new(secret.encode(),
                                        isolated.mac_text(body, secret).encode(),
                                        hashlib.sha256).hexdigest()}
        return body, body['auth']['mac']

    def _fixture(self, root, provides=('tool.run@1',)):
        source = root / 'candidate'
        source.mkdir()
        (source / 'plugin.json').write_bytes(b'{"id":"sample"}')
        (source / 'plugin.js').write_bytes(b'module.exports = {};')
        pin = {'files': {'src/services/pluginProtocolRegistry.json': 'a' * 64},
               'commit': 'a' * 40, 'image': 'node:24-bookworm-slim@sha256:' + 'b' * 64,
               'protocol': 'whale-plugin/1'}
        entry = {'id': 'sample', 'version': '1.0.0', 'level': 4, 'runtime': 'node-full',
                 'entry': 'plugin.js', 'sha256': 'd' * 64,
                 'manifestSha256': hashlib.sha256(b'{"id":"sample"}').hexdigest(),
                 'provides': list(provides)}
        registry = {'providers': {'tool.run@1': {'outputSchema': 'empty-object'}},
                    'schemas': {'empty-object': {'type': 'object', 'properties': {},
                                                 'required': [], 'additionalProperties': False}}}
        return source, pin, entry, registry

    def test_harness_result_must_be_authenticated_and_bound_to_subject(self):
        secret = 'c' * 64
        with _tmp() as root:
            source, pin, entry, registry = self._fixture(root)
            body, _ = self._signed_outcome(entry, source, pin, secret)
            summary = isolated.verify_outcome(body, secret, entry, source, pin, registry)
            self.assertEqual(summary['id'], 'sample')
            self.assertEqual(summary['runtime_digest'], isolated.runtime_digest(pin))

            for key, value, message in (('id', 'other', 'subject does not match'),
                                        ('version', '9.9.9', 'subject does not match'),
                                        ('manifestSha256', '0' * 64, 'different manifest'),
                                        ('entrySha256', '0' * 64, 'different entry')):
                tampered = json.loads(json.dumps(body))
                tampered['subject'][key] = value
                tampered['auth']['mac'] = hmac.new(secret.encode(), isolated.mac_text(tampered, secret).encode(),
                                                   hashlib.sha256).hexdigest()
                with self.subTest(key=key):
                    with self.assertRaisesRegex(isolated.Blocked, message):
                        isolated.verify_outcome(tampered, secret, entry, source, pin, registry)

            unsigned = json.loads(json.dumps(body))
            del unsigned['auth']
            with self.assertRaisesRegex(isolated.Blocked, 'HMAC envelope|authenticated|signature'):
                isolated.verify_outcome(unsigned, secret, entry, source, pin, registry)

            wrong_secret = 'e' * 64
            forged = json.loads(json.dumps(body))
            forged['auth']['nonceHash'] = hashlib.sha256(wrong_secret.encode()).hexdigest()
            with self.assertRaisesRegex(isolated.Blocked, 'different run'):
                isolated.verify_outcome(forged, secret, entry, source, pin, registry)

    def test_invalid_harness_outcomes_fail_closed(self):
        secret = 'c' * 64
        with _tmp() as root:
            source, pin, entry, registry = self._fixture(root)
            body, _ = self._signed_outcome(entry, source, pin, secret)
            for code, expected in (('provider_failed', 'isolation_blocked'),
                                   ('isolation_checks_failed', 'isolation_blocked')):
                blocked = json.loads(json.dumps(body))
                blocked['status'] = 'blocked'
                blocked['code'] = code
                blocked['reason'] = 'synthetic failure'
                blocked['auth']['mac'] = hmac.new(secret.encode(), isolated.mac_text(blocked, secret).encode(),
                                                  hashlib.sha256).hexdigest()
                with self.subTest(code=code):
                    with self.assertRaises(isolated.Blocked) as raised:
                        isolated.verify_outcome(blocked, secret, entry, source, pin, registry)
                    self.assertEqual(raised.exception.code, expected)

            no_checks = json.loads(json.dumps(body))
            no_checks['checks'] = {'schema': True, 'timeout': False, 'cancellation': True, 'revocation': True}
            no_checks['auth']['mac'] = hmac.new(secret.encode(), isolated.mac_text(no_checks, secret).encode(),
                                                hashlib.sha256).hexdigest()
            with self.assertRaisesRegex(isolated.Blocked, 'checks did not all pass'):
                isolated.verify_outcome(no_checks, secret, entry, source, pin, registry)

            wrong_runtime = json.loads(json.dumps(body))
            wrong_runtime['runtime_digest'] = '0' * 64
            wrong_runtime['auth']['mac'] = hmac.new(secret.encode(), isolated.mac_text(wrong_runtime, secret).encode(),
                                                    hashlib.sha256).hexdigest()
            with self.assertRaisesRegex(isolated.Blocked, 'different runtime pin'):
                isolated.verify_outcome(wrong_runtime, secret, entry, source, pin, registry)

            bad_schema = json.loads(json.dumps(body))
            bad_schema['providers'][0]['outputJson'] = '{"unexpected":true}'
            bad_schema['providers'][0]['outputSha256'] = hashlib.sha256(b'{"unexpected":true}').hexdigest()
            bad_schema['auth']['mac'] = hmac.new(secret.encode(), isolated.mac_text(bad_schema, secret).encode(),
                                                 hashlib.sha256).hexdigest()
            with self.assertRaisesRegex(isolated.Blocked, 'fails the pinned schema'):
                isolated.verify_outcome(bad_schema, secret, entry, source, pin, registry)

            bad_digest = json.loads(json.dumps(body))
            bad_digest['providers'][0]['outputJson'] = '{"changed":true}'
            bad_digest['auth']['mac'] = hmac.new(secret.encode(), isolated.mac_text(bad_digest, secret).encode(),
                                                 hashlib.sha256).hexdigest()
            with self.assertRaisesRegex(isolated.Blocked, 'output digest does not match'):
                isolated.verify_outcome(bad_digest, secret, entry, source, pin, registry)

    def test_harness_stdout_requires_exactly_one_marker(self):
        payload = json.dumps({'schema': 2, 'status': 'blocked', 'code': 'x'})
        self.assertEqual(isolated.parse_harness_stdout(isolated.MARKER + payload)['code'], 'x')
        with self.assertRaisesRegex(isolated.Blocked, 'exactly one'):
            isolated.parse_harness_stdout(isolated.MARKER + payload + isolated.MARKER + payload)
        with self.assertRaises(isolated.Blocked):
            isolated.parse_harness_stdout(isolated.MARKER + payload + ' trailing')
        with self.assertRaisesRegex(isolated.Blocked, 'exactly one'):
            isolated.parse_harness_stdout('no marker here')

    def test_container_command_uses_pinned_image_without_pull_and_binds_pin(self):
        pin = self.pin('verified')
        command = isolated.container_command('name', pin, Path('.'), Path('.'), Path('.'), 3000)
        joined = ' '.join(command)
        self.assertIn('--pull=never', joined)
        self.assertIn('--interactive', joined)
        self.assertIn('dst=/harness/plugin-runtime.json,readonly', joined)
        self.assertIn(pin['image'], joined)
        self.assertNotIn('GH_TOKEN', joined)
        self.assertNotIn('GITHUB_TOKEN', joined)

    def test_pinned_runtime_must_support_declared_providers(self):
        with _tmp() as root:
            file, manifest = make_package(root)
            entry = {**entry_for(file, manifest), 'provides': ['chat.received@1']}
            runtime = root / 'runtime'
            registry = runtime / 'src/services/pluginProtocolRegistry.json'
            registry.parent.mkdir(parents=True)
            registry.write_text(json.dumps({'format': 'whale-plugin/1',
                                            'providers': {'tool.run@1': {}}}), encoding='utf-8')
            pin = self.pin('verified')
            pin['files'] = {'src/services/pluginProtocolRegistry.json':
                            hashlib.sha256(registry.read_bytes()).hexdigest()}
            with self.assertRaises(isolated.Blocked) as raised:
                isolated.isolate([entry], root / 'packages', runtime, pin, docker=lambda: True)
        self.assertEqual(raised.exception.code, 'runtime_pin_abi_mismatch')


class V5DerivationTests(unittest.TestCase):
    MANIFEST = {'format': 'whale-plugin/1', 'level': 4, 'id': 'sample', 'name': '示例', 'author': 'A',
                'version': '1.0.0', 'minAppVersion': '4.3.0', 'description': '',
                'entry': 'plugin.js', 'runtime': 'node-full',
                'provides': {'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}, 'calls': []}

    def candidate(self, root):
        plugin = root / 'plugins' / 'sample'
        plugin.mkdir(parents=True)
        manifest = (json.dumps(self.MANIFEST) + '\n').encode()
        (plugin / 'plugin.json').write_bytes(manifest)
        (plugin / 'README.md').write_text('# 示例\n', encoding='utf-8')
        (plugin / 'market.json').write_text('{"readme":"README.md"}\n', encoding='utf-8')
        (plugin / 'plugin.js').write_text('module.exports = {};\n', encoding='utf-8')
        (root / 'packages').mkdir()
        package = root / 'packages' / 'sample-1.0.0.zip'
        with ZipFile(package, 'w') as archive:
            archive.writestr('plugin.json', manifest)
            archive.writestr('plugin.js', b'module.exports = {};\n')
        (root / 'protocol.json').write_bytes((gate.TRUSTED / 'protocol.json').read_bytes())

    def test_candidate_index_is_ignored_and_entries_derived_from_sources(self):
        with _tmp() as root:
            self.candidate(root)
            (root / 'index-v5.json').write_text('[]', encoding='utf-8')
            gate.generate_index(root)
            data = gate.validator(root)
            self.assertTrue(data['ok'], data['errors'])
            self.assertEqual([entry['id'] for entry in data['entries']], ['sample'])
            self.assertEqual(data['entries'][0]['level'], 4)

    def test_gate_fails_closed_when_derivation_yields_no_entries(self):
        calls = []
        def fake_snapshot(repo, ref, target):
            calls.append(('snapshot', repo))
            if target.name == 'candidate':
                (target / 'plugins').mkdir(exist_ok=True)
        def fake_validator(root):
            calls.append(('validator', (root / 'protocol.json').is_file()))
            return {'ok': True, 'errors': [], 'entries': []}
        with _tmp() as work:
            # gate.py 的快照根目录也走系统 tmp，不再落回仓库里的 security/_tmp/。
            os.environ['MARKET_GATE_TMP'] = str(work)
            self.addCleanup(os.environ.pop, 'MARKET_GATE_TMP', None)
            changed = work / 'changed.json'
            changed.write_text(json.dumps([{'filename': 'packages/sample-1.0.0.zip', 'status': 'added'}]), encoding='utf-8')
            argv = ['gate.py', '--repo', 'o/r', '--ref', 'a' * 40, '--base-repo', 'o/r',
                    '--base', 'b' * 40, '--changed-files', str(changed),
                    '--output', str(work / 'out')]
            with patch.object(gate, 'snapshot', side_effect=fake_snapshot), \
                 patch.object(gate, 'trusted_protocol', return_value={'levels': {'4': {'runtime': 'node-full', 'entry': 'plugin.js'}}, 'limits': {}}), \
                 patch.object(gate, 'generate_index', side_effect=lambda root: calls.append(('index', (root / 'protocol.json').is_file()))), \
                 patch.object(gate, 'validator', side_effect=fake_validator), \
                 patch.object(gate, 'classify', return_value='submission'), \
                 patch.object(gate, 'subjects', side_effect=AssertionError('must not attest empty')), \
                 patch.object(gate.sys, 'argv', argv):
                with self.assertRaises(gate.GateError) as raised:
                    gate.main()
        self.assertEqual(raised.exception.code, 'no_v5_entries')
        self.assertIn(('validator', True), calls, 'protocol must exist before validator runs')
        self.assertIn(('index', True), calls, 'protocol must exist before index derivation runs')


class SnapshotTests(unittest.TestCase):
    def test_snapshot_downloads_display_files_and_never_candidate_index_v5(self):
        import audit
        tree = {'tree': [
            {'path': 'plugins/sample/plugin.json', 'type': 'blob', 'mode': '100644', 'size': 2},
            {'path': 'plugins/sample/README.md', 'type': 'blob', 'mode': '100644', 'size': 2},
            {'path': 'plugins/sample/market.json', 'type': 'blob', 'mode': '100644', 'size': 2},
            {'path': 'plugins/sample/preview.png', 'type': 'blob', 'mode': '100644', 'size': 2},
            {'path': 'index-v5.json', 'type': 'blob', 'mode': '100644', 'size': 2},
        ]}
        fetched = []
        with _tmp() as target, patch.object(audit, 'api', return_value=tree), \
                patch.object(audit, 'fetch', side_effect=lambda url, limit: fetched.append(url) or b'{}'):
            gate.snapshot('o/r', 'a' * 40, target)
            written = sorted(str(path.relative_to(target)).replace('\\', '/') for path in target.rglob('*') if path.is_file())
        self.assertIn('plugins/sample/README.md', written)
        self.assertIn('plugins/sample/market.json', written)
        self.assertIn('plugins/sample/preview.png', written)
        self.assertNotIn('index-v5.json', written, 'candidate index-v5 must never be trusted or downloaded')


class WorkflowShapeTests(unittest.TestCase):
    def test_trusted_copies_land_under_expected_path_and_are_asserted(self):
        body = (Path(gate.TRUSTED) / '.github/workflows/security.yml').read_text(encoding='utf-8')
        self.assertIn('mkdir -p "$RUNNER_TEMP/gate/trusted"', body)
        self.assertIn('cp -r security "$RUNNER_TEMP/gate/trusted/"', body)
        self.assertIn('test -f "$RUNNER_TEMP/gate/trusted/security/isolated.py"', body)
        self.assertIn('verified-packages', body)
        self.assertIn('actions/attest-build-provenance@v2', body)
        self.assertIn('--base-repo "$AUDIT_BASE_REPO"', body)


class AttestationTests(unittest.TestCase):
    def report(self):
        return {'status': 'passed', 'mode': 'submission',
                'entries': [{'id': 'sample', 'version': '1.0.0', 'sha256': 'd' * 64}]}

    def test_only_listed_package_hash_is_attested(self):
        with _tmp() as directory:
            root = Path(directory)
            packages = root / 'packages'
            file, _ = make_package(root)
            report = self.report()
            report['entries'][0]['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
            report_path = root / 'security-report.json'
            report_path.write_text(json.dumps(report), encoding='utf-8')
            subjects = attest_subjects.build(report_path, packages, root / 'out')
            self.assertEqual(subjects, ['sample-1.0.0.zip'])
            self.assertFalse(any((root / 'out/attest-subjects').glob('*.json')))

    def test_tampered_package_or_foreign_name_is_refused(self):
        with _tmp() as directory:
            root = Path(directory)
            packages = root / 'packages'
            file, _ = make_package(root)
            report = self.report()
            report['entries'][0]['sha256'] = 'e' * 64
            report_path = root / 'report.json'
            report_path.write_text(json.dumps(report), encoding='utf-8')
            with self.assertRaisesRegex(attest_subjects.AttestError, 'changed'):
                attest_subjects.build(report_path, packages, root / 'out')
            report['entries'][0]['id'] = '../evil'
            report['entries'][0]['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
            report_path.write_text(json.dumps(report), encoding='utf-8')
            with self.assertRaisesRegex(attest_subjects.AttestError, 'unsafe'):
                attest_subjects.build(report_path, packages, root / 'out2')

    def test_only_passed_submission_reports_are_attested(self):
        with _tmp() as directory:
            root = Path(directory)
            report_path = root / 'report.json'
            for status, mode in (('failed', 'submission'), ('passed', 'maintenance')):
                report_path.write_text(json.dumps({'status': status, 'mode': mode, 'entries': []}), encoding='utf-8')
                with self.assertRaisesRegex(attest_subjects.AttestError, 'passed submission'):
                    attest_subjects.build(report_path, root, root / 'out')

    def test_report_subjects_are_authoritative_and_duplicates_refused(self):
        with _tmp() as directory:
            root = Path(directory)
            file, _ = make_package(root)
            other, _ = make_package(root, plugin_id='other', version='2.0.0')
            sample = {'id': 'sample', 'version': '1.0.0', 'level': 4,
                      'sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
            second = {'id': 'other', 'version': '2.0.0', 'level': 4,
                      'sha256': hashlib.sha256(other.read_bytes()).hexdigest()}
            report = {'status': 'passed', 'mode': 'submission', 'entries': [sample, second],
                      'subjects': [{'path': 'attest-subjects/sample-1.0.0.zip', 'sha256': sample['sha256']}]}
            report_path = root / 'report.json'
            report_path.write_text(json.dumps(report), encoding='utf-8')
            subjects = attest_subjects.build(report_path, root / 'packages', root / 'out')
            self.assertEqual(subjects, ['sample-1.0.0.zip'])
            self.assertFalse((root / 'out/attest-subjects/other-2.0.0.zip').exists())

            report['subjects'].append({'path': 'attest-subjects/sample-1.0.0.zip', 'sha256': sample['sha256']})
            report_path.write_text(json.dumps(report), encoding='utf-8')
            with self.assertRaisesRegex(attest_subjects.AttestError, 'duplicate subject'):
                attest_subjects.build(report_path, root / 'packages', root / 'out2')

    def test_isolation_result_must_pass_and_bind_to_the_package(self):
        with _tmp() as directory:
            root = Path(directory)
            file, _ = make_package(root)
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            report = {'status': 'passed', 'mode': 'submission',
                      'entries': [{'id': 'sample', 'version': '1.0.0', 'level': 4,
                                   'sha256': digest, 'manifestSha256': 'd' * 64}]}
            report_path = root / 'report.json'
            report_path.write_text(json.dumps(report), encoding='utf-8')
            isolation = {'status': 'passed', 'entries': [{'id': 'sample', 'version': '1.0.0',
                                                          'status': 'passed', 'sha256': digest,
                                                          'manifestSha256': 'd' * 64}]}
            isolation_path = root / 'isolation-report.json'
            isolation_path.write_text(json.dumps(isolation), encoding='utf-8')
            self.assertEqual(attest_subjects.build(report_path, root / 'packages', root / 'out',
                                                    isolation_path), ['sample-1.0.0.zip'])
            for fault, message in (
                    ({'status': 'blocked'}, 'did not pass'),
                    ({'entries': []}, 'no result for executable package'),
                    ({'entries': [{'id': 'sample', 'version': '1.0.0', 'status': 'passed',
                                   'sha256': 'f' * 64, 'manifestSha256': 'd' * 64}]}, 'different package'),
                    ({'entries': [{'id': 'sample', 'version': '1.0.0', 'status': 'passed',
                                   'sha256': digest, 'manifestSha256': 'e' * 64}]}, 'different manifest')):
                bad = {'status': 'passed', 'entries': [], **fault}
                isolation_path.write_text(json.dumps(bad), encoding='utf-8')
                with self.subTest(fault=fault), self.assertRaisesRegex(attest_subjects.AttestError, message):
                    attest_subjects.build(report_path, root / 'packages', root / f'out-{message}',
                                          isolation_path)


if __name__ == '__main__':
    unittest.main()
