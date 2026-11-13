"""Validate both market catalogs and their ZIP files without running plugin code."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener
from zipfile import ZipFile

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


def check(condition, message):
    if not condition:
        raise ValueError(message)


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
    check(hashlib.sha256(data).hexdigest() == entry['Sha256'].lower(), 'SHA-256 mismatch')
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


def validate(root):
    seen = set()
    catalogs = {**CATALOGS}
    if (root / 'index-personas.json').exists():
        catalogs['index-personas.json'] = 1
    for name, api in catalogs.items():
        if name == 'index-v4.json' and not (root / name).exists():
            continue
        data = (root / name).read_bytes()
        check(len(data) <= 256 * 1024, f'{name} exceeds launcher download limit')
        entries = json.loads(data)
        check(isinstance(entries, list), f'{name} must contain a JSON array')
        catalog_ids = set()
        for index, entry in enumerate(entries, 1):
            try:
                plugin_id = entry['Id']
                check(plugin_id not in catalog_ids, 'duplicate Id in catalog')
                catalog_ids.add(plugin_id)
                check_entry(root, entry, api, seen, name == 'index-personas.json')
            except Exception as error:
                raise ValueError(f'{name} entry {index}: {error}') from error
    return len(seen)


if __name__ == '__main__':
    print(f'Validated {validate(ROOT)} market entries.')
