import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inspectRepo } from '../src/apply/git.js';
import { projectResponse, AuthorityViolation } from '../src/agent/tasks.js';
import { createHost } from '../src/laboratory/execution.js';
import { createAssemblyWorkspace, recordAssembledCapability, commitAssembledState, evaluateWorkspace, dependencyEvidence, capabilityPresence, saveAssemblyWorkspace, loadAssemblyWorkspace } from '../src/laboratory/continuity.js';
import { composeNextCapability, checkCompositionReady, compositionEvidence, COMPOSITION_EVIDENCE_VERSION } from '../src/laboratory/composition.js';
import { storedProofFor } from './helpers/proof.js';
/** Proof Integrity 0.1: a CURRENT record cites a durable proof of the verification at its revision. */
const prove = (execution, revision) => ({ ...execution, proof: storedProofFor({ revision, capability: { slug: execution.verification?.capability || 'capability' } }) });

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-comp-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}

/**
 * A real assembly holding one verified capability A, built with real git: a created host, a
 * worktree, an applied change and a commit. Only verification outcomes are supplied by the test —
 * the revision mechanics this phase exists to prove are genuine throughout.
 */
function assemblyWithA(work) {
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const receipt = createHost({ parentDir: parent, name: `app-${crypto.randomUUID().slice(0, 6)}`, architectureId: 'node-esm-http-central' });
  const primary = receipt.root;
  const branchA = `graft/hosted-authentication-${crypto.randomUUID().slice(0, 8)}`;
  const worktreeA = path.join(work, `wt-a-${crypto.randomUUID().slice(0, 6)}`);
  git(primary, ['worktree', 'add', '--quiet', '-b', branchA, '--', worktreeA, receipt.initialCommit]);
  fs.mkdirSync(path.join(worktreeA, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(worktreeA, 'src', 'auth', 'routes.js'), 'export const registerAuth = () => ({ async handle() { return false; } });\n');
  const execution = {
    executionId: 'exec-app-000000-abcdef', planId: 'plan-x-000000-abcdef', blueprintId: 'app-000000', blueprintName: 'Authenticated application',
    status: 'COMPLETED', steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'DONE', finishedAt: '2026-09-12T00:00:00.000Z', outcome: { filesWritten: ['src/auth/routes.js'] } }],
    createdProject: { root: primary, name: receipt.projectName }, transplantId: 'aaaa1111', transplantPlan: { planId: 'graft-hosted-authentication-1' },
    capabilitySource: { kind: 'hosted-session-auth', genomeId: 'sha256:genomeA', irId: 'sha256:irA', sourceProject: '@leftsock/cuf', sourceRevision: 'ec1af9bb', sourceVerification: { verdict: 'VERIFIED', summary: { required: 13, passed: 13 } } },
    verification: { capability: 'hosted-authentication', capabilityId: 'sha256:capA', verdict: 'VERIFIED', summary: { required: 15, passed: 15, failed: 0 }, invariants: [{ id: 'sec.httponly', status: 'held' }], counterfactuals: [{ id: 'rejects-anonymous', outcome: 'passed' }] },
    hostPreservation: { captured: true, tests: 2, passed: 2, failed: 0 },
    proofReferences: [{ kind: 'proof', contractId: 'sha256:contractA', summary: { cases: 12, passed: 12 } }],
  };
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: { name: receipt.projectName }, baseRevision: receipt.initialCommit, workingBranch: branchA, primaryBranch: 'main', worktreePath: worktreeA, primaryRoot: primary, hostId: receipt.fingerprint.hostId });
  const committedA = commitAssembledState(worktreeA, { capability: 'Hosted sign-in' });
  recordAssembledCapability(workspace, { execution: prove(execution, committedA.revision), revisionBefore: receipt.initialCommit, revisionAfter: committedA.revision });
  return { primary, worktreeA, branchA, receipt, workspace, revisionA: committedA.revision, baseRevision: receipt.initialCommit };
}

