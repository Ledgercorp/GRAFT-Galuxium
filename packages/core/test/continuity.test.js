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
import { createAssemblyWorkspace, recordAssembledCapability, commitAssembledState, evaluateWorkspace, capabilityPresence, dependencyEvidence, checkPromotion, promoteAssembly, saveAssemblyWorkspace, loadAssemblyWorkspace, listAssemblyWorkspaces, workspaceForProject, assemblyLocation, ASSEMBLY_WORKSPACE_SCHEMA_VERSION, LEDGER_STATES } from '../src/laboratory/continuity.js';
import { storedProofFor } from './helpers/proof.js';
import { loadProofArtifact } from '../src/laboratory/proof-store.js';
/** Proof Integrity 0.1: a CURRENT record cites a durable proof of the verification at its revision. */
const prove = (execution, revision) => ({ ...execution, proof: storedProofFor({ revision, capability: { slug: execution.verification?.capability || 'capability' } }) });

const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-cont-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
/** A created host, a managed worktree holding an applied-and-verified capability, and its execution record. */
function assembled(work, { verdict = 'VERIFIED', status = 'COMPLETED', preservationFailed = 0 } = {}) {
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const receipt = createHost({ parentDir: parent, name: `app-${crypto.randomUUID().slice(0, 6)}`, architectureId: 'node-esm-http-central' });
  const primary = receipt.root;
  const worktree = path.join(work, `wt-${path.basename(primary)}`);
  const branch = `graft/hosted-authentication-${crypto.randomUUID().slice(0, 8)}`;
  git(primary, ['worktree', 'add', '--quiet', '-b', branch, '--', worktree, receipt.initialCommit]);
  fs.mkdirSync(path.join(worktree, 'src', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'auth', 'routes.js'), 'export const registerAuth = () => ({ async handle() { return false; } });\n');
  fs.appendFileSync(path.join(worktree, 'server.mjs'), '\n// graft: hosted authentication\n');
  const execution = {
    executionId: 'exec-authenticated-application-000000-abcdef', planId: 'plan-x-000000-abcdef', blueprintId: 'authenticated-application-000000', blueprintName: 'Authenticated application',
    status, steps: [{ type: 'TRANSPLANT_CAPABILITY', status: 'DONE', finishedAt: '2026-09-12T00:00:00.000Z', outcome: { filesWritten: ['src/auth/routes.js'] } }],
    createdProject: { root: primary, name: receipt.projectName }, transplantId: 'e5501844', transplantPlan: { planId: 'graft-hosted-authentication-1', entrypoint: 'server.mjs' },
    capabilitySource: { kind: 'hosted-session-auth', genomeId: 'sha256:genome', irId: 'sha256:ir', sourceProject: '@leftsock/cuf', sourceRevision: 'ec1af9bb', sourceVerification: { verdict: 'VERIFIED', summary: { required: 13, passed: 13 } } },
    verification: { capability: 'hosted-authentication', capabilityId: 'sha256:cap', verdict, summary: { required: 15, passed: verdict === 'VERIFIED' ? 15 : 12, failed: 0 }, invariants: [{ id: 'sec.httponly', status: 'held' }, { id: 'sec.csrf', status: 'held' }], counterfactuals: [{ id: 'hosted.session.rejects-anonymous', outcome: 'passed' }] },
    hostPreservation: { captured: true, tests: 2, passed: 2 - preservationFailed, failed: preservationFailed },
    proofReferences: [{ kind: 'transplant-record', transplantId: 'e5501844' }, { kind: 'proof', contractId: 'sha256:contract', summary: { cases: 12, passed: 12 } }],
  };
  return { primary, worktree, branch, receipt, execution };
}

