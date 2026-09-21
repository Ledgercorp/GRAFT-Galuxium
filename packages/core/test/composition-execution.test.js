// Real Multi-Capability Composition 0.1 — Checkpoint B: transactional execution, mutual
// re-verification and the atomic ledger transition.
//
// The kernel (`executeCompositionPlan`) is driven by a plan and by injected operations. Everything
// about revisions is real here — a created host, a git worktree cut from it, real commits, a real
// primary checkout that must not move — while verification outcomes are supplied by the test so
// that every failure path can be exercised deterministically. This proves the kernel, not the real
// CUF + SwivelJS composition (Checkpoint C).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inspectRepo } from '../src/apply/git.js';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { createBlueprint, addGoal, analyseBlueprint, selectImplementation } from '../src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification, viewAssemblyPlan } from '../src/laboratory/assembly.js';
import { createHost, createExecution, loadExecution, checkExecutionEligibility } from '../src/laboratory/execution.js';
import { commitAssembledState, evaluateWorkspace, capabilityPresence, checkPromotion, loadAssemblyWorkspace, assembliesDir, commitLedgerTransition, createAssemblyWorkspace } from '../src/laboratory/continuity.js';
import { executeCompositionPlan, plannedCapabilities } from '../src/laboratory/composition.js';
import { revisionAuthority } from '../src/verify/proof-envelope.js';
import { envelopeFor, decidedReport, httpResult, storedProofFor } from './helpers/proof.js';
import { loadProofArtifact, storeProof, proofArtifactPath } from '../src/laboratory/proof-store.js';

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const CUF_ORGAN = path.join(os.homedir(), '.graft/organ-bank/hosted-authentication.graft');
const haveReal = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js')) && fs.existsSync(CUF_ORGAN);
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-cexec-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}

// ---------------------------------------------------------------------------------------------
// A two-capability plan in exactly the shape the planner emits for the real pair (asserted against
// the real planner below when the organs are present): A = a service, B = a library.
// ---------------------------------------------------------------------------------------------
const A = { slug: 'hosted-authentication', capabilityId: 'sha256:capA', genomeId: 'sha256:genomeA', kind: 'hosted-session-auth', name: 'Hosted sign-in' };
const B = { slug: 'feature-flags-library', capabilityId: 'sha256:capB', genomeId: 'sha256:genomeB', kind: 'feature-flags', name: 'Feature flags (SwivelJS)', implementationForm: 'library' };
const PROFILE = 'esm-node-http-central';
function twoCapabilityPlan({ steps = null } = {}) {
  const host = newHostSpecification('node-esm-http-central');
  const shape = steps || [
    ['CREATE_HOST', {}], ['REINDEX_HOST', {}], ['CHECK_DEPENDENCIES', {}],
    ['TRANSPLANT_CAPABILITY', { goalId: 'goal-a', capability: A, profile: PROFILE }], ['VERIFY_CAPABILITY', { goalId: 'goal-a', capability: { slug: A.slug, capabilityId: A.capabilityId, contractId: 'sha256:contractA' } }], ['CHECK_HOST_PRESERVATION', { goalId: 'goal-a' }], ['REINDEX_HOST', {}],
    ['VERIFY_SOURCE_ARTIFACT_IDENTITY', { goalId: 'goal-b', capability: B }], ['ADAPT_LIBRARY_CAPABILITY', { goalId: 'goal-b', capability: B, profile: PROFILE }], ['VERIFY_CAPABILITY', { goalId: 'goal-b', capability: { slug: B.slug, capabilityId: B.capabilityId, contractId: 'sha256:contractB' } }],
    ['REVERIFY_CAPABILITY', { goalId: 'goal-a', capability: { slug: A.slug, capabilityId: A.capabilityId, contractId: 'sha256:contractA' }, alongside: [B.name] }], ['CHECK_HOST_PRESERVATION', {}], ['REINDEX_HOST', {}], ['FINAL_VERIFICATION', {}],
  ];
  return {
    schemaVersion: '1.0.0', planId: 'plan-flagged-portal-000000-abcdef', blueprintId: 'flagged-portal-000000', blueprintName: 'Flagged portal', blueprintRevision: 'sha256:rev', blueprintReadiness: 'READY_FOR_ASSEMBLY_PLANNING', host,
    steps: shape.map(([type, fields], i) => ({ stepId: `step-${String(i + 1).padStart(2, '0')}`, order: i + 1, type, what: type, why: type, operation: { function: type, exists: true }, supported: true, supportReason: 'fixture', ...fields })),
    dependencies: [], order: [{ position: 1, goalId: 'goal-a', label: 'User authentication', implementation: A.name, declaredPosition: 1, decidedBy: 'blueprint-declared-order' }, { position: 2, goalId: 'goal-b', label: 'Feature flags', implementation: B.name, declaredPosition: 2, decidedBy: 'blueprint-declared-order' }],
    ordering: { rule: 'blueprint-declared-order', detail: 'fixture', dependencyEdges: 0 }, edges: [],
    composition: { capabilities: 2, reverified: [A.slug], finalRevisionBindsAll: true },
    evidence: [{ goalId: 'goal-a', capabilityId: A.capabilityId, sourceVerdict: 'VERIFIED' }, { goalId: 'goal-b', capabilityId: B.capabilityId, sourceVerdict: 'VERIFIED' }],
    expectedCapabilities: [{ goalId: 'goal-a', label: 'User authentication', capabilityId: A.capabilityId, name: A.name, kind: A.kind }, { goalId: 'goal-b', label: 'Feature flags', capabilityId: B.capabilityId, name: B.name, kind: B.kind }],
    readiness: 'READY_TO_ASSEMBLE', executable: true, status: 'CURRENT', freshness: { stale: false, reasons: [] },
  };
}

/**
 * Real host, real worktree, real commits, real inspection. Verification, preservation and identity
 * outcomes come from `outcomes`; `hooks` let a test misbehave at a precise moment.
 */
