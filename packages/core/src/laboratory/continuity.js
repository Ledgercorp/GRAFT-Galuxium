// Laboratory 0.3.5 — Assembly Continuity.
//
// 0.3 assembled one capability into a new application, but left two gaps: the verified result lived
// only as uncommitted changes in a GRAFT-managed worktree, and nothing recorded — authoritatively —
// that GRAFT had put the capability there. This module closes both.
//
//   1. `LaboratoryAssemblyWorkspace`: the evolving application a future assembly step operates on.
//      One workspace per assembled project, carrying its repository identity, the revision it
//      started from, the revision it is at now, its working branch, and its capability ledger.
//
//   2. The `AssemblyLedger`: `AssemblyCapabilityRecord`s for capabilities GRAFT itself applied and
//      the verifier itself passed. The ledger is not a proof — it REFERENCES the authoritative
//      proof, contract, receipt and transplant record, and copies only the verdict and summaries.
//      A capability enters it only after a successful apply and a VERIFIED verdict.
//
//   3. Safe finalization: committing the verified state in the managed worktree, and promoting it
//      into the person's own checkout by fast-forward only, never by force or reset.
//
// Evidence sources stay separate and are never merged into one claim:
//
//   PRESENT_BY_ASSEMBLY_EVIDENCE  GRAFT applied it and the verifier passed it, at a known revision
//   OBSERVED_BY_DETECTOR          Capability Memory's heuristics recognise it in the code
//   CLAIMED_BY_AGENT              an agent said so — never evidence
//
// A detector that cannot see an implementation does not erase assembly evidence, and a detector
// that can see one does not replace proof.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { graftHome } from '../registry/index.js';
import { loadProofArtifact } from './proof-store.js';
import { inspectRepo, samePath } from '../apply/git.js';

export const ASSEMBLY_WORKSPACE_SCHEMA_VERSION = '1.0.0';
export const LEDGER_STATES = Object.freeze(['CURRENT', 'STALE', 'INVALIDATED']);
export const WORKSPACE_STATES = Object.freeze(['ACTIVE', 'FINALIZED', 'STALE', 'CLEANED']);
export const PRESENCE = Object.freeze(['PRESENT_BY_ASSEMBLY_EVIDENCE', 'OBSERVED_BY_DETECTOR', 'CLAIMED_BY_AGENT', 'NOT_PRESENT']);
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
// Every git call is argv-only (no shell) with GRAFT's own identity, so a person's git config cannot
// sign, hook or rewrite what the Laboratory commits.
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=GRAFT Laboratory', '-c', 'user.email=laboratory@graft.local', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---------------------------------------------------------------------------------------------
// The workspace and its ledger.
// ---------------------------------------------------------------------------------------------
export function createAssemblyWorkspace({ execution, repositoryIdentity, baseRevision, workingBranch, primaryBranch = 'main', worktreePath, primaryRoot, hostId, now = () => new Date().toISOString() }) {
  const at = now();
  return {
    schemaVersion: ASSEMBLY_WORKSPACE_SCHEMA_VERSION,
    assemblyWorkspaceId: `asm-${execution.blueprintId}-${crypto.randomBytes(3).toString('hex')}`,
    blueprintId: execution.blueprintId, blueprintName: execution.blueprintName, planId: execution.planId, executionIds: [execution.executionId],
    createdProjectId: execution.createdProject?.name || null, repositoryIdentity,
    baseRevision, currentRevision: baseRevision, workingBranch, primaryBranch,
    // Locations are local facts the product needs to open the application; identity above is portable.
    locations: { worktree: worktreePath, primary: primaryRoot },
    hostId, capabilities: [], status: 'ACTIVE', finalization: null, createdAt: at, updatedAt: at,
  };
}

const DIGEST = /^[0-9a-f]{64}$/;
/**
 * Proof Integrity 0.1: a CURRENT record cites the durable proof that earned it. The reference is a
 * digest (never a path); the artifact it names must exist in the proof store, read back intact,
 * and bind exactly the revision the record is about. The ledger does not hold the proof and does
 * not read a verdict from it — the verdict gate above stays the verifier's — it only refuses to
 * become CURRENT on a claim whose evidence binding is not durable.
 */
