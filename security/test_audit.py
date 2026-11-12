import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audit


def leb(value):
    result = []
    while True:
        byte = value & 127
        value >>= 7
        result.append(byte | (128 if value else 0))
        if not value:
            return bytes(result)


def wasm_output(value, import_module='whale'):
    def string(value):
        raw = value.encode()
        return leb(len(raw)) + raw
    def section(kind, data):
        return bytes([kind]) + leb(len(data)) + data
    body = b'\x00'
    for byte in json.dumps(value).encode():
        # ASCII JSON 字节均 < 128；正的 i32.const 需显式终止符号位。
        body += b'\x41' + bytes([(byte & 127) | 128, byte >> 7]) + b'\x10\x00'
    body += b'\x41\x00\x0b'
    return (b'\x00asm\x01\x00\x00\x00'
            + section(1, b'\x02\x60\x01\x7f\x00\x60\x00\x01\x7f')
            + section(2, b'\x01' + string(import_module) + string('output_byte') + b'\x00\x00')
            + section(3, b'\x01\x01')
            + section(7, b'\x01' + string('run') + b'\x00\x01')
            + section(10, b'\x01' + leb(len(body)) + body))


class AuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime_dir = tempfile.TemporaryDirectory()
        cls.runtime = Path(cls.runtime_dir.name) / 'runtime.cjs'
        configured = os.environ.get('MARKET_TEST_RUNTIME')
        pin = audit.json_data((audit.TRUSTED / 'security/runtime.json').read_bytes())
        data = Path(configured).read_bytes() if configured else audit.fetch(
            f"https://raw.githubusercontent.com/{pin['repository']}/{pin['commit']}/{pin['path']}", 100000)
        if hashlib.sha256(data).hexdigest() != pin['sha256']:
            raise AssertionError('host runtime pin mismatch')
        cls.runtime.write_bytes(data)

    @classmethod
    def tearDownClass(cls):
        cls.runtime_dir.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'candidate'
        self.root.mkdir()
        self.out = Path(temporary.name) / 'report'
        (self.root / 'packages').mkdir()
        (self.root / 'provenance').mkdir()
        for name in audit.CATALOG_NAMES:
            (self.root / name).write_text('[]', encoding='utf-8')

    def package(self, *, persona=False, module=None, extra=None, manifest_over=None):
        manifest = {'Id': 'sample', 'Version': '1.0.0', 'Name': 'Sample', 'Author': 'Author',
                    'Api': 1 if persona else 3, 'Kind': 'persona' if persona else 'message',
                    'MinAppVersion': '4.1.0', 'Description': '', 'ResultLabel': 'Result'}
        if not persona:
            manifest.update(Hooks=['chat.reply', 'chat.pre_reply'], Permissions=[])
        manifest.update(manifest_over or {})
        file = self.root / 'packages/sample-1.0.0.zip'
        with ZipFile(file, 'w') as package:
            package.writestr('plugin.json', json.dumps(manifest))
            package.writestr('persona.json' if persona else 'plugin.wasm',
                             json.dumps({'customPrompt': '温和自然'}) if persona else
                             (module if module is not None else wasm_output({'state': {}})))
            if extra:
                package.writestr(extra, b'never executed')
        entry = {**manifest, 'Download': audit.PREFIX + file.name,
                 'Sha256': hashlib.sha256(file.read_bytes()).hexdigest()}
        catalog = 'index-personas.json' if persona else 'index-v3.json'
        (self.root / catalog).write_text(json.dumps([entry]), encoding='utf-8')
        proof = {'publisher': {'login': 'example', 'id': 123},
                 'source': {'repository': 'example/plugin', 'commit': 'a' * 40, 'path': 'src'}}
        (self.root / 'provenance/sample-1.0.0.json').write_text(json.dumps(proof), encoding='utf-8')
        return entry

    def run_audit(self, runtime=True):
        return audit.audit(self.root, self.out, self.runtime if runtime else None)

    def test_persona_uses_static_checks_without_a_runtime(self):
        self.package(persona=True)
        with patch.object(audit.subprocess, 'run', side_effect=AssertionError('must not execute')):
            report = self.run_audit(runtime=False)
        self.assertEqual(report['plugins'][0]['mode'], 'static')

    def test_persona_cannot_hide_script_or_wasm(self):
        for extra in ('plugin.wasm', 'install.ps1', '../outside.exe'):
            with self.subTest(extra=extra):
                self.package(persona=True, extra=extra)
                with self.assertRaisesRegex(ValueError, 'unexpected ZIP entries'):
                    self.run_audit(runtime=False)

    def test_persona_cannot_claim_message_permissions(self):
        self.package(persona=True, manifest_over={'Permissions': ['chat.history']})
        with self.assertRaisesRegex(ValueError, 'executable capabilities'):
            self.run_audit()

    def test_api3_runs_real_host_and_binds_the_package_hash(self):
        entry = self.package()
        report = self.run_audit()
        result = report['plugins'][0]
        self.assertEqual(result['sha256'], entry['Sha256'])
        self.assertEqual(result['runtime']['calls'], 8)
        self.assertIn('disable', result['runtime']['checks'])
        self.assertFalse(result['provenance']['identity_verified'])
        self.assertEqual((self.out / 'sample-1.0.0.zip').read_bytes(),
                         (self.root / 'packages/sample-1.0.0.zip').read_bytes())

    def test_hash_tamper_is_rejected(self):
        self.package()
        with (self.root / 'packages/sample-1.0.0.zip').open('ab') as file:
            file.write(b'tampered')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'):
            self.run_audit()
        report = json.loads((self.out / 'security-report.json').read_text())
        self.assertEqual(report['status'], 'failed')

    def test_api3_requires_provenance(self):
        self.package()
        (self.root / 'provenance/sample-1.0.0.json').unlink()
        with self.assertRaisesRegex(ValueError, 'requires provenance'):
            self.run_audit()

    def test_foreign_import_is_rejected(self):
        self.package(module=wasm_output({}, 'wasi_snapshot_preview1'))
        with self.assertRaisesRegex(ValueError, 'runtime rejected'):
            self.run_audit()

    def test_infinite_loop_is_terminated_and_fails_gate(self):
        self.package(module=bytes.fromhex('0061736d010000000105016000017f030201000707010372756e00000a0b01090003400c000b41000b'))
        with self.assertRaisesRegex(ValueError, 'timeout'):
            self.run_audit()

    def test_prompt_without_permission_is_rejected(self):
        self.package(module=wasm_output({'system': 'override'}), manifest_over={'Hooks': ['chat.prompt']})
        with self.assertRaisesRegex(ValueError, 'invalid_system'):
            self.run_audit()

    def test_invalid_output_is_not_mistaken_for_successful_fallback(self):
        self.package(module=wasm_output({'execute': 'powershell'}))
        with self.assertRaisesRegex(ValueError, 'invalid_output'):
            self.run_audit()

    def test_runtime_cannot_be_replaced(self):
        self.package()
        fake = self.root / 'fake-runtime.cjs'
        fake.write_text('throw Error("must not run")')
        with self.assertRaisesRegex(ValueError, 'runtime hash mismatch'):
            audit.audit(self.root, self.out, fake)

    def test_publisher_cannot_impersonate_another_account_id(self):
        entry = self.package()
        with patch.object(audit, 'api', return_value={'id': 999, 'owner': {'id': 999}}):
            with self.assertRaisesRegex(ValueError, 'publisher must match'):
                audit.provenance(self.root, entry, True)

    def test_source_must_pin_an_existing_commit_and_path(self):
        entry = self.package()
        responses = [{'id': 123}, {'owner': {'id': 123}}, {'tree': []}]
        with patch.object(audit, 'api', side_effect=responses):
            with self.assertRaisesRegex(ValueError, 'source commit/path not found'):
                audit.provenance(self.root, entry, True)

    def test_duplicate_keys_and_path_traversal_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
            audit.json_data('{"Api":1,"Api":3}')
        for value in ('../secret', '/secret', 'a/../b', 'a\\b'):
            with self.assertRaisesRegex(ValueError, 'invalid relative path'):
                audit.safe_path(value)
        for repo in ('../..', 'owner/..', '/repo', 'owner/repo/extra'):
            self.assertIsNone(audit.REPOSITORY.fullmatch(repo))

    def test_published_package_is_immutable(self):
        self.package()
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'packages').mkdir()
            (base / 'packages/sample-1.0.0.zip').write_bytes(b'old package')
            with self.assertRaisesRegex(ValueError, 'cannot be changed'):
                audit.ensure_immutable(self.root, base)

    def test_snapshot_never_downloads_or_executes_candidate_scripts(self):
        tree = {'tree': [{'path': 'install.ps1', 'type': 'blob', 'mode': '100644', 'size': 5},
                         {'path': 'security/audit.py', 'type': 'blob', 'mode': '100644', 'size': 5}]}
        with patch.object(audit, 'api', return_value=tree), patch.object(audit, 'fetch') as fetch:
            audit.snapshot('example/plugin', 'a' * 40, self.root)
        fetch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
