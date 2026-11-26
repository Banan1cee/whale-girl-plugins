"""Validate both the legacy Api catalogs and the whale-plugin/1 (index-v5) catalog.
Only reads package bytes and JSON; never executes plugin code.

Stable CLI:
    python validate.py            # exit 0/1, human summary
    python validate.py --json     # machine report on stdout (for market security CI)
"""
import hashlib
import json
import math
import posixpath
import re
import stat
import subprocess
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener
from zipfile import BadZipFile, ZipFile

ROOT = Path(__file__).resolve().parent
PREFIX = 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/'
HOSTS = {'raw.githubusercontent.com', 'github.com', 'release-assets.githubusercontent.com',
         'objects.githubusercontent.com'}
CATALOGS = {'index.json': 1, 'index-v2.json': 2, 'index-v3.json': 3, 'index-v4.json': 4}
CATALOG_ONLY = {'Download', 'Sha256', 'DiscussionIssue'}
MESSAGE_HOOKS = ('chat.received', 'chat.pre_reply', 'chat.prompt', 'chat.generate',
                 'chat.reply', 'chat.before_send', 'chat.dispatched')
MESSAGE_PERMISSIONS = ('chat.history', 'model.prompt')
VERSION = re.compile(r'\d+\.\d+\.\d+(\.\d+)?', re.ASCII)
LIMIT = 1024 * 1024
NATIVE_LIMIT = 16 * 1024 * 1024
NATIVE_HOOKS = (*MESSAGE_HOOKS, 'chat.search', 'chat.search_result', 'app.start', 'app.stop', 'timer.tick', 'tool.run')

# whale-plugin/1 (index-v5) constants. Authority for levels/capabilities/schemas is protocol.json.
V5_INDEX = 'index-v5.json'
V5_DISPLAY = 'market.json'
V5_INDEX_LIMIT = 256 * 1024
V5_PROTOCOL = 'protocol.json'
README_LIMIT = 64 * 1024
DISPLAY_LIMIT = 64 * 1024
MAX_IMAGES = 8
IMAGE_LIMIT = 2 * 1024 * 1024
IMAGE_MEDIA = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif'}
IMAGE_MAGIC = {
    'image/png': b'\x89PNG\r\n\x1a\n',
    'image/jpeg': b'\xff\xd8\xff',
    'image/gif': b'GIF87a',
}
THEME_TOP = {'schema', 'id', 'name', 'author', 'version', 'colors', 'font', 'metrics', 'dialog'}
THEME_COLORS = ('accent', 'background', 'surface', 'text', 'muted', 'border', 'field')
THEME_FONTS = ('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', 'SimSun')
THEME_FONT_KEYS = {'family', 'scale'}
THEME_METRIC_KEYS = {'corner', 'spacing'}
THEME_DIALOG_KEYS = {'surface', 'border', 'corner'}
THEME_LIMIT = 64 * 1024
THEME_SCALE = (0.85, 1.15)
THEME_CORNER = (0, 24)
# 与宿主 launcher/PluginMarket.cs::AfdianPersonalPage 一致：只认 afdian.com。
AFDIAN_HOSTS = {'afdian.com'}
HEX_COLOR = re.compile(r'#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\Z')
ISO_TIME = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)\Z')
V5_ENTRY_KEYS = {'manifest', 'manifestSha256', 'package', 'display'}
V5_PACKAGE_KEYS = {'path', 'download', 'sha256', 'bytes'}
V5_DISPLAY_KEYS = {'readme', 'images', 'updatedAt', 'donation'}
RESERVED_IDS = {'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4',
                'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3',
                'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'}
PROTOCOL_CACHE = {}


def check(condition, message):
    if not condition:
        raise ValueError(message)


def first(values):
    """Bounded sample for error messages; avoids indexing an empty set."""
    ordered = sorted(values)
    return ordered[0] if ordered else ''


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _reject_constant(text):
    raise ValueError(f'non-finite JSON number {text}')


def strict_loads(raw, where):
    """Strict UTF-8 JSON: no BOM, no duplicate keys, no NaN/Infinity."""
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError(f'{where}: invalid UTF-8 ({error})') from error
    if text.startswith('\ufeff'):
        raise ValueError(f'{where}: UTF-8 BOM is not allowed')
    try:
        return json.loads(text, object_pairs_hook=_reject_duplicate_keys,
                          parse_constant=_reject_constant)
    except ValueError as error:
        raise ValueError(f'{where}: invalid JSON ({error})') from error


def read_json(path):
    return strict_loads(Path(path).read_bytes(), str(path))


def protocol(root=ROOT):
    """Load the copied host registry from the validated root; one cache per root."""
    key = Path(root).resolve()
    if key not in PROTOCOL_CACHE:
        data = read_json(key / V5_PROTOCOL)
        check(isinstance(data, dict) and isinstance(data.get('registry'), dict),
              f'{V5_PROTOCOL}: missing registry')
        registry = data['registry']
        check(registry.get('format') == 'whale-plugin/1', f'{V5_PROTOCOL}: unsupported format')
        PROTOCOL_CACHE[key] = registry
    return PROTOCOL_CACHE[key]


# ---------------------------------------------------------------------------
# Legacy Api 1-4 catalogs (behaviour kept from the previous market)
# ---------------------------------------------------------------------------

def download_url(url):
    target = urlsplit(url)
    check(target.scheme == 'https' and target.hostname in HOSTS
          and target.port in (None, 443) and target.username is None,
          'Download and its redirects must use supported GitHub HTTPS hosts')


class GitHubRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        download_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def package_bytes(root, entry):
    url = entry['Download']
    download_url(url)
    if url.startswith(PREFIX):
        name = f'{entry["Id"]}-{entry["Version"]}.zip'
        check(url == PREFIX + name, f'repository ZIP must be named {name}')
        with (root / 'packages' / name).open('rb') as file:
            return file.read((NATIVE_LIMIT if entry.get('Api') == 4 else LIMIT) + 1)
    with build_opener(GitHubRedirects()).open(url, timeout=20) as response:
        return response.read((NATIVE_LIMIT if entry.get('Api') == 4 else LIMIT) + 1)