function realOps(work, { outcomes = {}, hooks = {} } = {}) {
  const log = [];
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const fingerprint = () => ({ moduleSystem: 'esm', framework: 'node-http', handlerContract: 'node-res', profile: PROFILE, central: { supported: true, reason: null }, hostId: 'sha256:host' });
  const verdictFor = (slug, phase) => outcomes[`${phase}:${slug}`] || 'VERIFIED';
  const ops = {
    log,
    createHost: async ({ execution }) => {
      log.push('createHost');
      const receipt = createHost({ parentDir: parent, name: `app-${crypto.randomUUID().slice(0, 6)}`, architectureId: 'node-esm-http-central', executionId: execution.executionId, planId: execution.planId });
      ops.primary = receipt.root;
      return { root: receipt.root, projectName: receipt.projectName, branch: receipt.branch, initialCommit: receipt.initialCommit, files: receipt.files, fingerprint: receipt.fingerprint, repositoryIdentity: { name: receipt.projectName }, receipt };
    },
    reindexHost: async ({ root }) => {
      log.push(`reindex:${root === ops.primary ? 'primary' : 'candidate'}`);
      const observed = fs.existsSync(path.join(root, 'src', 'auth')) ? [{ id: 'hosted-authentication', category: 'hosted-authentication', confidence: 'high', harvestable: true }] : [];
      // An embedded library is honestly NOT observed by the detectors; the fixture never pretends otherwise.
      return { ...fingerprint(), ...(hooks.reindex ? hooks.reindex(root) : {}), routes: 2, observedCapabilities: observed, detectorObservation: observed.length ? 'OBSERVED' : 'NOT_OBSERVED' };
    },
    prepareCandidate: async ({ host }) => {
      log.push('prepareCandidate');
      const branch = `graft/composition-${crypto.randomUUID().slice(0, 8)}`;
      const worktreePath = path.join(work, `wt-${crypto.randomUUID().slice(0, 6)}`);
      git(host.root, ['worktree', 'add', '--quiet', '-b', branch, '--', worktreePath, hooks.cutFrom ? hooks.cutFrom(host) : host.initialCommit]);
      ops.candidate = { worktreePath, branch, transplantId: crypto.randomUUID().slice(0, 8), headAtPrepare: inspectRepo(worktreePath).head };
      return ops.candidate;
    },
    captureHostBaseline: async () => { log.push('baseline'); return outcomes.baseline || { captured: true, reason: null, tests: [{ id: 'host.root' }, { id: 'host.health' }, { id: 'host.traversal' }] }; },
    checkArtifactIdentity: async ({ capability }) => { log.push(`identity:${capability.slug}`); return outcomes.identity || { matched: true, expected: 'sha256:art', actual: 'sha256:art', entry: 'dist/swivel.js' }; },
    applyCapability: async ({ candidate, capability }) => {
      log.push(`apply:${capability.slug}`);
      if (outcomes[`apply:${capability.slug}`] === 'throw') throw Object.assign(new Error(`${capability.slug} could not be written`), { code: 'apply-failed' });
      const dir = capability.slug === A.slug ? 'src/auth' : 'src/flags';
      fs.mkdirSync(path.join(candidate.worktreePath, dir), { recursive: true });
      fs.writeFileSync(path.join(candidate.worktreePath, dir, 'index.js'), `export const ${capability.slug.replace(/-/g, '_')} = true;\n`);
      return { filesWritten: [`${dir}/index.js`], capabilitySource: { kind: capability.kind, genomeId: capability.genomeId, irId: null, sourceRevision: 'src-rev', sourceVerification: { verdict: 'VERIFIED' }, implementationForm: capability.implementationForm || 'service' },
        transplantPlan: capability.slug === A.slug ? { planId: 'graft-hosted-authentication-1' } : null, adaptation: capability.slug === B.slug ? { id: 'feature-flags-library-into-esm-node-http-central', method: 'vendored-artifact + generated-adapter', detectorObservation: 'NOT_OBSERVED' } : null, proofReferences: [] };
    },
    verifyCapability: async ({ candidate, capability, phase, alongside }) => {
      log.push(`verify:${phase}:${capability.slug}${alongside.length ? `:after(${alongside.join(',')})` : ''}`);
      if (hooks.onVerify) hooks.onVerify({ candidate, capability, phase });
      const verdict = verdictFor(capability.slug, phase);
      // As the real verifier does: a proof envelope exists only for a verification of a committed, clean tree, bound to that revision.
      const authority = revisionAuthority(candidate.worktreePath);
      const results = [httpResult(`${capability.slug}.a`), httpResult(`${capability.slug}.b`, verdict === 'VERIFIED' ? 'passed' : verdict === 'FAILED' ? 'failed' : 'inconclusive')];
      const proofEnvelope = authority.revision ? envelopeFor({ revision: authority.revision, capability: { slug: capability.slug, kind: capability.kind, id: capability.capabilityId, genomeId: capability.genomeId, form: capability.implementationForm || 'service' }, report: decidedReport(results) }) : null;
      return { proofEnvelope, proofEnvelopeReason: proofEnvelope ? null : 'destination-revision-unavailable', verdict, outcomes: results.map((r) => ({ id: r.id, outcome: r.outcome })), summary: { required: 6, passed: verdict === 'VERIFIED' ? 6 : 4, failed: verdict === 'FAILED' ? 2 : 0 }, rationale: verdict === 'VERIFIED' ? null : `${capability.slug} ${verdict} in fixture`, proofReference: { kind: 'proof', contractId: capability.contractId || null, summary: { cases: 6 } }, invariants: [{ id: 'inv', status: 'held' }], counterfactuals: [{ id: 'cf', outcome: 'passed' }] };
    },
    checkHostPreservation: async ({ candidate, baseline }) => {
      const nth = log.filter((l) => l.startsWith('preservation')).length + 1;
      log.push(`preservation:${nth}`);
      assert.equal(baseline?.captured, true, 'preservation always runs against the captured pre-composition baseline');
      if (outcomes[`preservation:${nth}`] === 'UNOBSERVED') return { captured: true, tests: 0, passed: 0, failed: 0, reason: 'the application did not become ready' };
      const failed = outcomes[`preservation:${nth}`] === 'FAILED' ? 1 : 0;
      return { captured: true, tests: baseline.tests.length, passed: baseline.tests.length - failed, failed };
    },
    commitCandidate: async ({ candidate, capability }) => { log.push(`commit:${capability.slug}`); return commitAssembledState(candidate.worktreePath, { capability: capability.name }); },
    inspectCandidate: async ({ candidate }) => { log.push('inspect'); const r = inspectRepo(candidate.worktreePath); return { head: r.head, dirty: r.dirty }; },
    ...(hooks.persistWorkspace ? { persistWorkspace: hooks.persistWorkspace } : {}),
    ...(hooks.persistProof ? { persistProof: hooks.persistProof } : {}),
  };
  return ops;
}
const run = async (work, { plan = twoCapabilityPlan(), ...rest } = {}) => {
  const ops = realOps(work, rest);
  const execution = createExecution(plan, { destinationParent: path.join(work, 'apps'), projectName: 'flagged-portal' });
  const result = await executeCompositionPlan(execution, plan, ops);
  return { ...result, ops, plan };
};
const primaryUnchanged = (ops) => { const r = inspectRepo(ops.primary); return r.head === git(ops.primary, ['rev-list', '--max-parents=0', 'HEAD']) && !r.dirty && r.branch === 'main'; };
const noLedger = () => !fs.existsSync(assembliesDir()) || fs.readdirSync(assembliesDir()).length === 0;

