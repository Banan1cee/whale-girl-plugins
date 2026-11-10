"""Validate both market catalogs and their ZIP files without running plugin code."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, build_opener
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
PREFIX = 'https://raw.githubusercontent.com/Banan1cee/whale-girl-plugins/main/packages/'
HOSTS = {'raw.githubusercontent.com', 'github.com', 'release-assets.githubusercontent.com',
         'objects.githubusercontent.com'}
CATALOGS = {'index.json': 1, 'index-v2.json': 2}
CATALOG_ONLY = {'Download', 'Sha256', 'DiscussionIssue'}
VERSION = re.compile(r'\d+\.\d+\.\d+(\.\d+)?', re.ASCII)
LIMIT = 1024 * 1024


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
            return file.read(LIMIT + 1)
    with build_opener(GitHubRedirects()).open(url, timeout=20) as response:
        return response.read(LIMIT + 1)


def check_entry(root, entry, api, seen):
    plugin_id = entry['Id']
    check(re.fullmatch(r'[a-z][a-z0-9-]{0,47}', plugin_id)
          and not re.fullmatch(r'con|prn|aux|nul|com[1-9]|lpt[1-9]', plugin_id), 'invalid Id')
    check(type(entry['Api']) is int and entry['Api'] == api and entry.get('Kind', 'tool') == 'tool'
          and entry.get('HostAction') in ((None,) if api == 1 else (None, 'chat.summary')),
          'invalid Api, Kind or HostAction for this catalog')
    for field in ('Name', 'Author', 'ResultLabel'):
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
    check(len(data) <= LIMIT, 'ZIP exceeds 1 MiB')
    check(hashlib.sha256(data).hexdigest() == entry['Sha256'].lower(), 'SHA-256 mismatch')
    with ZipFile(BytesIO(data)) as package:
        check(sorted(package.namelist()) == ['plugin.json', 'plugin.wasm'], 'unexpected ZIP entries')
        check(package.getinfo('plugin.json').file_size <= 8192, 'manifest exceeds 8 KiB')
        check(package.getinfo('plugin.wasm').file_size <= 512 * 1024, 'Wasm exceeds 512 KiB')
        manifest = json.loads(package.read('plugin.json'))
        check(manifest == {k: v for k, v in entry.items() if k not in CATALOG_ONLY},
              'package manifest differs from catalog')
        check(package.read('plugin.wasm').startswith(b'\x00asm\x01\x00\x00\x00'), 'invalid Wasm header')


def validate(root):
    seen = set()
    for name, api in CATALOGS.items():
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
                check_entry(root, entry, api, seen)
            except Exception as error:
                raise ValueError(f'{name} entry {index}: {error}') from error
    return len(seen)


if __name__ == '__main__':
    print(f'Validated {validate(ROOT)} market entries.')
