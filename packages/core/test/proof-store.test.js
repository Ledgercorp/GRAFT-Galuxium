// Proof Integrity 0.1, Checkpoint B — the content-addressed proof store and the redact-then-bind
// report pipeline. Pure: a temporary GRAFT_HOME, no server, no git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { storeProof, loadProofArtifact, verifyStoredProof, proofArtifactPath, proofsDir, proofIntegrity, exportProofArtifact, exportAssemblyProofs } from '../src/laboratory/proof-store.js';
import { attachProofEnvelope, finishReport } from '../src/verify/proof-envelope.js';
import { redactSecrets } from '../src/manifest/schema.js';
import { verifyProofEnvelope, buildProofEnvelope, verifyProofFile } from '../../proof-adapter/src/index.js';
import { canonicalJson, sha256 } from '../../cuf-kernel/src/index.js';
import { envelopeFor, decidedReport, httpResult } from './helpers/proof.js';

const R1 = '1'.repeat(40);
function home(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-proof-store-'));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}

test('persist: a valid envelope lands at the digest-derived location, verifies on reload, and carries no secret or machine path', (t) => {
  const work = home(t);
  const envelope = envelopeFor({ revision: R1 });
  const stored = storeProof(envelope);
  assert.equal(stored.stored, true); assert.equal(stored.digest, envelope.digest);
  assert.equal(stored.file, path.join(proofsDir(), `${envelope.digest}.json`)); assert.equal(proofArtifactPath(envelope.digest), stored.file);
  assert.ok(fs.existsSync(stored.file));
  const text = fs.readFileSync(stored.file, 'utf8');
  const artifact = JSON.parse(text);
  assert.deepEqual(Object.keys(artifact).sort(), ['digest', 'evidenceManifest', 'informational', 'payload', 'schema']);
  assert.deepEqual(verifyProofEnvelope(artifact), { intact: true, reasons: [] }, 'the file is the portable proof, verifiable on its own');
  assert.equal(artifact.digest, sha256(canonicalJson(artifact.payload)));
  assert.equal(text.includes(work), false); assert.equal(text.includes(os.homedir()), false); assert.equal(text.includes(os.tmpdir()), false);
  const back = loadProofArtifact(envelope.digest);
  assert.equal(back.found, true); assert.equal(back.intact, true); assert.deepEqual(back.reasons, []); assert.equal(back.envelope.digest, envelope.digest);
  assert.deepEqual(verifyStoredProof(envelope.digest), { found: true, intact: true, digest: envelope.digest, reasons: [] });
});

test('idempotent: the same envelope twice is one artifact; the same proof issued later (other createdAt) reuses the first artifact unchanged', (t) => {
  home(t);
  const first = envelopeFor({ revision: R1 });
  assert.equal(storeProof(first).stored, true);
  assert.equal(storeProof(first).stored, false);
  const later = { ...first, informational: { createdAt: '2030-01-01T00:00:00.000Z' } };
  assert.equal(later.digest, first.digest, 'time is informational: same proof identity');
  assert.equal(storeProof(later).stored, false);
  assert.equal(loadProofArtifact(first.digest).envelope.informational.createdAt, '2026-09-13T12:00:01.000Z', 'the first issuance is immutable');
  assert.equal(fs.readdirSync(proofsDir()).length, 1);
});

test('conflict: the same digest with different authoritative content is refused, never overwritten; damaged artifacts are refused too', (t) => {
  home(t);
  const envelope = envelopeFor({ revision: R1 });
  storeProof(envelope);
  // A forged envelope claiming the stored digest over different content: the store refuses to replace what it has.
  const other = envelopeFor({ revision: '2'.repeat(40) });
  const forged = { ...other, digest: envelope.digest };
  assert.throws(() => storeProof(forged), (e) => e.code === 'proof-not-intact', 'a mismatched digest never verifies');
  const before = fs.readFileSync(proofArtifactPath(envelope.digest), 'utf8');
  // Damage the stored artifact in place, then try to store the genuine envelope again.
  fs.writeFileSync(proofArtifactPath(envelope.digest), before.replace('"VERIFIED"', '"FAILED"'));
  assert.throws(() => storeProof(envelope), (e) => e.code === 'proof-store-conflict' && /damaged/.test(e.message));
  assert.equal(fs.readFileSync(proofArtifactPath(envelope.digest), 'utf8').includes('"FAILED"'), true, 'nothing was overwritten');
  // Same digest, different content that still parses: refused as a conflict.
  const swapped = JSON.parse(before); swapped.evidenceManifest = []; swapped.payload.evidence = { count: 0, manifestDigest: sha256(canonicalJson([])) }; swapped.payload.proofRoot = sha256(canonicalJson([]));
  swapped.digest = sha256(canonicalJson(swapped.payload));
  fs.writeFileSync(proofArtifactPath(envelope.digest), JSON.stringify({ ...swapped, digest: envelope.digest }));
  assert.throws(() => storeProof(envelope), (e) => e.code === 'proof-store-conflict');
});

test('corrupted, missing and malformed artifacts give structured results, never throws', (t) => {
  home(t);
  const envelope = envelopeFor({ revision: R1 });
  storeProof(envelope);
  const file = proofArtifactPath(envelope.digest);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(R1, '9'.repeat(40)));
  const tampered = verifyStoredProof(envelope.digest);
  assert.equal(tampered.found, true); assert.equal(tampered.intact, false); assert.deepEqual(tampered.reasons, ['payload does not re-derive to the digest']);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(verifyStoredProof(envelope.digest).reasons, ['the proof artifact is not valid JSON']);
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(text), digest: 'f'.repeat(64) }));
  assert.deepEqual(verifyStoredProof(envelope.digest).reasons, ['the stored digest is not the requested digest', 'payload does not re-derive to the digest']);
  fs.rmSync(file);
  assert.deepEqual(verifyStoredProof(envelope.digest), { found: false, intact: false, digest: envelope.digest, reasons: ['no proof artifact is stored for this digest'] });
  assert.deepEqual(verifyStoredProof('0'.repeat(64)).found, false);
  assert.throws(() => verifyStoredProof('not-a-digest'), (e) => e.code === 'invalid-proof-digest');
  assert.throws(() => verifyStoredProof('../etc/passwd'), (e) => e.code === 'invalid-proof-digest');
});

