import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { discoverCapabilities, harvest, harvestCapability, harvestPolicy } from '../src/harvest/index.js';
import { validateManifest, MANIFEST_VERSION } from '../src/manifest/schema.js';
import { writeManifest, readManifest, SOURCE_EVIDENCE_FILE } from '../src/manifest/io.js';
import { resolveRuntime } from '../src/verify/runtime.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { makeSource, makeDestination, patchFile } from './helpers.js';

const FAST = { timeoutMs: 4000, stepTimeoutMs: 1500 };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------- the working source

test('a working source capability is discovered, booted, observed and VERIFIED', async () => {
  const src = makeSource();
  try {
    const fp = fingerprintProject(src.root);
    assert.equal(fp.moduleSystem.value, 'cjs', 'the source is a different architecture from the destination on purpose');
    const { manifest, verification, policy } = await harvestCapability(fp, 'authentication', FAST);

    assert.equal(verification.verdict, 'VERIFIED');
    assert.equal(verification.summary.passed, verification.summary.required);
    assert.equal(verification.runtime.profile, 'node-entrypoint');
    assert.equal(policy.transplantReady, true);

    const vis = manifest.provenance.verifiedInSource;
    assert.equal(vis.verdict, 'VERIFIED');
    assert.equal(vis.skipped, false);
    assert.equal(vis.tests.length, manifest.acceptanceTests.tests.length);
    assert.ok(vis.tests.filter((t) => t.required).every((t) => t.outcome === 'passed'), 'every required test passed');
    assert.ok(vis.tests.some((t) => !t.required), 'the non-required restart-durability witness is recorded too');
    assert.equal(vis.runtime.profile, 'node-entrypoint');
    assert.match(vis.sourceState.head, /^[0-9a-f]{40}$/);
    assert.equal(vis.sourceState.dirty, false);
    assert.equal(vis.sourceState.marker, vis.sourceState.head.slice(0, 12));
    assert.equal(vis.sourceState.remote, null, 'a checkout without an origin records no repository identity rather than a path');
    assert.equal(vis.evidence, SOURCE_EVIDENCE_FILE);

    assert.equal(validateManifest(manifest).ok, true);
    assert.equal(alive(verification.process.pid), false, 'the source process must be gone after verification');
  } finally { src.cleanup(); }
});

test('an uncommitted source is recorded as such, never as pristine HEAD', async () => {
  const src = makeSource();
  try {
    fs.writeFileSync(path.join(src.root, 'notes.txt'), 'work in progress\n');
    const { manifest } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    const state = manifest.provenance.verifiedInSource.sourceState;
    assert.equal(state.dirty, true);
    assert.match(state.marker, /\+uncommitted-changes$/);
  } finally { src.cleanup(); }
});

test('source verification result survives a round trip through the organ bank', async () => {
  const src = makeSource();
  try {
    const { manifest } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    const bank = path.join(src.work, 'bank');
    const dir = writeManifest(bank, manifest);
    assert.ok(fs.existsSync(path.join(dir, SOURCE_EVIDENCE_FILE)), 'full evidence is written beside the manifest');
    const back = readManifest(dir);
    assert.equal(back.provenance.verifiedInSource.verdict, 'VERIFIED');
    assert.equal(back.sourceVerificationReport.results.length, manifest.acceptanceTests.tests.length);
    assert.ok(back.sourceVerificationReport.results.every((r) => Array.isArray(r.steps)), 'step-level evidence is preserved');
    assert.equal(validateManifest(back).ok, true);
  } finally { src.cleanup(); }
});

// ---------------------------------------------------------------- the control that matters

test('CONTROL: static discovery still finds auth, but broken password checking is observed and FAILED', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'lib/users.js', 'function verifyPassword(password, salt, expectedHash) {',
      'function verifyPassword(password, salt, expectedHash) {\n  return true;');
    const fp = fingerprintProject(src.root);
    const found = discoverCapabilities(fp).find((c) => c.id === 'authentication');
    assert.ok(found && found.harvestable, 'the analyzer cannot tell; it still sees an authentication capability');

    const { manifest, verification, policy } = await harvestCapability(fp, 'authentication', FAST);
    assert.equal(verification.verdict, 'FAILED');
    assert.ok(verification.results.some((r) => r.id === 'auth.login.rejects-invalid-credentials' && r.outcome === 'failed'));
    assert.equal(policy.bankable, false);
    assert.equal(policy.transplantReady, false);
    assert.equal(manifest.provenance.verifiedInSource.verdict, 'FAILED');
    assert.notEqual(manifest.provenance.verifiedInSource.verdict, 'VERIFIED');
  } finally { src.cleanup(); }
});