def check_capabilities(entry, api, persona=False):
    """按目录校验 Api / Kind / HostAction（Api 3 还校验 Hooks 与 Permissions）。"""
    check(type(entry['Api']) is int and entry['Api'] == api, 'invalid Api for this catalog')
    if persona:
        check(api == 1 and entry.get('Kind') == 'persona'
              and entry.get('HostAction') is None
              and not entry.get('Hooks') and not entry.get('Permissions'),
              'persona packages cannot declare executable capabilities')
    elif api == 4:
        check(entry.get('Kind') in ('message', 'tool') and entry.get('HostAction') is None, 'invalid native plugin kind/action')
        hooks = entry.get('Hooks')
        check(isinstance(hooks, list) and 1 <= len(hooks) <= len(NATIVE_HOOKS)
              and all(isinstance(hook, str) and hook in NATIVE_HOOKS for hook in hooks)
              and len(set(hooks)) == len(hooks), 'invalid native Hooks')
        check(entry.get('Permissions') == ['system.full'], 'Api 4 requires explicit system.full permission')
        check(VERSION.fullmatch(entry['MinAppVersion']) and tuple(map(int, entry['MinAppVersion'].split('.'))) >= (4, 1, 2),
              'Api 4 requires MinAppVersion >= 4.1.2')
        check(type(entry.get('ExecutionTimeoutMs', 30000)) is int and 100 <= entry.get('ExecutionTimeoutMs', 30000) <= 120000,
              'invalid execution timeout')
        check(type(entry.get('IntervalSeconds', 60)) is int and 1 <= entry.get('IntervalSeconds', 60) <= 86400,
              'invalid timer interval')
    elif api == 3:
        check(entry.get('Kind') == 'message', 'invalid Kind for this catalog')
        check(entry.get('HostAction') is None, 'invalid HostAction for this catalog')
        hooks = entry.get('Hooks')
        check(isinstance(hooks, list) and 1 <= len(hooks) <= 7
              and len(set(hooks)) == len(hooks)
              and all(hook in MESSAGE_HOOKS for hook in hooks), 'invalid Hooks')
        permissions = entry.get('Permissions')
        check(isinstance(permissions, list) and len(permissions) <= 2
              and len(set(permissions)) == len(permissions)
              and all(permission in MESSAGE_PERMISSIONS for permission in permissions),
              'invalid Permissions')
        check(tuple(map(int, entry['MinAppVersion'].split('.'))) >= (4, 1, 0),
              'Api 3 requires MinAppVersion >= 4.1.0')
    else:
        check(entry.get('Kind', 'tool') == 'tool'
              and entry.get('HostAction') in ((None,) if api == 1 else (None, 'chat.summary')),
              'invalid Api, Kind or HostAction for this catalog')


def check_entry(root, entry, api, seen, persona=False):
    plugin_id = entry['Id']
    check(re.fullmatch(r'[a-z][a-z0-9-]{0,47}', plugin_id)
          and not re.fullmatch(r'con|prn|aux|nul|com[1-9]|lpt[1-9]', plugin_id), 'invalid Id')
    check_capabilities(entry, api, persona)
    for field in (('Name', 'Author') if persona else ('Name', 'Author', 'ResultLabel')):
        check(isinstance(entry.get(field), str) and 0 < len(entry[field].strip()) <= 80,
              f'invalid {field}')
    check(isinstance(entry.get('Description'), str) and len(entry['Description']) <= 600,
          'invalid Description')
    for field in ('Version', 'MinAppVersion'):
        check(VERSION.fullmatch(entry[field]), f'invalid {field}')
    maximum = entry.get('MaxAppVersion')
    if maximum:
        check(VERSION.fullmatch(maximum)
              and tuple(map(int, maximum.split('.'))) >= tuple(map(int, entry['MinAppVersion'].split('.'))),
              'invalid MaxAppVersion')
    issue = entry.get('DiscussionIssue', 0)
    check(type(issue) is int and issue >= 0, 'invalid DiscussionIssue')
    key = (plugin_id, tuple(map(int, entry['Version'].split('.'))))
    check(key not in seen, 'duplicate Id and Version')
    seen.add(key)
    check(re.fullmatch(r'[a-fA-F0-9]{64}', entry['Sha256']), 'invalid Sha256')
    data = package_bytes(root, entry)
    check(len(data) <= (NATIVE_LIMIT if api == 4 else LIMIT), 'ZIP exceeds size limit')
    check(sha256(data) == entry['Sha256'].lower(), 'SHA-256 mismatch')
    with ZipFile(BytesIO(data)) as package:
        payload = 'persona.json' if persona else 'plugin.js' if api == 4 else 'plugin.wasm'
        check(sorted(package.namelist()) == sorted(['plugin.json', payload]), 'unexpected ZIP entries')
        for item in package.infolist():
            check(not item.flag_bits & 1 and not stat.S_ISLNK(item.external_attr >> 16),
                  'encrypted files and symlinks are forbidden')
        check(package.getinfo('plugin.json').file_size <= 8192, 'manifest exceeds 8 KiB')
        check(package.getinfo(payload).file_size <= (65536 if persona else 8 * 1024 * 1024 if api == 4 else 512 * 1024), 'payload exceeds size limit')
        manifest = json.loads(package.read('plugin.json'))
        check(manifest == {k: v for k, v in entry.items() if k not in CATALOG_ONLY},
              'package manifest differs from catalog')
        if persona:
            preset = json.loads(package.read(payload))
            check(isinstance(preset, dict) and set(preset) == {'customPrompt'}
                  and isinstance(preset['customPrompt'], str)
                  and 0 < len(preset['customPrompt'].strip()) <= 24000, 'invalid persona data')
        elif api == 4:
            source = package.read(payload).decode('utf-8')
            check(bool(source.strip()), 'JavaScript source cannot be empty')
        else:
            check(package.read(payload).startswith(b'\x00asm\x01\x00\x00\x00'), 'invalid Wasm header')


# ---------------------------------------------------------------------------
# whale-plugin/1 (index-v5)
# ---------------------------------------------------------------------------

def _version_tuple(value, where, minimum_parts=3):
    check(isinstance(value, str) and VERSION.fullmatch(value), f'{where}: invalid version')
    parts = tuple(int(part) for part in value.split('.'))
    check(len(parts) >= minimum_parts, f'{where}: version needs 3 or 4 parts')
    return parts + (0,) * (4 - len(parts))


