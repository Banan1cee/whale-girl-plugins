"""Build the only attestation subjects: market-hosted package ZIPs listed in a
passed submission report.

Plugin output, reports, logs and arbitrary paths are never signed. Subject
names must match the fixed market ZIP pattern and their bytes must match the
SHA-256 recorded by the trusted gate.

The report's `subjects` list is authoritative when present: PRs report every
entry, push/main only reports the changed packages. A separately supplied
isolation report must have passed and must be bound to the same package
SHA-256/manifest SHA-256 for every runnable (level 1-4) package.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

NAME = re.compile(r'[a-z][a-z0-9-]{0,47}-\d+\.\d+\.\d+(?:\.\d+)?\.zip', re.ASCII)
SHA = re.compile(r'[a-f0-9]{64}', re.ASCII)
RUNNABLE = (1, 2, 3, 4)


class AttestError(Exception):
    pass


def selected_entries(report):
    entries = report.get('entries') or []
    if not isinstance(entries, list) or not entries:
        raise AttestError('no package entries to attest')
    if not all(isinstance(entry, dict) for entry in entries):
        raise AttestError('report entries must be objects')
    listed = report.get('subjects')
    if listed is None:
        return entries
    if not isinstance(listed, list) or not listed:
        raise AttestError('report has an empty subject list')
    by_name = {}
    for entry in entries:
        name = '%s-%s.zip' % (entry.get('id'), entry.get('version'))
        if not NAME.fullmatch(name):
            raise AttestError('unsafe attestation subject name: ' + name)
        if name in by_name:
            raise AttestError('report contains a duplicate entry: ' + name)
        by_name[name] = entry
    selected, seen = [], set()
    for item in listed:
        if not isinstance(item, dict):
            raise AttestError('subject list contains a non-object')
        raw = str(item.get('path') or '')
        name = raw.rsplit('/', 1)[-1]
        if '/' in name or '\\' in name or not NAME.fullmatch(name):
            raise AttestError('unsafe attestation subject name: ' + name)
        if name in seen:
            raise AttestError('duplicate subject: ' + name)
        seen.add(name)
        entry = by_name.get(name)
        if entry is None:
            raise AttestError('subject is not among the report entries: ' + name)
        if item.get('sha256') != entry.get('sha256'):
            raise AttestError('subject hash differs from the report entry: ' + name)
        selected.append(entry)
    return selected


def require_isolation(entries, isolation):
    """A container result only counts when it is bound to the attested package."""
    if not isinstance(isolation, dict) or isolation.get('status') != 'passed':
        raise AttestError('isolation report did not pass; refusing to attest')
    results = isolation.get('entries') or []
    if not isinstance(results, list):
        raise AttestError('isolation report entries must be a list')
    index = {}
    for result in results:
        if not isinstance(result, dict):
            raise AttestError('isolation report entry must be an object')
        index[(result.get('id'), result.get('version'))] = result
    for entry in entries:
        if entry.get('level') not in RUNNABLE:
            continue
        name = '%s-%s.zip' % (entry.get('id'), entry.get('version'))
        result = index.get((entry.get('id'), entry.get('version')))
        if result is None:
            raise AttestError('isolation report has no result for executable package: ' + name)
        if result.get('status') != 'passed':
            raise AttestError('isolation did not pass for: ' + name)
        if result.get('sha256') != entry.get('sha256'):
            raise AttestError('isolation result is bound to a different package: ' + name)
        if entry.get('manifestSha256') is not None and result.get('manifestSha256') != entry.get('manifestSha256'):
            raise AttestError('isolation result is bound to a different manifest: ' + name)


def build(report_path, packages, output, isolation=None):
    report = json.loads(Path(report_path).read_text(encoding='utf-8'))
    if report.get('status') != 'passed' or report.get('mode') != 'submission':
        raise AttestError('only a passed submission report can be attested')
    entries = selected_entries(report)
    if isolation is not None:
        require_isolation(entries, json.loads(Path(isolation).read_text(encoding='utf-8')))
    output.mkdir(parents=True, exist_ok=False if output.exists() else True)
    attest_dir = output / 'attest-subjects'
    attest_dir.mkdir()
    subjects = []
    for entry in entries:
        name = '%s-%s.zip' % (entry.get('id'), entry.get('version'))
        if not NAME.fullmatch(name):
            raise AttestError('unsafe attestation subject name: ' + name)
        expected = entry.get('sha256')
        if not isinstance(expected, str) or not SHA.fullmatch(expected):
            raise AttestError('invalid recorded package hash')
        source = packages / name
        if not source.is_file() or source.is_symlink():
            raise AttestError('verified package is missing: ' + name)
        data = source.read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise AttestError('package bytes changed after the gate: ' + name)
        (attest_dir / name).write_bytes(data)
        subjects.append(name)
    (output / 'subjects.txt').write_text('\n'.join(subjects) + '\n', encoding='utf-8')
    return subjects


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument('--packages', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--isolation', type=Path,
                        help='isolation-report.json produced by the credential-less job')
    args = parser.parse_args()
    try:
        subjects = build(args.report, args.packages, args.output, args.isolation)
    except AttestError as error:
        print('attestation refused: ' + str(error), file=sys.stderr)
        return 1
    print('attestation subjects: ' + ', '.join(subjects))
    return 0


if __name__ == '__main__':
    sys.exit(main())
