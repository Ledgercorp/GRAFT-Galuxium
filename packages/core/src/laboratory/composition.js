// Laboratory 0.4a — Composition Kernel.
//
// One thing only: adding a SECOND capability to an assembly that already holds a verified first
// one, transactionally. Everything authoritative is done by operations that already exist
// (prepareTransplant → createTransplantPlan → applyTransplant → verifyCapability → decideVerdict);
// they are injected as `steps` so this kernel never re-implements them and can be exercised
// deterministically.
//
// The transaction:
//
//   CURRENT revision A
//     → candidate worktree cut from EXACTLY that revision   (never the base, never the checkout)
//     → plan and apply B against the candidate's own Host Model
//     → verify B
//     → RE-VERIFY every capability already CURRENT, against the candidate combined revision
//     → host preservation
//     → commit the candidate state
//     → advance the workspace's currentRevision and ledger histories (the only step that changes
//       which revision is CURRENT)
//
// Any authoritative failure disposes of the candidate and leaves the previous CURRENT revision
// exactly as it was. Disposal IS the rollback: nothing is reset, forced or destroyed.
import { evaluateWorkspace, assemblyLocation } from './continuity.js';

export const COMPOSITION_EVIDENCE_VERSION = '1.0.0';
export const COMPOSITION_STATES = Object.freeze(['ALL_SELECTED_CAPABILITIES_VERIFIED', 'CANDIDATE_REJECTED', 'BLOCKED']);
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });

/** Everything that must hold before a second capability may be composed onto this assembly. */
export function checkCompositionReady(workspace) {
  const problems = [];
  const evaluated = evaluateWorkspace(workspace);
  if (!evaluated.capabilities.length) problems.push('this assembly has no verified capability to compose onto');
  for (const c of evaluated.capabilities) if (c.state !== 'CURRENT') problems.push(`${c.capability} is ${c.state}: ${c.stateReason}`);
  const location = assemblyLocation(workspace);
  if (!location.root) problems.push('the assembly working tree is no longer present');
  else if (location.repo?.dirty) problems.push('the assembly working tree has uncommitted changes');
  else if (location.repo?.head !== workspace.currentRevision) problems.push(`the assembly is at ${String(location.repo?.head).slice(0, 12)}, not its recorded current revision ${String(workspace.currentRevision).slice(0, 12)}`);
  return { ok: problems.length === 0, problems, fromRevision: workspace.currentRevision, alreadyCurrent: evaluated.capabilities.map((c) => c.capability) };
}

/**
 * Compose one further capability. `steps` supplies the authoritative operations:
 *
 *   prepareCandidate({ fromRevision, capability })  → { worktreePath, branch, transplantId, headAtPrepare }
 *   applyAndVerify({ candidate, capability })       → { verdict, verification, hostPreservation, proofReferences, transplantPlan, capabilitySource }
 *   reverifyCapability({ candidate, record })       → { verdict, summary, proofReference }
 *   commitCandidate({ candidate, capability })      → { revision }
 *   disposeCandidate({ candidate, reason })         → void
 *
 * Returns `{ composed, workspace, evidence, rejection }`. The workspace is mutated only on success.
 */
