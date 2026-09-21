// Library Host Adaptation 0.1b — Checkpoint B: the deterministic product machinery.
//
// Checkpoint A proved the adaptation operation. This proves the planner opens for exactly the
// shape that was proven and stays shut for everything else, that execution re-establishes support
// instead of trusting the plan, and that the failure paths never produce a ledger entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest, readManifest } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { createBlueprint, addGoal, analyseBlueprint, selectImplementation } from '../src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification, STEP_TYPES } from '../src/laboratory/assembly.js';
import { runLibraryAdaptation, recheckLibraryAdaptationSupport, librarySourceRoot } from '../src/laboratory/library-assembly.js';
import { recordAssembledCapability, createAssemblyWorkspace, capabilityPresence, evaluateWorkspace, commitAssembledState } from '../src/laboratory/continuity.js';
import { prepareTransplant } from '../src/apply/worktree.js';
import { createHost } from '../src/laboratory/execution.js';
import { storedProofFor } from './helpers/proof.js';
import { buildEngineArtifacts } from '../src/engine/index.js';
import { sourceRevisionOf } from '../src/verify/proof-envelope.js';
import { verifyAdaptedLibraryCapability } from '../src/adapt/verify.js';
import { storeProof, loadProofArtifact, exportProofArtifact, proofArtifactPath } from '../src/laboratory/proof-store.js';
import { verifyProofEnvelope, verifyProofFile } from '../../proof-adapter/src/index.js';
/** Proof Integrity 0.1: a CURRENT record cites a durable proof of the verification at its revision. */
const prove = (execution, revision) => ({ ...execution, proof: storedProofFor({ revision, capability: { slug: execution.verification?.capability || 'capability' } }) });

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const haveSwivel = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js'));
const needSwivel = { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' };
const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
const HTTP_HOST = () => newHostSpecification('node-esm-http-central');

function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-libasm-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
/** Bank the real library and a blueprint that selects it. */
async function bankedLibraryBlueprint(work, { category = 'feature-flags', source = SWIVEL, capability = 'feature-flags-library' } = {}) {
  const { manifest } = await harvestCapability(fingerprintProject(source), capability);
  writeManifest(bankDir(), manifest);
  const bp = createBlueprint({ name: 'Flagged application', description: 'features can be turned on per context', hostIntent: 'new-application' });
  const goal = addGoal(bp, { category });
  const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const organ = a.goals[0].candidates.find((c) => c.kind === 'organ');
  assert.ok(organ, `no organ candidate for ${category}: ${JSON.stringify(a.goals[0].candidates)}`);
  selectImplementation(bp, goal.goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
  return { bp, manifest, organ, goalId: goal.goalId };
}

// ---------------------------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------------------------
test('the planner opens for the proven library shape and describes it honestly', needSwivel, async (t) => {
  const work = sandbox(t);
  const { bp } = await bankedLibraryBlueprint(work);
  const plan = buildAssemblyPlan(bp, { host: HTTP_HOST(), index: EMPTY_INDEX });
  assert.equal(plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(plan.blockers));
  assert.deepEqual(plan.steps.map((s) => s.type), ['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'VERIFY_SOURCE_ARTIFACT_IDENTITY', 'ADAPT_LIBRARY_CAPABILITY', 'VERIFY_CAPABILITY', 'CHECK_HOST_PRESERVATION', 'REINDEX_HOST', 'FINAL_VERIFICATION']);
  assert.ok(plan.steps.every((s) => STEP_TYPES.includes(s.type) && s.what && s.why && s.supported === true && s.operation));
  // The capability is never called a transplant, and the plan claims no install, build or route.
  assert.equal(plan.steps.some((s) => s.type === 'TRANSPLANT_CAPABILITY'), false);
  const adapt = plan.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY');
  assert.match(adapt.what, /carry the verified library artifact across unchanged and generate an adapter/);
  assert.deepEqual(adapt.integration, { method: 'vendored-commonjs-artifact-with-generated-esm-adapter', adaptation: 'feature-flags-library-into-esm-node-http-central',
    artifact: 'dist/swivel.js', adapter: 'src/feature-flags.js', hostProfile: 'esm-node-http-central', generatedBy: 'GRAFT', installsPackage: false, buildsAnything: false, registersRoutes: false });
  const wording = plan.steps.map((s) => s.what).join(' | ');
  for (const forbidden of [/register.{0,10}route/i, /install/i, /copy the service/i, /transplant/i]) assert.equal(forbidden.test(wording), false, `plan wording must not say ${forbidden}`);
  // Each executable step names the real operation, and the adaptation names the Checkpoint A module.
  assert.equal(adapt.operation.module, 'adapt/library-host');
  assert.equal(adapt.operation.function, 'adaptLibraryCapability → applyLibraryAdaptation (isolated worktree)');
  assert.equal(adapt.operation.exists, true);
  const identity = plan.steps.find((s) => s.type === 'VERIFY_SOURCE_ARTIFACT_IDENTITY');
  assert.equal(identity.operation.function, 'checkArtifactIdentity');
  assert.equal(identity.artifact.recordedSha256.length, 16);
  // The destination contract is named by its real size, not asserted as the source's.
  assert.match(plan.steps.find((s) => s.type === 'VERIFY_CAPABILITY').what, /destination contract against the generated adapter inside the host \(10 case\(s\)\)/);
});

test('the planner refuses every library/host combination that was not proven', needSwivel, async (t) => {
  const work = sandbox(t);
  const { bp } = await bankedLibraryBlueprint(work);
  // An Express host has no proven library adaptation, even though the capability is VERIFIED.
  const express = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-express'), index: EMPTY_INDEX });
  assert.equal(express.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  assert.match(express.blockers.map((b) => b.detail).join(' '), /no proven adaptation writes feature-flags in library form into the express-req-res host/);
  // A host that has not been chosen is NEEDS_HOST, not a false READY and not a capability blocker.
  assert.equal(buildAssemblyPlan(bp, { host: null, index: EMPTY_INDEX }).readiness, 'NEEDS_HOST');

  // Source VERIFIED never implies destination support: prove the source really is VERIFIED here.
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  assert.equal(manifest.provenance.verifiedInSource.verdict, 'VERIFIED');
  assert.equal(manifest.provenance.verifiedInSource.summary.passed, 8);

  // Degrade the banked capability's structure, one fact at a time; each must close the planner.
  const organDir = path.join(bankDir(), 'feature-flags-library.graft');
  // Changing the capability's structure can change its capability id, which would make the
  // blueprint's own selection stale and block the plan earlier for a different reason. Re-selecting
  // keeps the blueprint ready, so what is being asserted really is the capability-support decision.
  const degrade = (mutate) => {
    const m = readManifest(organDir);
    mutate(m);
    writeManifest(bankDir(), m);
    const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
    const organ = a.goals[0].candidates.find((c) => c.kind === 'organ');
    if (organ) selectImplementation(bp, bp.goals[0].goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
    return buildAssemblyPlan(bp, { host: HTTP_HOST(), index: EMPTY_INDEX });
  };
  const cases = [
    ['a missing recorded artifact identity', (m) => { m.sourceMap.files = m.sourceMap.files.filter((f) => f.role !== 'library-artifact'); }, /recorded no identity/],
    ['a missing operation role', (m) => { m.architecture.capabilityModel.operations = m.architecture.capabilityModel.operations.filter((o) => o.role !== 'invoke-branch'); }, /invoke-branch/],
    ['a different configuration shape', (m) => { m.architecture.capabilityModel.configuration.contextShape = 'user-attributes'; }, /configuration shape differs/],
    ['an artifact that is not committed', (m) => { m.architecture.capabilityModel.artifact.committed = false; }, /not committed/],
    ['an ESM artifact, whose interop was never measured', (m) => { m.architecture.capabilityModel.artifact.moduleSystem = 'esm'; }, /adaptation handles commonjs/],
  ];
  for (const [label, mutate, expected] of cases) {
    const plan = degrade(mutate);
    assert.equal(plan.readiness, 'BLOCKED_CAPABILITY_SUPPORT', `${label} must block the planner`);
    assert.match(plan.blockers.map((b) => b.detail).join(' '), expected, label);
    // Restore for the next case, and re-select so the blueprint is ready again.
    const { manifest: fresh } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
    writeManifest(bankDir(), fresh);
    const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
    const organ = a.goals[0].candidates.find((c) => c.kind === 'organ');
    selectImplementation(bp, bp.goals[0].goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
  }
  assert.equal(buildAssemblyPlan(bp, { host: HTTP_HOST(), index: EMPTY_INDEX }).readiness, 'READY_TO_ASSEMBLE', 'the restored capability is supported again');
});

test('a library capability whose source checkout has gone is not executable', needSwivel, async (t) => {
  const work = sandbox(t);
  // Harvest from a copy, then remove it: the artifact's bytes live in the source, not the organ.
  const copy = path.join(work, 'swivel-copy');
  fs.cpSync(SWIVEL, copy, { recursive: true, filter: (f) => path.basename(f) !== 'node_modules' });
  const { bp } = await bankedLibraryBlueprint(work, { source: copy });
  assert.equal(buildAssemblyPlan(bp, { host: HTTP_HOST(), index: EMPTY_INDEX }).readiness, 'READY_TO_ASSEMBLE');
  fs.rmSync(copy, { recursive: true, force: true });
  const gone = buildAssemblyPlan(bp, { host: HTTP_HOST(), index: EMPTY_INDEX });
  assert.equal(gone.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  assert.match(gone.blockers.map((b) => b.detail).join(' '), /no longer reachable/);
  assert.throws(() => librarySourceRoot(readManifest(path.join(bankDir(), 'feature-flags-library.graft'))), (e) => e.code === 'library-source-missing');
});

test('service-form feature flags keep the existing transplant path, untouched', async (t) => {
  const work = sandbox(t);
  const src = path.join(work, 'config-service');
  fs.cpSync(path.join(repoRoot, 'fixtures/config-service'), src, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
  const { bp } = await bankedLibraryBlueprint(work, { source: src, capability: 'feature-flags' });
  const manifest = readManifest(path.join(bankDir(), 'feature-flags.graft'));
  assert.equal(manifest.identity.implementationForm, 'service');
  // The service form goes to an Express host through the emitter, exactly as it always did.
  const plan = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-express'), index: EMPTY_INDEX });
  assert.ok(plan.steps.some((s) => s.type === 'TRANSPLANT_CAPABILITY'), 'a service is still transplanted');
  assert.equal(plan.steps.some((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY'), false, 'a service never takes the library adaptation path');
  assert.equal(plan.steps.find((s) => s.type === 'TRANSPLANT_CAPABILITY').operation.module, 'plan + apply');
});

// ---------------------------------------------------------------------------------------------
// Execution-time support recheck
// ---------------------------------------------------------------------------------------------
const HOST_FP = { profile: 'esm-node-http-central', moduleSystem: 'esm', framework: 'node-http', handlerContract: 'node-res' };

test('execution re-establishes support instead of trusting the plan', needSwivel, async (t) => {
  const work = sandbox(t);
  const { bp } = await bankedLibraryBlueprint(work);
  const plan = buildAssemblyPlan(bp, { host: HTTP_HOST(), index: EMPTY_INDEX });
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  const engine = { genome: { identity: { capabilityId: plan.expectedCapabilities[0].capabilityId } } };
  const planned = plan.expectedCapabilities[0].capabilityId;

  const ok = recheckLibraryAdaptationSupport({ plan, manifest, engine, hostFingerprint: HOST_FP, plannedCapabilityId: planned });
  assert.equal(ok.ok, true, ok.reasons.join('; '));

  // The host that exists is not the host that was planned: STALE, before anything is written.
  const drifted = recheckLibraryAdaptationSupport({ plan, manifest, engine, hostFingerprint: { ...HOST_FP, profile: 'express-req-res' }, plannedCapabilityId: planned });
  assert.equal(drifted.ok, false);
  assert.ok(drifted.stale.length > 0, 'a host that changed shape is stale, not merely unsupported');
  assert.match(drifted.stale.join(' '), /the plan was made for esm-node-http-central/);

  // The banked capability is not the one the plan selected.
  const swapped = recheckLibraryAdaptationSupport({ plan, manifest, engine: { genome: { identity: { capabilityId: 'cap:other' } } }, hostFingerprint: HOST_FP, plannedCapabilityId: planned });
  assert.equal(swapped.ok, false);
  assert.match(swapped.stale.join(' '), /not the .* the plan selected/);

  // The capability is no longer a library.
  const asService = structuredClone(manifest); asService.identity.implementationForm = 'service';
  const formChanged = recheckLibraryAdaptationSupport({ plan, manifest: asService, engine, hostFingerprint: HOST_FP, plannedCapabilityId: planned });
  assert.equal(formChanged.ok, false);
  assert.match(formChanged.blocked.join(' '), /not a library/);

  // Source verification is no longer an authoritative VERIFIED.
  for (const verdict of ['FAILED', 'NEEDS_REVIEW', null]) {
    const weakened = structuredClone(manifest);
    if (verdict === null) delete weakened.provenance.verifiedInSource; else weakened.provenance.verifiedInSource.verdict = verdict;
    const r = recheckLibraryAdaptationSupport({ plan, manifest: weakened, engine, hostFingerprint: HOST_FP, plannedCapabilityId: planned });
    assert.equal(r.ok, false, `source verification ${verdict} must not be adapted`);
    assert.match(r.blocked.join(' '), /only a VERIFIED capability is adapted/);
  }
});

// ---------------------------------------------------------------------------------------------
// The execution sequence itself
// ---------------------------------------------------------------------------------------------
/** A created host of the proven shape, and a candidate worktree cut from it. */
function hostAndWorktree(work, name = 'flag-host') {
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const receipt = createHost({ parentDir: parent, name, architectureId: 'node-esm-http-central' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: receipt.root, encoding: 'utf8' }).trim();
  const t = prepareTransplant({ destinationRoot: receipt.root, sourceRoot: SWIVEL, capabilitySlug: 'feature-flags-library', fromRevision: head });
  return { receipt, head, transplant: t, worktree: t.worktree.path };
}

test('the execution sequence adapts, verifies, preserves the host and re-indexes honestly', needSwivel, async (t) => {
  const work = sandbox(t);
  await bankedLibraryBlueprint(work);
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  const { receipt, head, worktree } = hostAndWorktree(work);
  const phases = [];
  const outcome = await runLibraryAdaptation({ manifest, sourceRoot: librarySourceRoot(manifest), worktreePath: worktree, host: HOST_FP, onPhase: (p) => phases.push(p) });

  assert.equal(outcome.admitted, true);
  // Baseline first — the host's real answers, recorded before a single file was written.
  assert.equal(outcome.baseline.captured, true);
  const byPath = new Map(outcome.baseline.observed.map((o) => [o.path, o.status]));
  assert.equal(byPath.get('/'), 200);
  assert.equal(byPath.get('/health'), 200);
  assert.equal(byPath.get('/%2e%2e/%2e%2e/%2e%2e/etc/passwd'), 404);
  assert.ok(phases.indexOf('Recording the host’s own behaviour') < phases.indexOf('Checking the verified artifact'), 'the baseline is taken before the artifact is even read');

  assert.equal(outcome.identity.matched, true);
  assert.equal(outcome.identity.byteIdentical, true);
  assert.deepEqual(outcome.filesWritten, ['vendor/swivel.cjs', 'vendor/swivel.LICENSE', 'vendor/swivel.provenance.json', 'src/feature-flags.js']);
  assert.equal(outcome.verification.verdict, 'VERIFIED', outcome.verification.rationale);
  assert.equal(outcome.verification.summary.required, 10);
  assert.equal(outcome.verification.proofOf, 'destination-adaptation');
  assert.equal(outcome.preservation.failed, 0);
  assert.equal(outcome.preservation.verdict, 'VERIFIED');

  // The re-index tells the truth: the detectors recognise nothing, and the host shape is intact.
  assert.equal(outcome.reindex.detectorObservation, 'NOT_OBSERVED');
  assert.equal(outcome.reindex.capabilityObserved, false);
  assert.deepEqual(outcome.reindex.observedCapabilities, []);
  assert.match(outcome.reindex.detectorNote, /they look for a standalone library package/);
  assert.equal(outcome.reindex.profile, 'esm-node-http-central');
  assert.equal(outcome.reindex.hostShapePreserved, true);

  // Only the worktree changed.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: receipt.root, encoding: 'utf8' }).trim(), '');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: receipt.root, encoding: 'utf8' }).trim(), head);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: SWIVEL, encoding: 'utf8' }).trim(), '', 'the library checkout is untouched');
});

test('an artifact that changed after planning is refused at execution, with nothing written', needSwivel, async (t) => {
  const work = sandbox(t);
  // Harvest from a copy so the artifact can be changed without touching the real checkout.
  const copy = path.join(work, 'swivel-copy');
  fs.cpSync(SWIVEL, copy, { recursive: true, filter: (f) => path.basename(f) !== 'node_modules' });
  await bankedLibraryBlueprint(work, { source: copy });
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  const { worktree } = hostAndWorktree(work);
  // The source artifact drifts after the plan was made.
  fs.appendFileSync(path.join(copy, 'dist/swivel.js'), '\n// changed after planning\n');

  const outcome = await runLibraryAdaptation({ manifest, sourceRoot: copy, worktreePath: worktree, host: HOST_FP });
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.stage, 'artifact-identity');
  assert.equal(outcome.reason, 'artifact-identity-mismatch');
  assert.equal(outcome.verification, null, 'nothing was verified, because nothing was adapted');
  assert.deepEqual(outcome.filesWritten, []);
  assert.equal(fs.existsSync(path.join(worktree, 'vendor')), false);
  assert.equal(fs.existsSync(path.join(worktree, 'src')), false);
  // The baseline was still captured first, so the refusal is recorded against real host behaviour.
  assert.equal(outcome.baseline.captured, true);
});

test('a failed or unprovable destination never becomes a ledger entry', needSwivel, async (t) => {
  const work = sandbox(t);
  await bankedLibraryBlueprint(work);
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  const sourceRoot = librarySourceRoot(manifest);

  // FAILED: the adapter answers wrongly.
  const broken = hostAndWorktree(work, 'failing-host');
  let outcome = await runLibraryAdaptation({ manifest, sourceRoot, worktreePath: broken.worktree, host: HOST_FP });
  assert.equal(outcome.verification.verdict, 'VERIFIED');
  const adapter = path.join(broken.worktree, 'src/feature-flags.js');
  fs.writeFileSync(adapter, fs.readFileSync(adapter, 'utf8').replace('returnValue(featureName, true, false) === true', 'returnValue(featureName, true, false) !== true'));
  const { verifyAdaptedLibraryCapability } = await import('../src/adapt/verify.js');
  const failed = await verifyAdaptedLibraryCapability({ plan: outcome.adaptation, destinationRoot: broken.worktree });
  assert.equal(failed.verdict, 'FAILED');
  assert.throws(() => recordAssembledCapability(ledgerShell(failed, 'COMPLETED'), { execution: executionFor(failed, 'COMPLETED'), revisionBefore: 'a', revisionAfter: 'b' }), (e) => e.code === 'not-verified');

  // NEEDS_REVIEW: the artifact cannot be loaded, so nothing was observed.
  fs.writeFileSync(path.join(broken.worktree, 'vendor/swivel.cjs'), 'not javascript (((\n');
  const review = await verifyAdaptedLibraryCapability({ plan: outcome.adaptation, destinationRoot: broken.worktree });
  assert.equal(review.verdict, 'NEEDS_REVIEW');
  assert.throws(() => recordAssembledCapability(ledgerShell(review, 'COMPLETED'), { execution: executionFor(review, 'COMPLETED'), revisionBefore: 'a', revisionAfter: 'b' }), (e) => e.code === 'not-verified');

  // Host preservation failure: a VERIFIED capability still does not enter the ledger.
  const execution = executionFor({ verdict: 'VERIFIED', summary: { required: 10, passed: 10 } }, 'COMPLETED');
  execution.hostPreservation = { captured: true, tests: 2, passed: 1, failed: 1 };
  assert.throws(() => recordAssembledCapability(ledgerShell({ verdict: 'VERIFIED' }, 'COMPLETED'), { execution, revisionBefore: 'a', revisionAfter: 'b' }), (e) => e.code === 'host-preservation-failed');

  // And an execution that did not complete cannot record anything either.
  assert.throws(() => recordAssembledCapability(ledgerShell({ verdict: 'VERIFIED' }, 'FAILED'), { execution: executionFor({ verdict: 'VERIFIED' }, 'FAILED'), revisionBefore: 'a', revisionAfter: 'b' }), (e) => e.code === 'execution-not-completed');
});
/** The smallest execution/workspace shapes the ledger guard reads. */
function executionFor(verification, status) {
  return { executionId: 'exec-x-000000', status, verification: { capability: 'feature-flags-library', capabilityId: 'cap:x', verdict: verification.verdict, summary: verification.summary || null },
    steps: [{ type: 'ADAPT_LIBRARY_CAPABILITY', outcome: { filesWritten: [] }, finishedAt: '2026-01-01T00:00:00.000Z' }],
    capabilitySource: { kind: 'feature-flags', implementationForm: 'library' }, hostPreservation: { captured: true, tests: 2, passed: 2, failed: 0 }, proofReferences: [], transplantId: 't1' };
}
const ledgerShell = () => ({ capabilities: [], currentRevision: null, updatedAt: null });

// ---------------------------------------------------------------------------------------------
// Presence authority and revision binding
// ---------------------------------------------------------------------------------------------
test('a preservation run with no captured baseline proves nothing and is refused', needSwivel, async (t) => {
  const work = sandbox(t);
  await bankedLibraryBlueprint(work);
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  const { worktree } = hostAndWorktree(work, 'unbootable-host');
  // A host that cannot start: the baseline cannot be recorded, so the probes keep their generic
  // expectations and a pass would mean nothing. This is the 0.4a false-result shape.
  const server = path.join(worktree, 'server.mjs');
  fs.writeFileSync(server, "throw new Error('this host cannot start');\n");
  const outcome = await runLibraryAdaptation({ manifest, sourceRoot: librarySourceRoot(manifest), worktreePath: worktree, host: HOST_FP });
  assert.equal(outcome.baseline.captured, false);
  assert.equal(outcome.admitted, false, 'an uncaptured baseline must never be admitted');
  assert.equal(outcome.stage, 'host-preservation-baseline');
  assert.equal(outcome.reason, 'baseline-not-captured');
  // And the ledger refuses it too, even though the capability itself verified.
  assert.equal(outcome.verification.verdict, 'VERIFIED', 'the library still works; the host is what could not be observed');
  const execution = executionFor({ verdict: 'VERIFIED', summary: { required: 10, passed: 10 } }, 'COMPLETED');
  execution.hostPreservation = { captured: false, reason: outcome.baseline.reason, tests: 2, passed: 2, failed: 0 };
  assert.throws(() => recordAssembledCapability(ledgerShell(), { execution, revisionBefore: 'a', revisionAfter: 'b' }), (e) => e.code === 'host-preservation-not-captured');
});

test('presence comes from assembly evidence, stays separate from the detector, and goes STALE on drift', needSwivel, async (t) => {
  const work = sandbox(t);
  await bankedLibraryBlueprint(work);
  const manifest = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  const { receipt, head, worktree } = hostAndWorktree(work);
  const outcome = await runLibraryAdaptation({ manifest, sourceRoot: librarySourceRoot(manifest), worktreePath: worktree, host: HOST_FP });
  assert.equal(outcome.admitted, true);

  const execution = { executionId: 'exec-flagged-000001', planId: 'plan-x', blueprintId: 'flagged', status: 'COMPLETED',
    verification: { capability: 'feature-flags-library', capabilityId: 'cap:flags', verdict: outcome.verification.verdict, summary: outcome.verification.summary },
    hostPreservation: { captured: true, tests: outcome.preservation.tests, passed: outcome.preservation.passed, failed: 0 },
    capabilitySource: { kind: 'feature-flags', implementationForm: 'library', sourceVerification: { verdict: 'VERIFIED', summary: { required: 8, passed: 8 } } },
    adaptation: { id: outcome.adaptation.adaptation, method: outcome.adaptation.method, artifact: outcome.adaptation.artifactIdentity.destinationPath, artifactSha256: outcome.adaptation.artifactIdentity.sha256,
      adapter: outcome.adaptation.verifyThrough.entry, hostProfile: 'esm-node-http-central', destinationContract: { cases: 10, passed: 10, verdict: 'VERIFIED' },
      licence: { declared: 'MIT' }, upstream: { repository: outcome.adaptation.provenance.source.repository, revision: outcome.adaptation.provenance.source.revision }, detectorObservation: 'NOT_OBSERVED' },
    steps: [{ type: 'ADAPT_LIBRARY_CAPABILITY', outcome: { filesWritten: outcome.filesWritten }, finishedAt: '2026-01-01T00:00:00.000Z' }],
    proofReferences: [], transplantId: 't1' };

  const committed = commitAssembledState(worktree, { capability: 'Feature flags' });
  // PROOF INTEGRITY 0.1 (real Swivel): the durable proof is the verification OF THE COMMITTED
  // revision, with the identities this assembly already holds threaded in — the donor checkout
  // revision the manifest recorded at source verification, and the organ's genome/IR ids.
  const engine = buildEngineArtifacts(manifest);
  const provenance = { sourceRevision: sourceRevisionOf(manifest), capabilityId: engine.genome.identity.capabilityId, genomeId: engine.genome.genomeId, irId: engine.ir.irId };
  const proven = await verifyAdaptedLibraryCapability({ plan: outcome.adaptation, destinationRoot: worktree, provenance });
  assert.equal(proven.verdict, 'VERIFIED'); assert.deepEqual([proven.summary.required, proven.summary.passed], [10, 10]);
  const envelope = proven.proofEnvelope;
  assert.ok(envelope, proven.proofEnvelopeReason); assert.deepEqual(verifyProofEnvelope(envelope), { intact: true, reasons: [] });
  assert.equal(envelope.payload.destination.revision, committed.revision);
  assert.equal(envelope.payload.source.revision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847', 'the donor revision is bound because the manifest recorded a clean source head');
  assert.deepEqual(envelope.payload.capability, { id: engine.genome.identity.capabilityId, slug: 'feature-flags-library', kind: engine.genome.identity.kind, form: 'library', genomeId: engine.genome.genomeId, irId: engine.ir.irId });
  assert.deepEqual(envelope.payload.destination.adaptation, { id: outcome.adaptation.adaptation, artifactSha256: outcome.adaptation.artifactIdentity.sha256 });
  const stored = storeProof(envelope); assert.equal(stored.stored, true);
  const reloaded = loadProofArtifact(envelope.digest); assert.equal(reloaded.intact, true); assert.equal(reloaded.envelope.digest, envelope.digest);
  execution.proof = { envelopeSchema: envelope.schema, envelopeDigest: envelope.digest };
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: { name: receipt.projectName, repositoryId: 'repo:flags' }, baseRevision: head, workingBranch: 'graft/feature-flags-library', primaryBranch: 'main', worktreePath: worktree, primaryRoot: receipt.root, hostId: receipt.fingerprint.hostId });
  const record = recordAssembledCapability(workspace, { execution, revisionBefore: head, revisionAfter: committed.revision });

  assert.equal(record.state, 'CURRENT');
  assert.equal(record.proofReference.envelopeDigest, envelope.digest, 'the ledger references the exact stored proof'); assert.equal(record.proofReference.envelopeSchema, 'graft-proof-envelope/1');
  assert.equal(record.destinationRevisionAfter, committed.revision);
  assert.equal(record.implementationForm, 'library');
  // The ledger keeps how it got here, and both proofs, without merging them.
  assert.equal(record.adaptation.id, 'feature-flags-library-into-esm-node-http-central');
  assert.equal(record.adaptation.artifactSha256, `sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8`);
  assert.equal(record.adaptation.licence.declared, 'MIT');
  assert.match(record.adaptation.upstream.repository, /zumba\/swiveljs/);
  assert.equal(record.adaptation.upstream.revision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847');
  assert.equal(record.adaptation.detectorObservation, 'NOT_OBSERVED');
  assert.deepEqual(record.sourceVerification, { verdict: 'VERIFIED', summary: { required: 8, passed: 8 } }, 'the source proof is 8/8');
  assert.deepEqual(record.adaptation.destinationContract, { cases: 10, passed: 10, verdict: 'VERIFIED' }, 'the destination proof is 10/10');
  assert.equal(record.verificationSummary.required, 10);
  // No invented combined score anywhere in the record.
  assert.equal(/"required":\s*18|18\/18/.test(JSON.stringify(record)), false);

  // Presence: GRAFT's own evidence says present; the detector honestly says it sees nothing.
  const [presence] = capabilityPresence(workspace, { detected: [] });
  assert.equal(presence.presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  assert.equal(presence.independentDetection, 'not observed');
  assert.match(presence.explanation, /does not independently recognize this implementation/);
  assert.equal(presence.assemblyEvidence.verdict, 'VERIFIED');
  assert.equal(presence.assemblyEvidence.revision, committed.revision);

  // Revision drift: the assembly moves without a later authoritative step, so evidence goes STALE.
  fs.writeFileSync(path.join(worktree, 'NOTES.md'), 'a later change nobody verified\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: worktree });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'later change'], { cwd: worktree });
  const drifted = evaluateWorkspace(workspace);
  assert.equal(drifted.capabilities[0].state, 'STALE');
  assert.match(drifted.capabilities[0].stateReason, /with no later authoritative Laboratory step/);
  assert.equal(drifted.status, 'STALE');
  const proofAfterDrift = loadProofArtifact(drifted.capabilities[0].proofReference.envelopeDigest);
  assert.equal(proofAfterDrift.intact, true); assert.equal(proofAfterDrift.envelope.payload.destination.revision, committed.revision, 'the R proof stays intact and still describes R');
  // A detector that still sees nothing does not rescue stale evidence, and does not invalidate it.
  const [after] = capabilityPresence(workspace, { detected: [] });
  assert.equal(after.presence, 'NOT_PRESENT');
  assert.match(after.explanation, /no longer current/);

  // PORTABILITY (Checkpoint C): the exact stored artifact leaves as a file and verifies on its own —
  // no destination checkout, no donor, no GRAFT_HOME, no git — still claiming R, the donor revision
  // and the adaptation/artifact binding; one altered field and it is no longer intact.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-portable-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  const exported = exportProofArtifact(record.proofReference.envelopeDigest, elsewhere);
  assert.equal(Buffer.compare(fs.readFileSync(exported.file), fs.readFileSync(proofArtifactPath(envelope.digest))), 0, 'byte-identical to the stored artifact');
  const portable = path.join(elsewhere, 'copy', 'flags-proof.json'); fs.mkdirSync(path.dirname(portable)); fs.copyFileSync(exported.file, portable);
  fs.rmSync(worktree, { recursive: true, force: true });
  const homeBefore = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(elsewhere, 'no-such-home');
  try {
    const v = verifyProofFile(portable);
    assert.equal(v.intact, true, v.reasons.join('; ')); assert.equal(v.digest, envelope.digest);
    assert.equal(v.claim.destinationRevision, committed.revision); assert.equal(v.claim.sourceRevision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847');
    assert.deepEqual(v.claim.adaptation, { id: outcome.adaptation.adaptation, artifactSha256: outcome.adaptation.artifactIdentity.sha256 });
    assert.deepEqual([v.claim.graftVerdict, v.claim.kernelVerdict, v.claim.capability.slug, v.claim.cases.length], ['VERIFIED', 'PASS', 'feature-flags-library', 10]);
    const tampered = JSON.parse(fs.readFileSync(portable, 'utf8')); tampered.payload.destination.revision = '0'.repeat(40);
    fs.writeFileSync(portable, JSON.stringify(tampered));
    assert.equal(verifyProofFile(portable).intact, false);
  } finally { process.env.GRAFT_HOME = homeBefore; }
});

test('the planner and the execution recheck name no upstream package, repository or revision', () => {
  for (const file of ['../src/laboratory/library-assembly.js', '../src/laboratory/assembly.js']) {
    const source = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    for (const token of ['swiveljs', 'zumba', 'f4d6efd']) assert.equal(new RegExp(token, 'i').test(source), false, `${file} must not mention ${token}`);
  }
  // Support is asked of the adaptation authority, not re-implemented in the planner.
  const planner = fs.readFileSync(fileURLToPath(new URL('../src/laboratory/assembly.js', import.meta.url)), 'utf8');
  assert.match(planner, /libraryHostAdaptationSupport\(\{ manifest, host/);
  assert.equal(/LIBRARY_HOST_ADAPTATIONS\s*\.\s*(find|filter|some)/.test(planner), false, 'the planner does not reach past the authority into the table');
});
