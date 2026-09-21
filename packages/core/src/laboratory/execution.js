// Laboratory 0.3 — Assembly Execution (single capability).
//
// The first phase in which the Laboratory writes anything outside GRAFT_HOME. Two things live here:
//
//   1. `createHost` — the CREATE_HOST operation for the one supported blank host shape
//      (Node / ESM / bare node:http with one central async handler). It writes a small, ordinary
//      starter application into a NEW child folder of a parent the person chose, stages the files
//      first and renames into place, initialises a local git repository with one deterministic
//      commit (the transplant system needs a repository to cut its isolated worktree from), and
//      configures no remote. Nothing in the created application depends on GRAFT.
//
//   2. The `LaboratoryAssemblyExecution` record: explicit states, a per-step log, receipts and
//      references to the authoritative evidence (transplant record, verification report, proof).
//      Persisted atomically under GRAFT_HOME/laboratory/executions. The orchestration of the
//      transplant steps themselves goes through GRAFT's existing operations (fingerprint / Host
//      Model / createTransplantPlan / prepareTransplant / applyTransplant / verifyCapability /
//      decideVerdict) in the product; this module never re-implements them.
//
// COMPLETED means every planned step finished through its operation. It never means VERIFIED:
// the capability verdict is copied from the verifier's report and shown beside it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { graftHome } from '../registry/index.js';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { buildHostModel } from '../engine/host.js';
import { stableHash } from '../capability/contract.js';
import { NEW_HOST_ARCHITECTURES, APPLYING_STEP_TYPES } from './assembly.js';

export const EXECUTION_SCHEMA_VERSION = '1.0.0';
export const EXECUTION_STATES = Object.freeze(['PREPARING', 'CREATING_HOST', 'HOST_CREATED', 'INDEXING_HOST', 'PREPARING_WORKTREE', 'PLANNING_TRANSPLANT', 'APPLYING', 'VERIFYING', 'REINDEXING', 'COMPLETED', 'FAILED', 'INCONCLUSIVE', 'BLOCKED', 'STALE']);
export const TERMINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'INCONCLUSIVE', 'BLOCKED', 'STALE']);
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=GRAFT Laboratory', '-c', 'user.email=laboratory@graft.local', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---------------------------------------------------------------------------------------------
// CREATE_HOST: the blank node:http host. Files are plain; the shape is exactly what the
// `esm-node-http-central` emitter profile needs (one module-scope createServer with an inline
// async (req, res) handler), which the fingerprint must independently confirm afterwards.
// ---------------------------------------------------------------------------------------------
export const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A safe folder / package name from whatever the person typed. */
export function normaliseHostName(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  if (!HOST_NAME.test(slug)) throw fail('invalid-host-name', 'The application name must contain at least one letter or digit.');
  return slug;
}
function hostFiles(name, architecture) {
  if (architecture.id !== 'node-esm-http-central') throw fail('unsupported-host-architecture', `createHost writes only the bare node:http host in this phase (asked for ${architecture.id}).`);
  return {
    'package.json': JSON.stringify({ name, version: '0.1.0', private: true, description: 'A small Node application: one node:http server with a central request handler.', type: 'module', engines: { node: '>=20' }, scripts: { start: 'node server.mjs', test: 'node --test' }, license: 'UNLICENSED' }, null, 2) + '\n',
    'server.mjs': `// ${name} — a bare node:http application with one central request handler.
// Every request passes through the handler below, in order: health, root, then a plain 404.
import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const started = new Date().toISOString();

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, started });
  if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { name: ${JSON.stringify(name)}, message: 'Hello from ' + ${JSON.stringify(name)} });
  return json(res, 404, { error: 'not-found', path: url.pathname });
});

server.listen(port, () => {
  console.log(\`${name} listening on http://localhost:\${port}\`);
});
`,
    '.gitignore': 'node_modules/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n',
    'README.md': `# ${name}

A small Node.js application created by GRAFT Laboratory as a starting host.

- Runtime: Node.js >= 20, ES modules
- HTTP: the standard \`node:http\` module with one central request handler in \`server.mjs\`
- Dependencies: none

## Run

\`\`\`
npm start
\`\`\`

Then open http://localhost:3000/ — \`/health\` answers \`{ "ok": true }\`, anything else answers 404.

The application does not depend on GRAFT and can be developed like any other Node project.
`,
  };
}
/** Resolve the parent the person chose; refuse anything that is not a real, existing directory reached without symlinks. */
function resolveParent(parentDir) {
  if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir)) throw fail('invalid-parent', 'Choose a folder to create the application in.');
  let real;
  try { if (fs.lstatSync(parentDir).isSymbolicLink()) throw fail('parent-symlink', 'The chosen folder is a symbolic link; choose its real location.'); real = fs.realpathSync.native(parentDir); }
  catch (err) { if (err.code === 'parent-symlink') throw err; throw fail('parent-missing', 'The chosen folder does not exist.'); }
  if (!fs.statSync(real).isDirectory()) throw fail('parent-not-a-directory', 'The chosen path is not a folder.');
  const home = (() => { try { return fs.realpathSync.native(graftHome()); } catch { return null; } })();
  if (home && (real === home || real.startsWith(home + path.sep))) throw fail('parent-inside-graft-home', 'GRAFT will not create an application inside its own home folder. Choose a folder of your own.');
  return real;
}
/**
 * Create the blank host: stage the files in a hidden sibling, initialise git and commit, then
 * rename into the final child folder. Any failure before the rename removes the staged folder.
 * Returns a HostCreationReceipt (not a verdict: it proves only that the shell exists).
 */