function proofProblem(proof, revision, name, slug = null) {
  if (!proof || !DIGEST.test(proof.envelopeDigest || '')) return `${name}: no durable proof envelope digest`;
  if (proof.envelopeSchema !== 'graft-proof-envelope/1') return `${name}: unsupported proof envelope schema ${JSON.stringify(proof.envelopeSchema ?? null)}`;
  const stored = loadProofArtifact(proof.envelopeDigest);
  if (!stored.found) return `${name}: the proof artifact ${proof.envelopeDigest.slice(0, 12)} is not in the proof store`;
  if (!stored.intact) return `${name}: the proof artifact ${proof.envelopeDigest.slice(0, 12)} is not intact (${stored.reasons.join('; ')})`;
  const bound = stored.envelope?.payload?.destination?.revision ?? null;
  if (bound !== revision) return `${name}: the stored proof binds destination revision ${String(bound).slice(0, 12)}, not ${String(revision).slice(0, 12)}`;
  const claimed = stored.envelope?.payload?.capability?.slug ?? null;
  if (slug && claimed !== slug) return `${name}: the stored proof is about ${claimed || 'another capability'}, not ${slug}`;
  return null;
}

/**
 * Add a capability to the ledger. Only a capability GRAFT applied, whose apply completed and whose
 * authoritative verification returned VERIFIED with host preservation intact, may enter as CURRENT.
 * Anything else is refused: the ledger never carries a capability the verifier did not pass.
 * `execution.proof` = { envelopeSchema, envelopeDigest } names the durable proof of the verification
 * AT `revisionAfter` (the stored envelope must bind that revision); without one, nothing enters.
 */