def _check_manifest_versions(manifest, registry, where, level):
    policy = registry['manifest']
    for field in ('version', 'minAppVersion'):
        _version_tuple(manifest.get(field), f'{where}.{field}')
    maximum = manifest.get('maxAppVersion')
    if maximum is not None:
        check(_version_tuple(maximum, f'{where}.maxAppVersion') >=
              _version_tuple(manifest['minAppVersion'], f'{where}.minAppVersion'),
              f'{where}: maxAppVersion is below minAppVersion')
    epoch = manifest.get('appEpoch')
    if epoch is not None:
        check(type(epoch) is int and epoch in (1, 2), f'{where}: appEpoch must be 1 or 2')
    ranges = manifest.get('appCompatibility')
    if ranges is None:
        minimum = _version_tuple(manifest['minAppVersion'], f'{where}.minAppVersion')
        ranges = [{'appEpoch': epoch or 1, 'minAppVersion': manifest['minAppVersion'],
                   'maxAppVersion': manifest.get('maxAppVersion')}]
    else:
        check(isinstance(ranges, list) and 1 <= len(ranges) <= 2,
              f'{where}: appCompatibility must have 1 or 2 ranges')
    epochs = set()
    for index, item in enumerate(ranges):
        label = f'{where}.appCompatibility[{index}]'
        check(isinstance(item, dict) and set(item) <= {'appEpoch', 'minAppVersion', 'maxAppVersion'},
              f'{label}: invalid fields')
        generation = item.get('appEpoch')
        check(type(generation) is int and generation in (1, 2), f'{label}: appEpoch must be 1 or 2')
        check(generation not in epochs, f'{label}: duplicate appEpoch')
        epochs.add(generation)
        minimum = _version_tuple(item.get('minAppVersion'), f'{label}.minAppVersion')
        floor = (1, 0, 0, 0) if generation == 2 else (4, 1, 2, 0)
        check(minimum >= floor, f'{label}: minAppVersion below this app epoch floor')
        if generation == 1 and level == 0:
            check(minimum >= (4, 3, 0, 0), f'{label}: theme plugins require minAppVersion >= 4.3.0')
        if item.get('maxAppVersion') is not None:
            check(_version_tuple(item['maxAppVersion'], f'{label}.maxAppVersion') >= minimum,
                  f'{label}: maxAppVersion is below minAppVersion')


def _check_compat(manifest, registry, where, level):
    """compat 只改变 3 级 Wasm 的输入信封与 whale 导入别名，不改变能力授权、调用白名单或输出校验。

    合法值/等级/运行时都来自 protocol.json 里的 manifest.compat，市场侧不另抄枚举；
    未声明 compat 的旧包照常通过。
    """
    if 'compat' not in manifest:
        return
    policy = registry['manifest'].get('compat')
    check(isinstance(policy, dict) and isinstance(policy.get('values'), list)
          and isinstance(policy.get('levels'), list) and isinstance(policy.get('runtime'), str),
          f'{where}.compat: protocol.json is missing the compat policy')
    check(isinstance(manifest['compat'], str) and manifest['compat'] in policy['values'],
          f'{where}.compat: unsupported compat value')
    check(level in policy['levels'], f'{where}.compat: compat is not allowed at this level')
    check(manifest.get('runtime') == policy['runtime'],
          f'{where}.compat: compat requires the {policy["runtime"]} runtime')
    # 旧信封只认识 hooks 登记过的那几个 provider：映射不到的（如 tool.run@1）会安装成功、
    # 第一次派发才撞 invalid_wasm_compat，所以清单校验就拒绝（与宿主 Node/C# 同一规则）。
    hooks = policy.get('hooks')
    check(isinstance(hooks, dict), f'{where}.compat: protocol.json is missing the compat hook map')
    declared = manifest.get('provides')
    if isinstance(declared, dict):
        missing = set(declared) - set(hooks)
        check(not missing, f'{where}.compat: {first(missing)} has no api3 hook in the registry')


def _check_settings_schema(schema, policy, depth, where):
    check(depth < policy['maxDepth'], f'{where}: settingsSchema is too deep')
    check(isinstance(schema, dict), f'{where}: settingsSchema must be an object')
    unknown = set(schema) - set(policy['supportedKeywords'])
    check(not unknown, f'{where}: unsupported settingsSchema keyword {first(unknown)}')
    kind = schema.get('type')
    check(kind in policy['allowedTypes'], f'{where}: unsupported settingsSchema type')
    if depth == 0:
        check(kind == 'object', f'{where}: settingsSchema root must be an object')

    if 'properties' in schema:
        check(kind == 'object' and isinstance(schema['properties'], dict),
              f'{where}.properties: only objects may declare properties')
        for name, child in schema['properties'].items():
            check(isinstance(name, str) and name, f'{where}.properties: invalid field name')
            _check_settings_schema(child, policy, depth + 1, f'{where}.properties.{name}')
    if 'required' in schema:
        required = schema['required']
        check(kind == 'object' and isinstance(required, list)
              and len(set(required)) == len(required)
              and all(isinstance(name, str) and name in (schema.get('properties') or {})
                      for name in required),
              f'{where}.required: must list declared unique properties')
    if 'additionalProperties' in schema:
        check(kind == 'object' and isinstance(schema['additionalProperties'], bool),
              f'{where}.additionalProperties: must be a boolean')
    if 'enum' in schema:
        choices = schema['enum']
        check(isinstance(choices, list) and choices, f'{where}.enum: must be a non-empty array')
        encoded = [json.dumps(choice, sort_keys=True, ensure_ascii=False) for choice in choices]
        check(len(set(encoded)) == len(encoded), f'{where}.enum: duplicate values')
        for choice in choices:
            if kind == 'object':
                check(isinstance(choice, dict), f'{where}.enum: value is not an object')
            elif kind == 'array':
                check(isinstance(choice, list), f'{where}.enum: value is not an array')
            elif kind == 'string':
                check(isinstance(choice, str), f'{where}.enum: value is not a string')
            elif kind == 'boolean':
                check(isinstance(choice, bool), f'{where}.enum: value is not a boolean')
            elif kind == 'integer':
                check(type(choice) is int, f'{where}.enum: value is not an integer')
            elif kind == 'number':
                check(type(choice) in (int, float) and math.isfinite(choice),
                      f'{where}.enum: value is not a finite number')
    for key in ('minimum', 'maximum'):
        if key in schema:
            check(kind in ('integer', 'number') and type(schema[key]) in (int, float)
                  and math.isfinite(schema[key]),
                  f'{where}.{key}: only finite numeric bounds are supported')
    for key in ('minLength', 'maxLength'):
        if key in schema:
            check(kind == 'string' and type(schema[key]) is int and schema[key] >= 0,
                  f'{where}.{key}: only non-negative string lengths are supported')
    annotations = policy.get('annotations') or {}
    forbidden = annotations.get('forbiddenRanges') or []
    for name in ('title', 'description'):
        if name not in schema:
            continue
        value = schema[name]
        check(isinstance(value, str), f'{where}.{name}: must be a string')
        if name == 'title':
            check(bool(value.strip()), f'{where}.title: must not be empty')
        limit = annotations.get(name)
        check(isinstance(limit, int), f'{where}.{name}: annotation limit is not configured')
        for char in value:
            code = ord(char)
            check(not any(low <= code <= high for low, high in forbidden),
                  f'{where}.{name}: contains a forbidden control/format character')
        check(len(value) <= limit, f'{where}.{name}: exceeds {limit} characters')


