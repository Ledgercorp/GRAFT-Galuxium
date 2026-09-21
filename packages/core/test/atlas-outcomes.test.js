// Compatibility Atlas 1.1.0 — evidence-bound entries, and transplantation outcomes from the
// Laboratory's execution record: successes, failures and attempts that never reached verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { buildEngineArtifacts } from '../src/engine/index.js';
import { stableHash } from '../src/capability/contract.js';
import { ATLAS_VERSION, buildAtlasEntry, validateAtlasEntry, recordAtlasEntry, loadAtlas, queryAtlas } from '../src/engine/atlas.js';
import { createHost, saveExecution } from '../src/laboratory/execution.js';
import { buildAssemblyOutcomes, recordAssemblyOutcomes } from '../src/laboratory/atlas-outcomes.js';
import { SOURCE_FIXTURE } from './helpers.js';
import { sourceRevisionOf } from '../src/verify/proof-envelope.js';

const manifest = harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');
const engine = buildEngineArtifacts(manifest);
const organ = () => ({ manifest, engine });
const ARCH = { runtime: { family: 'node', range: null }, framework: 'node-http', moduleSystem: 'esm', handlerContract: 'central-handler', persistence: 'unknown', dependencies: [] };
const HEX40 = 'a'.repeat(40), HEX64 = 'b'.repeat(64);
const base = { capabilityId: engine.genome.identity.capabilityId, capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: engine.genome.provenance.sourceArchitecture, destinationArchitecture: ARCH, adaptations: ['esm-node-http-central'], result: 'supported', at: '2026-09-14T00:00:00.000Z' };

function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-atlas-out-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
/** A created host plus the plan and execution skeleton the single-capability runner would leave behind. */
function assembly(work, { status, steps, error = null, verification = null, transplantPlan = null, proof = null, assembledRevision = null, extra = {} }) {
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const receipt = createHost({ parentDir: parent, name: `app-${Math.random().toString(16).slice(2, 8)}`, architectureId: 'node-esm-http-central' });
  const plan = { planId: 'plan-x-000000-abcdef', host: { profile: 'esm-node-http-central' }, steps: [{ stepId: 's1', type: 'CREATE_HOST' }, { stepId: 's2', type: 'TRANSPLANT_CAPABILITY', profile: 'esm-node-http-central', capability: { capabilityId: engine.genome.identity.capabilityId, slug: manifest.identity.slug, kind: 'session-auth' } }, { stepId: 's3', type: 'VERIFY_CAPABILITY' }] };
  const execution = { executionId: 'exec-x-000000-abcdef', status, finalState: status, finishedAt: '2026-09-14T01:00:00.000Z', steps, error, verification, transplantPlan, proof, assembledRevision,
    createdProject: { root: receipt.root, name: receipt.projectName, initialCommit: receipt.initialCommit }, receipts: [receipt], reindex: null, worktree: null, ...extra };
  return { plan, execution, receipt };
}