export function recordAssembledCapability(workspace, { execution, revisionBefore, revisionAfter, now = () => new Date().toISOString() }) {
  const v = execution.verification;
  if (!v) throw fail('no-verification', 'A capability enters the ledger only with an authoritative verification result.');
  if (execution.status !== 'COMPLETED') throw fail('execution-not-completed', `The execution is ${execution.status}; only a completed assembly records a capability.`);
  if (v.verdict !== 'VERIFIED') throw fail('not-verified', `Verification reported ${v.verdict}; only VERIFIED enters the ledger.`);
  if (execution.hostPreservation && execution.hostPreservation.failed > 0) throw fail('host-preservation-failed', 'Host preservation failed; the capability does not enter the ledger.');
  // Probes that ran without a captured baseline prove nothing: they kept generic expectations
  // instead of the destination's own answers, so a pass there is not evidence of preservation.
  if (execution.hostPreservation && execution.hostPreservation.captured === false && (execution.hostPreservation.tests || 0) > 0) throw fail('host-preservation-not-captured', 'Host preservation ran without a baseline captured before the change, so it proves nothing; the capability does not enter the ledger.');
  if (!revisionAfter) throw fail('no-revision', 'The resulting revision must be known before a capability enters the ledger.');
  const proofFault = proofProblem(execution.proof, revisionAfter, v.capability || 'the capability', v.capability || null);
  if (proofFault) throw fail('proof-not-durable', `${proofFault}; a capability enters the ledger only with a durable proof of its verification at this revision.`);
  // A library capability is added by an adaptation step, not a transplant; both are the step that
  // applied the capability, and the ledger record is about what was applied either way.
  const step = execution.steps.find((s) => s.type === 'TRANSPLANT_CAPABILITY' || s.type === 'ADAPT_LIBRARY_CAPABILITY');
  const proof = (execution.proofReferences || []).find((r) => r.kind === 'proof') || null;
  const record = {
    capabilityId: v.capabilityId, capability: v.capability, kind: execution.capabilitySource?.kind || null,
    genomeId: execution.capabilitySource?.genomeId || null, irId: execution.capabilitySource?.irId || null, artifactId: execution.transplantPlan?.planId || null,
    sourceRevision: execution.capabilitySource?.sourceRevision || null, sourceVerification: execution.capabilitySource?.sourceVerification || null,
    destinationRevisionBefore: revisionBefore, destinationRevisionAfter: revisionAfter,
    // 0.4a: where the capability was applied, where it is currently verified, and how it got there.
    // A later composition re-verifies it at the combined revision without erasing this history.
    appliedRevision: revisionAfter, currentVerifiedRevision: revisionAfter,
    verificationContractId: proof?.contractId || null, verificationVerdict: v.verdict, verificationSummary: v.summary || null,
    invariantSummary: { held: (v.invariants || []).filter((i) => i.status === 'held').length, violated: (v.invariants || []).filter((i) => i.status === 'violated').length, unobserved: (v.invariants || []).filter((i) => i.status === 'unobserved').length },
    counterfactualSummary: { cases: (v.counterfactuals || []).length, passed: (v.counterfactuals || []).filter((c) => c.outcome === 'passed').length },
    hostPreservation: execution.hostPreservation || null,
    transplantId: execution.transplantId, filesWritten: step?.outcome?.filesWritten || null,
    proofReference: { ...(proof || {}), envelopeSchema: execution.proof.envelopeSchema, envelopeDigest: execution.proof.envelopeDigest }, executionId: execution.executionId,
    // How the capability got here. A service is emitted from its IR; a library is carried across as
    // its own artifact with a generated adapter. Recorded so the ledger never implies the wrong one.
    implementationForm: execution.capabilitySource?.implementationForm || 'service',
    ...(execution.adaptation ? { adaptation: {
      id: execution.adaptation.id, method: execution.adaptation.method,
      artifact: execution.adaptation.artifact, artifactSha256: execution.adaptation.artifactSha256,
      adapter: execution.adaptation.adapter, hostProfile: execution.adaptation.hostProfile,
      destinationContract: execution.adaptation.destinationContract || null,
      licence: execution.adaptation.licence || null, upstream: execution.adaptation.upstream || null,
      // The independent detectors and GRAFT's own evidence are two different claims, kept apart.
      detectorObservation: execution.adaptation.detectorObservation || null,
    } } : {}),
    appliedAt: step?.finishedAt || now(), state: 'CURRENT', stateReason: 'applied by GRAFT and verified at this revision',
  };
  record.verificationHistory = [{ event: 'applied-and-verified', revision: revisionAfter, verdict: v.verdict, summary: v.summary || null, at: record.appliedAt }];
  workspace.capabilities.push(record);
  workspace.currentRevision = revisionAfter;
  workspace.updatedAt = now();
  return record;
}

/**
 * The ledger transition for a COMPOSITION: every requested capability becomes CURRENT together,
 * at one final revision, or none does. Everything is checked before anything is assigned, so a
 * refusal leaves the workspace exactly as it was; the assignment itself is one statement, so no
 * in-memory observer sees a ledger with some capabilities CURRENT and others not. Persistence
 * (`saveAssemblyWorkspace`) is already atomic, so the file is either the old ledger or the new one.
 */
