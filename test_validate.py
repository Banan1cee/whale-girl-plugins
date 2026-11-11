import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from validate import PREFIX, validate


class CatalogTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.v2 = self.root / 'index-v2.json'
        self.v3 = self.root / 'index-v3.json'
        (self.root / 'index.json').write_text('[]', encoding='utf-8')
        self.v3.write_text('[]', encoding='utf-8')
        (self.root / 'packages').mkdir()

    def write_package(self, manifest):
        """按清单打一个包并返回目录条目（名与哈希都由清单决定）。"""
        name = f"{manifest['Id']}-{manifest['Version']}.zip"
        path = self.root / 'packages' / name
        with ZipFile(path, 'w') as package:
            package.writestr('plugin.json', json.dumps(manifest))
            package.writestr('plugin.wasm', b'\x00asm\x01\x00\x00\x00')
        return {**manifest, 'Download': PREFIX + name,
                'Sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def test_second_catalog_is_required(self):
        with self.assertRaises(FileNotFoundError):
            validate(self.root)

    def test_third_catalog_is_required(self):
        self.v2.write_text('[]', encoding='utf-8')
        self.v3.unlink()
        with self.assertRaises(FileNotFoundError):
            validate(self.root)

    def test_v2_package_and_its_hash_are_checked(self):
        manifest = {
            'Id': 'summary', 'Version': '1.0.0', 'Name': 'Summary', 'Author': 'Author',
            'Api': 2, 'Kind': 'tool', 'HostAction': 'chat.summary', 'MinAppVersion': '4.1.0',
            'Description': 'Formats summaries', 'ResultLabel': 'Summary',
        }
        entry = self.write_package(manifest)
        self.v2.write_text(json.dumps([entry]), encoding='utf-8')
        self.assertEqual(validate(self.root), 1)
        for changes, error in [
            ({'Sha256': '0' * 64}, 'SHA-256 mismatch'),
            ({'HostAction': 'wechat.send'}, 'invalid Api, Kind or HostAction'),
            ({'Author': 'someone else'}, 'manifest differs'),
        ]:
            with self.subTest(changes=changes):
                self.v2.write_text(json.dumps([{**entry, **changes}]), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'index-v2.json entry 1: .*' + error):
                    validate(self.root)

    def test_v3_message_entry_and_its_capabilities_are_checked(self):
        manifest = {
            'Id': 'followup', 'Version': '1.0.0', 'Name': 'Followup', 'Author': 'Author',
            'Api': 3, 'Kind': 'message', 'MinAppVersion': '4.1.0',
            'Description': 'Message plugin', 'ResultLabel': 'Decision',
            'Hooks': ['chat.pre_reply', 'chat.reply'], 'Permissions': [],
        }
        self.v2.write_text('[]', encoding='utf-8')
        entry = self.write_package(manifest)
        self.v3.write_text(json.dumps([entry]), encoding='utf-8')
        self.assertEqual(validate(self.root), 1)

        for changes, error in [
            ({'Hooks': ['chat.unknown']}, 'invalid Hooks'),
            ({'Hooks': ['chat.reply', 'chat.reply']}, 'invalid Hooks'),
            ({'Hooks': []}, 'invalid Hooks'),
            ({'Kind': 'tool'}, 'invalid Kind'),
            ({'HostAction': 'chat.summary'}, 'invalid HostAction'),
            ({'Permissions': ['chat.history', 'model.prompt', 'files']}, 'invalid Permissions'),
            ({'Permissions': ['files']}, 'invalid Permissions'),
            ({'MinAppVersion': '4.0.9'}, 'Api 3 requires MinAppVersion'),
        ]:
            with self.subTest(changes=changes):
                broken = {**manifest, **changes}
                broken_entry = self.write_package(broken)
                self.v3.write_text(json.dumps([broken_entry]), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'index-v3.json entry 1: .*' + error):
                    validate(self.root)
