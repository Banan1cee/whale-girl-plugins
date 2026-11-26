'use strict';

// Maintenance self-test for the isolation adapter's pure, container-independent
// pieces. It never starts a container, never loads a candidate plugin and never
// requires the host runtime. The real end-to-end adapter run is recorded as a
// host-side synthetic fixture in the task report, not by this CI test.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('./run.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-harness-test-'));
  const files = {};
  for (const name of harness.REQUIRED_RUNTIME_FILES) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture:' + name);
    files[name] = sha('fixture:' + name);
  }
  return { root, files };
}

function pinFor(files) {
  return {
    commit: 'a'.repeat(40),
    image: 'node:24-bookworm-slim@sha256:' + 'b'.repeat(64),
    files,
    harness: { state: 'verified' },
  };
}

function expectCode(action, code) {
  let raised = null;
  try {
    action();
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, 'expected the adapter to fail closed');
  assert.equal(raised.code, code);
}

const { root, files } = fixture();
try {
  const digest = harness.verifyPinnedRuntime(pinFor({ ...files }), root);
  assert.match(digest, /^[a-f0-9]{64}$/, 'runtime digest is a SHA-256');

  const registry = {
    schemas: {
      'empty-object': { type: 'object', properties: {}, required: [], additionalProperties: false },
      'chat.pre_reply.output@1': {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pass', 'skip', 'wake'] },
          reason: { type: 'string', maxLength: 80 },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  };
  assert.deepEqual(harness.synthSchema(registry, 'empty-object', 0), {});
  const decision = harness.synthSchema(registry, 'chat.pre_reply.output@1', 0);
  assert.equal(decision.action, 'pass');
  assert.equal(typeof decision.reason, 'string');
  assert.equal(harness.synthSchema(registry, 'json', 0) === null, false);

  const body = {
    status: 'passed', code: '', subject: { id: 'sample', version: '1.0.0', level: 4,
      manifestSha256: 'c'.repeat(64), entrySha256: 'd'.repeat(64) },
    runtime_digest: 'e'.repeat(64),
    providers: [{ name: 'tool.run@1', ok: true }],
    checks: { schema: true, timeout: true, cancellation: true, revocation: true },
  };
  const base = harness.macText(body);
  assert.equal(base, harness.macText(JSON.parse(JSON.stringify(body))), 'MAC input is deterministic');
  assert.notEqual(base, harness.macText({ ...body, status: 'blocked' }));
  assert.notEqual(base, harness.macText({ ...body, providers: [{ name: 'tool.run@1', ok: false }] }));
  assert.notEqual(base, harness.macText({ ...body, checks: { ...body.checks, revocation: false } }));
  assert.notEqual(base, harness.macText({ ...body, runtime_digest: 'f'.repeat(64) }));

  expectCode(() => harness.verifyPinnedRuntime({ ...pinFor({ ...files }), harness: { state: 'pending' } }, root),
    'runtime_pin_pending');
  const incomplete = { ...files };
  delete incomplete['src/services/unifiedCapabilityDispatcher.js'];
  expectCode(() => harness.verifyPinnedRuntime(pinFor(incomplete), root), 'runtime_pin_incomplete');
  const tampered = { ...files };
  tampered['src/services/unifiedPluginRuntime.js'] = 'f'.repeat(64);
  expectCode(() => harness.verifyPinnedRuntime(pinFor(tampered), root), 'runtime_pin_mismatch');
  expectCode(() => harness.verifyPinnedRuntime(pinFor({ ...files, '../escape.js': files['src/services/unifiedWasm.js'] }), root),
    'runtime_pin_invalid');
  console.log('harness self-test passed: pin verification, fixture synthesis, MAC determinism');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