test('FAILED and NEEDS_REVIEW envelopes persist; an envelope that is not intact, or a report without a proof root, never becomes an artifact', (t) => {
  home(t);
  const failed = envelopeFor({ revision: R1, report: decidedReport([httpResult('a'), httpResult('b', 'failed')]) });
  assert.deepEqual(failed.payload.verdict, { graft: 'FAILED', kernel: 'FAIL' });
  assert.equal(storeProof(failed).stored, true); assert.equal(verifyStoredProof(failed.digest).intact, true);
  const review = envelopeFor({ revision: R1, report: decidedReport([], { serverReady: false }) });
  assert.deepEqual(review.payload.verdict, { graft: 'NEEDS_REVIEW', kernel: 'INCONCLUSIVE' });
  assert.equal(storeProof(review).stored, true); assert.equal(verifyStoredProof(review.digest).intact, true);
  const none = buildProofEnvelope({ report: { ...decidedReport(), proofRoot: null, proofEvidence: null }, capability: { slug: 's', kind: 'k', form: 'service' }, contract: {}, source: { revision: null }, verifier: { core: '0' } });
  assert.equal(none.envelope, null); assert.equal(none.reason, 'proof-unavailable');
  assert.throws(() => storeProof(none.envelope), (e) => e.code === 'proof-not-intact');
  const edited = JSON.parse(JSON.stringify(failed)); edited.payload.verdict.graft = 'VERIFIED';
  assert.throws(() => storeProof(edited), (e) => e.code === 'proof-not-intact');
  assert.equal(fs.readdirSync(proofsDir()).length, 2);
  // Privacy: a secret-looking key or a machine path inside an (otherwise intact) envelope is refused.
  const leaky = buildProofEnvelope({ report: decidedReport(), capability: { slug: 's', kind: 'k', form: 'service' }, contract: {}, source: { revision: null }, verifier: { core: os.tmpdir() } }).envelope;
  assert.throws(() => storeProof(leaky), (e) => e.code === 'proof-privacy');
});

