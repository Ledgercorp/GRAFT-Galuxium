// Proof Integrity 0.1, Checkpoint C — the portable file verifier: integrity and claim apart, a
// tamper matrix on copies, the recomputed-digest attack, and what Model A cannot catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProofEnvelope, verifyProofFile, verifyProofArtifact, proofClaim, decideHttpSuite, manifestDigest, proofRootOfManifest } from '../src/index.js';
import { canonicalJson, sha256 } from '../../cuf-kernel/src/index.js';

const R = '1'.repeat(40);
const result = (id, outcome = 'passed') => ({ id, required: true, outcome, steps: [{ name: 'probe', request: 'GET /x', status: outcome === 'failed' ? 500 : 200, checks: [{ name: 'status', ok: outcome !== 'failed' }] }] });
function envelope(outcomes = ['passed', 'passed']) {
  const results = outcomes.map((o, i) => result(`case-${i}`, o));
  const d = decideHttpSuite({ results });
  const report = { verdict: d.verdict, proofRoot: d.proofRoot, proofEvidence: d.evidence, proofAuthority: { ...d.authority, cufVerdict: d.cufVerdict }, results: results.map((r) => ({ id: r.id, kind: 'http', required: true, outcome: r.outcome })) };
  return buildProofEnvelope({ report, capability: { id: 'sha256:' + 'a'.repeat(64), slug: 'hosted-authentication', kind: 'hosted-session-auth', form: 'service', genomeId: 'sha256:' + 'b'.repeat(64), irId: null }, contract: { id: 'sha256:' + 'c'.repeat(64), version: '1.0.0' }, source: { revision: '2'.repeat(40) }, destination: { revision: R, hostProfile: 'esm-node-http-central' }, verifier: { core: '0.5.0' }, createdAt: '2026-09-13T13:00:00.000Z' }).envelope;
}
const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-proof-file-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const write = (dir, name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return file; };
const mutated = (e, edit) => { const copy = JSON.parse(JSON.stringify(e)); edit(copy); return copy; };