test('1.1.0 entries bind their evidence, refuse malformed bindings and a COMPLETED outcome without proof; 1.0.0 entries remain valid knowledge', (t) => {
  const dir = path.join(sandbox(t), 'atlas');
  const bound = buildAtlasEntry({ ...base, verification: { verdict: 'VERIFIED', summary: { required: 6, passed: 6 } }, sourceRevision: HEX40, destinationRevision: 'c'.repeat(40), proofEnvelopeDigest: HEX64, assumptions: [{ id: 'source.verification', status: 'ok', title: 'dropped' }], assembly: { finalState: 'COMPLETED' } });
  assert.equal(bound.atlasVersion, ATLAS_VERSION);
  assert.deepEqual(validateAtlasEntry(bound), { ok: true, errors: [] });
  assert.deepEqual(bound.assumptions, [{ id: 'source.verification', status: 'ok' }], 'only id and status travel; titles are free text');
  assert.deepEqual(bound.assembly, { finalState: 'COMPLETED', failedStep: null, errorCode: null });
  // Every binding is covered by the entry id: a swapped revision or proof digest is detected.
  for (const [field, value] of [['at', '2026-09-15T00:00:00.000Z'], ['sourceRevision', 'd'.repeat(40)], ['destinationRevision', null], ['proofEnvelopeDigest', 'e'.repeat(64)], ['assumptions', [{ id: 'source.verification', status: 'block' }]], ['assembly', { finalState: 'FAILED', failedStep: null, errorCode: null }]]) {
    assert.equal(validateAtlasEntry({ ...bound, [field]: value }).ok, false, `${field} is bound by the entry id`);
  }
  for (const [field, value] of [['sourceRevision', 'abc'], ['destinationRevision', 'HEAD'], ['proofEnvelopeDigest', 'sha256:x'], ['assumptions', [{ id: 'x' }]], ['assumptions', [{ id: 'x', status: 'maybe' }]], ['assembly', { finalState: 'DONE', failedStep: null, errorCode: null }], ['assembly', { finalState: 'FAILED', failedStep: '/tmp/x', errorCode: null }]]) {
    const built = buildAtlasEntry({ ...base, [field]: value });
    assert.equal(validateAtlasEntry(built).ok, false, `${field}=${JSON.stringify(value)} is refused`);
  }
  // A COMPLETED assembly is a claim of a verified, committed, proven state; nothing less validates.
  assert.equal(validateAtlasEntry(buildAtlasEntry({ ...base, verification: { verdict: 'VERIFIED' }, assembly: { finalState: 'COMPLETED' } })).ok, false, 'COMPLETED without revision and proof');
  assert.equal(validateAtlasEntry(buildAtlasEntry({ ...base, verification: { verdict: 'FAILED' }, destinationRevision: HEX40, proofEnvelopeDigest: HEX64, assembly: { finalState: 'COMPLETED' } })).ok, false, 'COMPLETED without VERIFIED');
  // An entry with no evidence bindings is still a valid observation (a dirty-tree verification).
  const unbound = buildAtlasEntry({ ...base, verification: { verdict: 'FAILED' }, failureReasons: ['auth.login:failed'] });
  assert.deepEqual([unbound.sourceRevision, unbound.destinationRevision, unbound.proofEnvelopeDigest, unbound.assumptions, unbound.assembly], [null, null, null, null, null]);
  assert.equal(validateAtlasEntry(unbound).ok, true);
  // A 1.0.0 entry written by an earlier GRAFT: its id was computed over the 1.0.0 field set, and it loads unchanged.
  const legacy = { atlasVersion: '1.0.0', capabilityId: base.capabilityId, capabilityCategory: 'authentication', capabilityKind: 'session-auth', genomeId: null, sourceArchitecture: base.sourceArchitecture, destinationArchitecture: ARCH, hostId: null, adaptations: ['esm-return-response'], recipeId: null, result: 'conditionally-supported', verification: { verdict: 'VERIFIED', summary: null, at: '2026-09-01T00:00:00.000Z' }, failureReasons: [], repair: null, confidence: { basis: 'observed', sampleSize: 1, relevance: 1 }, at: '2026-09-01T00:00:00.000Z' };
  legacy.entryId = stableHash({ atlasVersion: '1.0.0', capabilityId: legacy.capabilityId, sourceArchitecture: legacy.sourceArchitecture, destinationArchitecture: legacy.destinationArchitecture, hostId: null, adaptations: legacy.adaptations, recipeId: null, result: legacy.result, verification: legacy.verification, failureReasons: [], repair: null });
  assert.deepEqual(validateAtlasEntry(legacy), { ok: true, errors: [] });
  recordAtlasEntry(legacy, { directory: dir }); recordAtlasEntry(bound, { directory: dir }); recordAtlasEntry(unbound, { directory: dir });
  assert.deepEqual(loadAtlas({ directory: dir }).map((e) => e.atlasVersion).sort(), ['1.0.0', '1.1.0', '1.1.0']);
  // Ranking is unchanged by the new fields: the same query answers over old and new entries alike.
  const q = queryAtlas({ capabilityCategory: 'authentication', sourceArchitecture: base.sourceArchitecture, destinationArchitecture: ARCH, directory: dir });
  assert.equal(q.considered, 3); assert.deepEqual(q.verdicts, { VERIFIED: 2, FAILED: 1, NEEDS_REVIEW: 0, unverified: 0 });
});

