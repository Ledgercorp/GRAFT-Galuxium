// Proof Integrity 0.1, Checkpoint A: attach the content-addressed proof envelope to a verification
// report. The envelope itself (schema, digest, verify) lives in the proof adapter; this module only
// gathers the identities the verifier holds authoritatively — the capability and its engine
// contract, the revision the run was about, the core version — and hands them across. It decides
// nothing and fabricates nothing: an identity the verifier does not have is null, and a destination
// verification without a committed revision gets no envelope, with the reason stated.
import fs from 'node:fs';
import { inspectRepo } from '../apply/git.js';
import { buildEngineArtifacts } from '../engine/index.js';
import { profileFor } from '../emit/profiles.js';
import { buildProofEnvelope } from '../../../proof-adapter/src/index.js';
import { redactSecrets } from '../manifest/schema.js';

let coreVersion = null;
const graftCoreVersion = () => (coreVersion ??= JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);

/**
 * The revision a verification of `root` is about: the committed HEAD of a clean checkout, scoped to
 * the project directory. Anything else — not a repository, no commits, uncommitted changes — is no
 * authority, and the reason says which. Read-only.
 */
export function revisionAuthority(root) {
  const repo = inspectRepo(root);
  if (!repo.isRepo) return { revision: null, reason: 'not-a-git-repository' };
  if (!repo.hasCommits) return { revision: null, reason: 'no-commits' };
  if (repo.dirty) return { revision: null, reason: 'uncommitted-changes' };
  return { revision: repo.head, reason: null };
}

/**
 * The source revision a manifest records authoritatively: the head the harvest observed when the
 * capability was verified in its source, and only if that checkout was clean and did not change
 * during verification. Anything less is not a revision the proof may name.
 */
export function sourceRevisionOf(manifest) {
  const state = manifest?.provenance?.verifiedInSource?.sourceState;
  if (!state || typeof state.head !== 'string' || !/^[0-9a-f]{40}$/.test(state.head)) return null;
  if (state.dirty !== false || state.changedDuringVerification === true) return null;
  return state.head;
}

/** The capability identity the engine derives from the manifest; null ids when it cannot be derived. */
function capabilityIdentity(manifest) {
  const form = manifest.identity?.implementationForm || 'service';
  let genome = null, ir = null;
  try { const a = buildEngineArtifacts(manifest); genome = a.genome; ir = a.ir; } catch { /* identity stays partial */ }
  return {
    id: genome?.identity?.capabilityId ?? null, slug: manifest.identity?.slug, kind: genome?.identity?.kind ?? manifest.identity?.category, form,
    genomeId: genome?.genomeId ?? null, irId: ir?.irId ?? null,
  };
}

/**
 * Attach `proofEnvelope` (or null plus `proofEnvelopeReason`) to a report. Additive: no existing
 * field changes, and a consumer that ignores the field sees the report it always saw.
 *
 *   manifest     the capability manifest the run verified
 *   proof        the engine contract projection (its contractId / contractVersion), or null
 *   source       { revision } — the source revision or null
 *   destination  null for a source verification; { revision, reason, hostProfile, adaptation } for a
 *                destination one, where a null revision withholds the envelope. `fingerprint` (the
 *                destination's) stands in for hostProfile: the host profile is then the one the planner
 *                derives from that shape for this capability kind, or null when no profile matches
 *   capability   optional identity override for families whose identity does not come from a manifest
 *   provenance   optional authoritative identities the CALLER holds (a composition's capabilitySource):
 *                { sourceRevision, capabilityId, genomeId, irId }. Each fills only a null the verifier
 *                could not derive itself; none is discovered here.
 */
export function attachProofEnvelope(report, { manifest = null, proof = null, source, destination = null, capability = null, provenance = null, createdAt = null }) {
  if (destination !== null && !destination.revision) {
    return { ...report, proofEnvelope: null, proofEnvelopeReason: 'destination-revision-unavailable', proofEnvelopeDetail: destination.reason || null };
  }
  const derived = capability ?? capabilityIdentity(manifest);
  const identity = { ...derived, id: derived.id ?? provenance?.capabilityId ?? null, genomeId: derived.genomeId ?? provenance?.genomeId ?? null, irId: derived.irId ?? provenance?.irId ?? null };
  const hostProfile = destination === null ? null : destination.hostProfile ?? (destination.fingerprint ? profileFor(destination.fingerprint, identity.kind)?.id ?? null : null);
  const built = buildProofEnvelope({
    report,
    capability: identity,
    contract: { id: proof?.contractId ?? null, version: proof?.contractVersion ?? null },
    source: { revision: source?.revision ?? provenance?.sourceRevision ?? null },
    destination: destination === null ? null : { revision: destination.revision, hostProfile, adaptation: destination.adaptation ?? null },
    verifier: { core: graftCoreVersion() },
    createdAt: createdAt ?? report.finishedAt ?? null,
  });
  return { ...report, proofEnvelope: built.envelope, ...(built.envelope ? {} : { proofEnvelopeReason: built.reason, proofEnvelopeDetail: built.detail }) };
}

/**
 * The persisted-report pipeline, in the only order that keeps a proof honest: redact the report
 * FIRST, then build the envelope over the redacted facts. The digest therefore commits to exactly
 * the representation that is persisted; no later redaction pass can find anything to change (the
 * envelope carries digests, identifiers, versions and revisions only), so nothing mutates a proof
 * after its identity is fixed. Never build an envelope and redact afterwards.
 */
export function finishReport(report, identity) {
  return attachProofEnvelope(redactSecrets(report), identity);
}