test('a workspace opens over the created project, the verified state becomes a commit, and the ledger records what GRAFT applied', (t) => {
  const work = sandbox(t);
  const { primary, worktree, branch, receipt, execution } = assembled(work);
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: { name: receipt.projectName, repositoryId: 'git:test' }, baseRevision: receipt.initialCommit, workingBranch: branch, primaryBranch: 'main', worktreePath: worktree, primaryRoot: primary, hostId: receipt.fingerprint.hostId });
  assert.equal(workspace.schemaVersion, ASSEMBLY_WORKSPACE_SCHEMA_VERSION);
  assert.match(workspace.assemblyWorkspaceId, /^asm-authenticated-application-000000-[0-9a-f]{6}$/);
  assert.equal(workspace.currentRevision, receipt.initialCommit);
  assert.equal(workspace.capabilities.length, 0);
  // The verified working tree becomes one commit on the managed branch; the created checkout is untouched.
  const committed = commitAssembledState(worktree, { capability: 'Hosted sign-in' });
  assert.equal(committed.committed, true);
  assert.notEqual(committed.revision, receipt.initialCommit);
  assert.equal(inspectRepo(primary).head, receipt.initialCommit, 'the person’s checkout did not move');
  assert.equal(inspectRepo(worktree).dirty, false);
  assert.equal(commitAssembledState(worktree, { capability: 'x' }).committed, false, 'a clean worktree commits nothing');
  const record = recordAssembledCapability(workspace, { execution: prove(execution, committed.revision), revisionBefore: receipt.initialCommit, revisionAfter: committed.revision });
  assert.equal(record.state, 'CURRENT');
  assert.ok(LEDGER_STATES.includes(record.state));
  assert.equal(record.capability, 'hosted-authentication');
  assert.equal(record.capabilityId, 'sha256:cap');
  assert.equal(record.kind, 'hosted-session-auth');
  assert.equal(record.genomeId, 'sha256:genome'); assert.equal(record.irId, 'sha256:ir');
  assert.equal(record.sourceRevision, 'ec1af9bb'); assert.equal(record.sourceVerification.verdict, 'VERIFIED');
  assert.equal(record.destinationRevisionBefore, receipt.initialCommit);
  assert.equal(record.destinationRevisionAfter, committed.revision);
  assert.equal(record.verificationContractId, 'sha256:contract');
  assert.equal(record.verificationVerdict, 'VERIFIED');
  assert.deepEqual(record.invariantSummary, { held: 2, violated: 0, unobserved: 0 });
  assert.deepEqual(record.counterfactualSummary, { cases: 1, passed: 1 });
  assert.equal(record.hostPreservation.failed, 0);
  assert.equal(record.transplantId, 'e5501844');
  assert.deepEqual(record.proofReference, { kind: 'proof', contractId: 'sha256:contract', summary: { cases: 12, passed: 12 }, envelopeSchema: 'graft-proof-envelope/1', envelopeDigest: record.proofReference.envelopeDigest });
  assert.match(record.proofReference.envelopeDigest, /^[0-9a-f]{64}$/, 'the ledger cites the durable proof by digest, never by path');
  assert.equal(workspace.currentRevision, committed.revision);
  // Persistence: atomic, reopenable, listed, findable by project, private.
  saveAssemblyWorkspace(workspace);
  assert.deepEqual(fs.readdirSync(path.join(work, 'home', 'laboratory', 'assemblies')), [`${workspace.assemblyWorkspaceId}.json`]);
  assert.equal(loadAssemblyWorkspace(workspace.assemblyWorkspaceId).capabilities.length, 1);
  assert.equal(listAssemblyWorkspaces({ blueprintId: execution.blueprintId })[0].assemblyWorkspaceId, workspace.assemblyWorkspaceId);
  assert.equal(workspaceForProject(primary).assemblyWorkspaceId, workspace.assemblyWorkspaceId);
  assert.throws(() => saveAssemblyWorkspace({ ...workspace, capabilities: [{ ...record, apiKey: 'sk_live_x' }] }), (e) => e.code === 'workspace-privacy');
  assert.equal(assemblyLocation(workspace).kind, 'worktree');
});

