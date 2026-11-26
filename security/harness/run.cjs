'use strict';

/**
 * whale-plugin/1 container-side isolation harness.
 *
 * Runs only inside the credential-less, no-network, read-only-root container
 * started by security/isolated.py. It:
 *   1. verifies the mounted pinned host runtime against /harness/plugin-runtime.json;
 *   2. installs the candidate with a synthetic grant into a temp data directory;
 *   3. drives the real pinned UnifiedPluginRuntime + UnifiedCapabilityDispatcher;
 *   4. invokes every provider the manifest declares and lets the host validate output;
 *   5. checks timeout, cancellation and grant revocation behaviour;
 *   6. answers host.call with synthetic, schema-shaped values only (no send, no
 *      network, no file or process side effects);
 *   7. prints exactly one authenticated result line.
 *
 * The result is HMAC-signed with a secret read from stdin. isolated.py generated
 * that secret and never writes it to a file, argv or environment; the worker
 * environment is a fixed minimal set. This binds the output to one run and
 * detects tampering/mixups, but it is NOT a complete adversarial isolation
 * guarantee: candidate code runs under the same non-root uid, so a same-UID
 * process might still inspect parent process state through OS-specific paths.
 * The host therefore also revalidates package/runtime hashes and every provider
 * output schema itself; the container only provides non-root confinement.
 *
 * Pinned runtime shortcomings fail closed: if the pin is not verified, lacks the
 * adapter's required files, or its registry cannot support the declared
 * providers, this adapter reports blocked instead of pretending to pass.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MARKER = 'WHALE_ISOLATION_RESULT_V2 ';
const RESULT_SCHEMA = 2;
const MAX_RESULT_BYTES = 1536 * 1024;
const MAX_OUTPUT_JSON = 64 * 1024;
const MIN_BUDGET_MS = 5000;
const MAX_BUDGET_MS = 180000;
const CHECK_NAMES = Object.freeze(['schema', 'timeout', 'cancellation', 'revocation']);
// Files this adapter itself needs. A pin that does not cover them cannot be
// treated as verified: the host must re-pin and re-hash before flipping state.
const REQUIRED_RUNTIME_FILES = Object.freeze([
  'src/services/capabilitySchema.js',
  'src/services/pluginProtocol.js',
  'src/services/pluginProtocolRegistry.json',
  'src/services/unifiedCapabilityDispatcher.js',
  'src/services/unifiedPluginRuntime.js',
  'src/services/unifiedPluginWorker.js',
  'src/services/unifiedWasm.js',
  'src/services/unifiedWasmWorker.js',
]);
const SILENT_LOGGER = Object.freeze({ info() {}, warn() {} });
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const VERSION = /^\d+(?:\.\d+){1,3}$/;
const HASH = /^[a-f0-9]{64}$/;
const SECRET = /^[a-f0-9]{64}$/;

let emitted = false;
let secret = '';

function failure(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeText(value, limit) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, limit);
}

function readBounded(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw failure('invalid_file', 'candidate file is not a bounded regular file');
  const data = fs.readFileSync(file);
  if (data.length > limit) throw failure('invalid_file', 'candidate file exceeds limit');
  return data;
}

function readJson(file, limit) {
  return JSON.parse(readBounded(file, limit).toString('utf8'));
}

/**
 * Provider output travels to the host as the exact JSON text plus its digest, so
 * the host can validate the schema and notice any mismatch without duplicating
 * a cross-language canonical serializer. Oversized outputs fail closed.
 */
function encodeOutput(value) {
  let json;
  try {
    json = JSON.stringify(value === undefined ? null : value);
  } catch {
    throw failure('invalid_capability_output', 'provider output is not JSON-serializable');
  }
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_OUTPUT_JSON) {
    throw failure('provider_output_too_large', 'provider output exceeds the host validation limit');
  }
  // A plugin may legitimately return the public marker text; escape its first
  // character so the single-line scanner cannot mistake payload for a second
  // result. JSON parsing restores the original value, and the digest binds the
  // escaped wire text.
  const safeJson = json.split(MARKER).join('\\u0057HALE_ISOLATION_RESULT_V2 ');
  return { outputJson: safeJson, outputSha256: sha256(safeJson) };
}

function envInt(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(MAX_BUDGET_MS, Math.max(MIN_BUDGET_MS, value));
}

function readSecret() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  const value = String(raw).split(/\r?\n/)[0].trim();
  if (!SECRET.test(value)) throw failure('harness_secret_invalid', 'stdin isolation secret is missing or invalid');
  return value;
}

