import { canonicalJson, sha256 } from "./contracts.js";
export class EvidenceCaptureError extends Error {
    name = "EvidenceCaptureError";
}
/**
 * Evidence records what happened. It never decides a verdict, so no verdict
 * vocabulary may enter an evidence item.
 */
const FORBIDDEN_METADATA_KEYS = new Set(["verdict", "pass", "fail", "inconclusive", "result"]);
/** Header names whose values are credentials and must never be captured. */
const CREDENTIAL_HEADERS = new Set(["authorization", "apikey", "cookie", "set-cookie", "x-api-key"]);
/** Shapes that indicate credential material regardless of where they appear. */
const CREDENTIAL_PATTERNS = Object.freeze([
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
    /sbp_[0-9a-f]{40}/, // Supabase PAT
    /sb_(secret|publishable)_[A-Za-z0-9_-]{10,}/ // Supabase API keys
]);
function assertNoCredentialMaterial(value, where) {
    const rendered = typeof value === "string" ? value : JSON.stringify(value ?? "");
    for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(rendered)) {
            throw new EvidenceCaptureError(`Credential material detected in ${where}; refusing to capture`);
        }
    }
}
function freezeMetadata(metadata, where) {
    const out = {};
    for (const [key, value] of Object.entries(metadata)) {
        if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
            throw new EvidenceCaptureError(`Evidence may not carry a verdict field (${key}); the kernel decides`);
        }
        if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            // Nested structures are how protected row content leaks into evidence.
            throw new EvidenceCaptureError(`Evidence metadata ${key} must be a scalar or null`);
        }
        assertNoCredentialMaterial(value, `${where}.${key}`);
        out[key] = value;
    }
    return Object.freeze(out);
}
/**
 * Content-addresses an evidence item over its material facts.
 *
 * `capturedAt` is excluded deliberately: it is observation metadata, not a
 * material fact. Including it would make two captures of the same observation
 * produce different digests, which would move the evidence root and, through it,
 * a seal's applicability, whenever the clock advanced. This is the same rule
 * applied to the discovery and confirmed-intent fingerprints.
 */
export function evidenceDigest(kind, metadata) {
    return sha256(canonicalJson({ kind, metadata }));
}
export function captureEvidence(input) {
    const metadata = freezeMetadata(input.metadata, `evidence(${input.kind})`);
    return Object.freeze({
        kind: input.kind,
        digest: evidenceDigest(input.kind, metadata),
        capturedAt: input.capturedAt,
        redacted: true,
        metadata
    });
}
/** Strips query values, keeping only the resource path and parameter names. */
function safeUrl(url) {
    const parsed = new URL(url);
    return { path: parsed.pathname, params: [...parsed.searchParams.keys()].sort().join(",") };
}
/**
 * Summarizes a provider response without capturing protected values.
 *
 * The FAIL case has to prove that a forbidden row *was* exposed. Recording the
 * row count and the returned column names proves exposure; recording the values
 * would put the very data the boundary was meant to protect into evidence.
 */
export function summarizeRows(body) {
    if (!Array.isArray(body))
        return { rowCount: 0, columns: "", exposed: false };
    const columns = new Set();
    for (const row of body) {
        if (row !== null && typeof row === "object" && !Array.isArray(row)) {
            for (const key of Object.keys(row))
                columns.add(key);
        }
    }
    return { rowCount: body.length, columns: [...columns].sort().join(","), exposed: body.length > 0 };
}
/**
 * Captures one HTTP exchange as redacted evidence. Credential headers are
 * dropped by name rather than by value, and the response body is reduced to
 * counts and column names.
 */
export function captureHttpEvidence(input) {
    const { exchange } = input;
    for (const [name, value] of Object.entries(exchange.headers)) {
        if (!CREDENTIAL_HEADERS.has(name.toLowerCase()))
            assertNoCredentialMaterial(value, `header ${name}`);
    }
    const { path, params } = safeUrl(exchange.url);
    const rows = summarizeRows(exchange.body);
    const metadata = {
        method: exchange.method,
        path,
        queryParameters: params,
        status: exchange.status,
        rowCount: rows.rowCount,
        returnedColumns: rows.columns,
        ...input.extra
    };
    if (input.actor !== undefined) {
        // Attribution comes from the trusted step 6 boundary, and names the actor
        // without naming the means of becoming that actor.
        metadata.actorClass = input.actor.actorClass;
        metadata.actorId = input.actor.actorId;
        metadata.actorAuthentication = input.actor.authentication;
        metadata.actorClaimsSubject = input.actor.claimsSubject;
        metadata.actorTenantId = input.actor.tenantId;
        metadata.actorEnvironmentId = input.actor.environmentId;
    }
    return captureEvidence({ kind: input.kind, capturedAt: input.capturedAt, metadata });
}
/**
 * Classifies a provider response into an authorization decision.
 *
 * A transport or provider failure is never a denial: an empty result caused by a
 * 500 or a network error says nothing about authorization, so it becomes ERROR
 * and the kernel renders INCONCLUSIVE rather than mistaking silence for a
 * boundary holding.
 */
export function classifyDecision(status, body, transportError) {
    if (transportError !== null)
        return "ERROR";
    if (status === 401 || status === 403)
        return "DENIED";
    if (status >= 400)
        return "ERROR";
    if (status < 200)
        return "ERROR";
    if (!Array.isArray(body))
        return "ERROR";
    return body.length > 0 ? "ALLOWED" : "DENIED";
}
//# sourceMappingURL=capture.js.map