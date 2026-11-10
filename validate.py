"""Validate market entries and repository-hosted packages without running plugin code."""
import hashlib
import json
from pathlib import Path
import re
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
PREFIX = 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/'
seen = set()
for entry in json.loads((ROOT / 'index.json').read_text(encoding='utf-8')):
    plugin_id = entry['Id']
    assert re.fullmatch(r'[a-z][a-z0-9-]{0,47}', plugin_id) and plugin_id not in seen
    seen.add(plugin_id)
    assert entry['Api'] == 1
    assert re.fullmatch(r'\d+\.\d+\.\d+(\.\d+)?', entry['Version'])
    assert re.fullmatch(r'\d+\.\d+\.\d+(\.\d+)?', entry['MinAppVersion'])
    assert re.fullmatch(r'[a-fA-F0-9]{64}', entry['Sha256'])
    assert entry['Download'].startswith('https://')
    if entry['Download'].startswith(PREFIX):
        name = entry['Download'].removeprefix(PREFIX)
        assert name == f'{plugin_id}-{entry["Version"]}.zip'
        file = ROOT / 'packages' / name
        assert file.stat().st_size <= 1024 * 1024
        assert hashlib.sha256(file.read_bytes()).hexdigest() == entry['Sha256'].lower()
        with ZipFile(file) as package:
            assert sorted(package.namelist()) == ['plugin.json', 'plugin.wasm']
            assert package.getinfo('plugin.json').file_size <= 8192
            assert package.getinfo('plugin.wasm').file_size <= 512 * 1024
            assert json.loads(package.read('plugin.json')) == {
                k: v for k, v in entry.items() if k not in ('Download', 'Sha256')
            }
            assert package.read('plugin.wasm').startswith(b'\x00asm\x01\x00\x00\x00')
print(f'Validated {len(seen)} market entries.')
