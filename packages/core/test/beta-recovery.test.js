// Commercial Beta Readiness 0.1, Checkpoint A — pure helpers: recovery assessment, stale-lock
// release, customer failure wording, and the diagnostic bundle's collect → redact → validate →
// package pipeline (fail closed on secret-shaped material).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessRecovery, describeFailure, inspectExecutionLock, releaseStaleExecutionLock, suggestFreeProjectName, annotateRecovery } from '../src/laboratory/recovery.js';
import { collectDiagnostics, packageDiagnostics, saveDiagnostics, findDiagnosticLeaks, scrubPaths, diagnosticsFileName } from '../src/laboratory/diagnostics.js';
import { createExecution, saveExecution, acquireExecutionLock, executionsDir, failStep, beginStep } from '../src/laboratory/execution.js';
import { readZip } from '../src/export/index.js';
import { storeProof } from '../src/laboratory/proof-store.js';
import { envelopeFor } from './helpers/proof.js';

function home(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-beta-'));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
const plan = () => ({ planId: 'plan-flagged-000000-abcdef', blueprintId: 'flagged-000000', blueprintName: 'Flagged portal', blueprintRevision: 1, readiness: 'READY', host: { architectureId: 'node-esm-http-central' },
  steps: [{ stepId: 's1', order: 1, type: 'CREATE_HOST', what: 'create', operation: { function: 'createHost' } }, { stepId: 's2', order: 2, type: 'VERIFY_CAPABILITY', what: 'verify', operation: { function: 'verifyCapability' } }] });

test('recovery: a failed execution offers Retry (a NEW execution, free name) and Discard; a non-terminal one is "did not finish", never FAILED; COMPLETED and running offer nothing', (t) => {
  const work = home(t);
  const parent = path.join(work, 'apps'); fs.mkdirSync(path.join(parent, 'flagged-portal'), { recursive: true });
  const e = createExecution(plan(), { destinationParent: parent, projectName: 'Flagged portal' });
  const step = beginStep(e, 'CREATE_HOST', 'PREPARING');
  failStep(e, step, Object.assign(new Error('flagged-portal already exists in the chosen folder. Choose another name.'), { code: 'target-exists' }), 'FAILED');
  const r = assessRecovery(e);
  assert.equal(r.interrupted, false); assert.equal(r.status, 'FAILED');
  assert.deepEqual([r.failure.kind, r.failure.title], ['name-taken', 'That application name is already taken in the chosen folder.']);
  assert.deepEqual(r.retry, { available: true, planId: e.planId, destinationParent: parent, suggestedProjectName: 'flagged-portal-2' }, 'retry suggests the first free name; the old folder is left alone');
  assert.deepEqual(r.discard, { available: true, transplantId: null, discardedAt: null }); assert.equal(r.diagnostics.available, true);
  // Interrupted: not terminal, not running here.
  const running = createExecution(plan(), { destinationParent: parent, projectName: 'Flagged portal' }); running.status = 'EXECUTING'; running.currentStep = 'VERIFY_CAPABILITY';
  const ir = assessRecovery(running);
  assert.equal(ir.interrupted, true); assert.equal(ir.status, 'EXECUTING', 'the record is not rewritten to FAILED'); assert.equal(ir.failure.kind, 'interrupted'); assert.equal(ir.failure.title, 'This assembly did not finish.'); assert.equal(ir.failure.technical, 'stopped during VERIFY_CAPABILITY');
  assert.equal(assessRecovery(running, { running: true }), null, 'still running in this process: nothing to recover yet');
  assert.equal(assessRecovery({ ...e, status: 'COMPLETED' }), null);
  // Discard is offered once; the annotation is history, the status stays.
  annotateRecovery(e, { action: 'discard', transplantId: null }, { now: () => '2026-09-13T20:00:00.000Z' });
  assert.deepEqual(assessRecovery(e).discard, { available: false, transplantId: null, discardedAt: '2026-09-13T20:00:00.000Z' }); assert.equal(e.status, 'FAILED');
  assert.equal(suggestFreeProjectName(parent, 'Brand New'), 'brand-new'); fs.mkdirSync(path.join(parent, 'flagged-portal-2')); assert.equal(suggestFreeProjectName(parent, 'Flagged portal'), 'flagged-portal-3');
});

test('stale execution locks: a lock held by a live process stays; a lock whose process is gone is released', (t) => {
  home(t);
  const lock = acquireExecutionLock('plan-x');
  assert.deepEqual([inspectExecutionLock('plan-x').held, inspectExecutionLock('plan-x').stale, inspectExecutionLock('plan-x').pid], [true, false, process.pid]);
  assert.deepEqual(releaseStaleExecutionLock('plan-x'), { released: false, reason: 'held-by-live-process', pid: process.pid });
  assert.throws(() => acquireExecutionLock('plan-x'), (e) => e.code === 'execution-locked');
  fs.writeFileSync(path.join(executionsDir(), '.lock-plan-x'), JSON.stringify({ planId: 'plan-x', pid: 999999, at: '2026-01-01T00:00:00.000Z' }));
  assert.equal(inspectExecutionLock('plan-x', { isAlive: () => false }).stale, true);
  assert.deepEqual(releaseStaleExecutionLock('plan-x', { isAlive: () => false }), { released: true, reason: 'stale', pid: 999999 });
  assert.deepEqual(releaseStaleExecutionLock('plan-x'), { released: false, reason: 'not-held' });
  lock.release();
});

test('customer wording covers the failures the beta produces and keeps the technical detail; unknown errors are "Something unexpected happened"', () => {
  const cases = [
    [{ code: 'target-exists', message: 'x already exists' }, 'name-taken'], [{ code: 'execution-locked', message: 'busy' }, 'busy'], [{ code: 'worktree-has-changes', message: '' }, 'candidate-changed'],
    [{ code: 'verdict', message: 'reported FAILED', status: 'FAILED' }, 'failed-verification'], [{ code: 'inconclusive', message: 'nothing', status: 'INCONCLUSIVE' }, 'inconclusive'],
    [{ code: 'host-preservation', message: '' }, 'host-changed'], [{ code: 'candidate-moved', message: '' }, 'not-verified'], [{ code: 'proof-persistence', message: 'disk full' }, 'proof-not-stored'],
    [{ code: 'proof-missing', message: '' }, 'proof-missing'], [{ code: 'proof-mismatch', message: '' }, 'proof-integrity'], [{ code: 'host-mismatch', message: '' }, 'unsupported'], [{ code: 'plan-stale', message: '' }, 'stale-plan'],
    [{ code: null, message: 'The destination has uncommitted changes.' }, 'dirty-repository'], [{ code: 'not-a-git-repo', message: '' }, 'not-a-repository'], [{ code: 'weird-code', message: 'kaboom' }, 'unexpected'],
  ];
  for (const [input, kind] of cases) assert.equal(describeFailure(input).kind, kind, JSON.stringify(input));
  const d = describeFailure({ code: 'target-exists', message: 'flagged already exists in the chosen folder.' });
  assert.equal(d.technical, 'flagged already exists in the chosen folder.'); assert.equal(d.code, 'target-exists');
  assert.equal(describeFailure(null).kind, 'unexpected'); assert.equal(describeFailure('plain string').technical, 'plain string');
});

test('diagnostic bundle: collect → redact → scrub → validate → zip; secret-shaped material anywhere fails closed; nothing else than support facts and intact proofs is packaged', (t) => {
  const work = home(t);
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const e = createExecution(plan(), { destinationParent: parent, projectName: 'Flagged portal' });
  const step = beginStep(e, 'VERIFY_CAPABILITY', 'VERIFYING');
  // A failure whose message carries secret-shaped and path-shaped material, as a real verifier error could.
  const fakeKey = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
  failStep(e, step, Object.assign(new Error(`verify failed under ${work}/apps with header ${fakeKey} and token GRAFT-ABCD-EFGH-JKLM-NPQR-STUV`), { code: 'verdict' }), 'FAILED');
  saveExecution(e);
  const proof = envelopeFor({ revision: '1'.repeat(40), capability: { slug: 'hosted-authentication' } }); storeProof(proof);
  e.proof = { envelopeSchema: proof.schema, envelopeDigest: proof.digest }; saveExecution(e);
  // The licence key in the message is not redacted by the product redactor (it is not a value pattern
  // it knows), so packaging must FAIL CLOSED rather than ship it.
  assert.throws(() => packageDiagnostics(collectDiagnostics({ executionId: e.executionId, version: '0.5.0' })), (err) => err.code === 'diagnostics-unsafe' && /look like secrets/.test(err.message));
  // Without the licence-shaped value the same bundle packages, with the sk- key redacted and the path scrubbed.
  e.error.message = e.error.message.replace(' and token GRAFT-ABCD-EFGH-JKLM-NPQR-STUV', ''); e.steps[1].error = e.error.message; saveExecution(e);
  const collected = collectDiagnostics({ executionId: e.executionId, version: '0.5.0', appLog: `line1\nsaw ${fakeKey} in log\n` });
  const packaged = packageDiagnostics(collected);
  assert.deepEqual(packaged.entries, ['README.txt', 'diagnostics.json', `proofs/graft-proof-${proof.digest}.json`]);
  const zip = readZip(packaged.bytes);
  const text = Object.values(zip).map((b) => b.toString('utf8')).join('\n');
  assert.equal(text.includes(fakeKey), false, 'the sk- value is redacted'); assert.equal(text.includes(work), false, 'machine paths are scrubbed'); assert.equal(text.includes(os.homedir()), false);
  const facts = JSON.parse(zip['diagnostics.json'].toString('utf8'));
  assert.equal(facts.schema, 'graft-diagnostics/1'); assert.equal(facts.graft.version, '0.5.0'); assert.equal(facts.graft.platform.arch, os.arch());
  assert.equal(facts.execution.status, 'FAILED'); assert.equal(facts.execution.failure.kind, 'failed-verification'); assert.match(facts.execution.error.message, /\[redacted\]/); assert.match(facts.execution.error.message, /\$TMPDIR|\$GRAFT_HOME|~/);
  assert.equal(facts.execution.recovery.retry.suggestedProjectName, 'flagged-portal'); assert.deepEqual(facts.execution.steps.map((s) => [s.type, s.status]), [['CREATE_HOST', 'PENDING'], ['VERIFY_CAPABILITY', 'FAILED']].map(([a, b]) => [a, b === 'PENDING' ? 'SKIPPED' : b]));
  assert.deepEqual(facts.proofs, [{ digest: proof.digest, found: true, intact: true, reasons: [] }]);
  assert.match(facts.appLog, /\[redacted\]/);
  assert.match(zip['README.txt'].toString('utf8'), /never uploads it/);
  assert.equal(JSON.stringify(facts).includes('"env"'), false, 'no process environment');
  // The leak check itself: product patterns, secret-shaped keys, licence keys, credential shapes.
  assert.deepEqual(findDiagnosticLeaks({ a: 'fine', apiKey: 'x', jwt: 'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12) }).map((l) => l.reason.split(' ')[0]), ['secret-shaped', 'looks']);
  assert.equal(findDiagnosticLeaks({ note: 'Bearer ' + 'x'.repeat(20) }).length, 1); assert.equal(findDiagnosticLeaks({ note: 'sb_secret_' + 'x'.repeat(24) }).length, 1); assert.equal(findDiagnosticLeaks({ ok: 'nothing here', count: 3 }).length, 0);
  assert.equal(scrubPaths({ p: `${work}/x`, h: `${os.homedir()}/y` }, { home: path.join(work, 'home'), user: os.homedir(), tmp: os.tmpdir() }).p.includes(work), false);
  // Saved to a folder: named by the situation, never by a path.
  const out = path.join(work, 'out'); fs.mkdirSync(out);
  const saved = saveDiagnostics({ executionId: e.executionId, version: '0.5.0' }, out);
  assert.equal(path.basename(saved.file), diagnosticsFileName({ executionId: e.executionId })); assert.match(path.basename(saved.file), /^graft-diagnostics-exec-flagged-000000-[0-9a-f]{6}\.zip$/);
  assert.ok(fs.statSync(saved.file).size > 500); assert.equal(saved.failure.kind, 'failed-verification');
  // A workspace-only bundle (no situation) still packages the product identity and recent activity.
  const general = packageDiagnostics(collectDiagnostics({ version: '0.5.0' }));
  assert.deepEqual(general.entries, ['README.txt', 'diagnostics.json']);
});
