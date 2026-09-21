// Proof Integrity 0.1, Checkpoint A — the envelope alone: determinism, integrity verification,
// tampering, misbinding, schema, and the informational/authoritative split. No runner, no server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProofEnvelope, verifyProofEnvelope, evidenceManifest, manifestDigest, proofRootOfManifest, proofKernelIdentity, PROOF_ENVELOPE_SCHEMA, decideLibrarySuite } from '../src/index.js';
import { canonicalJson, sha256, captureEvidence } from '../../cuf-kernel/src/index.js';

const HEX = /^[0-9a-f]{64}$/;
const step = (name, call, args, expect) => ({ name, call, args, expect });
const T = (id, steps, required = true) => ({ id, kind: 'library', required, steps });
const tests = [T('a', [step('on', 'isEnabled', ['x'], { equals: true })]), T('b', [step('off', 'isEnabled', ['y'], { equals: false })])];
const runs = (bOff = false) => [
  { id: 'a', observations: [{ step: 'on', call: 'isEnabled', args: ['x'], returned: true, branch: null }], operationalError: null },
  { id: 'b', observations: [{ step: 'off', call: 'isEnabled', args: ['y'], returned: bOff, branch: null }], operationalError: null },
];
/** A decided report of the shape the library runner produces, from the real adapter decision. */
function decidedReport({ bOff = false, loaded = true } = {}) {
  const d = decideLibrarySuite({ tests, runs: runs(bOff), loaded });
  return { verdict: d.verdict, proofRoot: d.proofRoot, proofEvidence: d.evidence, proofAuthority: { ...d.authority, cufVerdict: d.cufVerdict }, results: d.cases.map((c) => ({ id: c.id, kind: 'library', required: true, outcome: c.outcome })), finishedAt: '2026-09-13T10:00:00.000Z' };
}
const identity = (over = {}) => ({
  capability: { id: 'sha256:' + 'a'.repeat(64), slug: 'flags', kind: 'feature-flags', form: 'library', genomeId: 'sha256:' + 'b'.repeat(64), irId: 'sha256:' + 'c'.repeat(64) },
  contract: { id: 'sha256:' + 'd'.repeat(64), version: '1.0.0' },
  source: { revision: '1'.repeat(40) },
  destination: { revision: '2'.repeat(40), hostProfile: 'esm-node-http-central' },
  verifier: { core: '0.5.0' },
  ...over,
});
const build = (report = decidedReport(), over = {}) => buildProofEnvelope({ report, ...identity(over), createdAt: '2026-09-13T10:00:01.000Z' });
/** A structurally identical copy with one payload field replaced (path like 'verdict.graft'). */
function withPayload(envelope, path, value) {
  const copy = JSON.parse(JSON.stringify(envelope));
  const keys = path.split('.'); let node = copy.payload;
  for (const k of keys.slice(0, -1)) node = node[k];
  node[keys.at(-1)] = value;
  return copy;
}

