// Destination-side proof for an adapted library capability.
//
// This module composes the verification machinery GRAFT already has; it implements no checking of
// its own and contains no verdict vocabulary. `runLibrarySuite` exercises the generated adapter in
// a child process and hands its results to `decideVerdict`; `captureHostBaseline` and
// `runAcceptanceSuite` are the same host-preservation path every transplant uses.
//
// It is deliberately a separate module from the adaptation itself: `adapt/library-host.js` cannot
// import a verdict from here, so an adaptation cannot declare its own success.
import path from 'node:path';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { runLibrarySuite } from '../verify/library-runner.js';
import { finishReport, revisionAuthority } from '../verify/proof-envelope.js';
import { runAcceptanceSuite, captureHostBaseline, withDouble } from '../verify/index.js';
import { resolveRuntime } from '../verify/runtime.js';

/**
 * Prove the adapted capability inside the destination.
 *
 * What runs is the GRAFT-generated adapter, which loads the vendored third-party artifact — so a
 * pass is evidence about the destination, not a restatement of the source proof. The verdict comes
 * from `decideVerdict` inside the runner; nothing here can change it.
 */
export async function verifyAdaptedLibraryCapability({ plan, destinationRoot, timeoutMs = 15000, now = () => new Date().toISOString(), provenance = null }) {
  // The destination revision this proof is about, read before the suite runs (see proof-envelope.js).
  const destinationRevision = revisionAuthority(destinationRoot);
  const report = await runLibrarySuite({
    sourceRoot: destinationRoot,
    artifact: { entry: plan.verifyThrough.entry, moduleSystem: plan.verifyThrough.moduleSystem, exportName: plan.verifyThrough.exportName },
    tests: plan.verificationContract,
    timeoutMs, now,
  });
  return finishReport({
    ...report,
    // What this proof is about, so it can never be mistaken for the source proof.
    proofOf: 'destination-adaptation', adaptation: plan.adaptation, method: plan.method,
    destination: { root: destinationRoot, profile: plan.host.profile, adapter: plan.verifyThrough.entry, artifact: plan.artifactIdentity.destinationPath },
  }, {
    // The plan carries the capability's slug, kind and form but not its engine ids or the source
    // revision; the caller that holds them (a composition's capabilitySource) passes them as
    // `provenance`, otherwise they stay null rather than being looked up here. The destination
    // contract has no engine contract id: the envelope binds the cases that ran. The adaptation and
    // the artifact's content identity are what this destination proof is about, bound with the revision.
    capability: { id: null, slug: plan.capability?.slug ?? null, kind: plan.capability?.kind ?? null, form: plan.capability?.implementationForm ?? 'library', genomeId: null, irId: null },
    proof: null, source: { revision: null }, provenance,
    destination: { ...destinationRevision, hostProfile: plan.host?.profile ?? null, adaptation: { id: plan.adaptation, artifactSha256: plan.artifactIdentity?.sha256 ?? null } },
  });
}

/**
 * Host preservation for the destination, baseline first.
 *
 * `captureHostBaseline` must be called on the destination BEFORE any adaptation file is written:
 * it records what each probe actually answers and rewrites the probes to expect that. Calling it
 * afterwards would compare the changed application with itself and pass by construction.
 */
export async function captureAdaptationHostBaseline({ destinationRoot, tests, entrypoint = null, timeoutMs = 15000 }) {
  const fp = fingerprintProject(path.resolve(destinationRoot));
  return captureHostBaseline(path.resolve(destinationRoot), { entrypoint: entrypoint ?? fp.entrypoint, tests, timeoutMs });
}

/**
 * Run the (baseline-adjusted) host-preservation probes against the adapted destination.
 *
 * `doublesFor`: manifests of service capabilities the destination now holds. An application that
 * holds a hosted capability only boots with that capability's provider environment, so the probes
 * run with the same provider doubles its verifier uses — otherwise the application exits before
 * it listens, no probe runs, and nothing is proven (the report then says so: zero tests).
 */
export async function verifyHostPreservation({ destinationRoot, tests, entrypoint = null, timeoutMs = 15000, doublesFor = [] }) {
  const abs = path.resolve(destinationRoot);
  const fp = fingerprintProject(abs);
  const runtime = resolveRuntime({ ...fp, entrypoint: entrypoint ?? fp.entrypoint });
  const withDoubles = async (manifests, env, run) => (manifests.length ? withDouble(manifests[0], (double, more) => withDoubles(manifests.slice(1), { ...env, ...more }, run)) : run(env));
  const report = await withDoubles(doublesFor, {}, (env) => runAcceptanceSuite({ runtime: runtime.ok ? { ...runtime, env: { ...(runtime.env || {}), ...env } } : runtime, tests, timeoutMs }));
  const results = (report.results || []).filter((r) => r.id.startsWith('host.'));
  return {
    verdict: report.verdict, rationale: report.rationale, runtime: report.runtime, results,
    tests: results.length, passed: results.filter((r) => r.outcome === 'passed').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
    inconclusive: results.filter((r) => r.outcome === 'inconclusive').length,
    proofOf: 'host-preservation',
  };
}
