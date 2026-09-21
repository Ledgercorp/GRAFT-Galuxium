// CUF Kernel Integration 0.1 — Checkpoint C: the HTTP acceptance family's aggregate verdict and proof
// root come from the proof kernel; the per-case outcomes are still GRAFT's HTTP runner's.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { verifySource, decideHttpVerdict, decideVerdict } from '../src/verify/index.js';
import { hostedSource } from './helpers/hosted-source.js';

const http = (id, outcome, steps = [{ name: 'login', request: 'GET /auth/login', status: 302, checks: [{ name: 'status', ok: outcome !== 'failed' }], ok: outcome !== 'failed' }]) => ({ id, required: true, outcome, reason: outcome === 'passed' ? null : `${outcome} in fixture`, steps });

test('the real hosted-session-auth source verification: VERIFIED 13/13 as before, aggregate PASS from the kernel, proof root deterministic across two runs', async () => {
  const src = hostedSource(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-cuf-http-')));
  const fp = fingerprintProject(src);
  const { manifest } = await harvestCapability(fp, 'hosted-authentication');
  const report = await verifySource(fp, manifest);
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(report.summary.passed, 13); assert.equal(report.summary.required, 13);
  assert.match(report.proofRoot, /^[0-9a-f]{64}$/);
  assert.deepEqual(report.proofAuthority, { perCase: 'graft-http-runner', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel', execution: 'graft-http-runner', providerDouble: 'graft-http-runner', retries: 'graft-http-runner', cufVerdict: 'PASS', cases: 13, evidenceItems: report.proofAuthority.evidenceItems });
  assert.ok(report.proofAuthority.evidenceItems > 20);
  assert.equal(decideVerdict(report.results, { serverReady: true }).verdict, 'VERIFIED', 'the native engine agrees on the same per-case outcomes');
  const again = await verifySource(fp, manifest);
  assert.equal(again.proofRoot, report.proofRoot, 'same exchanges, same statuses, same checks → same proof');
});

test('the HTTP decision is fail-closed and worded as before: not ready, uncertain, contradicted, undecidable', () => {
  const notReady = decideHttpVerdict([], { serverReady: false, reason: 'process-exited-before-ready' });
  assert.equal(notReady.verdict, 'NEEDS_REVIEW'); assert.equal(notReady.proofAuthority.cufVerdict, 'INCONCLUSIVE');
  assert.equal(notReady.rationale, 'The destination application did not become ready, so no behavior could be observed (process-exited-before-ready).');
  const uncertain = decideHttpVerdict([http('a', 'passed'), http('b', 'inconclusive')]);
  assert.equal(uncertain.verdict, 'NEEDS_REVIEW'); assert.equal(uncertain.rationale, '1 required acceptance test(s) produced no usable evidence: b.');
  const contradicted = decideHttpVerdict([http('a', 'failed'), http('b', 'inconclusive')]);
  assert.equal(contradicted.verdict, 'FAILED'); assert.equal(contradicted.rationale, '1 of 2 required acceptance test(s) failed: a.');
  for (const [results, options] of [[[http('a', 'passed'), http('b', 'inconclusive')], {}], [[http('a', 'failed')], {}], [[], { serverReady: false, reason: 'x' }], [[http('a', 'passed')], {}]]) {
    assert.equal(decideHttpVerdict(results, options).rationale, decideVerdict(results, options).rationale);
  }
  const undecidable = decideHttpVerdict([http('a', 'passed', [{ name: 's', request: 'GET /x?k=sbp_' + 'a'.repeat(40), status: 200, checks: [], ok: true }])]);
  assert.equal(undecidable.verdict, 'NEEDS_REVIEW'); assert.equal(undecidable.proofRoot, null);
  assert.match(undecidable.rationale, /The proof could not be decided, so no verdict could be established \(Credential material detected/);
  assert.equal(decideVerdict([http('a', 'passed')]).verdict, 'VERIFIED', 'the native engine would have said VERIFIED for that same outcome');
});