test('redaction order: the envelope is built over the redacted report, so a redaction-sensitive field never reaches the proof and nothing mutates after the digest', () => {
  const secretish = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0'; // shaped like a key the redactor strips; not a real secret
  const report = { ...decidedReport(), rationale: `observed ${secretish} in the log`, results: [{ id: 'a', kind: 'http', required: true, outcome: 'passed', reason: `header carried ${secretish}` }, { id: 'b', kind: 'http', required: true, outcome: 'passed' }] };
  const identity = { manifest: { identity: { slug: 'probe', category: 'probe-kind', implementationForm: 'service' } }, proof: null, source: { revision: null }, destination: null };
  const persisted = finishReport(report, identity);
  const text = JSON.stringify(persisted);
  assert.equal(text.includes(secretish), false, 'the secret is absent from the persisted report');
  assert.match(persisted.rationale, /\[redacted\]/); assert.match(persisted.results[0].reason, /\[redacted\]/);
  assert.deepEqual(verifyProofEnvelope(persisted.proofEnvelope), { intact: true, reasons: [] });
  // The digest is the digest of the final, safe representation: rebuilding from the persisted report gives the same envelope.
  const { proofEnvelope, ...safeReport } = persisted;
  assert.equal(attachProofEnvelope(safeReport, identity).proofEnvelope.digest, proofEnvelope.digest);
  // No post-digest mutation: redacting the finished report again changes nothing, envelope included.
  assert.deepEqual(redactSecrets(persisted), persisted);
  // The wrong order (bind, then redact) is what the pipeline forbids; shown here only to prove the hazard is real.
  const wrong = redactSecrets(attachProofEnvelope({ ...report, results: report.results.map((r) => ({ ...r, id: r.id === 'a' ? `case-${secretish}` : r.id })) }, identity));
  assert.equal(verifyProofEnvelope(wrong.proofEnvelope).intact, false, 'binding before redaction would let redaction break the proof');
  const right = finishReport({ ...report, results: report.results.map((r) => ({ ...r, id: r.id === 'a' ? `case-${secretish}` : r.id })) }, identity);
  assert.equal(verifyProofEnvelope(right.proofEnvelope).intact, true); assert.equal(JSON.stringify(right).includes(secretish), false);
});

// ---------------------------------------------------------------------------------------------
// Checkpoint C: proof integrity of a Ledger record, and export as an exact copy.
// ---------------------------------------------------------------------------------------------
test('proofIntegrity: INTACT / MISSING / MISMATCH / NONE for a record, from the store alone, never a verdict', (t) => {
  home(t);
  const e = envelopeFor({ revision: R1, capability: { slug: 'hosted-authentication' } });
  storeProof(e);
  const record = { capability: 'hosted-authentication', state: 'CURRENT', currentVerifiedRevision: R1, destinationRevisionAfter: R1, verificationVerdict: 'VERIFIED', proofReference: { envelopeSchema: e.schema, envelopeDigest: e.digest } };
  assert.deepEqual(proofIntegrity(record), { status: 'INTACT', digest: e.digest, reasons: [] });
  assert.deepEqual(proofIntegrity({ ...record, state: 'STALE' }), { status: 'INTACT', digest: e.digest, reasons: [] }, 'a STALE record\'s original proof is still intact');
  assert.deepEqual(proofIntegrity({ ...record, proofReference: null }).status, 'NONE');
  assert.deepEqual(proofIntegrity({ ...record, proofReference: { envelopeSchema: e.schema, envelopeDigest: '0'.repeat(64) } }).status, 'MISSING');
  assert.equal(proofIntegrity({ ...record, currentVerifiedRevision: '2'.repeat(40) }).status, 'MISMATCH');
  assert.equal(proofIntegrity({ ...record, capability: 'other' }).status, 'MISMATCH');
  const file = proofArtifactPath(e.digest);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"VERIFIED"', '"FAILED"'));
  const damaged = proofIntegrity(record);
  assert.equal(damaged.status, 'MISMATCH'); assert.deepEqual(damaged.reasons, ['payload does not re-derive to the digest']);
  assert.ok(!('verdict' in damaged) && !('state' in damaged));
});

