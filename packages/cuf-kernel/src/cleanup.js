import { captureEvidence } from "./capture.js";
export class CleanupVerificationError extends Error {
    name = "CleanupVerificationError";
}
/**
 * Verification authority is held by identity in a module-private registry, the
 * same pattern used for confirmed intent and actor sessions. A structurally
 * identical object built by the executor, a caller, or a model is not a member
 * and is treated as unverified.
 */
const AUTHENTIC_VERIFICATIONS = new WeakSet();
function requiredString(value, field) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new CleanupVerificationError(`${field} is required`);
    }
    return value;
}
function nonNegativeCount(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new CleanupVerificationError(`${field} must be a non-negative integer`);
    }
    return value;
}
/**
 * Creates the only route to an authentic cleanup verification.
 *
 * Inability to inspect is recorded as an inspection failure, never as success:
 * a verifier that cannot reach the provider after cleanup yields
 * `inspectionFailed: true` with null counts, which the kernel renders
 * INCONCLUSIVE.
 */
export function createCleanupVerifier(inspector, clock = () => new Date()) {
    if (typeof inspector?.inspect !== "function") {
        throw new CleanupVerificationError("A cleanup verifier requires an inspection capability");
    }
    return Object.freeze({
        async verify(binding, signal) {
            const tenantId = requiredString(binding?.tenantId, "binding.tenantId");
            const environmentId = requiredString(binding?.environmentId, "binding.environmentId");
            const fixtureRun = requiredString(binding?.fixtureRun, "binding.fixtureRun");
            const scoped = { tenantId, environmentId, fixtureRun };
            const capturedAt = clock().toISOString();
            let inspection = null;
            let failureReason = null;
            try {
                const raw = await inspector.inspect(scoped, signal);
                inspection = {
                    fixtureRows: nonNegativeCount(raw?.fixtureRows, "inspection.fixtureRows"),
                    actorIdentities: nonNegativeCount(raw?.actorIdentities, "inspection.actorIdentities")
                };
            }
            catch (error) {
                failureReason = error instanceof Error ? error.message : "Unknown inspection failure";
            }
            const remainingFixtureRows = inspection?.fixtureRows ?? null;
            const remainingActorIdentities = inspection?.actorIdentities ?? null;
            const remainingResources = inspection === null ? null : inspection.fixtureRows + inspection.actorIdentities;
            const evidence = captureEvidence({
                kind: "CLEANUP_PROOF",
                capturedAt,
                metadata: {
                    tenantId,
                    environmentId,
                    fixtureRun,
                    inspectionFailed: inspection === null,
                    failureReason,
                    remainingFixtureRows,
                    remainingActorIdentities,
                    remainingResources
                }
            });
            const verification = Object.freeze({
                tenantId,
                environmentId,
                fixtureRun,
                remainingResources,
                remainingFixtureRows,
                remainingActorIdentities,
                inspectionFailed: inspection === null,
                failureReason,
                evidence
            });
            AUTHENTIC_VERIFICATIONS.add(verification);
            return verification;
        }
    });
}
export function isAuthenticCleanupVerification(verification) {
    return verification !== null && verification !== undefined && AUTHENTIC_VERIFICATIONS.has(verification);
}
/**
 * The single question the kernel asks. True only for an authentic verification
 * whose inspection succeeded and found nothing remaining, and only when it is
 * bound to the tenant, environment, and run under evaluation.
 */
export function cleanupIndependentlyVerified(verification, binding) {
    if (!isAuthenticCleanupVerification(verification)) {
        return { verified: false, reason: "Controlled fixture cleanup was not independently verified" };
    }
    const v = verification;
    if (binding !== undefined) {
        if (v.tenantId !== binding.tenantId || v.environmentId !== binding.environmentId || v.fixtureRun !== binding.fixtureRun) {
            return { verified: false, reason: "Cleanup verification is bound to a different tenant, environment, or run" };
        }
    }
    if (v.inspectionFailed) {
        return { verified: false, reason: `Cleanup verification could not inspect the target: ${v.failureReason ?? "unknown"}` };
    }
    if (v.remainingResources === null || v.remainingResources > 0) {
        return {
            verified: false,
            reason: `Cleanup is incomplete: ${v.remainingFixtureRows ?? "?"} fixture row(s) and ${v.remainingActorIdentities ?? "?"} actor identit(y/ies) remain`
        };
    }
    return { verified: true, reason: "Independent inspection found no remaining resources" };
}
//# sourceMappingURL=cleanup.js.map