/** Deterministic, ASCII-only MAC input. isolated.py builds the same lines. */
function macTextFor(body, key) {
  const subject = isObject(body.subject) ? body.subject : {};
  const checks = isObject(body.checks) ? body.checks : {};
  const providers = Array.isArray(body.providers) ? body.providers : [];
  return [
    'whale-isolation/2',
    sha256(key),
    safeText(body.status, 16),
    safeText(body.code, 64),
    safeText(subject.id, 48),
    safeText(subject.version, 32),
    Number.isInteger(subject.level) ? String(subject.level) : '',
    safeText(subject.manifestSha256, 64),
    safeText(subject.entrySha256, 64),
    safeText(body.runtime_digest, 64),
    providers.map(row => safeText(row && row.name, 64) + '='
      + (row && row.ok === true ? 'ok:' + safeText(row.outputSha256, 64) : 'fail:')).join(','),
    CHECK_NAMES.map(name => checks[name] === true ? '1' : '0').join(''),
  ].join('\n');
}

function macText(body) {
  return macTextFor(body, secret);
}

function sign(body) {
  body.auth = {
    algo: 'hmac-sha256',
    nonceHash: sha256(secret),
    mac: crypto.createHmac('sha256', secret).update(macText(body)).digest('hex'),
  };
  return body;
}

function emit(body) {
  if (emitted) return;
  emitted = true;
  sign(body);
  let text = MARKER + JSON.stringify(body);
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    text = MARKER + JSON.stringify(sign({
      schema: RESULT_SCHEMA,
      status: 'blocked',
      code: 'result_too_large',
      reason: 'harness result exceeds the output limit',
    }));
  }
  // Flush before exiting so the container never truncates the only result line.
  process.stdout.write(text, () => process.exit(0));
}

function blocked(code, reason, extra) {
  return Object.assign({ schema: RESULT_SCHEMA, status: 'blocked', code: safeText(code, 64), reason: safeText(reason, 200) }, extra || {});
}

function passed(extra) {
  return Object.assign({ schema: RESULT_SCHEMA, status: 'passed', code: '' }, extra);
}

function verifyPinnedRuntime(pin, runtimeDir) {
  if (!isObject(pin) || !isObject(pin.files) || !Object.keys(pin.files).length) {
    throw failure('runtime_pin_invalid', 'pinned runtime manifest has no file hashes');
  }
  if (!isObject(pin.harness) || pin.harness.state !== 'verified') {
    throw failure('runtime_pin_pending', 'pinned harness is not verified');
  }
  const missing = REQUIRED_RUNTIME_FILES.filter(name => !Object.hasOwn(pin.files, name));
  if (missing.length) {
    throw failure('runtime_pin_incomplete', 'pinned runtime does not cover adapter file: ' + missing[0]);
  }
  const hashes = {};
  for (const [name, expected] of Object.entries(pin.files)) {
    if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\')
      || name.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw failure('runtime_pin_invalid', 'pinned runtime contains an unsafe file path');
    }
    if (typeof expected !== 'string' || !HASH.test(expected)) {
      throw failure('runtime_pin_invalid', 'pinned runtime hash is not lowercase SHA-256: ' + safeText(name, 64));
    }
    const data = readBounded(path.join(runtimeDir, name), 8 * 1024 * 1024);
    const actual = sha256(data);
    if (actual !== expected) throw failure('runtime_pin_mismatch', 'pinned runtime hash mismatch: ' + safeText(name, 64));
    hashes[name] = actual;
  }
  return sha256(JSON.stringify(Object.keys(hashes).sort().map(name => [name, hashes[name]])));
}

/**
 * Deterministic schema-shaped fixture. Not a validator: the real host validates
 * plugin output. This only gives providers realistic, bounded inputs and gives
 * host.call synthetic outputs.
 */
