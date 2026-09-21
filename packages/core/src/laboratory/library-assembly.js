// Assembly Execution for a capability in LIBRARY form.
//
// This is not a second execution engine. Assembly Execution still owns the states, the steps, the
// receipts and the ledger; what lives here is the ordered sequence of operations that a library
// capability needs instead of a service transplant, plus the support recheck that must happen
// before any of it runs.
//
// The order is the point. Host preservation captures its baseline BEFORE anything is written (a
// baseline taken afterwards compares the changed application with itself and passes by
// construction — this went wrong once in 0.4a), and the artifact's identity is confirmed before
// any write, not after. Encoding the order here means a caller cannot get it wrong.
//
// Nothing here decides a verdict. `verifyAdaptedLibraryCapability` returns what `decideVerdict`
// said, and this module passes it through untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { buildHostModel } from '../engine/host.js';
import { discoverCapabilities } from '../harvest/index.js';
import { hostPreservationTests } from '../plan/index.js';
import { libraryHostAdaptationSupport, checkArtifactIdentity, adaptLibraryCapability, applyLibraryAdaptation, libraryArtifactOf } from '../adapt/library-host.js';
import { verifyAdaptedLibraryCapability, captureAdaptationHostBaseline, verifyHostPreservation } from '../adapt/verify.js';

const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });

/** Where the library's own artifact has to be read from: the organ holds sections, not bytes. */
export function librarySourceRoot(manifest) {
  const root = manifest?.provenance?.sourceProject?.root || null;
  if (!root) throw fail('library-source-unknown', 'The organ records no source checkout for the library artifact, so the verified artifact cannot be carried across.');
  if (!fs.existsSync(root)) throw fail('library-source-missing', `The source checkout that holds the verified artifact is no longer at ${root}.`, 'Restore the source project, or re-harvest the capability from where it now lives.');
  return root;
}

/**
 * Re-establish, at execution time, everything the plan assumed. A plan that said
 * READY_TO_ASSEMBLE is never taken at its word.
 *
 * Returns `{ ok, blocked, stale, reasons, support }`. `stale` means the world moved (the host is
 * not the shape that was planned, the capability is not the one that was selected); `blocked`
 * means the capability or destination is not something GRAFT can adapt at all.
 */
export function recheckLibraryAdaptationSupport({ plan, manifest, engine, hostFingerprint, plannedCapabilityId = null }) {
  const stale = [], blocked = [];
  const host = { profile: hostFingerprint?.profile || null, moduleSystem: hostFingerprint?.moduleSystem || null };

  // The host that actually exists must be the shape the plan was made for.
  if (plan?.host?.profile && host.profile !== plan.host.profile) stale.push(`the host is ${host.profile || 'an unknown shape'}, but the plan was made for ${plan.host.profile}`);
  if (plan?.host?.moduleSystem && host.moduleSystem !== plan.host.moduleSystem) stale.push(`the host module system is ${host.moduleSystem || 'unknown'}, but the plan was made for ${plan.host.moduleSystem}`);

  // The capability must still be the one the plan selected, and still a library.
  const actualCapabilityId = engine?.genome?.identity?.capabilityId || null;
  if (plannedCapabilityId && actualCapabilityId !== plannedCapabilityId) stale.push(`the banked capability is ${actualCapabilityId || 'absent'}, not the ${plannedCapabilityId} the plan selected`);
  const form = manifest?.identity?.implementationForm || null;
  if (form !== 'library') blocked.push(`the capability is now ${form || 'of an unknown form'}, not a library; the library adaptation does not apply to it`);

  // Source verification must still be the authoritative VERIFIED it was harvested as. This is not
  // what makes the destination supported — it is a precondition for adapting anything at all.
  const sourceVerdict = manifest?.provenance?.verifiedInSource?.verdict || null;
  if (sourceVerdict !== 'VERIFIED') blocked.push(`the library's own source verification is ${sourceVerdict || 'absent'}; only a VERIFIED capability is adapted`);

  // And the structural adaptation support must still hold, from the one authority that defines it.
  const support = libraryHostAdaptationSupport({ manifest, host });
  if (!support.supported) blocked.push(...support.checks.filter((c) => c.ok === false).map((c) => c.detail));

  return { ok: stale.length === 0 && blocked.length === 0, stale, blocked, reasons: [...stale, ...blocked], support, host, actualCapabilityId };
}

/**
 * Run the library adaptation against a prepared candidate worktree, in the only safe order.
 *
 * The caller owns the worktree (it comes from `prepareTransplant`), the step bookkeeping and the
 * ledger. This performs the operations and reports what happened, including the honest re-index
 * result even when the detectors recognise nothing.
 */