test('the plan fixture is the shape the eligibility gate admits, and the shape the real planner emits for the real pair', async (t) => {
  sandbox(t);
  const plan = twoCapabilityPlan();
  assert.deepEqual(checkExecutionEligibility(plan), { ok: true, problems: [], capabilities: 2 });
  assert.deepEqual(plannedCapabilities(plan).map((c) => [c.capability.slug, c.form, c.contractId]), [[A.slug, 'service', 'sha256:contractA'], [B.slug, 'library', 'sha256:contractB']]);
  if (!haveReal) { t.diagnostic('real organs absent: the fixture shape is not cross-checked against the real planner here'); return; }
  fs.mkdirSync(bankDir(), { recursive: true });
  fs.cpSync(CUF_ORGAN, path.join(bankDir(), 'hosted-authentication.graft'), { recursive: true });
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
  const bp = createBlueprint({ name: 'Flagged portal', description: 'people sign in, and features can be turned on for some of them', hostIntent: 'new-application' });
  addGoal(bp, { category: 'authentication' }); addGoal(bp, { category: 'feature-flags' });
  for (const g of analyseBlueprint(bp, { index: EMPTY_INDEX }).goals) { const c = g.candidates.find((x) => x.kind === 'organ'); selectImplementation(bp, g.goalId, { kind: 'organ', slug: c.slug, capabilityId: c.capabilityId, name: c.name }); }
  const real = viewAssemblyPlan(buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-http-central'), index: EMPTY_INDEX }), bp, { index: EMPTY_INDEX });
  assert.deepEqual(real.steps.map((s) => s.type), plan.steps.map((s) => s.type), 'the real plan has exactly the fixture\'s step sequence');
  assert.deepEqual(real.steps.map((s) => s.capability?.slug || null), plan.steps.map((s) => s.capability?.slug || null));
  assert.deepEqual(checkExecutionEligibility(real), { ok: true, problems: [], capabilities: 2 });
});

test('MANDATORY SUCCESS: one candidate; A applied, verified, preserved; B applied, verified; A re-verified after B; final preservation, re-index; both CURRENT at one final revision; primary untouched; finalization still explicit', async (t) => {
  const work = sandbox(t);
  const { execution, workspace, promotable, ops, plan } = await run(work);
  assert.equal(promotable, true, JSON.stringify(execution.error));
  assert.equal(execution.status, 'COMPLETED');
  assert.ok(execution.steps.every((s) => s.status === 'DONE'), 'every planned step ran');
  // The transaction, in order, as the operations saw it.
  assert.deepEqual(ops.log, [
    'createHost', 'reindex:primary',
    'prepareCandidate', 'baseline',
    `apply:${A.slug}`, `verify:initial:${A.slug}`, `commit:${A.slug}`, 'preservation:1', 'reindex:candidate',
    `identity:${B.slug}`, `apply:${B.slug}`, `verify:initial:${B.slug}`, `commit:${B.slug}`,
    `verify:reverify:${A.slug}:after(${B.slug})`, 'preservation:2', 'reindex:candidate', 'inspect',
    // Proof Integrity 0.1: B's only verification preceded its own commit, so its durable proof comes
    // from one more verification of the committed final revision, never from the dirty-tree one relabelled.
    `verify:reverify:${B.slug}`,
  ]);
  for (const record of workspace.capabilities) {
    assert.equal(record.proofReference.envelopeSchema, 'graft-proof-envelope/1');
    const stored = loadProofArtifact(record.proofReference.envelopeDigest);
    assert.equal(stored.intact, true, `${record.capability}: the ledger cites a durable, intact proof`);
    assert.equal(stored.envelope.payload.destination.revision, workspace.currentRevision, `${record.capability}: the proof binds the final revision`);
    assert.equal(stored.envelope.payload.capability.slug, record.capability);
  }
  assert.notEqual(workspace.capabilities[0].proofReference.envelopeDigest, workspace.capabilities[1].proofReference.envelopeDigest, 'separate capability proofs stay separate');
  assert.deepEqual(execution.composition.proofs.map((p) => [p.capability, p.revision === workspace.currentRevision]), [[A.slug, true], [B.slug, true]]);
  // One candidate worktree, cut from the created host's initial commit.
  const worktrees = git(ops.primary, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
  assert.equal(worktrees, 2, 'the primary checkout and exactly one composition candidate');
  assert.equal(execution.composition.baseRevision, execution.createdProject.initialCommit);
  // Intermediate A evidence is about the A-only revision; the final revision is B's commit, and both
  // records are bound to THAT — the revision the final verifications actually ran on.
  const finalRevision = inspectRepo(ops.candidate.worktreePath).head;
  const [ra, rb] = workspace.capabilities;
  assert.equal(execution.composition.finalRevision, finalRevision);
  assert.deepEqual(execution.composition.intermediateRevisions.map((r) => r.capability), [A.slug, B.slug]);
  assert.notEqual(ra.appliedRevision, finalRevision, 'A was applied at an intermediate revision');
  assert.equal(rb.appliedRevision, finalRevision);
  assert.equal(ra.destinationRevisionAfter, finalRevision); assert.equal(rb.destinationRevisionAfter, finalRevision);
  assert.equal(ra.currentVerifiedRevision, finalRevision); assert.equal(rb.currentVerifiedRevision, finalRevision);
  assert.equal(ra.destinationRevisionBefore, execution.createdProject.initialCommit); assert.equal(rb.destinationRevisionBefore, execution.createdProject.initialCommit);
  assert.equal(git(ops.candidate.worktreePath, ['rev-parse', `${finalRevision}^`]), ra.appliedRevision, 'the final revision is one commit on top of the A-only revision');
  assert.deepEqual(ra.verificationHistory.map((h) => [h.event, h.revision]), [['applied-and-verified', ra.appliedRevision], ['re-verified-with', finalRevision]]);
  assert.deepEqual(rb.verificationHistory.map((h) => [h.event, h.revision]), [['applied-and-verified', finalRevision], ['proven-at-revision', finalRevision]], 'B: applied and verified before its commit, then proven on the committed final revision');
  assert.deepEqual(execution.composition.reverifications.map((r) => [r.capability, r.alongside, r.verdict, r.revision]), [[A.slug, [B.slug], 'VERIFIED', finalRevision]], 'the proof verification of B is not a re-verification alongside later capabilities');
  assert.deepEqual(execution.composition.proofs.map((p) => [p.capability, p.provenBy]), [[A.slug, 're-verification-after-later-capabilities'], [B.slug, 'verification-of-committed-revision']]);
  // Both CURRENT, together, in the persisted ledger.
  const evaluated = evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId));
  assert.deepEqual(evaluated.capabilities.map((c) => [c.capability, c.state, c.implementationForm]), [[A.slug, 'CURRENT', 'service'], [B.slug, 'CURRENT', 'library']]);
  assert.equal(evaluated.currentRevision, finalRevision);
  assert.equal(evaluated.status, 'ACTIVE');
  // Host preservation: after A and at the end, both against the baseline captured before any write.
  assert.deepEqual([ra.hostPreservation, rb.hostPreservation].map((p) => [p.captured, p.failed, p.revision]), [[true, 0, finalRevision], [true, 0, finalRevision]]);
  assert.equal(execution.composition.baseline.captured, true);
  // Detector truth unchanged: the library is NOT observed, yet PRESENT by assembly evidence.
  const presence = capabilityPresence(evaluated, { detected: execution.reindex.observedCapabilities });
  assert.deepEqual(presence.map((p) => [p.capability, p.presence, p.independentDetection]), [[A.slug, 'PRESENT_BY_ASSEMBLY_EVIDENCE', 'observed'], [B.slug, 'PRESENT_BY_ASSEMBLY_EVIDENCE', 'not observed']]);
  assert.equal(execution.reindex.detectorObservation, 'OBSERVED', 'the last re-index reports what the detectors saw (the service), nothing composition-aware');
  // The primary checkout has not moved, and finalization is still an explicit, separate step.
  assert.equal(primaryUnchanged(ops), true);
  assert.equal(workspace.status, 'ACTIVE'); assert.equal(workspace.finalization, null);
  assert.equal(checkPromotion(workspace, { execution }).ok, true, 'eligible for explicit finalization');
  assert.equal(inspectRepo(ops.primary).head, execution.createdProject.initialCommit, 'nothing was promoted');
  // The execution record says what was proven, and no more.
  assert.equal(loadExecution(execution.executionId).finalSummary.capabilities.length, 2);
  assert.match(execution.finalSummary.finalAssemblyVerification, /2 capabilities.*same|one final revision/);
  assert.match(execution.finalSummary.wording, /not a "verified app" claim/);
  assert.equal(plan.steps.length, execution.steps.length);
  // REVISION DRIFT: the candidate advances to R+1 without a Laboratory step → R evidence is STALE.
  fs.writeFileSync(path.join(ops.candidate.worktreePath, 'src', 'flags', 'extra.js'), 'export const later = true;\n');
  git(ops.candidate.worktreePath, ['add', '--all']); git(ops.candidate.worktreePath, ['commit', '--quiet', '-m', 'R+1 without verification']);
  const drifted = evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId));
  assert.deepEqual(drifted.capabilities.map((c) => c.state), ['STALE', 'STALE']);
  assert.equal(drifted.status, 'STALE');
  assert.equal(checkPromotion(loadAssemblyWorkspace(workspace.assemblyWorkspaceId), { execution }).ok, false);
});