export function createHost({ parentDir, name, architectureId, executionId = null, planId = null, hostId = null, now = () => new Date().toISOString() }) {
  const architecture = NEW_HOST_ARCHITECTURES.find((a) => a.id === architectureId);
  if (!architecture) throw fail('unknown-architecture', `Unknown host architecture ${architectureId}.`);
  const parent = resolveParent(parentDir);
  const slug = normaliseHostName(name);
  const target = path.join(parent, slug);
  if (fs.existsSync(target) || (() => { try { fs.lstatSync(target); return true; } catch { return false; } })()) throw fail('target-exists', `${slug} already exists in the chosen folder. Choose another name or folder; nothing is overwritten.`);
  const files = hostFiles(slug, architecture);
  const staging = path.join(parent, `.${slug}.graft-creating-${crypto.randomBytes(3).toString('hex')}`);
  let committed = null;
  try {
    fs.mkdirSync(staging, { mode: 0o755 });
    for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(staging, file), contents, { flag: 'wx', mode: 0o644 });
    git(staging, ['init', '--quiet', '--initial-branch=main']);
    git(staging, ['add', '--all']);
    git(staging, ['commit', '--quiet', '--no-verify', '-m', `Create ${slug}: blank Node / ESM / node:http host (GRAFT Laboratory)`]);
    committed = git(staging, ['rev-parse', 'HEAD']);
    // The rename is the authoritative handoff: before it, nothing at the chosen name exists.
    fs.renameSync(staging, target);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  const fp = fingerprintProject(target);
  const host = buildHostModel(fp);
  const remotes = git(target, ['remote']);
  return {
    kind: 'HostCreationReceipt', receiptVersion: '1.0.0', assemblyExecutionId: executionId, planId, hostId, requestedHostId: hostId,
    projectName: slug, architectureId: architecture.id, root: target, files: Object.keys(files).sort(), initialCommit: committed, branch: 'main', remotes: remotes ? remotes.split('\n') : [],
    fingerprint: { runtime: 'node', moduleSystem: fp.moduleSystem.value, framework: fp.framework.value, handlerContract: fp.handlerContract.value, entrypoint: fp.entrypoint, central: fp.central ? { supported: fp.central.supported === true, reason: fp.central.reason || null } : null, profile: host.constraints.adaptationProfile, profilesByKind: host.constraints.profilesByKind, hostId: host.hostId },
    verdict: null, note: 'This receipt proves only that the requested shell was created. It is not a verification.', createdAt: now(),
  };
}
/** Compare the host that actually exists with what the plan asked for. A mismatch stops the assembly. */
export function checkCreatedHost(receipt, hostSpec) {
  const fp = receipt.fingerprint;
  const expect = [['moduleSystem', hostSpec.moduleSystem, fp.moduleSystem], ['framework', hostSpec.framework, fp.framework], ['handlerContract', hostSpec.handlerContract, fp.handlerContract], ['profile', hostSpec.profile, fp.profile]];
  const mismatches = expect.filter(([, want, got]) => want !== got).map(([field, want, got]) => `${field}: planned ${want}, actual ${got}`);
  if (fp.central && fp.central.supported !== true) mismatches.push(`central handler: ${fp.central.reason}`);
  return { ok: mismatches.length === 0, mismatches, actual: fp };
}