function synthSchema(registry, schema, depth) {
  depth = depth || 0;
  if (depth > 12) return null;
  if (typeof schema === 'string') {
    if (schema === 'json') return {};
    const named = registry.schemas && registry.schemas[schema];
    return named ? synthSchema(registry, named, depth + 1) : null;
  }
  if (!isObject(schema)) return null;
  if (schema.$ref !== undefined) {
    const name = String(schema.$ref).replace(/^#\/schemas\//, '');
    if (!registry.schemas || !Object.hasOwn(registry.schemas, name)) return null;
    return synthSchema(registry, registry.schemas[name], depth + 1);
  }
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object') {
    const value = {};
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      value[key] = synthSchema(registry, props[key] || {}, depth + 1);
    }
    for (const [key, child] of Object.entries(props)) {
      if (!Object.hasOwn(value, key)) value[key] = synthSchema(registry, child, depth + 1);
    }
    return value;
  }
  if (type === 'array') {
    const minimum = Number.isInteger(schema.minItems) && schema.minItems > 0 ? schema.minItems : 1;
    const count = Math.min(3, minimum);
    return Array.from({ length: count }, () => synthSchema(registry, schema.items || {}, depth + 1));
  }
  if (type === 'string') {
    const minLength = Number.isInteger(schema.minLength) ? schema.minLength : 0;
    let text = 'isolated-fixture';
    while (text.length < minLength) text += text;
    const maxLength = Number.isInteger(schema.maxLength) ? Math.max(minLength, schema.maxLength) : 256;
    return text.slice(0, Math.min(maxLength, 256));
  }
  if (type === 'integer') {
    const minimum = Number.isInteger(schema.minimum) ? schema.minimum : 0;
    const maximum = Number.isInteger(schema.maximum) ? schema.maximum : minimum + 1;
    return Math.min(Math.max(minimum, 0), maximum);
  }
  if (type === 'number') {
    const minimum = typeof schema.minimum === 'number' ? schema.minimum : 0;
    return Math.min(Math.max(minimum, 0), 1);
  }
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (type === 'json') return {};
  return null;
}