test('MANDATORY COUNTERFACTUAL: A succeeds, B succeeds and verifies, then A fails its post-B re-verification → composition NOT promotable, no partial CURRENT, primary unchanged', async (t) => {
  const work = sandbox(t);
  const { execution, workspace, promotable, ops } = await run(work, { outcomes: { [`reverify:${A.slug}`]: 'FAILED' } });
  assert.equal(promotable, false); assert.equal(workspace, null);
  assert.equal(execution.status, 'FAILED'); assert.equal(execution.composition.finalState, 'NOT_PROMOTABLE');
  assert.match(execution.error.message, new RegExp(`${A.slug} reported FAILED on the combined application after ${B.slug}`));
  // B's own proof is intact and recorded — and changes nothing about the composition.
  const [ca, cb] = execution.composition.capabilities;
  assert.deepEqual([cb.initialVerdict, cb.finalVerdict], ['VERIFIED', 'VERIFIED']);
  assert.deepEqual([ca.initialVerdict, ca.reverifiedVerdict, ca.finalVerdict], ['VERIFIED', 'FAILED', 'FAILED']);
  assert.equal(execution.composition.finalRevision, null);
  assert.equal(noLedger(), true, 'no ledger record of any kind was written');
  assert.deepEqual(execution.steps.map((s) => `${s.type}:${s.status}`).slice(-4), ['REVERIFY_CAPABILITY:FAILED', 'CHECK_HOST_PRESERVATION:SKIPPED', 'REINDEX_HOST:SKIPPED', 'FINAL_VERIFICATION:SKIPPED']);
  assert.equal(ops.log.at(-1), `verify:reverify:${A.slug}:after(${B.slug})`, 'nothing ran after the failed re-verification');
  assert.equal(primaryUnchanged(ops), true);
  // The candidate is kept for inspection, as a failed single-capability assembly is; it is not promotable.
  assert.equal(fs.existsSync(ops.candidate.worktreePath), true);
  assert.equal(execution.finalSummary.finalAssemblyVerification, 'no verified assembled state');
  assert.equal(loadExecution(execution.executionId).status, 'FAILED');
});

