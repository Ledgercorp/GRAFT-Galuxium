const SCALAR = (value) => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
function malformed(run) {
    if (!run || typeof run !== "object")
        return "the run is not an object";
    if (!Array.isArray(run.observations))
        return "the run carries no observations list";
    if (run.operationalError !== null && typeof run.operationalError !== "string")
        return "the operational error is not a string";
    if (!Array.isArray(run.evidence))
        return "the run carries no evidence list";
    const seen = new Set();
    for (const observation of run.observations) {
        if (!observation || typeof observation !== "object")
            return "an observation is not an object";
        if (typeof observation.id !== "string" || observation.id.length === 0)
            return "an observation has no id";
        if (seen.has(observation.id))
            return `observation ${observation.id} is recorded twice`;
        seen.add(observation.id);
        if (!SCALAR(observation.value))
            return `observation ${observation.id} has a non-scalar value`;
        if (observation.selected !== null && typeof observation.selected !== "string")
            return `observation ${observation.id} has a malformed selection`;
    }
    return null;
}
function describe(value) {
    return JSON.stringify(value);
}
function contradiction(expectation, observation, observations) {
    switch (expectation.kind) {
        case "value":
            return Object.is(observation.value, expectation.equals) ? null
                : `${observation.id} produced ${describe(observation.value)}, expected ${describe(expectation.equals)}`;
        case "selection":
            return observation.selected === expectation.equals ? null
                : `${observation.id} selected ${observation.selected === null ? "nothing" : observation.selected}, expected ${expectation.equals}`;
        case "consistent": {
            const earlier = observations.find((candidate) => candidate.id === expectation.with);
            if (!earlier)
                return null; // absence is uncertainty, handled by the caller
            return Object.is(earlier.value, observation.value) && earlier.selected === observation.selected ? null
                : `${observation.id} did not repeat ${earlier.id}: ${describe(observation.value)}/${observation.selected ?? "nothing"} vs ${describe(earlier.value)}/${earlier.selected ?? "nothing"}`;
        }
        default:
            return null;
    }
}
/**
 * Decide one observation case.
 *
 * Expectations are taken in declared order. A contradiction between an expectation and the
 * observation it names is FAIL and outranks every later uncertainty (a deterministic
 * contradiction is a fact, not a doubt). An expectation whose observation does not exist is
 * INCONCLUSIVE: either execution stopped first (the operational error says why) or nothing was
 * observed; neither is a pass. A malformed run and missing required evidence are INCONCLUSIVE.
 * PASS only when every expectation is satisfied by an observation that exists, no operational
 * error interrupted the run, and every required evidence kind is present.
 */
export function evaluateObservationCase(testCase, run) {
    const result = (verdict, reason, evidence = []) => Object.freeze({ testCaseId: testCase.id, expectationId: testCase.expectationId, verdict, reason, evidence: Object.freeze([...evidence]) });
    const shape = malformed(run);
    if (shape !== null)
        return result("INCONCLUSIVE", `Malformed observation run: ${shape}`);
    if (!Array.isArray(testCase.expectations))
        return result("INCONCLUSIVE", "Malformed observation case: no expectations list", run.evidence);
    if (testCase.expectations.length === 0)
        return result("INCONCLUSIVE", "The case declares no expectation, so nothing could be proven", run.evidence);
    for (const expectation of testCase.expectations) {
        if (!expectation || typeof expectation !== "object" || typeof expectation.observation !== "string") {
            return result("INCONCLUSIVE", "Malformed observation case: an expectation names no observation", run.evidence);
        }
        const observation = run.observations.find((candidate) => candidate.id === expectation.observation);
        if (!observation) {
            return result("INCONCLUSIVE", run.operationalError !== null
                ? `Operational error before ${expectation.observation} was observed: ${run.operationalError}`
                : `Observation ${expectation.observation} is unavailable`, run.evidence);
        }
        if (expectation.kind === "consistent" && !run.observations.some((candidate) => candidate.id === expectation.with)) {
            return result("INCONCLUSIVE", `Observation ${expectation.with}, which ${expectation.observation} must repeat, is unavailable`, run.evidence);
        }
        if (!["value", "selection", "consistent"].includes(expectation.kind)) {
            return result("INCONCLUSIVE", `Malformed observation case: unsupported expectation kind ${String(expectation.kind)}`, run.evidence);
        }
        const contradicted = contradiction(expectation, observation, run.observations);
        if (contradicted !== null)
            return result("FAIL", contradicted, run.evidence);
    }
    if (run.operationalError !== null) {
        return result("INCONCLUSIVE", `Operational error: ${run.operationalError}`, run.evidence);
    }
    const present = new Set(run.evidence.map((item) => item.kind));
    const missing = (testCase.requiredEvidenceKinds ?? []).filter((kind) => !present.has(kind));
    if (missing.length > 0)
        return result("INCONCLUSIVE", `Required evidence is missing: ${missing.join(", ")}`, run.evidence);
    return result("PASS", `Every declared expectation was satisfied by the observed values`, run.evidence);
}
//# sourceMappingURL=observation.js.map