export function commitLedgerTransition(workspace, { records, revision, now = () => new Date().toISOString() }) {
  const problems = [];
  if (!Array.isArray(records) || !records.length) problems.push('a composition records at least one capability');
  if (!revision) problems.push('the final combined revision must be known');
  for (const r of records || []) {
    const name = r.capability || r.capabilityId || 'a capability';
    if (r.verificationVerdict !== 'VERIFIED') problems.push(`${name}: final verification is ${r.verificationVerdict || 'absent'}, not VERIFIED`);
    if (r.currentVerifiedRevision !== revision) problems.push(`${name}: verified at ${String(r.currentVerifiedRevision).slice(0, 12)}, not the final revision ${String(revision).slice(0, 12)}`);
    if (r.destinationRevisionAfter !== revision) problems.push(`${name}: destination revision after is ${String(r.destinationRevisionAfter).slice(0, 12)}, not the final revision ${String(revision).slice(0, 12)}`);
    if (!r.hostPreservation || r.hostPreservation.failed > 0) problems.push(`${name}: host preservation ${r.hostPreservation ? 'failed' : 'is absent'}`);
    if (r.hostPreservation && !(r.hostPreservation.tests > 0)) problems.push(`${name}: no host-preservation probe was observed, so preservation is not proven`);
    if (r.hostPreservation && r.hostPreservation.captured === false) problems.push(`${name}: host preservation ran without a captured baseline, so it proves nothing`);
    if (!r.capabilityId) problems.push(`${name}: no capability id`);
    const proofFault = proofProblem(r.proofReference, revision, name, r.capability || null);
    if (proofFault) problems.push(proofFault);
  }
  const ids = (records || []).map((r) => r.capabilityId);
  if (new Set(ids).size !== ids.length) problems.push('a capability appears twice in the transition');
  if (workspace.capabilities?.length) problems.push('the ledger already holds capabilities; a composition transition starts from an empty ledger');
  if (problems.length) throw fail('ledger-transition-refused', problems.join('; '));
  const at = now();
  workspace.capabilities = records.map((r) => ({ ...r, state: 'CURRENT' }));
  workspace.currentRevision = revision;
  workspace.updatedAt = at;
  return workspace;
}

/**
 * Revision binding, deterministically and without reading any source: a record is CURRENT while the
 * working branch still stands exactly where the capability was verified. If the application moved
 * without a later authoritative Laboratory step, the record becomes STALE — never silently CURRENT.
 */
export function evaluateWorkspace(workspace, { observedRevision = undefined, observedDirty = undefined } = {}) {
  const revision = observedRevision === undefined ? currentRevisionOf(workspace) : observedRevision;
  const capabilities = workspace.capabilities.map((record) => {
    if (record.state === 'INVALIDATED') return record;
    if (revision === null) return { ...record, state: 'STALE', stateReason: 'the assembled working tree is no longer present' };
    // Binding is to where the capability is CURRENTLY verified: its own revision, or the combined
    // revision a later composition re-verified it at.
    const verifiedAt = record.currentVerifiedRevision || record.destinationRevisionAfter;
    if (verifiedAt === revision) return { ...record, state: 'CURRENT', stateReason: record.stateReason?.startsWith('applied at') ? record.stateReason : 'the assembly is at the revision this capability was verified at' };
    return { ...record, state: 'STALE', stateReason: `the assembly moved to ${revision.slice(0, 12)} after this capability was verified at ${verifiedAt.slice(0, 12)}, with no later authoritative Laboratory step` };
  });
  const dirty = observedDirty === undefined ? dirtyOf(workspace) : observedDirty;
  const location = assemblyLocation(workspace);
  const drifted = capabilities.some((c) => c.state === 'STALE');
  const status = workspace.status === 'CLEANED' || workspace.status === 'FINALIZED' ? workspace.status : drifted ? 'STALE' : 'ACTIVE';
  return { ...workspace, capabilities, status, observed: { revision, dirty, uncommittedChanges: dirty, location: location.kind, root: location.root } };
}
/**
 * Where the assembly authoritatively lives: the managed worktree until it is finalized, the
 * person's own checkout afterwards (the worktree may then be cleaned up through the normal path).
 */
export function assemblyLocation(workspace) {
  const finalized = workspace.status === 'FINALIZED';
  const primary = workspace.locations?.primary, worktree = workspace.locations?.worktree;
  const order = finalized ? [['primary', primary], ['worktree', worktree]] : [['worktree', worktree], ['primary', primary]];
  for (const [kind, root] of order) if (root && fs.existsSync(root)) { const repo = inspectRepo(root); if (repo.isRepo) return { kind, root, repo }; }
  return { kind: null, root: null, repo: null };
}
const currentRevisionOf = (workspace) => assemblyLocation(workspace).repo?.head ?? null;
const dirtyOf = (workspace) => assemblyLocation(workspace).repo?.dirty ?? null;

/**
 * What GRAFT can say about a capability in this assembly, from both evidence sources, kept apart.
 * `detected` is whatever Capability Memory's detectors independently observed — never fabricated.
 */