test('a capability that passes before its commit but FAILS the proof verification of the committed revision is FAILED in the record and in the Atlas — never VERIFIED corroboration', async (t) => {
  const work = sandbox(t);
  // B is applied last: its initial verification runs on the dirty tree, and the only reverify-phase
  // call it receives is the proof verification of the committed final revision, which fails here.
  const { execution, workspace, promotable, ops, plan } = await run(work, { outcomes: { [`reverify:${B.slug}`]: 'FAILED' } });
  assert.equal(promotable, false); assert.equal(workspace, null); assert.equal(execution.status, 'FAILED');
  assert.equal(execution.steps.find((s) => s.status === 'FAILED').type, 'FINAL_VERIFICATION'); assert.equal(execution.error.code, 'verdict');
  assert.match(execution.error.message, /feature-flags-library reported FAILED on the committed final revision/);
  const [ca, cb] = execution.composition.capabilities;
  assert.deepEqual([cb.initialVerdict, cb.reverifiedVerdict, cb.finalVerdict], ['VERIFIED', null, 'VERIFIED'], 'finalVerdict keeps its meaning (after later capabilities): B had none');
  assert.deepEqual([cb.proofVerdict, cb.proofSummary.failed, cb.proofOutcomes.map((o) => o.outcome)], ['FAILED', 2, ['passed', 'failed']], 'the committed-revision verification is the capability\'s last word, recorded on it');
  assert.deepEqual([ca.finalVerdict, ca.proofVerdict], ['VERIFIED', null], 'A was proven by its re-verification after B; no extra proof verification ran');
  assert.equal(fs.existsSync(assembliesDir()) ? fs.readdirSync(assembliesDir()).length : 0, 0, 'nothing CURRENT');
  // The Atlas observation prefers the last verification: B is FAILED with that verification's own
  // failed case; A stays truthfully VERIFIED. Neither carries a revision or a proof digest.
  const { buildAssemblyOutcomes } = await import('../src/laboratory/atlas-outcomes.js');
  const { queryAtlas } = await import('../src/engine/atlas.js');
  const id = (c) => `sha256:${c.repeat(64)}`;
  const plan64 = JSON.parse(JSON.stringify(plan).replaceAll(A.capabilityId, id('a')).replaceAll(B.capabilityId, id('b')));
  const exec64 = JSON.parse(JSON.stringify(execution).replaceAll(A.capabilityId, id('a')).replaceAll(B.capabilityId, id('b')));
  const arch = { runtime: { family: 'node', range: null }, framework: 'node-http', moduleSystem: 'esm', handlerContract: 'central-handler', persistence: 'unknown', dependencies: [] };
  const organ = (slug) => (slug === A.slug
    ? { manifest: { identity: { category: 'authentication' }, architecture: { capabilityModel: { kind: 'session-auth' } }, provenance: {} }, engine: { genome: { genomeId: 'sha256:genomeA', identity: { capabilityId: id('a'), kind: 'session-auth' }, provenance: { sourceArchitecture: arch } } } }
    : { manifest: { identity: { category: 'feature-flags', implementationForm: 'library' }, architecture: { capabilityModel: { kind: 'feature-flags' } }, provenance: {} }, engine: { genome: { genomeId: 'sha256:genomeB', identity: { capabilityId: id('b'), kind: 'feature-flags' }, provenance: { sourceArchitecture: arch } } } });
  const { entries, skipped } = buildAssemblyOutcomes({ execution: exec64, plan: plan64, organ });
  assert.deepEqual(skipped, []); assert.equal(entries.length, 2);
  const ea = entries.find((e) => e.capabilityId === id('a')), eb = entries.find((e) => e.capabilityId === id('b'));
  assert.deepEqual([eb.verification.verdict, eb.failureReasons, eb.destinationRevision, eb.proofEnvelopeDigest], ['FAILED', [`${B.slug}.b:failed`], null, null]);
  assert.deepEqual([ea.verification.verdict, ea.failureReasons, ea.destinationRevision, ea.proofEnvelopeDigest], ['VERIFIED', [], null, null]);
  for (const e of [ea, eb]) assert.deepEqual(e.assembly, { finalState: 'FAILED', failedStep: 'FINAL_VERIFICATION', errorCode: 'verdict' });
  const q = queryAtlas({ capabilityCategory: 'feature-flags', sourceArchitecture: arch, destinationArchitecture: eb.destinationArchitecture, entries });
  assert.deepEqual(q.verdicts, { VERIFIED: 0, FAILED: 1, NEEDS_REVIEW: 0, unverified: 0 }, 'the failed proof verification is not VERIFIED corroboration');
  assert.deepEqual(q.failureReasons, [{ reason: `${B.slug}.b:failed`, count: 1 }]);
});