test('CONTROL: a source that leaks sessions on logout is observed and FAILED', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'routes/auth.js', 'if (sid) destroySession(sid);', '/* leaked */');
    const { verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'FAILED');
    assert.ok(verification.results.some((r) => r.id === 'auth.logout.ends-session' && r.outcome === 'failed'));
  } finally { src.cleanup(); }
});

// ---------------------------------------------------------------- when evidence cannot be obtained

test('a source that crashes on startup is NEEDS_REVIEW, never VERIFIED', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'server.js', "'use strict';", "'use strict';\nthrow new Error('boot-boom');");
    const { verification, policy } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'NEEDS_REVIEW');
    assert.equal(verification.summary.required, 0);
    assert.match(verification.diagnostics.stderr, /boot-boom/);
    assert.equal(policy.transplantReady, false);
    assert.equal(alive(verification.process.pid), false);
  } finally { src.cleanup(); }
});

test('a source that never starts listening is NEEDS_REVIEW after the boot timeout, and is killed', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'server.js', 'server.listen(port,', 'setInterval(() => {}, 1000); if (false) server.listen(port,');
    const { verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', { timeoutMs: 1500, stepTimeoutMs: 1000 });
    assert.equal(verification.verdict, 'NEEDS_REVIEW');
    assert.equal(verification.diagnostics.reason, 'timeout-waiting-for-listen');
    assert.equal(alive(verification.process.pid), false, 'a hung source must not be left running');
  } finally { src.cleanup(); }
});

test('a source that accepts a request and never answers is NEEDS_REVIEW, not VERIFIED', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'routes/auth.js', "router.add('POST', '/auth/register', (req, res) => {", "router.add('POST', '/auth/register', (req, res) => {\n    return; // never responds");
    const { verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'NEEDS_REVIEW');
    assert.ok(verification.results.some((r) => r.outcome === 'inconclusive'));
    assert.ok(!verification.results.some((r) => r.outcome === 'failed' && !r.required));
    assert.equal(alive(verification.process.pid), false);
  } finally { src.cleanup(); }
});

test('a source GRAFT does not know how to run is NEEDS_REVIEW with the reason, not a guess', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'package.json', '"start": "node server.js"', '"start": "docker compose up"');
    const fp = fingerprintProject(src.root);
    assert.equal(resolveRuntime(fp).ok, false);
    const { verification } = await harvestCapability(fp, 'authentication', FAST);
    assert.equal(verification.verdict, 'NEEDS_REVIEW');
    assert.equal(verification.diagnostics.reason, 'runtime-unresolved');
    assert.match(verification.rationale, /docker compose up/);
  } finally { src.cleanup(); }
});

test('a source that does not read $PORT cannot be targeted and is NEEDS_REVIEW', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'server.js', 'process.env.PORT || 3000', '3000');
    fs.writeFileSync(path.join(src.root, '.env.example'), 'SESSION_SECRET=replace-me\n');
    const { verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'NEEDS_REVIEW');
    assert.match(verification.rationale, /PORT/);
  } finally { src.cleanup(); }
});

// ---------------------------------------------------------------- process safety

test('the source runs in a controlled environment and cannot see host secrets', async () => {
  const src = makeSource();
  process.env.GRAFT_TEST_CANARY = 'host-secret-value';
  try {
    patchFile(src.root, 'server.js', "'use strict';",
      "'use strict';\nconsole.error('CANARY=' + (process.env.GRAFT_TEST_CANARY === undefined ? 'absent' : 'LEAKED'));");
    const { verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'VERIFIED');
    assert.match(verification.diagnostics.stderr, /CANARY=absent/);
    assert.doesNotMatch(verification.diagnostics.stderr, /LEAKED/);
  } finally { delete process.env.GRAFT_TEST_CANARY; src.cleanup(); }
});