def _check_provides(manifest, registry, where, level):
    policy = registry['levels'].get(str(level))
    check(policy is not None, f'{where}: unsupported level {level}')
    provides = manifest.get('provides')
    check(isinstance(provides, dict), f'{where}.provides: must be an object')
    names = list(provides)
    if level == 0:
        check(not names, f'{where}: level 0 themes cannot declare providers')
        return
    check(bool(names), f'{where}.provides: at least one provider is required')
    allowed_here = set(policy.get('providers') or [])
    for name in names:
        check(name in registry['providers'] and name in allowed_here,
              f'{where}.provides: provider is not allowed at this level')
        descriptor = provides[name]
        rule = registry['providers'][name]
        check(isinstance(descriptor, dict), f'{where}.provides.{name}: must be an object')
        unknown = set(descriptor) - {'mode', 'scope', 'intervalSeconds'}
        check(not unknown, f'{where}.provides.{name}: unknown field {first(unknown)}')
        check(descriptor.get('mode') in rule.get('modes', []),
              f'{where}.provides.{name}: unsupported mode')
        check(descriptor.get('scope') in rule.get('scopes', []),
              f'{where}.provides.{name}: unsupported scope')
        interval = rule.get('intervalSeconds')
        if interval:
            value = descriptor.get('intervalSeconds')
            check(type(value) is int and interval['min'] <= value <= interval['max'],
                  f'{where}.provides.{name}: intervalSeconds is out of range')
        else:
            check('intervalSeconds' not in descriptor,
                  f'{where}.provides.{name}: intervalSeconds is not supported')


def _check_calls(manifest, registry, where, level):
    calls = manifest.get('calls')
    check(isinstance(calls, list), f'{where}.calls: must be an array')
    check(len(set(calls)) == len(calls), f'{where}.calls: duplicate capabilities')
    allowed = set(registry['levels'][str(level)].get('calls') or [])
    for name in calls:
        check(isinstance(name, str) and name in allowed,
              f'{where}.calls: capability is not allowed at this level')
    data_access = manifest.get('dataAccess')
    if data_access is None:
        return
    # 与宿主一致：3 级只要声明了任一 chat.* provider 就可以申请 dataAccess；
    # 具体允许值仍以 protocol.json 的 levels["3"].dataAccess 为准（不在这里抄枚举）。
    declared = manifest.get('provides') or {}
    declares_chat = any(isinstance(name, str) and name.startswith('chat.') for name in declared)
    level_policy = registry['levels'].get(str(level)) or {}
    allowed_data = set(level_policy.get('dataAccess') or [])
    check(declares_chat and bool(allowed_data),
          f'{where}.dataAccess: chat data is not available at this level')
    check(isinstance(data_access, list) and len(set(data_access)) == len(data_access)
          and all(isinstance(item, str) and item in allowed_data for item in data_access),
          f'{where}.dataAccess: invalid chat data request')


def check_v5_manifest(manifest, registry, where):
    policy = registry['manifest']
    levels = registry['levels']
    check(isinstance(manifest, dict), f'{where}: manifest must be a JSON object')
    unknown = set(manifest) - set(policy['allowed'])
    check(not unknown, f'{where}: unknown manifest field {first(unknown)}')
    missing = set(policy['required']) - set(manifest)
    check(not missing, f'{where}: missing manifest field {first(missing)}')
    check(manifest.get('format') == registry['format'], f'{where}: unsupported format')
    level = manifest.get('level')
    check(type(level) is int and str(level) in levels, f'{where}: unsupported level')
    level_policy = levels[str(level)]
    check(manifest.get('runtime') == level_policy['runtime'], f'{where}: runtime does not match level')
    check(manifest.get('entry') == level_policy['entry'], f'{where}: entry does not match level')
    plugin_id = manifest.get('id')
    check(isinstance(plugin_id, str)
          and re.fullmatch(policy['idPattern'], plugin_id)
          and len(plugin_id) <= policy.get('maxIdLength', 48)
          and plugin_id not in RESERVED_IDS, f'{where}: invalid id')
    for field, limit in (('name', policy.get('maxNameLength', 80)),
                         ('author', policy.get('maxAuthorLength', 80))):
        value = manifest.get(field)
        check(isinstance(value, str) and 0 < len(value.strip()) <= limit,
              f'{where}.{field}: must be a non-empty bounded string')
    description = manifest.get('description')
    check(isinstance(description, str)
          and len(description) <= policy.get('maxDescriptionLength', 600),
          f'{where}.description: exceeds length limit')
    _check_manifest_versions(manifest, registry, where, level)
    _check_compat(manifest, registry, where, level)
    _check_provides(manifest, registry, where, level)
    _check_calls(manifest, registry, where, level)
    if 'settingsSchema' in manifest:
        check(level != 0, f'{where}: level 0 themes cannot declare settingsSchema')
        _check_settings_schema(manifest['settingsSchema'], registry['settingsSchema'], 0,
                               f'{where}.settingsSchema')
    timeout = manifest.get('executionTimeoutMs')
    if timeout is not None:
        limits = registry['limits']
        check(type(timeout) is int and limits['minExecutionTimeoutMs'] <= timeout <= limits['maxExecutionTimeoutMs'],
              f'{where}.executionTimeoutMs: out of range')
    return level


def _hex_color(value, where):
    check(isinstance(value, str) and HEX_COLOR.fullmatch(value), f'{where}: invalid color')


def _scale(value, where):
    check(type(value) in (int, float) and math.isfinite(value), f'{where}: must be a finite number')
    check(THEME_SCALE[0] <= value <= THEME_SCALE[1], f'{where}: scale is out of range')
    return float(value)