test('every other required failure is fail-closed: no CURRENT records, no finalization, primary unchanged', async (t) => {
  const cases = [
    { name: 'A apply failure', outcomes: { [`apply:${A.slug}`]: 'throw' }, status: 'FAILED', notAttempted: [`apply:${B.slug}`, `verify:initial:${A.slug}`], last: `apply:${A.slug}` },
    { name: 'A verify failure', outcomes: { [`initial:${A.slug}`]: 'FAILED' }, status: 'FAILED', notAttempted: [`apply:${B.slug}`, `identity:${B.slug}`, `commit:${A.slug}`], last: `verify:initial:${A.slug}` },
    { name: 'B apply failure', outcomes: { [`apply:${B.slug}`]: 'throw' }, status: 'FAILED', notAttempted: [`verify:initial:${B.slug}`, `verify:reverify:${A.slug}:after(${B.slug})`], last: `apply:${B.slug}`, intermediate: true },
    { name: 'B verify inconclusive', outcomes: { [`initial:${B.slug}`]: 'NEEDS_REVIEW' }, status: 'INCONCLUSIVE', notAttempted: [`commit:${B.slug}`, `verify:reverify:${A.slug}:after(${B.slug})`], last: `verify:initial:${B.slug}`, intermediate: true },
    { name: 'preservation failure after A', outcomes: { 'preservation:1': 'FAILED' }, status: 'FAILED', notAttempted: [`apply:${B.slug}`], last: 'preservation:1' },
    { name: 'final host preservation failure', outcomes: { 'preservation:2': 'FAILED' }, status: 'FAILED', notAttempted: ['inspect'], last: 'preservation:2', intermediate: true },
    // Probes that never ran (the application did not boot) are not a pass: Checkpoint C found this for real.
    { name: 'preservation probes unobserved after A', outcomes: { 'preservation:1': 'UNOBSERVED' }, status: 'INCONCLUSIVE', notAttempted: [`apply:${B.slug}`], last: 'preservation:1' },
    { name: 'final preservation probes unobserved', outcomes: { 'preservation:2': 'UNOBSERVED' }, status: 'INCONCLUSIVE', notAttempted: ['inspect'], last: 'preservation:2', intermediate: true },
    { name: 'artifact identity mismatch', outcomes: { identity: { matched: false, reason: 'artifact-changed', detail: 'dist/swivel.js is not the artifact GRAFT verified' } }, status: 'BLOCKED', notAttempted: [`apply:${B.slug}`], last: `identity:${B.slug}` },
    { name: 'baseline not captured', outcomes: { baseline: { captured: false, reason: 'the host did not start', tests: [] } }, status: 'INCONCLUSIVE', notAttempted: [`apply:${A.slug}`], last: 'baseline' },
  ];
  for (const c of cases) {
    const work = sandbox(t);
    const { execution, workspace, promotable, ops } = await run(work, { outcomes: c.outcomes });
    assert.equal(promotable, false, c.name); assert.equal(workspace, null, c.name);
    assert.equal(execution.status, c.status, `${c.name}: ${execution.error?.message}`);
    assert.equal(execution.composition.finalState, 'NOT_PROMOTABLE', c.name);
    assert.equal(execution.composition.finalRevision, null, c.name);
    assert.equal(noLedger(), true, `${c.name}: no ledger record`);
    assert.equal(primaryUnchanged(ops), true, c.name);
    for (const op of c.notAttempted) assert.equal(ops.log.includes(op), false, `${c.name}: ${op} must not run`);
    assert.equal(ops.log.at(-1), c.last, `${c.name}: stops at the failing operation`);
    // Intermediate A evidence may exist as a commit in the candidate — and is CURRENT nowhere.
    if (c.intermediate) { assert.equal(execution.composition.capabilities[0].initialVerdict, 'VERIFIED', c.name); assert.ok(execution.composition.intermediateRevisions.some((r) => r.capability === A.slug), c.name); }
    assert.ok(execution.steps.some((s) => s.status === 'FAILED'), c.name);
    assert.equal(execution.steps.filter((s) => s.status === 'PENDING' || s.status === 'RUNNING').length, 0, c.name);
    assert.equal(execution.finalSummary.finalAssemblyVerification, 'no verified assembled state', c.name);
  }
});

