import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { verifyCapability, decideVerdict, VERIFIED, FAILED, NEEDS_REVIEW } from '../src/verify/index.js';
import { SOURCE_FIXTURE, makeDestination } from './helpers.js';

const manifest = harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');

/** Applies the transplant into a fresh destination, then lets a mutator sabotage it. */
async function transplantThenVerify(mutate = null) {
  const dest = makeDestination();
  try {
    const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true });
    const applied = applyTransplant(plan, dest.root);
    assert.equal(applied.applied, true, 'setup: transplant must apply');
    if (mutate) mutate(dest.root);
    return await verifyCapability(manifest, dest.root, { entrypoint: plan.destination.entrypoint });
  } finally { dest.cleanup(); }
}

function patch(root, file, from, to) {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `mutation target not found in ${file}: ${from}`);
  fs.writeFileSync(p, src.replace(from, to), 'utf8');
}

// ---------------------------------------------------------------- the verdict engine

test('the verdict engine returns NEEDS_REVIEW when the application never started', () => {
  const d = decideVerdict([], { serverReady: false, reason: 'timeout-waiting-for-listen' });
  assert.equal(d.verdict, NEEDS_REVIEW);
});

test('the verdict engine returns NEEDS_REVIEW when there is nothing to prove', () => {
  assert.equal(decideVerdict([]).verdict, NEEDS_REVIEW);
  assert.equal(decideVerdict([{ id: 'x', required: false, outcome: 'passed' }]).verdict, NEEDS_REVIEW);
});

test('the verdict engine returns NEEDS_REVIEW when evidence is missing, not a pass', () => {
  const d = decideVerdict([
    { id: 'a', required: true, outcome: 'passed' },
    { id: 'b', required: true, outcome: 'inconclusive' },
  ]);
  assert.equal(d.verdict, NEEDS_REVIEW);
  assert.match(d.rationale, /no usable evidence/);
});

test('one failed required test is enough to fail the whole transplant', () => {
  const d = decideVerdict([
    { id: 'a', required: true, outcome: 'passed' },
    { id: 'b', required: true, outcome: 'failed' },
  ]);
  assert.equal(d.verdict, FAILED);
});

test('an optional failure does not fail a transplant whose required tests all passed', () => {
  const d = decideVerdict([
    { id: 'a', required: true, outcome: 'passed' },
    { id: 'b', required: false, outcome: 'failed' },
  ]);
  assert.equal(d.verdict, VERIFIED);
});

// ---------------------------------------------------------------- against a real server

test('an unmutated transplant verifies against the running application', async () => {
  const report = await transplantThenVerify();
  assert.equal(report.verdict, VERIFIED, report.rationale + ' ' + JSON.stringify(report.results.filter((r) => r.outcome !== 'passed'), null, 1));
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passed, report.summary.required);
  for (const b of report.behaviorCoverage) {
    assert.ok(b.provenBy.length > 0, `behavior ${b.id} was proven by nothing`);
  }
});

test('FAILED: a password check that accepts any password is caught', async () => {
  const report = await transplantThenVerify((root) => {
    patch(root, 'src/auth/passwords.js', 'export function verifyPassword(password, salt, expectedHash) {',
      'export function verifyPassword(password, salt, expectedHash) {\n  return true;');
  });
  assert.equal(report.verdict, FAILED);
  assert.ok(report.results.some((r) => r.id === 'auth.login.rejects-invalid-credentials' && r.outcome === 'failed'));
});

test('FAILED: a guard that lets anonymous requests through is caught', async () => {
  const report = await transplantThenVerify((root) => {
    patch(root, 'src/auth/guard.js', "if (!session) return", "if (false) return");
  });
  assert.equal(report.verdict, FAILED);
  assert.ok(report.results.some((r) => r.id === 'auth.protect.rejects-anonymous' && r.outcome === 'failed'));
});

test('FAILED: a session that does not persist is caught', async () => {
  const report = await transplantThenVerify((root) => {
    patch(root, 'src/auth/sessions.js', 'export function getSession(id) {', 'export function getSession(id) {\n  return null;');
  });
  assert.equal(report.verdict, FAILED);
  assert.ok(report.results.some((r) => r.id === 'auth.session.persists-across-requests' && r.outcome === 'failed'));
});

test('FAILED: logout that does not end the session is caught', async () => {
  const report = await transplantThenVerify((root) => {
    patch(root, 'src/auth/sessions.js', 'export function destroySession(id) { sessions.remove(id); }',
      'export function destroySession(id) { /* leaked */ }');
  });
  assert.equal(report.verdict, FAILED);
  assert.ok(report.results.some((r) => r.id === 'auth.logout.ends-session' && r.outcome === 'failed'));
});

test('FAILED: renaming the session cookie breaks the preserved contract', async () => {
  const report = await transplantThenVerify((root) => {
    patch(root, 'src/auth/sessions.js', 'export const COOKIE_NAME = "', 'export const COOKIE_NAME = "x_');
  });
  assert.equal(report.verdict, FAILED);
});

test('NEEDS_REVIEW: an application that cannot start yields no verdict at all', async () => {
  const report = await transplantThenVerify((root) => {
    patch(root, 'src/auth/routes.js', "import crypto from 'node:crypto';", "import crypto from 'node:crypto';\nthrow new Error('boom');");
  });
  assert.equal(report.verdict, NEEDS_REVIEW);
  assert.equal(report.summary.required, 0);
  assert.match(report.diagnostics.stderr || '', /boom/);
});
