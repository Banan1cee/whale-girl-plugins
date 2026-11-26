"""Static self-checks for the market workflows.

These checks catch the dangerous pull_request_target patterns that would let a
candidate run with privileges or inject its text into a shell. They are not a
substitute for review; they only fail on known-bad shapes.
"""
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / '.github/workflows'
DANGEROUS_EVENT_TEXT = re.compile(r'\$\{\{\s*github\.event\.(pull_request|issue|comment)\.'
                                  r'(title|body|head\.label|head\.ref|user\.login\s*\}\}\s*[\'"`]?)')


def text(name):
    raw = (WORKFLOWS / name).read_text(encoding='utf-8')
    # 注释不是执行面：只看真正会执行的配置行，避免把说明文字当成危险模式。
    return '\n'.join(line for line in raw.splitlines() if not line.lstrip().startswith('#'))


def fail(message):
    raise SystemExit('workflow self-check failed: ' + message)


def main():
    security = text('security.yml')
    if 'pull_request_target' not in security:
        fail('security.yml must stay on pull_request_target with a trusted base')
    if re.search(r'github\.event\.pull_request\.head\.(ref|label)', security):
        fail('security.yml must never checkout or reference the candidate head ref/label')
    if re.search(r'ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.', security):
        fail('security.yml must not checkout the candidate head')
    if 'GH_READ_TOKEN' in security.split('isolate:', 1)[-1]:
        fail('isolation job must not receive a repository token')
    isolate = security.split('isolate:', 1)[-1].split('attest:', 1)[0]
    if not re.search(r'permissions:\s*\{\s*\}', isolate):
        fail('isolation job must declare permissions: {}')
    for forbidden in ('secrets.', 'github.token'):
        if forbidden in isolate:
            fail('isolation job must not reference ' + forbidden)
    if re.search(r'actions/checkout@[^\n]*\n(?:[^\n]*\n){0,4}[^\n]*ref:\s*\$\{\{\s*github\.event\.pull_request', isolate):
        fail('isolation job must not checkout the candidate')
    if DANGEROUS_EVENT_TEXT.search(security):
        fail('candidate-controlled text must be passed via env, never interpolated into shell')
    if 'attest-subjects/*.zip' not in security:
        fail('attestation must bind the explicit package list, not an arbitrary path')
    if 'pull-requests: read' not in security:
        fail('the static job needs pull-requests: read to list PR changed files')
    if 'node --check security/harness/run.cjs' not in security:
        fail('the trusted static job must syntax-check the isolation adapter')
    attest = security.split('attest:', 1)[-1]
    if '--isolation' not in attest:
        fail('attestation must consume the isolation report, not just the static report')
    if 'trusted/security/attest_subjects.py' not in attest:
        fail('attestation must run the trusted-base copy of attest_subjects.py')
    if 'actions/checkout' in attest:
        fail('attestation must not execute workspace code; it only needs trusted artifacts')
    if "steps.gate.outputs.mode == 'submission'" not in attest:
        fail('maintenance pushes must skip attestation explicitly instead of failing')

    selftest = text('security-selftest.yml')
    if 'secrets.' in selftest:
        fail('selftest is maintenance CI and must not use secrets')
    if 'pull_request_target' in selftest:
        fail('selftest must not run as a privileged candidate job')
    if 'security/harness/selftest.cjs' not in selftest:
        fail('selftest must exercise the isolation adapter self-test')

    for name in ('validate.yml', 'index.yml'):
        body = text(name)
        if 'pull_request' in body and not re.search(r'github\.event\.pull_request\.base\.sha', body):
            fail(name + ' PR path must run trusted base scripts, not candidate scripts')
        if 'cp -a candidate/.git' in body:
            fail(name + ' must not copy candidate git metadata into the trusted work copy')
        if 'find "candidate/' not in body:
            fail(name + ' must reject symlinked candidate data paths')
    print('workflow self-checks passed: trusted base, no candidate execution in privileged jobs')


if __name__ == '__main__':
    main()
