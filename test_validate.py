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
        (self.root / 'index.json').write_text('[]', encoding='utf-8')
        (self.root / 'packages').mkdir()

    def test_second_catalog_is_required(self):
        with self.assertRaises(FileNotFoundError):
            validate(self.root)

    def test_v2_package_and_its_hash_are_checked(self):
        manifest = {
            'Id': 'summary', 'Version': '1.0.0', 'Name': 'Summary', 'Author': 'Author',
            'Api': 2, 'Kind': 'tool', 'HostAction': 'chat.summary', 'MinAppVersion': '4.1.0',
            'Description': 'Formats summaries', 'ResultLabel': 'Summary',
        }
        name = 'summary-1.0.0.zip'
        path = self.root / 'packages' / name
        with ZipFile(path, 'w') as package:
            package.writestr('plugin.json', json.dumps(manifest))
            package.writestr('plugin.wasm', b'\x00asm\x01\x00\x00\x00')
        entry = {**manifest, 'Download': PREFIX + name, 'DiscussionIssue': 12,
                 'Sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
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
