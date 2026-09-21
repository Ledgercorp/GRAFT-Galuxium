// Real Multi-Capability Composition 0.1 — the REAL operations behind `executeCompositionPlan`.
//
// Checkpoint B proved the kernel over injected operations. This module supplies the real ones, and
// nothing else: every authoritative act is an operation GRAFT already has, composed in the order
// the kernel asks for. There is no second engine here and no capability is named.
//
//   createHost              laboratory/execution createHost (+ workspace registration)
//   reindexHost             analyze/fingerprint → engine/host → harvest detectors (host truth, detector truth)
//   prepareCandidate        apply/worktree prepareTransplant — ONE candidate for every capability
//   captureHostBaseline     plan hostPreservationTests → verify captureHostBaseline, BEFORE any write
//   checkArtifactIdentity   laboratory/library-assembly recheck → adapt/library-host checkArtifactIdentity
//   applyCapability         by the plan step's type: service → plan createTransplantPlan → apply
//                           checkPreconditions → applyTransplant; library → adapt/library-host
//                           adaptLibraryCapability → applyLibraryAdaptation. Nothing is flattened.
//   verifyCapability        by implementation form, at the requested phase, against the candidate as
//                           it is NOW: service → verify verifyCapability (the capability's own contract,
//                           provider double included); library → adapt/verify verifyAdaptedLibraryCapability.
//                           A re-verification is the same call again; no earlier verdict is reused.
//   checkHostPreservation   adapt/verify verifyHostPreservation with the composition's own baseline —
//                           the single-capability operations that capture their own baseline are not
//                           used here, so nothing can replace the pre-A baseline after A.
//   commitCandidate         laboratory/continuity commitAssembledState
//   inspectCandidate        apply/git inspectRepo
import path from 'node:path';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { buildHostModel } from '../engine/host.js';
import { discoverCapabilities } from '../harvest/index.js';
import { readManifest, readOrganEngine } from '../manifest/io.js';
import { bankDir, graftHome, addProject, recordTransplant } from '../registry/index.js';
import { createTransplantPlan, hostPreservationTests } from '../plan/index.js';
import { applyTransplant, checkPreconditions } from '../apply/index.js';
import { prepareTransplant, transition, stateForVerdict } from '../apply/worktree.js';
import { inspectRepo } from '../apply/git.js';
import { repositoryIdentity } from '../workspace/identity.js';
import { verifyCapability, captureHostBaseline } from '../verify/index.js';
import { sourceRevisionOf } from '../verify/proof-envelope.js';
import { checkArtifactIdentity, adaptLibraryCapability, applyLibraryAdaptation, libraryArtifactOf } from '../adapt/library-host.js';
import { verifyAdaptedLibraryCapability, verifyHostPreservation } from '../adapt/verify.js';
import { recheckLibraryAdaptationSupport, librarySourceRoot } from './library-assembly.js';
import { createHost, createExecution, saveExecution } from './execution.js';
import { commitAssembledState } from './continuity.js';
import { executeCompositionPlan, plannedCapabilities } from './composition.js';
import { recordAssemblyOutcomes } from './atlas-outcomes.js';

const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
/** The fingerprint fields the kernel compares with the plan (through `checkCreatedHost`), read from the real fingerprint. */
const shapeOf = (fp, host) => ({ moduleSystem: fp.moduleSystem.value, framework: fp.framework.value, handlerContract: fp.handlerContract.value, profile: host.constraints.adaptationProfile, central: fp.central ? { supported: fp.central.supported === true, reason: fp.central.reason || null } : null, hostId: host.hostId, entrypoint: fp.entrypoint });

/**
 * The real operations for one composition. `plan` is the assembly plan; the bank supplies every
 * capability by the slug the plan names. Returns the `ops` object the kernel consumes, plus
 * `conclude` for the transplant record once the kernel has finished.
 */