function installCandidate({ dataDir, manifest, manifestBytes, entryBytes, registry, policy }) {
  const root = path.join(dataDir, 'plugins');
  const install = path.join(root, manifest.id);
  fs.mkdirSync(path.join(install, 'data'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(install, 'plugin.json'), manifestBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(install, policy.entry), entryBytes, { mode: 0o600 });
  const calls = (Array.isArray(manifest.calls) ? manifest.calls : [])
    .filter(name => registry.calls && registry.calls[name] && registry.calls[name].enabled !== false);
  // A declared settingsSchema is enforced by the runtime on read. Synthesize a
  // schema-valid settings object so a legitimate required-field schema does not
  // look like a rejected grant.
  const settings = isObject(manifest.settingsSchema) ? synthSchema(registry, manifest.settingsSchema, 0) : {};
  const grant = {
    enabled: true,
    epoch: crypto.randomUUID(),
    packageHash: sha256(Buffer.concat([manifestBytes, entryBytes])),
    level: manifest.level,
    manifestHash: sha256(manifestBytes),
    entryHash: sha256(entryBytes),
    approvedProviders: Object.keys(manifest.provides || {}),
    approvedCalls: calls,
    approvedDataAccess: Array.isArray(manifest.dataAccess) ? manifest.dataAccess.slice() : [],
    fullAccess: manifest.level === 4,
    nodeFullConfirmed: manifest.level === 4,
    chatConfirmed: manifest.level === 3,
    settings: isObject(settings) ? settings : {},
  };
  const grantFile = path.join(install, 'grant.json');
  fs.writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
  return { install, grantFile, originalGrant: fs.readFileSync(grantFile), calls };
}

function createHostCall(registry, records) {
  return async function hostCall(name, input, flow) {
    if (typeof name !== 'string' || name.length > 64) throw failure('host_capability_unknown', 'invalid host capability name');
    const contract = registry.calls && registry.calls[name];
    if (!contract) throw failure('host_capability_unknown', 'unknown host capability: ' + safeText(name, 64));
    if (!Array.isArray(flow.calls) || !flow.calls.includes(name)) {
      throw failure('host_capability_not_declared', 'host capability is not declared by this install');
    }
    // Synthetic and side-effect free: no send, no network, no file/process action.
    if (records.seen.length < 32) records.seen.push(name);
    records.count++;
    return synthSchema(registry, contract.outputSchema, 0);
  };
}

function providerNames(manifest) {
  return Object.keys(isObject(manifest.provides) ? manifest.provides : {}).sort();
}

async function invokeProviders({ registry, dispatcher, manifest, timeoutMs, overallDeadline, captured }) {
  const rows = [];
  for (const name of providerNames(manifest)) {
    const declaration = manifest.provides[name];
    const rule = registry.providers && registry.providers[name];
    if (!isObject(rule) || !isObject(declaration)) throw failure('manifest_provider_invalid', 'manifest provider is not in the pinned registry');
    const input = synthSchema(registry, rule.inputSchema, 0);
    const deadline = Math.min(Date.now() + timeoutMs, overallDeadline);
    const started = Date.now();
    try {
      if (name === 'tool.run@1') {
        await dispatcher.runTool(manifest.id, input, { deadline });
      } else {
        await dispatcher.invoke(name, input, {
          scope: declaration.scope,
          pluginId: name === 'task.tick@1' ? manifest.id : undefined,
          deadline,
        });
      }
      const output = captured.get(name);
      if (!output) throw failure('provider_output_missing', 'host did not receive a schema-validated provider output');
      rows.push({ name, mode: declaration.mode, scope: declaration.scope, ok: true,
        durationMs: Date.now() - started, outputJson: output.outputJson, outputSha256: output.outputSha256 });
    } catch (error) {
      rows.push({
        name, mode: declaration.mode, scope: declaration.scope, ok: false,
        durationMs: Date.now() - started, code: safeText(error && error.code || 'plugin_error', 48),
      });
      return { rows, failed: name };
    }
  }
  return { rows, failed: '' };
}

async function expectCode(promise, expected) {
  try {
    await promise;
  } catch (error) {
    return error && error.code === expected;
  }
  return false;
}

async function behaviourChecks({ runtime, flow, registry, capability, grantFile, originalGrant }) {
  const checks = { schema: false, timeout: false, cancellation: false, revocation: false };
  if (!flow || !capability) return checks;
  const rule = registry.providers[capability];
  const input = synthSchema(registry, rule.inputSchema, 0);
  checks.schema = true; // every provider above ran through the host's output validation
  checks.timeout = await expectCode(runtime.invoke(flow, capability, input, { deadline: Date.now() - 1 }), 'capability_timeout');
  const controller = new AbortController();
  controller.abort();
  checks.cancellation = await expectCode(runtime.invoke(flow, capability, input, { signal: controller.signal }), 'capability_aborted');
  try {
    const revoked = JSON.parse(originalGrant.toString('utf8'));
    revoked.enabled = false;
    fs.writeFileSync(grantFile, JSON.stringify(revoked), { mode: 0o600 });
    checks.revocation = await expectCode(runtime.invoke(flow, capability, input), 'grant_revoked');
  } finally {
    fs.writeFileSync(grantFile, originalGrant, { mode: 0o600 });
  }
  if (!runtime.isApproved(flow)) checks.revocation = false;
  return checks;
}

async function main() {
  const budget = envInt('HARNESS_TIMEOUT_MS', 60000);
  const started = Date.now();
  let watchdog;
  try {
    secret = readSecret();
    watchdog = setTimeout(() => emit(blocked('harness_timeout', 'overall isolation budget exceeded')), budget);
    watchdog.unref?.();

    const candidateDir = process.env.HARNESS_CANDIDATE_DIR || '/candidate';
    const runtimeDir = process.env.HARNESS_RUNTIME_DIR || '/runtime';
    const pinPath = process.env.HARNESS_PIN || '/harness/plugin-runtime.json';

    const pin = readJson(pinPath, 64 * 1024);
    const runtimeDigest = verifyPinnedRuntime(pin, runtimeDir);
    const registry = readJson(path.join(runtimeDir, 'src/services/pluginProtocolRegistry.json'), 4 * 1024 * 1024);
    if (!isObject(registry) || registry.format !== 'whale-plugin/1' || !isObject(registry.levels)) {
      throw failure('runtime_pin_format_mismatch', 'pinned runtime registry is not whale-plugin/1');
    }

    const manifestBytes = readBounded(path.join(candidateDir, 'plugin.json'),
      Number.isInteger(registry.limits && registry.limits.maxManifestBytes) ? registry.limits.maxManifestBytes : 32768);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!isObject(manifest)) throw failure('invalid_manifest', 'plugin.json is not an object');
    const level = manifest.level;
    if (!Number.isInteger(level) || ![1, 2, 3, 4].includes(level)) {
      throw failure('invalid_manifest', 'only executable levels 1-4 reach the isolation harness');
    }
    const policy = registry.levels[String(level)];
    if (!isObject(policy) || manifest.runtime !== policy.runtime) {
      throw failure('manifest_runtime_mismatch', 'manifest runtime does not match the pinned level policy');
    }
    if (manifest.entry !== policy.entry) throw failure('manifest_entry_mismatch', 'manifest entry does not match the pinned level policy');
    const entryLimit = Number.isInteger(policy.maxEntryBytes) ? policy.maxEntryBytes : 8 * 1024 * 1024;
    const entryBytes = readBounded(path.join(candidateDir, policy.entry), entryLimit);

    const subject = {
      id: manifest.id,
      version: manifest.version,
      level,
      entry: policy.entry,
      manifestSha256: sha256(manifestBytes),
      entrySha256: sha256(entryBytes),
    };
    if (typeof subject.id !== 'string' || !ID.test(subject.id)) throw failure('invalid_manifest', 'manifest id is not a safe plugin id');
    if (typeof subject.version !== 'string' || !VERSION.test(subject.version)) throw failure('invalid_manifest', 'manifest version is not a fixed version');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-isolate-'));
    const installed = installCandidate({ dataDir, manifest, manifestBytes, entryBytes, registry, policy });

    const runtimeModule = require(path.join(runtimeDir, 'src/services/unifiedPluginRuntime.js'));
    const dispatcherModule = require(path.join(runtimeDir, 'src/services/unifiedCapabilityDispatcher.js'));
    const hostCalls = { seen: [], count: 0 };
    const runtime = new runtimeModule.UnifiedPluginRuntime({
      dataDir,
      logger: SILENT_LOGGER,
      hostCall: createHostCall(registry, hostCalls),
      maxConcurrent: 1,
    });
    const dispatcher = new dispatcherModule.UnifiedCapabilityDispatcher({ plugins: runtime, logger: SILENT_LOGGER });
    for (const name of providerNames(manifest)) {
      if (!isObject(registry.providers[name])) throw failure('manifest_provider_invalid', 'provider is not in the pinned registry');
      dispatcher.define(name, { builtin: () => synthSchema(registry, registry.providers[name].outputSchema, 0) });
    }

    const flow = runtime.installed()[0];
    if (!flow) throw failure('grant_rejected', 'pinned runtime rejected the synthetic grant');
    // Intercept the runtime call the dispatcher makes so the host receives the
    // exact provider output, not just "dispatch returned". The host revalidates
    // its schema and digest; a missing/oversized output fails the provider.
    const captured = new Map();
    let captureEnabled = true;
    const originalInvoke = runtime.invoke.bind(runtime);
    runtime.invoke = (flowArg, capability, input, options = {}) => {
      if (!captureEnabled) return originalInvoke(flowArg, capability, input, options);
      const validate = options.validateOutput;
      return originalInvoke(flowArg, capability, input, {
        ...options,
        validateOutput: value => {
          if (typeof validate === 'function') validate(value);
          captured.set(capability, encodeOutput(value));
        },
      });
    };
    const timeoutMs = Number.isInteger(manifest.executionTimeoutMs)
      ? Math.min(manifest.executionTimeoutMs, 30000) : 10000;
    const overallDeadline = Math.max(Date.now() + 1000, started + budget - 1500);
    const outcome = await invokeProviders({ registry, dispatcher, manifest, timeoutMs, overallDeadline, captured });
    captureEnabled = false;
    const base = {
      subject,
      runtime_digest: runtimeDigest,
      runtime_files: Object.keys(pin.files).length,
      host_calls: hostCalls.seen.slice().sort(),
      host_call_count: hostCalls.count,
      providers: outcome.rows,
      limits: { budget_ms: budget, provider_timeout_ms: timeoutMs },
    };
    if (outcome.failed) {
      const row = outcome.rows[outcome.rows.length - 1];
      emit(blocked('provider_failed', 'declared provider did not pass: ' + safeText(outcome.failed, 64), {
        ...base, checks: { schema: false, timeout: false, cancellation: false, revocation: false },
      }));
      return;
    }

    const firstCapability = providerNames(manifest)[0] || '';
    const checks = await behaviourChecks({
      runtime, flow, registry, capability: firstCapability, grantFile: installed.grantFile, originalGrant: installed.originalGrant,
    });
    await runtime.stop();
    if (!CHECK_NAMES.every(name => checks[name] === true)) {
      emit(blocked('isolation_checks_failed', 'timeout/cancellation/revocation checks did not all pass', { ...base, checks }));
      return;
    }
    emit(passed({ ...base, checks, reason: 'every declared provider ran in the pinned runtime; synthetic host calls only' }));
  } catch (error) {
    const code = safeText(error && error.code || 'harness_error', 64);
    emit(blocked(code, error && error.message || 'isolation harness error'));
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
}

if (require.main === module) {
  process.on('uncaughtException', error => {
    if (!emitted) emit(blocked('harness_error', error && error.message || 'uncaught harness error'));
  });
  process.on('unhandledRejection', error => {
    if (!emitted) emit(blocked('harness_error', error && error.message || 'unhandled harness rejection'));
  });
  void main();
}

module.exports = { MARKER, RESULT_SCHEMA, CHECK_NAMES, REQUIRED_RUNTIME_FILES, synthSchema, macText, macTextFor,
  verifyPinnedRuntime };