export async function runLibraryAdaptation({ manifest, sourceRoot, worktreePath, host, timeoutMs = 15000, onPhase = () => {} }) {
  const worktree = path.resolve(worktreePath);
  const artifact = libraryArtifactOf(manifest);

  // 1. HOST PRESERVATION BASELINE — before anything is written. Mandatory, and first.
  onPhase('Recording the host’s own behaviour');
  const beforeFingerprint = fingerprintProject(worktree);
  const beforeProfile = buildHostModel(beforeFingerprint).constraints.adaptationProfile;
  const probes = hostPreservationTests(beforeFingerprint, manifest);
  const baseline = await captureAdaptationHostBaseline({ destinationRoot: worktree, tests: probes, timeoutMs });

  // 2. ARTIFACT IDENTITY — the capability that gets added must be the one that was proven.
  onPhase('Checking the verified artifact');
  const identity = checkArtifactIdentity({ manifest, sourceRoot });
  if (!identity.matched) {
    return { admitted: false, stage: 'artifact-identity', reason: identity.reason, detail: identity.detail,
      identity: { matched: false, expected: identity.expected, actual: identity.actual, entry: artifact.entry },
      baseline: { captured: baseline.captured, reason: baseline.reason, observed: baseline.observed },
      adaptation: null, receipt: null, verification: null, preservation: null, reindex: null, filesWritten: [] };
  }

  // 3. ADAPT — plan (checks identity again, and support) then write, into the worktree only.
  onPhase(`Adding ${manifest.identity.name}`);
  const adaptation = adaptLibraryCapability({ manifest, sourceRoot, host });
  const receipt = applyLibraryAdaptation({ plan: adaptation, destinationRoot: worktree });

  // 4. DESTINATION VERIFICATION — the generated adapter and the vendored artifact, in this host.
  onPhase(`Verifying ${manifest.identity.name} in the host`);
  const verification = await verifyAdaptedLibraryCapability({ plan: adaptation, destinationRoot: worktree, timeoutMs });

  // 5. HOST PRESERVATION — the probes the baseline adjusted, against the adapted application.
  onPhase('Checking the host still behaves as it did');
  const preservation = await verifyHostPreservation({ destinationRoot: worktree, tests: baseline.tests, timeoutMs });

  // 6. RE-INDEX — recorded honestly. An embedded library inside an HTTP application does not look
  // like a standalone library package, so the detectors are not expected to recognise it. That is
  // reported as it is; the authoritative evidence is the adaptation plus the verification above.
  onPhase('Re-indexing the assembled application');
  const after = fingerprintProject(worktree);
  const hostAfter = buildHostModel(after);
  const observed = discoverCapabilities(after).map((c) => ({ id: c.id, category: c.category, confidence: c.confidence, harvestable: c.harvestable }));
  const detectorObserved = observed.some((c) => c.category === manifest.identity.category);
  const reindex = {
    hostId: hostAfter.hostId, profile: hostAfter.constraints.adaptationProfile, routes: hostAfter.routing.routes.length,
    observedCapabilities: observed,
    capabilityObserved: detectorObserved,
    detectorObservation: detectorObserved ? 'OBSERVED' : 'NOT_OBSERVED',
    // Said plainly, so nobody reads the absence as a failure or as a reason to distrust the proof.
    detectorNote: detectorObserved ? null
      : `The independent detectors do not recognise ${manifest.identity.category} in this application: they look for a standalone library package, and this is an HTTP application with the library embedded in it. Presence rests on GRAFT's own assembly evidence, which is stronger: GRAFT carried the verified artifact across, generated the adapter, and the destination contract passed.`,
    hostShapePreserved: hostAfter.constraints.adaptationProfile === beforeProfile,
    profileBefore: beforeProfile,
  };

  return {
    // An UNCAPTURED baseline is not a pass. When the host could not be booted beforehand, the
    // preservation probes keep their generic expectations, so they can succeed without ever having
    // compared the application with how it really behaved. That is the 0.4a false result, and it is
    // refused here rather than admitted quietly.
    admitted: verification.verdict === 'VERIFIED' && preservation.failed === 0 && baseline.captured === true,
    ...(baseline.captured ? {} : { stage: 'host-preservation-baseline', reason: 'baseline-not-captured', detail: `The host's own behaviour could not be recorded before the adaptation (${baseline.reason}), so host preservation cannot be proven.` }),
    identity: { matched: true, expected: identity.expected, actual: identity.actual, sha256: adaptation.artifactIdentity.sha256, entry: artifact.entry, byteIdentical: true },
    baseline: { captured: baseline.captured, reason: baseline.reason, observed: baseline.observed },
    adaptation, receipt, verification, preservation, reindex,
    filesWritten: receipt.files.map((f) => f.path),
  };
}