export function capabilityPresence(workspace, { detected = [] } = {}) {
  const evaluated = evaluateWorkspace(workspace);
  return evaluated.capabilities.map((record) => {
    const observedByDetector = detected.some((d) => d === record.capability || d === record.kind || (typeof d === 'object' && (d.category === record.capability || d.category === record.kind)));
    return {
      capability: record.capability, capabilityId: record.capabilityId,
      presence: record.state === 'CURRENT' ? 'PRESENT_BY_ASSEMBLY_EVIDENCE' : observedByDetector ? 'OBSERVED_BY_DETECTOR' : 'NOT_PRESENT',
      assemblyEvidence: { state: record.state, reason: record.stateReason, verdict: record.verificationVerdict, summary: record.verificationSummary, revision: record.destinationRevisionAfter, contractId: record.verificationContractId, proofReference: record.proofReference, appliedAt: record.appliedAt },
      independentDetection: observedByDetector ? 'observed' : 'not observed',
      explanation: record.state === 'CURRENT' && !observedByDetector
        ? 'Added and verified by GRAFT. The workspace detector does not independently recognize this implementation.'
        : record.state === 'CURRENT' ? 'Added and verified by GRAFT, and independently recognized by the workspace detector.'
          : observedByDetector ? 'The workspace detector recognizes an implementation, but GRAFT’s assembly evidence is no longer current.' : 'GRAFT’s assembly evidence is no longer current for this capability.',
    };
  });
}

/**
 * Prepared for 0.4 and nothing more: a later capability's dependency may be satisfied by assembly
 * evidence only while that evidence is CURRENT. An agent's claim never satisfies anything.
 */
export function dependencyEvidence(workspace, { capability = null, capabilityId = null } = {}) {
  const evaluated = evaluateWorkspace(workspace);
  const record = evaluated.capabilities.find((c) => (capabilityId && c.capabilityId === capabilityId) || (capability && c.capability === capability));
  if (!record) return { satisfied: false, source: null, reason: 'no assembly evidence for this capability' };
  if (record.state !== 'CURRENT') return { satisfied: false, source: 'assembly-evidence', state: record.state, reason: record.stateReason };
  return { satisfied: true, source: 'assembly-evidence', state: 'CURRENT', reason: record.stateReason, verdict: record.verificationVerdict, revision: record.destinationRevisionAfter, proofReference: record.proofReference };
}

// ---------------------------------------------------------------------------------------------
// Committing the verified state, and promoting it into the person's own checkout.
// ---------------------------------------------------------------------------------------------
/** Commit whatever the verified assembly produced, in the managed worktree, on its own branch. */
export function commitAssembledState(worktreePath, { capability, message = null }) {
  const repo = inspectRepo(worktreePath);
  if (!repo.isRepo) throw fail('not-a-repository', 'The assembled worktree is not a Git repository.');
  if (!repo.dirty) return { revision: repo.head, committed: false, reason: 'nothing to commit' };
  git(worktreePath, ['add', '--all']);
  git(worktreePath, ['commit', '--quiet', '--no-verify', '-m', message || `Add ${capability}: applied and verified by GRAFT Laboratory`]);
  return { revision: git(worktreePath, ['rev-parse', 'HEAD']), committed: true, reason: null };
}

/**
 * Everything that must hold before the person's own checkout may move. Each refusal names what
 * changed; none of them is overridable, and none of them writes anything.
 */