test('only a completed, VERIFIED, host-preserving capability may enter the ledger', (t) => {
  const work = sandbox(t);
  for (const [label, options, code] of [
    ['a FAILED verdict', { verdict: 'FAILED' }, 'not-verified'],
    ['an INCONCLUSIVE verdict', { verdict: 'NEEDS_REVIEW' }, 'not-verified'],
    ['an execution that did not complete', { status: 'INCONCLUSIVE' }, 'execution-not-completed'],
    ['a failed host-preservation check', { preservationFailed: 1 }, 'host-preservation-failed'],
  ]) {
    const { primary, worktree, branch, receipt, execution } = assembled(work, options);
    const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: { name: receipt.projectName }, baseRevision: receipt.initialCommit, workingBranch: branch, worktreePath: worktree, primaryRoot: primary, hostId: 'h' });
    const committed = commitAssembledState(worktree, { capability: 'x' });
    assert.throws(() => recordAssembledCapability(workspace, { execution: prove(execution, committed.revision), revisionBefore: receipt.initialCommit, revisionAfter: committed.revision }), (e) => e.code === code, label);
    assert.equal(workspace.capabilities.length, 0, `${label} leaves the ledger empty`);
  }
  const { primary, worktree, branch, receipt, execution } = assembled(work);
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: {}, baseRevision: receipt.initialCommit, workingBranch: branch, worktreePath: worktree, primaryRoot: primary, hostId: 'h' });
  assert.throws(() => recordAssembledCapability(workspace, { execution, revisionBefore: receipt.initialCommit, revisionAfter: null }), (e) => e.code === 'no-revision');
  assert.throws(() => recordAssembledCapability(workspace, { execution: { ...execution, verification: null }, revisionBefore: 'a', revisionAfter: 'b' }), (e) => e.code === 'no-verification');
});

test('assembly evidence and detector observation are separate: neither erases nor replaces the other, and drift makes evidence STALE', (t) => {
  const work = sandbox(t);
  const { primary, worktree, branch, receipt, execution } = assembled(work);
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: {}, baseRevision: receipt.initialCommit, workingBranch: branch, primaryBranch: 'main', worktreePath: worktree, primaryRoot: primary, hostId: 'h' });
  const committed = commitAssembledState(worktree, { capability: 'Hosted sign-in' });
  recordAssembledCapability(workspace, { execution: prove(execution, committed.revision), revisionBefore: receipt.initialCommit, revisionAfter: committed.revision });
  // Detector sees nothing: the capability is still present by assembly evidence, and says so plainly.
  const unseen = capabilityPresence(workspace, { detected: [] })[0];
  assert.equal(unseen.presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  assert.equal(unseen.independentDetection, 'not observed');
  assert.equal(unseen.assemblyEvidence.verdict, 'VERIFIED');
  assert.match(unseen.explanation, /Added and verified by GRAFT/);
  // Detector sees it: evidence is unchanged, proof is not replaced by the observation.
  const seen = capabilityPresence(workspace, { detected: [{ category: 'hosted-authentication' }] })[0];
  assert.equal(seen.presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  assert.equal(seen.independentDetection, 'observed');
  assert.equal(seen.assemblyEvidence.proofReference.contractId, 'sha256:contract');
  // A CURRENT capability is evidence a later dependency may use; an agent's claim never is.
  assert.equal(dependencyEvidence(workspace, { capability: 'hosted-authentication' }).satisfied, true);
  assert.equal(dependencyEvidence(workspace, { capability: 'hosted-authentication' }).source, 'assembly-evidence');
  assert.equal(dependencyEvidence(workspace, { capability: 'billing' }).satisfied, false);
  // Drift outside the Laboratory: the branch moves, so the record is STALE and satisfies nothing.
  fs.appendFileSync(path.join(worktree, 'server.mjs'), '\n// a person edited this\n');
  git(worktree, ['commit', '--quiet', '-am', 'hand edit']);
  const drifted = evaluateWorkspace(workspace);
  assert.equal(drifted.capabilities[0].state, 'STALE');
  assert.match(drifted.capabilities[0].stateReason, /moved to [0-9a-f]{12} after this capability was verified/);
  assert.equal(drifted.status, 'STALE');
  // Proof Integrity 0.1: the proof for the earlier revision is untouched by drift and still names that revision.
  const proofAfterDrift = loadProofArtifact(drifted.capabilities[0].proofReference.envelopeDigest);
  assert.equal(proofAfterDrift.intact, true); assert.equal(proofAfterDrift.envelope.payload.destination.revision, workspace.capabilities[0].destinationRevisionAfter);
  assert.equal(dependencyEvidence(workspace, { capability: 'hosted-authentication' }).satisfied, false, 'a STALE capability satisfies nothing');
  const staleSeen = capabilityPresence(workspace, { detected: [{ category: 'hosted-authentication' }] })[0];
  assert.equal(staleSeen.presence, 'OBSERVED_BY_DETECTOR', 'a detector observation never restores stale assembly evidence');
  // A vanished working tree is STALE too, never silently CURRENT.
  assert.equal(evaluateWorkspace(workspace, { observedRevision: null }).capabilities[0].state, 'STALE');
});