// ---------------------------------------------------------------------------------------------
// The execution record.
// ---------------------------------------------------------------------------------------------
export const executionsDir = () => path.join(graftHome(), 'laboratory', 'executions');
const ID = /^exec-[a-z0-9][a-z0-9-]{0,100}-[0-9a-f]{6}$/;
const executionFile = (id) => { if (!ID.test(id)) throw fail('invalid-execution-id', 'Execution id must be a short lowercase id.'); return path.join(executionsDir(), `${id}.json`); };
const SECRET_KEY = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
function assertStorable(value, trail = 'execution') {
  if (Array.isArray(value)) { value.forEach((v, i) => assertStorable(v, `${trail}[${i}]`)); return; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) { if (SECRET_KEY.test(k) && typeof v === 'string' && v.length) throw fail('execution-privacy', `${trail}.${k} looks like a secret value; executions store configuration names only.`); assertStorable(v, `${trail}.${k}`); } return; }
  // The managed worktree (where the assembled application lives), apply receipts and proof references are kept on purpose; nothing else may carry GRAFT_HOME.
  if (typeof value === 'string' && value.includes(graftHome()) && !/worktree|receipt|report|proof|resultLocation|wording/i.test(trail)) throw fail('execution-privacy', `${trail} would store a GRAFT_HOME path.`);
}
/** Paths the record keeps on purpose: the created project and the managed worktree are where the person's application lives. */
export function createExecution(plan, { destinationParent, projectName, now = () => new Date().toISOString() }) {
  const executionId = `exec-${plan.blueprintId}-${crypto.randomBytes(3).toString('hex')}`;
  return {
    schemaVersion: EXECUTION_SCHEMA_VERSION, executionId, planId: plan.planId, blueprintId: plan.blueprintId, blueprintName: plan.blueprintName, planRevision: plan.blueprintRevision, planReadinessAtStart: plan.readiness,
    status: 'PREPARING', startedAt: now(), finishedAt: null, host: { ...plan.host, destinationParent, projectName }, currentStep: null,
    steps: plan.steps.map((s) => ({ stepId: s.stepId, order: s.order, type: s.type, what: s.what, operation: s.operation?.function || null, status: 'PENDING', startedAt: null, finishedAt: null, outcome: null, error: null })),
    receipts: [], verification: null, hostPreservation: null, reindex: null, proofReferences: [], transplantId: null, worktree: null, createdProject: null,
    finalState: null, finalSummary: null, error: null, authority: { deterministic: true, agentDecided: false }, agentAdvice: null,
  };
}
export function saveExecution(execution) {
  assertStorable(execution);
  const file = executionFile(execution.executionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(execution, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  return execution;
}
export function loadExecution(id) {
  const file = executionFile(id);
  if (!fs.existsSync(file)) throw fail('unknown-execution', `No assembly execution ${id}.`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== EXECUTION_SCHEMA_VERSION) throw fail('unsupported-schema', `Execution schema ${parsed.schemaVersion} is not supported.`);
  return parsed;
}
export function listExecutions({ planId = null, blueprintId = null } = {}) {
  const dir = executionsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { executionId: e.executionId, planId: e.planId, blueprintId: e.blueprintId, status: e.status, finalState: e.finalState, verdict: e.verification?.verdict || null, worktree: e.worktree?.path || null, createdProject: e.createdProject?.root || null, startedAt: e.startedAt, finishedAt: e.finishedAt }; } catch { return null; } })
    .filter((e) => e && (!planId || e.planId === planId) && (!blueprintId || e.blueprintId === blueprintId)).sort((x, y) => (y.startedAt || '').localeCompare(x.startedAt || ''));
}
/** Step bookkeeping. `advance` is the only way a step changes state, and it is called by the orchestrator around the mapped operation. */
export function beginStep(execution, type, status, { now = () => new Date().toISOString() } = {}) {
  const step = execution.steps.find((s) => s.type === type && s.status === 'PENDING');
  if (!step) throw fail('no-such-step', `The plan has no pending ${type} step.`);
  step.status = 'RUNNING'; step.startedAt = now(); execution.currentStep = step.stepId; execution.status = status;
  return step;
}
export function finishStep(execution, step, outcome, { now = () => new Date().toISOString() } = {}) {
  step.status = 'DONE'; step.finishedAt = now(); step.outcome = outcome; execution.currentStep = null;
  return step;
}
export function failStep(execution, step, error, status, { now = () => new Date().toISOString() } = {}) {
  // An operation's message may name the managed worktree; the record keeps the message, not the path.
  const message = String(error.message || error).split(graftHome()).join('$GRAFT_HOME');
  if (step) { step.status = 'FAILED'; step.finishedAt = now(); step.error = message; }
  for (const s of execution.steps) if (s.status === 'PENDING') s.status = 'SKIPPED';
  execution.status = status; execution.finalState = status; execution.error = { message, code: error.code || null, remedy: error.remedy || null }; execution.finishedAt = now(); execution.currentStep = null;
  return execution;
}
/**
 * The final assembly result, derived only from referenced authoritative outcomes: the verifier's
 * verdict, host preservation from the same report, the created host's own re-index, and every
 * plan step's status. No new verdict is invented here.
 */