export function checkPromotion(workspace, { execution = null } = {}) {
  const problems = [];
  const evaluated = evaluateWorkspace(workspace);
  const primary = workspace.locations?.primary, worktree = workspace.locations?.worktree;
  if (workspace.status === 'FINALIZED') problems.push('this assembly has already been finalized');
  if (workspace.status === 'CLEANED') problems.push('this assembly workspace has been cleaned up');
  if (!worktree || !fs.existsSync(worktree)) problems.push('the assembled worktree is no longer present');
  if (!primary || !fs.existsSync(primary)) problems.push('the created project folder is no longer present');
  if (execution) {
    if (execution.status !== 'COMPLETED') problems.push(`the assembly execution ended ${execution.status}, not COMPLETED`);
    if (execution.composition) {
      // A composition is promotable only as a whole: every capability final-verified at the one
      // revision the workspace stands at.
      if (execution.composition.finalState !== 'ALL_SELECTED_CAPABILITIES_VERIFIED') problems.push(`the composition ended ${execution.composition.finalState || 'without a final state'}, not ALL_SELECTED_CAPABILITIES_VERIFIED`);
      if (execution.composition.finalRevision !== workspace.currentRevision) problems.push(`the composition's final revision ${String(execution.composition.finalRevision).slice(0, 12)} is not the workspace's current revision ${String(workspace.currentRevision).slice(0, 12)}`);
      for (const c of execution.composition.capabilities || []) if (c.finalVerdict !== 'VERIFIED') problems.push(`${c.capability} final verification reported ${c.finalVerdict || 'nothing'}, not VERIFIED`);
      const recorded = new Set(evaluated.capabilities.map((c) => c.capabilityId));
      for (const c of execution.composition.capabilities || []) if (!recorded.has(c.capabilityId)) problems.push(`${c.capability} is not in the ledger`);
    } else if (execution.verification?.verdict !== 'VERIFIED') problems.push(`verification reported ${execution.verification?.verdict || 'nothing'}, not VERIFIED`);
  }
  if (!evaluated.capabilities.length) problems.push('this assembly has no verified capability to promote');
  for (const c of evaluated.capabilities) if (c.state !== 'CURRENT') problems.push(`${c.capability} is ${c.state}: ${c.stateReason}`);
  if (problems.length) return { ok: false, problems };
  const primaryRepo = inspectRepo(primary), worktreeRepo = inspectRepo(worktree);
  if (!primaryRepo.isRepo) problems.push('the created project is not a Git repository');
  if (primaryRepo.dirty) problems.push(`the created project has ${primaryRepo.dirtyFiles.length} uncommitted change(s); GRAFT will not move a checkout with your work in it`);
  if (primaryRepo.head !== workspace.baseRevision) problems.push(`the created project moved from ${String(workspace.baseRevision).slice(0, 12)} to ${String(primaryRepo.head).slice(0, 12)} after the assembly started`);
  if (primaryRepo.branch !== workspace.primaryBranch && workspace.primaryBranch) problems.push(`the created project is on ${primaryRepo.branch}, not ${workspace.primaryBranch}`);
  if (worktreeRepo.branch !== workspace.workingBranch) problems.push(`the assembled worktree is on ${worktreeRepo.branch}, not ${workspace.workingBranch}`);
  if (worktreeRepo.dirty) problems.push('the assembled worktree has uncommitted changes; the verified state must be committed first');
  if (worktreeRepo.head !== workspace.currentRevision) problems.push(`the assembled worktree is at ${String(worktreeRepo.head).slice(0, 12)}, not the verified ${String(workspace.currentRevision).slice(0, 12)}`);
  // Ancestry: the promotion must be a pure fast-forward, so the checkout's commit must already be
  // part of the assembled history. Anything else would rewrite or discard the person's history.
  if (!problems.length) {
    try { git(primary, ['merge-base', '--is-ancestor', primaryRepo.head, workspace.currentRevision]); }
    catch { problems.push(`${String(primaryRepo.head).slice(0, 12)} is not an ancestor of the assembled revision; a fast-forward is not possible`); }
  }
  return { ok: problems.length === 0, problems, primary: problems.length ? null : { head: primaryRepo.head, branch: primaryRepo.branch }, assembled: problems.length ? null : { head: worktreeRepo.head, branch: worktreeRepo.branch } };
}

/**
 * Promote the verified assembly into the person's own checkout: a fast-forward merge of the
 * assembled branch, nothing else. No reset, no force, no remote is contacted, and the blank-host
 * commit stays in history with the assembly commit(s) on top.
 */