test('promotion is explicit, fast-forward only, and refuses drift, dirt, staleness and unverified work', (t) => {
  const work = sandbox(t);
  const { primary, worktree, branch, receipt, execution } = assembled(work);
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: {}, baseRevision: receipt.initialCommit, workingBranch: branch, primaryBranch: 'main', worktreePath: worktree, primaryRoot: primary, hostId: 'h' });
  const committed = commitAssembledState(worktree, { capability: 'Hosted sign-in' });
  recordAssembledCapability(workspace, { execution: prove(execution, committed.revision), revisionBefore: receipt.initialCommit, revisionAfter: committed.revision });
  const reflogBefore = git(primary, ['rev-list', '--count', 'HEAD']);
  // Refusals first, each leaving the checkout exactly where it was.
  const dirtyFile = path.join(primary, 'notes.md'); fs.writeFileSync(dirtyFile, 'my work\n');
  assert.match(checkPromotion(workspace, { execution }).problems.join(' '), /uncommitted change/);
  assert.throws(() => promoteAssembly(workspace, { execution }), (e) => e.code === 'promotion-refused');
  fs.rmSync(dirtyFile);
  const unverified = checkPromotion(workspace, { execution: { ...execution, verification: { ...execution.verification, verdict: 'NEEDS_REVIEW' } } });
  assert.equal(unverified.ok, false); assert.match(unverified.problems.join(' '), /NEEDS_REVIEW/);
  assert.equal(checkPromotion(workspace, { execution: { ...execution, status: 'INCONCLUSIVE' } }).ok, false);
  // Primary moved: refuse (no force, no reset).
  fs.writeFileSync(path.join(primary, 'README.md'), '# changed by the person\n');
  git(primary, ['commit', '--quiet', '-am', 'person commit']);
  const moved = checkPromotion(workspace, { execution });
  assert.equal(moved.ok, false);
  assert.match(moved.problems.join(' '), /moved from|not an ancestor/);
  assert.throws(() => promoteAssembly(workspace, { execution }), (e) => e.code === 'promotion-refused');
  git(primary, ['reset', '--hard', '--quiet', receipt.initialCommit]);
  // Stale assembly: refuse.
  fs.appendFileSync(path.join(worktree, 'server.mjs'), '\n// drift\n');
  git(worktree, ['commit', '--quiet', '-am', 'drift']);
  assert.match(checkPromotion(workspace, { execution }).problems.join(' '), /STALE|not the verified/);
  git(worktree, ['reset', '--hard', '--quiet', committed.revision]);
  // Now it promotes: fast-forward, history preserved, no remote, nothing forced.
  assert.equal(checkPromotion(workspace, { execution }).ok, true, JSON.stringify(checkPromotion(workspace, { execution }).problems));
  const { promotion } = promoteAssembly(workspace, { execution });
  assert.equal(promotion.kind, 'fast-forward'); assert.equal(promotion.forced, false); assert.deepEqual(promotion.remotesContacted, []);
  assert.equal(promotion.fromRevision, receipt.initialCommit); assert.equal(promotion.toRevision, committed.revision);
  const after = inspectRepo(primary);
  assert.equal(after.head, committed.revision, 'the created project now holds the assembled application');
  assert.equal(after.branch, 'main'); assert.equal(after.dirty, false);
  assert.equal(git(primary, ['rev-list', '--count', 'HEAD']), String(Number(reflogBefore) + 1), 'the blank-host commit remains in history');
  assert.equal(git(primary, ['rev-parse', `${committed.revision}^`]), receipt.initialCommit);
  assert.equal(git(primary, ['remote']), '', 'no remote was configured or contacted');
  assert.ok(fs.existsSync(path.join(primary, 'src', 'auth', 'routes.js')), 'the capability is in the person’s checkout');
  assert.equal(workspace.status, 'FINALIZED');
  // Finalized once only, and the ledger stays CURRENT when read from the promoted checkout.
  assert.throws(() => promoteAssembly(workspace, { execution }), (e) => e.code === 'promotion-refused');
  saveAssemblyWorkspace(workspace);
  const reopened = evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId));
  assert.equal(reopened.capabilities[0].state, 'CURRENT');
  assert.equal(reopened.status, 'FINALIZED');
  // The managed worktree may now be cleaned up; ledger and proof references survive it.
  git(primary, ['worktree', 'remove', '--force', '--', worktree]);
  git(primary, ['branch', '-D', '--', branch]);
  const afterCleanup = evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId));
  assert.equal(afterCleanup.observed.location, 'primary');
  assert.equal(afterCleanup.capabilities[0].state, 'CURRENT', 'cleanup does not invalidate the ledger');
  assert.equal(afterCleanup.capabilities[0].proofReference.contractId, 'sha256:contract');
  assert.equal(dependencyEvidence(loadAssemblyWorkspace(workspace.assemblyWorkspaceId), { capability: 'hosted-authentication' }).satisfied, true);
});

