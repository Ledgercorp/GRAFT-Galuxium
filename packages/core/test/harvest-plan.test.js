import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { discoverCapabilities, harvest } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { profileFor } from '../src/emit/session-auth.js';
import { SOURCE_FIXTURE, DEST_FIXTURE } from './helpers.js';

const srcFp = fingerprintProject(SOURCE_FIXTURE);
const destFp = fingerprintProject(DEST_FIXTURE);
const manifest = harvest(srcFp, 'authentication');

test('the source and destination really are different architectures', () => {
  assert.equal(srcFp.moduleSystem.value, 'cjs');
  assert.equal(srcFp.handlerContract.value, 'node-res');
  assert.equal(destFp.moduleSystem.value, 'esm');
  assert.equal(destFp.handlerContract.value, 'return-response');
});

test('capabilities are discovered with evidence, and non-harvestable ones say so', () => {
  const caps = discoverCapabilities(srcFp);
  const auth = caps.find((c) => c.id === 'authentication');
  assert.ok(auth);
  assert.equal(auth.harvestable, true);
  assert.equal(auth.confidence, 'high');
  assert.ok(auth.signals.every((s) => s.evidence), 'every signal must carry evidence');

  const uploads = caps.find((c) => c.id === 'file-uploads');
  assert.equal(uploads.harvestable, false);
  assert.ok(uploads.notHarvestableReason);
});

test('harvesting a capability with no emitter is refused rather than half-done', () => {
  assert.throws(() => harvest(srcFp, 'file-uploads'), /not harvestable/);
});

test('harvesting an absent capability is refused', () => {
  assert.throws(() => harvest(srcFp, 'billing'), /was not found/);
});

test('the manifest preserves the behavioral contract, not the source files', () => {
  const model = manifest.architecture.capabilityModel;
  assert.equal(model.passwordHash.algorithm, 'scrypt');
  assert.equal(model.session.transport, 'cookie');
  assert.equal(model.session.httpOnly, true);
  assert.equal(model.guard.unauthenticatedStatus, 401);
  // The source map is evidence for a human, not the transplant payload.
  assert.ok(manifest.sourceMap.files.length > 0);
  assert.ok(manifest.sourceMap.files.every((f) => f.sha256));
});

test('provenance records that no AI was involved in this harvest', () => {
  assert.equal(manifest.provenance.method, 'static-analysis');
  assert.equal(manifest.provenance.aiAssisted, false);
  // A static harvest is not allowed to claim it saw the capability work.
  const vis = manifest.provenance.verifiedInSource;
  assert.equal(vis.verdict, 'NEEDS_REVIEW');
  assert.equal(vis.skipped, true);
  assert.equal(vis.tests.length, 0);
});

test('the plan regenerates the capability in the destination idiom', () => {
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
  assert.equal(plan.adaptation.profile, 'esm-return-response');
  assert.equal(plan.adaptation.usesSharedStore, true, 'it must use the destination store, not invent a second one');

  const routes = plan.files.find((f) => f.path.endsWith('routes.js')).contents;
  assert.match(routes, /^import /m, 'emitted code must be ESM, like the destination');
  assert.doesNotMatch(routes, /require\(/, 'no CommonJS may leak in from the source');
  assert.doesNotMatch(routes, /res\.writeHead/, 'no node-res handler idiom may leak in from the source');
  assert.match(routes, /return \{ status: 401, body: \{ error: 'invalid_credentials' \} \}/);

  const adapter = plan.files.find((f) => f.path.endsWith('store-adapter.js')).contents;
  assert.match(adapter, /from ['"]\.\.\/store\.js['"]/);
});

test('the emitted cookie and hash parameters match the harvested contract exactly', () => {
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
  const sessions = plan.files.find((f) => f.path.endsWith('sessions.js')).contents;
  assert.match(sessions, new RegExp(`COOKIE_NAME = ['"]${manifest.architecture.capabilityModel.session.cookieName}['"]`));
  assert.match(sessions, /HttpOnly/);
  const passwords = plan.files.find((f) => f.path.endsWith('passwords.js')).contents;
  assert.match(passwords, new RegExp(`KEY_LENGTH = ${manifest.architecture.capabilityModel.passwordHash.keyLength}`));
  assert.match(passwords, /timingSafeEqual/);
});

test('a route collision is reported, and blocks the plan until explicitly resolved', () => {
  const plan = createTransplantPlan(manifest, destFp);
  assert.equal(plan.status, 'needs-resolution');
  assert.deepEqual(plan.compatibility.collisions, ['POST /auth/login']);
  const resolved = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
  assert.equal(resolved.status, 'ready');
});

test('an unsupported destination architecture is blocked, not guessed at', () => {
  const alien = { ...destFp, moduleSystem: { value: 'cjs' }, handlerContract: { value: 'node-res' } };
  assert.equal(profileFor(alien), null);
  const plan = createTransplantPlan(manifest, alien, { resolveConflicts: true });
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.files.length, 0, 'no code may be emitted for an architecture GRAFT cannot write');
  assert.match(plan.adaptation.refusal, /no emitter can write a session-auth capability/);
  assert.ok(plan.compatibility.blocking.some((b) => b.id === 'architecture.profile'));
});

test('the plan carries a brief an external coding agent could act on', () => {
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
  assert.ok(plan.agentBrief.behaviorContract.length > 0);
  assert.ok(plan.agentBrief.constraints.some((c) => /Do not copy files/.test(c)));
  assert.match(plan.agentBrief.verdictOwnedBy, /not a verdict/);
  assert.equal(plan.agentBrief.acceptanceCriteria.length, manifest.acceptanceTests.tests.length);
});
