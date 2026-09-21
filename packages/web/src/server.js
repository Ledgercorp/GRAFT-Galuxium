import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../../core/src/analyze/fingerprint.js';
import { discoverCapabilities, harvestCapability } from '../../core/src/harvest/index.js';
import { readManifest, writeManifest, listOrganBank, readOrganEngine } from '../../core/src/manifest/io.js';
import { createTransplantPlan } from '../../core/src/plan/index.js';
import { applyTransplant, checkPreconditions } from '../../core/src/apply/index.js';
import { planEntrypointEdit } from '../../core/src/emit/entrypoint.js';
import { verifyCapability, captureHostBaseline } from '../../core/src/verify/index.js';
import { exportCapabilityPackage, buildCapabilityPackage, loadExportReceipts, defaultExportDir } from '../../core/src/export/index.js';
import { createBlueprint, loadBlueprint, saveBlueprint, listBlueprints, deleteBlueprint, addGoal, removeGoal, updateGoal, selectImplementation, setHostIntent, recordAgentAdvice, viewBlueprint, goalsFromDescription, GUIDED_QUESTIONS, GOAL_CATEGORIES } from '../../core/src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification, existingHostSpecification, NEW_HOST_ARCHITECTURES, saveAssemblyPlan, loadAssemblyPlan, listAssemblyPlans, deleteAssemblyPlan, viewAssemblyPlan, recordPlanAdvice } from '../../core/src/laboratory/assembly.js';
import { buildHostModel } from '../../core/src/engine/host.js';
import { createAssemblyWorkspace, recordAssembledCapability, commitAssembledState, evaluateWorkspace, capabilityPresence, checkPromotion, promoteAssembly, saveAssemblyWorkspace, loadAssemblyWorkspace, listAssemblyWorkspaces, workspaceForProject } from '../../core/src/laboratory/continuity.js';
import { createHost, checkCreatedHost, createExecution, saveExecution, loadExecution, listExecutions, beginStep, finishStep, failStep, concludeExecution, acquireExecutionLock, checkExecutionEligibility } from '../../core/src/laboratory/execution.js';

// GRAFT's own version, recorded in every exported package.
const GRAFT_VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || null; } catch { return null; } })();
import { repairAndVerify } from '../../core/src/engine/repair.js';
import { buildSemanticChangeset } from '../../core/src/engine/changeset.js';
import { addProject, loadRegistry, bankDir, graftHome, recordTransplant, removeProject } from '../../core/src/registry/index.js';
import { safeProjectPath } from '../../core/src/util/paths.js';
import { GRAFT_ENGINE_VERSION } from '../../core/src/engine/index.js';
import { openDogfoodSession, recorderFromEnvironment, repositoryIdentity, planSummary, reportSummary } from '../../core/src/dogfood/index.js';
import { addRoot, removeRoot, buildIndex, loadIndex, refreshProject, staleProjects, searchCapabilities, getCapability, indexSummary, discoverCapabilityCandidates } from '../../core/src/workspace/index.js';
import { loadAgentConfig, saveAgentConfig, clearAgentConfig, describeAgentConfig, resolveApiKey } from '../../core/src/agent/config.js';
import { createAgentRuntime, createGrant, SCOPES } from '../../core/src/agent/runtime.js';
import { prepareTransplant, listTransplants, getTransplant, assertApplyable, transition, stateForVerdict, changedFiles, cleanupTransplant, worktreesDir } from '../../core/src/apply/worktree.js';
import { profilesByKind } from '../../core/src/emit/profiles.js';
import { runLibraryAdaptation, recheckLibraryAdaptationSupport, librarySourceRoot } from '../../core/src/laboratory/library-assembly.js';
import { runRealComposition } from '../../core/src/laboratory/composition-ops.js';
import { describeLibraryIntegration } from '../../core/src/adapt/library-host.js';
import { verifyAdaptedLibraryCapability } from '../../core/src/adapt/verify.js';
import { sourceRevisionOf } from '../../core/src/verify/proof-envelope.js';
import { storeProof, verifyStoredProof, proofIntegrity } from '../../core/src/laboratory/proof-store.js';
import { recordAssemblyOutcomes } from '../../core/src/laboratory/atlas-outcomes.js';
import { exportAssemblyProofs } from '../../core/src/laboratory/proof-store.js';
import { assessRecovery, describeFailure, releaseStaleExecutionLock, annotateRecovery } from '../../core/src/laboratory/recovery.js';
import { saveDiagnostics, diagnosticsFileName } from '../../core/src/laboratory/diagnostics.js';
import { inspectRepo } from '../../core/src/apply/git.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let staleMemo = null;
const publicDir = path.resolve(here, '../public');
const fixtures = path.resolve(here, '../../../fixtures');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const projectId = (root) => hash(root).slice(0, 24);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Dogfood summaries must never fail a customer request: a summariser error is recorded instead.
const identity = (fp) => { try { return repositoryIdentity(fp); } catch (err) { return { identityError: err.message }; } };

function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Expected a JSON object.');
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw fail('Unknown request field.');
}
function string(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw fail(`${name} is required.`);
  return value.trim();
}
function project(id) {
  const found = loadRegistry().projects.find((p) => projectId(p.root) === id);
  if (!found) throw fail('Project is no longer registered. Refresh the workspace.', 404);
  if (fs.realpathSync(found.root) !== found.root) throw fail('Project path changed. Register its current real path again.', 409);
  return found;
}
function manifest(slug) {
  if (typeof slug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) throw fail('Invalid capability name.');
  return readManifest(path.join(bankDir(), `${slug}.graft`));
}
function snapshot(fp, m) {
  return hash(JSON.stringify({ root: fs.realpathSync(fp.root), manifest: m, package: fp.packageJson,
    files: fp.files.map((file) => [file, fp.readFile(file)]), entrypoint: fp.entrypoint && fp.readFile(fp.entrypoint) }));
}
function projectSummary(p) {
  try {
    const fp = fingerprintProject(p.root);
    return { ...p, id: projectId(p.root), framework: fp.framework.value, moduleSystem: fp.moduleSystem.value,
      routes: fp.routes.length, capabilities: discoverCapabilities(fp) };
  } catch (err) { return { ...p, id: projectId(p.root), error: err.message, capabilities: [] }; }
}
function bankSummary() {
  return listOrganBank(bankDir()).map((entry) => {
    if (entry.error) return { slug: path.basename(entry.dir, '.graft'), error: entry.error };
    const m = entry.manifest;
    // Implementation form and what it means for integration travel with the capability, so the
    // product can say "verified" and "not yet integrable" in the same breath without contradiction.
    const form = m.identity.implementationForm || (Array.isArray(m.architecture?.capabilityModel?.endpoints) && m.architecture.capabilityModel.endpoints.length ? 'service' : null);
    return { ...m.identity, implementationForm: form,
      integration: form === 'library' ? describeLibraryIntegration({ kind: m.identity.category }) : { supported: true, reason: null },
      library: form === 'library' ? { artifact: m.architecture?.capabilityModel?.artifact?.entry || null, packageName: m.architecture?.capabilityModel?.artifact?.packageName || null, packageVersion: m.architecture?.capabilityModel?.artifact?.packageVersion || null, operations: (m.architecture?.capabilityModel?.operations || []).map((o) => o.name) } : null,
      source: m.identity.sourceProject, verification: m.provenance.verifiedInSource,
      statements: m.behavior.statements, tests: m.acceptanceTests.tests.map(({ id, description, required }) => ({ id, description, required })),
      notFound: m.behavior.notFound || [] };
  });
}

/** What the discovery UI needs about an indexed project. Bounded; no file lists, no source. */
function indexedProjectSummary(project) {
  if (project.error) return { projectId: project.projectId, root: project.root, error: project.error, capabilities: [] };
  return {
    projectId: project.projectId, repositoryId: project.repositoryId, name: project.name, root: project.root,
    relativeRoot: project.relativeRoot, subprojectOf: project.subprojectOf, boundaryReason: project.boundaryReason,
    repository: { name: project.repository.name, branch: project.repository.branch, head: project.repository.head,
      dirty: project.repository.dirty, isGit: project.repository.isGit, isWorktree: project.repository.isWorktree,
      worktrees: project.repository.worktrees.length },
    language: project.language, runtime: project.runtime, moduleSystem: project.moduleSystem, framework: project.framework,
    packageManager: project.packageManager, isCompiled: project.isCompiled, sourceRoot: project.sourceRoot, buildOutputDir: project.buildOutputDir,
    entrypoint: project.entrypoint, hasHttpServer: project.hasHttpServer, handlerContract: project.handlerContract,
    routeIdioms: project.routeIdioms, routeCount: project.routes?.length || 0,
    dependencyCount: project.dependencies?.length || 0, environmentVariableCount: project.environmentVariables?.length || 0,
    externalHosts: project.externalHosts, deployTargets: project.deployTargets, testCommands: project.testCommands?.map((t) => t.name) || [],
    fileCount: project.fileCount, indexedAt: project.indexedAt, indexElapsedMs: project.indexElapsedMs,
    capabilities: (project.capabilities || []).map((c) => ({ capability: c.capability, state: c.state, subtypes: c.subtypes,
      confidence: c.confidence, harvestable: c.harvestable, transplantSupport: c.transplantSupport,
      asDestination: c.asDestination, localVerification: c.localVerification, signalCount: c.signals.length,
      auth: c.auth ? { credentialAuthority: c.auth.credentialAuthority, sessionTransport: c.auth.sessionTransport,
        sessionCustody: c.auth.sessionCustody, sessionStore: c.auth.sessionStore, sessionDurableAcrossRestart: c.auth.sessionDurableAcrossRestart,
        providers: c.auth.providers } : null, flags: c.flags || null })),
  };
}

/** Build an agent runtime from the saved config, or null when none is configured/ready. */
function agentRuntime(scopes = null) {
  const config = loadAgentConfig();
  if (!config) return null;
  const apiKey = resolveApiKey(config);
  if (!apiKey && !config.endpoint) return null;
  return createAgentRuntime({ provider: config.provider, apiKey, model: config.model, endpoint: config.endpoint,
    grant: createGrant(scopes || config.scopes, { reason: 'saved agent configuration' }) });
}

/** A transplant record as the UI shows it: lifecycle facts, never a manufactured verdict. */
function transplantView(t) {
  return { id: t.id, state: t.state, capabilitySlug: t.capabilitySlug, capabilities: t.capabilities || [t.capabilitySlug], createdAt: t.createdAt, updatedAt: t.updatedAt,
    destination: { name: t.destination.name, root: t.destination.root, branchBefore: t.destination.branchBefore, dirtyAtPreparation: t.destination.dirtyAtPreparation },
    source: t.source ? { root: t.source.root } : null, baseHead: t.baseHead, worktree: t.worktree, live: t.live || null,
    plan: t.plan, receipt: t.receipt, verdict: t.verdict, history: t.history, error: t.error || null };
}

/** The plan as a person reviews it before anything is written. Every fact comes from the plan. */
function planReview(plan) {
  const e = plan.engine || {};
  const policies = e.ir?.policies || {};
  return {
    capability: { name: plan.capability.name, slug: plan.capability.slug, kind: e.genome?.identity.kind || null },
    filesToCreate: plan.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.contents || '', 'utf8') })),
    filesToEdit: plan.destination.entrypoint && plan.files.length ? [{ path: plan.destination.entrypoint, change: plan.steps.find((s) => s.kind === 'register-routes')?.description || 'route registration' }] : [],
    dependencies: { added: (e.analysis?.requiredComponents?.dependencies || []).filter((d) => !d.presentInHost).map((d) => d.name), removed: [] },
    securitySensitive: [
      ...(policies.session ? [`session cookie ${policies.session.cookieName}${policies.session.httpOnly ? ' HttpOnly' : ''}${policies.session.sameSite ? ` SameSite=${policies.session.sameSite}` : ''}${policies.session.durableAcrossRestart === false ? ' (not durable across restart, by design)' : ''}`] : []),
      ...(policies.credentialAuthority ? [`credential authority: ${policies.credentialAuthority.kind}${policies.credentialAuthority.provider ? ` (${policies.credentialAuthority.provider})` : ''}`] : []),
      ...(policies.passwordHash ? [`password hashing: ${policies.passwordHash.algorithm}`] : []),
      ...(policies.csrf ? [`same-origin checks on mutations (${policies.csrf.headerName})`] : []),
      ...(policies.guard ? [`authorization guard answers ${policies.guard.unauthenticatedStatus}`] : []),
    ],
    configuration: (e.ir?.environment || []).map((v) => ({ name: v.name, required: v.required, introduced: true })),
    routes: (e.ir?.operations || []).map((o) => `${o.method} ${o.path}`),
    registration: plan.registration ? { module: plan.registration.module, strategy: plan.adaptation.profile === 'esm-node-http-central' ? 'first refusal inside the central request handler' : `${plan.registration.name}() in the entrypoint` } : null,
    verification: e.verificationContract ? { success: e.verificationContract.successCases.length, counterfactual: e.verificationContract.counterfactualCases.length, invariants: e.verificationContract.invariants.length,
      unobserved: e.verificationContract.invariants.filter((i) => !i.checkedBy.length).map((i) => i.id), hostPreservation: (plan.preservation || []).length, providerDouble: e.genome?.identity.kind === 'hosted-session-auth' } : null,
    compatibility: { status: plan.compatibility.status, warnings: plan.compatibility.warnings.map((w) => ({ id: w.id, title: w.title, detail: w.detail })), blocking: plan.compatibility.blocking.map((b) => ({ id: b.id, title: b.title, detail: b.detail })) },
    adaptations: (e.analysis?.adaptations || []).map((a) => ({ kind: a.kind, description: a.concrete || a.description })),
    risks: e.analysis?.risks || [], unknowns: e.analysis?.unknowns || [],
  };
}

