// Proof Integrity 0.1, Checkpoint B: the content-addressed proof store.
//
// GRAFT_HOME/proofs/<envelopeDigest>.json — one immutable JSON artifact per proof envelope, named
// by the envelope's own digest, so a Ledger record can cite a proof by digest alone and any reader
// with the file can re-verify it with sha256 + canonicalJson (see packages/proof-adapter/src/
// envelope.js). The store is not a database and knows nothing about capabilities, revisions or
// verdicts: it holds intact envelopes and answers "is the artifact for this digest here and intact".
//
// Write semantics: an envelope is stored only if it verifies intact and is free of secret-looking
// keys and GRAFT_HOME paths; writing the same envelope again is idempotent; an existing artifact
// whose authoritative content (payload + evidence manifest) matches is reused as it is — including
// its informational fields, which the first issuance fixed — and an existing artifact under the
// same digest with different authoritative content (or one that no longer verifies) is a store
// integrity failure, never overwritten. Writes are atomic (temporary file + hard link, which cannot
// replace an existing file).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { graftHome } from '../registry/index.js';
import { verifyProofEnvelope, verifyProofArtifact, PROOF_ENVELOPE_SCHEMA } from '../../../proof-adapter/src/index.js';
import { canonicalJson } from '../../../cuf-kernel/src/index.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const DIGEST = /^[0-9a-f]{64}$/;
const SECRET_KEY = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
export const proofsDir = () => path.join(graftHome(), 'proofs');
export const proofArtifactPath = (digest) => { if (!DIGEST.test(digest || '')) throw fail('invalid-proof-digest', 'A proof digest is a 64-character sha256 hex string.'); return path.join(proofsDir(), `${digest}.json`); };

/** The artifact body: exactly the envelope, nothing else, so the file is the portable proof. */
const artifactOf = (envelope) => ({ schema: envelope.schema, digest: envelope.digest, payload: envelope.payload, evidenceManifest: envelope.evidenceManifest, informational: envelope.informational ?? { createdAt: null } });
const authoritative = (envelope) => canonicalJson({ payload: envelope.payload, evidenceManifest: envelope.evidenceManifest });

function assertStorableProof(value, trail = 'proof') {
  if (Array.isArray(value)) { value.forEach((v, i) => assertStorableProof(v, `${trail}[${i}]`)); return; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) { if (SECRET_KEY.test(k) && typeof v === 'string' && v.length) throw fail('proof-privacy', `${trail}.${k} looks like a secret value; the proof store refuses it.`); assertStorableProof(v, `${trail}.${k}`); } return; }
  if (typeof value === 'string' && [graftHome(), os.homedir(), os.tmpdir()].some((p) => p.length > 1 && value.includes(p))) throw fail('proof-privacy', `${trail} would store a machine path.`);
}

/**
 * Persist an envelope. Returns `{ digest, file, stored }` where `stored` is false when an identical
 * artifact was already there. Throws `proof-not-intact` for an envelope that does not verify,
 * `proof-privacy` for one that carries a secret-looking value or a machine path, and
 * `proof-store-conflict` when the digest is already taken by different or damaged content.
 */
export function storeProof(envelope) {
  const check = verifyProofEnvelope(envelope);
  if (!check.intact) throw fail('proof-not-intact', `The proof envelope does not verify: ${check.reasons.join('; ')}.`);
  const artifact = artifactOf(envelope);
  assertStorableProof(artifact);
  const file = proofArtifactPath(artifact.digest);
  const existing = loadProofArtifact(artifact.digest);
  if (existing.found) {
    if (!existing.intact) throw fail('proof-store-conflict', `The stored proof ${artifact.digest.slice(0, 12)} is damaged (${existing.reasons.join('; ')}); it is not overwritten.`);
    if (authoritative(existing.envelope) !== authoritative(artifact)) throw fail('proof-store-conflict', `The stored proof ${artifact.digest.slice(0, 12)} has different content under the same digest; it is not overwritten.`);
    return { digest: artifact.digest, file, stored: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Lost a race to an identical-digest writer: accept only if what landed is the same proof.
      const landed = loadProofArtifact(artifact.digest);
      if (!landed.found || !landed.intact || authoritative(landed.envelope) !== authoritative(artifact)) throw fail('proof-store-conflict', `The stored proof ${artifact.digest.slice(0, 12)} was written concurrently with different content.`);
      return { digest: artifact.digest, file, stored: false };
    }
  } finally { fs.rmSync(temporary, { force: true }); }
  return { digest: artifact.digest, file, stored: true };
}

/**
 * Load and check the artifact for a digest. Never throws for an absent or damaged file: the result
 * says `found`, `intact` (schema + envelope integrity + the stored digest equals the requested one)
 * and deterministic `reasons`. It decides nothing about a capability, a revision or a verdict.
 */
export function loadProofArtifact(digest) {
  const file = proofArtifactPath(digest);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? Object.freeze({ found: false, intact: false, digest, envelope: null, reasons: Object.freeze(['no proof artifact is stored for this digest']) }) : Object.freeze({ found: false, intact: false, digest, envelope: null, reasons: Object.freeze([`the proof artifact could not be read (${error.code || 'error'})`]) }); }
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { return Object.freeze({ found: true, intact: false, digest, envelope: null, reasons: Object.freeze(['the proof artifact is not valid JSON']) }); }
  const reasons = [];
  if (!envelope || typeof envelope !== 'object') reasons.push('the proof artifact is not an object');
  else {
    if (envelope.schema !== PROOF_ENVELOPE_SCHEMA) reasons.push(`unsupported schema ${JSON.stringify(envelope.schema ?? null)}`);
    if (envelope.digest !== digest) reasons.push('the stored digest is not the requested digest');
    const check = verifyProofEnvelope(envelope);
    for (const r of check.reasons) if (!reasons.includes(r)) reasons.push(r);
  }
  return Object.freeze({ found: true, intact: reasons.length === 0, digest, envelope, reasons: Object.freeze(reasons) });
}

