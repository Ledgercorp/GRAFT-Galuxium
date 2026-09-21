import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { readManifest } from '../src/manifest/io.js';
import { harvestCapability } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { sanitize, repositoryIdentity, planSummary, reportSummary, openDogfoodSession, nullRecorder, recorderFromEnvironment, annotate, scorecard, listDogfoodSessions, readEvents, OBSERVATION_TAGS, FINAL_STATES } from '../src/dogfood/index.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-dogfood-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sanitize strips source text, payloads and secret-looking strings but keeps structure', () => {
  const clean = sanitize({
    path: 'src/auth/routes.js', contents: 'export const secret = 1;', before: 'a', after: 'b', edits: [{ line: 1 }], steps: [{ body: 'x' }],
    nested: { source: 'const x = 1;\nconst y = 2;', reason: 'kept', dimension: { source: 'esm', destination: 'cjs' }, token: 'Bearer abcdefghijklmnop', key: 'sk_test_ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
    fn: () => 1, list: [{ contents: 'c' }, 'plain'], digest: 'sha256:' + 'ab'.repeat(32), sha: 'f6c0b7b41fefa08413487978c91ae01aae6849a1', base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm',
  });
  assert.deepEqual(Object.keys(clean).sort(), ['afterDigest', 'base64', 'beforeDigest', 'contentsDigest', 'digest', 'editsCount', 'list', 'nested', 'path', 'sha', 'stepsCount']);
  assert.equal(clean.digest, 'sha256:' + 'ab'.repeat(32));
  assert.equal(clean.sha, 'f6c0b7b41fefa08413487978c91ae01aae6849a1');
  assert.equal(clean.base64, '[redacted]');
  assert.equal(clean.contentsDigest.bytes, 24);
  assert.match(clean.contentsDigest.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(clean.editsCount, 1);
  assert.deepEqual(Object.keys(clean.nested).sort(), ['dimension', 'key', 'reason', 'sourceDigest', 'token']);
  assert.deepEqual(clean.nested.dimension, { source: 'esm', destination: 'cjs' });
  assert.equal(clean.nested.token, '[redacted]');
  assert.equal(clean.nested.key, '[redacted]');
  assert.deepEqual(clean.list, [{ contentsDigest: clean.list[0].contentsDigest }, 'plain']);
  assert.equal(JSON.stringify(clean).includes('export const secret'), false);
});

test('repository identity and plan/report summaries carry no source text', async () => {
  const sourceFp = fingerprintProject(path.join(fixtures, 'old-saas-project'));
  const destFp = fingerprintProject(path.join(fixtures, 'new-startup'));
  const identity = repositoryIdentity(destFp);
  assert.equal(identity.name, destFp.name);
  assert.equal(typeof identity.rootHash, 'string');
  assert.match(identity.structureHash, /^sha256:/);
  assert.equal(identity.architecture.framework, destFp.framework.value);
  assert.equal(identity.shape.files, destFp.files.length);
  const { manifest } = await harvestCapability(sourceFp, 'authentication', { verifySource: false });
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
  const summary = planSummary(plan);
  assert.equal(summary.status, plan.status);
  assert.equal(summary.genome.genomeId, plan.engine.genome.genomeId);
  assert.equal(summary.host.hostId, plan.engine.host.hostId);
  assert.equal(summary.recipe.recipeId, plan.engine.recipe.recipeId);
  assert.ok(summary.files.length > 0);
  assert.ok(summary.files.every((f) => typeof f.path === 'string' && Number.isInteger(f.bytes) && !('contents' in f)));
  const generated = plan.files[0].contents.split('\n').find((line) => line.trim().length > 20);
  const serialized = JSON.stringify(sanitize({ identity, summary }));
  assert.equal(serialized.includes(generated), false);
  for (const file of destFp.files.filter((f) => f.endsWith('.js'))) {
    const text = destFp.readFile(file) || '';
    const line = text.split('\n').find((l) => l.trim().length > 30);
    if (line) assert.equal(serialized.includes(line), false, `${file} leaked`);
  }
  assert.equal(reportSummary(null), null);
  const report = reportSummary({ verdict: 'FAILED', rationale: 'r', summary: { passed: 0 }, results: [{ id: 'a', outcome: 'failed', required: true, reason: 'x', steps: [{ body: 'secret body' }] }], proof: { contractId: 'c', summary: {}, invariants: [] } });
  assert.deepEqual(report.results, [{ id: 'a', outcome: 'failed', required: true, provesBehavior: null, reason: 'x' }]);
  assert.equal(JSON.stringify(report).includes('secret body'), false);
});

test('a session records events locally with restrictive modes, annotations are validated, and the scorecard counts what was recorded', (t) => {
  const directory = path.join(tempDir(t), 'dogfood');
  assert.throws(() => openDogfoodSession('../escape', { directory }), /session names/);
  const recorder = openDogfoodSession('trial-1', { directory, context: { surface: 'test', contents: 'never stored' } });
  assert.equal(recorder.session, 'trial-1');
  const meta = JSON.parse(fs.readFileSync(path.join(directory, 'trial-1', 'session.json'), 'utf8'));
  assert.equal(meta.telemetry, false);
  assert.equal(meta.uploads, 'never');
  assert.equal(meta.contents, undefined);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, 'trial-1')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, 'trial-1', 'session.json')).mode & 0o777, 0o600);
  }
  recorder.event('harvest', { capability: 'authentication', kind: 'authentication', banked: true, report: { verdict: 'VERIFIED' } }, { stage: 'harvest', elapsedMs: 12.5 });
  recorder.event('plan', { capability: 'authentication', plan: { planId: 'p1', status: 'ready', compatibility: { status: 'conditionally-supported' }, recipe: { name: 'r' }, host: { hostId: 'sha256:x', profile: 'esm-return-response', architecture: { framework: 'unknown', moduleSystem: 'esm' }, existingCapabilities: [] }, analysis: { unknowns: ['u'] }, atlasUsed: { observations: 2 } } }, { stage: 'plan', elapsedMs: 3 });
  recorder.event('apply', { planId: 'p1', branch: 'graft/x', report: { verdict: 'FAILED', rationale: 'one required test failed', results: [{ id: 'a', outcome: 'failed', required: true }, { id: 'b', outcome: 'passed', required: true }], proof: { invariants: [], routeCoverage: [] }, atlasEntry: { entryId: 'sha256:e' } },
    repair: { attempts: [{ attempt: 1, class: 'missing-route-registration', repaired: false }], initialVerdict: 'FAILED' } }, { stage: 'apply', elapsedMs: 100, intervention: true });
  recorder.error('verify', Object.assign(new Error('refused'), { status: 409 }));
  // A later plan (e.g. after reopening, when the transplant already exists) must not replace the applied plan in the scorecard.
  recorder.event('plan', { capability: 'authentication', plan: { planId: 'p2', status: 'blocked', compatibility: { status: 'blocked' }, host: { hostId: 'sha256:y', profile: null, architecture: {}, existingCapabilities: [{ id: 'authentication' }] }, analysis: { unknowns: [] } } }, { stage: 'plan', elapsedMs: 1 });
  assert.throws(() => annotate('trial-1', { tag: 'NOT_A_TAG', text: 'x', directory }), /tag must be one of/);
  assert.throws(() => annotate('trial-1', { tag: 'UX_FRICTION', stage: 'nowhere', text: 'x', directory }), /stage must be one of/);
  assert.throws(() => annotate('trial-1', { tag: 'UX_FRICTION', text: '', directory }), /short description/);
  assert.throws(() => annotate('trial-1', { tag: 'UX_FRICTION', text: 'x', ref: -1, directory }), /positive event sequence/);
  for (const tag of OBSERVATION_TAGS) annotate('trial-1', { tag, stage: 'apply', text: `${tag} observed`, ref: 3, directory });
  annotate('trial-1', { tag: 'UX_FRICTION', stage: 'rollback', text: 'had to use git in the Terminal', terminal: true, intervention: true, directory });
  annotate('trial-1', { tag: 'VERIFICATION_GAP', stage: 'verify', text: 'false VERIFIED: passed although the cookie was missing', directory });
  const events = readEvents(path.join(directory, 'trial-1'));
  assert.equal(events[0].type, 'session.open');
  assert.equal(events.at(-1).seq, events.length);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'trial-1', 'events.jsonl')).mode & 0o777, 0o600);
  const card = scorecard('trial-1', { directory });
  assert.equal(card.transplant.finalState, 'FAIL');
  assert.equal(card.transplant.finalVerdict, 'FAILED');
  assert.equal(card.capabilityRecognition.recognized, 1);
  assert.deepEqual(card.hostModel.unknownDimensions, ['framework']);
  assert.equal(card.hostModel.hostId, 'sha256:x');
  assert.equal(card.compatibilityPrediction.plans, 2);
  assert.equal(card.compatibilityPrediction.agreement, false);
  assert.equal(card.manualIntervention.count, 2);
  assert.equal(card.terminalUse.count, 1);
  assert.equal(card.repair.attempts, 1);
  assert.equal(card.repair.repaired, 0);
  assert.equal(card.verificationCoverage.failed, 1);
  assert.deepEqual(card.atlas, { used: [2, 0], generated: ['sha256:e'] });
  assert.equal(card.counts.engineDefects, 1);
  assert.equal(card.counts.uxFriction, 2);
  assert.equal(card.counts.verificationGaps, 2);
  assert.equal(card.counts.errors, 1);
  assert.equal(card.counts.refusals, 1);
  assert.equal(card.falseVerified, 1);
  assert.equal(card.missedMutations, 0);
  assert.deepEqual(card.elapsedByStage, { harvest: 12.5, plan: 4, apply: 100 });
  // Reopening appends after the last sequence number rather than restarting it.
  const again = openDogfoodSession('trial-1', { directory });
  assert.equal(again.sequence, events.length + 1);
  const sessions = listDogfoodSessions({ directory });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session, 'trial-1');
  assert.throws(() => scorecard('missing', { directory }), /no dogfood session/);
  for (const name of ['../trial-1', 'a/b', '', '.x']) assert.throws(() => scorecard(name, { directory }), /session names/);
});