def _corner(value, where):
    check(type(value) is int and THEME_CORNER[0] <= value <= THEME_CORNER[1],
          f'{where}: corner radius is out of range')
    return value


def _luminance(hex_color):
    channels = [int(hex_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    linear = [channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4
              for channel in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(first, second):
    light, dark = sorted((_luminance(first), _luminance(second)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def check_theme(raw, manifest_id, where):
    check(len(raw) <= THEME_LIMIT, f'{where}: theme.json exceeds 64 KiB')
    theme = strict_loads(raw, where)
    check(isinstance(theme, dict), f'{where}: theme.json must be an object')
    unknown = set(theme) - THEME_TOP
    check(not unknown, f'{where}: unknown theme field {first(unknown)}')
    check(theme.get('schema') == 1 and type(theme['schema']) is int,
          f'{where}: theme schema must be 1')
    check(theme.get('id') == manifest_id, f'{where}: theme id must match the manifest id')
    name = theme.get('name')
    check(isinstance(name, str) and 0 < len(name.strip()) <= 40,
          f'{where}.name: must be a non-empty bounded string')
    for field, limit in (('author', 40), ('version', 20)):
        if field in theme:
            value = theme[field]
            check(isinstance(value, str) and len(value.strip()) <= limit,
                  f'{where}.{field}: exceeds length limit')
    if 'version' in theme and theme['version'].strip():
        check(VERSION.fullmatch(theme['version'].strip()),
              f'{where}.version: invalid version')

    colors = {}
    if 'colors' in theme:
        check(isinstance(theme['colors'], dict), f'{where}.colors: must be an object')
        for key, value in theme['colors'].items():
            check(key in THEME_COLORS, f'{where}.colors: unsupported token {key}')
            _hex_color(value, f'{where}.colors.{key}')
            colors[key] = value
    font = {}
    if 'font' in theme:
        check(isinstance(theme['font'], dict) and set(theme['font']) <= THEME_FONT_KEYS,
              f'{where}.font: invalid fields')
        if 'family' in theme['font']:
            check(theme['font']['family'] in THEME_FONTS, f'{where}.font.family: not in the font whitelist')
            font['family'] = theme['font']['family']
        if 'scale' in theme['font']:
            font['scale'] = _scale(theme['font']['scale'], f'{where}.font.scale')
    metrics = {}
    if 'metrics' in theme:
        check(isinstance(theme['metrics'], dict) and set(theme['metrics']) <= THEME_METRIC_KEYS,
              f'{where}.metrics: invalid fields')
        if 'corner' in theme['metrics']:
            metrics['corner'] = _corner(theme['metrics']['corner'], f'{where}.metrics.corner')
        if 'spacing' in theme['metrics']:
            metrics['spacing'] = _scale(theme['metrics']['spacing'], f'{where}.metrics.spacing')
    dialog = {}
    if 'dialog' in theme:
        check(isinstance(theme['dialog'], dict) and set(theme['dialog']) <= THEME_DIALOG_KEYS,
              f'{where}.dialog: invalid fields')
        for key in ('surface', 'border'):
            if key in theme['dialog']:
                _hex_color(theme['dialog'][key], f'{where}.dialog.{key}')
                dialog[key] = theme['dialog'][key]
        if 'corner' in theme['dialog']:
            dialog['corner'] = _corner(theme['dialog']['corner'], f'{where}.dialog.corner')

    visual = bool(colors) or bool(font) or bool(metrics) or bool(dialog)
    check(visual, f'{where}: theme must change at least one visual token')
    if len(colors.get('text', '')) == 7 and len(colors.get('background', '')) == 7:
        check(_contrast(colors['text'], colors['background']) >= 4.5,
              f'{where}: text/background contrast is below 4.5')
    if len(colors.get('accent', '')) == 7 and len(colors.get('background', '')) == 7:
        check(_contrast(colors['accent'], colors['background']) >= 3.0,
              f'{where}: accent/background contrast is below 3.0')


def _leb128(raw, position, where):
    result = 0
    shift = 0
    while True:
        check(position < len(raw), f'{where}: truncated Wasm LEB128')
        byte = raw[position]
        position += 1
        result |= (byte & 0x7f) << shift
        if not byte & 0x80:
            return result, position
        shift += 7
        check(shift <= 35, f'{where}: invalid Wasm LEB128')


def _wasm_name(raw, position, where):
    length, position = _leb128(raw, position, where)
    check(length <= 512 and position + length <= len(raw), f'{where}: invalid Wasm name')
    try:
        name = raw[position:position + length].decode('utf-8')
    except UnicodeDecodeError as error:
        raise ValueError(f'{where}: invalid Wasm UTF-8 name') from error
    return name, position + length


def check_wasm(raw, level, where, compat=False):
    """Static ABI check only: no instantiation and no code execution."""
    check(len(raw) >= 8 and raw[:8] == b'\x00asm\x01\x00\x00\x00',
          f'{where}: invalid Wasm v1 header')
    position = 8
    imports = []
    exports = []
    while position < len(raw):
        section = raw[position]
        position += 1
        size, position = _leb128(raw, position, where)
        end = position + size
        check(end <= len(raw), f'{where}: truncated Wasm section')
        if section == 2:
            count, position = _leb128(raw, position, where)
            for _ in range(count):
                module, position = _wasm_name(raw, position, where)
                field, position = _wasm_name(raw, position, where)
                check(position < len(raw), f'{where}: truncated Wasm import')
                kind = raw[position]
                position += 1
                check(kind == 0, f'{where}: only function imports are allowed')
                _, position = _leb128(raw, position, where)
                imports.append((module, field))
            check(position == end, f'{where}: Wasm import section length mismatch')
        elif section == 7:
            count, position = _leb128(raw, position, where)
            for _ in range(count):
                field, position = _wasm_name(raw, position, where)
                check(position < len(raw), f'{where}: truncated Wasm export')
                kind = raw[position]
                position += 1
                _, position = _leb128(raw, position, where)
                exports.append((field, kind))
            check(position == end, f'{where}: Wasm export section length mismatch')
        else:
            position = end
    for module, field in imports:
        allowed_modules = ('whale_plugin', 'whale') if (compat or level in (1, 2)) else ('whale_plugin',)
        check(module in allowed_modules, f'{where}: unsupported wasm import module'.replace('wasm', 'Wasm'))
        check(field in ('input_size', 'input_byte', 'output_byte'),
              f'{where}: unsupported Wasm import')
        check(not (level == 1 and field == 'output_byte'),
              f'{where}: level 1 cannot import output_byte')
    check(any(name == 'run' and kind == 0 for name, kind in exports),
          f'{where}: missing run() export')


def _zip_info(info, expected, where):
    check(info.filename == expected, f'{where}: ZIP entry must be {expected}')
    check(not info.is_dir(), f'{where}: directories are not allowed in the ZIP')
    check(info.filename == info.filename.strip() and '\\' not in info.filename
          and not info.filename.startswith('/') and '..' not in info.filename.split('/'),
          f'{where}: unsafe ZIP entry name')
    check(not info.flag_bits & 1, f'{where}: encrypted ZIP entries are forbidden')
    check((info.external_attr >> 16) & 0o170000 != 0o120000,
          f'{where}: symlinks are forbidden')


def _read_package(root, manifest, registry, where, report):
    level = manifest['level']
    level_policy = registry['levels'][str(level)]
    name = f"{manifest['id']}-{manifest['version']}.zip"
    relative = f'packages/{name}'
    path = root / 'packages' / name
    check(path.is_file(), f'{where}: missing {relative}')
    raw = path.read_bytes()
    check(len(raw) <= registry['limits']['maxPackageBytes'], f'{where}: package exceeds size limit')
    if report is not None:
        report['packageBytes'] = len(raw)
        report['sha256'] = sha256(raw)
    try:
        package = ZipFile(BytesIO(raw))
    except BadZipFile as error:
        raise ValueError(f'{where}: invalid ZIP ({error})') from error
    with package:
        infos = package.infolist()
        check(len(infos) == 2, f'{where}: ZIP must contain exactly two files')
        names = [info.filename for info in infos]
        check(len(set(names)) == 2, f'{where}: duplicate ZIP entries')
        expected = {'plugin.json', level_policy['entry']}
        check(set(names) == expected, f'{where}: ZIP must contain plugin.json and {level_policy["entry"]}')
        for info in infos:
            _zip_info(info, info.filename, where)
        check(package.testzip() is None, f'{where}: ZIP CRC mismatch')
        manifest_info = package.getinfo('plugin.json')
        entry_info = package.getinfo(level_policy['entry'])
        check(manifest_info.file_size <= registry['limits']['maxManifestBytes'],
              f'{where}: plugin.json exceeds size limit')
        check(entry_info.file_size <= level_policy['maxEntryBytes'],
              f'{where}: {level_policy["entry"]} exceeds the level entry limit')
        manifest_bytes = package.read('plugin.json')
        entry_bytes = package.read(level_policy['entry'])
        check(len(manifest_bytes) <= registry['limits']['maxManifestBytes'],
              f'{where}: plugin.json exceeds size limit')
        check(len(entry_bytes) <= level_policy['maxEntryBytes'],
              f'{where}: {level_policy["entry"]} exceeds the level entry limit')
    packaged = strict_loads(manifest_bytes, f'{where}/plugin.json')
    check(packaged == manifest, f'{where}: package manifest differs from the index')
    source_path = root / 'plugins' / manifest['id'] / 'plugin.json'
    check(source_path.is_file(), f'{where}: missing plugins/{manifest["id"]}/plugin.json')
    source_bytes = source_path.read_bytes()
    check(source_bytes == manifest_bytes,
          f'{where}: package plugin.json must be byte-identical to the source manifest')
    payload = level_policy['entry']
    if level == 0:
        check_theme(entry_bytes, manifest['id'], f'{where}/{payload}')
    elif level == 4:
        try:
            text = entry_bytes.decode('utf-8')
        except UnicodeDecodeError as error:
            raise ValueError(f'{where}: plugin.js must be UTF-8') from error
        check(not text.startswith('\ufeff'), f'{where}: plugin.js must not start with a BOM')
        check(bool(text.strip()), f'{where}: plugin.js cannot be empty')
    else:
        # compat 的取值、等级与运行时已由 check_v5_manifest 按 protocol.json 统一校验；
        # 这里只用它决定 Wasm 导入白名单（api3 信封沿用旧的 whale 模块名）。
        check_wasm(entry_bytes, level, f'{where}/{payload}', manifest.get('compat') == 'api3')
    if report is not None:
        report['manifestSha256'] = sha256(manifest_bytes)
    return raw, manifest_bytes, entry_bytes


def _afdian_url(value, where):
    # 规则以宿主 PluginMarket.cs 的 AfdianPersonalPage 为准：https、默认端口、
    # 无 userinfo/query/fragment、主机只能是 afdian.com；/a/<slug> 允许一个尾斜杠，
    # 返回去掉尾斜杠的规范地址（与宿主返回值一致）。
    check(isinstance(value, str) and 0 < len(value.strip()) <= 200, f'{where}: invalid URL')
    target = urlsplit(value.strip())
    check(target.scheme == 'https' and target.hostname in AFDIAN_HOSTS
          and target.port in (None, 443) and not target.username and not target.password,
          f'{where}: must use the HTTPS Afdian personal-page hosts')
    check(not target.query and not target.fragment, f'{where}: query/fragment is not allowed')
    path = target.path
    check(re.fullmatch(r'/a/[A-Za-z0-9_-]{1,64}/?', path) is not None,
          f'{where}: must be an Afdian personal page path')
    return 'https://afdian.com' + path.rstrip('/')


def _git_updated_at(root, relative):
    try:
        result = subprocess.run(['git', '-C', str(root), 'log', '-1', '--format=%cI', '--', relative],
                                capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    return value or None


def _local_image_refs(readme_text):
    refs = re.findall(r'!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)', readme_text)
    local = []
    for ref in refs:
        target = ref.strip('<>')
        if re.match(r'^(?:https?:|data:)', target, re.I):
            check(target.lower().startswith('https://'), 'README images must use HTTPS links')
            continue
        local.append(target.split('?', 1)[0].split('#', 1)[0])
    return local


def _display(root, plugin_dir, manifest):
    """Build the expected display metadata; the index must match this except updatedAt.

    updatedAt is validated separately: absence is accepted (generator may run where git
    metadata is unavailable), but a present timestamp must equal the source commit time.
    """
    plugin_id = manifest['id']
    meta = {}
    meta_file = plugin_dir / V5_DISPLAY
    if meta_file.exists():
        check(not meta_file.is_symlink(), f'plugins/{plugin_id}/{V5_DISPLAY}: symlink is forbidden')
        raw = meta_file.read_bytes()
        check(len(raw) <= DISPLAY_LIMIT, f'plugins/{plugin_id}/{V5_DISPLAY}: exceeds size limit')
        meta = strict_loads(raw, f'plugins/{plugin_id}/{V5_DISPLAY}')
        check(isinstance(meta, dict) and set(meta) <= {'readme', 'images', 'donation'},
              f'plugins/{plugin_id}/{V5_DISPLAY}: unknown field')
    display = {}
    readme_name = meta.get('readme', 'README.md')
    check(isinstance(readme_name, str) and readme_name, 'readme must be a file name')
    check('/' not in readme_name and '\\' not in readme_name and '..' not in readme_name,
          'readme must be a plain file name')
    check(readme_name.lower().endswith('.md'), 'readme must be a Markdown file')
    readme_path = plugin_dir / readme_name
    readme_text = ''
    if readme_path.exists():
        check(not readme_path.is_symlink(), f'plugins/{plugin_id}/{readme_name}: symlink is forbidden')
        raw = readme_path.read_bytes()
        check(len(raw) <= README_LIMIT, f'plugins/{plugin_id}/{readme_name}: exceeds 64 KiB')
        try:
            readme_text = raw.decode('utf-8')
        except UnicodeDecodeError as error:
            raise ValueError(f'plugins/{plugin_id}/{readme_name}: invalid UTF-8') from error
        if readme_text.startswith('\ufeff'):
            readme_text = readme_text[1:]
        display['readme'] = {
            'path': f'plugins/{plugin_id}/{readme_name}',
            'sha256': sha256(raw),
            'bytes': len(raw),
        }
    images = meta.get('images', [])
    check(isinstance(images, list) and len(images) <= MAX_IMAGES, 'images must be a short array')
    check(len(set(images)) == len(images), 'images must be unique')
    rendered = []
    for relative in images:
        check(isinstance(relative, str) and relative, 'image path must be a string')
        check(not relative.startswith('/') and '\\' not in relative
              and '..' not in relative.split('/') and relative == posixpath.normpath(relative),
              f'image path must stay inside the plugin directory: {relative}')
        suffix = Path(relative).suffix.lower()
        check(suffix in IMAGE_MEDIA, f'unsupported image extension: {relative}')
        path = plugin_dir / relative
        check(path.is_file() and not path.is_symlink(), f'missing or linked image: {relative}')
        raw = path.read_bytes()
        check(len(raw) <= IMAGE_LIMIT, f'image exceeds 2 MiB: {relative}')
        media = IMAGE_MEDIA[suffix]
        check(raw.startswith(IMAGE_MAGIC[media]), f'image magic does not match {media}: {relative}')
        if media == 'image/gif':
            check(raw.startswith(b'GIF87a') or raw.startswith(b'GIF89a'), f'invalid GIF: {relative}')
        rendered.append({
            'path': f'plugins/{plugin_id}/{relative}',
            'sha256': sha256(raw),
            'bytes': len(raw),
            'media': media,
        })
    if rendered:
        display['images'] = rendered
    if readme_text:
        declared = {posixpath.normpath(item) for item in images}
        for reference in _local_image_refs(readme_text):
            normal = posixpath.normpath(unquote(reference))
            check(not normal.startswith('../') and normal != '..',
                  f'README image escapes the plugin directory: {reference}')
            check(normal in declared,
                  f'README references an undeclared image (add it to {V5_DISPLAY}.images): {reference}')
    donation = meta.get('donation')
    if donation is not None:
        check(isinstance(donation, dict) and set(donation) == {'afdian'},
              'donation must contain only the afdian field')
        normalized = _afdian_url(donation['afdian'], f'plugins/{plugin_id}/{V5_DISPLAY}.donation.afdian')
        display['donation'] = {'afdian': normalized}
    return display


def check_v5_entry(root, entry, registry, seen, legacy_ids, report):
    where = V5_INDEX
    check(isinstance(entry, dict), f'{where}: entry must be an object')
    check(set(entry) <= V5_ENTRY_KEYS and V5_ENTRY_KEYS <= set(entry),
          f'{where}: entry must contain manifest, manifestSha256, package and display')
    manifest = entry['manifest']
    check_v5_manifest(manifest, registry, f'{where}/{entry.get("manifest", {}).get("id", "?")}')
    plugin_id = manifest['id']
    check(plugin_id not in legacy_ids, f'{where}: id {plugin_id} already exists in an Api 1-4 catalog')
    version = manifest['version']
    check(re.fullmatch(r'[a-fA-F0-9]{64}', str(entry['manifestSha256'])),
          f'{where}.{plugin_id}: manifestSha256 must be a SHA-256')
    package = entry['package']
    check(isinstance(package, dict) and set(package) == V5_PACKAGE_KEYS,
          f'{where}.{plugin_id}.package: invalid fields')
    name = f'{plugin_id}-{version}.zip'
    expected_path = f'packages/{name}'
    check(package['path'] == expected_path, f'{where}.{plugin_id}.package: path must be {expected_path}')
    check(package['download'] == PREFIX + name,
          f'{where}.{plugin_id}.package: download must use the repository package URL')
    check(type(package['bytes']) is int and package['bytes'] > 0,
          f'{where}.{plugin_id}.package: bytes must be positive')
    check(str(package['sha256']).lower() == str(package['sha256']),
          f'{where}.{plugin_id}.package: sha256 must be lowercase hex')
    check(re.fullmatch(r'[a-f0-9]{64}', str(package['sha256'])),
          f'{where}.{plugin_id}.package: sha256 must be a lowercase SHA-256')
    report.update({'catalog': V5_INDEX, 'id': plugin_id, 'version': version, 'level': manifest['level'],
                   'runtime': manifest['runtime'], 'entry': manifest['entry'],
                   'package': expected_path,
                   'provides': sorted((manifest.get('provides') or {}).keys()),
                   'calls': list(manifest.get('calls') or []),
                   'dataAccess': list(manifest.get('dataAccess') or [])})
    payload = _read_package(root, manifest, registry, f'{where}.{plugin_id}', report)
    raw, manifest_bytes, _entry_bytes = payload
    check(report['sha256'] == package['sha256'], f'{where}.{plugin_id}.package: SHA-256 mismatch')
    check(report['packageBytes'] == package['bytes'], f'{where}.{plugin_id}.package: byte size mismatch')
    check(report['manifestSha256'] == entry['manifestSha256'],
          f'{where}.{plugin_id}.manifestSha256: does not match the packaged manifest')
    plugin_dir = root / 'plugins' / plugin_id
    expected_display = _display(root, plugin_dir, manifest)
    actual_display = dict(entry['display'])
    updated_at = actual_display.pop('updatedAt', None)
    check(actual_display == expected_display,
          f'{where}.{plugin_id}.display: does not match README/images metadata')
    if updated_at is not None:
        check(isinstance(updated_at, str) and ISO_TIME.fullmatch(updated_at) is not None,
              f'{where}.{plugin_id}.display.updatedAt: must be an ISO-8601 timestamp')
        from_git = _git_updated_at(root, f'plugins/{plugin_id}/plugin.json')
        check(from_git is not None,
              f'{where}.{plugin_id}.display.updatedAt: cannot be verified without git metadata')
        check(updated_at == from_git,
              f'{where}.{plugin_id}.display.updatedAt: must equal the plugin source commit time')
    donation = expected_display.get('donation', {}).get('afdian')
    if report is not None:
        report['donation'] = donation
    key = (plugin_id, tuple(int(part) for part in version.split('.')))
    check(key not in seen, f'{where}: duplicate plugin id and version')
    seen.add(key)


def _catalog_entries(root, name, api, legacy_ids, seen):
    data = (root / name).read_bytes()
    check(len(data) <= 256 * 1024, f'{name} exceeds launcher download limit')
    entries = strict_loads(data, name)
    check(isinstance(entries, list), f'{name} must contain a JSON array')
    catalog_ids = set()
    for index, entry in enumerate(entries, 1):
        try:
            plugin_id = entry['Id']
            check(plugin_id not in catalog_ids, 'duplicate Id in catalog')
            catalog_ids.add(plugin_id)
            legacy_ids.add(plugin_id)
            check_entry(root, entry, api, seen, name == 'index-personas.json')
        except Exception as error:
            raise ValueError(f'{name} entry {index}: {error}') from error


def _v5_source_entries(root, registry):
    """Source dirs that should be present in index-v5 (a missing ZIP means draft)."""
    expected = {}
    plugins = root / 'plugins'
    if not plugins.exists():
        return expected
    for directory in sorted(plugins.iterdir()):
        if not directory.is_dir():
            continue
        manifest_file = directory / 'plugin.json'
        if not manifest_file.is_file():
            continue
        try:
            manifest = strict_loads(manifest_file.read_bytes(), f'plugins/{directory.name}/plugin.json')
        except ValueError:
            # Invalid JSON cannot even prove it is a whale-plugin/1 source; legacy validator
            # and CI still see the file, but it cannot contribute an index entry.
            continue
        if not isinstance(manifest, dict) or manifest.get('format') != registry['format']:
            continue
        plugin_id = manifest.get('id')
        version = manifest.get('version')
        if not isinstance(plugin_id, str) or not isinstance(version, str):
            continue
        if (root / 'packages' / f'{plugin_id}-{version}.zip').is_file():
            expected[plugin_id] = version
    return expected


def check_v5_catalog(root, registry, seen, legacy_ids, report):
    path = root / V5_INDEX
    if not path.exists():
        return
    raw = path.read_bytes()
    check(len(raw) <= V5_INDEX_LIMIT, f'{V5_INDEX} exceeds 256 KiB')
    entries = strict_loads(raw, V5_INDEX)
    check(isinstance(entries, list), f'{V5_INDEX} must contain a JSON array')
    ids = set()
    actual = {}
    for record in entries:
        try:
            report_entry = {}
            check_v5_entry(root, record, registry, seen, legacy_ids, report_entry)
            plugin_id = report_entry['id']
            check(plugin_id not in ids, f'{V5_INDEX}: duplicate Id {plugin_id}')
            ids.add(plugin_id)
            actual[plugin_id] = report_entry['version']
            if report is not None:
                report['entries'].append(report_entry)
        except Exception as error:
            label = '?'
            if isinstance(record, dict) and isinstance(record.get('manifest'), dict):
                label = record['manifest'].get('id', '?')
            raise ValueError(f'{V5_INDEX} entry {label}: {error}') from error
    expected = _v5_source_entries(root, registry)
    missing = sorted(set(expected) - set(actual))
    check(not missing, f'{V5_INDEX}: missing entries for {", ".join(missing)}')
    extra = sorted(set(actual) - set(expected))
    check(not extra, f'{V5_INDEX}: entries without a source package: {", ".join(extra)}')
    for plugin_id, version in expected.items():
        check(actual[plugin_id] == version,
              f'{V5_INDEX}: version for {plugin_id} is out of sync (expected {version})')


def validate(root=ROOT, report=None):
    """Validate legacy catalogs and (when present) index-v5. Returns entry count."""
    seen = set()
    legacy_ids = set()
    if report is not None:
        report.setdefault('entries', [])
        report['legacy'] = 0
    for name, api in CATALOGS.items():
        if name == 'index-v4.json' and not (root / name).exists():
            continue
        _catalog_entries(root, name, api, legacy_ids, seen)
    if report is not None:
        report['legacy'] = len(seen)
    if (root / 'index-personas.json').exists():
        _catalog_entries(root, 'index-personas.json', 1, legacy_ids, seen)
        if report is not None:
            report['legacy'] = len(seen)
    if (root / V5_INDEX).exists():
        check_v5_catalog(root, protocol(root), seen, legacy_ids, report)
    return len(seen)


def report(root=ROOT):
    """Machine report consumed by the market security CI."""
    output = {'ok': True, 'errors': [], 'entries': [], 'legacy': 0}
    try:
        validate(root, output)
    except Exception as error:  # noqa: BLE001 - report every static failure, never crash CI parser
        output['ok'] = False
        output['errors'].append({'path': None, 'code': 'validation_error', 'message': str(error)})
    output['counts'] = {'legacy': output.get('legacy', 0), 'v5': len(output['entries'])}
    return output


if __name__ == '__main__':
    import sys

    argv = sys.argv[1:]
    root = Path('.')
    if '--root' in argv:
        index = argv.index('--root')
        check(index + 1 < len(argv), '--root requires a directory')
        root = Path(argv[index + 1])
    if '--json' in argv:
        result = report(root.resolve())
        # The machine report is the only stdout output; diagnostics stay on stderr.
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
        raise SystemExit(0 if result['ok'] else 1)
    print(f'Validated {validate(root)} market entries.')