/** `loadProofArtifact` without the envelope body: the shape a Ledger gate needs. */
export function verifyStoredProof(digest) {
  const r = loadProofArtifact(digest);
  return Object.freeze({ found: r.found, intact: r.intact, digest: r.digest, reasons: r.reasons });
}

// ---------------------------------------------------------------------------------------------
// Checkpoint C: integrity status of a Ledger record's proof, and portable export.
// ---------------------------------------------------------------------------------------------

/**
 * The proof integrity of one Ledger record, for display beside — never instead of — its state and
 * its recorded verdict: INTACT (the cited artifact is here and verifies), MISSING (cited, not in the
 * store), MISMATCH (here but does not verify, or names another digest / revision / capability),
 * NONE (the record cites no proof — a record from before Proof Integrity). Reads the store only.
 */
export function proofIntegrity(record) {
  const ref = record?.proofReference;
  if (!ref || !DIGEST.test(ref.envelopeDigest || '')) return Object.freeze({ status: 'NONE', digest: null, reasons: Object.freeze(['the record cites no proof envelope']) });
  const stored = loadProofArtifact(ref.envelopeDigest);
  if (!stored.found) return Object.freeze({ status: 'MISSING', digest: ref.envelopeDigest, reasons: stored.reasons });
  const reasons = [...stored.reasons];
  const revision = record.currentVerifiedRevision || record.destinationRevisionAfter || null;
  const bound = stored.envelope?.payload?.destination?.revision ?? null;
  if (stored.intact && revision && bound !== revision) reasons.push(`the proof binds destination revision ${String(bound).slice(0, 12)}, not the record's ${String(revision).slice(0, 12)}`);
  if (stored.intact && record.capability && stored.envelope?.payload?.capability?.slug !== record.capability) reasons.push(`the proof is about ${stored.envelope?.payload?.capability?.slug || 'another capability'}, not ${record.capability}`);
  return Object.freeze({ status: reasons.length ? 'MISMATCH' : 'INTACT', digest: ref.envelopeDigest, reasons: Object.freeze(reasons) });
}

/** The portable file name for a proof: derived from the digest alone. */
export const proofFileName = (digest) => `graft-proof-${digest}.json`;

/**
 * Export the stored artifact for a digest as an exact byte copy. The export never rebuilds an
 * envelope: what leaves is what the Ledger cites. Fails closed — `proof-missing` when nothing is
 * stored, `proof-mismatch` when the stored artifact does not verify — and re-reads the copy to
 * confirm it is byte-identical and verifies on its own. `destination` is a directory (the file is
 * named by digest) or a file path.
 */
export function exportProofArtifact(digest, destination) {
  const stored = loadProofArtifact(digest);
  if (!stored.found) throw fail('proof-missing', `No proof artifact is stored for ${String(digest).slice(0, 12)}; nothing was exported.`);
  if (!stored.intact) throw fail('proof-mismatch', `The stored proof ${String(digest).slice(0, 12)} does not verify (${stored.reasons.join('; ')}); it was not exported.`);
  const source = proofArtifactPath(digest);
  const isDir = fs.existsSync(destination) && fs.statSync(destination).isDirectory();
  const file = isDir ? path.join(destination, proofFileName(digest)) : destination;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = fs.readFileSync(source);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  const copy = fs.readFileSync(file);
  if (Buffer.compare(copy, bytes) !== 0) throw fail('proof-export-mismatch', `The exported proof at ${path.basename(file)} is not byte-identical to the stored artifact.`);
  const check = verifyProofArtifact(JSON.parse(copy.toString('utf8')));
  if (!check.intact || check.digest !== digest) throw fail('proof-export-mismatch', `The exported proof ${String(digest).slice(0, 12)} does not verify on its own (${check.reasons.join('; ')}).`);
  return Object.freeze({ digest, file, bytes: bytes.length, claim: check.claim });
}

/**
 * Export the proof of every CURRENT record of an assembly workspace into `directory`. All or
 * nothing: every cited proof is checked before any file is written, so a missing or damaged
 * artifact means no export at all rather than a package with a promised proof absent.
 */
export function exportAssemblyProofs(workspace, directory) {
  const current = (workspace?.capabilities || []).filter((c) => c.state === 'CURRENT');
  const problems = [];
  for (const c of current) {
    const i = proofIntegrity(c);
    if (i.status !== 'INTACT') problems.push(`${c.capability || c.capabilityId}: proof ${i.status.toLowerCase()}${i.reasons.length ? ` (${i.reasons.join('; ')})` : ''}`);
  }
  if (problems.length) throw fail('proof-export-refused', `The assembly's proofs cannot be exported: ${problems.join('; ')}.`);
  fs.mkdirSync(directory, { recursive: true });
  return Object.freeze(current.map((c) => Object.freeze({ capability: c.capability, capabilityId: c.capabilityId, revision: c.currentVerifiedRevision || c.destinationRevisionAfter, ...exportProofArtifact(c.proofReference.envelopeDigest, directory) })));
}