test('without a session nothing is recorded anywhere', async (t) => {
  const home = tempDir(t);
  const previous = process.env.GRAFT_HOME, previousSession = process.env.GRAFT_DOGFOOD;
  process.env.GRAFT_HOME = home;
  delete process.env.GRAFT_DOGFOOD;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; if (previousSession !== undefined) process.env.GRAFT_DOGFOOD = previousSession; });
  const recorder = recorderFromEnvironment();
  assert.equal(recorder.session, null);
  assert.equal(recorder.event('x', {}), null);
  assert.equal(await recorder.timed('x', 'other', async () => 42), 42);
  await assert.rejects(recorder.timed('x', 'other', async () => { throw new Error('through'); }), /through/);
  assert.equal(nullRecorder().error('other', new Error('e')), null);
  assert.equal(fs.existsSync(path.join(home, 'dogfood')), false);
  assert.deepEqual(listDogfoodSessions(), []);
  process.env.GRAFT_DOGFOOD = 'describe-session';
  const describing = recorderFromEnvironment();
  assert.equal(await describing.timed('x', 'other', async () => 7, () => { throw new Error('summary broke'); }), 7);
  assert.equal(readEvents(path.join(home, 'dogfood', 'describe-session')).at(-1).data.describeError, 'summary broke');
  delete process.env.GRAFT_DOGFOOD;
  process.env.GRAFT_DOGFOOD = 'env-session';
  const fromEnv = recorderFromEnvironment({ surface: 'test' });
  assert.equal(fromEnv.session, 'env-session');
  assert.ok(fs.existsSync(path.join(home, 'dogfood', 'env-session', 'events.jsonl')));
});

