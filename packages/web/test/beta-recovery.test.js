// Commercial Beta Readiness 0.1, Checkpoint A — through the real product server: a failed assembly
// is not a dead end (Retry = a fresh execution under a free name; Discard = GRAFT's own working copy
// only), an interrupted one is reported as "did not finish", proofs export from the assembly as
// exact copies, a diagnostic bundle saves locally with no secrets, and the page renders the recovery
// panel, the proof-export control, the supported panel and distinct state tones.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { startDashboard } from '../src/server.js';
import { fingerprintProject } from '../../core/src/analyze/fingerprint.js';
import { harvestCapability } from '../../core/src/harvest/index.js';
import { writeManifest } from '../../core/src/manifest/io.js';
import { bankDir } from '../../core/src/registry/index.js';
import { loadProofArtifact, proofArtifactPath } from '../../core/src/laboratory/proof-store.js';
import { loadExecution, saveExecution, executionsDir } from '../../core/src/laboratory/execution.js';
import { readZip } from '../../core/src/export/index.js';
import { verifyProofFile } from '../../proof-adapter/src/index.js';

const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const haveSwivel = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js'));
const needSwivel = { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function setup(t) {
  const previous = process.env.GRAFT_HOME;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-beta-ui-')));
  process.env.GRAFT_HOME = path.join(work, 'home'); fs.mkdirSync(process.env.GRAFT_HOME, { recursive: true });
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
  const app = await startDashboard({ port: 0 });
  const html = await (await fetch(app.origin)).text();
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(html)[1];
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  async function request(route, body) {
    const response = await fetch(`${app.origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Graft-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  }
  async function finished(id) { for (let n = 0; n < 900; n++) { const state = await request('state'); const job = state.jobs.find((j) => j.id === id); if (job && job.status !== 'running') return job; await pause(100); } throw new Error('the job did not finish in time'); }
  return { work, request, finished };
}
/** The page's own view functions, evaluated from app.js exactly as the browser would run them. */
function pageViews({ lab = {}, data = {} } = {}) {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
  const helpers = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); const icon = () => ''; const disabled = () => ''; let lastProofExport = null; const FORM_LABEL = { library: 'Library', service: 'Service' }; const goalLabel = () => null; const capabilityLabel = (p, id, slug) => slug; const executionStageLabel = (e, p, s) => s.type; const compositionResultView = () => ''; const libraryEvidenceView = () => ''; const loadAssemblyPlan = () => {};\n`
    + source.split('\n').filter((l) => l.startsWith('const badge = (text, tone') || l.startsWith('const ledgerTone = ')).join('\n') + '\n' + slice('function supportedView()', 'function empty(') + slice('function assemblyExecutionView(', '// A composition, rendered') + slice('function assembledApplicationView(', 'async function loadAssembly(');
  const built = new Function('lab', 'data', 'window', `${helpers}\nreturn { recoveryView, assembledApplicationView, supportedView, assemblyExecutionView, ledgerTone };`)(lab, data, {});
  return { ...built, text: (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
}

test('a failed assembly offers Retry (fresh execution, free name) and Discard; Retry succeeds; the failed record is kept; proofs export as exact copies; diagnostics save locally', needSwivel, async (t) => {
  const app = await setup(t);
  const created = await app.request('laboratory/create', { name: 'Flagged application', description: 'features can be turned on per context', categories: ['feature-flags'], hostIntent: 'new-application' });
  const blueprintId = created.blueprint.blueprintId;
  const goal = created.blueprint.analysis.goals.find((g) => g.category === 'feature-flags');
  const organ = goal.candidates.find((c) => c.kind === 'organ' && c.slug === 'feature-flags-library');
  await app.request('laboratory/select', { blueprintId, goalId: goal.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } });
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  assert.equal(planned.plan.readiness, 'READY_TO_ASSEMBLE');
  const parent = path.join(app.work, 'apps'); fs.mkdirSync(path.join(parent, 'flagged-application'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'flagged-application', 'KEEP.txt'), 'the person\'s own folder');

  // 1. A real, customer-recoverable failure: the chosen name already exists in the folder.
  const launched = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'flagged-application' });
  const job = await app.finished(launched.job.id);
  assert.equal(job.status, 'failed');
  const failed = (await app.request('laboratory/execution', { executionId: job.execution.executionId })).execution;
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.error.code, 'target-exists');
  assert.deepEqual([failed.failure.kind, failed.failure.title], ['name-taken', 'That application name is already taken in the chosen folder.']);
  assert.deepEqual(failed.recovery.retry, { available: true, planId: planned.plan.planId, destinationParent: parent, suggestedProjectName: 'flagged-application-2' });
  assert.equal(failed.recovery.discard.available, true); assert.equal(failed.recovery.interrupted, false);
  // The page: a recovery panel with Retry / Discard / Save diagnostic bundle, technical detail collapsed.
  const views = pageViews();
  const panel = views.recoveryView(failed);
  assert.match(panel, /That application name is already taken/); assert.match(panel, /data-action="lab-retry"[^>]*data-root="flagged-application-2"/); assert.match(panel, /data-action="lab-discard"/); assert.match(panel, /data-action="diagnostics"/);
  assert.match(panel, /<details class="tech"><summary>Technical details<\/summary>/); assert.ok(panel.indexOf('target-exists') > panel.indexOf('<details'), 'the raw code lives inside Technical details');
  assert.equal(views.text(panel).startsWith('That application name is already taken in the chosen folder. Retry with a different name, or choose another folder.'), true);

  // 2. Retry: a NEW execution under the suggested name; the failed one is unchanged history.
  const retried = await app.request('laboratory/execution/retry', { executionId: failed.executionId });
  assert.equal(retried.status, 200, JSON.stringify(retried));
  const retryJob = await app.finished(retried.job.id);
  assert.equal(retryJob.status, 'completed', JSON.stringify(retryJob.error || retryJob.status));
  const done = (await app.request('laboratory/execution', { executionId: retryJob.execution.executionId })).execution;
  assert.notEqual(done.executionId, failed.executionId); assert.equal(done.status, 'COMPLETED'); assert.equal(done.recovery, null); assert.equal(done.failure, null);
  assert.equal(path.basename(done.createdProject.root), 'flagged-application-2');
  assert.equal(fs.readFileSync(path.join(parent, 'flagged-application', 'KEEP.txt'), 'utf8'), 'the person\'s own folder', 'the folder that caused the failure is untouched');
  const failedAfter = (await app.request('laboratory/execution', { executionId: failed.executionId })).execution;
  assert.equal(failedAfter.status, 'FAILED'); assert.deepEqual(failedAfter.recoveryHistory.map((h) => [h.action, h.projectName]), [['retry', 'flagged-application-2']]);
  // 3. Discard the failed one: nothing GRAFT does not own is touched; offered once.
  const discarded = await app.request('laboratory/execution/discard', { executionId: failed.executionId });
  assert.equal(discarded.status, 200, JSON.stringify(discarded)); assert.equal(discarded.execution.status, 'FAILED'); assert.equal(discarded.execution.recovery.discard.available, false);
  assert.deepEqual(discarded.execution.recoveryHistory.map((h) => h.action), ['retry', 'discard']);
  assert.equal((await app.request('laboratory/execution/discard', { executionId: failed.executionId })).status, 409);
  assert.equal((await app.request('laboratory/execution/discard', { executionId: done.executionId })).status, 409, 'a completed assembly is not discardable');
  assert.equal((await app.request('laboratory/execution/retry', { executionId: done.executionId })).status, 409, 'a completed assembly is not retried');
  assert.ok(fs.existsSync(done.createdProject.root)); assert.equal(git(SWIVEL, ['status', '--porcelain']), '', 'the donor is untouched');

  // 4. The assembly: CURRENT, INTACT, and its proofs export as exact byte copies through the product.
  const { assembly } = await app.request('laboratory/assembly', { assemblyWorkspaceId: done.assemblyWorkspaceId });
  assert.deepEqual(assembly.capabilities.map((c) => [c.state, c.verificationVerdict, c.proofIntegrity.status]), [['CURRENT', 'VERIFIED', 'INTACT']]);
  const out = path.join(app.work, 'exported'); fs.mkdirSync(out);
  const exported = await app.request('laboratory/assembly/proofs/export', { assemblyWorkspaceId: done.assemblyWorkspaceId, destination: out });
  assert.equal(exported.status, 200, JSON.stringify(exported)); assert.equal(exported.count, 1); assert.equal(exported.exported[0].digest, assembly.capabilities[0].proofReference.envelopeDigest);
  const file = path.join(out, exported.exported[0].file);
  assert.equal(Buffer.compare(fs.readFileSync(file), fs.readFileSync(proofArtifactPath(exported.exported[0].digest))), 0, 'the exported file IS the stored artifact');
  assert.equal(verifyProofFile(file).intact, true); assert.equal(verifyProofFile(file).claim.destinationRevision, done.assembledRevision);
  const ledgerHtml = pageViews({ lab: { assembly } }).assembledApplicationView(done);
  assert.match(ledgerHtml, /data-action="export-proofs"/); assert.match(ledgerHtml, /Exports the tamper-evident proof files for this assembly \(1\)/); assert.match(ledgerHtml, /id="assembled-application"/);
  assert.match(ledgerHtml, /class="badge current">CURRENT/); assert.doesNotMatch(ledgerHtml, /class="badge good">CURRENT/, 'CURRENT has its own tone, not VERIFIED\'s');
  // A corrupted stored proof: export fails closed with customer wording; the capability is not re-judged.
  const stored = proofArtifactPath(exported.exported[0].digest); const original = fs.readFileSync(stored, 'utf8');
  fs.writeFileSync(stored, original.replace('"VERIFIED"', '"FAILED"'));
  const refused = await app.request('laboratory/assembly/proofs/export', { assemblyWorkspaceId: done.assemblyWorkspaceId, destination: out });
  assert.equal(refused.status, 409); assert.match(refused.error, /^Proof could not be exported because its stored integrity check failed\./);
  const after = (await app.request('laboratory/assembly', { assemblyWorkspaceId: done.assemblyWorkspaceId })).assembly;
  assert.deepEqual([after.capabilities[0].state, after.capabilities[0].verificationVerdict, after.capabilities[0].proofIntegrity.status], ['CURRENT', 'VERIFIED', 'MISMATCH']);
  assert.match(pageViews({ lab: { assembly: after } }).assembledApplicationView(done), /No exportable proof: a stored proof did not pass its integrity check/);
  fs.writeFileSync(stored, original);

  // 5. Diagnostics: a bundle for the failed execution, saved where the person chose, with support facts and no secrets.
  const diag = await app.request('diagnostics/bundle', { executionId: failed.executionId, destination: out });
  assert.equal(diag.status, 200, JSON.stringify(diag)); assert.match(diag.file, /^graft-diagnostics-exec-[a-z0-9-]+\.zip$/); assert.equal(diag.failure.kind, 'name-taken');
  const zip = readZip(fs.readFileSync(path.join(out, diag.file)));
  const facts = JSON.parse(zip['diagnostics.json'].toString('utf8'));
  assert.equal(facts.execution.status, 'FAILED'); assert.equal(facts.execution.failure.kind, 'name-taken'); assert.ok(facts.graft.version); assert.deepEqual(facts.executions.map((e) => e.status).sort(), ['COMPLETED', 'FAILED']);
  const text = Object.values(zip).map((b) => b.toString('utf8')).join('\n');
  assert.equal(text.includes(app.work), false, 'no machine path'); assert.equal(text.includes(os.homedir()), false); assert.doesNotMatch(text, /GRAFT-(?:[A-Z0-9]{4,5}-){3,4}[A-Z0-9]{4,5}/);
  const wsDiag = await app.request('diagnostics/bundle', { assemblyWorkspaceId: done.assemblyWorkspaceId, destination: out });
  assert.equal(wsDiag.status, 200); assert.ok(wsDiag.entries.some((e) => e.startsWith('proofs/graft-proof-')), 'intact proofs travel with an assembly bundle');
});

test('an execution that did not finish is reported as such (never rewritten to FAILED), a lock left by a dead process is released on Retry, and the page shows the supported panel and onboarding copy', needSwivel, async (t) => {
  const app = await setup(t);
  const created = await app.request('laboratory/create', { name: 'Interrupted', description: 'features can be turned on per context', categories: ['feature-flags'], hostIntent: 'new-application' });
  const blueprintId = created.blueprint.blueprintId;
  const goal = created.blueprint.analysis.goals.find((g) => g.category === 'feature-flags');
  const organ = goal.candidates.find((c) => c.kind === 'organ' && c.slug === 'feature-flags-library');
  await app.request('laboratory/select', { blueprintId, goalId: goal.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } });
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  const parent = path.join(app.work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  // A run that was cut off: the record on disk is not terminal, no job in this process owns it, and its lock names a dead process.
  const launched = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'interrupted' });
  const job = await app.finished(launched.job.id); assert.equal(job.status, 'completed');
  const e = loadExecution(job.execution.executionId);
  e.status = 'EXECUTING'; e.finalState = null; e.finishedAt = null; e.currentStep = 'VERIFY_CAPABILITY'; e.executionId = `exec-${e.blueprintId}-dead01`; e.assemblyWorkspaceId = null; e.assembledRevision = null; saveExecution(e);
  fs.writeFileSync(path.join(executionsDir(), `.lock-${planned.plan.planId}`), JSON.stringify({ planId: planned.plan.planId, pid: 999999, at: '2026-01-01T00:00:00.000Z' }));
  const shown = (await app.request('laboratory/execution', { executionId: e.executionId })).execution;
  assert.equal(shown.status, 'EXECUTING', 'the record is not rewritten'); assert.equal(shown.recovery.interrupted, true); assert.equal(shown.recovery.failure.title, 'This assembly did not finish.');
  assert.match(pageViews().recoveryView(shown), /This assembly did not finish\./);
  const retried = await app.request('laboratory/execution/retry', { executionId: e.executionId, projectName: 'interrupted-again' });
  assert.equal(retried.status, 200, JSON.stringify(retried));
  const again = await app.finished(retried.job.id); assert.equal(again.status, 'completed', JSON.stringify(again.error || again.status));
  assert.equal(fs.existsSync(path.join(executionsDir(), `.lock-${planned.plan.planId}`)), false, 'the stale lock is gone, the new run released its own');
  const discarded = await app.request('laboratory/execution/discard', { executionId: e.executionId });
  assert.equal(discarded.status, 200, JSON.stringify(discarded)); assert.equal(discarded.execution.status, 'EXECUTING'); assert.equal(discarded.execution.recovery.discard.available, false);
  // Page copy: the supported boundary and the onboarding words.
  const views = pageViews();
  const supported = views.text(views.supportedView());
  assert.match(supported, /Supported Hosted sign-in .* Email\/password session auth .* Feature flags as a library/); assert.match(supported, /Experimental Express ESM hosts for hosted sign-in/); assert.match(supported, /Not yet CommonJS hosts .* Windows and Intel Macs/);
  assert.match(supported, /Nothing experimental is presented as supported/);
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /<h2>You already built it\.<\/h2>/); assert.match(source, /data-action="onboard-folder"[^>]*>[^<]*Choose software folder/); assert.match(source, /What’s supported in this beta/);
  assert.equal(views.ledgerTone('CURRENT'), 'current'); assert.equal(views.ledgerTone('STALE'), 'stale');
  assert.doesNotMatch(source, /<dt>Emitter profile<\/dt>/); assert.doesNotMatch(source, /<dt>Genome<\/dt>/); assert.doesNotMatch(source, /<dt>Atlas evidence<\/dt>/);
  assert.match(source, /<details class="tech"><summary>Technical details<\/summary><small>\$\{esc\(s\.type\)\}<\/small><br><code>\$\{esc\(s\.operation\.function\)\}<\/code><\/details>/, 'step ids and engine operations are behind Technical details');
});