test('grandchildren spawned by the source are torn down with it', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'server.js', "'use strict';",
      "'use strict';\nconst gc = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\nconsole.error('GRANDCHILD=' + gc.pid);");
    const { verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'VERIFIED');
    const gcPid = Number(/GRANDCHILD=(\d+)/.exec(verification.diagnostics.stderr)?.[1]);
    assert.ok(gcPid > 0, 'test setup: grandchild pid must be reported');
    await new Promise((r) => setTimeout(r, 300));
    const still = alive(gcPid);
    if (still) { try { process.kill(gcPid, 'SIGKILL'); } catch { /* best effort */ } }
    assert.equal(still, false, `grandchild ${gcPid} survived teardown`);
    assert.equal(alive(verification.process.pid), false);
  } finally { src.cleanup(); }
});

test('secrets the source logs are redacted from the evidence GRAFT keeps', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'server.js', "'use strict';", "'use strict';\nconsole.error('key sk-live-0123456789abcdefghijklmnop loaded');");
    const { manifest, verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'VERIFIED');
    assert.match(manifest.sourceVerificationReport.diagnostics.stderr, /\[redacted\]/);
    assert.doesNotMatch(JSON.stringify(manifest), /sk-live-0123456789/);
    const dir = writeManifest(path.join(src.work, 'bank'), manifest);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, SOURCE_EVIDENCE_FILE), 'utf8'), /sk-live-0123456789/);
  } finally { src.cleanup(); }
});

// ---------------------------------------------------------------- provenance cannot be faked

test('the schema refuses a manifest that claims VERIFIED without passing tests', () => {
  const src = makeSource();
  try {
    const m = harvest(fingerprintProject(src.root), 'authentication');
    assert.equal(m.identity.manifestVersion, MANIFEST_VERSION);
    m.provenance.verifiedInSource = { verdict: 'VERIFIED', rationale: 'trust me', at: new Date().toISOString(), tests: [], runtime: { profile: 'node-entrypoint' } };
    const v = validateManifest(m);
    assert.equal(v.ok, false);
    assert.match(v.errors.join(' '), /claims VERIFIED without a passing test/);

    m.provenance.verifiedInSource = { verdict: 'VERIFIED', rationale: 'skipped but verified', at: new Date().toISOString(), skipped: true,
      tests: m.acceptanceTests.tests.map((t) => ({ id: t.id, required: true, outcome: 'passed' })), runtime: { profile: 'node-entrypoint' } };
    assert.match(validateManifest(m).errors.join(' '), /cannot be both skipped and VERIFIED/);

    const requiredTests = m.acceptanceTests.tests.filter((t) => t.required);
    m.provenance.verifiedInSource = { verdict: 'VERIFIED', rationale: 'x', at: new Date().toISOString(),
      tests: m.acceptanceTests.tests.map((t) => ({ id: t.id, required: t.required, outcome: 'passed' })), runtime: { profile: 'node-entrypoint' } };
    m.provenance.verifiedInSource.summary = { required: requiredTests.length, passed: requiredTests.length, failed: 0, inconclusive: 0 };
    assert.equal(validateManifest(m).ok, true, 'a well-formed VERIFIED claim is accepted');
    assert.throws(() => writeManifest(path.join(src.work, 'bank'), { ...m, provenance: { ...m.provenance, verifiedInSource: null } }), /must be an object/);
  } finally { src.cleanup(); }
});

test('harvest without source verification is honest: NEEDS_REVIEW, skipped, not transplant-ready', async () => {
  const src = makeSource();
  try {
    const { manifest, verification, policy } = await harvestCapability(fingerprintProject(src.root), 'authentication', { verifySource: false });
    assert.equal(verification, null);
    assert.equal(manifest.provenance.verifiedInSource.verdict, 'NEEDS_REVIEW');
    assert.equal(manifest.provenance.verifiedInSource.skipped, true);
    assert.equal(policy.transplantReady, false);
    assert.equal(policy.bankable, true);
  } finally { src.cleanup(); }
});

// ---------------------------------------------------------------- the verdict reaches the transplant