test('a proof file verifies from disk alone: integrity intact and the claim reported separately, verbatim from the payload', (t) => {
  const dir = tmp(t);
  const e = envelope();
  const file = write(dir, 'graft-proof.json', e);
  const r = verifyProofFile(file);
  assert.equal(r.found, true); assert.equal(r.intact, true); assert.deepEqual(r.reasons, []); assert.equal(r.digest, e.digest); assert.equal(r.schema, 'graft-proof-envelope/1');
  assert.equal(r.claim.capability.slug, 'hosted-authentication'); assert.equal(r.claim.capability.id, 'sha256:' + 'a'.repeat(64));
  assert.equal(r.claim.destinationRevision, R); assert.equal(r.claim.sourceRevision, '2'.repeat(40)); assert.equal(r.claim.hostProfile, 'esm-node-http-central');
  assert.deepEqual([r.claim.graftVerdict, r.claim.kernelVerdict], ['VERIFIED', 'PASS']);
  assert.equal(r.claim.proofRoot, e.payload.proofRoot); assert.equal(r.claim.verifier.core, '0.5.0'); assert.match(r.claim.verifier.kernel.sourceCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(r.claim.cases, [{ id: 'case-0', outcome: 'passed' }, { id: 'case-1', outcome: 'passed' }]);
  assert.equal(r.claim.createdAt, '2026-09-13T13:00:00.000Z');
  assert.ok(!('verdict' in r) && !('verified' in r) && !('valid' in r), 'the result has no verdict field: integrity is not verification');
  assert.deepEqual(proofClaim(e), r.claim);
});

test('claim vs integrity: intact proofs of FAILED and NEEDS_REVIEW are intact; a tampered VERIFIED proof is not, whatever it claims', (t) => {
  const dir = tmp(t);
  const failed = verifyProofFile(write(dir, 'failed.json', envelope(['passed', 'failed'])));
  assert.equal(failed.intact, true); assert.deepEqual([failed.claim.graftVerdict, failed.claim.kernelVerdict], ['FAILED', 'FAIL']);
  const review = verifyProofFile(write(dir, 'review.json', envelope(['passed', 'inconclusive'])));
  assert.equal(review.intact, true); assert.deepEqual([review.claim.graftVerdict, review.claim.kernelVerdict], ['NEEDS_REVIEW', 'INCONCLUSIVE']);
  const forged = verifyProofFile(write(dir, 'forged.json', mutated(envelope(['passed', 'failed']), (c) => { c.payload.verdict.graft = 'VERIFIED'; })));
  assert.equal(forged.intact, false); assert.equal(forged.claim.graftVerdict, 'VERIFIED', 'the claim is what the damaged file says; only intact says whether it can be relied on');
});

test('portable tamper matrix: one authoritative field changed in a copy (digest left as is) → not intact with a structured reason', (t) => {
  const dir = tmp(t);
  const e = envelope();
  const matrix = {
    'destination revision': (c) => { c.payload.destination.revision = '9'.repeat(40); },
    'capability id': (c) => { c.payload.capability.id = 'sha256:' + 'f'.repeat(64); },
    'recorded verdict': (c) => { c.payload.verdict.graft = 'FAILED'; },
    'proof root': (c) => { c.payload.proofRoot = '7'.repeat(64); },
    'manifest digest': (c) => { c.payload.evidence.manifestDigest = '6'.repeat(64); },
    'case outcome': (c) => { c.payload.cases[1].outcome = 'failed'; },
    'source revision': (c) => { c.payload.source.revision = null; },
    'verifier kernel': (c) => { c.payload.verifier.kernel.sourceCommit = '5'.repeat(40); },
  };
  for (const [name, edit] of Object.entries(matrix)) {
    const r = verifyProofFile(write(dir, `${name.replace(/ /g, '-')}.json`, mutated(e, edit)));
    assert.equal(r.intact, false, `${name} changed → not intact`);
    assert.ok(r.reasons.includes('payload does not re-derive to the digest'), `${name}: ${r.reasons.join('; ')}`);
  }
  assert.deepEqual(verifyProofFile(write(dir, 'malformed.json', '{"schema": "graft-proof-envelope/1", ')), { found: true, intact: false, reasons: ['the file is not valid JSON'], schema: null, digest: null, claim: null });
  const other = verifyProofFile(write(dir, 'schema.json', mutated(e, (c) => { c.schema = 'graft-proof-envelope/2'; c.payload.schema = 'graft-proof-envelope/2'; })));
  assert.equal(other.intact, false); assert.ok(other.reasons.includes('unsupported schema "graft-proof-envelope/2"'), other.reasons.join('; '));
  assert.deepEqual(verifyProofFile(path.join(dir, 'absent.json')), { found: false, intact: false, reasons: ['no such file'], schema: null, digest: null, claim: null });
  assert.equal(verifyProofFile(write(dir, 'array.json', [1, 2])).reasons[0], 'the proof artifact is not a JSON object');
  // Informational fields are not authenticated: changing createdAt leaves integrity intact.
  assert.equal(verifyProofFile(write(dir, 'dated.json', mutated(e, (c) => { c.informational.createdAt = '1999-01-01T00:00:00.000Z'; }))).intact, true);
});

test('recomputed-digest attack: re-digesting an altered payload is still caught by the internal bindings; a fully consistent rewrite is NOT — Model A is tamper-evident, not a signature', (t) => {
  const dir = tmp(t);
  const e = envelope();
  const redigest = (c) => { c.digest = sha256(canonicalJson(c.payload)); return c; };
  // Altered proof root, digest recomputed: the carried manifest still re-derives the original root.
  const root = verifyProofFile(write(dir, 'root.json', redigest(mutated(e, (c) => { c.payload.proofRoot = '7'.repeat(64); }))));
  assert.equal(root.intact, false); assert.deepEqual(root.reasons, ['proof root does not re-derive from the manifest']);
  // Altered manifest digest, digest recomputed: the manifest still re-derives the original manifest digest.
  const md = verifyProofFile(write(dir, 'manifest.json', redigest(mutated(e, (c) => { c.payload.evidence.manifestDigest = '6'.repeat(64); }))));
  assert.equal(md.intact, false); assert.deepEqual(md.reasons, ['evidence manifest digest does not match the manifest']);
  // A dropped evidence item, digest recomputed: count, manifest digest and root all disagree.
  const dropped = verifyProofFile(write(dir, 'dropped.json', redigest(mutated(e, (c) => { c.evidenceManifest.pop(); }))));
  assert.equal(dropped.intact, false); assert.deepEqual(dropped.reasons, ['evidence count does not match the manifest', 'evidence manifest digest does not match the manifest', 'proof root does not re-derive from the manifest']);
  // A changed verdict / revision / capability with the digest recomputed: no internal binding
  // contradicts it. This is the documented limit of Model A: an attacker who can rewrite the whole
  // file and recompute every hash produces an internally consistent artifact. Detecting THAT needs an
  // issuer key (Model C/D), which is out of scope here and is why nothing calls this proof signed.
  const consistent = redigest(mutated(e, (c) => { c.payload.verdict = { graft: 'VERIFIED', kernel: 'PASS' }; c.payload.destination.revision = '9'.repeat(40); c.payload.capability.slug = 'other'; }));
  const r = verifyProofFile(write(dir, 'consistent.json', consistent));
  assert.equal(r.intact, true, 'internally consistent: Model A cannot tell a full rewrite from an original');
  assert.notEqual(r.digest, e.digest, 'but it is a DIFFERENT proof: the original digest (the one a Ledger cites) no longer names it');
  // And a fully consistent rewrite that also fakes the evidence must fabricate a whole manifest whose
  // root matches — possible for the attacker, still a different digest from the cited one.
  const fabricated = mutated(e, (c) => { c.evidenceManifest = [{ kind: 'RESULT', digest: '3'.repeat(64) }]; c.payload.evidence = { count: 1, manifestDigest: manifestDigest(c.evidenceManifest) }; c.payload.proofRoot = proofRootOfManifest(c.evidenceManifest); });
  assert.equal(verifyProofArtifact(redigest(fabricated)).intact, true); assert.notEqual(redigest(fabricated).digest, e.digest);
});