test('final state distinguishes success, failure, inconclusive, safe refusal and no attempt', (t) => {
  const directory = path.join(tempDir(t), 'dogfood');
  const state = (name, build) => { const r = openDogfoodSession(name, { directory }); build(r); return scorecard(name, { directory }).transplant; };
  const verdictReport = (verdict) => ({ verdict, rationale: 'r', summary: {}, results: [], proof: null });

  // The exact Phase 1 shape: discovery only, one correct EXPECTED_REFUSAL note, no pipeline events.
  const phase1 = state('phase1', (r) => {
    r.event('observation', { tag: 'SUCCESS', text: 'discovery complete' }, { stage: 'review' });
    r.event('observation', { tag: 'EXPECTED_REFUSAL', text: 'no capability claimed in four repositories' }, { stage: 'harvest' });
    r.event('observation', { tag: 'MISSING_ENGINE_CAPABILITY', text: 'entrypoint detection is filename-bound' }, { stage: 'register' });
  });
  assert.equal(phase1.finalState, 'NO_TRANSPLANT_ATTEMPTED');
  assert.match(phase1.finalStateReason, /no harvest, plan, apply or verify/);
  assert.equal(phase1.finalVerdict, null);

  // A refusal the engine actually issued, with nothing written.
  const refused = state('refused', (r) => {
    r.event('plan', { capability: 'authentication', plan: { planId: 'p', status: 'blocked' } }, { stage: 'plan' });
    r.event('apply.refused', { planId: 'p', problems: [{ id: 'dirty-working-tree' }] }, { stage: 'apply' });
  });
  assert.equal(refused.finalState, 'SAFE_REFUSAL');
  assert.deepEqual(refused.refusals.length, 1);

  // A 409 from the product is a refusal, not a failure.
  const conflict = state('conflict', (r) => {
    r.event('harvest', { capability: 'authentication' }, { stage: 'harvest' });
    r.error('apply', Object.assign(new Error('The destination has uncommitted changes.'), { status: 409 }));
  });
  assert.equal(conflict.finalState, 'SAFE_REFUSAL');

  // An operator-tagged expected refusal counts only once the pipeline was actually asked.
  const taggedRefusal = state('tagged', (r) => {
    r.event('harvest', { capability: 'authentication', banked: false }, { stage: 'harvest' });
    r.event('observation', { tag: 'EXPECTED_REFUSAL', text: 'source was not harvestable' }, { stage: 'harvest' });
  });
  assert.equal(taggedRefusal.finalState, 'SAFE_REFUSAL');

  // A genuine crash before verification is a failure.
  const crashed = state('crashed', (r) => {
    r.event('plan', { capability: 'authentication', plan: { planId: 'p', status: 'ready' } }, { stage: 'plan' });
    r.error('apply', new Error('ENOSPC: no space left on device'));
  });
  assert.equal(crashed.finalState, 'FAIL');

  // Files written and never verified is unproven, not successful.
  const unverified = state('unverified', (r) => r.event('apply', { planId: 'p', branch: 'graft/x', filesWritten: ['src/auth/routes.js'] }, { stage: 'apply' }));
  assert.equal(unverified.finalState, 'INCONCLUSIVE');
  assert.match(unverified.finalStateReason, /no verification was recorded/);

  for (const [verdict, expected] of [['VERIFIED', 'SUCCESS'], ['FAILED', 'FAIL'], ['NEEDS_REVIEW', 'INCONCLUSIVE']]) {
    const card = state(`verdict-${verdict}`, (r) => r.event('verify', { capability: 'authentication', report: verdictReport(verdict) }, { stage: 'verify' }));
    assert.equal(card.finalState, expected, verdict);
    assert.equal(card.finalVerdict, verdict);
  }
  // A refusal recorded alongside a real VERIFIED verdict never downgrades the verdict, and an
  // EXPECTED_REFUSAL note can never manufacture SUCCESS.
  const mixed = state('mixed', (r) => {
    r.error('plan', Object.assign(new Error('stale preview'), { status: 409 }));
    r.event('verify', { capability: 'authentication', report: verdictReport('VERIFIED') }, { stage: 'verify' });
  });
  assert.equal(mixed.finalState, 'SUCCESS');
  const fakeSuccess = state('fake-success', (r) => {
    r.event('harvest', { capability: 'authentication' }, { stage: 'harvest' });
    r.event('observation', { tag: 'SUCCESS', text: 'it definitely worked' }, { stage: 'verify' });
  });
  assert.equal(fakeSuccess.finalState, 'INCONCLUSIVE');
  assert.equal(fakeSuccess.finalVerdict, null);
  for (const name of ['phase1', 'refused', 'conflict', 'tagged', 'crashed', 'unverified', 'mixed', 'fake-success']) {
    assert.ok(FINAL_STATES.includes(scorecard(name, { directory }).transplant.finalState));
  }
});