test('a capability that FAILED in source cannot be applied to a destination', async () => {
  const src = makeSource();
  const dest = makeDestination();
  try {
    patchFile(src.root, 'lib/users.js', 'function verifyPassword(password, salt, expectedHash) {', 'function verifyPassword(password, salt, expectedHash) {\n  return true;');
    const { manifest } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true });
    assert.equal(plan.status, 'blocked');
    assert.ok(plan.compatibility.blocking.some((b) => b.id === 'source.verification'));
    const result = applyTransplant(plan, dest.root);
    assert.equal(result.applied, false);
    assert.ok(result.problems.some((p) => p.code === 'plan-blocked'));
    assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false);
  } finally { src.cleanup(); dest.cleanup(); }
});

test('an unproven capability may be transplanted, but the plan says so', async () => {
  const src = makeSource();
  const dest = makeDestination();
  try {
    const { manifest } = await harvestCapability(fingerprintProject(src.root), 'authentication', { verifySource: false });
    const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true });
    assert.equal(plan.status, 'ready');
    const check = plan.compatibility.checks.find((c) => c.id === 'source.verification');
    assert.equal(check.status, 'warn');
    assert.match(check.title, /not proven/);
  } finally { src.cleanup(); dest.cleanup(); }
});

test('a verified capability gets a clean source check in the plan', async () => {
  const src = makeSource();
  const dest = makeDestination();
  try {
    const { manifest } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    const destFp = fingerprintProject(dest.root);
    const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
    const check = plan.compatibility.checks.find((c) => c.id === 'source.verification');
    assert.equal(check.status, 'ok');
    assert.equal(harvestPolicy('VERIFIED').label, 'Verified in source');
    assert.equal(execFileSync('git', ['-C', src.root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'verification must not dirty the source repository');
    assert.equal(manifest.provenance.verifiedInSource.sourceState.changedDuringVerification, false);
  } finally { src.cleanup(); dest.cleanup(); }
});

test('a source that changes its own tree while running is recorded as such, not as pristine', async () => {
  const src = makeSource();
  try {
    patchFile(src.root, 'server.js', "'use strict';", "'use strict';\nrequire('node:fs').writeFileSync(require('node:path').join(__dirname, 'runtime-artifact.txt'), 'x');");
    const { manifest, verification } = await harvestCapability(fingerprintProject(src.root), 'authentication', FAST);
    assert.equal(verification.verdict, 'VERIFIED');
    const state = manifest.provenance.verifiedInSource.sourceState;
    assert.equal(state.changedDuringVerification, true);
    assert.match(state.marker, /\+changed-during-verification$/);
    // The patch itself makes the tree dirty before boot (1 file); the run adds another.
    // The BEFORE state is what is recorded as primary, and the delta is what proves it changed.
    assert.equal(state.dirtyFileCount, 1);
    assert.equal(state.after.dirtyFileCount, 2);
  } finally { src.cleanup(); }
});

test('an entrypoint that looks like a node option is refused, not executed', () => {
  const src = makeSource();
  try {
    fs.writeFileSync(path.join(src.root, '--inspect-brk=0.0.0.0:9229'), 'process.exit(0)\n');
    patchFile(src.root, 'package.json', '"main": "server.js"', '"main": "--inspect-brk=0.0.0.0:9229"');
    patchFile(src.root, 'package.json', '"start": "node server.js"', '"start": "node --inspect-brk=0.0.0.0:9229"');
    const fp = fingerprintProject(src.root);
    const rt = resolveRuntime(fp);
    assert.equal(rt.ok, false);
    assert.match(rt.reason, /command-line option|not a plain/);
  } finally { src.cleanup(); }
});

test('an entrypoint that resolves outside the project is refused', () => {
  const src = makeSource();
  try {
    fs.writeFileSync(path.join(src.work, 'outside.js'), 'process.exit(0)\n');
    patchFile(src.root, 'package.json', '"main": "server.js"', '"main": "../outside.js"');
    patchFile(src.root, 'package.json', '"start": "node server.js"', '"start": "node ../outside.js"');
    const rt = resolveRuntime(fingerprintProject(src.root));
    assert.equal(rt.ok, false);
    assert.match(rt.reason, /outside the project/);
  } finally { src.cleanup(); }
});