test('export: an exact byte copy of the stored artifact that verifies on its own; missing or corrupt artifacts fail closed; assembly export is all or nothing', (t) => {
  const work = home(t);
  const a = envelopeFor({ revision: R1, capability: { slug: 'a', id: 'sha256:a' } });
  const b = envelopeFor({ revision: R1, capability: { slug: 'b', id: 'sha256:b' } });
  storeProof(a); storeProof(b);
  const out = path.join(work, 'exported'); fs.mkdirSync(out);
  const exported = exportProofArtifact(a.digest, out);
  assert.equal(exported.file, path.join(out, `graft-proof-${a.digest}.json`)); assert.equal(exported.digest, a.digest); assert.equal(exported.claim.capability.slug, 'a');
  assert.equal(Buffer.compare(fs.readFileSync(exported.file), fs.readFileSync(proofArtifactPath(a.digest))), 0, 'byte-identical: export copies, it never mints');
  assert.deepEqual(verifyProofFile(exported.file).intact, true);
  // A file destination.
  const named = exportProofArtifact(a.digest, path.join(work, 'deep', 'my-proof.json'));
  assert.equal(named.file, path.join(work, 'deep', 'my-proof.json')); assert.equal(Buffer.compare(fs.readFileSync(named.file), fs.readFileSync(proofArtifactPath(a.digest))), 0);
  // Missing and corrupt: refused, nothing written.
  assert.throws(() => exportProofArtifact('0'.repeat(64), out), (e) => e.code === 'proof-missing');
  fs.writeFileSync(proofArtifactPath(b.digest), fs.readFileSync(proofArtifactPath(b.digest), 'utf8').replace(R1, '9'.repeat(40)));
  assert.throws(() => exportProofArtifact(b.digest, out), (e) => e.code === 'proof-mismatch');
  assert.equal(fs.existsSync(path.join(out, `graft-proof-${b.digest}.json`)), false);
  // Assembly export: every CURRENT record's proof, or none.
  const record = (slug, digest) => ({ capability: slug, capabilityId: `sha256:${slug}`, state: 'CURRENT', currentVerifiedRevision: R1, destinationRevisionAfter: R1, proofReference: { envelopeSchema: 'graft-proof-envelope/1', envelopeDigest: digest } });
  const dir2 = path.join(work, 'assembly');
  assert.throws(() => exportAssemblyProofs({ capabilities: [record('a', a.digest), record('b', b.digest)] }, dir2), (e) => e.code === 'proof-export-refused' && /b: proof mismatch/.test(e.message));
  assert.equal(fs.existsSync(dir2), false, 'nothing was written');
  const c = envelopeFor({ revision: R1, capability: { slug: 'c', id: 'sha256:c' } }); storeProof(c);
  const files = exportAssemblyProofs({ capabilities: [record('a', a.digest), record('c', c.digest), { ...record('b', b.digest), state: 'STALE' }] }, dir2);
  assert.deepEqual(files.map((f) => [f.capability, path.basename(f.file)]), [['a', `graft-proof-${a.digest}.json`], ['c', `graft-proof-${c.digest}.json`]], 'CURRENT records only');
  for (const f of files) assert.equal(verifyProofFile(f.file).intact, true);
});
