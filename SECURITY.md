# Security boundaries

GRAFT runs source and destination code to observe behavior. This code has the current user's OS permissions, filesystem access, and network access. Environment filtering and process cleanup are containment measures, not a sandbox. Use trusted projects or an independently isolated environment.

## Guardrails

- Generated JavaScript uses validated literals, identifiers, routes, cookie fields, and numeric ranges. JavaScript entrypoints are parsed before edits; unsupported wiring is refused.
- Apply checks the full write set before creating branches or files. Symlinks below the destination root, hard-linked files, traversal, Git internals, existing generated files, and receipt collisions are refused. New files use exclusive creation. Concurrent hostile filesystem replacement is outside this protection; do not allow another process to mutate the destination during apply.
- Runtime resolution checks real entrypoint containment and terminates Node option parsing. Arbitrary package start scripts are not executed.
- Child processes receive a restricted environment. POSIX process groups are terminated even when the leader exits early, escalating to SIGKILL for surviving descendants. A malicious process can escape its group; Windows currently only terminates the direct child.
- HTTP tests follow no redirects, target the ephemeral local server, and have per-step timeouts. Response bodies are limited to 1 MiB; stdout/stderr capture is limited to 64 KiB each.
- Imported manifests and acceptance assertions are validated. VERIFIED source evidence must match required test IDs and counts. This is structural validation, not signing or a guarantee against a coordinated forged manifest and evidence.
- Recognized credential formats are redacted from captured evidence. Pattern matching cannot identify every possible secret. Do not log credentials in applications under verification.

## Browser workspace

The dashboard binds to IPv4 loopback only. Every API request requires a random per-process token supplied through the same-origin page; the server validates Host, Origin, and Fetch Metadata and does not grant CORS access. A restrictive content security policy blocks embedding, external scripts, and unapproved resource origins. Static assets are explicitly allowlisted. Request bodies are capped at 16 KiB. This protects against other websites, not against applications or users already able to access this machine.

The browser selects registered projects by opaque identifiers. It cannot submit generated code, arbitrary output paths, or CLI safety bypass flags. Apply consumes an in-memory preview, expires previews after 15 minutes, rechecks the source contract and destination contents, and enforces the core clean-repository/write-set checks. Operations are serialized within each dashboard process. Do not run multiple dashboard instances or a CLI writer against the same destination concurrently.

Harvest and verification require explicit trust confirmation in the interface because they execute project code. Applying requires a separate review confirmation. Sample setup copies only bundled fixtures into new directories and initializes recovery commits. Initial destination reports are saved by atomically replacing the existing owner-only receipt; the API returns selected result/recovery metadata, not original entrypoint recovery contents. If saving a report fails after applying files, the job retains the actual apply outcome and test results.

Use the supplied loopback URL directly. Never publish or tunnel the dashboard: it is not designed for remote or multi-user access. Tokens expire on restart; session activity and later re-verification reports are not persisted. Graceful shutdown waits for the active operation. Force-killing the server or its host can interrupt work; follow the existing bank and receipt recovery procedures.

## Organ-bank replacement

Complete package generations are staged and validated before promotion. A per-package lock prevents overlapping GRAFT writers; readers check for that lock and verify directory identity so they cannot accept mixed generations. Ordinary failures restore the previous directory. Process death or incomplete cleanup leaves a visible recovery lock and preserved directories; locks are never removed automatically based only on a PID. Unrecognized user files cause replacement to be refused.

See the recovery procedure in README.md. Back up all remaining directories before manual cleanup. Tests include killed writers during staging and promotion; filesystem corruption, whole-machine power loss, and hostile external writers are outside this guarantee.

## Sensitive files

Manifest environment variables contain names rather than values. Apply receipts contain an exact entrypoint recovery copy and may therefore contain project secrets already present in that file. Receipt files are created with owner-only permissions. Keep `.graft/transplants`, your organ bank, and registry private; review before sharing or committing them.

## Generated authentication

The emitter preserves the harvested contract, including cookie security flags and scrypt parameters. The fixture source lacks Secure cookies; GRAFT does not silently strengthen or weaken that contract. Runtime session lifetimes must be finite positive integers within the supported range.

The included storage adapters are synchronous and may keep data in memory. Generated authentication has not been assessed for production traffic, distributed persistence, resource-exhaustion resistance, CSRF protection, or complete identity lifecycle management. No rate limiting, password reset, MFA, or email verification is supplied. Acceptance verification is not a substitute for application security review.

## Reporting a problem

Provide a minimal reproduction using disposable repositories and remove credentials and private source code. Do not publish exploit details or secrets in a public issue. No dedicated disclosure address has been configured for this local release candidate.
