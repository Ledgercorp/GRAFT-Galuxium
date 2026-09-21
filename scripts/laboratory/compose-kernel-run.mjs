// Laboratory 0.4a — the composition kernel against real capabilities and a real host.
//
// ENGINEERING COMPOSITION TEST. Both capabilities are GRAFT test sources, used only to exercise
// composition mechanics; this run is NOT evidence of open-source composition (see
// docs/LABORATORY-0.4-FEASIBILITY.md) and makes no customer claim. Everything else is real: real
// harvests, a real git host, and GRAFT's own transplant, verification and proof path.
//
// Host: the `esm-return-response` shape, which is the only shape that supports BOTH capability
// kinds used here and needs no dependencies. (The 2B Express host supports hosted-session-auth
// only: its entrypoint mounts routers, so `express.supported` is false and the feature-flags
// emitter — which registers routes directly — is correctly refused there.)
//
//   node scripts/laboratory/compose-kernel-run.mjs [--keep]
//   node scripts/laboratory/compose-kernel-run.mjs --mutate   (rollback experiment: capability B's
//     apply also removes capability A's module, so A's real re-verification must fail on the
//     combined candidate and the candidate must be discarded with revision A left current)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const FIXTURE_A = path.join(repoRoot, 'fixtures/old-saas-project');
const FIXTURE_B_ROOT = path.join(repoRoot, 'fixtures/config-service');
const MUTATE = process.argv.includes('--mutate');
const SESSION = MUTATE ? 'laboratory-composition-kernel-0.4a-mutation' : 'laboratory-composition-kernel-0.4a';
const HOME = path.resolve(process.env.GRAFT_COMPOSE_HOME || path.join(os.homedir(), '.graft-demo', SESSION, 'graft-state'));
// The host lives beside GRAFT_HOME, never inside it (GRAFT refuses destinations it manages).
const HOST = path.join(os.homedir(), '.graft-demo', SESSION, 'composition-host');
process.env.GRAFT_HOME = HOME;

const { fingerprintProject } = await import('../../packages/core/src/analyze/fingerprint.js');
const { harvestCapability } = await import('../../packages/core/src/harvest/index.js');
const { writeManifest, readManifest, readOrganEngine } = await import('../../packages/core/src/manifest/io.js');
const { bankDir } = await import('../../packages/core/src/registry/index.js');
const { createTransplantPlan } = await import('../../packages/core/src/plan/index.js');
const { applyTransplant, checkPreconditions } = await import('../../packages/core/src/apply/index.js');
const { captureHostBaseline } = await import('../../packages/core/src/verify/index.js');
const { prepareTransplant, transition, cleanupTransplant } = await import('../../packages/core/src/apply/worktree.js');
const { verifyCapability } = await import('../../packages/core/src/verify/index.js');
const { inspectRepo } = await import('../../packages/core/src/apply/git.js');
const { createAssemblyWorkspace, recordAssembledCapability, commitAssembledState, evaluateWorkspace, capabilityPresence, dependencyEvidence, saveAssemblyWorkspace } = await import('../../packages/core/src/laboratory/continuity.js');
const { composeNextCapability, checkCompositionReady } = await import('../../packages/core/src/laboratory/composition.js');
const { openDogfoodSession } = await import('../../packages/core/src/dogfood/index.js');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const evidence = { session: SESSION, kind: 'ENGINEERING COMPOSITION TEST', startedAt: new Date().toISOString(), steps: [], testSourceNote: 'Both capabilities are GRAFT test sources (fixtures/old-saas-project authentication and fixtures/config-service feature flags), used only to exercise composition mechanics. This run makes no open-source import claim and no customer claim.' };
const step = (name, data) => { evidence.steps.push({ at: new Date().toISOString(), name, ...data }); console.log(`${name} :: ${JSON.stringify(data).slice(0, 320)}`); };
const fail = (m) => { throw new Error(m); };

fs.mkdirSync(HOME, { recursive: true });
const record = openDogfoodSession(SESSION, { context: { kind: 'engineering-composition-test' } });