export function realCompositionOps({ plan, destinationParent, projectName, timeoutMs = 15000, onPhase = () => {} }) {
  const organs = new Map();
  const organ = (slug) => {
    if (!organs.has(slug)) {
      const dir = path.join(bankDir(), `${slug}.graft`);
      const manifest = readManifest(dir);
      const engine = (() => { try { return readOrganEngine(dir); } catch { return null; } })();
      organs.set(slug, { manifest, engine });
    }
    return organs.get(slug);
  };
  const state = { host: null, index: null, candidate: null, baseline: null, applied: new Map() };
  const worktreeOf = (candidate) => candidate.worktreePath;

  const ops = {
    createHost: async ({ execution }) => {
      const receipt = createHost({ parentDir: destinationParent, name: projectName, architectureId: plan.host.architectureId, executionId: execution.executionId, planId: plan.planId, hostId: plan.host.hostId });
      addProject(receipt.root);
      state.host = receipt;
      const identity = repositoryIdentity(receipt.root);
      return { root: receipt.root, projectName: receipt.projectName, branch: receipt.branch, initialCommit: receipt.initialCommit, files: receipt.files, fingerprint: receipt.fingerprint, repositoryIdentity: { name: receipt.projectName, repositoryId: identity.repositoryId || null }, receipt };
    },
    reindexHost: async ({ root }) => {
      const fp = fingerprintProject(root);
      const host = buildHostModel(fp);
      const observed = discoverCapabilities(fp).map((c) => ({ id: c.id, category: c.category, confidence: c.confidence, harvestable: c.harvestable }));
      // Detector truth per planned capability, as the detectors report it — never composition-aware.
      const detectorObservation = Object.fromEntries(plannedCapabilities(plan).map((c) => { const category = organ(c.capability.slug).manifest.identity.category; return [c.capability.slug, observed.some((o) => o.category === category) ? 'OBSERVED' : 'NOT_OBSERVED']; }));
      state.index = { ...shapeOf(fp, host), routes: host.routing.routes.length, observedCapabilities: observed, detectorObservation };
      return state.index;
    },
    prepareCandidate: async ({ host, capabilities }) => {
      const t = prepareTransplant({ destinationRoot: host.root, sourceRoot: null, capabilitySlug: 'composition', capabilities: capabilities.map((c) => c.slug) });
      transition(t.id, 'READY', { plan: { planId: plan.planId, status: 'composition', compatibility: 'composition', capabilities: capabilities.map((c) => c.slug), files: [], entrypoint: host.fingerprint?.entrypoint || null, recipe: null } });
      state.candidate = { worktreePath: t.worktree.path, branch: t.worktree.branch, transplantId: t.id, headAtPrepare: t.baseHead };
      return state.candidate;
    },
    captureHostBaseline: async ({ candidate }) => {
      const root = worktreeOf(candidate);
      const fp = fingerprintProject(root);
      // The probes exclude every endpoint any planned capability will add, so a route a capability
      // legitimately introduces is never mistaken for a change in the host's own behaviour.
      const endpoints = plannedCapabilities(plan).flatMap((c) => organ(c.capability.slug).manifest.architecture?.capabilityModel?.endpoints || []);
      const probes = hostPreservationTests(fp, { architecture: { capabilityModel: { endpoints } } });
      onPhase('Recording the host’s own behaviour');
      const baseline = await captureHostBaseline(root, { entrypoint: fp.entrypoint, tests: probes, timeoutMs });
      state.baseline = baseline;
      return { captured: baseline.captured, reason: baseline.reason, tests: baseline.tests, observed: baseline.observed };
    },
    checkArtifactIdentity: async ({ capability }) => {
      const { manifest, engine } = organ(capability.slug);
      onPhase(`Checking ${manifest.identity.name}'s verified artifact`);
      const recheck = recheckLibraryAdaptationSupport({ plan, manifest, engine, hostFingerprint: state.index, plannedCapabilityId: capability.capabilityId });
      if (!recheck.ok) return { matched: false, reason: recheck.stale.length ? 'plan-stale' : 'adaptation-unsupported', detail: `${recheck.stale.length ? 'the plan no longer matches what exists' : 'GRAFT cannot adapt this capability into this host'}: ${recheck.reasons.join('; ')}` };
      const sourceRoot = librarySourceRoot(manifest);
      const identity = checkArtifactIdentity({ manifest, sourceRoot });
      state.applied.set(capability.slug, { form: 'library', manifest, engine, sourceRoot, host: recheck.host, support: recheck.support, capabilityId: recheck.actualCapabilityId });
      return { matched: identity.matched === true, expected: identity.expected, actual: identity.actual, entry: libraryArtifactOf(manifest).entry, reason: identity.reason || null, detail: identity.detail || null };
    },
    applyCapability: async ({ candidate, capability, step }) => {
      const root = worktreeOf(candidate);
      const { manifest, engine } = organ(capability.slug);
      onPhase(`Adding ${manifest.identity.name}`);
      if (step.type === 'ADAPT_LIBRARY_CAPABILITY') {
        const prepared = state.applied.get(capability.slug);
        if (!prepared?.sourceRoot) throw fail('identity-not-checked', `${capability.slug}: the artifact identity was not checked before the adaptation.`);
        const adaptation = adaptLibraryCapability({ manifest, sourceRoot: prepared.sourceRoot, host: prepared.host });
        const receipt = applyLibraryAdaptation({ plan: adaptation, destinationRoot: root });
        transition(candidate.transplantId, 'APPLIED', { receipt: { capability: capability.slug, adaptation: adaptation.adaptation, filesWritten: receipt.files.map((f) => f.path) }, reason: `${capability.slug} written` });
        state.applied.set(capability.slug, { ...prepared, adaptation });
        return {
          filesWritten: receipt.files.map((f) => f.path),
          capabilitySource: { kind: engine?.genome?.identity?.kind || manifest.identity.category, implementationForm: 'library', genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null, sourceProject: manifest.provenance?.sourceProject?.name || null, sourceRevision: sourceRevisionOf(manifest) || manifest.provenance?.sourceProject?.revision || null, sourceVerification: manifest.provenance?.verifiedInSource ? { verdict: manifest.provenance.verifiedInSource.verdict, summary: manifest.provenance.verifiedInSource.summary || null, at: manifest.provenance.verifiedInSource.at || null } : null },
          transplantPlan: null,
          adaptation: { id: adaptation.adaptation, method: adaptation.method, artifact: adaptation.artifactIdentity.destinationPath, artifactSha256: adaptation.artifactIdentity.sha256, adapter: adaptation.verifyThrough.entry, hostProfile: prepared.host.profile, interop: adaptation.interop.mechanism, checks: (prepared.support?.checks || []).map((c) => ({ id: c.id, ok: c.ok })), upstream: { repository: adaptation.provenance.source.repository, revision: adaptation.provenance.source.revision, package: adaptation.provenance.source.package }, licence: { declared: adaptation.provenance.licence.declared, file: adaptation.provenance.licence.file } },
          proofReferences: [{ kind: 'library-adaptation', adaptation: adaptation.adaptation, artifactSha256: adaptation.artifactIdentity.sha256 }],
        };
      }
      if (step.type !== 'TRANSPLANT_CAPABILITY') throw fail('unknown-apply-step', `${step.type} is not a step that applies a capability.`);
      // Service: the existing transplant chain, inside the composition candidate.
      const actualCapabilityId = engine?.genome?.identity?.capabilityId || null;
      if (actualCapabilityId !== capability.capabilityId) throw fail('capability-identity-changed', `The banked capability is not the one the plan selected (${capability.capabilityId} planned, ${actualCapabilityId || 'none'} in the bank).`);
      const fp = fingerprintProject(root);
      const tplan = await createTransplantPlan(manifest, fp, { resolveConflicts: false, atlas: 'local' });
      if (tplan.status !== 'ready') throw fail(`transplant-plan-${tplan.status}`, `The transplant plan is ${tplan.status}: ${tplan.compatibility?.status || ''} ${(tplan.compatibility?.reasons || tplan.compatibility?.blockers || []).map((r) => r.detail || r.message || r).join('; ')}`.trim());
      // The candidate holds earlier capabilities as commits, so its tree is clean; a dirty tree is refused as always.
      const safety = checkPreconditions(tplan, root);
      if (!safety.ok) throw fail('preconditions', safety.problems.map((x) => x.message).join(' '));
      const result = applyTransplant(tplan, root, { createBranch: false });
      if (result.refused) throw fail('apply-refused', result.problems.map((x) => x.message).join(' '));
      recordTransplant({ planId: tplan.id, capability: manifest.identity.slug, destination: root, branch: candidate.branch, appliedAt: result.receipt.appliedAt });
      transition(candidate.transplantId, 'APPLIED', { receipt: { capability: capability.slug, path: result.receiptPath, planId: tplan.id, branch: candidate.branch, filesWritten: result.filesWritten, entrypoint: { file: tplan.destination.entrypoint, edits: result.entrypointEdits?.length || 0 } }, reason: `${capability.slug} written` });
      state.applied.set(capability.slug, { form: 'service', manifest, engine, tplan, capabilityId: actualCapabilityId });
      return {
        filesWritten: result.filesWritten,
        capabilitySource: { kind: engine?.genome?.identity?.kind || null, implementationForm: 'service', genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null, sourceProject: manifest.provenance?.sourceProject?.name || null, sourceRevision: sourceRevisionOf(manifest) || manifest.provenance?.sourceProject?.revision || manifest.identity?.sourceRevision || null, sourceVerification: manifest.provenance?.verifiedInSource ? { verdict: manifest.provenance.verifiedInSource.verdict, summary: manifest.provenance.verifiedInSource.summary || null, at: manifest.provenance.verifiedInSource.at || null } : null },
        transplantPlan: { planId: tplan.id, status: tplan.status, compatibility: tplan.compatibility.status, profile: tplan.adaptation?.profile || null, files: tplan.files.map((f) => f.path), entrypoint: tplan.destination.entrypoint, recipe: tplan.engine.recipe?.name || null, recipeId: tplan.engine.recipe?.recipeId || null, checks: (tplan.compatibility.checks || []).map((c) => ({ id: c.id, status: c.status })) },
        adaptation: null,
        proofReferences: [{ kind: 'apply-receipt', path: result.receiptPath }],
      };
    },
    verifyCapability: async ({ candidate, capability, phase, alongside }) => {
      const root = worktreeOf(candidate);
      const applied = state.applied.get(capability.slug);
      if (!applied) throw fail('not-applied', `${capability.slug} was not applied in this candidate.`);
      onPhase(`${phase === 'reverify' ? 'Re-verifying' : 'Verifying'} ${applied.manifest.identity.name}${alongside?.length ? ` after ${alongside.join(', ')}` : ''}`);
      if (applied.form === 'library') {
        // The identities this composition already holds for the capability travel into its proof.
        const provenance = { sourceRevision: sourceRevisionOf(applied.manifest), capabilityId: applied.capabilityId || capability.capabilityId || null, genomeId: applied.engine?.genome?.genomeId || null, irId: applied.engine?.ir?.irId || null };
        const report = await verifyAdaptedLibraryCapability({ plan: applied.adaptation, destinationRoot: root, timeoutMs, provenance });
        return { verdict: report.verdict, summary: report.summary || null, rationale: report.rationale || null, method: report.method || null, proofOf: report.proofOf, finishedAt: report.finishedAt || null, invariants: [], counterfactuals: [],
          outcomes: (report.results || []).map((r) => ({ id: r.id, outcome: r.outcome, ...(r.outcome !== 'passed' && r.reason ? { reason: String(r.reason).split(graftHome()).join('$GRAFT_HOME').slice(0, 400) } : {}) })),
          proofEnvelope: report.proofEnvelope || null, proofEnvelopeReason: report.proofEnvelopeReason || null,
          proofReference: { kind: 'library-adaptation-proof', adaptation: applied.adaptation.adaptation, artifactSha256: applied.adaptation.artifactIdentity.sha256, cases: report.summary?.required ?? null, passed: report.summary?.passed ?? null, verdict: report.verdict } };
      }
      // The capability's own contract, run again from scratch against the candidate as it is now.
      // A re-verification runs against a revision that is already committed, so the project-local
      // observation is computed but not written into the tree (it is kept in the execution's
      // evidence); the initial verification records it as every transplant does, before the commit.
      const report = await verifyCapability(applied.manifest, root, { entrypoint: applied.tplan.destination.entrypoint, atlas: null, timeoutMs, recordKnowledge: phase !== 'reverify', provenance: { sourceRevision: sourceRevisionOf(applied.manifest), capabilityId: applied.capabilityId || capability.capabilityId || null }, onProgress: (event) => { if (event.stage === 'test') onPhase(`${phase === 'reverify' ? 'Re-running' : 'Running'} ${applied.manifest.identity.name} verification (${event.index}/${event.total})`); } });
      return { verdict: report.verdict, summary: report.summary || null, rationale: report.rationale || null, method: report.method || null, finishedAt: report.finishedAt || null,
        // Per-test outcomes with the verifier's own reasons (paths under GRAFT_HOME elided): the evidence a person needs when a verdict is not VERIFIED.
        outcomes: (report.results || []).map((r) => ({ id: r.id, outcome: r.outcome, ...(r.outcome !== 'passed' && r.reason ? { reason: String(r.reason).split(graftHome()).join('$GRAFT_HOME').slice(0, 400) } : {}) })),
        observation: report.compatibilityObservation ? { eventId: report.compatibilityObservation.eventId, recorded: report.compatibilityObservation.recorded !== false, result: report.compatibilityObservation.result || null } : null,
        invariants: (report.proof?.invariants || []).map((i) => ({ id: i.id || i.invariant || null, status: i.status })), counterfactuals: (report.proof?.counterfactualCases || []).map((c) => ({ id: c.id, outcome: c.outcome })),
        proofReference: report.proof ? { kind: 'proof', contractId: report.proof.contractId, summary: report.proof.summary, verdict: report.verdict, phase } : null, providerDouble: report.providerDouble?.injectedThrough || null,
        proofEnvelope: report.proofEnvelope || null, proofEnvelopeReason: report.proofEnvelopeReason || null };
    },
    checkHostPreservation: async ({ candidate, baseline }) => {
      if (!baseline?.captured) return { captured: false, tests: 0, passed: 0, failed: 0 };
      onPhase('Checking the host still behaves as it did before composition');
      // The application now holds every capability applied so far; a hosted one only boots with
      // its provider double, exactly as its own verifier boots it.
      const doublesFor = [...state.applied.values()].filter((a) => a.form === 'service' && a.tplan).map((a) => a.manifest);
      const p = await verifyHostPreservation({ destinationRoot: worktreeOf(candidate), tests: baseline.tests, timeoutMs, doublesFor });
      return { captured: true, tests: p.tests, passed: p.passed, failed: p.failed, inconclusive: p.inconclusive, verdict: p.verdict, reason: p.tests === 0 ? p.rationale || null : null, results: p.results.map((r) => ({ id: r.id, outcome: r.outcome })) };
    },
    commitCandidate: async ({ candidate, capability }) => commitAssembledState(worktreeOf(candidate), { capability: capability.name || capability.slug }),
    inspectCandidate: async ({ candidate }) => { const r = inspectRepo(worktreeOf(candidate)); return { head: r.head, dirty: r.dirty, branch: r.branch }; },
    /** After the kernel: the transplant record takes the state the execution earned. */
    conclude: ({ execution, promotable }) => {
      if (!state.candidate) return null;
      const verdict = promotable ? 'VERIFIED' : execution.status === 'INCONCLUSIVE' ? 'NEEDS_REVIEW' : 'FAILED';
      return transition(state.candidate.transplantId, stateForVerdict(verdict), { verdict: { verdict, rationale: execution.error?.message || null, summary: { capabilities: (execution.composition?.capabilities || []).map((c) => ({ capability: c.capability, verdict: c.finalVerdict })) }, at: execution.finishedAt || null }, reason: promotable ? 'every capability verified at the final revision' : `composition ${execution.status}` });
    },
    state, organ,
  };
  return ops;
}

/** Run a multi-capability plan for real: the kernel over the real operations, then the transplant record. */
export async function runRealComposition({ plan, destinationParent, projectName, timeoutMs = 15000, onPhase = () => {}, onExecution = () => {}, now = () => new Date().toISOString() }) {
  const ops = realCompositionOps({ plan, destinationParent, projectName, timeoutMs, onPhase });
  const execution = createExecution(plan, { destinationParent, projectName, now });
  const persistExecution = (e) => { saveExecution(e); onExecution(e); };
  const result = await executeCompositionPlan(execution, plan, { ...ops, persistExecution }, { now, onPhase });
  // One attempt, one Atlas observation per capability, from the execution's final state.
  recordAssemblyOutcomes({ execution: result.execution, plan, organ: ops.organ, now });
  persistExecution(result.execution);
  const transplant = ops.conclude({ execution: result.execution, promotable: result.promotable });
  return { ...result, transplant, candidate: ops.state.candidate, host: ops.state.host };
}
