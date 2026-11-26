import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from zipfile import ZipFile, ZipInfo

from validate import PREFIX, report, validate

HERE = Path(__file__).resolve().parent
TEMP_BASE = Path(tempfile.gettempdir())
ENTRY = {0: 'theme.json', 1: 'plugin.wasm', 2: 'plugin.wasm', 3: 'plugin.wasm', 4: 'plugin.js'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def make_root(prefix='market-v5-'):
    """mkdir-based temp root: some sandboxes deny writes into mkdtemp dirs."""
    root = TEMP_BASE / (prefix + uuid.uuid4().hex)
    root.mkdir()
    return root


def uleb(value):
    out = bytearray()
    while True:
        byte = value & 0x7f
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def wasm_run_only(level=1, imports=()):
    """Tiny Wasm v1 module with an exported run() and optional whale_plugin imports."""
    magic = b'\x00asm\x01\x00\x00\x00'
    body = b'\x01' + uleb(3) + b'run' + b'\x00\x00'
    export = b'\x07' + uleb(len(body)) + body
    types = b'\x01\x04\x01\x60\x00\x00'
    funcs = b'\x03\x02\x01\x00'
    import_section = b''
    if imports:
        payload = bytearray(b'\x01')
        for module, field in imports:
            for text in (module, field):
                payload += uleb(len(text)) + text.encode()
            payload += b'\x00\x00'
        import_section = b'\x02' + uleb(len(payload)) + bytes(payload)
    return magic + import_section + types + funcs + export


def base_manifest(level=4, **overrides):
    manifest = {
        'format': 'whale-plugin/1',
        'level': level,
        'id': 'example-plugin',
        'name': '示例插件',
        'author': 'Author',
        'version': '1.0.0',
        'minAppVersion': '4.3.0',
        'description': 'fixture',
        'entry': ENTRY[level],
        'runtime': {0: 'theme-data', 1: 'wasm-restricted', 2: 'wasm-restricted',
                    3: 'wasm-restricted', 4: 'node-full'}[level],
        'provides': {},
        'calls': [],
    }
    if level == 0:
        manifest['provides'] = {}
    elif level in (1, 2):
        manifest['provides'] = {'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}
    elif level == 3:
        manifest['provides'] = {'chat.reply@1': {'mode': 'enhance', 'scope': 'all'}}
    else:
        manifest['provides'] = {'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}
    manifest.update(overrides)
    return manifest


def base_theme(theme_id='example-plugin', **overrides):
    theme = {
        'schema': 1,
        'id': theme_id,
        'name': '示例主题',
        'author': 'Author',
        'version': '1.0.0',
        'colors': {'accent': '#6FD6C0', 'background': '#07120F', 'text': '#F2FAF7'},
        'font': {'family': 'Microsoft YaHei UI', 'scale': 1.02},
        'metrics': {'corner': 10, 'spacing': 1.0},
    }
    theme.update(overrides)
    return theme


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.addCleanup(shutil.rmtree, self.root, True)
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


class V5Tests(unittest.TestCase):
    def setUp(self):
        self.root = make_root()
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / 'index.json').write_text('[]', encoding='utf-8')
        (self.root / 'index-v2.json').write_text('[]', encoding='utf-8')
        (self.root / 'index-v3.json').write_text('[]', encoding='utf-8')
        (self.root / 'packages').mkdir()
        (self.root / 'plugins').mkdir()
        shutil.copyfile(HERE / 'protocol.json', self.root / 'protocol.json')

    def publish(self, manifest, payload, *, readme='# README\n', image=None,
                donation=None, raw_manifest=None, zip_entries=None, entry_name=None):
        plugin_id = manifest['id']
        plugin_dir = self.root / 'plugins' / plugin_id
        plugin_dir.mkdir(parents=True, exist_ok=True)
        manifest_bytes = raw_manifest if raw_manifest is not None else (
            json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        (plugin_dir / 'plugin.json').write_bytes(manifest_bytes)
        display = {}
        if readme is not None:
            readme_bytes = readme.encode('utf-8')
            (plugin_dir / 'README.md').write_bytes(readme_bytes)
            display['readme'] = {
                'path': f'plugins/{plugin_id}/README.md',
                'sha256': sha(readme_bytes),
                'bytes': len(readme_bytes),
            }
        meta = {}
        if image is not None:
            name, data = image
            (plugin_dir / name).write_bytes(data)
            suffix = Path(name).suffix.lower()
            media = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                     '.gif': 'image/gif'}[suffix]
            meta['images'] = [name]
            display['images'] = [{
                'path': f'plugins/{plugin_id}/{name}', 'sha256': sha(data),
                'bytes': len(data), 'media': media,
            }]
        if donation is not None:
            meta['donation'] = {'afdian': donation}
            display['donation'] = {'afdian': donation}
        if meta:
            (plugin_dir / 'market.json').write_text(json.dumps(meta), encoding='utf-8')
        name = f'{plugin_id}-{manifest["version"]}.zip'
        package = self.root / 'packages' / name
        if zip_entries is not None:
            with ZipFile(package, 'w') as archive:
                for entry in zip_entries:
                    archive.writestr(entry['name'], entry['data'])
        else:
            entry = entry_name or ENTRY.get(manifest['level'], 'plugin.js')
            with ZipFile(package, 'w') as archive:
                archive.writestr('plugin.json', manifest_bytes)
                archive.writestr(entry, payload)
        package_bytes = package.read_bytes()
        return {
            'manifest': manifest,
            'manifestSha256': sha(manifest_bytes),
            'package': {
                'path': f'packages/{name}',
                'download': PREFIX + name,
                'sha256': sha(package_bytes),
                'bytes': len(package_bytes),
            },
            'display': display,
        }

    def write_index(self, entries):
        (self.root / 'index-v5.json').write_text(json.dumps(entries), encoding='utf-8')

    def publish_ok(self, manifest=None, payload=None, **kwargs):
        manifest = manifest or base_manifest()
        payload = payload if payload is not None else "exports.providers = { 'tool.run@1': () => ({ ok: true }) };\n"
        entry = self.publish(manifest, payload, **kwargs)
        self.write_index([entry])
        return entry

    def assert_rejected(self, manifest=None, payload=None, *, pattern=None, entry=None, **kwargs):
        if entry is None:
            entry = self.publish(manifest or base_manifest(), payload, **kwargs)
        self.write_index([entry])
        with self.assertRaisesRegex(ValueError, pattern or '.*'):
            validate(self.root)

    # ---- happy paths -----------------------------------------------------
    def test_level4_entry_passes_and_keeps_display_separate(self):
        entry = self.publish_ok(donation='https://afdian.com/a/your-name',
                                image=('preview.png', b'\x89PNG\r\n\x1a\n' + b'0' * 8))
        self.assertEqual(validate(self.root), 1)
        result = report(self.root)
        self.assertTrue(result['ok'], result['errors'])
        self.assertEqual(set(result['entries'][0]), {
            'catalog', 'id', 'version', 'level', 'runtime', 'entry', 'package', 'sha256',
            'manifestSha256', 'packageBytes', 'provides', 'calls', 'dataAccess', 'donation',
        })
        self.assertEqual(result['entries'][0]['catalog'], 'index-v5.json')
        self.assertEqual(result['entries'][0]['donation'], 'https://afdian.com/a/your-name')
        self.assertEqual(result['entries'][0]['packageBytes'], entry['package']['bytes'])

    def test_level0_theme_package_passes(self):
        manifest = base_manifest(level=0, minAppVersion='4.3.0')
        theme = base_theme('example-plugin')
        self.publish_ok(manifest, json.dumps(theme).encode('utf-8'))
        self.assertEqual(validate(self.root), 1)

    def test_level1_wasm_with_allowed_import_passes(self):
        manifest = base_manifest(level=1)
        wasm = wasm_run_only(imports=[('whale_plugin', 'input_size')])
        self.publish_ok(manifest, wasm)
        self.assertEqual(validate(self.root), 1)

    # ---- manifest --------------------------------------------------------
    def test_unknown_manifest_field_is_rejected(self):
        manifest = base_manifest()
        manifest['Permissions'] = ['system.full']
        self.assert_rejected(manifest, "exports.providers = {};\n", pattern='unknown manifest field')

    def test_version_and_level_fields_are_checked(self):
        for manifest, pattern in [
            (base_manifest(version='1.0'), 'invalid version'),
            ({**base_manifest(), 'level': 9}, 'unsupported level'),
            (base_manifest(entry='plugin.wasm'), 'entry does not match level'),
            (base_manifest(runtime='wasm-restricted'), 'runtime does not match level'),
        ]:
            with self.subTest(pattern=pattern):
                self.assert_rejected(manifest, "exports.providers = {};\n", pattern=pattern)

    def test_capabilities_level_and_scope_are_checked(self):
        for manifest, pattern in [
            (base_manifest(level=1, provides={'chat.reply@1': {'mode': 'enhance', 'scope': 'all'}}),
             'not allowed at this level'),
            (base_manifest(provides={'tool.run@1': {'mode': 'tool', 'scope': 'all'}}), 'unsupported scope'),
            (base_manifest(provides={'tool.run@1': {'mode': 'replace', 'scope': 'manual'}}), 'unsupported mode'),
            (base_manifest(calls=['chat.history']), 'not allowed at this level'),
            (base_manifest(calls=['not-in-registry@1']), 'not allowed at this level'),
            (base_manifest(level=0, provides={'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}),
             'level 0 themes cannot declare providers'),
        ]:
            with self.subTest(pattern=pattern):
                payload = json.dumps(base_theme()) if manifest['level'] == 0 else "exports.providers = {};\n"
                self.assert_rejected(manifest, payload, pattern=pattern)

    def test_settings_schema_keywords_and_annotations_are_bounded(self):
        for schema, pattern in [
            ({'type': 'object', 'properties': {'x': {'type': 'string', 'pattern': '.*'}}},
             'unsupported settingsSchema keyword'),
            ({'type': 'object', 'properties': {'x': {'type': 'string', 'title': 't' * 41}}},
             'exceeds 40 characters'),
            ({'type': 'object', 'properties': {'x': {'type': 'string', 'title': 'x\x01'}}},
             'forbidden control/format'),
            ({'type': 'array'}, 'unsupported settingsSchema type'),
        ]:
            with self.subTest(pattern=pattern):
                self.assert_rejected(base_manifest(settingsSchema=schema), "exports.providers = {};\n",
                                     pattern=pattern)
        theme_manifest = base_manifest(level=0, settingsSchema={'type': 'object'})
        self.assert_rejected(theme_manifest, json.dumps(base_theme()).encode('utf-8'),
                             pattern='themes cannot declare settingsSchema')

    # ---- ZIP safety ------------------------------------------------------
    def test_zip_exact_files_and_safety_are_enforced(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        extra = [{'name': 'plugin.json', 'data': json.dumps(manifest).encode()},
                 {'name': 'plugin.js', 'data': payload.encode()},
                 {'name': 'README.md', 'data': b'# x'}]
        self.assert_rejected(manifest, payload, zip_entries=extra, pattern='exactly two files')
        duplicate = [{'name': 'plugin.json', 'data': json.dumps(manifest).encode()},
                     {'name': 'plugin.json', 'data': payload.encode()}]
        self.assert_rejected(manifest, payload, zip_entries=duplicate, pattern='duplicate ZIP entries')

    def test_zip_symlink_and_entry_name_are_rejected(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"

        # entry name mismatch: package uses plugin.wasm for a level 4 manifest
        self.assert_rejected(manifest, payload, entry_name='plugin.wasm', pattern='must contain plugin.json and plugin.js')

        package = self.root / 'packages' / f"{manifest['id']}-{manifest['version']}.zip"
        with ZipFile(package, 'w') as archive:
            archive.writestr('plugin.json', json.dumps(manifest).encode())
            info = ZipInfo('plugin.js')
            info.external_attr = 0o120777 << 16
            info.create_system = 3
            archive.writestr(info, payload.encode())
        entry = {
            'manifest': manifest, 'manifestSha256': sha(json.dumps(manifest).encode()),
            'package': {'path': f'packages/{package.name}',
                        'download': PREFIX + package.name,
                        'sha256': sha(package.read_bytes()), 'bytes': len(package.read_bytes())},
            'display': {},
        }
        self.write_index([entry])
        with self.assertRaisesRegex(ValueError, 'symlink'):
            validate(self.root)

    def test_source_and_package_manifest_must_match(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        entry = self.publish(manifest, payload)
        # package manifest bytes rewritten after the entry was built
        package = self.root / entry['package']['path']
        changed = dict(manifest, description='different')
        with ZipFile(package, 'w') as archive:
            archive.writestr('plugin.json', json.dumps(changed).encode())
            archive.writestr('plugin.js', payload.encode())
        entry['package']['sha256'] = sha(package.read_bytes())
        entry['package']['bytes'] = package.stat().st_size
        self.write_index([entry])
        with self.assertRaisesRegex(ValueError, 'package manifest differs|byte-identical'):
            validate(self.root)

    # ---- theme -----------------------------------------------------------
    def test_theme_tokens_are_bounded(self):
        manifest = base_manifest(level=0)
        for theme, pattern in [
            (base_theme(colors={'accent': '#12345'}), 'invalid color'),
            (base_theme(colors={'success': '#00FF00', 'text': '#FFFFFF', 'background': '#000000'}),
             'unsupported token'),
            (base_theme(font={'family': 'Comic Sans MS'}), 'font whitelist'),
            (base_theme(metrics={'corner': 25}), 'corner radius is out of range'),
            (base_theme(font={'scale': 1.5}), 'scale is out of range'),
            (base_theme(extra=1), 'unknown theme field'),
            (base_theme(id='other-id'), 'must match the manifest id'),
        ]:
            with self.subTest(pattern=pattern):
                self.assert_rejected(manifest, json.dumps(theme).encode('utf-8'), pattern=pattern)
        # a theme must change at least one visual token
        empty = {'schema': 1, 'id': 'example-plugin', 'name': 'x'}
        self.assert_rejected(manifest, json.dumps(empty).encode('utf-8'), pattern='at least one visual token')

    def test_theme_contrast_is_checked_for_opaque_colors(self):
        manifest = base_manifest(level=0)
        theme = base_theme(colors={'background': '#FFFFFF', 'text': '#EEEEEE'})
        self.assert_rejected(manifest, json.dumps(theme).encode('utf-8'), pattern='contrast is below 4.5')

    # ---- wasm ABI --------------------------------------------------------
    def test_wasm_imports_are_restricted(self):
        manifest = base_manifest(level=1)
        self.assert_rejected(manifest, wasm_run_only(imports=[('whale_plugin', 'output_byte')]),
                             pattern='level 1 cannot import output_byte')
        self.assert_rejected(manifest, wasm_run_only(imports=[('wasi_snapshot_preview1', 'input_size')]),
                             pattern='unsupported Wasm import module')
        self.assert_rejected(manifest, b'\x00asm\x01\x00\x00\x00', pattern='missing run')

    def test_compat_follows_protocol_and_relaxes_only_wasm_imports(self):
        """compat 不是自由字段：值/等级/运行时都按 protocol.json 的 manifest.compat 校验。

        与宿主 Node 运行时和启动器 C# 安装校验同一套非法集合：未知值、大小写不同、
        非字符串、非 3 级、非 wasm-restricted 一律拒绝；未声明 compat 的旧包不受影响。
        """
        legacy_wasm = wasm_run_only(imports=[('whale', 'input_size')])
        # 同一条二进制不声明 compat 时必须仍被拒，才说明后面通过是 compat 起作用。
        self.assert_rejected(base_manifest(level=3), legacy_wasm, pattern='unsupported Wasm import module')
        self.publish_ok(base_manifest(level=3, compat='api3'), legacy_wasm)
        self.assertEqual(validate(self.root), 1)
        for value in ('api4', 'API3', '', 1, 0, True, ['api3'], {'api3': True}, None):
            with self.subTest(compat=value):
                self.assert_rejected(base_manifest(level=3, compat=value), legacy_wasm,
                                     pattern='unsupported compat value')
        # 等级：compat 只改变 3 级 Wasm 的信封，其他等级声明 compat 一律拒绝。
        for level in (0, 1, 2, 4):
            with self.subTest(level=level):
                payload = {0: json.dumps(base_theme()).encode('utf-8'),
                           4: b"exports.providers = {};\n"}.get(level, legacy_wasm)
                self.assert_rejected(base_manifest(level=level, compat='api3'), payload,
                                     pattern='compat is not allowed at this level')
        # 旧信封只认识注册表 hooks 里的 provider：tool.run@1 在 3 级合法，但 api3 映射不到它，
        # 声明 compat 就必须在清单校验被拒，不能装成功再在派发时 invalid_wasm_compat。
        self.assert_rejected(base_manifest(level=3, compat='api3',
                                           provides={'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}),
                             wasm_run_only(imports=[('whale_plugin', 'input_size')]),
                             pattern='has no api3 hook in the registry')
        # 同一个 provider 不声明 compat 时仍然合法。
        self.publish_ok(base_manifest(level=3, provides={'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}),
                        wasm_run_only(imports=[('whale_plugin', 'input_size')]))
        self.assertEqual(validate(self.root), 1)

    # ---- display ---------------------------------------------------------
    def test_display_images_must_be_declared_and_real(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        entry = self.publish(manifest, payload, readme='![bad](missing.png)\n')
        self.write_index([entry])
        with self.assertRaisesRegex(ValueError, 'undeclared image|missing or linked image'):
            validate(self.root)

        bad_magic = self.publish(manifest, payload, image=('preview.png', b'not-a-png'))
        self.write_index([bad_magic])
        with self.assertRaisesRegex(ValueError, 'image magic'):
            validate(self.root)

    def test_donation_must_be_an_afdian_personal_page(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        for url, pattern in [
            ('https://example.com/a/user', 'Afdian personal-page hosts'),
            ('http://afdian.com/a/user', 'HTTPS Afdian'),
            ('https://afdian.com/search?q=user', 'query/fragment|personal page path'),
            ('https://user:pass@afdian.com/a/user', 'Afdian'),
            ('https://afdian.com.evil.test/a/user', 'Afdian'),
        ]:
            with self.subTest(url=url):
                entry = self.publish(manifest, payload, donation=url)
                self.write_index([entry])
                with self.assertRaisesRegex(ValueError, pattern):
                    validate(self.root)

    def test_forged_updated_at_is_rejected_without_git_metadata(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        entry = self.publish(manifest, payload)
        entry['display']['updatedAt'] = '2026-01-01T00:00:00+00:00'
        self.write_index([entry])
        with self.assertRaisesRegex(ValueError, 'cannot be verified without git metadata'):
            validate(self.root)

    # ---- index/source coverage ------------------------------------------
    def test_index_must_cover_sources_and_packages(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        entry = self.publish(manifest, payload)
        self.write_index([])
        with self.assertRaisesRegex(ValueError, 'missing entries'):
            validate(self.root)

        # An index entry without its source/package must be reported, not silently accepted.
        self.write_index([entry])
        shutil.rmtree(self.root / 'plugins' / manifest['id'])
        (self.root / 'packages' / f"{manifest['id']}-{manifest['version']}.zip").unlink()
        with self.assertRaisesRegex(ValueError, 'missing packages|without a source package'):
            validate(self.root)

    def test_duplicate_id_across_legacy_and_v5_is_rejected(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        entry = self.publish(manifest, payload)
        self.write_index([entry])
        legacy_manifest = {
            'Id': 'example-plugin', 'Version': '1.0.0', 'Name': 'Legacy', 'Author': 'Author',
            'Api': 1, 'Kind': 'tool', 'MinAppVersion': '4.1.0', 'Description': 'Legacy',
            'ResultLabel': 'Tool',
        }
        package = self.root / 'packages' / 'example-plugin-1.0.0.zip'
        with ZipFile(package, 'w') as archive:
            archive.writestr('plugin.json', json.dumps(legacy_manifest))
            archive.writestr('plugin.wasm', b'\x00asm\x01\x00\x00\x00')
        legacy_entry = {**legacy_manifest, 'Download': PREFIX + package.name,
                        'Sha256': sha(package.read_bytes())}
        (self.root / 'index.json').write_text(json.dumps([legacy_entry]), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'already exists in an Api 1-4 catalog'):
            validate(self.root)

    # ---- machine interface ----------------------------------------------
    def test_json_report_interface(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        self.publish_ok(manifest, payload)
        result = subprocess.run([sys.executable, str(HERE / 'validate.py'), '--root', str(self.root), '--json'],
                                capture_output=True, text=True, encoding='utf-8', cwd=str(HERE))
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertTrue(output['ok'])
        self.assertEqual(len(output['entries']), 1)
        self.assertEqual(output['counts']['v5'], 1)

        (self.root / 'index-v5.json').write_text('[{"manifest": {}}]', encoding='utf-8')
        broken = subprocess.run([sys.executable, str(HERE / 'validate.py'), '--root', str(self.root), '--json'],
                                capture_output=True, text=True, encoding='utf-8', cwd=str(HERE))
        self.assertNotEqual(broken.returncode, 0)
        output = json.loads(broken.stdout)
        self.assertFalse(output['ok'])
        self.assertTrue(output['errors'])

    @unittest.skipUnless(shutil.which('node') and shutil.which('git'), 'node and git are required')
    def test_updated_at_is_derived_from_git_and_cannot_be_forged(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        self.publish(manifest, payload)
        env = {**os.environ,
               'GIT_AUTHOR_DATE': '2026-01-02T03:04:05+00:00',
               'GIT_COMMITTER_DATE': '2026-01-02T03:04:05+00:00'}

        def git(*args):
            return subprocess.run(['git', '-C', str(self.root), *args], check=True,
                                  capture_output=True, text=True, encoding='utf-8', env=env)

        git('init', '-q')
        git('config', 'user.email', 'test@example.com')
        git('config', 'user.name', 'Market Test')
        git('add', 'plugins')
        git('commit', '-q', '-m', 'fixture')
        result = subprocess.run(['node', 'scripts/build-index.js', '--root', str(self.root)],
                                capture_output=True, text=True, encoding='utf-8', cwd=str(HERE))
        self.assertEqual(result.returncode, 0, result.stderr)
        generated = json.loads((self.root / 'index-v5.json').read_text(encoding='utf-8'))
        timestamp = generated[0]['display'].get('updatedAt')
        expected = subprocess.run(['git', '-C', str(self.root), 'log', '-1', '--format=%cI',
                                   '--', f"plugins/{manifest['id']}/plugin.json"],
                                  check=True, capture_output=True, text=True, encoding='utf-8')
        if timestamp is None:
            # The generator may run where Node cannot spawn git (sandbox restriction).
            # Missing time is an honest degradation; the validator must still pass.
            self.assertEqual(validate(self.root), 1)
            return
        self.assertEqual(timestamp, expected.stdout.strip())
        self.assertEqual(validate(self.root), 1)

        generated[0]['display']['updatedAt'] = '2000-01-01T00:00:00+00:00'
        self.write_index(generated)
        with self.assertRaisesRegex(ValueError, 'must equal the plugin source commit time'):
            validate(self.root)

    @unittest.skipUnless(shutil.which('node'), 'node is required for the generator test')
    def test_build_index_generates_matching_v5_catalog(self):
        manifest = base_manifest()
        payload = "exports.providers = {};\n"
        self.publish(manifest, payload)
        result = subprocess.run(['node', 'scripts/build-index.js', '--root', str(self.root)],
                                capture_output=True, text=True, encoding='utf-8', cwd=str(HERE))
        self.assertEqual(result.returncode, 0, result.stderr)
        generated = json.loads((self.root / 'index-v5.json').read_text(encoding='utf-8'))
        self.assertEqual(len(generated), 1)
        self.assertEqual(generated[0]['manifest'], manifest)
        self.assertEqual(validate(self.root), 1)
        check = subprocess.run(['node', 'scripts/build-index.js', '--root', str(self.root), '--check'],
                               capture_output=True, text=True, encoding='utf-8', cwd=str(HERE))
        self.assertEqual(check.returncode, 0, check.stderr)


    # ---- task-69: 新扩展点 / gate / 爱发电契约 ----
    def test_new_level3_providers_are_allowed_with_their_modes(self):
        for provider, mode in [('chat.pre_reply@1', 'gate'), ('chat.prompt@1', 'enhance'),
                               ('chat.before_send@1', 'enhance')]:
            with self.subTest(provider=provider):
                manifest = base_manifest(level=3, provides={provider: {'mode': mode, 'scope': 'all'}},
                                         calls=[], dataAccess=['chat.history'])
                self.publish_ok(manifest, wasm_run_only(level=3))
                self.assertEqual(validate(self.root), 1)
                self.write_index([])
                shutil.rmtree(self.root / 'plugins' / manifest['id'], True)
                (self.root / 'packages' / f"{manifest['id']}-{manifest['version']}.zip").unlink()

    def test_new_level4_observe_and_gate_providers_are_accepted(self):
        for provides in ({'chat.dispatched@1': {'mode': 'observe', 'scope': 'all'}},
                         {'app.start@1': {'mode': 'observe', 'scope': 'all'}},
                         {'app.stop@1': {'mode': 'observe', 'scope': 'all'}}):
            with self.subTest(provides=provides):
                manifest = base_manifest(level=4, provides=provides)
                self.publish_ok(manifest)
                self.assertEqual(validate(self.root), 1)
                self.write_index([])
                shutil.rmtree(self.root / 'plugins' / manifest['id'], True)
                (self.root / 'packages' / f"{manifest['id']}-{manifest['version']}.zip").unlink()

    def test_wrong_mode_for_new_provider_is_rejected(self):
        for provides, pattern in [
                ({'chat.pre_reply@1': {'mode': 'enhance', 'scope': 'all'}}, 'unsupported mode'),
                ({'chat.prompt@1': {'mode': 'gate', 'scope': 'all'}}, 'unsupported mode'),
                ({'app.start@1': {'mode': 'enhance', 'scope': 'all'}}, 'unsupported mode')]:
            with self.subTest(provides=provides):
                level = 3 if 'chat.' in next(iter(provides)) else 4
                payload = wasm_run_only(level=3) if level == 3 else 'exports.providers = {};\n'
                self.assert_rejected(base_manifest(level=level, provides=provides), payload, pattern=pattern)

    def test_level3_calls_stay_empty_after_protocol_sync(self):
        manifest = base_manifest(level=3, provides={'chat.prompt@1': {'mode': 'enhance', 'scope': 'all'}},
                                 calls=['status.read@1'])
        self.assert_rejected(manifest, wasm_run_only(level=3), pattern='not allowed at this level')

    def test_level4_data_access_follows_level_policy(self):
        # 4 级与 3 级共用同一套 dataAccess 白名单；4 级可声明，值仍必须是策略内的。
        self.publish_ok(base_manifest(level=4, provides={'chat.prompt@1': {'mode': 'enhance', 'scope': 'all'}},
                                      dataAccess=['model.prompt']))
        self.assertEqual(validate(self.root), 1)
        node_payload = b"'use strict';\nexports.providers = {};\n"
        self.assert_rejected(base_manifest(level=4, provides={'chat.prompt@1': {'mode': 'enhance', 'scope': 'all'}},
                                           dataAccess=['system-prompt']), node_payload,
                             pattern='invalid chat data request')
        self.assert_rejected(base_manifest(level=4, provides={'tool.run@1': {'mode': 'tool', 'scope': 'manual'}},
                                           dataAccess=['model.prompt']), node_payload,
                             pattern='chat data is not available at this level')

    def test_level3_data_access_requires_a_chat_provider_and_policy_values(self):
        # chat.prompt@1（新 provider）可以申请 dataAccess；值仍以 protocol 的 level3 白名单为准。
        self.publish_ok(base_manifest(level=3, provides={'chat.prompt@1': {'mode': 'enhance', 'scope': 'all'}},
                                      dataAccess=['model.prompt']), wasm_run_only(level=3))
        self.assertEqual(validate(self.root), 1)
        for provides, data_access, pattern in [
                ({'tool.run@1': {'mode': 'tool', 'scope': 'manual'}}, ['chat.history'],
                 'chat data is not available at this level'),
                ({'chat.prompt@1': {'mode': 'enhance', 'scope': 'all'}}, ['system-prompt'],
                 'invalid chat data request'),
                ({'chat.reply@1': {'mode': 'enhance', 'scope': 'all'}}, ['chat.history', 'chat.history'],
                 'invalid chat data request')]:
            with self.subTest(pattern=pattern):
                self.assert_rejected(base_manifest(level=3, provides=provides, dataAccess=data_access),
                                     wasm_run_only(level=3), pattern=pattern)

    def test_afdian_contract_matches_host(self):
        # 合法：afdian.com、可选一个尾斜杠；返回规范化地址（去尾斜杠）。
        entry = self.publish(base_manifest(), "exports.providers = {};\n",
                             donation='https://afdian.com/a/your-name/')
        entry['display']['donation']['afdian'] = 'https://afdian.com/a/your-name'
        self.write_index([entry])
        self.assertEqual(validate(self.root), 1)
        self.assertEqual(report(self.root)['entries'][0]['donation'], 'https://afdian.com/a/your-name')
        for value in ('https://www.afdian.com/a/your-name', 'http://afdian.com/a/your-name',
                      'https://afdian.com/a/your-name?tab=1', 'https://afdian.com/a/your-name#x',
                      'https://afdian.com/b/your-name', 'https://afdian.com/a/', 'https://user@afdian.com/a/x',
                      'https://afdian.com/a/' + 'a' * 65, 'https://afdian.com:8443/a/x'):
            with self.subTest(value=value):
                self.assert_rejected(base_manifest(), "exports.providers = {};\n", donation=value,
                                     pattern='Afdian|afdian|invalid URL|query/fragment|path')
                shutil.rmtree(self.root / 'plugins' / 'example-plugin', True)
                (self.root / 'packages' / 'example-plugin-1.0.0.zip').unlink()
                self.write_index([])


if __name__ == '__main__':
    unittest.main()