test('the agent cannot mark a ledger entry current, claim presence or finalize anything', (t) => {
  const work = sandbox(t);
  const { primary, worktree, branch, receipt, execution } = assembled(work);
  const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: {}, baseRevision: receipt.initialCommit, workingBranch: branch, worktreePath: worktree, primaryRoot: primary, hostId: 'h' });
  const committed = commitAssembledState(worktree, { capability: 'x' });
  recordAssembledCapability(workspace, { execution: prove(execution, committed.revision), revisionBefore: receipt.initialCommit, revisionAfter: committed.revision });
  fs.appendFileSync(path.join(worktree, 'server.mjs'), '\n// drift\n'); git(worktree, ['commit', '--quiet', '-am', 'drift']);
  assert.throws(() => projectResponse('explainAssemblyPlan', { explanation: 'it is fine', verified: true }), AuthorityViolation);
  const { value } = projectResponse('explainAssemblyPlan', { explanation: 'The detector cannot see it; GRAFT applied it.', tradeoffs: ['finalize when ready'] });
  assert.equal(value.explanation.length > 0, true);
  workspace.agentAdvice = { advisory: true, authoritative: false, value };
  assert.equal(evaluateWorkspace(workspace).capabilities[0].state, 'STALE', 'advice changes no ledger state');
  assert.equal(checkPromotion(workspace, { execution }).ok, false, 'advice cannot make a stale assembly promotable');
});
