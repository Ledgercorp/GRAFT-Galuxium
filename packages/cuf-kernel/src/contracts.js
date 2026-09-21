import { createHash } from "node:crypto";
export const VERDICTS = ["PASS", "FAIL", "INCONCLUSIVE"];
export const KNOWLEDGE_STATES = ["OBSERVED", "INFERRED", "CONFIRMED"];
export const CAPABILITY_STATES = ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNKNOWN"];
export const ACTOR_CLASSES = ["ALICE", "BOB", "ANONYMOUS"];
function canonicalizeValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalizeValue);
    if (value !== null && typeof value === "object") {
        const record = value;
        return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalizeValue(record[key])]));
    }
    return value;
}
export function canonicalJson(value) {
    return JSON.stringify(canonicalizeValue(value));
}
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
export function assertNever(value) {
    throw new Error(`Unhandled discriminant: ${String(value)}`);
}
//# sourceMappingURL=index.js.map