export function concludeExecution(execution, { now = () => new Date().toISOString() } = {}) {
  // A composition carries one final verdict per capability; the execution's verdict is VERIFIED
  // only when every one of them is, on the same final revision (decided by the kernel, copied here).
  const composed = execution.composition?.capabilities || null;
  const composedVerdict = () => {
    if (execution.composition.finalState === 'ALL_SELECTED_CAPABILITIES_VERIFIED' && composed.length && composed.every((c) => c.finalVerdict === 'VERIFIED')) return 'VERIFIED';
    if (composed.some((c) => c.finalVerdict === 'FAILED')) return 'FAILED';
    return composed.find((c) => c.finalVerdict && c.finalVerdict !== 'VERIFIED')?.finalVerdict || 'FAILED';
  };
  const verdict = composed ? composedVerdict() : execution.verification?.verdict || null;
  const stepsFailed = execution.steps.filter((s) => s.status === 'FAILED' || s.status === 'SKIPPED');
  const preservationOk = execution.hostPreservation ? execution.hostPreservation.failed === 0 : null;
  // A terminal state set by `failStep` (FAILED / INCONCLUSIVE / BLOCKED / STALE) is kept as it is.
  const status = TERMINAL_STATES.includes(execution.status) ? execution.status : stepsFailed.length ? 'FAILED' : verdict === 'VERIFIED' ? 'COMPLETED' : verdict === 'FAILED' ? 'FAILED' : verdict ? 'INCONCLUSIVE' : 'FAILED';
  execution.status = status; execution.finalState = status; execution.finishedAt = now(); execution.currentStep = null;
  execution.finalSummary = {
    assembly: status,
    capabilities: composed ? composed.map((c) => ({ capability: c.capability, verdict: c.finalVerdict, passed: c.finalSummary?.passed ?? null, required: c.finalSummary?.required ?? null, reverified: c.reverifiedVerdict !== null }))
      : execution.verification ? [{ capability: execution.verification.capability, verdict, passed: execution.verification.summary?.passed ?? null, required: execution.verification.summary?.required ?? null }] : [],
    hostPreservation: preservationOk === null ? 'not captured' : preservationOk ? 'passed' : 'failed',
    finalAssemblyVerification: verdict === 'VERIFIED' && preservationOk !== false && !stepsFailed.length
      ? composed ? `${composed.length} capabilities, each verified by its own contract on the one final revision ${String(execution.composition.finalRevision).slice(0, 12)}, earlier capabilities re-verified after later ones; host behaviour preserved against the baseline captured before composition` : 'one capability, verified by its own contract on the created host; host behaviour preserved; no composed multi-capability proof exists'
      : 'no verified assembled state',
    // Named from what was actually assembled: the wording must never describe another capability.
    resultLocation: execution.worktree?.path || null,
    wording: status === 'COMPLETED'
      ? composed ? `Assembly COMPLETED. ${composed.map((c) => c.capability).join(' and ')} each VERIFIED by their own contracts on the same final revision. This is not a "verified app" claim.`
        : `Assembly COMPLETED. ${execution.verification?.capability || 'The capability'} VERIFIED by its contract${execution.capabilitySource?.implementationForm === 'library' ? ' in this host, as an adapted library' : ''}. This is not a "verified app" claim.`
      : `Assembly ${status}.`,
  };
  return execution;
}