// ---------------------------------------------------------------------------------------------
// Sources and host, all read-only.
// ---------------------------------------------------------------------------------------------
for (const [label, root] of [['fixture A', FIXTURE_A], ['fixture B', FIXTURE_B_ROOT]]) if (!fs.existsSync(root)) fail(`${label} not found at ${root}`);
// The host: a real git repository of the `esm-return-response` shape, made once from GRAFT's
// dependency-free fixture. It is the destination, so it must be a repository with a commit.
if (!fs.existsSync(HOST)) {
  fs.mkdirSync(path.dirname(HOST), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'fixtures/new-startup'), HOST, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: HOST });
  execFileSync('git', ['-c', 'user.name=GRAFT Laboratory', '-c', 'user.email=laboratory@graft.local', 'add', '--all'], { cwd: HOST });
  execFileSync('git', ['-c', 'user.name=GRAFT Laboratory', '-c', 'user.email=laboratory@graft.local', 'commit', '--quiet', '-m', 'Composition test host (esm-return-response, no dependencies)'], { cwd: HOST });
}
const hostBefore = { head: git(HOST, ['rev-parse', 'HEAD']), branch: git(HOST, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(HOST, ['status', '--porcelain']).split('\n').filter(Boolean).length, remote: (() => { try { return git(HOST, ['remote', 'get-url', 'origin']); } catch { return ''; } })() };
if (hostBefore.dirty) fail(`the host has ${hostBefore.dirty} uncommitted change(s); composition needs a clean host`);
const hostShape = fingerprintProject(HOST);
step('sources', { host: { root: path.basename(HOST), shape: `${hostShape.moduleSystem.value}/${hostShape.framework.value}/${hostShape.handlerContract.value}`, head: hostBefore.head.slice(0, 12), branch: hostBefore.branch, dirty: hostBefore.dirty, remote: hostBefore.remote || 'none', dependencies: hostShape.dependencies.length },
  capabilityA: 'fixtures/old-saas-project (GRAFT test source)', capabilityB: 'fixtures/config-service (GRAFT test source)', note: 'engineering composition test; neither source is an open-source import' });

// Harvest both capabilities into the bank (the source checkouts are only read).
const harvested = {};
for (const [key, root, capability] of [['A', FIXTURE_A, 'authentication'], ['B', FIXTURE_B_ROOT, 'feature-flags']]) {
  const { manifest, verification } = await harvestCapability(fingerprintProject(root), capability);
  writeManifest(bankDir(), manifest);
  const engine = readOrganEngine(path.join(bankDir(), `${manifest.identity.slug}.graft`));
  harvested[key] = { slug: manifest.identity.slug, name: manifest.identity.name, kind: engine.genome.identity.kind, capabilityId: engine.genome.identity.capabilityId, genomeId: engine.genome.genomeId, irId: engine.ir.irId, contractId: engine.verificationContract.contractId, sourceVerdict: verification?.verdict || manifest.provenance?.verifiedInSource?.verdict || null, sourceProject: manifest.provenance?.sourceProject?.name || null };
  step(`harvested-${key}`, harvested[key]);
  record.event('harvest', { capability: manifest.identity.slug, kind: harvested[key].kind, verdict: harvested[key].sourceVerdict }, { stage: 'harvest' });
}
if (harvested.A.sourceVerdict !== 'VERIFIED') fail(`capability A was not VERIFIED in source (${harvested.A.sourceVerdict})`);

// ---------------------------------------------------------------------------------------------
// Shared operations: one transplant of one capability into one candidate worktree.
// ---------------------------------------------------------------------------------------------
async function transplantInto({ worktreePath, slug, resolveConflicts = false }) {
  const manifest = readManifest(path.join(bankDir(), `${slug}.graft`));
  const fp = fingerprintProject(worktreePath);
  const plan = createTransplantPlan(manifest, fp, { resolveConflicts, atlas: 'local' });
  // A blocked plan is an authoritative refusal, not a crash: report it so the transaction rejects
  // the candidate and the previous revision stays current.
  if (plan.status !== 'ready') return { verdict: `PLAN_${plan.status.toUpperCase()}`, report: null, plan, blockers: (plan.compatibility?.axes || []).filter((a) => a.status === 'block').map((a) => a.detail) };
  const safety = checkPreconditions(plan, worktreePath);
  if (!safety.ok) fail(`preconditions for ${slug}: ${safety.problems.map((p) => p.message).join(' ')}`);
  // Host preservation compares against the destination's own answers, captured BEFORE any write —
  // the same order the product's apply path uses. Probes without a baseline prove nothing.
  const baseline = (plan.preservation || []).length ? await captureHostBaseline(worktreePath, { entrypoint: plan.destination.entrypoint, tests: plan.preservation }) : { captured: false, tests: [], reason: 'no host-preservation probes' };
  const preservationTests = baseline.captured ? baseline.tests : [];
  const applied = applyTransplant(plan, worktreePath, { createBranch: false });
  if (applied.refused) fail(`apply refused for ${slug}: ${applied.problems.map((p) => p.message).join(' ')}`);
  const report = await verifyCapability(manifest, worktreePath, { entrypoint: plan.destination.entrypoint, atlas: 'local', extraTests: preservationTests });
  const preservationIds = new Set(preservationTests.map((x) => x.id));
  const preservation = (report.results || []).filter((r) => preservationIds.has(r.id));
  return {
    verdict: report.verdict, report, plan,
    verification: { summary: report.summary, invariantSummary: report.proof?.summary ? { held: report.proof.summary.invariantsHeld, violated: report.proof.summary.invariantsViolated, unobserved: report.proof.summary.invariantsUnobserved } : null, counterfactualSummary: { cases: (report.proof?.counterfactualCases || []).length, passed: (report.proof?.counterfactualCases || []).filter((c) => c.outcome === 'passed').length } },
    hostPreservation: { captured: baseline.captured, reason: baseline.reason || null, tests: preservation.length, passed: preservation.filter((r) => r.outcome === 'passed').length, failed: preservation.filter((r) => r.outcome === 'failed').length },
    proofReferences: [{ kind: 'transplant-plan', planId: plan.id }, ...(report.proof ? [{ kind: 'proof', contractId: report.proof.contractId, summary: report.proof.summary }] : [])],
    conflictsApproved: resolveConflicts ? plan.conflicts?.routes || [] : [],
    transplantPlan: { planId: plan.id, profile: plan.adaptation?.profile || null, recipe: plan.engine?.recipe?.name || null, files: plan.files.map((f) => f.path), entrypoint: plan.destination.entrypoint },
    filesWritten: applied.filesWritten,
  };
}

// ---------------------------------------------------------------------------------------------
// Capability A: the first assembly revision on this host.
// ---------------------------------------------------------------------------------------------
const tA = prepareTransplant({ destinationRoot: HOST, capabilitySlug: harvested.A.slug, fromRevision: hostBefore.head });
if (tA.baseHead !== hostBefore.head) fail('capability A was not cut from the host revision');
const appliedA = await transplantInto({ worktreePath: tA.worktree.path, slug: harvested.A.slug, resolveConflicts: true });
step('capability-A-verified', { verdict: appliedA.verdict, summary: appliedA.report?.summary || null, conflictsApproved: appliedA.conflictsApproved || [], blockers: appliedA.blockers || null, profile: appliedA.transplantPlan?.profile || appliedA.plan?.adaptation?.profile || null, files: appliedA.filesWritten?.length ?? 0, worktree: path.basename(tA.worktree.path) });
if (appliedA.verdict !== 'VERIFIED') fail(`capability A reported ${appliedA.verdict}${appliedA.blockers ? ': ' + appliedA.blockers.join('; ') : ''}`);
transition(tA.id, 'VERIFIED', { verdict: { verdict: appliedA.verdict, summary: appliedA.report.summary, at: appliedA.report.finishedAt } });
const executionA = {
  executionId: `exec-compose-${Date.now().toString(16)}`, planId: 'plan-composition-kernel', blueprintId: 'authenticated-flagged-application-0000', blueprintName: 'Authenticated feature-flagged application (engineering composition test)',
  status: 'COMPLETED', steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'DONE', finishedAt: new Date().toISOString(), outcome: { filesWritten: appliedA.filesWritten } }],
  createdProject: { root: HOST, name: path.basename(HOST) }, transplantId: tA.id, transplantPlan: appliedA.transplantPlan,
  capabilitySource: { kind: harvested.A.kind, genomeId: harvested.A.genomeId, irId: harvested.A.irId, sourceProject: harvested.A.sourceProject, sourceRevision: 'fixture', sourceVerification: { verdict: harvested.A.sourceVerdict } },
  verification: { capability: harvested.A.slug, capabilityId: harvested.A.capabilityId, verdict: appliedA.verdict, summary: appliedA.report.summary, invariants: (appliedA.report.proof?.invariants || []).map((i) => ({ id: i.id, status: i.status })), counterfactuals: (appliedA.report.proof?.counterfactualCases || []).map((c) => ({ id: c.id, outcome: c.outcome })) },
  hostPreservation: appliedA.hostPreservation, proofReferences: appliedA.proofReferences,
};
const workspace = createAssemblyWorkspace({ execution: executionA, repositoryIdentity: { name: path.basename(HOST), repositoryId: null }, baseRevision: hostBefore.head, workingBranch: tA.worktree.branch, primaryBranch: hostBefore.branch, worktreePath: tA.worktree.path, primaryRoot: HOST, hostId: 'express-host' });
const committedA = commitAssembledState(tA.worktree.path, { capability: harvested.A.name });
recordAssembledCapability(workspace, { execution: executionA, revisionBefore: hostBefore.head, revisionAfter: committedA.revision });
saveAssemblyWorkspace(workspace);
const revisionA = workspace.currentRevision;
step('revision-A', { revisionA: revisionA.slice(0, 12), base: hostBefore.head.slice(0, 12), branch: tA.worktree.branch, ledger: workspace.capabilities.map((c) => `${c.capability}:${c.state}`) });
record.event('laboratory.compose.capability', { capability: harvested.A.slug, capabilityId: harvested.A.capabilityId, verdict: appliedA.verdict, revision: revisionA, position: 1 }, { stage: 'apply' });