test('a COMPLETED single-capability assembly becomes one bound observation: revision, proof digest, assumptions, adaptations', (t) => {
  const work = sandbox(t);
  const { plan, execution } = assembly(work, { status: 'COMPLETED', steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'DONE' }, { type: 'VERIFY_CAPABILITY', status: 'DONE' }],
    verification: { capability: manifest.identity.slug, capabilityId: engine.genome.identity.capabilityId, verdict: 'VERIFIED', summary: { required: 6, passed: 6, failed: 0 }, outcomes: [{ id: 'auth.login', outcome: 'passed' }], providerDouble: null },
    transplantPlan: { profile: 'esm-node-http-central', recipe: null, recipeId: 'recipe-1', checks: [{ id: 'source.verification', status: 'ok' }, { id: 'data.persistence', status: 'warn' }] },
    proof: { envelopeSchema: 'graft-proof-envelope/1', envelopeDigest: HEX64, revision: HEX40 }, assembledRevision: HEX40, extra: { reindex: { hostId: 'sha256:host' } } });
  const { entries, skipped } = buildAssemblyOutcomes({ execution, plan, organ });
  assert.deepEqual(skipped, []); assert.equal(entries.length, 1);
  const [e] = entries;
  assert.deepEqual(validateAtlasEntry(e), { ok: true, errors: [] });
  assert.equal(e.capabilityId, engine.genome.identity.capabilityId); assert.equal(e.genomeId, engine.genome.genomeId); assert.equal(e.capabilityKind, 'session-auth');
  assert.deepEqual(e.sourceArchitecture, engine.genome.provenance.sourceArchitecture);
  assert.equal(e.destinationArchitecture.framework, 'node-http'); assert.equal(e.hostId, 'sha256:host');
  assert.deepEqual([e.destinationRevision, e.proofEnvelopeDigest, e.recipeId], [HEX40, HEX64, 'recipe-1']);
  assert.equal(e.sourceRevision, sourceRevisionOf(manifest), 'the source revision is the one the harvest recorded (the head of a clean checkout), or null');
  assert.match(e.sourceRevision, /^[0-9a-f]{40}$/, 'the fixture lives in a clean checkout, so the revision is bound');
  assert.deepEqual(e.assumptions, [{ id: 'source.verification', status: 'ok' }, { id: 'data.persistence', status: 'warn' }]);
  assert.equal(e.result, 'conditionally-supported', 'a warning in the plan makes the result conditional, as the planner itself says');
  assert.deepEqual(e.verification, { verdict: 'VERIFIED', summary: { required: 6, passed: 6, failed: 0 }, at: '2026-09-14T01:00:00.000Z' });
  assert.deepEqual(e.failureReasons, []); assert.deepEqual(e.assembly, { finalState: 'COMPLETED', failedStep: null, errorCode: null });
  assert.deepEqual(e.adaptations, ['esm-node-http-central']);
  assert.equal(e.confidence.basis, 'observed');
  // Recorded once, idempotently, and the execution names the entry.
  const first = recordAssemblyOutcomes({ execution, plan, organ });
  assert.deepEqual(first.errors, []); assert.deepEqual(first.entries.map((x) => x.entryId), [e.entryId]);
  recordAssemblyOutcomes({ execution, plan, organ });
  assert.equal(loadAtlas().length, 1);
  assert.deepEqual(execution.atlas.entries[0], { capabilityId: e.capabilityId, entryId: e.entryId, result: 'conditionally-supported', verdict: 'VERIFIED' });
  const text = JSON.stringify(loadAtlas());
  assert.equal(text.includes(execution.createdProject.root), false); assert.equal(text.includes(os.homedir()), false); assert.equal(text.includes(manifest.identity.sourceProject), false, 'no project name');
  // At most once per execution. A failure AFTER the first recording (persistence, the dogfood
  // event) sends the runner through its failure exit, which rewrites the execution FAILED and
  // records again: the first observation stands, no contradictory second one is written, and the
  // execution's Atlas metadata is exactly what the first recording left.
  const recordedBefore = structuredClone(execution.atlas);
  Object.assign(execution, { status: 'FAILED', finalState: 'FAILED', finishedAt: '2026-09-14T01:00:05.000Z', error: { code: 'execution-privacy', message: 'persist failed after recording' }, steps: [...execution.steps, { type: 'FINAL_VERIFICATION', status: 'FAILED' }] });
  const second = recordAssemblyOutcomes({ execution, plan, organ });
  assert.deepEqual(second, recordedBefore); assert.deepEqual(execution.atlas, recordedBefore);
  assert.equal(loadAtlas().length, 1, 'one execution, one terminal observation');
  assert.deepEqual(loadAtlas()[0].assembly, { finalState: 'COMPLETED', failedStep: null, errorCode: null });
});