/** Real candidate mechanics; verification outcomes are injected so failure paths can be exercised. */
function steps(work, { primary, outcomes = {}, onApply = null }) {
  const disposals = [];
  const created = [];
  return {
    disposals, created,
    prepareCandidate: async ({ fromRevision, capability }) => {
      const branch = `graft/${capability.slug}-${crypto.randomUUID().slice(0, 8)}`;
      const worktreePath = path.join(work, `wt-cand-${crypto.randomUUID().slice(0, 6)}`);
      git(primary, ['worktree', 'add', '--quiet', '-b', branch, '--', worktreePath, outcomes.cutFrom || fromRevision]);
      const candidate = { worktreePath, branch, transplantId: crypto.randomUUID().slice(0, 8), headAtPrepare: inspectRepo(worktreePath).head };
      created.push(candidate);
      return candidate;
    },
    applyAndVerify: async ({ candidate, capability }) => {
      fs.mkdirSync(path.join(candidate.worktreePath, 'src', 'flags'), { recursive: true });
      fs.writeFileSync(path.join(candidate.worktreePath, 'src', 'flags', 'flags.js'), 'export const DEFAULT_FLAGS = Object.freeze({ beta: false });\n');
      if (onApply) onApply(candidate);
      return {
        verdict: outcomes.bVerdict || 'VERIFIED',
        verification: { summary: { required: 6, passed: outcomes.bVerdict === 'VERIFIED' || !outcomes.bVerdict ? 6 : 4, failed: 0 }, invariantSummary: { held: 3, violated: 0, unobserved: 0 }, counterfactualSummary: { cases: 2, passed: 2 } },
        hostPreservation: outcomes.hostPreservation || { captured: true, tests: 2, passed: 2, failed: 0 },
        proofReferences: [{ kind: 'proof', contractId: 'sha256:contractB', summary: { cases: 8, passed: 8 } }],
        transplantPlan: { planId: 'graft-feature-flags-1' },
        capabilitySource: { kind: 'feature-flags', genomeId: 'sha256:genomeB', irId: 'sha256:irB', sourceProject: 'config-service (GRAFT fixture)', sourceRevision: 'fixture', sourceVerification: { verdict: 'VERIFIED', summary: { required: 6, passed: 6 } } },
        filesWritten: ['src/flags/flags.js'],
      };
    },
    reverifyCapability: async ({ candidate, record }) => ({ verdict: outcomes.reverifyVerdict || 'VERIFIED', summary: { required: 15, passed: outcomes.reverifyVerdict && outcomes.reverifyVerdict !== 'VERIFIED' ? 13 : 15, failed: 0 }, proofReference: { kind: 'proof', contractId: record.verificationContractId } }),
    commitCandidate: async ({ candidate, capability }) => commitAssembledState(candidate.worktreePath, { capability: capability.name || capability.slug }),
    disposeCandidate: async ({ candidate, reason }) => {
      disposals.push({ branch: candidate?.branch, reason });
      if (!candidate?.worktreePath) return;
      try { git(primary, ['worktree', 'remove', '--force', '--', candidate.worktreePath]); } catch { /* already gone */ }
      try { git(primary, ['branch', '-D', '--', candidate.branch]); } catch { /* already gone */ }
    },
  };
}
const CAPABILITY_B = { slug: 'feature-flags', name: 'Feature flags (GRAFT fixture test source)', capabilityId: 'sha256:capB', kind: 'feature-flags' };

