// Dogfood recorder: a local, append-only record of one real GRAFT session.
//
// Purpose: capture what GRAFT observed, decided and proved while an operator runs a real
// transplant, so the failure topology of a run can be studied afterwards. It records
// structure, decisions, verdicts and timings — never source text.
//
// Boundaries (enforced here, not by convention):
//   - Local only. Everything is written under GRAFT_HOME/dogfood/<session>/ with 0600 files.
//     Nothing here opens a socket, and nothing in the product reads these files back to
//     send them anywhere.
//   - Opt-in. A recorder exists only when the operator asked for one (GRAFT_DOGFOOD or an
//     explicit startDashboard option). Without it every hook is a no-op.
//   - No customer source. Generated file contents, entrypoint before/after text, repair
//     edit text, HTTP bodies and cookies are stripped by `sanitize` before anything is
//     written; only paths, byte counts, hashes, verdicts and reasons remain.
//   - Recording never changes an outcome. Every write is wrapped: a recorder failure is
//     reported in the record (when possible) and swallowed, never surfaced as a product error.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { graftHome } from '../registry/index.js';
import { architectureSignature } from '../capability/contract.js';
import { projectFingerprint } from '../capability/knowledge.js';

export const DOGFOOD_VERSION = '1.0.0';
export const OBSERVATION_TAGS = Object.freeze(['ENGINE_DEFECT', 'MISSING_ENGINE_CAPABILITY', 'VERIFICATION_GAP', 'UX_FRICTION', 'PERFORMANCE', 'EXPECTED_REFUSAL', 'SUCCESS']);
export const STAGES = Object.freeze(['setup', 'register', 'harvest', 'plan', 'apply', 'verify', 'repair', 'review', 'rollback', 'other']);
/**
 * Descriptive outcome of a recorded session. Never a verdict: SUCCESS is only ever copied from
 * a verification report the verifier produced, and no other state can be promoted into it.
 *
 *   SUCCESS                 the last recorded verification said VERIFIED
 *   FAIL                    the last verification said FAILED, or work failed outside a refusal
 *   INCONCLUSIVE            verification ran without deciding, or files were written and never verified
 *   SAFE_REFUSAL            GRAFT was asked to act and correctly declined; nothing was written
 *   PACKAGED                a capability was harvested and exported as a package; no transplant attempted
 *   BLUEPRINTED             a Laboratory blueprint was created; a design, never a verdict; no transplant attempted
 *   PLANNED                 a Laboratory assembly plan was built; a description of steps, never a verdict; nothing executed
 *   ASSEMBLED               a Laboratory assembly ran to COMPLETED and its capability verified; the capability verdict is the verifier's
 *   FINALIZED               an assembled application was explicitly promoted into the person's own checkout by fast-forward
 *   COMPOSED_TEST           a multi-capability composition landed; every selected capability is CURRENT and verified
 *                           at one shared revision. "TEST" because the composition kernel is exercised with GRAFT's
 *                           own test sources; it is never a claim about the application as a whole.
 *   NO_TRANSPLANT_ATTEMPTED nothing was asked of the pipeline (a discovery-only session)
 */
export const FINAL_STATES = Object.freeze(['SUCCESS', 'FAIL', 'INCONCLUSIVE', 'SAFE_REFUSAL', 'PACKAGED', 'BLUEPRINTED', 'PLANNED', 'ASSEMBLED', 'FINALIZED', 'COMPOSED_TEST', 'NO_TRANSPLANT_ATTEMPTED']);
export const SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export const dogfoodDir = () => path.join(graftHome(), 'dogfood');
const sha = (value) => 'sha256:' + crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// Keys whose values are, or can carry, source text or secrets. Dropped wherever they occur.
const SOURCE_KEYS = new Set(['contents', 'before', 'after', 'basis', 'edits', 'entrypointBefore', 'readFile', 'body', 'cookies', 'headers', 'response', 'request', 'steps', 'stack', 'agentBrief', 'packageJson']);
const SECRET_PATTERN = /(sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|Bearer\s+[A-Za-z0-9._-]+|[A-Za-z0-9+/]{40,}={0,2})/g;
// Hex digests (git SHAs, sha256 ids) are identifiers, not secrets; every other long token is redacted.
const redact = (text) => text.replace(SECRET_PATTERN, (match) => /^[0-9a-f]{40,64}$/i.test(match) ? match : '[redacted]');