test('a capability cannot sneak in unsupported, or disappear between plan and execution: refused before the host is created', async (t) => {
  const work = sandbox(t);
  const unsupported = twoCapabilityPlan();
  unsupported.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY').supported = false;
  assert.equal(checkExecutionEligibility(unsupported).ok, false);
  const r1 = await run(work, { plan: unsupported });
  assert.equal(r1.execution.status, 'BLOCKED'); assert.equal(r1.execution.error.code, 'unsupported-step'); assert.deepEqual(r1.ops.log, []);
  assert.equal(fs.existsSync(path.join(work, 'apps')) ? fs.readdirSync(path.join(work, 'apps')).length : 0, 0, 'no host was created');

  const dropped = twoCapabilityPlan();
  dropped.steps = dropped.steps.filter((s) => s.goalId !== 'goal-b' && s.type !== 'REVERIFY_CAPABILITY');
  assert.match(checkExecutionEligibility(dropped).problems.join(' '), /silently disappear/);
  const r2 = await run(work, { plan: dropped });
  assert.equal(r2.execution.status, 'BLOCKED'); assert.equal(r2.execution.error.code, 'capability-set-mismatch'); assert.deepEqual(r2.ops.log, []);
  assert.equal(noLedger(), true);

  // A plan that applies B twice, or names a capability the plan does not expect, is refused by the gate.
  const twice = twoCapabilityPlan(); twice.steps.push({ ...twice.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY'), stepId: 'step-99' });
  assert.match(checkExecutionEligibility(twice).problems.join(' '), /applied more than once/);
  const stranger = twoCapabilityPlan(); stranger.expectedCapabilities.pop();
  assert.match(checkExecutionEligibility(stranger).problems.join(' '), /does not expect/);
  const reordered = twoCapabilityPlan(); reordered.order.reverse();
  assert.match(checkExecutionEligibility(reordered).problems.join(' '), /do not follow the plan's recorded capability order/);
  const otherHost = twoCapabilityPlan(); otherHost.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY').profile = 'express-req-res';
  assert.match(checkExecutionEligibility(otherHost).problems.join(' '), /not the host's esm-node-http-central/);
  const unverifiedSource = twoCapabilityPlan(); unverifiedSource.evidence[1].sourceVerdict = 'NEEDS_REVIEW';
  assert.match(checkExecutionEligibility(unverifiedSource).problems.join(' '), /source verification is NEEDS_REVIEW/);
});

test('the same-revision invariant cannot be faked: a candidate that moves after the final verifications, or records at two revisions, are refused; a ledger write failure leaves nothing CURRENT', async (t) => {
  // The candidate advances (an extra commit) after B's commit: the re-verifications ran on a tree
  // that is no longer the candidate's HEAD, so the evidence does not apply to a single revision.
  const work = sandbox(t);
  const moved = await run(work, { hooks: { onVerify: ({ candidate, phase }) => { if (phase === 'reverify') { fs.writeFileSync(path.join(candidate.worktreePath, 'moved.js'), 'export const moved = true;\n'); git(candidate.worktreePath, ['add', '--all']); git(candidate.worktreePath, ['commit', '--quiet', '-m', 'moved after B']); } } } });
  assert.equal(moved.promotable, false); assert.equal(moved.execution.status, 'FAILED'); assert.equal(moved.execution.error.code, 'candidate-moved');
  assert.match(moved.execution.error.message, /not the last verified commit/);
  assert.equal(noLedger(), true); assert.equal(primaryUnchanged(moved.ops), true);
  // Uncommitted changes after the final verifications are refused the same way.
  const dirty = await run(work, { hooks: { onVerify: ({ candidate, phase }) => { if (phase === 'reverify') fs.writeFileSync(path.join(candidate.worktreePath, 'dirty.js'), 'export const dirty = true;\n'); } } });
  assert.equal(dirty.execution.error.code, 'candidate-moved'); assert.match(dirty.execution.error.message, /uncommitted changes/);
  assert.equal(noLedger(), true);

  // The ledger transition itself refuses records that do not all sit at the one final revision.
  const proofAt = (revision, slug) => { const p = storedProofFor({ revision, capability: { slug, id: `sha256:${slug}` } }); return { envelopeSchema: p.envelopeSchema, envelopeDigest: p.envelopeDigest }; };
  const base = { verificationVerdict: 'VERIFIED', hostPreservation: { captured: true, tests: 3, passed: 3, failed: 0 } };
  const proofs = { a: proofAt('r3', 'a'), b: proofAt('r3', 'b') };
  const ws = createAssemblyWorkspace({ execution: { blueprintId: 'x-000000', executionId: 'exec-x-000000-abcdef', planId: 'plan-x' }, repositoryIdentity: { name: 'x' }, baseRevision: 'r0', workingBranch: 'graft/x', worktreePath: '/nowhere/wt', primaryRoot: '/nowhere/p', hostId: 'h' });
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...base, capabilityId: 'a', capability: 'a', proofReference: proofs.a, currentVerifiedRevision: 'r2', destinationRevisionAfter: 'r2' }, { ...base, capabilityId: 'b', capability: 'b', proofReference: proofs.b, currentVerifiedRevision: 'r3', destinationRevisionAfter: 'r3' }], revision: 'r3' }), (e) => e.code === 'ledger-transition-refused' && /a: verified at r2, not the final revision r3/.test(e.message));
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...base, capabilityId: 'a', capability: 'a', proofReference: proofs.a, currentVerifiedRevision: 'r3', destinationRevisionAfter: 'r3' }, { ...base, capabilityId: 'b', capability: 'b', proofReference: proofs.b, verificationVerdict: 'FAILED', currentVerifiedRevision: 'r3', destinationRevisionAfter: 'r3' }], revision: 'r3' }), /b: final verification is FAILED/);
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...base, capabilityId: 'a', capability: 'a', proofReference: proofs.a, currentVerifiedRevision: 'r3', destinationRevisionAfter: 'r3', hostPreservation: { captured: true, tests: 3, passed: 2, failed: 1 } }], revision: 'r3' }), /host preservation failed/);
  assert.deepEqual(ws.capabilities, [], 'a refused transition leaves the ledger exactly as it was');
  assert.equal(ws.currentRevision, 'r0');
  commitLedgerTransition(ws, { records: [{ ...base, capabilityId: 'a', capability: 'a', proofReference: proofs.a, currentVerifiedRevision: 'r3', destinationRevisionAfter: 'r3' }, { ...base, capabilityId: 'b', capability: 'b', proofReference: proofs.b, currentVerifiedRevision: 'r3', destinationRevisionAfter: 'r3' }], revision: 'r3' });
  assert.deepEqual(ws.capabilities.map((c) => c.state), ['CURRENT', 'CURRENT']); assert.equal(ws.currentRevision, 'r3');
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...base, capabilityId: 'c', capability: 'c', currentVerifiedRevision: 'r4', destinationRevisionAfter: 'r4' }], revision: 'r4' }), /already holds capabilities/);

  // The ledger could not be written: the execution is FAILED, nothing is CURRENT anywhere.
  const unwritable = await run(work, { hooks: { persistWorkspace: () => { throw new Error('disk full'); } } });
  assert.equal(unwritable.promotable, false); assert.equal(unwritable.workspace, null);
  assert.equal(unwritable.execution.status, 'FAILED'); assert.equal(unwritable.execution.error.code, 'ledger-write');
  assert.equal(unwritable.execution.composition.finalState, 'NOT_PROMOTABLE'); assert.equal(unwritable.execution.assemblyWorkspaceId, undefined);
  assert.equal(noLedger(), true); assert.equal(primaryUnchanged(unwritable.ops), true);
  assert.equal(loadExecution(unwritable.execution.executionId).status, 'FAILED');
});

test('the created host must fingerprint as planned, and a capability that changes the host shape stops the composition before the next capability', async (t) => {
  const work = sandbox(t);
  const mismatch = await run(work, { hooks: { reindex: () => ({ profile: 'express-req-res', framework: 'express', handlerContract: 'express-req-res' }) } });
  assert.equal(mismatch.execution.status, 'BLOCKED'); assert.equal(mismatch.execution.error.code, 'host-mismatch'); assert.deepEqual(mismatch.ops.log, ['createHost', 'reindex:primary']);
  const changed = await run(work, { hooks: { reindex: (root) => (fs.existsSync(path.join(root, 'src', 'auth')) ? { profile: 'express-req-res' } : {}) } });
  assert.equal(changed.execution.status, 'BLOCKED'); assert.equal(changed.execution.error.code, 'host-shape-changed');
  assert.match(changed.execution.error.message, new RegExp(`After ${A.slug} the host is express-req-res`));
  assert.equal(changed.ops.log.includes(`apply:${B.slug}`), false);
  assert.equal(noLedger(), true); assert.equal(primaryUnchanged(changed.ops), true);
});