/** Evidence as a person reads it: every number copied from the verifier's report. */
function proofView(report, repair, changeset, hostBaseline = null) {
  const proof = report.proof || null;
  const invariants = proof?.invariants || [];
  return {
    hostBaseline: hostBaseline ? { captured: hostBaseline.captured, reason: hostBaseline.reason || null, observed: (hostBaseline.observed || []).map((o) => ({ path: o.path, status: o.status })) } : null,
    verdict: report.verdict, rationale: report.rationale,
    required: { passed: report.summary.passed, total: report.summary.required, failed: report.summary.failed, inconclusive: report.summary.inconclusive },
    invariants: { held: invariants.filter((i) => i.status === 'held').length, violated: invariants.filter((i) => i.status === 'violated').length, unobserved: invariants.filter((i) => i.status === 'unobserved').length, list: invariants },
    counterfactuals: proof ? { total: proof.counterfactualCases.length, passed: proof.counterfactualCases.filter((c) => c.outcome === 'passed').length, cases: proof.counterfactualCases } : null,
    successCases: proof ? proof.successCases : [],
    hostPreservation: (report.results || []).filter((r) => r.id.startsWith('host.')).map((r) => ({ id: r.id, outcome: r.outcome })),
    runnerWitnesses: (report.results || []).filter((r) => r.id.startsWith('output.')).map((r) => ({ id: r.id, outcome: r.outcome })),
    routeCoverage: proof?.routeCoverage || [],
    repairs: { attempts: repair?.attempts?.length || 0, repaired: repair?.repaired === true },
    // Verification attempts, all of them: a stalled first attempt is shown, never erased.
    attempts: (report.attempts || []).map((a) => ({ attempt: a.attempt, verdict: a.verdict, classification: a.classification, detail: a.detail, summary: a.summary })),
    providerBoundary: report.providerDouble ? { kind: 'deterministic provider double', injectedThrough: report.providerDouble.injectedThrough, liveProvider: false, calls: report.providerDoubleCalls || [] } : null,
    atlas: report.atlasEntry ? { recorded: true, entryId: report.atlasEntry.entryId } : { recorded: false, error: report.atlasRecordingError || null },
    runtime: report.runtime, finishedAt: report.finishedAt,
    results: (report.results || []).map((r) => ({ id: r.id, outcome: r.outcome, required: r.required, description: r.description || null, reason: r.reason || null, steps: (r.steps || []).map((s) => ({ name: s.name, request: s.request, status: s.status, ok: s.ok, checks: s.checks })) })),
    changeset: changeset ? { created: changeset.componentsIntroduced.map((c) => c.path), modified: changeset.componentsAdapted.filter((c) => c.path).map((c) => c.path), security: changeset.securitySensitiveChanges, dependencies: changeset.dependenciesAdded } : null,
  };
}