// While planning B, A must be visible as assembly evidence without any detector rediscovery.
const presenceBeforeB = capabilityPresence(workspace, { detected: [] })[0];
const dependencyBeforeB = dependencyEvidence(workspace, { capability: harvested.A.slug });
step('A-evidence-while-planning-B', { presence: presenceBeforeB.presence, detector: presenceBeforeB.independentDetection, dependencySatisfied: dependencyBeforeB.satisfied, state: dependencyBeforeB.state });
if (presenceBeforeB.presence !== 'PRESENT_BY_ASSEMBLY_EVIDENCE' || !dependencyBeforeB.satisfied) fail('capability A is not visible as current assembly evidence');
const ready = checkCompositionReady(workspace);
if (!ready.ok) fail(`composition not ready: ${ready.problems.join('; ')}`);

// ---------------------------------------------------------------------------------------------
// Capability B: composed onto revision A, transactionally.
// ---------------------------------------------------------------------------------------------
const candidates = [];
const result = await composeNextCapability(workspace, {
  capability: { slug: harvested.B.slug, name: harvested.B.name, capabilityId: harvested.B.capabilityId, kind: harvested.B.kind },
  steps: {
    prepareCandidate: async ({ fromRevision, capability }) => {
      const t = prepareTransplant({ destinationRoot: HOST, capabilitySlug: capability.slug, fromRevision });
      const candidate = { worktreePath: t.worktree.path, branch: t.worktree.branch, transplantId: t.id, headAtPrepare: inspectRepo(t.worktree.path).head };
      candidates.push(candidate);
      step('candidate-prepared', { branch: candidate.branch, cutFrom: candidate.headAtPrepare.slice(0, 12), expected: fromRevision.slice(0, 12), containsA: fs.existsSync(path.join(candidate.worktreePath, 'src/auth')) || fs.existsSync(path.join(candidate.worktreePath, 'app/auth')) });
      return candidate;
    },
    applyAndVerify: async ({ candidate, capability }) => {
      const applied = await transplantInto({ worktreePath: candidate.worktreePath, slug: capability.slug, resolveConflicts: true });
      if (MUTATE) {
        // Controlled mutation: break capability A inside the candidate, exactly as a hostile or
        // incompatible second capability would. A's own contract must catch it.
        const authModule = ['src/auth/session.js', 'src/auth/routes.js', 'src/auth/identity.js'].map((f) => path.join(candidate.worktreePath, f)).find((f) => fs.existsSync(f));
        if (!authModule) fail('the mutation experiment could not find capability A’s module in the candidate');
        fs.writeFileSync(authModule, 'export const createSessions = () => { throw new Error("mutated by the rollback experiment"); };\n');
        step('mutation-applied', { file: path.relative(candidate.worktreePath, authModule), note: 'capability A deliberately broken inside the candidate' });
      }
      step('capability-B-verified', { verdict: applied.verdict, summary: applied.report?.summary || null, conflictsApproved: applied.conflictsApproved || [], blockers: applied.blockers || null, profile: applied.transplantPlan?.profile || null, files: applied.filesWritten?.length ?? 0 });
      if (applied.verdict === 'VERIFIED') transition(candidate.transplantId, 'VERIFIED', { verdict: { verdict: applied.verdict, summary: applied.report.summary, at: applied.report.finishedAt } });
      return { ...applied, capabilitySource: { kind: harvested.B.kind, genomeId: harvested.B.genomeId, irId: harvested.B.irId, sourceProject: 'fixtures/config-service (GRAFT test source)', sourceRevision: 'fixture', sourceVerification: { verdict: 'VERIFIED' } } };
    },
    reverifyCapability: async ({ candidate, record: ledgerRecord }) => {
      const manifest = readManifest(path.join(bankDir(), `${ledgerRecord.capability}.graft`));
      const fp = fingerprintProject(candidate.worktreePath);
      const report = await verifyCapability(manifest, candidate.worktreePath, { entrypoint: fp.entrypoint, atlas: null });
      step('A-reverified-on-candidate', { capability: ledgerRecord.capability, verdict: report.verdict, summary: report.summary });
      return { verdict: report.verdict, summary: report.summary, proofReference: report.proof ? { kind: 'proof', contractId: report.proof.contractId, summary: report.proof.summary } : null };
    },
    commitCandidate: async ({ candidate, capability }) => commitAssembledState(candidate.worktreePath, { capability: capability.name }),
    disposeCandidate: async ({ candidate, reason }) => {
      step('candidate-disposed', { branch: candidate?.branch || null, reason });
      if (candidate?.transplantId) { try { cleanupTransplant(candidate.transplantId, { confirmDiscard: true }); } catch (err) { step('dispose-warning', { message: err.message }); } }
    },
  },
});