// ---------------------------------------------------------------------------------------------
// Proof Integrity 0.1, Checkpoint B: the ledger gate depends on DURABLE proof, and drift never
// touches a stored proof.
// ---------------------------------------------------------------------------------------------
test('proof persistence gate: a proof that cannot be made durable, is missing, or is corrupt before the transition means no CURRENT state at all', async (t) => {
  const work = sandbox(t);
  // B's proof cannot be persisted: A's artifact may exist, but nothing is CURRENT and the execution says why.
  const failing = await run(work, { hooks: { persistProof: (envelope) => { if (envelope.payload.capability.slug === B.slug) throw Object.assign(new Error('disk full'), { code: 'EIO' }); return storeProof(envelope); } } });
  assert.equal(failing.workspace, null); assert.equal(failing.promotable, false);
  assert.equal(failing.execution.status, 'FAILED'); assert.equal(failing.execution.error.code, 'proof-persistence'); assert.match(failing.execution.error.message, /feature-flags-library: the proof could not be made durable: disk full/);
  assert.equal(noLedger(), true, 'no partial CURRENT composition');
  assert.deepEqual(failing.execution.steps.at(-1).type, 'FINAL_VERIFICATION'); assert.equal(failing.execution.steps.at(-1).status, 'FAILED');
  assert.equal(failing.execution.composition.finalState, 'NOT_PROMOTABLE'); assert.equal(failing.execution.composition.promotable, false);
  const orphan = failing.execution.composition.proofs.find((p) => p.capability === A.slug);
  assert.ok(orphan && loadProofArtifact(orphan.envelopeDigest).intact, 'A\'s immutable proof artifact is stored and harmless');
  assert.equal(primaryUnchanged(failing.ops), true);
  // The store says it wrote, but the artifact is not there when read back: refused.
  const vanishing = await run(work, { hooks: { persistProof: (envelope) => { const r = storeProof(envelope); if (envelope.payload.capability.slug === B.slug) fs.rmSync(r.file); return r; } } });
  assert.equal(vanishing.workspace, null); assert.equal(vanishing.execution.error.code, 'proof-persistence'); assert.match(vanishing.execution.error.message, /does not read back intact \(no proof artifact is stored/);
  assert.equal(noLedger(), true);
  // Corrupted on disk between persistence and the transition: refused.
  const corrupting = await run(work, { hooks: { persistProof: (envelope) => { const r = storeProof(envelope); if (envelope.payload.capability.slug === A.slug) fs.writeFileSync(r.file, fs.readFileSync(r.file, 'utf8').replace('"VERIFIED"', '"FAILED"')); return r; } } });
  assert.equal(corrupting.workspace, null); assert.equal(corrupting.execution.error.code, 'proof-persistence'); assert.match(corrupting.execution.error.message, /hosted-authentication: the stored proof .* does not read back intact \(payload does not re-derive/);
  assert.equal(noLedger(), true);
  // The ledger transition itself, handed records whose proofs are absent or damaged, refuses.
  const ws = createAssemblyWorkspace({ execution: { blueprintId: 'x-000000', executionId: 'exec-x-000000-abcdef', planId: 'plan-x' }, repositoryIdentity: { name: 'x' }, baseRevision: 'r0', workingBranch: 'b', primaryBranch: 'main', worktreePath: work, projectRoot: work });
  const ok = { verificationVerdict: 'VERIFIED', hostPreservation: { captured: true, tests: 3, passed: 3, failed: 0 }, currentVerifiedRevision: 'r9', destinationRevisionAfter: 'r9' };
  const a = storedProofFor({ revision: 'r9', capability: { slug: 'a', id: 'sha256:a' } });
  const b = storedProofFor({ revision: 'r9', capability: { slug: 'b', id: 'sha256:b' } });
  const refA = { envelopeSchema: a.envelopeSchema, envelopeDigest: a.envelopeDigest }, refB = { envelopeSchema: b.envelopeSchema, envelopeDigest: b.envelopeDigest };
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...ok, capabilityId: 'a', capability: 'a', proofReference: refA }, { ...ok, capabilityId: 'b', capability: 'b' }], revision: 'r9' }), /b: no durable proof envelope digest/);
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...ok, capabilityId: 'a', capability: 'a', proofReference: refA }, { ...ok, capabilityId: 'b', capability: 'b', proofReference: { ...refB, envelopeDigest: '0'.repeat(64) } }], revision: 'r9' }), /b: the proof artifact 000000000000 is not in the proof store/);
  const elsewhere = storedProofFor({ revision: 'r8', capability: { slug: 'b', id: 'sha256:b' } });
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...ok, capabilityId: 'a', capability: 'a', proofReference: refA }, { ...ok, capabilityId: 'b', capability: 'b', proofReference: { envelopeSchema: elsewhere.envelopeSchema, envelopeDigest: elsewhere.envelopeDigest } }], revision: 'r9' }), /b: the stored proof binds destination revision r8, not r9/);
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...ok, capabilityId: 'a', capability: 'a', proofReference: refA }, { ...ok, capabilityId: 'b', capability: 'b', proofReference: refA }], revision: 'r9' }), /b: the stored proof is about a, not b/, 'a proof of another capability at the same revision is not this capability\'s proof');
  fs.writeFileSync(proofArtifactPath(b.envelopeDigest), fs.readFileSync(proofArtifactPath(b.envelopeDigest), 'utf8').replace('"r9"', '"r7"'));
  assert.throws(() => commitLedgerTransition(ws, { records: [{ ...ok, capabilityId: 'a', capability: 'a', proofReference: refA }, { ...ok, capabilityId: 'b', capability: 'b', proofReference: refB }], revision: 'r9' }), /b: the proof artifact .* is not intact \(payload does not re-derive/);
  assert.deepEqual(ws.capabilities, []); assert.equal(ws.currentRevision, 'r0');
});

test('revision drift: the ledger goes STALE by its own rules while the stored proof for the earlier revision stays intact and still describes that revision', async (t) => {
  const work = sandbox(t);
  const { workspace, ops } = await run(work);
  const R = workspace.currentRevision;
  const digests = workspace.capabilities.map((c) => c.proofReference.envelopeDigest);
  assert.deepEqual(evaluateWorkspace(workspace).capabilities.map((c) => c.state), ['CURRENT', 'CURRENT']);
  // The application advances without a Laboratory step.
  fs.writeFileSync(path.join(ops.candidate.worktreePath, 'later.js'), 'export const later = true;\n');
  const next = commitAssembledState(ops.candidate.worktreePath, { capability: 'a later change' });
  assert.notEqual(next.revision, R);
  const drifted = evaluateWorkspace(workspace);
  assert.deepEqual(drifted.capabilities.map((c) => c.state), ['STALE', 'STALE']);
  for (const [i, digest] of digests.entries()) {
    const stored = loadProofArtifact(digest);
    assert.equal(stored.intact, true, 'drift does not touch the immutable proof');
    assert.equal(stored.envelope.payload.destination.revision, R, 'the proof still truthfully describes R, not R+1');
    assert.equal(drifted.capabilities[i].proofReference.envelopeDigest, digest, 'the STALE record still cites the same proof');
  }
});