test('a second capability composes onto the verified first: candidate cut from revision A, B verified, A re-verified, revision advances once', async (t) => {
  const work = sandbox(t);
  const { primary, workspace, revisionA, baseRevision, worktreeA } = assemblyWithA(work);
  assert.equal(workspace.currentRevision, revisionA);
  assert.notEqual(revisionA, baseRevision);
  // While planning B, A is visible as assembly evidence — no detector rediscovery required.
  const ready = checkCompositionReady(workspace);
  assert.deepEqual(ready, { ok: true, problems: [], fromRevision: revisionA, alreadyCurrent: ['hosted-authentication'] });
  assert.equal(dependencyEvidence(workspace, { capability: 'hosted-authentication' }).satisfied, true);
  assert.equal(capabilityPresence(workspace, { detected: [] })[0].presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  const s = steps(work, { primary });
  const beforeBranches = git(primary, ['branch', '--list']).split('\n').length;
  const result = await composeNextCapability(workspace, { capability: CAPABILITY_B, steps: s });
  assert.equal(result.composed, true, JSON.stringify(result.rejection));
  const candidate = s.created[0];
  // The candidate was cut from A's revision — and contained A's files before B was applied.
  assert.equal(candidate.headAtPrepare, revisionA, 'the candidate is cut from the current verified revision, not the base');
  assert.equal(git(primary, ['rev-parse', `${candidate.branch}~1`]), revisionA, 'the composed commit sits directly on revision A');
  assert.ok(fs.existsSync(path.join(candidate.worktreePath, 'src', 'auth', 'routes.js')), 'capability A is present in the candidate');
  assert.ok(fs.existsSync(path.join(candidate.worktreePath, 'src', 'flags', 'flags.js')), 'capability B was applied into the candidate');
  // The workspace advanced exactly once, to the combined revision.
  const revisionAB = workspace.currentRevision;
  assert.notEqual(revisionAB, revisionA);
  assert.equal(workspace.workingBranch, candidate.branch);
  assert.equal(s.disposals.length, 0, 'a successful composition disposes of nothing');
  // Ledger histories: A keeps where it was applied and gains its re-verification; B is applied at AB.
  const [a, b] = workspace.capabilities;
  assert.equal(a.capability, 'hosted-authentication');
  assert.equal(a.appliedRevision, revisionA);
  assert.equal(a.currentVerifiedRevision, revisionAB);
  assert.deepEqual(a.verificationHistory.map((h) => h.event), ['applied-and-verified', 're-verified-with']);
  assert.equal(a.verificationHistory[0].revision, revisionA, 'A’s original application history is not erased');
  assert.equal(a.verificationHistory[1].revision, revisionAB);
  assert.equal(a.verificationHistory[1].alongside, 'feature-flags');
  assert.equal(b.capability, 'feature-flags');
  assert.equal(b.appliedRevision, revisionAB);
  assert.equal(b.currentVerifiedRevision, revisionAB);
  assert.equal(b.kind, 'feature-flags');
  assert.equal(b.sourceVerification.verdict, 'VERIFIED');
  // Both CURRENT at the same revision.
  const evaluated = evaluateWorkspace(workspace);
  assert.deepEqual(evaluated.capabilities.map((c) => c.state), ['CURRENT', 'CURRENT']);
  assert.equal(new Set(evaluated.capabilities.map((c) => c.currentVerifiedRevision)).size, 1);
  // Composition evidence references the authoritative proofs and never claims a verified application.
  const e = result.evidence;
  assert.equal(e.evidenceVersion, COMPOSITION_EVIDENCE_VERSION);
  assert.equal(e.finalState, 'ALL_SELECTED_CAPABILITIES_VERIFIED');
  assert.equal(e.revision, revisionAB);
  assert.equal(e.capabilityRecords.length, 2);
  assert.deepEqual(e.verificationReferences.map((r) => r.contractId).sort(), ['sha256:contractA', 'sha256:contractB']);
  assert.equal(e.interactionsChecked[0].capability, 'hosted-authentication');
  assert.equal(e.interactionsChecked[0].verdict, 'VERIFIED');
  assert.equal(e.hostPreservation.failed, 0);
  assert.match(e.wording, /2 of 2 selected capabilities verified/);
  assert.match(e.wording, /not a claim that the application as a whole is verified/);
  // The person's own checkout is untouched until an explicit finalization.
  assert.equal(inspectRepo(primary).head, baseRevision);
  assert.equal(inspectRepo(primary).dirty, false);
  // The earlier A-only revision is still reachable.
  assert.equal(git(primary, ['rev-parse', revisionA]), revisionA);
  assert.ok(fs.existsSync(worktreeA));
  assert.ok(git(primary, ['branch', '--list']).split('\n').length > beforeBranches);
  saveAssemblyWorkspace(workspace);
  assert.equal(loadAssemblyWorkspace(workspace.assemblyWorkspaceId).capabilities.length, 2);
});

test('a candidate cut from the wrong revision is refused and disposed of before anything is applied', async (t) => {
  const work = sandbox(t);
  const { primary, workspace, revisionA, baseRevision } = assemblyWithA(work);
  const s = steps(work, { primary, outcomes: { cutFrom: baseRevision } });
  await assert.rejects(() => composeNextCapability(workspace, { capability: CAPABILITY_B, steps: s }), (e) => e.code === 'candidate-wrong-base');
  assert.equal(s.disposals.length, 1);
  assert.equal(s.disposals[0].reason, 'wrong base revision');
  assert.equal(workspace.currentRevision, revisionA, 'the assembly did not move');
  assert.equal(workspace.capabilities.length, 1);
});

test('every authoritative failure rejects the candidate and leaves revision A current: B failed, B inconclusive, A re-verification failed, host preservation failed', async (t) => {
  const work = sandbox(t);
  for (const [label, outcomes, stage] of [
    ['B reports FAILED', { bVerdict: 'FAILED' }, 'capability-verification'],
    ['B stays INCONCLUSIVE', { bVerdict: 'NEEDS_REVIEW' }, 'capability-verification'],
    ['A fails re-verification on the combined revision', { reverifyVerdict: 'FAILED' }, 'existing-capability-reverification'],
    ['A is inconclusive on the combined revision', { reverifyVerdict: 'NEEDS_REVIEW' }, 'existing-capability-reverification'],
    ['host preservation fails', { hostPreservation: { captured: true, tests: 2, passed: 1, failed: 1 } }, 'host-preservation'],
  ]) {
    const { primary, workspace, revisionA, baseRevision, worktreeA } = assemblyWithA(work);
    const s = steps(work, { primary, outcomes });
    const result = await composeNextCapability(workspace, { capability: CAPABILITY_B, steps: s });
    assert.equal(result.composed, false, label);
    assert.equal(result.rejection.stage, stage, label);
    assert.equal(result.rejection.disposed, true, label);
    // A remains exactly as it was; B is absent.
    assert.equal(workspace.currentRevision, revisionA, `${label}: the assembly stays at revision A`);
    assert.equal(workspace.capabilities.length, 1, `${label}: B did not enter the ledger`);
    assert.equal(workspace.capabilities[0].currentVerifiedRevision, revisionA, label);
    const evaluated = evaluateWorkspace(workspace);
    assert.equal(evaluated.capabilities[0].state, 'CURRENT', `${label}: A is still CURRENT`);
    assert.equal(evaluated.status, 'ACTIVE', label);
    // The candidate is gone; nothing was reset and the person's checkout never moved.
    assert.equal(s.disposals.length, 1, label);
    assert.equal(fs.existsSync(s.created[0].worktreePath), false, `${label}: the candidate worktree was disposed of`);
    assert.equal(git(primary, ['branch', '--list', s.created[0].branch]), '', `${label}: the candidate branch was removed`);
    assert.equal(inspectRepo(primary).head, baseRevision, label);
    assert.equal(inspectRepo(worktreeA).head, revisionA, `${label}: revision A is untouched and reachable`);
    assert.ok(fs.existsSync(path.join(worktreeA, 'src', 'auth', 'routes.js')), label);
    // The evidence for a rejected candidate stays on the prior revision and is never "all verified".
    assert.equal(result.evidence.finalState, 'CANDIDATE_REJECTED', label);
    assert.equal(result.evidence.revision, revisionA, label);
  }
});

test('composition refuses to start on a stale or dirty assembly, and the agent cannot advance it', async (t) => {
  const work = sandbox(t);
  const { primary, workspace, revisionA, worktreeA } = assemblyWithA(work);
  // Drift outside the Laboratory: the assembly is STALE, so nothing may be composed onto it.
  fs.appendFileSync(path.join(worktreeA, 'server.mjs'), '\n// hand edit\n');
  git(worktreeA, ['commit', '--quiet', '-am', 'hand edit']);
  const stale = checkCompositionReady(workspace);
  assert.equal(stale.ok, false);
  assert.match(stale.problems.join(' '), /STALE|not its recorded current revision/);
  await assert.rejects(() => composeNextCapability(workspace, { capability: CAPABILITY_B, steps: steps(work, { primary }) }), (e) => e.code === 'composition-not-ready');
  git(worktreeA, ['reset', '--hard', '--quiet', revisionA]);
  // Uncommitted work in the assembly: also refused.
  fs.writeFileSync(path.join(worktreeA, 'scratch.txt'), 'wip\n');
  assert.equal(checkCompositionReady(workspace).ok, false);
  fs.rmSync(path.join(worktreeA, 'scratch.txt'));
  assert.equal(checkCompositionReady(workspace).ok, true);
  // The agent may explain; it cannot advance, waive re-verification or promote a candidate.
  assert.throws(() => projectResponse('explainAssemblyPlan', { explanation: 'compose it', verified: true }), AuthorityViolation);
  const { value } = projectResponse('explainAssemblyPlan', { explanation: 'B is independent of A, so ordering is free.' });
  workspace.agentAdvice = { advisory: true, authoritative: false, value };
  assert.equal(workspace.currentRevision, revisionA);
  assert.equal(compositionEvidence(workspace).finalState, 'ALL_SELECTED_CAPABILITIES_VERIFIED', 'evidence still reflects only what the verifier decided');
  assert.equal(compositionEvidence(workspace).capabilityRecords.length, 1);
});