const hostAfter = { head: git(HOST, ['rev-parse', 'HEAD']), branch: git(HOST, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(HOST, ['status', '--porcelain']).split('\n').filter(Boolean).length };
evidence.composition = {
  composed: result.composed, rejection: result.rejection, evidenceRecord: result.evidence,
  revisionA, revisionAB: workspace.currentRevision, candidate: candidates[0] ? { branch: candidates[0].branch, cutFrom: candidates[0].headAtPrepare } : null,
  ledger: workspace.capabilities.map((c) => ({ capability: c.capability, capabilityId: c.capabilityId, kind: c.kind, state: c.state, appliedRevision: c.appliedRevision, currentVerifiedRevision: c.currentVerifiedRevision, verdict: c.verificationVerdict, summary: c.verificationSummary, contractId: c.verificationContractId, history: c.verificationHistory })),
  host: { before: hostBefore, after: hostAfter, unchanged: hostAfter.head === hostBefore.head && hostAfter.branch === hostBefore.branch && hostAfter.dirty === 0 },
};
if (MUTATE) {
  // The experiment succeeds when composition is REJECTED and nothing moved.
  if (result.composed) fail('the mutation experiment composed anyway: capability A’s failure was not caught');
  const evaluated = evaluateWorkspace(workspace);
  const stillThere = fs.existsSync(tA.worktree.path) && inspectRepo(tA.worktree.path).head === revisionA;
  evidence.rollback = { rejected: true, stage: result.rejection.stage, detail: result.rejection.detail, disposed: result.rejection.disposed, candidateBranch: result.rejection.candidateBranch, candidateWorktreeGone: !fs.existsSync(candidates[0].worktreePath), currentRevision: workspace.currentRevision, revisionA, ledger: evaluated.capabilities.map((c) => ({ capability: c.capability, state: c.state, currentVerifiedRevision: c.currentVerifiedRevision })), revisionAIntact: stillThere, finalState: result.evidence.finalState };
  if (workspace.currentRevision !== revisionA) fail('the assembly moved despite the rejection');
  if (evaluated.capabilities.length !== 1 || evaluated.capabilities[0].state !== 'CURRENT') fail('capability A is no longer the only CURRENT capability');
  if (!stillThere) fail('revision A is no longer intact');
  step('rollback-proven', evidence.rollback);
  record.event('laboratory.compose', { assemblyWorkspaceId: workspace.assemblyWorkspaceId, revisionA, revisionAB: null, rejected: true, stage: result.rejection.stage, finalState: result.evidence.finalState, capabilities: evaluated.capabilities.map((c) => ({ capability: c.capability, state: c.state })), testSource: 'engineering mutation experiment' }, { stage: 'verify' });
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(path.dirname(HOME), 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`\nRollback experiment complete (candidate rejected, revision A intact). Evidence: ${path.join(path.dirname(HOME), 'evidence.json')}`);
  process.exit(0);
}
if (!result.composed) fail(`composition was rejected: ${JSON.stringify(result.rejection)}`);
if (candidates[0].headAtPrepare !== revisionA) fail('the candidate was not cut from revision A');
if (git(HOST, ['rev-parse', `${workspace.workingBranch}~1`]) !== revisionA) fail('the composed commit does not sit directly on revision A');
if (!evidence.composition.host.unchanged) fail('the host checkout changed');
const bound = new Set(workspace.capabilities.map((c) => c.currentVerifiedRevision));
if (bound.size !== 1 || !bound.has(workspace.currentRevision)) fail('the capabilities are not bound to one shared revision');
saveAssemblyWorkspace(workspace);
record.event('laboratory.compose.capability', { capability: harvested.B.slug, capabilityId: harvested.B.capabilityId, verdict: 'VERIFIED', revision: workspace.currentRevision, position: 2 }, { stage: 'apply' });
record.event('laboratory.compose', { assemblyWorkspaceId: workspace.assemblyWorkspaceId, revisionA, revisionAB: workspace.currentRevision, capabilities: workspace.capabilities.map((c) => ({ capability: c.capability, state: c.state, verdict: c.verificationVerdict, appliedRevision: c.appliedRevision, currentVerifiedRevision: c.currentVerifiedRevision })), finalState: result.evidence.finalState, interactionsChecked: result.evidence.interactionsChecked.map((i) => `${i.capability}:${i.verdict}`), testSource: 'capability B is the GRAFT feature-flags fixture' }, { stage: 'verify' });

step('composed', { revisionA: revisionA.slice(0, 12), revisionAB: workspace.currentRevision.slice(0, 12), finalState: result.evidence.finalState, capabilities: workspace.capabilities.map((c) => `${c.capability}@${c.currentVerifiedRevision.slice(0, 8)}:${c.state}`), interactions: result.evidence.interactionsChecked.map((i) => `${i.capability}:${i.verdict}`) });

// The composed application, run the way its owner would.
const composedWorktree = workspace.locations.worktree;
const fpFinal = fingerprintProject(composedWorktree);
evidence.composition.finalWorktree = { path: composedWorktree, entrypoint: fpFinal.entrypoint, routes: fpFinal.routes.length, files: fs.readdirSync(composedWorktree).filter((f) => !f.startsWith('.')).sort() };
step('final-assembly', evidence.composition.finalWorktree);

evidence.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(path.dirname(HOME), 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\nComposition kernel run complete. Evidence: ${path.join(path.dirname(HOME), 'evidence.json')}`);
if (!process.argv.includes('--keep')) console.log('Worktrees kept for inspection; clean up with the product’s own cleanup when done.');
