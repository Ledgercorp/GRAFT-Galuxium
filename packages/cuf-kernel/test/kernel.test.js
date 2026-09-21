// The vendored CUF kernel on its own: no GRAFT, no CUF application, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { VERDICTS, aggregateVerdict, evidenceRoot, captureEvidence, canonicalJson, sha256, evaluateObservationCase } from '../src/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const provenance = JSON.parse(fs.readFileSync(path.join(here, '..', 'PROVENANCE.json'), 'utf8'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const item = (kind, metadata, capturedAt = '2026-01-01T00:00:00.000Z') => captureEvidence({ kind, capturedAt, metadata });
const result = (verdict, ...evidence) => ({ testCaseId: `t-${verdict}`, expectationId: 'e', verdict, reason: verdict, evidence, setupVerified: true, cleanupVerified: true, driftDetected: false });

test('the verdict vocabulary and aggregation are CUF\'s: FAIL outranks INCONCLUSIVE outranks PASS; nothing is not PASS', () => {
  assert.deepEqual([...VERDICTS], ['PASS', 'FAIL', 'INCONCLUSIVE']);
  assert.equal(aggregateVerdict([result('PASS'), result('PASS')]), 'PASS');
  assert.equal(aggregateVerdict([result('PASS'), result('FAIL'), result('INCONCLUSIVE')]), 'FAIL');
  assert.equal(aggregateVerdict([result('INCONCLUSIVE'), result('PASS')]), 'INCONCLUSIVE');
  assert.equal(aggregateVerdict([result('INCONCLUSIVE')]), 'INCONCLUSIVE');
  assert.equal(aggregateVerdict([]), 'INCONCLUSIVE');
});

test('evidence digests are deterministic, redacted, and the proof root is order-independent and content-addressed', () => {
  const a = item('REQUEST', { test: 'flags.enabled', outcome: 'passed' });
  const b = item('RESPONSE', { test: 'flags.enabled', returned: true });
  assert.equal(a.redacted, true);
  assert.equal(a.digest, item('REQUEST', { test: 'flags.enabled', outcome: 'passed' }).digest, 'same facts, same digest');
  assert.equal(a.digest, item('REQUEST', { test: 'flags.enabled', outcome: 'passed' }, '2030-01-01T00:00:00.000Z').digest, 'capturedAt is not part of the digest');
  assert.notEqual(a.digest, item('REQUEST', { test: 'flags.enabled', outcome: 'failed' }).digest, 'a changed fact changes the digest');
  const root = evidenceRoot([result('PASS', a, b)]);
  assert.equal(root, evidenceRoot([result('PASS', b, a)]), 'order-independent');
  assert.equal(root, evidenceRoot([result('PASS', a), result('PASS', b, a)]), 'the same fact captured twice is one leaf');
  assert.notEqual(root, evidenceRoot([result('PASS', a)]), 'different evidence, different root');
  assert.equal(root, sha256(canonicalJson([a.digest, b.digest].sort())), 'the root is the sha256 of the sorted, deduplicated digests');
  assert.match(root, /^[0-9a-f]{64}$/);
});

test('the vendored modules are exactly what PROVENANCE.json records, and match the CUF source when it is present', () => {
  assert.equal(provenance.sourceCommit, 'b18f70096b3e08899ff0a25303630038ac965b76'); assert.equal(provenance.sourceBranch, 'main');
  for (const f of provenance.files) {
    const vendored = fs.readFileSync(path.join(here, '..', '..', '..', f.vendored));
    assert.equal(sha(vendored), f.vendoredSha256, `${f.vendored} drifted from its recorded identity`);
    // The only permitted difference from CUF's compiled output is the documented specifier rewrite.
    const restored = vendored.toString('utf8').split(provenance.transformation.to).join(provenance.transformation.from);
    assert.equal(sha(restored), f.compiledSha256, `${f.vendored} differs from CUF's compiled output by more than the recorded rewrite`);
    assert.equal(f.transformed, restored !== vendored.toString('utf8'));
  }
  const cuf = path.join(os.homedir(), 'Developer', 'CUF');
  if (!fs.existsSync(path.join(cuf, '.git'))) return;
  for (const f of provenance.files) {
    const blob = execFileSync('git', ['rev-parse', `${provenance.sourceCommit}:${f.sourcePath}`], { cwd: cuf, encoding: 'utf8' }).trim();
    assert.equal(blob, f.sourceBlob, `${f.sourcePath} at ${provenance.sourceCommit.slice(0, 7)} is not the recorded source`);
    const dist = path.join(cuf, f.compiledFrom);
    if (fs.existsSync(dist)) assert.equal(sha(fs.readFileSync(dist)), f.compiledSha256, `${f.compiledFrom} no longer matches the vendored copy`);
  }
});

test('the observation evaluator, in neutral terms: satisfied PASS, contradicted FAIL, unavailable / error / malformed / missing-evidence INCONCLUSIVE', () => {
  const ev = (id, value) => [item('INVOCATION', { observation: id, operation: 'op' }), item('RESULT', { observation: id, value })];
  const kase = (expectations) => ({ id: 'c', expectationId: 'e', expectations, requiredEvidenceKinds: ['INVOCATION', 'RESULT'] });
  const run = (observations, extra = {}) => ({ observations, operationalError: null, evidence: observations.flatMap((o) => ev(o.id, o.value)), ...extra });
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }]), run([{ id: 'a', value: 1, selected: null }])).verdict, 'PASS');
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }]), run([{ id: 'a', value: 2, selected: null }])).verdict, 'FAIL');
  assert.equal(evaluateObservationCase(kase([{ kind: 'selection', observation: 'a', equals: 'left' }]), run([{ id: 'a', value: null, selected: 'right' }])).verdict, 'FAIL');
  assert.equal(evaluateObservationCase(kase([{ kind: 'consistent', observation: 'b', with: 'a' }]), run([{ id: 'a', value: 1, selected: null }, { id: 'b', value: 1, selected: null }])).verdict, 'PASS');
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }]), run([])).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }]), run([], { operationalError: 'it threw' })).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }]), { observations: null, operationalError: null, evidence: [] }).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }]), run([{ id: 'a', value: 1, selected: null }], { evidence: [] })).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateObservationCase(kase([]), run([{ id: 'a', value: 1, selected: null }])).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateObservationCase(kase([{ kind: 'value', observation: 'a', equals: 1 }, { kind: 'value', observation: 'b', equals: 1 }]), run([{ id: 'a', value: 0, selected: null }], { operationalError: 'threw later' })).verdict, 'FAIL', 'a contradiction outranks later uncertainty');
});