export async function composeNextCapability(workspace, { capability, steps, now = () => new Date().toISOString() }) {
  const ready = checkCompositionReady(workspace);
  if (!ready.ok) throw fail('composition-not-ready', ready.problems.join('; '));
  const fromRevision = workspace.currentRevision;
  const priorRecords = workspace.capabilities.filter((c) => c.state === 'CURRENT');
  const priorRevision = fromRevision;
  const candidate = await steps.prepareCandidate({ fromRevision, capability });
  // The rule this phase exists to enforce: the candidate must be cut from the CURRENT verified
  // revision — the one that already contains capability A — and from nothing else.
  if (!candidate?.headAtPrepare) { await steps.disposeCandidate({ candidate, reason: 'the candidate did not report the revision it was cut from' }); throw fail('candidate-base-unknown', 'The candidate worktree did not report the revision it was cut from.'); }
  if (candidate.headAtPrepare !== fromRevision) {
    await steps.disposeCandidate({ candidate, reason: 'wrong base revision' });
    throw fail('candidate-wrong-base', `The candidate was cut from ${String(candidate.headAtPrepare).slice(0, 12)}, not the assembly's current verified revision ${String(fromRevision).slice(0, 12)}.`);
  }
  const reject = async (stage, detail, extra = {}) => {
    await steps.disposeCandidate({ candidate, reason: `${stage}: ${detail}` });
    return {
      composed: false, workspace, rejection: { stage, detail, candidateRevision: candidate.headAtPrepare, candidateBranch: candidate.branch, disposed: true, ...extra },
      evidence: { evidenceVersion: COMPOSITION_EVIDENCE_VERSION, assemblyWorkspaceId: workspace.assemblyWorkspaceId, revision: priorRevision, capabilityRecords: priorRecords.map((c) => ({ capability: c.capability, state: c.state, revision: c.currentVerifiedRevision || c.destinationRevisionAfter })), verificationReferences: [], hostPreservation: extra.hostPreservation || null, interactionsChecked: extra.interactionsChecked || [], finalState: 'CANDIDATE_REJECTED', reason: `${stage}: ${detail}`, at: now() },
    };
  };
  // Apply and verify the new capability inside the candidate.
  const applied = await steps.applyAndVerify({ candidate, capability });
  if (applied.verdict !== 'VERIFIED') return reject('capability-verification', `${capability.name || capability.slug} reported ${applied.verdict}`, { verdict: applied.verdict, summary: applied.verification?.summary || null });
  if (applied.hostPreservation && applied.hostPreservation.failed > 0) return reject('host-preservation', `${applied.hostPreservation.failed} host-preservation check(s) failed`, { hostPreservation: applied.hostPreservation });
  // Re-verify everything that was already CURRENT, against the combined candidate.
  const interactionsChecked = [];
  for (const record of priorRecords) {
    const result = await steps.reverifyCapability({ candidate, record });
    interactionsChecked.push({ capability: record.capability, capabilityId: record.capabilityId, verdict: result.verdict, summary: result.summary || null, proofReference: result.proofReference || null, at: now() });
    if (result.verdict !== 'VERIFIED') return reject('existing-capability-reverification', `${record.capability} reported ${result.verdict} on the combined revision`, { interactionsChecked, verdict: result.verdict });
  }
  // Everything held: commit the candidate and advance. This is the only step that changes CURRENT.
  const committed = await steps.commitCandidate({ candidate, capability });
  if (!committed?.revision) return reject('commit', 'the candidate state could not be committed');
  const at = now();
  const newRecord = {
    capabilityId: capability.capabilityId, capability: capability.slug, kind: applied.capabilitySource?.kind || capability.kind || null,
    genomeId: applied.capabilitySource?.genomeId || null, irId: applied.capabilitySource?.irId || null, artifactId: applied.transplantPlan?.planId || null,
    sourceRevision: applied.capabilitySource?.sourceRevision || null, sourceVerification: applied.capabilitySource?.sourceVerification || null,
    destinationRevisionBefore: fromRevision, destinationRevisionAfter: committed.revision,
    appliedRevision: committed.revision, currentVerifiedRevision: committed.revision,
    verificationContractId: applied.proofReferences?.find((r) => r.kind === 'proof')?.contractId || null,
    verificationVerdict: applied.verdict, verificationSummary: applied.verification?.summary || null,
    invariantSummary: applied.verification?.invariantSummary || null, counterfactualSummary: applied.verification?.counterfactualSummary || null,
    hostPreservation: applied.hostPreservation || null, transplantId: candidate.transplantId, filesWritten: applied.filesWritten || null,
    proofReference: applied.proofReferences?.find((r) => r.kind === 'proof') || null, executionId: applied.executionId || null,
    verificationHistory: [{ event: 'applied-and-verified', revision: committed.revision, verdict: applied.verdict, summary: applied.verification?.summary || null, at }],
    appliedAt: at, state: 'CURRENT', stateReason: 'applied by GRAFT and verified at this revision',
  };
  // Prior capabilities keep the revision they were originally applied at, and gain the
  // re-verification that proves they still hold on the combined revision. History is never erased.
  for (const record of priorRecords) {
    const check = interactionsChecked.find((i) => i.capabilityId === record.capabilityId);
    record.appliedRevision = record.appliedRevision || record.destinationRevisionAfter;
    record.verificationHistory = [
      ...(record.verificationHistory || [{ event: 'applied-and-verified', revision: record.appliedRevision, verdict: record.verificationVerdict, summary: record.verificationSummary, at: record.appliedAt }]),
      { event: 're-verified-with', revision: committed.revision, alongside: capability.slug, verdict: check?.verdict || 'VERIFIED', summary: check?.summary || null, at },
    ];
    record.currentVerifiedRevision = committed.revision;
    record.stateReason = `applied at ${String(record.appliedRevision).slice(0, 12)} and re-verified at ${String(committed.revision).slice(0, 12)} alongside ${capability.slug}`;
  }
  workspace.capabilities.push(newRecord);
  workspace.currentRevision = committed.revision;
  workspace.workingBranch = candidate.branch;
  workspace.locations = { ...workspace.locations, worktree: candidate.worktreePath };
  if (candidate.transplantId) workspace.transplantIds = [...new Set([...(workspace.transplantIds || []), candidate.transplantId])];
  workspace.updatedAt = at;
  return { composed: true, workspace, rejection: null, evidence: compositionEvidence(workspace, { interactionsChecked, hostPreservation: applied.hostPreservation || null, at }) };
}

/**
 * What GRAFT can honestly say about the composed application: which capabilities are CURRENT, at
 * which revision, and which authoritative proofs that rests on. It references proofs; it is not a
 * proof, and it never describes the application as universally verified.
 */
