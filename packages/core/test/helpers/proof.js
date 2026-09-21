// Proof Integrity 0.1 test helper: a real, intact proof envelope for a synthetic verification, built
// through the real adapter and kernel, and persisted in the proof store under the current GRAFT_HOME.
import { decideHttpSuite, buildProofEnvelope } from '../../../proof-adapter/src/index.js';
import { storeProof } from '../../src/laboratory/proof-store.js';

export const httpResult = (id, outcome = 'passed', step = 'GET /health') => ({ id, required: true, outcome, steps: [{ name: 'probe', request: step, status: outcome === 'failed' ? 500 : 200, checks: [{ name: 'status', ok: outcome !== 'failed' }] }] });

/** A decided report of the shape the HTTP verifier produces (verdict, root, evidence identities, cases). */
export function decidedReport(results = [httpResult('a'), httpResult('b')], { serverReady = true } = {}) {
  const d = decideHttpSuite({ results, serverReady });
  return { verdict: d.verdict, proofRoot: d.proofRoot, proofEvidence: d.evidence, proofAuthority: { ...d.authority, cufVerdict: d.cufVerdict }, results: results.map((r) => ({ id: r.id, kind: 'http', required: true, outcome: r.outcome })), finishedAt: '2026-09-13T12:00:00.000Z' };
}

/** An envelope bound to `revision` for `capability` (defaults are a hosted-auth-shaped identity). */
export function envelopeFor({ revision, capability = {}, source = null, report = decidedReport(), hostProfile = 'esm-node-http-central' } = {}) {
  const built = buildProofEnvelope({
    report,
    capability: { id: 'sha256:' + 'a'.repeat(64), slug: 'hosted-authentication', kind: 'hosted-session-auth', form: 'service', genomeId: null, irId: null, ...capability },
    contract: { id: 'sha256:' + 'c'.repeat(64), version: '1.0.0' },
    source: { revision: source },
    destination: revision === null ? null : { revision, hostProfile },
    verifier: { core: '0.0.0-test' },
    createdAt: '2026-09-13T12:00:01.000Z',
  });
  if (!built.envelope) throw new Error(`no envelope: ${built.reason} (${built.detail})`);
  return built.envelope;
}

/** Persist an envelope for `revision` and return the ledger-side proof reference for it. */
export function storedProofFor(options) {
  const envelope = envelopeFor(options);
  storeProof(envelope);
  return { envelopeSchema: envelope.schema, envelopeDigest: envelope.digest, envelope };
}
