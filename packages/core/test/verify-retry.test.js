import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAcceptanceSuite, classifyAttempt, MAX_VERIFICATION_ATTEMPTS, NEEDS_REVIEW, VERIFIED, FAILED } from '../src/verify/index.js';

// An application whose behaviour depends on how many times it has been booted (a counter file
// in its own folder): the first N boots stall in one of two ways, later boots behave. This is
// exactly the shape of a machine stall — nothing wrong with the code, the process just did not
// answer in time — and it lets the retry policy be exercised deterministically.
function stallingApp(t, { stallBoots = 1, mode = 'never-listen', answer = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'boots.txt'), '0');
  fs.writeFileSync(path.join(dir, 'server.mjs'), `import { createServer } from 'node:http';
import fs from 'node:fs';
const boots = Number(fs.readFileSync(new URL('./boots.txt', import.meta.url), 'utf8')) + 1;
fs.writeFileSync(new URL('./boots.txt', import.meta.url), String(boots));
const stalled = boots <= ${stallBoots};
if (stalled && ${JSON.stringify(mode)} === 'never-listen') { setInterval(() => {}, 1000); }
else createServer((req, res) => {
  if (stalled && ${JSON.stringify(mode)} === 'never-answer') return; // accept, never respond
  res.writeHead(${answer}, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, boots }));
}).listen(Number(process.env.PORT));
`);
  return dir;
}
const runtimeFor = (dir) => ({ ok: true, profile: 'node-entrypoint', entrypoint: 'server.mjs', command: [process.execPath, 'server.mjs'], cwd: dir, env: {}, readiness: 'tcp-connect' });
const TESTS = [
  { id: 'app.answers', kind: 'http', required: true, provesBehavior: 'app.answers', description: 'the app answers', steps: [{ name: 'root', method: 'GET', path: '/', expect: { status: [200] } }] },
  { id: 'app.answers-again', kind: 'http', required: true, provesBehavior: 'app.answers', description: 'still answers', steps: [{ name: 'root', method: 'GET', path: '/', expect: { status: [200] } }] },
];
const boots = (dir) => Number(fs.readFileSync(path.join(dir, 'boots.txt'), 'utf8'));

test('a first attempt that never listens is INCONCLUSIVE, one fresh process is tried, and its evidence alone verifies', async (t) => {
  const dir = stallingApp(t, { stallBoots: 1, mode: 'never-listen' });
  const events = [];
  const report = await runAcceptanceSuite({ runtime: runtimeFor(dir), tests: TESTS, timeoutMs: 1500, stepTimeoutMs: 1500, onProgress: (e) => events.push(e.stage) });
  assert.equal(report.verdict, VERIFIED);
  assert.equal(report.summary.passed, 2);
  assert.equal(report.attempts.length, 2);
  assert.deepEqual(report.attempts.map((a) => [a.attempt, a.verdict, a.classification]), [[1, NEEDS_REVIEW, 'transport-timeout'], [2, VERIFIED, 'verified']]);
  assert.equal(report.attempts[0].detail, 'timeout-waiting-for-listen');
  assert.equal(report.attempts[0].process?.aliveAfterStop ?? false, false, 'the first process tree was terminated before the retry');
  assert.deepEqual(report.retried, { count: 1, firstClassification: 'transport-timeout' });
  assert.equal(boots(dir), 2, 'exactly one fresh process was started for the retry');
  assert.ok(events.includes('retry'));
  // The verdict is attempt 2's own evidence: every result in the final report comes from the process that answered.
  assert.ok(report.results.every((r) => r.outcome === 'passed' && r.steps.every((s) => s.status === 200)));
});

test('a first attempt whose steps time out is retried once; a second stall stays INCONCLUSIVE', async (t) => {
  const once = stallingApp(t, { stallBoots: 1, mode: 'never-answer' });
  const recovered = await runAcceptanceSuite({ runtime: runtimeFor(once), tests: TESTS, timeoutMs: 3000, stepTimeoutMs: 700 });
  assert.equal(recovered.verdict, VERIFIED);
  assert.equal(recovered.attempts[0].classification, 'transport-timeout');
  assert.match(recovered.attempts[0].detail, /step timeout/);
  assert.equal(recovered.attempts[0].summary.inconclusive, 2, 'every step on the stalled process timed out; none failed');
  const twice = stallingApp(t, { stallBoots: 2, mode: 'never-listen' });
  const still = await runAcceptanceSuite({ runtime: runtimeFor(twice), tests: TESTS, timeoutMs: 1200, stepTimeoutMs: 1000 });
  assert.equal(still.verdict, NEEDS_REVIEW, 'a second timeout never becomes a pass');
  assert.equal(still.attempts.length, MAX_VERIFICATION_ATTEMPTS);
  assert.deepEqual(still.attempts.map((a) => a.classification), ['transport-timeout', 'transport-timeout']);
  assert.equal(boots(twice), 2, 'never more than two processes');
  assert.equal(still.results.length, 0);
});

test('a failed assertion is authoritative: no retry, whatever else timed out', async (t) => {
  const wrong = stallingApp(t, { stallBoots: 0, answer: 500 });
  const failed = await runAcceptanceSuite({ runtime: runtimeFor(wrong), tests: TESTS, timeoutMs: 1500, stepTimeoutMs: 1500 });
  assert.equal(failed.verdict, FAILED);
  assert.equal(failed.attempts.length, 1);
  assert.equal(failed.attempts[0].classification, 'failed');
  assert.equal(failed.retried, undefined);
  assert.equal(boots(wrong), 1);
  // A security-style witness that failed alongside a timeout is still not retried.
  const mixed = { verdict: NEEDS_REVIEW, results: [
    { id: 'sec.no-secret', outcome: 'failed', required: true, reason: 'secret appeared in output' },
    { id: 'x', outcome: 'inconclusive', required: true, reason: 'transport error on step "a": The operation was aborted due to timeout' }] };
  assert.deepEqual(classifyAttempt(mixed), { retryable: false, classification: 'failed-assertion' });
  // Inconclusive for a reason other than a timeout is not a stall either.
  assert.equal(classifyAttempt({ verdict: NEEDS_REVIEW, results: [{ id: 'x', outcome: 'inconclusive', required: true, reason: 'transport error on step "a": fetch failed' }] }).retryable, false);
  assert.equal(classifyAttempt({ verdict: NEEDS_REVIEW, results: [], diagnostics: { reason: 'process-exited-before-ready' } }).retryable, false, 'a crash is evidence, not a stall');
  assert.equal(classifyAttempt({ verdict: NEEDS_REVIEW, results: [], diagnostics: { reason: 'invalid-acceptance-tests' } }).retryable, false, 'a malformed contract is never retried');
  assert.equal(classifyAttempt({ verdict: VERIFIED, results: [] }).retryable, false);
  assert.equal(classifyAttempt({ verdict: FAILED, results: [] }).retryable, false);
});