export function compositionEvidence(workspace, { interactionsChecked = [], hostPreservation = null, at = new Date().toISOString() } = {}) {
  const evaluated = evaluateWorkspace(workspace);
  const current = evaluated.capabilities.filter((c) => c.state === 'CURRENT');
  const revision = workspace.currentRevision;
  const allBound = current.length > 0 && current.length === evaluated.capabilities.length
    && current.every((c) => (c.currentVerifiedRevision || c.destinationRevisionAfter) === revision)
    && current.every((c) => c.verificationVerdict === 'VERIFIED');
  const preservationOk = hostPreservation ? hostPreservation.failed === 0 : true;
  const reverificationsOk = interactionsChecked.every((i) => i.verdict === 'VERIFIED');
  return {
    evidenceVersion: COMPOSITION_EVIDENCE_VERSION, assemblyWorkspaceId: workspace.assemblyWorkspaceId, revision,
    capabilityRecords: current.map((c) => ({ capability: c.capability, capabilityId: c.capabilityId, appliedRevision: c.appliedRevision || c.destinationRevisionAfter, currentVerifiedRevision: c.currentVerifiedRevision || c.destinationRevisionAfter, verdict: c.verificationVerdict, summary: c.verificationSummary, state: c.state })),
    verificationReferences: current.map((c) => c.proofReference).filter(Boolean),
    hostPreservation, interactionsChecked,
    finalState: allBound && preservationOk && reverificationsOk ? 'ALL_SELECTED_CAPABILITIES_VERIFIED' : 'BLOCKED',
    wording: allBound && preservationOk && reverificationsOk
      ? `Assembly complete. ${current.length} of ${current.length} selected capabilities verified on revision ${String(revision).slice(0, 12)}; existing-capability re-verification passed. This is not a claim that the application as a whole is verified.`
      : 'Not every selected capability is verified on the same revision.',
    at,
  };
}

// ---------------------------------------------------------------------------------------------
// Real Multi-Capability Composition 0.1 — transactional execution of a multi-capability PLAN.
//
// `composeNextCapability` above adds one capability to an assembly that is already CURRENT.
// `executeCompositionPlan` executes a plan with several capabilities from a blank host, as ONE
// transaction, and is driven by the plan's own steps: it walks them in order and dispatches each
// to an injected operation, so the plan is the execution and no capability, form or name is
// special-cased here. The operations are the existing ones (createHost, fingerprint / Host Model,
// prepareTransplant, applyTransplant / library adaptation, verifyCapability → decideVerdict,
// hostPreservationTests, commitAssembledState) injected as `ops`, exactly as `steps` are above.
//
// The transaction:
//
//   PRIMARY checkout (blank host)            — never written after creation
//     → one CANDIDATE worktree cut from it
//       baseline: the host's behaviour, captured BEFORE any capability is written
//       for each capability, in the plan's order:
//         apply → verify → commit (an INTERMEDIATE revision: evidence about that state only)
//         → host preservation against the baseline → re-index (the next capability sees the host as it is)
//       for each earlier capability: RE-VERIFY on the combined candidate
//       host preservation against the ORIGINAL baseline, re-index
//       FINAL: the candidate must stand, clean, at the last commit; every capability's final
//              verification must be VERIFIED there; only then do all records enter the ledger,
//              together, at that one revision
//     → eligible for explicit finalization (promoteAssembly, fast-forward only) — never automatic
//
// Any required step that fails ends the execution: no ledger record is written (not even for a
// capability that verified on its own), the primary stays untouched, and the candidate is kept
// as it is for inspection, exactly as a failed single-capability assembly is.
import { beginStep, finishStep, failStep, concludeExecution, checkCreatedHost, saveExecution } from './execution.js';
import { createAssemblyWorkspace, commitLedgerTransition, saveAssemblyWorkspace } from './continuity.js';
import { storeProof, verifyStoredProof } from './proof-store.js';
import { APPLYING_STEP_TYPES } from './assembly.js';

export const COMPOSITION_EXECUTION_VERSION = '1.0.0';
export const COMPOSITION_FINAL_STATES = Object.freeze(['IN_PROGRESS', 'ALL_SELECTED_CAPABILITIES_VERIFIED', 'NOT_PROMOTABLE']);

/** The capabilities a plan applies, in the plan's own order, with the step that applies each. */
export function plannedCapabilities(plan) {
  return (plan.steps || []).filter((s) => APPLYING_STEP_TYPES.includes(s.type)).map((s) => ({
    goalId: s.goalId, capability: s.capability, form: s.type === 'ADAPT_LIBRARY_CAPABILITY' ? 'library' : 'service', applyStep: s,
    contractId: (plan.steps || []).find((v) => v.type === 'VERIFY_CAPABILITY' && v.goalId === s.goalId)?.capability?.contractId || null,
  }));
}

/**
 * Execute a multi-capability plan transactionally. `execution` is the record from `createExecution`.
 *
 *   ops.createHost({ execution })                          → { root, projectName, branch, initialCommit, fingerprint, repositoryIdentity }
 *   ops.reindexHost({ root })                              → { hostId, profile, moduleSystem, framework, handlerContract, central, routes, observedCapabilities, detectorObservation }
 *   ops.prepareCandidate({ host, capabilities })           → { worktreePath, branch, transplantId, headAtPrepare }
 *   ops.captureHostBaseline({ candidate })                 → { captured, reason, tests }
 *   ops.checkArtifactIdentity({ candidate, capability })   → { matched, expected, actual, entry, reason, detail }
 *   ops.applyCapability({ candidate, capability, step, host }) → { filesWritten, capabilitySource, transplantPlan, adaptation, proofReferences }
 *   ops.verifyCapability({ candidate, capability, phase, alongside }) → { verdict, summary, rationale, proofReference, invariants, counterfactuals }
 *   ops.checkHostPreservation({ candidate, baseline })     → { captured, tests, passed, failed }
 *   ops.commitCandidate({ candidate, capability })         → { revision, committed }
 *   ops.inspectCandidate({ candidate })                    → { head, dirty }
 *   ops.persistWorkspace(workspace) / ops.persistExecution(execution)   (default: the atomic stores)
 *   ops.persistProof(envelope) / ops.verifyStoredProof(digest)            (default: the content-addressed proof store)
 *
 * Proof Integrity 0.1: `ops.verifyCapability` may also return `proofEnvelope` — the proof envelope
 * of that verification, present only when it ran on a committed, clean candidate revision. The
 * kernel persists one proof per capability from its verification AT THE FINAL REVISION (running one
 * post-commit verification for a capability whose last verification preceded its own commit), and
 * the ledger transition names each proof by digest. No durable proof, no CURRENT record.
 *
 * Returns `{ execution, workspace, promotable }`. `workspace` is non-null only when every
 * capability became CURRENT at the final revision and the ledger was persisted.
 */