export function promoteAssembly(workspace, { execution = null, now = () => new Date().toISOString() } = {}) {
  const check = checkPromotion(workspace, { execution });
  if (!check.ok) throw fail('promotion-refused', check.problems.join('; '));
  const primary = workspace.locations.primary;
  const before = inspectRepo(primary);
  git(primary, ['merge', '--ff-only', '--', workspace.workingBranch]);
  const after = inspectRepo(primary);
  if (after.head !== workspace.currentRevision) throw fail('promotion-incomplete', `The created project is at ${after.head}, not the verified ${workspace.currentRevision}.`);
  const remotes = git(primary, ['remote']);
  workspace.status = 'FINALIZED';
  workspace.finalization = {
    kind: 'fast-forward', branch: workspace.workingBranch, fromRevision: before.head, toRevision: after.head,
    ancestryPreserved: true, forced: false, remotesContacted: [], remotesConfigured: remotes ? remotes.split('\n') : [],
    executionId: execution?.executionId || workspace.executionIds?.[0] || null, finalizedAt: now(),
  };
  workspace.updatedAt = now();
  return { workspace, promotion: workspace.finalization };
}

// ---------------------------------------------------------------------------------------------
// Persistence: GRAFT_HOME/laboratory/assemblies/<id>.json, atomic, no secret values.
// ---------------------------------------------------------------------------------------------
export const assembliesDir = () => path.join(graftHome(), 'laboratory', 'assemblies');
const ID = /^asm-[a-z0-9][a-z0-9-]{0,100}-[0-9a-f]{6}$/;
const workspaceFile = (id) => { if (!ID.test(id)) throw fail('invalid-workspace-id', 'Assembly workspace id must be a short lowercase id.'); return path.join(assembliesDir(), `${id}.json`); };
const SECRET_KEY = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
function assertStorable(value, trail = 'workspace') {
  if (Array.isArray(value)) { value.forEach((v, i) => assertStorable(v, `${trail}[${i}]`)); return; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) { if (SECRET_KEY.test(k) && typeof v === 'string' && v.length) throw fail('workspace-privacy', `${trail}.${k} looks like a secret value; assembly records store names only.`); assertStorable(v, `${trail}.${k}`); } return; }
  // `locations` and proof references are the local facts the product needs to open and cite the
  // application; everything else stays free of GRAFT_HOME paths.
  if (typeof value === 'string' && value.includes(graftHome()) && !/locations|proofReference|receipt/i.test(trail)) throw fail('workspace-privacy', `${trail} would store a GRAFT_HOME path.`);
}
export function saveAssemblyWorkspace(workspace) {
  const storable = { ...workspace };
  delete storable.observed;
  assertStorable(storable);
  const file = workspaceFile(storable.assemblyWorkspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(storable, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  return storable;
}
export function loadAssemblyWorkspace(id) {
  const file = workspaceFile(id);
  if (!fs.existsSync(file)) throw fail('unknown-workspace', `No assembly workspace ${id}.`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== ASSEMBLY_WORKSPACE_SCHEMA_VERSION) throw fail('unsupported-schema', `Assembly workspace schema ${parsed.schemaVersion} is not supported.`);
  return parsed;
}
export function listAssemblyWorkspaces({ blueprintId = null, planId = null } = {}) {
  const dir = assembliesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter((w) => w && (!blueprintId || w.blueprintId === blueprintId) && (!planId || w.planId === planId))
    .map((w) => { const e = evaluateWorkspace(w); return { assemblyWorkspaceId: w.assemblyWorkspaceId, blueprintId: w.blueprintId, blueprintName: w.blueprintName, planId: w.planId, status: e.status, capabilities: e.capabilities.map((c) => ({ capability: c.capability, state: c.state, verdict: c.verificationVerdict })), currentRevision: w.currentRevision, observed: e.observed, finalization: w.finalization, updatedAt: w.updatedAt }; })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
/** The workspace for an assembled project root, if GRAFT assembled it. */
export function workspaceForProject(root) {
  const dir = assembliesDir();
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try { const w = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (w.locations?.primary && samePath(w.locations.primary, root)) return w; } catch { /* skip unreadable */ }
  }
  return null;
}
