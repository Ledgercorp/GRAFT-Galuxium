import { canonicalJson, sha256 } from "./contracts.js";
import { cleanupIndependentlyVerified } from "./cleanup.js";
function missingEvidence(testCase, evidence) {
    const present = new Set(evidence.map((item) => item.kind));
    return testCase.requiredEvidenceKinds.filter((kind) => !present.has(kind));
}
export function evaluateCase(testCase, observation) {
    let verdict;
    let reason;
    const missing = missingEvidence(testCase, observation.evidence);
    const cleanup = cleanupIndependentlyVerified(observation.cleanupVerification);
    // A deterministic boundary break outranks every later uncertainty
    // (NON_NEGOTIABLES.md 9). It requires a verified setup, a real observed
    // decision, and the request/response evidence that records it. Cleanup,
    // drift, and other missing proofs gate PASS only: they can never repair or
    // erase a proven FAIL.
    const present = new Set(observation.evidence.map((item) => item.kind));
    const observedDecision = observation.operationalError === null && observation.setupVerified &&
        observation.actual !== "ERROR" && present.has("REQUEST") && present.has("RESPONSE");
    const matched = (testCase.expected === "ALLOW" && observation.actual === "ALLOWED") ||
        (testCase.expected === "DENY" && observation.actual === "DENIED");
    if (observedDecision && !matched) {
        verdict = "FAIL";
        reason = `Observed ${observation.actual} contradicted expected ${testCase.expected}`;
    }
    else if (observation.operationalError !== null) {
        verdict = "INCONCLUSIVE";
        reason = `Operational error: ${observation.operationalError}`;
    }
    else if (!observation.setupVerified) {
        verdict = "INCONCLUSIVE";
        reason = "Controlled fixture setup was not verified";
    }
    else if (observation.driftDetected) {
        verdict = "INCONCLUSIVE";
        reason = "Target schema or policy drift was detected during execution";
    }
    else if (!cleanup.verified) {
        // Cleanup success cannot be asserted by the component that performed it.
        // Only an authentic, independent verification with nothing remaining counts.
        verdict = "INCONCLUSIVE";
        reason = cleanup.reason;
    }
    else if (missing.length > 0) {
        verdict = "INCONCLUSIVE";
        reason = `Required evidence is missing: ${missing.join(", ")}`;
    }
    else if (observation.actual === "ERROR") {
        verdict = "INCONCLUSIVE";
        reason = "The target returned an unclassified execution error";
    }
    else {
        verdict = "PASS";
        reason = `Observed ${observation.actual} matched expected ${testCase.expected}`;
    }
    return Object.freeze({
        testCaseId: testCase.id,
        expectationId: testCase.expectationId,
        verdict,
        reason,
        evidence: Object.freeze([...observation.evidence]),
        setupVerified: observation.setupVerified,
        // Derived from independent verification, never from the executor's flag.
        cleanupVerified: cleanup.verified,
        driftDetected: observation.driftDetected
    });
}
export function aggregateVerdict(results) {
    if (results.length === 0)
        return "INCONCLUSIVE";
    if (results.some((result) => result.verdict === "FAIL"))
        return "FAIL";
    if (results.some((result) => result.verdict === "INCONCLUSIVE"))
        return "INCONCLUSIVE";
    return "PASS";
}
export function evidenceRoot(results) {
    // Content-addressed: identical digests are the same fact captured twice, not
    // two independent facts. Deduplicating keeps a retry that recaptures the same
    // observation from inflating the root, so recovery cannot manufacture
    // additional evidence authority.
    const leaves = [...new Set(results.flatMap((result) => result.evidence.map((item) => item.digest)))].sort();
    return sha256(canonicalJson(leaves));
}
export * from "./capture.js";
export * from "./cleanup.js";
export * from "./observation.js";
//# sourceMappingURL=index.js.map