export async function executeCompositionPlan(execution, plan, ops, { now = () => new Date().toISOString(), onPhase = () => {} } = {}) {
  const persistExecution = ops.persistExecution || saveExecution;
  const persistWorkspace = ops.persistWorkspace || saveAssemblyWorkspace;
  const persistProof = ops.persistProof || storeProof;
  const checkStoredProof = ops.verifyStoredProof || verifyStoredProof;
  const capabilities = plannedCapabilities(plan);
  const results = new Map(capabilities.map((c) => [c.capability.capabilityId, { ...c, applied: null, identity: null, verification: null, appliedRevision: null, preservation: null, reverification: null, alongside: [] }]));
  const byGoal = (goalId) => [...results.values()].find((r) => r.goalId === goalId) || null;
  execution.composition = { executionVersion: COMPOSITION_EXECUTION_VERSION, ordering: plan.ordering || null, order: capabilities.map((c) => ({ goalId: c.goalId, capability: c.capability.slug, capabilityId: c.capability.capabilityId, form: c.form })),
    capabilities: capabilities.map((c) => ({ goalId: c.goalId, capability: c.capability.slug, capabilityId: c.capability.capabilityId, name: c.capability.name || null, form: c.form, appliedRevision: null, initialVerdict: null, initialSummary: null, reverifiedVerdict: null, reverifiedSummary: null, finalVerdict: null, finalSummary: null })),
    baseRevision: null, intermediateRevisions: [], finalRevision: null, baseline: null, finalPreservation: null, reverifications: [], proofs: [], finalState: 'IN_PROGRESS', promotable: false };
  // The record the product renders: every fact below is copied from an operation's own result.
  const syncComposition = () => { for (const c of execution.composition.capabilities) { const r = results.get(c.capabilityId); c.appliedRevision = r.appliedRevision; c.initialVerdict = r.verification?.verdict || null; c.initialSummary = r.verification?.summary || null; c.reverifiedVerdict = r.reverification?.verdict || null; c.reverifiedSummary = r.reverification?.summary || null; const final = r.reverification || r.verification; c.finalVerdict = final?.verdict || null; c.finalSummary = final?.summary || null;
    c.sourceProject = r.applied?.capabilitySource?.sourceProject || null; c.sourceRevision = r.applied?.capabilitySource?.sourceRevision || null; c.sourceVerification = r.applied?.capabilitySource?.sourceVerification || null; c.kind = r.applied?.capabilitySource?.kind || r.capability.kind || null;
    c.artifactIdentity = r.identity || null; c.adaptation = r.applied?.adaptation ? { id: r.applied.adaptation.id, method: r.applied.adaptation.method, artifact: r.applied.adaptation.artifact, artifactSha256: r.applied.adaptation.artifactSha256, adapter: r.applied.adaptation.adapter, upstream: r.applied.adaptation.upstream || null, licence: r.applied.adaptation.licence || null, checks: r.applied.adaptation.checks || null } : null;
    // What the plan assumed before writing, and how the final verification reached its provider: copied for the Atlas outcome, decided nowhere here.
    c.transplantPlan = r.applied?.transplantPlan ? { compatibility: r.applied.transplantPlan.compatibility ?? null, profile: r.applied.transplantPlan.profile ?? null, recipe: r.applied.transplantPlan.recipe ?? null, recipeId: r.applied.transplantPlan.recipeId ?? null, checks: r.applied.transplantPlan.checks || null } : null; c.providerDouble = (r.proofVerification || final)?.providerDouble ?? null;
    // The verification of the committed final revision made for the proof, when one ran: the last word on this capability, kept beside `finalVerdict` (which keeps its meaning: after the later capabilities).
    c.proofVerdict = r.proofVerification?.verdict ?? null; c.proofSummary = r.proofVerification?.summary ?? null; c.proofOutcomes = r.proofVerification?.outcomes ?? null;
    c.preservationAfter = r.preservation || null; c.filesWritten = r.applied?.filesWritten || null; } };
  const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
  const BLOCKING = new Set(['host-mismatch', 'capability-set-mismatch', 'unsupported-step', 'artifact-identity', 'candidate-wrong-base', 'host-shape-changed']);
  let step = null, host = null, candidate = null, baseline = null, hostNow = null, lastCommit = null;
  const finish = (state) => { execution.composition.finalState = state; execution.composition.promotable = state === 'ALL_SELECTED_CAPABILITIES_VERIFIED'; syncComposition(); };
  const end = (err) => {
    failStep(execution, step, err, BLOCKING.has(err.code) ? 'BLOCKED' : err.code === 'inconclusive' ? 'INCONCLUSIVE' : 'FAILED', { now });
    finish('NOT_PROMOTABLE'); concludeExecution(execution, { now });
    execution.finalSummary.wording = `Assembly ${execution.status}: ${err.message}`;
    persistExecution(execution);
    return { execution, workspace: null, promotable: false, error: { code: err.code || null, message: err.message } };
  };
  // Before anything is written: the plan must apply exactly the capabilities it expects, every one supported.
  const expected = (plan.expectedCapabilities || []).map((c) => c.capabilityId).sort();
  const applying = capabilities.map((c) => c.capability?.capabilityId || null).sort();
  if (JSON.stringify(expected) !== JSON.stringify(applying)) return end(fail('capability-set-mismatch', `The plan expects ${expected.length} capability(ies) but applies ${applying.length}; a capability would silently disappear.`));
  if (!capabilities.length) return end(fail('capability-set-mismatch', 'The plan applies no capability.'));
  const unsupported = (plan.steps || []).find((s) => s.supported === false);
  if (unsupported) return end(fail('unsupported-step', `Planned step ${unsupported.type}${unsupported.capability?.slug ? ` (${unsupported.capability.slug})` : ''} is not supported: ${unsupported.supportReason || ''}`.trim()));
  const ensureCandidate = async () => {
    if (candidate) return candidate;
    onPhase('Preparing the composition candidate');
    candidate = await ops.prepareCandidate({ host, capabilities: capabilities.map((c) => c.capability) });
    if (!candidate?.headAtPrepare || candidate.headAtPrepare !== host.initialCommit) throw fail('candidate-wrong-base', `The candidate was cut from ${String(candidate?.headAtPrepare).slice(0, 12) || 'an unknown revision'}, not the created host's ${String(host.initialCommit).slice(0, 12)}.`);
    execution.transplantId = candidate.transplantId || null; execution.worktree = { path: candidate.worktreePath, branch: candidate.branch, baseHead: candidate.headAtPrepare };
    execution.composition.baseRevision = candidate.headAtPrepare;
    // The host's own behaviour, recorded before any capability writes anything. Every preservation
    // check in this execution — after each capability and at the end — compares against THIS.
    onPhase('Recording the host’s own behaviour');
    baseline = await ops.captureHostBaseline({ candidate });
    execution.composition.baseline = { captured: baseline?.captured === true, reason: baseline?.reason || null, tests: baseline?.tests?.length ?? baseline?.tests ?? 0 };
    if (baseline?.captured !== true) throw fail('inconclusive', `The host's own behaviour could not be recorded before composition (${baseline?.reason || 'no reason given'}), so host preservation cannot be proven.`);
    return candidate;
  };
  try {
    persistExecution(execution);
    for (const planned of execution.steps) {
      const planStep = plan.steps.find((s) => s.stepId === planned.stepId) || planned;
      const target = planStep.goalId ? byGoal(planStep.goalId) : null;
      switch (planned.type) {
        case 'CREATE_HOST': {
          step = beginStep(execution, 'CREATE_HOST', 'CREATING_HOST', { now }); onPhase('Creating host');
          host = await ops.createHost({ execution });
          execution.createdProject = { root: host.root, name: host.projectName, initialCommit: host.initialCommit, branch: host.branch, files: host.files || null };
          if (host.receipt) execution.receipts.push(host.receipt);
          finishStep(execution, step, { root: host.root, initialCommit: host.initialCommit }, { now }); execution.status = 'HOST_CREATED';
          break;
        }
        case 'REINDEX_HOST': {
          step = beginStep(execution, 'REINDEX_HOST', candidate ? 'REINDEXING' : 'INDEXING_HOST', { now }); onPhase(candidate ? 'Re-indexing the assembled application' : 'Indexing host');
          const index = await ops.reindexHost({ root: candidate ? candidate.worktreePath : host.root });
          if (!candidate) {
            // The created host must independently fingerprint as planned.
            const check = checkCreatedHost({ fingerprint: index }, plan.host);
            if (!check.ok) throw fail('host-mismatch', `The created host does not match the plan: ${check.mismatches.join('; ')}. Nothing was applied.`);
          } else if (plan.host?.profile && index.profile !== plan.host.profile) {
            // Every capability targets the same planned host shape; a capability that changed it
            // would make the next one's plan a lie.
            throw fail('host-shape-changed', `After ${[...results.values()].filter((r) => r.applied).map((r) => r.capability.slug).join(', ')} the host is ${index.profile || 'an unknown shape'}, not the planned ${plan.host.profile}.`);
          }
          hostNow = index;
          execution.reindex = { hostId: index.hostId, profile: index.profile, routes: index.routes ?? null, observedCapabilities: index.observedCapabilities || [], detectorObservation: index.detectorObservation || null, authenticationObserved: (index.observedCapabilities || []).some((c) => /authentication/.test(c.category || '')) };
          finishStep(execution, step, { hostId: index.hostId, profile: index.profile, observed: (index.observedCapabilities || []).length, detectorObservation: index.detectorObservation || null }, { now });
          break;
        }
        case 'CHECK_DEPENDENCIES': {
          step = beginStep(execution, 'CHECK_DEPENDENCIES', 'PREPARING_WORKTREE', { now });
          const unmet = (plan.dependencies || []).filter((d) => d.level === 'DECLARED' && d.satisfied === false);
          if (unmet.length) throw fail('unmet-dependency', `Declared dependencies are unmet: ${unmet.map((d) => `${d.from} → ${d.needs}`).join(', ')}`);
          finishStep(execution, step, { declared: (plan.dependencies || []).filter((d) => d.level === 'DECLARED').length, unmet: 0 }, { now });
          break;
        }
        case 'VERIFY_SOURCE_ARTIFACT_IDENTITY': {
          step = beginStep(execution, 'VERIFY_SOURCE_ARTIFACT_IDENTITY', 'PREPARING_WORKTREE', { now }); onPhase('Checking the verified artifact');
          await ensureCandidate();
          const identity = await ops.checkArtifactIdentity({ candidate, capability: target.capability, step: planStep });
          target.identity = { matched: identity?.matched === true, entry: identity?.entry || null, expected: identity?.expected || null, actual: identity?.actual || null }; syncComposition();
          if (identity?.matched !== true) throw fail('artifact-identity', `${target.capability.name || target.capability.slug}: ${identity?.detail || identity?.reason || 'the artifact is not the one GRAFT verified'}. Nothing was written for it.`);
          finishStep(execution, step, { entry: identity.entry || null, expected: identity.expected || null, actual: identity.actual || null, byteIdentical: true }, { now });
          break;
        }
        case 'TRANSPLANT_CAPABILITY': case 'ADAPT_LIBRARY_CAPABILITY': {
          step = beginStep(execution, planned.type, 'APPLYING', { now }); onPhase(`Applying ${target.capability.name || target.capability.slug}`);
          await ensureCandidate();
          const applied = await ops.applyCapability({ candidate, capability: target.capability, step: planStep, host: hostNow });
          target.applied = applied;
          finishStep(execution, step, { filesWritten: applied?.filesWritten || [], transplantId: candidate.transplantId || null }, { now });
          break;
        }
        case 'VERIFY_CAPABILITY': {
          step = beginStep(execution, 'VERIFY_CAPABILITY', 'VERIFYING', { now }); onPhase(`Verifying ${target.capability.name || target.capability.slug}`);
          if (!target.applied) throw fail('not-applied', `${target.capability.slug} was not applied before its verification.`);
          const v = await ops.verifyCapability({ candidate, capability: target.capability, phase: 'initial', alongside: [] });
          target.verification = v; syncComposition();
          if (v?.verdict !== 'VERIFIED') { execution.composition.capabilities.find((c) => c.capabilityId === target.capability.capabilityId).initialOutcomes = v?.outcomes || null; }
          if (v?.verdict !== 'VERIFIED') throw fail(v?.verdict === 'FAILED' ? 'verdict' : 'inconclusive', `Verification of ${target.capability.slug} reported ${v?.verdict || 'nothing'}: ${v?.rationale || ''}`.trim());
          // The verified state becomes an intermediate revision: evidence about THIS state, which a
          // later capability may still invalidate. It is not CURRENT anywhere yet.
          const committed = await ops.commitCandidate({ candidate, capability: target.capability });
          if (!committed?.revision || committed.committed === false) throw fail('nothing-applied', `${target.capability.slug} verified, but the candidate holds nothing to commit for it.`);
          target.appliedRevision = committed.revision; lastCommit = committed.revision;
          execution.composition.intermediateRevisions.push({ capability: target.capability.slug, revision: committed.revision });
          syncComposition();
          finishStep(execution, step, { verdict: v.verdict, passed: v.summary?.passed ?? null, required: v.summary?.required ?? null, revision: committed.revision }, { now });
          break;
        }
        case 'REVERIFY_CAPABILITY': {
          step = beginStep(execution, 'REVERIFY_CAPABILITY', 'VERIFYING', { now }); onPhase(`Re-verifying ${target.capability.name || target.capability.slug} on the combined application`);
          const position = capabilities.findIndex((c) => c.goalId === target.goalId);
          const later = capabilities.slice(position + 1).filter((c) => results.get(c.capability.capabilityId).applied).map((c) => c.capability.slug);
          const v = await ops.verifyCapability({ candidate, capability: target.capability, phase: 'reverify', alongside: later });
          target.reverification = v; target.alongside = later;
          execution.composition.reverifications.push({ capability: target.capability.slug, capabilityId: target.capability.capabilityId, alongside: later, verdict: v?.verdict || null, summary: v?.summary || null, revision: lastCommit, observation: v?.observation || null, outcomes: v?.outcomes || null, at: now() });
          syncComposition();
          if (v?.verdict !== 'VERIFIED') throw fail(v?.verdict === 'FAILED' ? 'verdict' : 'inconclusive', `${target.capability.slug} reported ${v?.verdict || 'nothing'} on the combined application after ${later.join(', ')}: ${v?.rationale || ''}`.trim());
          finishStep(execution, step, { verdict: v.verdict, passed: v.summary?.passed ?? null, required: v.summary?.required ?? null, alongside: later, revision: lastCommit }, { now });
          break;
        }
        case 'CHECK_HOST_PRESERVATION': {
          step = beginStep(execution, 'CHECK_HOST_PRESERVATION', 'VERIFYING', { now }); onPhase('Checking the host still behaves as it did');
          await ensureCandidate();
          const p = await ops.checkHostPreservation({ candidate, baseline });
          const summary = { captured: baseline.captured === true, tests: p?.tests ?? 0, passed: p?.passed ?? 0, failed: p?.failed ?? 0, inconclusive: p?.inconclusive ?? 0, revision: lastCommit };
          if (target) target.preservation = summary; else execution.composition.finalPreservation = summary;
          execution.hostPreservation = summary;
          if (summary.failed > 0) throw fail('host-preservation', `The host stopped behaving as it did before composition: ${summary.failed} preservation check(s) failed${target ? ` after ${target.capability.slug}` : ''}.`);
          // Probes that did not run prove nothing: a baseline with probes and a check that observed
          // none of them (the application did not boot, a probe was inconclusive) is not a pass.
          const expected = Array.isArray(baseline.tests) ? baseline.tests.length : Number(baseline.tests) || 0;
          if (summary.inconclusive > 0 || (expected > 0 && summary.tests === 0)) throw fail('inconclusive', `Host preservation could not be observed${target ? ` after ${target.capability.slug}` : ''}: ${summary.tests === 0 ? `none of the ${expected} probe(s) ran (${p?.reason || 'the application did not become ready'})` : `${summary.inconclusive} probe(s) inconclusive`}.`);
          finishStep(execution, step, summary, { now });
          break;
        }
        case 'FINAL_VERIFICATION': {
          step = beginStep(execution, 'FINAL_VERIFICATION', 'REINDEXING', { now }); onPhase('Binding every capability to the final revision');
          // The candidate must stand, clean, at the last commit: that is the only way the final
          // verifications above can be evidence about the revision the ledger is about to name.
          const state = await ops.inspectCandidate({ candidate });
          if (!lastCommit) throw fail('no-revision', 'No capability was committed; there is no final revision.');
          if (state?.dirty) throw fail('candidate-moved', 'The candidate has uncommitted changes after the final verifications; the evidence does not describe a single revision.');
          if (state?.head !== lastCommit) throw fail('candidate-moved', `The candidate stands at ${String(state?.head).slice(0, 12)}, not the last verified commit ${String(lastCommit).slice(0, 12)}; the evidence does not apply to it.`);
          const finalRevision = lastCommit;
          const problems = [];
          for (const r of results.values()) {
            const isLast = r === [...results.values()].at(-1);
            if (!r.applied || !r.verification) problems.push(`${r.capability.slug} was not applied and verified`);
            if (!isLast && !r.reverification) problems.push(`${r.capability.slug} was not re-verified after the later capabilities`);
            const final = r.reverification || r.verification;
            if (final?.verdict !== 'VERIFIED') problems.push(`${r.capability.slug}: final verification is ${final?.verdict || 'absent'}`);
          }
          if (!execution.composition.finalPreservation || execution.composition.finalPreservation.failed > 0) problems.push('the composed application was not shown to preserve the host baseline');
          if (execution.composition.finalPreservation && execution.composition.finalPreservation.revision !== finalRevision) problems.push('the final preservation check did not run on the final revision');
          if (!execution.reindex) problems.push('the composed application was not re-indexed');
          if (execution.steps.some((s) => s !== step && s.status !== 'DONE')) problems.push(`not every planned step ran: ${execution.steps.filter((s) => s !== step && s.status !== 'DONE').map((s) => `${s.type}:${s.status}`).join(', ')}`);
          if (problems.length) throw fail('final-verification', problems.join('; '));
          // Durable proof, one per capability, from a verification AT the final revision. A
          // capability whose last verification ran before its own commit (the last one applied) is
          // verified once more on the committed, clean candidate: its proof is never the earlier
          // dirty-tree verification relabelled with the commit hash. Every proof is persisted and
          // read back intact BEFORE any record is built; a proof that cannot be made durable means
          // no ledger transition at all.
          for (const r of results.values()) {
            const final = r.reverification || r.verification;
            if (final?.proofEnvelope?.payload?.destination?.revision !== finalRevision) {
              onPhase(`Proving ${r.capability.name || r.capability.slug} at the final revision`);
              const v = await ops.verifyCapability({ candidate, capability: r.capability, phase: 'reverify', alongside: [] });
              // Kept apart from `reverification`: that word means "after the later capabilities";
              // this is the same contract on the same committed revision, for the proof. Recorded
              // BEFORE the verdict is judged, so a failure here is part of the capability's record
              // (`proofVerdict`) and not only of the execution's error.
              r.proofVerification = v || { verdict: null };
              if (v?.verdict !== 'VERIFIED') throw fail(v?.verdict === 'FAILED' ? 'verdict' : 'inconclusive', `${r.capability.slug} reported ${v?.verdict || 'nothing'} on the committed final revision: ${v?.rationale || 'no rationale'}`);
            }
            const proven = r.proofVerification || final;
            const envelope = proven?.proofEnvelope;
            if (envelope?.payload?.destination?.revision !== finalRevision) throw fail('proof-unavailable', `${r.capability.slug}: no proof envelope binds the final revision ${String(finalRevision).slice(0, 12)} (${proven?.proofEnvelopeReason || 'absent'}).`);
            let stored;
            try { stored = persistProof(envelope); } catch (err) { throw fail('proof-persistence', `${r.capability.slug}: the proof could not be made durable: ${err.message}`); }
            const back = checkStoredProof(envelope.digest);
            if (!back?.found || !back.intact || back.digest !== envelope.digest) throw fail('proof-persistence', `${r.capability.slug}: the stored proof ${String(envelope.digest).slice(0, 12)} does not read back intact (${(back?.reasons || ['absent']).join('; ')}).`);
            r.proof = { envelopeSchema: envelope.schema, envelopeDigest: envelope.digest, stored: stored?.stored !== false };
            execution.composition.proofs.push({ capability: r.capability.slug, capabilityId: r.capability.capabilityId, revision: finalRevision, envelopeSchema: envelope.schema, envelopeDigest: envelope.digest, verdict: envelope.payload.verdict,
              provenBy: r.proofVerification ? 'verification-of-committed-revision' : 're-verification-after-later-capabilities', verification: { verdict: proven.verdict, summary: proven.summary || null } });
          }
          // Records for every capability, all at the one final revision, then ONE ledger transition.
          const at = now();
          const records = [...results.values()].map((r) => {
            const final = r.reverification || r.verification;
            const proof = { ...(final?.proofReference || r.verification?.proofReference || (r.applied?.proofReferences || []).find((x) => x.kind === 'proof') || {}), envelopeSchema: r.proof.envelopeSchema, envelopeDigest: r.proof.envelopeDigest };
            return {
              capabilityId: r.capability.capabilityId, capability: r.capability.slug, kind: r.applied?.capabilitySource?.kind || r.capability.kind || null,
              genomeId: r.applied?.capabilitySource?.genomeId || r.capability.genomeId || null, irId: r.applied?.capabilitySource?.irId || null, artifactId: r.applied?.transplantPlan?.planId || r.applied?.adaptation?.id || null,
              sourceProject: r.applied?.capabilitySource?.sourceProject || null, sourceRevision: r.applied?.capabilitySource?.sourceRevision || null, sourceVerification: r.applied?.capabilitySource?.sourceVerification || null,
              destinationRevisionBefore: candidate.headAtPrepare, destinationRevisionAfter: finalRevision,
              appliedRevision: r.appliedRevision, currentVerifiedRevision: finalRevision,
              verificationContractId: r.contractId || proof?.contractId || null, verificationVerdict: final.verdict, verificationSummary: final.summary || null,
              invariantSummary: { held: (final.invariants || []).filter((i) => i.status === 'held').length, violated: (final.invariants || []).filter((i) => i.status === 'violated').length, unobserved: (final.invariants || []).filter((i) => i.status === 'unobserved').length },
              counterfactualSummary: { cases: (final.counterfactuals || []).length, passed: (final.counterfactuals || []).filter((c) => c.outcome === 'passed').length },
              hostPreservation: execution.composition.finalPreservation,
              transplantId: candidate.transplantId || null, filesWritten: r.applied?.filesWritten || null,
              proofReference: proof, executionId: execution.executionId, implementationForm: r.form,
              ...(r.applied?.adaptation ? { adaptation: r.applied.adaptation } : {}),
              verificationHistory: [
                { event: 'applied-and-verified', revision: r.appliedRevision, verdict: r.verification.verdict, summary: r.verification.summary || null, at },
                ...(r.reverification ? [{ event: 're-verified-with', revision: finalRevision, alongside: r.alongside.join(', '), verdict: r.reverification.verdict, summary: r.reverification.summary || null, at }] : []),
                ...(r.proofVerification ? [{ event: 'proven-at-revision', revision: finalRevision, verdict: r.proofVerification.verdict, summary: r.proofVerification.summary || null, at }] : []),
              ],
              appliedAt: at, state: 'CURRENT', stateReason: r.reverification ? `applied at ${String(r.appliedRevision).slice(0, 12)} and re-verified at ${String(finalRevision).slice(0, 12)} alongside ${r.alongside.join(', ')}` : 'applied by GRAFT and verified at this revision',
            };
          });
          execution.composition.finalRevision = finalRevision;
          finish('ALL_SELECTED_CAPABILITIES_VERIFIED');
          finishStep(execution, step, { revision: finalRevision, capabilities: records.map((r) => ({ capability: r.capability, verdict: r.verificationVerdict })), hostPreservation: execution.composition.finalPreservation, stepsFailed: 0 }, { now });
          // The execution is concluded first: the ledger takes capabilities from a COMPLETED assembly only.
          concludeExecution(execution, { now });
          if (execution.status !== 'COMPLETED') throw fail('final-verification', `The execution concluded ${execution.status}, not COMPLETED.`);
          const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: host.repositoryIdentity || { name: host.projectName }, baseRevision: candidate.headAtPrepare, workingBranch: candidate.branch, primaryBranch: host.branch || 'main', worktreePath: candidate.worktreePath, primaryRoot: host.root, hostId: hostNow?.hostId || host.fingerprint?.hostId || null, now });
          commitLedgerTransition(workspace, { records, revision: finalRevision, now });
          try { persistWorkspace(workspace); }
          catch (err) {
            // The ledger could not be written: nothing is CURRENT anywhere, and the execution says so.
            return end(fail('ledger-write', `The assembly ledger could not be written: ${err.message}`));
          }
          execution.assemblyWorkspaceId = workspace.assemblyWorkspaceId; execution.assembledRevision = finalRevision;
          persistExecution(execution);
          return { execution, workspace, promotable: true, error: null };
        }
        default: throw fail('unknown-step', `The plan has a step this execution does not know: ${planned.type}.`);
      }
      persistExecution(execution);
    }
    throw fail('final-verification', 'The plan ended without a FINAL_VERIFICATION step.');
  } catch (err) {
    return end(err);
  }
}