test('a decided report yields a v1 envelope whose digest is the sha256 of the canonical payload, and it verifies intact', () => {
  const { envelope, reason } = build();
  assert.equal(reason, null);
  assert.equal(envelope.schema, PROOF_ENVELOPE_SCHEMA); assert.equal(envelope.payload.schema, PROOF_ENVELOPE_SCHEMA);
  assert.equal(envelope.digest, sha256(canonicalJson(envelope.payload)));
  assert.deepEqual(Object.keys(envelope.payload).sort(), ['capability', 'cases', 'contract', 'createdBy', 'destination', 'evidence', 'proofAuthority', 'proofRoot', 'schema', 'source', 'verdict', 'verifier']);
  assert.deepEqual(envelope.payload.verdict, { graft: 'VERIFIED', kernel: 'PASS' });
  assert.deepEqual(envelope.payload.capability, identity().capability);
  assert.equal(envelope.payload.contract.id, identity().contract.id); assert.equal(envelope.payload.contract.version, '1.0.0'); assert.match(envelope.payload.contract.casesDigest, HEX);
  assert.deepEqual(envelope.payload.source, { revision: '1'.repeat(40) });
  assert.deepEqual(envelope.payload.destination, { revision: '2'.repeat(40), hostProfile: 'esm-node-http-central', adaptation: null });
  assert.deepEqual(envelope.payload.verifier, { core: '0.5.0', proofAdapter: '0.1.0', kernel: proofKernelIdentity() });
  assert.match(envelope.payload.verifier.kernel.sourceCommit, /^[0-9a-f]{40}$/); assert.match(envelope.payload.verifier.kernel.vendoredSha256, HEX);
  assert.deepEqual(envelope.payload.cases, [{ id: 'a', outcome: 'passed' }, { id: 'b', outcome: 'passed' }]);
  assert.equal(envelope.payload.evidence.count, envelope.evidenceManifest.length); assert.equal(envelope.payload.evidence.count, 4);
  assert.equal(envelope.payload.evidence.manifestDigest, manifestDigest(envelope.evidenceManifest));
  assert.equal(envelope.payload.proofRoot, proofRootOfManifest(envelope.evidenceManifest), 'the proof root re-derives from the manifest with sha256 + canonicalJson alone');
  assert.deepEqual(envelope.payload.proofAuthority, { perCase: 'cuf-kernel', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel' });
  assert.equal(envelope.payload.createdBy, 'graft');
  assert.deepEqual(envelope.informational, { createdAt: '2026-09-13T10:00:01.000Z' });
  assert.ok(!('createdAt' in envelope.payload), 'createdAt is informational: outside the authoritative payload');
  assert.deepEqual(verifyProofEnvelope(envelope), { intact: true, reasons: [] });
  assert.ok(Object.isFrozen(envelope) && Object.isFrozen(envelope.payload) && Object.isFrozen(envelope.evidenceManifest));
});

test('determinism: the same proof facts give the same digest regardless of time, evidence order and case order', () => {
  const one = build().envelope;
  const later = buildProofEnvelope({ report: { ...decidedReport(), finishedAt: 'other' }, ...identity(), createdAt: '2030-01-01T00:00:00.000Z' }).envelope;
  assert.equal(later.digest, one.digest);
  const r = decidedReport();
  const shuffled = { ...r, proofEvidence: [...r.proofEvidence].reverse(), results: [...r.results].reverse() };
  assert.equal(buildProofEnvelope({ report: shuffled, ...identity() }).envelope.digest, one.digest);
  const duplicated = { ...r, proofEvidence: [...r.proofEvidence, ...r.proofEvidence] };
  assert.equal(buildProofEnvelope({ report: duplicated, ...identity() }).envelope.digest, one.digest, 'the same fact captured twice is one fact');
});

test('FAILED and NEEDS_REVIEW reports get envelopes too; a report without a proof root gets none', () => {
  const failed = build(decidedReport({ bOff: true }));
  assert.deepEqual(failed.envelope.payload.verdict, { graft: 'FAILED', kernel: 'FAIL' });
  assert.deepEqual(failed.envelope.payload.cases, [{ id: 'a', outcome: 'passed' }, { id: 'b', outcome: 'failed' }]);
  assert.equal(verifyProofEnvelope(failed.envelope).intact, true);
  const review = build(decidedReport({ loaded: false }));
  assert.deepEqual(review.envelope.payload.verdict, { graft: 'NEEDS_REVIEW', kernel: 'INCONCLUSIVE' });
  assert.equal(review.envelope.payload.evidence.count, 0);
  assert.equal(verifyProofEnvelope(review.envelope).intact, true);
  assert.notEqual(failed.envelope.digest, build().envelope.digest); assert.notEqual(review.envelope.digest, build().envelope.digest);
  const none = buildProofEnvelope({ report: { ...decidedReport(), proofRoot: null, proofEvidence: null }, ...identity() });
  assert.deepEqual(none, { envelope: null, reason: 'proof-unavailable', detail: 'the report has no proof root' });
  const noEvidence = buildProofEnvelope({ report: { ...decidedReport(), proofEvidence: undefined }, ...identity() });
  assert.equal(noEvidence.reason, 'proof-evidence-unavailable');
  const mismatch = buildProofEnvelope({ report: { ...decidedReport(), proofRoot: 'e'.repeat(64) }, ...identity() });
  assert.equal(mismatch.reason, 'proof-evidence-mismatch', 'a root the evidence does not re-derive to is not bound');
});

test('a destination claim without a committed revision is refused, not fabricated; a source-only envelope has destination null', () => {
  const noRevision = build(decidedReport(), { destination: { revision: null, hostProfile: 'esm-node-http-central' } });
  assert.equal(noRevision.envelope, null); assert.equal(noRevision.reason, 'claim-incomplete');
  const sourceOnly = build(decidedReport(), { destination: null, source: { revision: null } });
  assert.equal(sourceOnly.envelope.payload.destination, null); assert.equal(sourceOnly.envelope.payload.source.revision, null);
  assert.equal(verifyProofEnvelope(sourceOnly.envelope).intact, true);
  assert.notEqual(sourceOnly.envelope.digest, build().envelope.digest);
});

test('tamper matrix: every authoritative binding, changed alone, breaks integrity; the informational timestamp does not', () => {
  const { envelope } = build();
  const matrix = [
    ['verdict.graft', 'FAILED'], ['verdict.kernel', 'FAIL'],
    ['capability.id', 'sha256:' + 'f'.repeat(64)], ['capability.kind', 'other-kind'], ['capability.form', 'service'], ['capability.slug', 'other'], ['capability.genomeId', null], ['capability.irId', null],
    ['contract.id', 'sha256:' + '9'.repeat(64)], ['contract.version', '2.0.0'], ['contract.casesDigest', '8'.repeat(64)],
    ['source.revision', '3'.repeat(40)], ['destination.revision', '4'.repeat(40)], ['destination.hostProfile', 'express-req-res'],
    ['verifier.core', '0.6.0'], ['verifier.proofAdapter', '0.2.0'], ['verifier.kernel.sourceCommit', '5'.repeat(40)], ['verifier.kernel.vendoredSha256', '6'.repeat(64)],
    ['proofRoot', '7'.repeat(64)], ['evidence.manifestDigest', '1'.repeat(64)], ['evidence.count', 3],
    ['cases', [{ id: 'a', outcome: 'passed' }, { id: 'b', outcome: 'failed' }]], ['proofAuthority.perCase', 'graft'], ['createdBy', 'someone'], ['schema', 'graft-proof-envelope/2'],
  ];
  for (const [path, value] of matrix) {
    const v = verifyProofEnvelope(withPayload(envelope, path, value));
    assert.equal(v.intact, false, `${path} changed → not intact`);
    assert.ok(v.reasons.includes('payload does not re-derive to the digest'), `${path}: ${v.reasons.join('; ')}`);
  }
  // Informational: changing createdAt leaves integrity intact. It is not an authenticated claim in Model A.
  const dated = JSON.parse(JSON.stringify(envelope)); dated.informational.createdAt = '1999-01-01T00:00:00.000Z';
  assert.deepEqual(verifyProofEnvelope(dated), { intact: true, reasons: [] });
  // A re-digested tamper is still caught by the manifest and root cross-checks when the manifest is carried.
  const rerooted = withPayload(envelope, 'proofRoot', '7'.repeat(64)); rerooted.digest = sha256(canonicalJson(rerooted.payload));
  const v = verifyProofEnvelope(rerooted);
  assert.equal(v.intact, false); assert.deepEqual(v.reasons, ['proof root does not re-derive from the manifest']);
  // An edited evidence manifest is detected against the payload.
  const edited = JSON.parse(JSON.stringify(envelope)); edited.evidenceManifest.pop();
  assert.deepEqual(verifyProofEnvelope(edited).reasons, ['evidence count does not match the manifest', 'evidence manifest digest does not match the manifest', 'proof root does not re-derive from the manifest']);
  // Verification never mutates its input.
  const before = JSON.stringify(envelope); verifyProofEnvelope(envelope); assert.equal(JSON.stringify(envelope), before);
});

test('misbinding: a valid proof root cannot be moved to another capability or another revision without a different digest, and the original does not verify as either', () => {
  const a = build().envelope;
  const asB = buildProofEnvelope({ report: decidedReport(), ...identity({ capability: { ...identity().capability, id: 'sha256:' + 'e'.repeat(64), slug: 'other-capability' } }) }).envelope;
  assert.equal(asB.payload.proofRoot, a.payload.proofRoot, 'same evidence, same root');
  assert.notEqual(asB.digest, a.digest, 'different capability, different proof');
  const forgedB = withPayload(a, 'capability.slug', 'other-capability'); const alsoId = withPayload(forgedB, 'capability.id', 'sha256:' + 'e'.repeat(64));
  assert.equal(verifyProofEnvelope(alsoId).intact, false, 'A\'s envelope relabelled as B does not verify');
  const atR2 = buildProofEnvelope({ report: decidedReport(), ...identity({ destination: { revision: '9'.repeat(40), hostProfile: 'esm-node-http-central' } }) }).envelope;
  assert.equal(atR2.payload.proofRoot, a.payload.proofRoot); assert.notEqual(atR2.digest, a.digest, 'same capability at another revision is another proof');
  assert.equal(verifyProofEnvelope(withPayload(a, 'destination.revision', '9'.repeat(40))).intact, false);
  // Another application (host profile) for the same code is another proof too.
  const otherHost = buildProofEnvelope({ report: decidedReport(), ...identity({ destination: { revision: '2'.repeat(40), hostProfile: 'express-req-res' } }) }).envelope;
  assert.notEqual(otherHost.digest, a.digest);
});

test('schema and structure: v1 only, required bindings present, deterministic reasons, no verdict is ever derived', () => {
  assert.deepEqual(verifyProofEnvelope(null), { intact: false, reasons: ['envelope is not an object'] });
  assert.deepEqual(verifyProofEnvelope({ schema: 'graft-proof-envelope/2' }), { intact: false, reasons: ['unsupported schema "graft-proof-envelope/2"', 'payload is missing'] });
  const { envelope } = build();
  const stripped = JSON.parse(JSON.stringify(envelope)); delete stripped.payload.destination.revision; stripped.digest = sha256(canonicalJson(stripped.payload));
  assert.deepEqual(verifyProofEnvelope(stripped).reasons, ['destination binding is incomplete']);
  const badVerdict = withPayload(envelope, 'verdict.graft', 'PASSED'); badVerdict.digest = sha256(canonicalJson(badVerdict.payload));
  assert.deepEqual(verifyProofEnvelope(badVerdict).reasons, ['verdict binding is incomplete']);
  // An envelope whose verdict pair is inconsistent with the mapping is still "intact" if unmodified:
  // integrity says nothing about the verdict, and verify derives neither verdict from the other.
  const odd = buildProofEnvelope({ report: { ...decidedReport(), verdict: 'FAILED' }, ...identity() }).envelope;
  assert.deepEqual(odd.payload.verdict, { graft: 'FAILED', kernel: 'PASS' });
  const v = verifyProofEnvelope(odd);
  assert.equal(v.intact, true); assert.ok(!('verdict' in v), 'verify answers intact?, never a verdict');
  // A manifest carried without the envelope is verifiable on its own primitives.
  const items = [captureEvidence({ kind: 'RESULT', capturedAt: '1970-01-01T00:00:00.000Z', metadata: { observation: 'x', value: 1 } }), captureEvidence({ kind: 'INVOCATION', capturedAt: '2000-01-01T00:00:00.000Z', metadata: { observation: 'x', operation: 'f' } })];
  const m = evidenceManifest([items[1], items[0], items[0]]);
  assert.equal(m.length, 2); assert.deepEqual(m.map((e) => Object.keys(e)), [['kind', 'digest'], ['kind', 'digest']]);
  assert.equal(m[0].digest < m[1].digest, true, 'sorted by digest');
});