function receiptFor(record) {
  if (!/^[a-zA-Z0-9_-]+$/.test(record.planId)) throw fail('Invalid saved transplant identifier.');
  return safeProjectPath(record.destination, `.graft/transplants/${record.planId}.json`);
}
function transplantSummary(record) {
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptFor(record), 'utf8'));
    return { ...record, verification: receipt.verification, report: receipt.verificationReport,
      receiptPath: receiptFor(record), rollback: receipt.recovery?.rollback };
  } catch (err) { return { ...record, receiptError: err.message }; }
}
function saveReport(record, report, repair = null) {
  const receiptPath = receiptFor(record);
  const before = fs.readFileSync(receiptPath, 'utf8');
  const receipt = JSON.parse(before);
  receipt.verification = { verdict: report.verdict, rationale: report.rationale, summary: report.summary, at: report.finishedAt };
  receipt.verificationReport = report;
  if (repair) receipt.repairs = repair;
  const temporary = safeProjectPath(record.destination, `.graft/transplants/${record.planId}-${crypto.randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); } finally { fs.closeSync(fd); }
    if (fs.readFileSync(receiptFor(record), 'utf8') !== before) throw fail('Receipt changed while saving verification. The new result is available in this session.', 409);
    fs.renameSync(temporary, receiptPath);
  } finally { if (created) fs.rmSync(temporary, { force: true }); }
}

// `dogfood`: name of a local dogfood record to append this session's decisions and verdicts to
// (source-free; see core/src/dogfood). Omitted: GRAFT_DOGFOOD in the environment, else no record.
export async function startDashboard({ port = 4317, authorize = () => true, dogfood = null } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw fail('Port must be an integer between 0 and 65535.');
  const context = { surface: 'workspace', engineVersion: GRAFT_ENGINE_VERSION };
  const record = dogfood === null ? recorderFromEnvironment(context) : openDogfoodSession(dogfood, { context });
  const token = crypto.randomBytes(32).toString('hex');
  const plans = new Map();
  const jobs = [];
  let active = null;
  let pending = Promise.resolve();
  let stopping = false;
  let closeTask;
  let origin;
  function idle() {
    if (stopping) throw fail('The dashboard is shutting down.', 503);
    if (active) throw fail('An operation is already running. Wait for it to finish.', 409);
  }
  /** The session's own event log (the local dogfood record, when one is active): the tail travels in a diagnostic bundle. Never anything else on disk. */
  const readSessionLog = () => { try { return record?.file && fs.existsSync(record.file) ? fs.readFileSync(record.file, 'utf8').split('\n').slice(-200).join('\n') : null; } catch { return null; } };
  /** Executions this process is still running: their job is live and carries the execution id. */
  const runningExecutions = () => new Set(jobs.filter((j) => j.kind === 'assembly' && j.status === 'running').map((j) => j.execution?.executionId).filter(Boolean));
  function launch(kind, label, operation) {
    idle();
    const job = { id: crypto.randomUUID(), kind, label, status: 'running', phase: 'Starting', startedAt: new Date().toISOString() };
    active = job;
    jobs.unshift(job);
    if (jobs.length > 50) jobs.pop();
    pending = Promise.resolve().then(() => operation(job)).then((result) => {
      job.result = result;
      job.status = result.report && result.report.verdict !== 'VERIFIED' ? 'failed' : 'completed';
      job.phase = job.status === 'completed' ? 'Complete' : 'Verification needs attention';
    }).catch((err) => { job.status = 'failed'; job.error = err.message; job.phase = 'Stopped'; record.error(kind, err, { job: job.id, label }); })
      .finally(() => { job.finishedAt = new Date().toISOString(); active = null; });
    return { job };
  }
  /**
   * Apply a reviewed transplant plan into `p.root` and verify it — the one path every apply takes,
   * from the dashboard's own Apply button and from Laboratory assembly execution alike. `saved` is
   * the reviewed plan record ({ plan, m, projectId, transplantId, baseHead }); the job's phases
   * follow the verifier's own progress. Verdicts are the verifier's; nothing here invents one.
   */
  async function applyAndVerify(saved, p, safety, job, { atlas = 'local' } = {}) {
        if (saved.transplantId) { const t = assertApplyable(saved.transplantId); if (inspectRepo(p.root).head !== t.baseHead) throw fail('The worktree moved before apply. Prepare a fresh transplant.', 409); }
        // Host preservation compares against the destination's own answers, captured before any
        // file is written; a destination that cannot boot yields no baseline and the report says so.
        job.phase = 'Recording how the destination answers today';
        const baseline = saved.plan.preservation?.length ? await captureHostBaseline(p.root, { entrypoint: saved.plan.destination.entrypoint, tests: saved.plan.preservation }) : { captured: false, reason: 'no host-preservation probes', tests: [], observed: [] };
        const preservationTests = baseline.captured ? baseline.tests : (saved.plan.preservation || []);
        job.hostBaseline = { captured: baseline.captured, reason: baseline.reason, observed: baseline.observed };
        job.phase = `Applying ${saved.plan.files.length + 1} changes`;
        const startingHead = safety.repo?.head || null;
        const timings = { applyMs: null, verifyMs: [], repairMs: null };
        const clock = () => { const t0 = process.hrtime.bigint(); return () => Number(process.hrtime.bigint() - t0) / 1e6; };
        const applyClock = clock();
        // A managed transplant is already isolated on its own branch; apply there rather than
        // cutting a second branch inside the worktree.
        const managedBranch = saved.transplantId ? getTransplant(saved.transplantId).worktree.branch : null;
        const result = applyTransplant(saved.plan, p.root, { createBranch: !saved.transplantId });
        timings.applyMs = applyClock();
        // The branch the transplant lives on: the one apply cut, or the managed worktree's own.
        const branch = result.branch || managedBranch;
        if (result.refused) { record.event('apply.refused', { planId: saved.plan.id, startingHead, problems: result.problems }, { stage: 'apply', elapsedMs: timings.applyMs }); throw fail(result.problems.map((p) => p.message).join(' '), 409); }
        // Preserve authoritative write outcome even if verification or recording later fails.
        job.applied = { branch, receiptPath: result.receiptPath, files: result.filesWritten, rollback: result.recovery.rollback };
        recordTransplant({ planId: saved.plan.id, capability: saved.m.identity.slug, destination: p.root,
          branch, appliedAt: result.receipt.appliedAt });
        if (saved.transplantId) transition(saved.transplantId, 'APPLIED', { receipt: { path: result.receiptPath, planId: saved.plan.id, branch, filesWritten: result.filesWritten, entrypoint: { file: saved.plan.destination.entrypoint, edits: result.entrypointEdits?.length || 0 } }, reason: 'files written' });
        job.phase = 'Booting destination';
        // Stages track the verifier's own progress; a counterfactual or host-preservation case is
        // named as such from the contract, never guessed.
        const counterfactual = new Set((saved.plan.engine?.verificationContract?.counterfactualCases || []).map((c) => c.id));
        const preservation = new Set(preservationTests.map((t) => t.id));
        const onProgress = (event) => {
          if (event.stage === 'boot') job.phase = 'Booting destination';
          else if (event.stage === 'retry') job.phase = `Verification stalled (${event.reason}); retrying once with a fresh process (attempt ${event.attempt})`;
          else if (event.stage === 'test') job.phase = preservation.has(event.id) ? `Checking host preservation (${event.index}/${event.total})` : counterfactual.has(event.id) ? `Checking counterfactuals (${event.index}/${event.total})` : `Running verification (${event.index}/${event.total})`;
          else if (event.stage === 'decide') job.phase = 'Recording evidence';
          else if (event.stage === 'record') job.phase = 'Updating Atlas';
        };
        const verify = async (extra) => {
          const verifyClock = clock();
          try { return await verifyCapability(saved.m, p.root, { entrypoint: saved.plan.destination.entrypoint, atlas, extraTests: preservationTests, onProgress, ...extra }); }
          finally { timings.verifyMs.push({ repair: extra.repair || null, elapsedMs: verifyClock() }); }
        };
        const loopClock = clock();
        let outcome;
        try { outcome = await repairAndVerify({ plan: saved.plan, destRoot: p.root, verify, maxAttempts: 1 }); }
        catch (err) { record.error('verify', err, { planId: saved.plan.id, branch, startingHead, timings }); throw err; }
        timings.repairMs = loopClock() - timings.verifyMs.reduce((sum, v) => sum + v.elapsedMs, 0);
        const report = outcome.report;
        const repair = { attempts: outcome.attempts, repaired: outcome.repaired, initialVerdict: outcome.initial.verdict };
        const changeset = buildSemanticChangeset({ plan: saved.plan, applied: result, report, proof: report.proof, repair });
        record.event('apply', { planId: saved.plan.id, startingHead, branch, filesWritten: result.filesWritten, receiptPath: result.receiptPath, entrypointEdits: (result.entrypointEdits || []).length, removedRoutes: result.removedRoutes || [],
          engine: result.receipt?.engine || null, report: reportSummary(report), initialReport: outcome.initial === report ? null : reportSummary(outcome.initial), repair: { ...repair, exhausted: outcome.exhausted, maxAttempts: outcome.maxAttempts }, changeset, timings, confirmations: ['trusted'] },
          { stage: 'apply', elapsedMs: timings.applyMs + timings.repairMs + timings.verifyMs.reduce((sum, v) => sum + v.elapsedMs, 0) });
        job.result = { report, repair, changeset, hostBaseline: job.hostBaseline, ...job.applied };
        saveReport({ destination: p.root, planId: saved.plan.id }, report, repair);
        if (saved.transplantId) transition(saved.transplantId, stateForVerdict(report.verdict), { verdict: { verdict: report.verdict, rationale: report.rationale, summary: report.summary, at: report.finishedAt, proof: report.proof ? { contractId: report.proof.contractId, summary: report.proof.summary } : null, atlasEntry: report.atlasEntry || null }, reason: 'verification finished' });
        return { report, repair, changeset, hostBaseline: job.hostBaseline, ...job.applied, transplantId: saved.transplantId, proof: proofView(report, repair, changeset, job.hostBaseline), review: planReview(saved.plan) };
  }
  /**
   * Laboratory 0.3: execute one READY_TO_ASSEMBLE plan for a new bare node:http host with exactly
   * one capability. Every step runs through the operation the plan named; the execution record
   * follows what actually happened. Failure at any step stops the rest; nothing is retried here
   * beyond the verifier's own transport-timeout retry; no agent takes part.
   */
  async function runAssembly({ plan, destinationParent, projectName, job, lock }) {
    const execution = createExecution(plan, { destinationParent, projectName });
    const persist = () => { saveExecution(execution); job.execution = executionSummary(execution); };
    let step = null;
    const stepFail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
    // Every terminal exit passes here: the attempt becomes one Atlas observation per capability
    // (success or failure, from the execution's final state), then the dogfood event is recorded.
    // Recording is at most once per execution (`execution.atlas`): if persist() or the event throws
    // after the Atlas write and the catch below lands here again, nothing more is recorded.
    const finishAssembly = (stage) => {
      recordAssemblyOutcomes({ execution, plan, organ: (slug) => { const m = manifest(slug); return { manifest: m, engine: (() => { try { return readOrganEngine(path.join(bankDir(), `${m.identity.slug}.graft`)); } catch { return null; } })() }; } });
      persist();
      record.event('laboratory.execute', executionEvent(execution), { stage });
    };
    // Proof Integrity 0.1: the durable proof of a capability comes from a verification of the
    // COMMITTED revision, never from the earlier verification of the uncommitted tree relabelled
    // with the commit hash. The committed tree is verified once more, its envelope is persisted in
    // the content-addressed proof store and read back intact, and only then may the ledger record
    // it. A verdict or proof failure here is a FINAL_VERIFICATION failure: no CURRENT record.
    const proveCommitted = async (committedRevision, verify) => {
      job.phase = 'Proving the assembly at its committed revision';
      const proven = await verify();
      if (proven.verdict !== 'VERIFIED') throw stepFail('verdict', `The committed revision ${String(committedRevision).slice(0, 12)} reported ${proven.verdict}: ${proven.rationale || ''}`.trim());
      const envelope = proven.proofEnvelope;
      if (envelope?.payload?.destination?.revision !== committedRevision) throw stepFail('proof-unavailable', `No proof envelope binds the committed revision ${String(committedRevision).slice(0, 12)} (${proven.proofEnvelopeReason || 'absent'}).`);
      let stored;
      try { stored = storeProof(envelope); } catch (err) { throw stepFail('proof-persistence', `The proof could not be made durable: ${err.message}`); }
      const back = verifyStoredProof(envelope.digest);
      if (!back.found || !back.intact) throw stepFail('proof-persistence', `The stored proof ${envelope.digest.slice(0, 12)} does not read back intact (${back.reasons.join('; ')}).`);
      execution.proof = { envelopeSchema: envelope.schema, envelopeDigest: envelope.digest, revision: committedRevision, verdict: envelope.payload.verdict, stored: stored.stored };
      return { proven, envelope };
    };
    try {
      persist();
      // 1. CREATE_HOST
      step = beginStep(execution, 'CREATE_HOST', 'CREATING_HOST'); job.phase = 'Creating host'; persist();
      const receipt = createHost({ parentDir: destinationParent, name: projectName, architectureId: plan.host.architectureId, executionId: execution.executionId, planId: plan.planId, hostId: plan.host.hostId });
      execution.receipts.push(receipt);
      execution.createdProject = { root: receipt.root, name: receipt.projectName, initialCommit: receipt.initialCommit, branch: receipt.branch, files: receipt.files };
      finishStep(execution, step, { root: receipt.root, files: receipt.files.length, initialCommit: receipt.initialCommit }); execution.status = 'HOST_CREATED'; persist();
      record.event('laboratory.host.create', { executionId: execution.executionId, planId: plan.planId, files: receipt.files, initialCommit: receipt.initialCommit, fingerprint: { moduleSystem: receipt.fingerprint.moduleSystem, framework: receipt.fingerprint.framework, handlerContract: receipt.fingerprint.handlerContract, profile: receipt.fingerprint.profile, hostId: receipt.fingerprint.hostId } }, { stage: 'apply' });
      // 2. REINDEX_HOST — the created host must independently fingerprint as planned.
      step = beginStep(execution, 'REINDEX_HOST', 'INDEXING_HOST'); job.phase = 'Indexing host'; persist();
      const check = checkCreatedHost(receipt, plan.host);
      if (!check.ok) throw stepFail('host-mismatch', `The created host does not match the plan: ${check.mismatches.join('; ')}. Nothing was transplanted.`);
      const registered = addProject(receipt.root).project;
      finishStep(execution, step, { hostId: receipt.fingerprint.hostId, plannedHostId: plan.host.hostId, profile: receipt.fingerprint.profile, handlerContract: receipt.fingerprint.handlerContract, registered: projectId(registered.root) }); persist();
      // 3. CHECK_DEPENDENCIES — from the plan, deterministic.
      step = beginStep(execution, 'CHECK_DEPENDENCIES', 'PREPARING_WORKTREE'); persist();
      const unmet = plan.dependencies.filter((d) => d.level === 'DECLARED' && d.satisfied === false);
      if (unmet.length) throw stepFail('unmet-dependency', `Declared dependencies are unmet: ${unmet.map((d) => `${d.from} → ${d.needs}`).join(', ')}`);
      finishStep(execution, step, { declared: plan.dependencies.filter((d) => d.level === 'DECLARED').length, unmet: 0 }); persist();
      // 4a. A capability in LIBRARY form takes the adaptation path instead of the transplant chain:
      // its own verified artifact is carried across and an adapter is generated. Same execution
      // record, same worktree model, same verdict authority — different operation.
      const adaptStep = plan.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY');
      if (adaptStep) {
        const m = manifest(adaptStep.capability.slug);
        const engine = (() => { try { return readOrganEngine(path.join(bankDir(), `${m.identity.slug}.graft`)); } catch { return null; } })();
        // The plan saying READY_TO_ASSEMBLE is never taken at its word: re-establish support now.
        step = beginStep(execution, 'VERIFY_SOURCE_ARTIFACT_IDENTITY', 'PREPARING_WORKTREE'); job.phase = 'Checking the verified artifact'; persist();
        const recheck = recheckLibraryAdaptationSupport({ plan, manifest: m, engine, hostFingerprint: receipt.fingerprint, plannedCapabilityId: adaptStep.capability.capabilityId });
        if (!recheck.ok) throw stepFail(recheck.stale.length ? 'plan-stale' : 'adaptation-unsupported', `${recheck.stale.length ? 'The plan no longer matches what exists' : 'GRAFT cannot adapt this capability into this host'}: ${recheck.reasons.join('; ')}. Nothing was written.`);
        const sourceRoot = librarySourceRoot(m);
        const t = prepareTransplant({ destinationRoot: receipt.root, sourceRoot, capabilitySlug: m.identity.slug });
        execution.transplantId = t.id; execution.worktree = { path: t.worktree.path, branch: t.worktree.branch, baseHead: t.baseHead }; persist();
        execution.capabilitySource = { kind: engine?.genome?.identity?.kind || null, implementationForm: 'library', genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null,
          sourceProject: m.provenance?.sourceProject?.name || null, sourceRevision: sourceRevisionOf(m),
          sourceVerification: m.provenance?.verifiedInSource ? { verdict: m.provenance.verifiedInSource.verdict, summary: m.provenance.verifiedInSource.summary || null, at: m.provenance.verifiedInSource.at || null } : null };
        execution.status = 'APPLYING'; persist();

        const outcome = await runLibraryAdaptation({ manifest: m, sourceRoot, worktreePath: t.worktree.path, host: recheck.host, onPhase: (phase) => { job.phase = phase; } });
        if (!outcome.identity.matched) { failStep(execution, step, stepFail(outcome.reason, `${outcome.detail}. No adaptation was written.`), 'BLOCKED'); concludeExecution(execution); persist(); finishAssembly('apply'); return { execution: executionSummary(execution), report: null }; }
        finishStep(execution, step, { entry: outcome.identity.entry, expected: outcome.identity.expected, actual: outcome.identity.actual, byteIdentical: true }); persist();

        // ADAPT_LIBRARY_CAPABILITY
        step = beginStep(execution, 'ADAPT_LIBRARY_CAPABILITY', 'APPLYING'); persist();
        transition(t.id, 'READY', { plan: { planId: outcome.adaptation.adaptation, status: 'ready', compatibility: 'library-adaptation', files: outcome.filesWritten, entrypoint: outcome.adaptation.verifyThrough.entry, recipe: outcome.adaptation.method } });
        execution.adaptation = { id: outcome.adaptation.adaptation, method: outcome.adaptation.method, artifact: outcome.adaptation.artifactIdentity.destinationPath, artifactSha256: outcome.adaptation.artifactIdentity.sha256,
          adapter: outcome.adaptation.verifyThrough.entry, hostProfile: recheck.host.profile, interop: outcome.adaptation.interop.mechanism, mapping: outcome.adaptation.mapping, checks: (recheck.support?.checks || []).map((c) => ({ id: c.id, ok: c.ok })),
          upstream: { repository: outcome.adaptation.provenance.source.repository, revision: outcome.adaptation.provenance.source.revision, package: outcome.adaptation.provenance.source.package },
          licence: { declared: outcome.adaptation.provenance.licence.declared, file: outcome.adaptation.provenance.licence.file }, filesWritten: outcome.filesWritten };
        finishStep(execution, step, { filesWritten: outcome.filesWritten, adaptation: outcome.adaptation.adaptation, adapter: outcome.adaptation.verifyThrough.entry, transplantId: t.id }); persist();

        // VERIFY_CAPABILITY — the destination contract, through the same verdict authority.
        step = beginStep(execution, 'VERIFY_CAPABILITY', 'VERIFYING'); persist();
        const report = outcome.verification;
        execution.verification = { capability: m.identity.slug, capabilityId: recheck.actualCapabilityId, verdict: report.verdict, rationale: report.rationale || null, summary: report.summary || null, method: report.method || null,
          proofOf: report.proofOf, implementationForm: 'library', finishedAt: report.finishedAt || null, invariants: [], counterfactuals: [], outcomes: (report.results || []).map((r) => ({ id: r.id, outcome: r.outcome })), providerDouble: null };
        execution.hostPreservation = { captured: outcome.baseline.captured, reason: outcome.baseline.reason, tests: outcome.preservation.tests, passed: outcome.preservation.passed, failed: outcome.preservation.failed, verdict: outcome.preservation.verdict };
        execution.adaptation.destinationContract = { cases: report.summary?.required ?? null, passed: report.summary?.passed ?? null, verdict: report.verdict };
        execution.proofReferences.push({ kind: 'transplant-record', transplantId: t.id }, { kind: 'library-adaptation', adaptation: outcome.adaptation.adaptation, artifactSha256: outcome.adaptation.artifactIdentity.sha256 });
        if (report.verdict !== 'VERIFIED') { failStep(execution, step, stepFail('verdict', `Verification reported ${report.verdict}: ${report.rationale || ''}`.trim()), report.verdict === 'FAILED' ? 'FAILED' : 'INCONCLUSIVE'); concludeExecution(execution); persist(); finishAssembly('verify'); return { execution: executionSummary(execution), report }; }
        finishStep(execution, step, { verdict: report.verdict, passed: report.summary?.passed ?? null, required: report.summary?.required ?? null }); persist();

        // CHECK_HOST_PRESERVATION — the baseline was captured before any write.
        step = beginStep(execution, 'CHECK_HOST_PRESERVATION', 'VERIFYING'); persist();
        if (!outcome.baseline.captured) { failStep(execution, step, stepFail('host-preservation-not-captured', `The host's own behaviour could not be recorded before the adaptation (${outcome.baseline.reason}), so preservation cannot be proven.`), 'INCONCLUSIVE'); concludeExecution(execution); persist(); finishAssembly('verify'); return { execution: executionSummary(execution), report }; }
        if (outcome.preservation.failed > 0) { failStep(execution, step, stepFail('host-preservation', `The host stopped behaving as it did: ${outcome.preservation.failed} preservation check(s) failed.`), 'FAILED'); concludeExecution(execution); persist(); finishAssembly('verify'); return { execution: executionSummary(execution), report }; }
        finishStep(execution, step, { captured: outcome.baseline.captured, tests: outcome.preservation.tests, passed: outcome.preservation.passed, failed: 0 }); persist();

        // REINDEX_HOST — recorded honestly, including a detector that recognises nothing.
        step = beginStep(execution, 'REINDEX_HOST', 'REINDEXING'); job.phase = 'Re-indexing the assembled application'; persist();
        execution.reindex = { ...outcome.reindex, authenticationObserved: outcome.reindex.observedCapabilities.some((c) => /authentication/.test(c.category)) };
        execution.adaptation.detectorObservation = outcome.reindex.detectorObservation;
        finishStep(execution, step, { hostId: outcome.reindex.hostId, profile: outcome.reindex.profile, detectorObservation: outcome.reindex.detectorObservation, observed: outcome.reindex.observedCapabilities.length }); persist();

        // FINAL_VERIFICATION, then continuity: the verified state is committed and recorded at that
        // exact revision. Presence comes from assembly evidence; the detector result stays separate.
        step = beginStep(execution, 'FINAL_VERIFICATION', 'REINDEXING'); persist();
        const committed = commitAssembledState(t.worktree.path, { capability: m.identity.name });
        const provenance = { sourceRevision: sourceRevisionOf(m), capabilityId: recheck.actualCapabilityId || null, genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null };
        const { proven } = await proveCommitted(committed.revision, () => verifyAdaptedLibraryCapability({ plan: outcome.adaptation, destinationRoot: t.worktree.path, provenance }));
        finishStep(execution, step, { verdict: report.verdict, hostPreservation: execution.hostPreservation, detectorObservation: outcome.reindex.detectorObservation, stepsFailed: 0, revision: committed.revision, proof: { verdict: proven.verdict, envelopeDigest: execution.proof.envelopeDigest } });
        job.phase = 'Recording the assembly';
        concludeExecution(execution);
        const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: { name: receipt.projectName, repositoryId: identity(fingerprintProject(receipt.root)).repositoryId || null }, baseRevision: t.baseHead, workingBranch: t.worktree.branch, primaryBranch: inspectRepo(receipt.root).branch, worktreePath: t.worktree.path, primaryRoot: receipt.root, hostId: receipt.fingerprint.hostId });
        recordAssembledCapability(workspace, { execution, revisionBefore: t.baseHead, revisionAfter: committed.revision });
        saveAssemblyWorkspace(workspace);
        execution.assemblyWorkspaceId = workspace.assemblyWorkspaceId;
        execution.assembledRevision = committed.revision;
        persist();
        finishAssembly('verify');
        return { execution: executionSummary(execution), report, transplantId: t.id, worktree: t.worktree.path, assemblyWorkspaceId: workspace.assemblyWorkspaceId };
      }
      // 4. TRANSPLANT_CAPABILITY — the existing chain: worktree → plan → preconditions → apply (+ verify inside applyAndVerify).
      const transplantStep = plan.steps.find((s) => s.type === 'TRANSPLANT_CAPABILITY');
      step = beginStep(execution, 'TRANSPLANT_CAPABILITY', 'PREPARING_WORKTREE'); job.phase = 'Preparing capability'; persist();
      const m = manifest(transplantStep.capability.slug);
      const engine = (() => { try { return readOrganEngine(path.join(bankDir(), `${m.identity.slug}.graft`)); } catch { return null; } })();
      const actualCapabilityId = engine?.genome?.identity?.capabilityId || null;
      if (actualCapabilityId !== transplantStep.capability.capabilityId) throw stepFail('capability-identity-changed', `The banked capability is not the one the plan selected (${transplantStep.capability.capabilityId} planned, ${actualCapabilityId || 'none'} in the bank).`);
      const t = prepareTransplant({ destinationRoot: receipt.root, sourceRoot: null, capabilitySlug: m.identity.slug });
      execution.transplantId = t.id; execution.worktree = { path: t.worktree.path, branch: t.worktree.branch, baseHead: t.baseHead }; execution.status = 'PLANNING_TRANSPLANT'; job.phase = 'Planning the transplant'; persist();
      const fp = fingerprintProject(t.worktree.path);
      const tplan = await record.timed('plan', 'plan', () => createTransplantPlan(m, fp, { resolveConflicts: false, atlas: 'local' }),
        (built) => ({ source: { project: m.identity.sourceProject, fingerprint: m.provenance?.sourceFingerprint || null, verifiedInSource: m.provenance?.verifiedInSource || null }, destination: identity(fp), capability: m.identity.slug, kind: built.engine?.genome?.identity.kind || null, plan: planSummary(built), safety: checkPreconditions(built, t.worktree.path), confirmations: ['laboratory-assembly'], executionId: execution.executionId }));
      if (tplan.status !== 'ready') throw stepFail('transplant-plan-' + tplan.status, `The transplant plan is ${tplan.status}: ${tplan.compatibility?.status || ''} ${(tplan.compatibility?.reasons || tplan.compatibility?.blockers || []).map((r) => r.detail || r.message || r).join('; ')}`.trim());
      const safety = checkPreconditions(tplan, t.worktree.path);
      if (!safety.ok) throw stepFail('preconditions', safety.problems.map((x) => x.message).join(' '));
      transition(t.id, 'READY', { plan: { planId: tplan.id, status: tplan.status, compatibility: tplan.compatibility.status, files: tplan.files.map((f) => f.path), entrypoint: tplan.destination.entrypoint, recipe: tplan.engine.recipe?.name || null } });
      execution.capabilitySource = { kind: engine?.genome?.identity?.kind || null, genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null, sourceProject: m.provenance?.sourceProject?.name || null, sourceRevision: sourceRevisionOf(m), sourceVerification: m.provenance?.verifiedInSource ? { verdict: m.provenance.verifiedInSource.verdict, summary: m.provenance.verifiedInSource.summary || null, at: m.provenance.verifiedInSource.at || null } : null };
      execution.transplantPlan = { planId: tplan.id, status: tplan.status, compatibility: tplan.compatibility.status, profile: tplan.adaptation?.profile || null, files: tplan.files.map((f) => f.path), entrypoint: tplan.destination.entrypoint, recipe: tplan.engine.recipe?.name || null, recipeId: tplan.engine.recipe?.recipeId || null, checks: (tplan.compatibility.checks || []).map((c) => ({ id: c.id, status: c.status })), preservation: (tplan.preservation || []).length };
      execution.status = 'APPLYING'; job.phase = `Applying ${m.identity.name}`; persist();
      // The verifier's progress drives the execution state; nothing here narrates ahead of it.
      const watched = new Proxy(job, { set(target, key, value) { target[key] = value; if (key === 'phase' && typeof value === 'string') { const s = /^Applying/.test(value) ? 'APPLYING' : 'VERIFYING'; if (execution.status !== s || execution.phase !== value) { execution.status = s; execution.phase = value; persist(); } } return true; } });
      const saved = { plan: tplan, m, projectId: projectId(t.worktree.path), transplantId: t.id, baseHead: t.baseHead, snapshot: null, created: Date.now() };
      const applied = await applyAndVerify(saved, { root: t.worktree.path, name: receipt.projectName }, safety, watched, { atlas: null });
      finishStep(execution, step, { branch: applied.branch, filesWritten: applied.files, receiptPath: applied.receiptPath, transplantId: t.id }); persist();
      // 5. VERIFY_CAPABILITY — the verdict is the report's.
      step = beginStep(execution, 'VERIFY_CAPABILITY', 'VERIFYING'); persist();
      const report = applied.report;
      const preservationIds = new Set((tplan.preservation || []).map((x) => x.id));
      const preservationResults = (report.results || []).filter((r) => preservationIds.has(r.id));
      execution.verification = { capability: m.identity.slug, capabilityId: actualCapabilityId, verdict: report.verdict, rationale: report.rationale || null, summary: report.summary || null, method: report.method || null, attempts: applied.repair?.attempts ?? null, initialVerdict: applied.repair?.initialVerdict || null, finishedAt: report.finishedAt || null,
        // Invariants and counterfactuals come from the evaluated verification contract (the proof), never guessed from result shapes.
        invariants: (report.proof?.invariants || []).map((i) => ({ id: i.id || i.invariant || null, status: i.status })), counterfactuals: (report.proof?.counterfactualCases || []).map((c) => ({ id: c.id, outcome: c.outcome })),
        proofSummary: report.proof?.summary || null, outcomes: (report.results || []).map((r) => ({ id: r.id, outcome: r.outcome })), providerDouble: report.providerDouble?.injectedThrough || null };
      execution.hostPreservation = { captured: applied.hostBaseline?.captured ?? false, reason: applied.hostBaseline?.reason || null, tests: preservationResults.length, passed: preservationResults.filter((r) => r.outcome === 'passed').length, failed: preservationResults.filter((r) => r.outcome === 'failed').length };
      execution.proofReferences.push({ kind: 'transplant-record', transplantId: t.id }, { kind: 'apply-receipt', path: applied.receiptPath }, ...(report.proof ? [{ kind: 'proof', contractId: report.proof.contractId, summary: report.proof.summary }] : []), ...(report.atlasEntry ? [{ kind: 'atlas-entry', entryId: report.atlasEntry.entryId || report.atlasEntry }] : []));
      if (report.verdict !== 'VERIFIED') { failStep(execution, step, stepFail('verdict', `Verification reported ${report.verdict}: ${report.rationale || ''}`.trim()), report.verdict === 'FAILED' ? 'FAILED' : 'INCONCLUSIVE'); concludeExecution(execution); persist(); finishAssembly('verify'); return { execution: executionSummary(execution), report }; }
      finishStep(execution, step, { verdict: report.verdict, passed: report.summary?.passed ?? null, required: report.summary?.required ?? null }); persist();
      // 6. REINDEX_HOST — the assembled worktree as Capability Memory's detectors see it now.
      step = beginStep(execution, 'REINDEX_HOST', 'REINDEXING'); job.phase = 'Re-indexing the assembled application'; persist();
      const after = fingerprintProject(t.worktree.path);
      const hostAfter = buildHostModel(after);
      const observed = discoverCapabilities(after).map((c) => ({ id: c.id, category: c.category, confidence: c.confidence, harvestable: c.harvestable }));
      execution.reindex = { hostId: hostAfter.hostId, profile: hostAfter.constraints.adaptationProfile, routes: hostAfter.routing.routes.length, observedCapabilities: observed, authenticationObserved: observed.some((c) => /authentication/.test(c.category)) };
      finishStep(execution, step, execution.reindex); persist();
      // 7. FINAL_VERIFICATION — derived from the referenced outcomes only.
      step = beginStep(execution, 'FINAL_VERIFICATION', 'REINDEXING'); persist();
      // Continuity: the verified state becomes a commit on the managed branch, that commit is
      // verified again and its proof made durable, and the assembly workspace + ledger record what
      // GRAFT itself applied, at exactly that revision.
      const committed = commitAssembledState(t.worktree.path, { capability: m.identity.name });
      const provenance = { sourceRevision: sourceRevisionOf(m), capabilityId: actualCapabilityId || null, genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null };
      const { proven } = await proveCommitted(committed.revision, () => verifyCapability(m, t.worktree.path, { entrypoint: tplan.destination.entrypoint, atlas: null, extraTests: tplan.preservation || [], recordKnowledge: false, provenance }));
      finishStep(execution, step, { verdict: report.verdict, hostPreservation: execution.hostPreservation, stepsFailed: 0, revision: committed.revision, proof: { verdict: proven.verdict, envelopeDigest: execution.proof.envelopeDigest } });
      job.phase = 'Recording the assembly';
      // The execution is concluded first: a capability enters the ledger only from a COMPLETED
      // assembly, and `concludeExecution` is what decides that from the recorded outcomes.
      concludeExecution(execution);
      const workspace = createAssemblyWorkspace({ execution, repositoryIdentity: { name: receipt.projectName, repositoryId: identity(fingerprintProject(receipt.root)).repositoryId || null }, baseRevision: t.baseHead, workingBranch: t.worktree.branch, primaryBranch: inspectRepo(receipt.root).branch, worktreePath: t.worktree.path, primaryRoot: receipt.root, hostId: receipt.fingerprint.hostId });
      recordAssembledCapability(workspace, { execution, revisionBefore: t.baseHead, revisionAfter: committed.revision });
      saveAssemblyWorkspace(workspace);
      execution.assemblyWorkspaceId = workspace.assemblyWorkspaceId;
      execution.assembledRevision = committed.revision;
      persist();
      finishAssembly('verify');
      return { execution: executionSummary(execution), report, transplantId: t.id, worktree: t.worktree.path, assemblyWorkspaceId: workspace.assemblyWorkspaceId };
    } catch (err) {
      failStep(execution, step, err, err.code === 'host-mismatch' || err.code === 'capability-identity-changed' ? 'BLOCKED' : 'FAILED');
      if (execution.status !== 'BLOCKED') execution.finalState = execution.status;
      execution.finalSummary = { assembly: execution.status, capabilities: [], hostPreservation: 'not captured', finalAssemblyVerification: 'no verified assembled state', resultLocation: execution.worktree?.path || execution.createdProject?.root || null, wording: `Assembly ${execution.status}: ${err.message}` };
      persist();
      finishAssembly('apply');
      throw err;
    } finally { lock.release(); }
  }
  /** Real Multi-Capability Composition 0.1: the composition kernel over the real operations. */
  /** Start one assembly job under the plan's lock; the runner depends only on how many capabilities the plan has. */
  function startAssembly({ plan, eligibility, destinationParent, projectName, retryOf = null }) {
    const lock = acquireExecutionLock(plan.planId);
    try {
      // One capability: the single-capability runner. Several: the composition kernel over the
      // real operations (Real Multi-Capability Composition 0.1), one candidate for all of them.
      const started = launch('assembly', `Assemble ${plan.blueprintName}`, (job) => (eligibility.capabilities === 1 ? runAssembly({ plan, destinationParent, projectName, job, lock }) : runComposition({ plan, destinationParent, projectName, job, lock })));
      if (retryOf) started.job.retryOf = retryOf;
      return started;
    } catch (err) { lock.release(); throw err; }
  }
  async function runComposition({ plan, destinationParent, projectName, job, lock }) {
    try {
      const result = await runRealComposition({ plan, destinationParent, projectName, onPhase: (phase) => { job.phase = phase; }, onExecution: (e) => { job.execution = executionSummary(e); } });
      record.event('laboratory.execute', executionEvent(result.execution), { stage: 'verify' });
      return { execution: executionSummary(result.execution), transplantId: result.candidate?.transplantId || null, worktree: result.candidate?.worktreePath || null, assemblyWorkspaceId: result.workspace?.assemblyWorkspaceId || null, promotable: result.promotable };
    } finally { lock.release(); }
  }
  const executionSummary = (e) => ({ executionId: e.executionId, assemblyWorkspaceId: e.assemblyWorkspaceId || null, assembledRevision: e.assembledRevision || null, planId: e.planId, blueprintId: e.blueprintId, status: e.status, phase: e.phase || null, finalState: e.finalState, currentStep: e.currentStep, steps: e.steps.map((s) => ({ stepId: s.stepId, order: s.order, type: s.type, what: s.what, status: s.status, error: s.error })), createdProject: e.createdProject, worktree: e.worktree, transplantId: e.transplantId, transplantPlan: e.transplantPlan || null, verification: e.verification, composition: e.composition || null, hostPreservation: e.hostPreservation, reindex: e.reindex, proofReferences: e.proofReferences,
    // Kept as separate claims on purpose: where the capability came from and how it was proven in
    // the source, versus how it was adapted and proven in the destination. Never one combined score.
    capabilitySource: e.capabilitySource || null, adaptation: e.adaptation || null, atlas: e.atlas || null, receipts: e.receipts.map((r) => ({ kind: r.kind, projectName: r.projectName, files: r.files, initialCommit: r.initialCommit, fingerprint: r.fingerprint, createdAt: r.createdAt })), finalSummary: e.finalSummary, error: e.error, startedAt: e.startedAt, finishedAt: e.finishedAt, authority: e.authority ,
    // Commercial Beta 0.1: what the customer can do now (Retry / Discard / diagnostics) and what happened, in their words. Never rewrites the record.
    recovery: assessRecovery(e, { running: runningExecutions().has(e.executionId) }), failure: e.error || (e.status && e.status !== 'COMPLETED' && ['FAILED', 'INCONCLUSIVE', 'BLOCKED', 'STALE'].includes(e.status)) ? describeFailure({ ...(e.error || {}), status: e.status }) : null, recoveryHistory: e.recovery || [] });
  const executionEvent = (e) => ({ executionId: e.executionId, assemblyWorkspaceId: e.assemblyWorkspaceId || null, assembledRevision: e.assembledRevision || null, planId: e.planId, blueprintId: e.blueprintId, status: e.status, finalState: e.finalState, steps: e.steps.map((s) => `${s.type}:${s.status}`), verdict: e.verification?.verdict || null, summary: e.verification?.summary || null,
    composition: e.composition ? { finalState: e.composition.finalState, finalRevision: e.composition.finalRevision, capabilities: e.composition.capabilities.map((c) => ({ capability: c.capability, initial: c.initialVerdict, reverified: c.reverifiedVerdict, final: c.finalVerdict })), reverifications: e.composition.reverifications.map((r) => ({ capability: r.capability, alongside: r.alongside, verdict: r.verdict })) } : null, hostPreservation: e.hostPreservation, reindex: e.reindex ? { authenticationObserved: e.reindex.authenticationObserved, observed: e.reindex.observedCapabilities.map((c) => c.category) } : null, transplantId: e.transplantId, error: e.error?.message || null });
  async function api(route, body) {
    if (route === '/api/projects') {
      idle(); fields(body, ['path']);
      const root = string(body.path, 'Project path');
      if (!path.isAbsolute(root)) throw fail('Enter an absolute folder path.');
      const real = fs.realpathSync(root);
      if (!fs.statSync(real).isDirectory()) throw fail('Choose a project folder.');
      const fp = fingerprintProject(real);
      record.event('project.register', { project: identity(fp) }, { stage: 'register' });
      return { project: projectSummary(addProject(real).project) };
    }
    if (route === '/api/samples') {
      fields(body, []);
      return launch('samples', 'Prepare sample workspace', async (job) => {
        job.phase = 'Copying sample projects';
        fs.mkdirSync(graftHome(), { recursive: true });
        const work = fs.mkdtempSync(path.join(graftHome(), 'samples-'));
        const created = [];
        for (const name of ['old-saas-project', 'new-startup']) {
          const root = path.join(work, name);
          fs.cpSync(path.join(fixtures, name), root, { recursive: true, filter: (file) => !['.git', 'node_modules'].includes(path.basename(file)) });
          const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', timeout: 15000 });
          git(['init', '-q', '-b', 'main']); git(['add', '-A']);
          git(['-c', 'user.name=GRAFT samples', '-c', 'user.email=samples@graft.local', 'commit', '-q', '-m', 'Sample project recovery point']);
          created.push(projectSummary(addProject(fs.realpathSync(root), { name }).project));
        }
        return { projects: created, workspace: work };
      });
    }
    if (route === '/api/workspace') {
      fields(body, []);
      const index = loadIndex();
      return { summary: indexSummary({ index }), projects: index.projects.map(indexedProjectSummary), stale: staleProjects().length };
    }
    if (route === '/api/workspace/roots') {
      idle(); fields(body, ['path', 'remove']);
      const root = string(body.path, 'Workspace folder');
      if (!path.isAbsolute(root)) throw fail('Enter an absolute folder path.');
      const roots = body.remove === true ? removeRoot(root) : addRoot(root);
      record.event('workspace.roots', { action: body.remove === true ? 'remove' : 'add', rootHash: hash(root).slice(0, 24), roots: roots.length }, { stage: 'register' });
      return { roots };
    }
    if (route === '/api/workspace/index') {
      fields(body, ['force']);
      if (body.force !== undefined && typeof body.force !== 'boolean') throw fail('force must be true or false.');
      return launch('index', 'Index workspace', async (job) => {
        job.phase = 'Scanning authorized workspace roots';
        const built = await record.timed('workspace.index', 'register', async () => buildIndex({ force: body.force === true, onProgress: ({ root }) => { job.phase = `Indexing ${path.basename(root)}`; } }),
          (result) => ({ projects: result.projects, repositories: result.repositories, capabilities: result.capabilities, elapsedMs: result.elapsedMs, roots: result.roots }));
        const index = loadIndex();
        return { index: built, summary: indexSummary({ index }) };
      });
    }
    if (route === '/api/workspace/refresh') {
      idle(); fields(body, ['projectId']);
      const refreshed = refreshProject(string(body.projectId, 'Project'));
      return { project: indexedProjectSummary(refreshed.project), elapsedMs: refreshed.elapsedMs };
    }
    if (route === '/api/workspace/search') {
      fields(body, ['text', 'capability', 'harvestable', 'transplantSupport', 'language', 'runtime', 'framework', 'localVerification']);
      const { text, ...filters } = body;
      if (text !== undefined && typeof text !== 'string') throw fail('Search text must be a string.');
      if ((text || '').length > 500) throw fail('Search text is too long.');
      return searchCapabilities({ text: text || '', ...filters }, { limit: 25 });
    }
    if (route === '/api/workspace/capability') {
      fields(body, ['projectId', 'capability']);
      const { project, capability } = getCapability(string(body.projectId, 'Project'), string(body.capability, 'Capability'));
      return { project: indexedProjectSummary(project), capability };
    }
    // Discover → Transplant: register the folder the capability is harvested at and start the
    // harvest, exactly as the Projects tab would. The candidate's own metadata decides the
    // category and the root; nothing here is keyed to a repository name.
    // Destination candidates for a banked capability: every indexed project, with whether an
    // emitter exists for this capability's kind in that project's shape, its blockers, and its
    // repository state. Decided from the Host Model rules, never from names.
    if (route === '/api/destinations') {
      fields(body, ['slug', 'includeNonProduction']);
      const m = manifest(string(body.slug, 'Capability'));
      const kind = m.architecture.capabilityModel.kind;
      const includeNonProduction = body.includeNonProduction === true;
      const index = loadIndex();
      const seen = new Set();
      const candidates = [];
      const worktrees = (() => { try { return fs.realpathSync(worktreesDir()); } catch { return null; } })();
      const describe = (root, name, extra = {}) => {
        let real; try { real = fs.realpathSync(root); } catch { return; }
        if (seen.has(real) || (worktrees && real.startsWith(worktrees + path.sep))) return;
        seen.add(real);
        try {
          const fp = fingerprintProject(real);
          const byKind = profilesByKind(fp);
          const repo = inspectRepo(real);
          const blockers = [];
          if (!byKind[kind]) blockers.push({ id: 'unsupported-profile', detail: `no ${kind} emitter for ${fp.moduleSystem.value}/${fp.handlerContract.value}${fp.framework.value !== 'unknown' ? ` (${fp.framework.value})` : ''}${fp.central && !fp.central.supported ? `; central handler: ${fp.central.reason}` : ''}` });
          if (!fp.entrypoint) blockers.push({ id: 'no-entrypoint', detail: 'no entrypoint was identified' });
          if (!repo.isRepo) blockers.push({ id: 'not-a-repository', detail: 'not a Git repository; an isolated worktree cannot be created' });
          if (repo.isRepo && !repo.hasCommits) blockers.push({ id: 'no-commits', detail: 'the repository has no commit to branch from' });
          if (m.identity.sourceProjectRoot && fs.existsSync(m.identity.sourceProjectRoot) && fs.realpathSync(m.identity.sourceProjectRoot) === real) blockers.push({ id: 'source-is-destination', detail: 'this is the capability\'s own source checkout' });
          candidates.push({ root: real, name, ...extra, language: extra.language || (fp.files.some((f) => f.endsWith('.ts')) ? 'typescript' : 'javascript'), runtime: 'node',
            architecture: { moduleSystem: fp.moduleSystem.value, handlerContract: fp.handlerContract.value, framework: fp.framework.value, persistence: fp.persistence.value, central: fp.central?.supported === true ? 'central-handler' : null },
            entrypoint: fp.entrypoint, profile: byKind[kind] || null, supported: blockers.length === 0, blockers,
            repository: { isGit: repo.isRepo, branch: repo.branch, head: repo.head, dirty: repo.dirty, dirtyFiles: repo.dirtyFiles.length } });
        } catch (err) { candidates.push({ root: real, name, error: err.message, supported: false, blockers: [{ id: 'unreadable', detail: err.message }] }); }
      };
      for (const p of index.projects) if (!p.error && p.runtime === 'node' && !p.subprojectOf && (includeNonProduction || !p.nonProduction)) describe(p.root, p.name, { projectId: p.projectId, language: p.language });
      for (const p of loadRegistry().projects) describe(p.root, p.name);
      candidates.sort((a, b) => (b.supported - a.supported) || a.name.localeCompare(b.name));
      return { kind, candidates };
    }
    if (route === '/api/transplants') { fields(body, []); return { transplants: listTransplants().map(transplantView) }; }
    // Capability Export 0.1: a harvested capability as a package. Packaging decides nothing; the
    // organ is read, never rewritten. Without an explicit destination the package lands in
    // GRAFT's own exports folder (the desktop app supplies a path from the native save dialog).
    if (route === '/api/capabilities/export/preview') {
      fields(body, ['slug']);
      const slug = string(body.slug, 'Capability');
      const built = buildCapabilityPackage({ organDir: path.join(bankDir(), `${slug}.graft`), graftVersion: GRAFT_VERSION });
      return { name: built.name, suggestedFileName: `${built.name}.zip`, files: built.fileList.length, packageHash: built.packageHash, verification: built.verification, licence: built.licence, configurationNames: built.configurationNames, sourceProject: built.sourceProject, profile: built.profile };
    }
    if (route === '/api/capabilities/export') {
      fields(body, ['slug', 'destination', 'overwrite', 'alternate']);
      const slug = string(body.slug, 'Capability');
      for (const flag of ['overwrite', 'alternate']) if (body[flag] !== undefined && typeof body[flag] !== 'boolean') throw fail(`${flag} must be true or false.`);
      const organDir = path.join(bankDir(), `${slug}.graft`);
      let destination;
      if (body.destination !== undefined) { destination = string(body.destination, 'Destination'); if (!path.isAbsolute(destination)) throw fail('Choose an absolute .zip file path.'); }
      else { fs.mkdirSync(defaultExportDir(), { recursive: true, mode: 0o700 }); destination = path.join(defaultExportDir(), `${slug}.zip`); }
      try {
        const result = exportCapabilityPackage({ organDir, destination, graftVersion: GRAFT_VERSION, overwrite: body.overwrite === true, alternate: body.alternate === true });
        record.event('capability.export', { capability: result.receipt.capability, packageHash: result.receipt.packageHash, files: result.receipt.exportedFileCount, licence: result.receipt.licence.state, verification: result.receipt.verification }, { stage: 'other' });
        return result;
      } catch (err) {
        if (err.code === 'destination-exists') throw fail(`${err.message} ${err.remedy || ''}`.trim(), 409);
        if (['invalid-destination', 'destination-missing', 'destination-symlink', 'destination-inside-source', 'destination-not-a-file', 'organ-has-no-engine-artifacts', 'unsupported-kind', 'package-privacy', 'unsupported-profile'].includes(err.code)) throw fail(`${err.message} ${err.remedy || ''}`.trim());
        throw err;
      }
    }
    if (route === '/api/exports') { fields(body, []); return { receipts: loadExportReceipts().receipts.slice(-50).reverse() }; }
    // Laboratory 0.1: blueprints. Every answer is `viewBlueprint`: the person's decisions plus a
    // fresh deterministic analysis. Nothing here harvests, transplants, verifies or writes to a project.
    const laboratoryView = (b) => viewBlueprint(b, { index: loadIndex() });
    const saveAndView = (b) => laboratoryView(saveBlueprint(b));
    if (route === '/api/laboratory') { fields(body, []); return { blueprints: listBlueprints(), questions: GUIDED_QUESTIONS, categories: Object.entries(GOAL_CATEGORIES).map(([id, d]) => ({ id, label: d.label, searchable: Boolean(d.memory) })), agentConfigured: Boolean(agentRuntime()),
      hosts: { architectures: NEW_HOST_ARCHITECTURES.map((a) => ({ id: a.id, label: a.label, runtime: a.runtime, moduleSystem: a.moduleSystem, framework: a.framework, handlerContract: a.handlerContract, persistence: a.persistence, profile: a.profile, kinds: a.kinds, provenBy: a.provenBy })), projects: loadRegistry().projects.map((p) => ({ projectId: projectId(p.root), name: p.name })) } }; }
    if (route === '/api/laboratory/blueprint') { fields(body, ['blueprintId']); return { blueprint: laboratoryView(loadBlueprint(string(body.blueprintId, 'Blueprint'))) }; }
    if (route === '/api/laboratory/create') {
      fields(body, ['name', 'description', 'categories', 'hostIntent']);
      const blueprint = createBlueprint({ name: string(body.name, 'Name'), description: body.description === undefined ? '' : string(body.description, 'Description'), hostIntent: body.hostIntent === undefined ? 'decide-later' : string(body.hostIntent, 'Host intent') });
      for (const g of goalsFromDescription(blueprint.description)) addGoal(blueprint, g);
      for (const category of Array.isArray(body.categories) ? body.categories : []) if (typeof category === 'string' && GOAL_CATEGORIES[category]) addGoal(blueprint, { category, source: 'user', derivedFrom: 'checklist' });
      record.event('laboratory.create', { blueprintId: blueprint.blueprintId, goals: blueprint.goals.map((g) => g.category || g.label) }, { stage: 'plan' });
      return { blueprint: saveAndView(blueprint) };
    }
    if (route === '/api/laboratory/delete') { fields(body, ['blueprintId']); deleteBlueprint(string(body.blueprintId, 'Blueprint')); return { ok: true }; }
    if (route === '/api/laboratory/goal') {
      fields(body, ['blueprintId', 'add', 'remove', 'update']);
      const blueprint = loadBlueprint(string(body.blueprintId, 'Blueprint'));
      if (body.add) { const a = body.add; if (a.source !== undefined && !['user', 'agent-advisory'].includes(a.source)) throw fail('A goal is added by the person, or accepted from advice.'); addGoal(blueprint, { category: typeof a.category === 'string' ? a.category : null, label: typeof a.label === 'string' ? a.label : null, required: a.required !== false, source: a.source || 'user', derivedFrom: typeof a.derivedFrom === 'string' ? a.derivedFrom.slice(0, 40) : null, description: typeof a.description === 'string' ? a.description : '' }); }
      if (body.remove) removeGoal(blueprint, string(body.remove, 'Goal'));
      if (body.update) updateGoal(blueprint, string(body.update.goalId, 'Goal'), { required: body.update.required, label: body.update.label });
      return { blueprint: saveAndView(blueprint) };
    }
    if (route === '/api/laboratory/select') {
      fields(body, ['blueprintId', 'goalId', 'selection']);
      const blueprint = loadBlueprint(string(body.blueprintId, 'Blueprint'));
      selectImplementation(blueprint, string(body.goalId, 'Goal'), body.selection === null ? null : body.selection);
      record.event('laboratory.select', { blueprintId: blueprint.blueprintId, goalId: body.goalId, selection: body.selection ? { kind: body.selection.kind, slug: body.selection.slug || null, projectId: body.selection.projectId || null } : null }, { stage: 'plan' });
      return { blueprint: saveAndView(blueprint) };
    }
    if (route === '/api/laboratory/host') {
      fields(body, ['blueprintId', 'kind', 'runtime', 'framework']);
      const blueprint = loadBlueprint(string(body.blueprintId, 'Blueprint'));
      setHostIntent(blueprint, { kind: string(body.kind, 'Host intent'), runtime: body.runtime ? string(body.runtime, 'Runtime') : null, framework: body.framework ? string(body.framework, 'Framework') : null });
      return { blueprint: saveAndView(blueprint) };
    }
    if (route === '/api/laboratory/use') {
      // "Use in Laboratory" from a harvested capability: into an existing blueprint or a new one, as a selected implementation of its goal.
      fields(body, ['slug', 'blueprintId', 'name']);
      const m = manifest(string(body.slug, 'Capability'));
      const category = Object.entries(GOAL_CATEGORIES).find(([, d]) => (d.memory || []).includes(m.identity.category))?.[0];
      if (!category) throw fail(`GRAFT has no Laboratory goal for ${m.identity.category} capabilities yet.`);
      const blueprint = body.blueprintId !== undefined ? loadBlueprint(string(body.blueprintId, 'Blueprint')) : createBlueprint({ name: body.name === undefined ? `New application with ${m.identity.name}` : string(body.name, 'Name') });
      const goal = addGoal(blueprint, { category, source: 'user', derivedFrom: 'capability-page' });
      const engine = (() => { try { return readOrganEngine(path.join(bankDir(), `${m.identity.slug}.graft`)); } catch { return null; } })();
      // A choice the person already made for this goal is kept; the capability is then offered as a candidate, not swapped in.
      const kept = goal.selection && !(goal.selection.kind === 'organ' && goal.selection.slug === m.identity.slug);
      if (!kept) selectImplementation(blueprint, goal.goalId, { kind: 'organ', slug: m.identity.slug, capabilityId: engine?.genome?.identity?.capabilityId || null, name: m.identity.name });
      record.event('laboratory.use', { blueprintId: blueprint.blueprintId, capability: m.identity.slug, selected: !kept }, { stage: 'plan' });
      return { blueprint: saveAndView(blueprint), selected: !kept, note: kept ? `${goal.label} already has a selected implementation (${goal.selection.name || goal.selection.slug || goal.selection.projectId}); this capability is listed among its candidates.` : null };
    }
    if (route === '/api/laboratory/advise') {
      // Optional: an agent interprets the idea. Its answer is stored as advice only; the person accepts goals explicitly.
      fields(body, ['blueprintId']);
      const blueprint = loadBlueprint(string(body.blueprintId, 'Blueprint'));
      const agent = agentRuntime();
      if (!agent) throw fail('No agent is configured. Laboratory works without one: use the checklist or add goals yourself.');
      const advice = await agent.run('interpretBlueprintIntent', { description: blueprint.description, name: blueprint.name, existingGoals: blueprint.goals.map((g) => ({ category: g.category, label: g.label, required: g.required })), categories: Object.keys(GOAL_CATEGORIES) });
      recordAgentAdvice(blueprint, { ...advice, receivedAt: new Date().toISOString() });
      record.event('laboratory.advise', { blueprintId: blueprint.blueprintId, provider: advice.provider, droppedFields: advice.droppedFields.length }, { stage: 'plan' });
      return { blueprint: saveAndView(blueprint) };
    }
    // Laboratory 0.2: assembly plans. The planner describes how GRAFT would build the blueprint with
    // its existing operations; nothing here creates, writes or executes anything.
    const hostFor = (spec) => {
      if (spec === undefined || spec === null) return null;
      if (spec.kind === 'new-application') return newHostSpecification(string(spec.architectureId, 'Architecture'));
      if (spec.kind === 'existing-project') { const p = project(string(spec.projectId, 'Project')); return existingHostSpecification(spec.projectId, { project: { projectId: spec.projectId, name: p.name, root: p.root } }); }
      throw fail('A host is an existing project or a new blank application.');
    };
    const planView = (plan) => { let blueprint = null; try { blueprint = loadBlueprint(plan.blueprintId); } catch { blueprint = null; } return viewAssemblyPlan(plan, blueprint, { index: loadIndex() }); };
    if (route === '/api/laboratory/plan') {
      fields(body, ['blueprintId', 'host']);
      const blueprint = loadBlueprint(string(body.blueprintId, 'Blueprint'));
      if (body.host !== undefined && body.host !== null) { fields(body.host, ['kind', 'architectureId', 'projectId']); }
      const host = hostFor(body.host);
      const plan = saveAssemblyPlan(buildAssemblyPlan(blueprint, { host, index: loadIndex() }));
      record.event('laboratory.plan', { blueprintId: blueprint.blueprintId, planId: plan.planId, readiness: plan.readiness, host: host ? { kind: host.kind, architectureId: host.architectureId || null, hostId: host.hostId } : null, steps: plan.steps.length, supportedSteps: plan.steps.filter((s) => s.supported).length, blockers: plan.blockers.map((b) => b.kind), warnings: plan.warnings.map((w) => w.kind), capabilities: plan.expectedCapabilities.map((c) => c.capabilityId) }, { stage: 'plan' });
      return { plan: planView(plan) };
    }
    if (route === '/api/laboratory/execute') {
      fields(body, ['planId', 'destinationParent', 'projectName']);
      idle();
      const plan = loadAssemblyPlan(string(body.planId, 'Plan'));
      const blueprint = (() => { try { return loadBlueprint(plan.blueprintId); } catch { return null; } })();
      const view = viewAssemblyPlan(plan, blueprint, { index: loadIndex() });
      const eligibility = checkExecutionEligibility(view);
      if (!eligibility.ok) throw fail(`This plan cannot be assembled: ${eligibility.problems.join('; ')}`, 409);
      const destinationParent = string(body.destinationParent, 'Destination folder');
      if (!path.isAbsolute(destinationParent)) throw fail('Choose a folder to create the application in.');
      const projectName = body.projectName === undefined ? plan.blueprintName : string(body.projectName, 'Application name');
      return startAssembly({ plan, eligibility, destinationParent, projectName });
    }
    // Commercial Beta 0.1 — recovery. Retry is a NEW execution of the same plan (eligibility
    // re-checked, a free application name suggested by the product); the failed execution stays as
    // it is. Discard closes the failed workflow with the existing candidate cleanup and notes it on
    // the record. A lock left by a process that is gone is released; a live one is respected.
    if (route === '/api/laboratory/execution/retry') {
      fields(body, ['executionId', 'projectName']);
      idle();
      const previous = loadExecution(string(body.executionId, 'Execution'));
      const recovery = assessRecovery(previous, { running: runningExecutions().has(previous.executionId) });
      if (!recovery || !recovery.retry.available) throw fail('This assembly cannot be retried: it completed, is still running, or has no destination folder.', 409);
      releaseStaleExecutionLock(previous.planId);
      const plan = loadAssemblyPlan(previous.planId);
      const blueprint = (() => { try { return loadBlueprint(plan.blueprintId); } catch { return null; } })();
      const view = viewAssemblyPlan(plan, blueprint, { index: loadIndex() });
      const eligibility = checkExecutionEligibility(view);
      if (!eligibility.ok) throw fail(`This plan cannot be assembled: ${eligibility.problems.join('; ')}`, 409);
      const projectName = body.projectName === undefined ? recovery.retry.suggestedProjectName : string(body.projectName, 'Application name');
      annotateRecovery(previous, { action: 'retry', projectName }); saveExecution(previous);
      record.event('laboratory.recovery', { executionId: previous.executionId, action: 'retry', projectName }, { stage: 'rollback', intervention: true });
      return startAssembly({ plan, eligibility, destinationParent: recovery.retry.destinationParent, projectName, retryOf: previous.executionId });
    }
    if (route === '/api/laboratory/execution/discard') {
      fields(body, ['executionId']);
      idle();
      const execution = loadExecution(string(body.executionId, 'Execution'));
      const recovery = assessRecovery(execution, { running: runningExecutions().has(execution.executionId) });
      if (!recovery) throw fail('Only an assembly that failed or did not finish can be discarded.', 409);
      if (!recovery.discard.available) throw fail('This assembly was already discarded.', 409);
      let candidate = null;
      if (execution.transplantId) {
        const before = (() => { try { return getTransplant(execution.transplantId); } catch { return null; } })();
        if (before) {
          const registeredRoots = new Set([before.worktree.path]); try { registeredRoots.add(fs.realpathSync(before.worktree.path)); } catch { /* already gone */ }
          const cleaned = cleanupTransplant(before.id, { confirmDiscard: true });
          for (const root of registeredRoots) removeProject(root);
          candidate = { transplantId: cleaned.id, state: cleaned.state };
        }
      }
      const lock = releaseStaleExecutionLock(execution.planId);
      annotateRecovery(execution, { action: 'discard', transplantId: execution.transplantId || null, candidate, lockReleased: lock.released });
      saveExecution(execution);
      record.event('laboratory.recovery', { executionId: execution.executionId, action: 'discard', candidate, lockReleased: lock.released }, { stage: 'rollback', intervention: true });
      return { execution: executionSummary(execution), candidate, lockReleased: lock.released };
    }
    // Commercial Beta 0.1 — proof access without Terminal: the assembly's proofs, exact byte copies
    // of the stored artifacts the ledger cites, into a folder the person chose. Fails closed.
    if (route === '/api/laboratory/assembly/proofs/export') {
      fields(body, ['assemblyWorkspaceId', 'destination']);
      const workspace = loadAssemblyWorkspace(string(body.assemblyWorkspaceId, 'Assembly'));
      const destination = string(body.destination, 'Destination folder');
      if (!path.isAbsolute(destination)) throw fail('Choose a folder to export the proofs into.');
      const current = evaluateWorkspace(workspace).capabilities.filter((c) => c.state === 'CURRENT');
      if (!current.length) throw fail('This assembly has no current capability with a proof to export.', 409);
      try {
        const files = exportAssemblyProofs({ ...workspace, capabilities: evaluateWorkspace(workspace).capabilities }, destination);
        record.event('proof.export', { assemblyWorkspaceId: workspace.assemblyWorkspaceId, files: files.length }, { stage: 'verify' });
        return { exported: files.map((f) => ({ capability: f.capability, revision: f.revision, digest: f.digest, file: path.basename(f.file) })), folder: destination, count: files.length };
      } catch (err) {
        if (['proof-export-refused', 'proof-missing', 'proof-mismatch', 'proof-export-mismatch'].includes(err.code)) throw fail(`Proof could not be exported because its stored integrity check failed. ${err.message}`, 409);
        throw err;
      }
    }
    // Commercial Beta 0.1 — support: one local bundle of support facts, redacted and validated, never uploaded.
    if (route === '/api/diagnostics/bundle') {
      fields(body, ['executionId', 'assemblyWorkspaceId', 'planId', 'destination']);
      const destination = string(body.destination, 'Destination');
      if (!path.isAbsolute(destination)) throw fail('Choose where to save the diagnostic bundle.');
      const options = { executionId: body.executionId === undefined ? null : string(body.executionId, 'Execution'), assemblyWorkspaceId: body.assemblyWorkspaceId === undefined ? null : string(body.assemblyWorkspaceId, 'Assembly'), planId: body.planId === undefined ? null : string(body.planId, 'Plan'),
        version: GRAFT_VERSION, platform: { os: process.platform, arch: process.arch, node: process.versions.node }, appLog: readSessionLog(), running: runningExecutions() };
      try {
        const saved = saveDiagnostics(options, destination);
        record.event('diagnostics.save', { entries: saved.entries.length, bytes: saved.bytes, executionId: options.executionId, assemblyWorkspaceId: options.assemblyWorkspaceId }, { stage: 'other' });
        return { file: path.basename(saved.file), folder: path.dirname(saved.file), bytes: saved.bytes, entries: saved.entries, failure: saved.failure };
      } catch (err) {
        if (err.code === 'diagnostics-unsafe') throw fail(err.message, 409);
        throw err;
      }
    }
    if (route === '/api/diagnostics/name') { fields(body, ['executionId', 'assemblyWorkspaceId']); return { name: diagnosticsFileName({ executionId: body.executionId === undefined ? null : string(body.executionId, 'Execution'), assemblyWorkspaceId: body.assemblyWorkspaceId === undefined ? null : string(body.assemblyWorkspaceId, 'Assembly') }) }; }
    if (route === '/api/laboratory/executions') { fields(body, ['planId', 'blueprintId']); return { executions: listExecutions({ planId: body.planId === undefined ? null : string(body.planId, 'Plan'), blueprintId: body.blueprintId === undefined ? null : string(body.blueprintId, 'Blueprint') }) }; }
    if (route === '/api/laboratory/execution') { fields(body, ['executionId']); return { execution: executionSummary(loadExecution(string(body.executionId, 'Execution'))) }; }
    if (route === '/api/laboratory/assemblies') { fields(body, ['blueprintId', 'planId']); return { assemblies: listAssemblyWorkspaces({ blueprintId: body.blueprintId === undefined ? null : string(body.blueprintId, 'Blueprint'), planId: body.planId === undefined ? null : string(body.planId, 'Plan') }) }; }
    if (route === '/api/laboratory/assembly') {
      // The assembled application as GRAFT can honestly describe it: the ledger it kept, evaluated
      // against the revision the assembly actually stands at, beside whatever the detectors see.
      fields(body, ['assemblyWorkspaceId']);
      const workspace = loadAssemblyWorkspace(string(body.assemblyWorkspaceId, 'Assembly'));
      const evaluated = evaluateWorkspace(workspace);
      const detected = (() => { try { return evaluated.observed.root ? discoverCapabilities(fingerprintProject(evaluated.observed.root)).map((c) => ({ category: c.category, confidence: c.confidence })) : []; } catch { return []; } })();
      const execution = (() => { try { return loadExecution(workspace.executionIds[0]); } catch { return null; } })();
      // Proof integrity is a third fact beside a record's state and its recorded verdict, never a
      // substitute for either: INTACT / MISSING / MISMATCH / NONE, from the local proof store.
      evaluated.capabilities = evaluated.capabilities.map((c) => ({ ...c, proofIntegrity: proofIntegrity(c) }));
      return { assembly: { ...evaluated, presence: capabilityPresence(workspace, { detected }), detected, promotion: checkPromotion(workspace, { execution }), execution: execution ? { executionId: execution.executionId, status: execution.status, verdict: execution.verification?.verdict || null } : null } };
    }
    if (route === '/api/laboratory/assembly/finalize') {
      // Explicit, never automatic: the person asks, GRAFT re-checks everything and fast-forwards.
      fields(body, ['assemblyWorkspaceId', 'confirmed']);
      if (body.confirmed !== true) throw fail('Confirm that GRAFT may move this project to the verified assembled revision.');
      idle();
      const workspace = loadAssemblyWorkspace(string(body.assemblyWorkspaceId, 'Assembly'));
      const execution = (() => { try { return loadExecution(workspace.executionIds[0]); } catch { return null; } })();
      const check = checkPromotion(workspace, { execution });
      if (!check.ok) throw fail(`This assembly cannot be finalized: ${check.problems.join('; ')}`, 409);
      const { promotion } = promoteAssembly(workspace, { execution });
      saveAssemblyWorkspace(workspace);
      record.event('laboratory.finalize', { assemblyWorkspaceId: workspace.assemblyWorkspaceId, executionId: execution?.executionId || null, kind: promotion.kind, fromRevision: promotion.fromRevision, toRevision: promotion.toRevision, forced: promotion.forced, remotesContacted: promotion.remotesContacted, capabilities: workspace.capabilities.map((c) => ({ capability: c.capability, state: c.state, verdict: c.verificationVerdict })) }, { stage: 'review' });
      const evaluated = evaluateWorkspace(workspace);
      // The same three facts per record as the assembly view, finalized or not: state, verdict, proof integrity.
      evaluated.capabilities = evaluated.capabilities.map((c) => ({ ...c, proofIntegrity: proofIntegrity(c) }));
      const detected = (() => { try { return evaluated.observed.root ? discoverCapabilities(fingerprintProject(evaluated.observed.root)).map((c) => ({ category: c.category })) : []; } catch { return []; } })();
      return { assembly: { ...evaluated, presence: capabilityPresence(workspace, { detected }), detected, promotion: checkPromotion(workspace, { execution }) }, promotion };
    }
    if (route === '/api/laboratory/plans') { fields(body, ['blueprintId']); return { plans: listAssemblyPlans({ blueprintId: body.blueprintId === undefined ? null : string(body.blueprintId, 'Blueprint') }) }; }
    if (route === '/api/laboratory/plan/view') { fields(body, ['planId']); return { plan: planView(loadAssemblyPlan(string(body.planId, 'Plan'))) }; }
    if (route === '/api/laboratory/plan/delete') { fields(body, ['planId']); deleteAssemblyPlan(string(body.planId, 'Plan')); return { ok: true }; }
    if (route === '/api/laboratory/plan/explain') {
      fields(body, ['planId']);
      const plan = loadAssemblyPlan(string(body.planId, 'Plan'));
      const agent = agentRuntime();
      if (!agent) throw fail('No agent is configured. The plan is complete without one: every step says what GRAFT will do and why.');
      const advice = await agent.run('explainAssemblyPlan', { blueprint: plan.blueprintName, readiness: plan.readiness, readinessReason: plan.readinessReason, host: plan.host?.label || plan.host?.name || plan.host?.kind, steps: plan.steps.map((s) => ({ type: s.type, what: s.what, supported: s.supported })), blockers: plan.blockers.map((b) => b.detail), warnings: plan.warnings.map((w) => w.detail), architectures: NEW_HOST_ARCHITECTURES.map((a) => a.id) });
      recordPlanAdvice(plan, { ...advice, receivedAt: new Date().toISOString() });
      saveAssemblyPlan(plan);
      record.event('laboratory.plan.explain', { planId: plan.planId, provider: advice.provider, droppedFields: advice.droppedFields.length }, { stage: 'plan' });
      return { plan: planView(plan) };
    }
    if (route === '/api/transplants/prepare') {
      // The page confirms this operation the same way it confirms a run (it creates a worktree),
      // so `trusted` is accepted here; nothing is executed.
      fields(body, ['slug', 'destinationRoot', 'allowDirty', 'trusted']);
      const m = manifest(string(body.slug, 'Capability'));
      const root = string(body.destinationRoot, 'Destination folder');
      if (!path.isAbsolute(root)) throw fail('Enter an absolute folder path.');
      if (body.allowDirty !== undefined && typeof body.allowDirty !== 'boolean') throw fail('allowDirty must be true or false.');
      return launch('prepare', `Prepare isolated transplant into ${path.basename(root)}`, async (job) => {
        job.phase = 'Preparing isolated worktree';
        const prepared = await record.timed('transplant.prepare', 'apply', async () => prepareTransplant({ destinationRoot: root, sourceRoot: m.identity.sourceProjectRoot || null, capabilitySlug: m.identity.slug, allowDirty: body.allowDirty === true }),
          (t) => ({ transplantId: t.id, state: t.state, baseHead: t.baseHead, branch: t.worktree.branch, destinationRepository: t.destination.repositoryId, dirtyAtPreparation: t.destination.dirtyAtPreparation }));
        // The worktree is a project like any other, so plan/apply/verify address it by id.
        const project = projectSummary(addProject(fs.realpathSync(prepared.worktree.path), { name: `${prepared.destination.name} (transplant ${prepared.id})` }).project);
        return { transplant: transplantView(prepared), project };
      });
    }
    if (route === '/api/transplants/changes') {
      fields(body, ['transplantId']);
      return changedFiles(string(body.transplantId, 'Transplant'));
    }
    if (route === '/api/transplants/cleanup') {
      idle(); fields(body, ['transplantId', 'confirmDiscard']);
      if (body.confirmDiscard !== undefined && typeof body.confirmDiscard !== 'boolean') throw fail('confirmDiscard must be true or false.');
      const before = getTransplant(string(body.transplantId, 'Transplant'));
      // The worktree was registered as a project (by real path) when it was prepared; resolve
      // that now, while the folder may still exist, so the registration can be dropped after.
      const registeredRoots = new Set([before.worktree.path]);
      try { registeredRoots.add(fs.realpathSync(before.worktree.path)); } catch { /* already gone */ }
      let cleaned;
      try { cleaned = cleanupTransplant(before.id, { confirmDiscard: body.confirmDiscard === true }); }
      catch (err) { if (err.code === 'worktree-has-changes') throw fail(`${err.message} ${err.remedy || ''}`.trim(), 409); throw err; }
      for (const root of registeredRoots) removeProject(root);
      record.event('transplant.cleanup', { transplantId: cleaned.id, discardedChanges: body.confirmDiscard === true }, { stage: 'rollback', intervention: true });
      return { transplant: transplantView(cleaned) };
    }
    if (route === '/api/workspace/harvest') {
      fields(body, ['projectId', 'capability', 'trusted']);
      if (body.trusted !== true) throw fail('Confirm that you trust this project before running it.');
      const { capability } = getCapability(string(body.projectId, 'Project'), string(body.capability, 'Capability'));
      if (!capability.harvestable || !capability.harvestCategory || !capability.harvestRoot) throw fail(`This capability is not harvestable yet${capability.blockers?.[0] ? `: ${capability.blockers[0].detail}` : ''}.`, 409);
      const real = fs.realpathSync(capability.harvestRoot);
      const registered = addProject(real).project;
      return api('/api/harvest', { projectId: projectId(registered.root), capability: capability.harvestCategory, trusted: true });
    }
    if (route === '/api/workspace/discover') {
      fields(body, ['text', 'explain']);
      const text = string(body.text, 'Request');
      if (text.length > 500) throw fail('Request is too long.');
      const agent = agentRuntime();
      const index = loadIndex();
      const result = await record.timed('workspace.discover', 'register', () => discoverCapabilityCandidates(text, { agent, index, limit: 10, explain: body.explain === true }),
        (r) => ({ agentConfigured: r.agentConfigured, provider: r.agent?.provider || null, total: r.total, rankedByAgent: r.ranking.rankedByAgent, steps: r.steps, elapsedMs: r.elapsedMs }));
      return result;
    }
    if (route === '/api/agent') {
      fields(body, ['provider', 'model', 'endpoint', 'scopes', 'clear']);
      if (body.clear === true) { clearAgentConfig(); return { agent: describeAgentConfig(null) }; }
      if (body.provider === undefined) return { agent: describeAgentConfig(loadAgentConfig()), scopes: SCOPES };
      const saved = saveAgentConfig({ provider: string(body.provider, 'Provider'),
        model: body.model ? string(body.model, 'Model') : null, endpoint: body.endpoint ? string(body.endpoint, 'Endpoint') : null,
        scopes: Array.isArray(body.scopes) && body.scopes.length ? body.scopes : undefined });
      record.event('agent.configure', { provider: saved.provider, model: saved.model, scopes: saved.scopes, keyStoredInConfig: false }, { stage: 'setup' });
      return { agent: describeAgentConfig(saved) };
    }
    if (route === '/api/harvest') {
      fields(body, ['projectId', 'capability', 'trusted']);
      if (body.trusted !== true) throw fail('Confirm that you trust this project before running it.');
      const p = project(body.projectId);
      if (!['authentication', 'hosted-authentication', 'feature-flags', 'feature-flags-library'].includes(body.capability)) throw fail('Only authentication, hosted-authentication and feature-flags (service or library form) can currently be harvested.');
      return launch('harvest', `Harvest ${body.capability} from ${p.name}`, async (job) => {
        job.phase = 'Running source acceptance tests';
        const fp = fingerprintProject(p.root);
        const outcome = await record.timed('harvest', 'harvest', () => harvestCapability(fp, body.capability),
          ({ manifest: m, verification, policy }) => ({ source: identity(fp), capability: body.capability, kind: m?.identity.category || null, slug: m?.identity.slug || null,
            discovered: discoverCapabilities(fp).map((c) => ({ id: c.id, category: c.category, confidence: c.confidence, harvestable: c.harvestable })),
            policy, report: reportSummary(verification), banked: Boolean(policy.bankable && verification?.verdict === 'VERIFIED'), confirmations: ['trusted'] }));
        const { manifest: m, verification, policy } = outcome;
        if (!policy.bankable || verification?.verdict !== 'VERIFIED') return { report: verification, banked: false };
        job.phase = 'Saving verified capability';
        writeManifest(bankDir(), m);
        return { report: verification, banked: true, slug: m.identity.slug };
      });
    }
    if (route === '/api/plan') {
      idle(); fields(body, ['slug', 'projectId', 'resolveConflicts', 'transplantId']);
      if (body.resolveConflicts !== undefined && typeof body.resolveConflicts !== 'boolean') throw fail('Conflict approval must be true or false.');
      // Planning inside a managed transplant targets its worktree, and refuses if the worktree
      // moved or was touched since it was prepared.
      let transplant = null;
      if (body.transplantId !== undefined) {
        transplant = assertApplyable(string(body.transplantId, 'Transplant'));
        if (body.projectId !== undefined && project(body.projectId).root !== fs.realpathSync(transplant.worktree.path)) throw fail('The chosen project is not this transplant\'s worktree.', 409);
        body.projectId = projectId(fs.realpathSync(transplant.worktree.path));
      }
      const m = manifest(body.slug), p = project(body.projectId), fp = fingerprintProject(p.root);
      const plan = await record.timed('plan', 'plan', () => createTransplantPlan(m, fp, { resolveConflicts: body.resolveConflicts === true, atlas: 'local' }),
        (built) => ({ source: { project: m.identity.sourceProject, fingerprint: m.provenance?.sourceFingerprint || null, verifiedInSource: m.provenance?.verifiedInSource || null }, destination: identity(fp),
          capability: body.slug, kind: built.engine?.genome?.identity.kind || null, plan: planSummary(built), safety: checkPreconditions(built, p.root), confirmations: body.resolveConflicts === true ? ['resolveConflicts'] : [] }));
      const safety = checkPreconditions(plan, p.root);
      let entrypoint = null;
      if (plan.files.length && plan.destination.entrypoint && plan.adaptation.profile) {
        safeProjectPath(p.root, plan.destination.entrypoint);
        let routesModule = path.relative(path.dirname(fp.entrypoint), plan.registration?.module || 'src/auth/routes.js').split(path.sep).join('/');
        if (!routesModule.startsWith('.')) routesModule = './' + routesModule;
        const before = fp.readFile(fp.entrypoint);
        const edit = planEntrypointEdit(before, { routesModule, conflictingRoutes: plan.conflicts.routes,
          resolveConflicts: plan.conflicts.resolutionApproved, profile: plan.adaptation.profile, registration: plan.registration || undefined });
        if (edit.applied) entrypoint = { path: fp.entrypoint, before, after: edit.source };
      }
      const id = crypto.randomUUID();
      plans.set(id, { plan, m, projectId: body.projectId, snapshot: snapshot(fp, m), created: Date.now(), transplantId: transplant?.id || null, baseHead: transplant?.baseHead || null });
      if (plans.size > 30) plans.delete(plans.keys().next().value);
      if (transplant) transition(transplant.id, 'READY', { plan: { planId: plan.id, status: plan.status, compatibility: plan.compatibility.status, files: plan.files.map((f) => f.path), entrypoint: plan.destination.entrypoint, recipe: plan.engine.recipe?.name || null, createdAt: plan.createdAt }, reason: 'plan built' });
      return { id, plan, safety, entrypoint, transplantId: transplant?.id || null, review: planReview(plan) };
    }
    if (route === '/api/apply') {
      fields(body, ['planId', 'trusted']);
      if (body.trusted !== true) throw fail('Confirm the reviewed changes and trusted project before applying.');
      idle();
      const saved = plans.get(body.planId);
      if (!saved || Date.now() - saved.created > 15 * 60 * 1000) throw fail('This preview expired. Build a fresh plan.', 409);
      const p = project(saved.projectId), currentManifest = manifest(saved.m.identity.slug);
      if (snapshot(fingerprintProject(p.root), currentManifest) !== saved.snapshot) throw fail('The project or capability changed since this preview. Build a fresh plan.', 409);
      const safety = checkPreconditions(saved.plan, p.root);
      if (!safety.ok) throw fail(safety.problems.map((p) => p.message).join(' '), 409);
      // A managed transplant is applied only to the worktree it was planned for, at the base
      // it was prepared from — checked here and again immediately before the first write.
      if (saved.transplantId) { const t = assertApplyable(saved.transplantId); if (t.baseHead !== saved.baseHead) throw fail('The transplant base moved since planning. Prepare a fresh transplant.', 409); }
      plans.delete(body.planId);
      return launch('transplant', `Transplant into ${p.name}`, (job) => applyAndVerify(saved, p, safety, job));
    }
    if (route === '/api/verify') {
      fields(body, ['slug', 'projectId', 'trusted']);
      if (body.trusted !== true) throw fail('Confirm that you trust this project before running it.');
      const m = manifest(body.slug), p = project(body.projectId);
      return launch('verify', `Verify ${p.name}`, async (job) => {
        job.phase = 'Running acceptance tests';
        const fp = fingerprintProject(p.root);
        const report = await record.timed('verify', 'verify', () => verifyCapability(m, p.root, { entrypoint: fp.entrypoint, atlas: 'local' }),
          (r) => ({ capability: body.slug, destination: identity(fp), report: reportSummary(r), confirmations: ['trusted'] }));
        return { report };
      });
    }
    throw fail('Not found.', 404);
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    const send = (status, value, type = 'application/json') => {
      // A charset belongs on text; declaring one on an image makes the browser decode bytes as text.
      const binary = Buffer.isBuffer(value);
      res.writeHead(status, { ...headers, 'Content-Type': binary ? type : `${type}; charset=utf-8` });
      res.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      if (req.headers.host !== new URL(origin).host) throw fail('Invalid host.', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw fail('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw fail('Cross-site requests are not allowed.', 403);
      const route = new URL(req.url, origin).pathname;
      if (route.startsWith('/api/')) {
        if (req.headers['x-graft-token'] !== token) throw fail('Session expired. Reload this page.', 403);
        if (!authorize()) throw fail('Activate GRAFT to use this desktop workspace.', 402);
        // The stale-project count runs git per indexed project (synchronously, on this process's only
        // thread). Polled every second on a workspace of dozens of projects it kept the main thread busy
        // for seconds at a time — long enough to starve a verification's provider double while the
        // page watched the assembly. It is informational, so it is recomputed at most every 10 s per index.
        const staleCount = (index) => {
          const key = `${graftHome()}|${index?.updatedAt || ''}`;
          if (!staleMemo || staleMemo.key !== key || Date.now() - staleMemo.at > 10000) staleMemo = { key, at: Date.now(), count: staleProjects().length };
          return staleMemo.count;
        };
        if (req.method === 'GET' && route === '/api/state') {
          const registry = loadRegistry();
          return send(200, { projects: registry.projects.map(projectSummary), bank: bankSummary(), transplants: registry.transplants,
            jobs, activeJob: active?.id || null, home: graftHome(), savedResults: registry.transplants.map(transplantSummary), dogfood: record.session, managedTransplants: listTransplants().map(transplantView),
            workspace: (() => { try { const index = loadIndex(); return { ...indexSummary({ index }), stale: staleCount(index) }; } catch (err) { return { error: err.message, roots: [], projects: 0 }; } })(),
            agent: (() => { try { return describeAgentConfig(loadAgentConfig()); } catch (err) { return { configured: false, error: err.message }; } })() });
        }
        if (req.method !== 'POST') throw fail('Method not allowed.', 405);
        if (req.headers['content-type'] !== 'application/json') throw fail('Expected application/json.', 415);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 16384) throw fail('Request is too large.', 413);
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Invalid JSON.'); }
        return send(200, await api(route, body));
      }
      if (req.method !== 'GET') throw fail('Method not allowed.', 405);
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/brand-icon.png': ['brand-icon.png', 'image/png'] };
      if (!Object.hasOwn(assets, route)) throw fail('Not found.', 404);
      const [file, type] = assets[route];
      // Text assets are read as text so the page can be stamped with its token; an image is bytes
      // and must stay bytes.
      if (type.startsWith('image/')) { send(200, fs.readFileSync(path.join(publicDir, file)), type); }
      else {
        let contents = fs.readFileSync(path.join(publicDir, file), 'utf8');
        if (route === '/') contents = contents.replace('__GRAFT_TOKEN__', token);
        send(200, contents, type);
      }
    } catch (err) {
      if (req.url?.startsWith('/api/') && req.method === 'POST') record.error('other', err, { route: new URL(req.url, origin || 'http://127.0.0.1').pathname });
      if (!res.headersSent) send(err.status || 400, { error: err.message }); else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  return { server, origin, close: () => closeTask ||= (async () => {
    stopping = true;
    await pending;
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  })() };
}

export function keepDashboard(app) {
  console.log(`GRAFT workspace: ${app.origin}\nLocal access only. Keep this process running while using the dashboard.`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('Closing after the current operation finishes…');
    app.close().catch((err) => { console.error(err.message); process.exitCode = 1; });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startDashboard({ port: process.env.GRAFT_UI_PORT === undefined ? 4317 : Number(process.env.GRAFT_UI_PORT) })
    .then(keepDashboard)
    .catch((err) => { console.error(err.message); process.exitCode = 1; });
}