test('a FAILED verification keeps its own failed cases; an attempt that never reached verification is recorded as a refusal with the reason it ended', (t) => {
  const work = sandbox(t);
  const failed = assembly(work, { status: 'FAILED', steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'DONE' }, { type: 'VERIFY_CAPABILITY', status: 'FAILED' }, { type: 'REINDEX_HOST', status: 'SKIPPED' }], error: { code: 'verdict', message: 'Verification reported FAILED' },
    verification: { capability: manifest.identity.slug, capabilityId: engine.genome.identity.capabilityId, verdict: 'FAILED', summary: { required: 6, passed: 5, failed: 1 }, outcomes: [{ id: 'auth.login', outcome: 'passed' }, { id: 'auth.logout', outcome: 'failed' }], providerDouble: null },
    transplantPlan: { profile: 'esm-node-http-central', checks: [{ id: 'source.verification', status: 'ok' }] }, assembledRevision: HEX40 });
  const [f] = buildAssemblyOutcomes({ ...failed, organ }).entries;
  assert.deepEqual(validateAtlasEntry(f), { ok: true, errors: [] });
  assert.deepEqual([f.result, f.verification.verdict, f.failureReasons], ['supported', 'FAILED', ['auth.logout:failed']]);
  assert.deepEqual([f.destinationRevision, f.proofEnvelopeDigest], [null, null], 'a failed attempt has no proven revision, whatever was committed');
  assert.deepEqual(f.assembly, { finalState: 'FAILED', failedStep: 'VERIFY_CAPABILITY', errorCode: 'verdict' });

  const blocked = assembly(work, { status: 'BLOCKED', steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'FAILED' }, { type: 'VERIFY_CAPABILITY', status: 'SKIPPED' }], error: { code: 'capability-identity-changed', message: 'The banked capability is not the one the plan selected' } });
  const [b] = buildAssemblyOutcomes({ ...blocked, organ }).entries;
  assert.deepEqual(validateAtlasEntry(b), { ok: true, errors: [] });
  assert.deepEqual([b.result, b.verification, b.failureReasons, b.assumptions, b.confidence.basis], ['refused', null, ['assembly:capability-identity-changed'], null, 'static']);
  assert.deepEqual(b.assembly, { finalState: 'BLOCKED', failedStep: 'TRANSPLANT_CAPABILITY', errorCode: 'capability-identity-changed' });
  assert.deepEqual(b.adaptations, ['esm-node-http-central'], 'the planned profile is still the adaptation that was attempted');
  recordAssemblyOutcomes({ ...failed, organ }); recordAssemblyOutcomes({ ...blocked, organ });
  assert.equal(loadAtlas().length, 2, 'failures do not disappear');
  // Two identical refusals at different times are two attempts, not one replay: the observation
  // time is part of a 1.1.0 identity, so the second neither collides nor is dropped.
  const later = assembly(work, { status: 'BLOCKED', steps: blocked.execution.steps, error: blocked.execution.error });
  later.execution.createdProject = blocked.execution.createdProject; later.execution.receipts = blocked.execution.receipts; later.execution.finishedAt = '2026-09-14T02:00:00.000Z';
  const again = recordAssemblyOutcomes({ ...later, organ });
  assert.deepEqual(again.errors, []); assert.equal(again.entries.length, 1); assert.notEqual(again.entries[0].entryId, b.entryId);
  assert.equal(loadAtlas().length, 3, 'a repeated attempt is a separate observation');
  assert.equal(recordAssemblyOutcomes({ ...later, organ }).errors.length, 0, 'the same attempt recorded again is an idempotent replay');
  assert.equal(loadAtlas().length, 3);
  // The failure is descriptive evidence in the same query the planner consults.
  const q = queryAtlas({ capabilityCategory: 'authentication', sourceArchitecture: engine.genome.provenance.sourceArchitecture, destinationArchitecture: f.destinationArchitecture });
  assert.equal(q.observations, 3); assert.equal(q.refused, 2); assert.deepEqual(q.failureReasons.map((r) => [r.reason, r.count]).sort(), [['assembly:capability-identity-changed', 2], ['auth.logout:failed', 1]]);
  assert.equal(q.verdicts.VERIFIED, 0, 'refusals and failures never corroborate a success');
});

test('nothing is recorded for a non-terminal execution or one that never created a host; an unreadable organ is skipped and reported, never invented', (t) => {
  const work = sandbox(t);
  const running = assembly(work, { status: 'VERIFYING', steps: [] });
  assert.deepEqual(buildAssemblyOutcomes({ ...running, organ }), { entries: [], skipped: ['the execution is not terminal'] });
  const hostless = assembly(work, { status: 'FAILED', steps: [{ type: 'CREATE_HOST', status: 'FAILED' }], error: { code: 'target-exists', message: 'exists' } });
  hostless.execution.createdProject = null; hostless.execution.receipts = [];
  assert.deepEqual(buildAssemblyOutcomes({ ...hostless, organ }), { entries: [], skipped: ['no destination exists for this execution'] });
  const gone = assembly(work, { status: 'FAILED', steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'FAILED' }], error: { code: 'preconditions', message: 'x' } });
  const result = recordAssemblyOutcomes({ ...gone, organ: () => { throw new Error(`Organ-bank package is busy: ${path.join(process.env.GRAFT_HOME, 'organ-bank/authentication.graft')}`); } });
  assert.deepEqual(result.entries, []); assert.deepEqual(result.skipped, ['authentication: Organ-bank package is busy: $GRAFT_HOME/organ-bank/authentication.graft']); assert.deepEqual(result.errors, []);
  assert.equal(loadAtlas().length, 0);
  // The reasons live on the execution record, so they must be storable there: no GRAFT_HOME path.
  gone.execution.schemaVersion = '1.0.0';
  assert.doesNotThrow(() => saveExecution({ ...gone.execution, executionId: 'exec-gone-000000-abcdef' }));
});
