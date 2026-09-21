// Portable proof verification (Proof Integrity 0.1, Checkpoint C).
//
// A proof artifact is the envelope itself (schema, digest, payload, evidenceManifest,
// informational) written as JSON. Anyone holding the file can check it here with nothing else: no
// project, no donor repository, no GRAFT_HOME, no git, no network, no model, no key. Two separate
// answers come back and are never merged:
//
//   integrity  — is the artifact internally intact (schema known, every binding re-derives to the
//                digest, the evidence manifest re-derives to the manifest digest and the proof root)?
//   claim      — what does the artifact RECORD: which capability, at which destination revision,
//                from which source revision, with which recorded GRAFT and kernel verdicts, decided by
//                which verifier and kernel, over which proof root.
//
// "intact" means unmodified under Model A's trust model. It never means VERIFIED: an intact artifact
// can record FAILED or NEEDS_REVIEW, and that is exactly what it proves — that this is what the
// verifier reported. Model A is content addressing without a key: it detects accidental or partial
// modification and stops an unchanged artifact from being re-bound to another claim; it does not
// authenticate an issuer. Whoever can rewrite the whole file can recompute every hash in it. Do not
// describe the result as signed, attested, trusted or tamper-proof; it is tamper-evident.
import fs from 'node:fs';
import { verifyProofEnvelope, PROOF_ENVELOPE_SCHEMA } from './envelope.js';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What an envelope records, read verbatim from its payload. Descriptive only; derives nothing. */
export function proofClaim(envelope) {
  const p = isPlain(envelope?.payload) ? envelope.payload : {};
  const c = isPlain(p.capability) ? p.capability : {};
  const v = isPlain(p.verdict) ? p.verdict : {};
  const verifier = isPlain(p.verifier) ? p.verifier : {};
  return Object.freeze({
    schema: typeof p.schema === 'string' ? p.schema : null,
    capability: Object.freeze({ id: c.id ?? null, slug: c.slug ?? null, kind: c.kind ?? null, form: c.form ?? null, genomeId: c.genomeId ?? null, irId: c.irId ?? null }),
    contract: Object.freeze({ id: p.contract?.id ?? null, version: p.contract?.version ?? null, casesDigest: p.contract?.casesDigest ?? null }),
    sourceRevision: p.source?.revision ?? null,
    destinationRevision: p.destination?.revision ?? null,
    hostProfile: p.destination?.hostProfile ?? null,
    adaptation: p.destination?.adaptation ? Object.freeze({ id: p.destination.adaptation.id ?? null, artifactSha256: p.destination.adaptation.artifactSha256 ?? null }) : null,
    graftVerdict: v.graft ?? null,
    kernelVerdict: v.kernel ?? null,
    verifier: Object.freeze({ core: verifier.core ?? null, proofAdapter: verifier.proofAdapter ?? null, kernel: Object.freeze({ sourceCommit: verifier.kernel?.sourceCommit ?? null, vendoredSha256: verifier.kernel?.vendoredSha256 ?? null }) }),
    proofRoot: p.proofRoot ?? null,
    proofAuthority: isPlain(p.proofAuthority) ? Object.freeze({ ...p.proofAuthority }) : null,
    evidence: Object.freeze({ count: p.evidence?.count ?? null, manifestDigest: p.evidence?.manifestDigest ?? null }),
    cases: Object.freeze(Array.isArray(p.cases) ? p.cases.map((x) => Object.freeze({ id: x?.id ?? null, outcome: x?.outcome ?? null })) : []),
    createdBy: p.createdBy ?? null,
    createdAt: envelope?.informational?.createdAt ?? null,
  });
}

/** Verify an already-parsed artifact: integrity and claim, separately. */
export function verifyProofArtifact(artifact) {
  if (!isPlain(artifact)) return Object.freeze({ found: true, intact: false, reasons: Object.freeze(['the proof artifact is not a JSON object']), schema: null, digest: null, claim: null });
  const integrity = verifyProofEnvelope(artifact);
  return Object.freeze({
    found: true, intact: integrity.intact, reasons: integrity.reasons,
    schema: artifact.schema === PROOF_ENVELOPE_SCHEMA ? artifact.schema : (typeof artifact.schema === 'string' ? artifact.schema : null),
    digest: typeof artifact.digest === 'string' ? artifact.digest : null,
    // The claim is reported even when integrity failed, so a person can see what the damaged file
    // purports; it is what the file SAYS, and only `intact` says whether that can be relied on.
    claim: proofClaim(artifact),
  });
}

/**
 * Verify a proof file on disk. Never throws for a missing, unreadable or malformed file; the result
 * says so. Reads the file and nothing else.
 */
export function verifyProofFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (error) { return Object.freeze({ found: false, intact: false, reasons: Object.freeze([error.code === 'ENOENT' ? 'no such file' : `the file could not be read (${error.code || 'error'})`]), schema: null, digest: null, claim: null }); }
  let artifact;
  try { artifact = JSON.parse(text); }
  catch { return Object.freeze({ found: true, intact: false, reasons: Object.freeze(['the file is not valid JSON']), schema: null, digest: null, claim: null }); }
  return verifyProofArtifact(artifact);
}