// ---------------------------------------------------------------------------------------------
// Execution lock: one execution per plan at a time, held as a file created with `wx`.
// ---------------------------------------------------------------------------------------------
export function acquireExecutionLock(planId) {
  const dir = executionsDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `.lock-${planId}`);
  try { fs.writeFileSync(file, JSON.stringify({ planId, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (err) { if (err.code === 'EEXIST') throw fail('execution-locked', 'This plan is already being executed.'); throw err; }
  return { release: () => fs.rmSync(file, { force: true }), file };
}
/**
 * The eligibility gate, re-run at execution time from the plan as stored and the blueprint as it
 * is now. One capability or several: every requested capability must be selected, supported,
 * carry its source evidence, target the planned host, have an operation path, sit in the plan's
 * deterministic order, and — when there is more than one — be re-verified on the final combined
 * state. Partial support is refused whole; no capability may be dropped between plan and execution.
 */
export function checkExecutionEligibility(planView, { hostArchitectureAllowed = ['node-esm-http-central'] } = {}) {
  const problems = [];
  if (planView.status === 'STALE') problems.push(`the plan is STALE: ${planView.freshness.reasons.join('; ')}`);
  if (planView.readiness !== 'READY_TO_ASSEMBLE') problems.push(`the plan is ${planView.readiness}, not READY_TO_ASSEMBLE`);
  if (planView.host?.kind !== 'new-application') problems.push('this phase executes plans for a new blank application only');
  else if (!hostArchitectureAllowed.includes(planView.host.architectureId)) problems.push(`this phase executes only ${hostArchitectureAllowed.join(', ')} hosts (plan asks for ${planView.host.architectureId})`);
  const steps = planView.steps || [];
  const applying = steps.filter((s) => APPLYING_STEP_TYPES.includes(s.type));
  if (!applying.length) problems.push('the plan applies no capability (no TRANSPLANT_CAPABILITY or ADAPT_LIBRARY_CAPABILITY step)');
  if (steps.some((s) => s.supported === false)) problems.push('a planned step is not supported');
  // Every requested capability, none dropped: the plan's expected capabilities and its applying
  // steps must name exactly the same ids, once each.
  const expected = (planView.expectedCapabilities || []).map((c) => c.capabilityId);
  const applied = applying.map((s) => s.capability?.capabilityId || null);
  if (applied.some((id) => !id)) problems.push('a capability step names no capability id');
  if (new Set(applied.filter(Boolean)).size !== applied.length) problems.push('a capability is applied more than once');
  for (const id of expected) if (!applied.includes(id)) problems.push(`expected capability ${id} has no applying step: it would silently disappear from the execution`);
  for (const id of applied.filter(Boolean)) if (!expected.includes(id)) problems.push(`applying step names ${id}, which the plan does not expect`);
  // Deterministic order: the applying steps follow the plan's own recorded order, goal by goal.
  const orderedGoals = (planView.order || []).map((o) => o.goalId);
  const applyingGoals = applying.map((s) => s.goalId);
  if (!planView.ordering?.rule) problems.push('the plan records no ordering rule, so its execution order cannot be explained');
  if (applyingGoals.some((g, i) => orderedGoals.indexOf(g) < 0 || (i > 0 && orderedGoals.indexOf(g) <= orderedGoals.indexOf(applyingGoals[i - 1])))) problems.push('the applying steps do not follow the plan\'s recorded capability order');
  for (const step of applying) {
    const name = step.capability?.name || step.capability?.slug || step.goalId;
    // Source evidence: the capability was VERIFIED where it came from. Execution re-establishes
    // this again against the bank; here it is required of the plan.
    const evidence = (planView.evidence || []).find((e) => e.goalId === step.goalId);
    if (evidence?.sourceVerdict !== 'VERIFIED') problems.push(`${name}: source verification is ${evidence?.sourceVerdict || 'absent'}, not VERIFIED`);
    // The same planned host for every capability.
    if (planView.host?.profile && step.profile !== planView.host.profile) problems.push(`${name}: planned for profile ${step.profile || 'none'}, not the host's ${planView.host.profile}`);
    // An operation path: a verification step for the capability after its applying step.
    const at = steps.indexOf(step);
    if (!steps.some((s, i) => i > at && s.type === 'VERIFY_CAPABILITY' && s.goalId === step.goalId)) problems.push(`${name}: no VERIFY_CAPABILITY step follows its applying step`);
    // A library adaptation must not proceed without the identity check that precedes its writes.
    if (step.type === 'ADAPT_LIBRARY_CAPABILITY' && !steps.some((s, i) => i < at && s.type === 'VERIFY_SOURCE_ARTIFACT_IDENTITY' && s.goalId === step.goalId)) problems.push(`${name}: a library adaptation plan must check the source artifact identity before it writes`);
  }
  // A composition must say what its execution does: every earlier capability re-verified after
  // the last one is applied, then preservation, re-index and the final binding.
  if (applying.length > 1) {
    const lastApply = steps.indexOf(applying[applying.length - 1]);
    for (const step of applying.slice(0, -1)) if (!steps.some((s, i) => i > lastApply && s.type === 'REVERIFY_CAPABILITY' && s.goalId === step.goalId)) problems.push(`${step.capability?.name || step.goalId} is not re-verified after the later capabilities are applied`);
    if (!steps.some((s, i) => i > lastApply && s.type === 'CHECK_HOST_PRESERVATION' && !s.goalId)) problems.push('the composed application is not checked against the host baseline captured before composition');
    if (!steps.some((s, i) => i > lastApply && s.type === 'REINDEX_HOST')) problems.push('the composed application is not re-indexed');
  }
  if (steps.length && steps[steps.length - 1].type !== 'FINAL_VERIFICATION') problems.push('the plan does not end with FINAL_VERIFICATION');
  return { ok: problems.length === 0, problems, capabilities: applying.length };
}
export const isTerminal = (execution) => TERMINAL_STATES.includes(execution.status);