/** Strip source text, request/response payloads and secret-looking strings from a value. */
export function sanitize(value, depth = 0) {
  if (depth > 12) return '[depth-limited]';
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…[+${value.length - 2000}]` : redact(value);
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // `source` names a repository or an architecture value in plans, but multi-line text under it is code.
      if (SOURCE_KEYS.has(k) || (k === 'source' && typeof v === 'string' && v.includes('\n'))) {
        if (typeof v === 'string') out[`${k}Digest`] = { bytes: Buffer.byteLength(v, 'utf8'), sha256: sha(v) };
        else if (Array.isArray(v)) out[`${k}Count`] = v.length;
        continue;
      }
      const clean = sanitize(v, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return value;
}

function git(root, args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim(); }
  catch { return null; }
}
function stripCredentials(remote) {
  if (!remote) return null;
  try { const u = new URL(remote); u.username = ''; u.password = ''; return u.toString(); }
  catch { return remote.replace(/^[^@]+@/, ''); } // scp-like user@host:path → host:path
}

/** Identity of a repository as GRAFT met it: names, hashes, architecture, shape counts. No text. */
export function repositoryIdentity(fp) {
  const root = fp.root;
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  const status = git(root, ['status', '--porcelain', '--', root]);
  let structureHash = null;
  try { structureHash = projectFingerprint(fp); } catch { structureHash = null; }
  return {
    name: fp.name, version: fp.version || null, rootHash: sha(root), rootBasename: path.basename(root),
    git: { head, branch: git(root, ['symbolic-ref', '--short', 'HEAD']) || (head ? 'detached' : null), remote: stripCredentials(git(root, ['remote', 'get-url', 'origin'])),
      dirty: status === null ? null : status.length > 0, dirtyFiles: status ? status.split('\n').length : 0 },
    architecture: architectureSignature(fp), structureHash,
    shape: { files: fp.files.length, routes: fp.routes.length, entrypoint: fp.entrypoint || null, dependencies: fp.dependencies.map((d) => d.name), environmentVariables: fp.environmentVariables.length, sqlFiles: fp.sqlFiles.length },
    detection: { framework: fp.framework, moduleSystem: fp.moduleSystem, handlerContract: fp.handlerContract, persistence: { value: fp.persistence.value, evidence: fp.persistence.evidence } },
  };
}

/** Structured, source-free summary of a plan: what the engine understood and decided. */
export function planSummary(plan) {
  const e = plan.engine || {};
  const a = e.analysis || {};
  const prior = a.priorObservations || null;
  return {
    planId: plan.id, status: plan.status, capability: plan.capability, source: plan.source, destinationShape: plan.destination.shape, entrypoint: plan.destination.entrypoint,
    adaptation: { profile: plan.adaptation.profile, specId: plan.adaptation.specId, refusal: plan.adaptation.refusal, usesSharedStore: plan.adaptation.usesSharedStore },
    compatibility: plan.compatibility, conflicts: { routes: plan.conflicts.routes.length, resolutionApproved: plan.conflicts.resolutionApproved },
    files: plan.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.contents || '', 'utf8') })), steps: plan.steps.map((s) => ({ order: s.order, kind: s.kind, requiresExplicitApproval: s.requiresExplicitApproval === true, approved: s.approved })),
    genome: e.genome ? { genomeId: e.genome.genomeId, kind: e.genome.identity.kind, capabilityId: e.genome.identity.capabilityId, entrypoints: e.genome.entrypoints.length, inputs: e.genome.inputs.length, outputs: e.genome.outputs.length, sideEffects: e.genome.sideEffects.length,
      dependentModules: e.genome.dependentModules.length, environment: e.genome.environment.map((v) => v.name), behaviors: e.genome.purpose.behaviors.length, notFound: e.genome.purpose.notFound.length, sourceArchitecture: e.genome.provenance.sourceArchitecture } : null,
    host: e.host ? { hostId: e.host.hostId, profile: e.host.constraints?.adaptationProfile ?? null, architecture: e.host.architecture, routing: e.host.routing, dataLayer: { persistence: e.host.dataLayer?.persistence, modules: (e.host.dataLayer?.modules || []).length }, testing: e.host.testing,
      existingCapabilities: e.host.existingCapabilities, constraints: e.host.constraints, structure: e.host.structure } : null,
    ir: e.ir ? { irId: e.ir.irId, operations: (e.ir.operations || []).length, policies: Object.keys(e.ir.policies || {}), state: (e.ir.state || []).length, adaptationPoints: (e.ir.adaptationPoints || []).map((p) => p.id || p) } : null,
    recipe: e.recipe ? { recipeId: e.recipe.recipeId, name: e.recipe.name, origin: e.recipe.provenance?.origin, status: e.recipe.provenance?.status || 'builtin' } : null,
    recipeSelection: e.recipeSelection ? { matches: e.recipeSelection.matches, considered: e.recipeSelection.considered, explanation: e.recipeSelection.explanation, alternatives: e.recipeSelection.alternatives, learnedRecipes: e.recipeSelection.learnedRecipes } : null,
    analysis: { mismatches: a.mismatches, adaptations: a.adaptations, risks: a.risks, unknowns: a.unknowns, summary: a.summary },
    verificationContract: plan.semantic?.verificationContract || null,
    atlasUsed: prior ? { observations: prior.observations, considered: prior.considered, verdicts: prior.verdicts, ranked: (prior.ranked || []).map((r) => ({ entryId: r.entryId, score: r.score, verdict: r.verdict, reasons: r.reasons })), top: prior.top ? { entryId: prior.top.entryId, score: prior.top.score } : null } : null,
  };
}

/** Source-free summary of a verification report. */
export function reportSummary(report) {
  if (!report) return null;
  return { verdict: report.verdict, rationale: report.rationale, summary: report.summary, serverReady: report.serverReady ?? null, runtime: report.runtime?.profile || null, startedAt: report.startedAt || null, finishedAt: report.finishedAt || null,
    results: (report.results || []).map((r) => ({ id: r.id, outcome: r.outcome, required: r.required, provesBehavior: r.provesBehavior || null, reason: r.reason || null })),
    proof: report.proof ? { contractId: report.proof.contractId, summary: report.proof.summary, invariants: report.proof.invariants, routeCoverage: report.proof.routeCoverage || [], appliedRecipe: report.proof.appliedRecipe || null } : null,
    compatibilityObservation: report.compatibilityObservation ? { result: report.compatibilityObservation.result, adaptation: report.compatibilityObservation.adaptation, recipeId: report.compatibilityObservation.recipeId || null } : null,
    atlasEntry: report.atlasEntry || null, atlasRecordingError: report.atlasRecordingError || null, knowledgeRecordingError: report.knowledgeRecordingError || null };
}

class Recorder {
  constructor(session, { directory }) {
    this.session = session;
    this.directory = directory;
    this.file = path.join(directory, 'events.jsonl');
    this.sequence = 0;
  }
  /** Append one event. Never throws. */
  event(type, data = {}, { stage = null, elapsedMs = null, intervention = false } = {}) {
    const record = { seq: ++this.sequence, at: new Date().toISOString(), session: this.session, type, stage, ...(elapsedMs === null ? {} : { elapsedMs: Math.round(elapsedMs * 1000) / 1000 }), ...(intervention ? { intervention: true } : {}), data: sanitize(data) };
    try { fs.appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 }); }
    catch (err) { record.recordingError = err.message; }
    return record;
  }
  error(stage, err, extra = {}) { return this.event('error', { message: err?.message || String(err), status: err?.status || null, code: err?.code || null, ...extra }, { stage }); }
  /** Time an async or sync operation and record its outcome; the operation's result/throw is passed through untouched. */
  async timed(type, stage, operation, describe = (r) => r) {
    const started = process.hrtime.bigint();
    const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
    try {
      const result = await operation();
      // A summarising failure is recorded as such; it must never turn a successful operation into an error.
      let data;
      try { data = describe(result); } catch (err) { data = { describeError: err.message }; }
      this.event(type, data, { stage, elapsedMs: elapsed() });
      return result;
    } catch (err) { this.error(stage, err, { during: type, elapsedMs: elapsed() }); throw err; }
  }
}

/** The only way a session name becomes a path: validated, and always directly under the dogfood directory. */
export function sessionDir(name, directory = dogfoodDir()) {
  if (!SESSION_NAME.test(name || '')) throw new Error('Dogfood session names are 1–64 characters of letters, digits, dot, dash or underscore.');
  return path.join(directory, name);
}

/** Open (creating if needed) the local record for a named session. */
export function openDogfoodSession(name, { directory = dogfoodDir(), context = {} } = {}) {
  const dir = sessionDir(name, directory);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = path.join(dir, 'session.json');
  if (!fs.existsSync(meta)) {
    fs.writeFileSync(meta, JSON.stringify({ dogfoodVersion: DOGFOOD_VERSION, session: name, startedAt: new Date().toISOString(), platform: process.platform, node: process.version, local: true, telemetry: false, uploads: 'never', ...sanitize(context) }, null, 2) + '\n', { mode: 0o600 });
  }
  const recorder = new Recorder(name, { directory: dir });
  const existing = readEvents(dir);
  recorder.sequence = existing.length ? existing[existing.length - 1].seq : 0;
  recorder.event('session.open', { context: sanitize(context) }, { stage: 'setup' });
  return recorder;
}

/** A recorder whose every method is a no-op: what the product uses when nobody asked for a record. */
export function nullRecorder() {
  return { session: null, directory: null, event() { return null; }, error() { return null; }, async timed(_type, _stage, operation) { return operation(); } };
}

/** The recorder the environment asks for (GRAFT_DOGFOOD=<session>), or the null recorder. */
export function recorderFromEnvironment(context = {}) {
  const name = process.env.GRAFT_DOGFOOD;
  if (!name) return nullRecorder();
  return openDogfoodSession(name, { context });
}

export function readEvents(dir) {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function listDogfoodSessions({ directory = dogfoodDir() } = {}) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => SESSION_NAME.test(name) && fs.existsSync(path.join(directory, name, 'session.json'))).sort().map((name) => {
    const events = readEvents(path.join(directory, name));
    return { session: name, directory: path.join(directory, name), events: events.length, startedAt: JSON.parse(fs.readFileSync(path.join(directory, name, 'session.json'), 'utf8')).startedAt, lastEventAt: events.at(-1)?.at || null };
  });
}

/** Operator annotation: tag an observation. Optional `ref` names the event sequence it is about. */
export function annotate(name, { tag, stage = 'other', text, ref = null, intervention = false, terminal = false, directory = dogfoodDir() }) {
  if (!OBSERVATION_TAGS.includes(tag)) throw new Error(`tag must be one of ${OBSERVATION_TAGS.join(', ')}`);
  if (!STAGES.includes(stage)) throw new Error(`stage must be one of ${STAGES.join(', ')}`);
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('an observation needs a short description (≤ 2000 characters)');
  if (ref !== null && !(Number.isInteger(ref) && ref > 0)) throw new Error('ref must be a positive event sequence number');
  const recorder = openDogfoodSession(name, { directory });
  return recorder.event('observation', { tag, text: text.trim(), ref, terminal }, { stage, intervention });
}

/** Observable counts for the dogfood scorecard. Nothing here is a judgement; every number names the events it was counted from. */
export function scorecard(name, { directory = dogfoodDir() } = {}) {
  const dir = sessionDir(name, directory);
  if (!fs.existsSync(path.join(dir, 'session.json'))) throw new Error(`no dogfood session named "${name}" under ${directory}`);
  const events = readEvents(dir);
  const of = (type) => events.filter((e) => e.type === type);
  const observations = of('observation');
  const tagged = (tag) => observations.filter((e) => e.data.tag === tag);
  const seqs = (list) => list.map((e) => e.seq);
  const plans = of('plan'), applies = of('apply'), verifies = [...of('verify'), ...applies.map((a) => ({ ...a, data: { report: a.data.report } }))].filter((e) => e.data.report);
  const harvests = of('harvest');
  const finalVerify = verifies.at(-1)?.data.report || null;
  const repairAttempts = applies.flatMap((a) => a.data.repair?.attempts || []);
  const interventions = events.filter((e) => e.intervention);
  const terminal = observations.filter((e) => e.data.terminal);
  const elapsedByStage = {};
  for (const e of events) if (e.elapsedMs !== undefined && e.stage) elapsedByStage[e.stage] = Math.round(((elapsedByStage[e.stage] || 0) + e.elapsedMs) * 1000) / 1000;
  const first = events[0]?.at, last = events.at(-1)?.at;
  // Final state, in priority order. A correct refusal is not a failure, and a session that
  // never asked the pipeline for anything has not failed either. SUCCESS is only ever the
  // verifier's own VERIFIED, copied; nothing else can be promoted into it.
  const errors = of('error');
  const refusalEvents = [...of('apply.refused'), ...errors.filter((e) => e.data.status === 409)];
  const hardErrors = errors.filter((e) => e.data.status !== 409);
  const attempted = [...harvests, ...plans, ...applies, ...of('verify'), ...of('apply.refused')].length > 0;
  const applied = applies.filter((a) => a.data.branch).length;
  const { finalState, finalStateReason } = (() => {
    // Laboratory 0.3: an assembly execution's own outcome. COMPLETED is the orchestration finishing;
    // the capability verdict beside it is the verifier's, and a failed one is never promoted here.
    // Laboratory 0.3.5: an explicit, safe promotion of a verified assembly is the session's outcome.
    // It says where the verified application now lives — never that the application is universally verified.
    // Laboratory 0.4a: a composition transaction's own outcome. A rejected candidate is a correct
    // refusal, not a failure — nothing durable moved.
    const compositions = of('laboratory.compose');
    if (compositions.length) {
      const last = compositions.at(-1).data;
      if (last.rejected) return { finalState: 'SAFE_REFUSAL', finalStateReason: `the composition candidate was rejected at ${last.stage} and discarded; the assembly stayed at its previous verified revision` };
      if (last.finalState === 'ALL_SELECTED_CAPABILITIES_VERIFIED') return { finalState: 'COMPOSED_TEST', finalStateReason: `${(last.capabilities || []).length} capability record(s) are CURRENT and verified at ${String(last.revisionAB || '').slice(0, 12)}; each verdict is the verifier's` };
      return { finalState: 'INCONCLUSIVE', finalStateReason: `the composition ended ${last.finalState}` };
    }
    const finalizations = of('laboratory.finalize');
    if (finalizations.length) { const last = finalizations.at(-1).data; return { finalState: 'FINALIZED', finalStateReason: `the verified assembly was promoted by ${last.kind} to ${String(last.toRevision || '').slice(0, 12)}; its capability verdict is the verifier's` }; }
    const executions = of('laboratory.execute');
    if (executions.length) {
      const last = executions.at(-1).data;
      if (last.finalState === 'COMPLETED' && last.verdict === 'VERIFIED') return { finalState: 'ASSEMBLED', finalStateReason: `the assembly completed and ${last.verdict === 'VERIFIED' ? 'its capability verified' : 'its capability did not verify'}` };
      if (last.finalState === 'FAILED') return { finalState: 'FAIL', finalStateReason: `the assembly stopped: ${last.error || last.verdict || 'a step failed'}` };
      return { finalState: 'INCONCLUSIVE', finalStateReason: `the assembly ended ${last.finalState}${last.verdict ? ` with verification ${last.verdict}` : ''}` };
    }
    if (finalVerify) {
      if (finalVerify.verdict === 'VERIFIED') return { finalState: 'SUCCESS', finalStateReason: 'the last recorded verification reported VERIFIED' };
      if (finalVerify.verdict === 'FAILED') return { finalState: 'FAIL', finalStateReason: 'the last recorded verification reported FAILED' };
      return { finalState: 'INCONCLUSIVE', finalStateReason: `the last recorded verification reported ${finalVerify.verdict}` };
    }
    if (applied) return { finalState: 'INCONCLUSIVE', finalStateReason: 'a transplant was applied but no verification was recorded' };
    // Capability Export 0.1: a session that harvested and packaged a capability, without any
    // transplant, ended as it was meant to. Packaging is not a verdict, so this is not SUCCESS.
    const exported = of('capability.export');
    if (exported.length && !plans.length && !applies.length) return { finalState: 'PACKAGED', finalStateReason: `${exported.length} capability package(s) were exported; no transplant was attempted` };
    // Laboratory 0.1: a session that designed a blueprint ended as it was meant to. A blueprint is
    // a design with readiness states of its own; it is never VERIFIED and never SUCCESS here.
    const plannedAssembly = of('laboratory.plan');
    if (plannedAssembly.length && !plans.length && !applies.length) return { finalState: 'PLANNED', finalStateReason: `${plannedAssembly.length} assembly plan(s) were built in the Laboratory; nothing was executed` };
    const blueprinted = of('laboratory.create');
    if (blueprinted.length && !plans.length && !applies.length) return { finalState: 'BLUEPRINTED', finalStateReason: `${blueprinted.length} blueprint(s) were created in the Laboratory; no transplant was attempted` };
    if (refusalEvents.length) return { finalState: 'SAFE_REFUSAL', finalStateReason: `GRAFT declined ${refusalEvents.length} request(s) and wrote nothing` };
    if (hardErrors.length) return { finalState: 'FAIL', finalStateReason: `${hardErrors.length} error(s) stopped the session before any verification` };
    if (attempted && tagged('EXPECTED_REFUSAL').length) return { finalState: 'SAFE_REFUSAL', finalStateReason: 'the operator recorded the outcome as an expected refusal' };
    if (attempted) return { finalState: 'INCONCLUSIVE', finalStateReason: 'pipeline work was recorded but nothing reached verification' };
    return { finalState: 'NO_TRANSPLANT_ATTEMPTED', finalStateReason: 'no harvest, plan, apply or verify was recorded in this session' };
  })();
  // Prediction is judged for the plan that was applied (matched by plan id); the latest plan otherwise.
  const appliedPlanId = applies.at(-1)?.data.planId || null;
  const latestPlan = (appliedPlanId && plans.find((p) => p.data.plan?.planId === appliedPlanId)?.data) || plans.at(-1)?.data || null;
  return {
    dogfoodVersion: DOGFOOD_VERSION, session: name, events: events.length, startedAt: first || null, endedAt: last || null,
    totalElapsedMs: first && last ? Date.parse(last) - Date.parse(first) : 0, elapsedByStage,
    capabilityRecognition: { harvests: harvests.length, recognized: harvests.filter((h) => h.data.kind).length, verifiedInSource: harvests.filter((h) => h.data.report?.verdict === 'VERIFIED').length, banked: harvests.filter((h) => h.data.banked).length, kinds: [...new Set(harvests.map((h) => h.data.kind).filter(Boolean))], events: seqs(harvests) },
    hostModel: latestPlan?.plan?.host ? { hostId: latestPlan.plan.host.hostId, profile: latestPlan.plan.host.profile, unknownDimensions: Object.entries(latestPlan.plan.host.architecture || {}).filter(([, v]) => v === 'unknown').map(([k]) => k), unknowns: latestPlan.plan.analysis?.unknowns?.length ?? null, existingCapabilities: latestPlan.plan.host.existingCapabilities?.length ?? null } : null,
    compatibilityPrediction: { plans: plans.length, predicted: plans.map((p) => ({ seq: p.seq, planStatus: p.data.plan?.status, compatibility: p.data.plan?.compatibility?.status, recipe: p.data.plan?.recipe?.name || null })), observed: finalVerify?.verdict || null,
      agreement: latestPlan && finalVerify ? (latestPlan.plan?.status === 'ready' ? finalVerify.verdict === 'VERIFIED' : finalVerify.verdict !== 'VERIFIED') : null },
    manualIntervention: { count: interventions.length, events: seqs(interventions) },
    terminalUse: { count: terminal.length, events: seqs(terminal) },
    transplant: { applied, branches: applies.map((a) => a.data.branch).filter(Boolean), finalVerdict: finalVerify?.verdict || null, finalState, finalStateReason, refusals: seqs(refusalEvents) },
    repair: { attempts: repairAttempts.length, classified: repairAttempts.filter((a) => a.class).length, repaired: repairAttempts.filter((a) => a.repaired).length, classes: [...new Set(repairAttempts.map((a) => a.class).filter(Boolean))] },
    verificationCoverage: finalVerify ? { results: finalVerify.results.length, passed: finalVerify.results.filter((r) => r.outcome === 'passed').length, failed: finalVerify.results.filter((r) => r.outcome === 'failed').length, inconclusive: finalVerify.results.filter((r) => r.outcome === 'inconclusive').length,
      required: finalVerify.results.filter((r) => r.required).length, invariants: finalVerify.proof?.invariants || null, routeCoverage: finalVerify.proof?.routeCoverage || [] } : null,
    evidenceQuality: finalVerify ? { verdict: finalVerify.verdict, rationale: finalVerify.rationale, proofContract: finalVerify.proof?.contractId || null, atlasEntry: finalVerify.atlasEntry?.entryId || null, recordingErrors: [finalVerify.atlasRecordingError, finalVerify.knowledgeRecordingError].filter(Boolean) } : null,
    atlas: { used: plans.map((p) => p.data.plan?.atlasUsed?.observations || 0), generated: verifies.map((v) => v.data.report?.atlasEntry?.entryId).filter(Boolean) },
    counts: { engineDefects: tagged('ENGINE_DEFECT').length, missingCapabilities: tagged('MISSING_ENGINE_CAPABILITY').length, verificationGaps: tagged('VERIFICATION_GAP').length, uxFriction: tagged('UX_FRICTION').length, performance: tagged('PERFORMANCE').length, expectedRefusals: tagged('EXPECTED_REFUSAL').length, successes: tagged('SUCCESS').length,
      errors: of('error').length, refusals: events.filter((e) => e.type === 'error' && e.data.status === 409).length, inconclusive: verifies.filter((v) => v.data.report?.verdict === 'NEEDS_REVIEW').length },
    // Operator-asserted: a VERIFIED verdict the operator found unjustified, or a mutation/error the verifier missed, must be tagged explicitly.
    falseVerified: observations.filter((e) => e.data.tag === 'VERIFICATION_GAP' && /false verified/i.test(e.data.text)).length,
    missedMutations: observations.filter((e) => e.data.tag === 'VERIFICATION_GAP' && /missed (mutation|error)/i.test(e.data.text)).length,
    observations: observations.map((e) => ({ seq: e.seq, tag: e.data.tag, stage: e.stage, ref: e.data.ref, terminal: e.data.terminal, text: e.data.text })),
  };
}
