# GRAFT Engine 1.2 — the first real → real transplant

Engine 1.2 is exactly the support the first real-world transplant needed, and nothing more:
a real hosted-provider sign-in capability, harvested from real TypeScript source, regenerated
into a real bare `node:http` destination, and **VERIFIED without a live provider, without
credentials and without network access**. Everything below was driven by that operation;
nothing was added because it sounded useful.

## What changed

### 1. Delegated credential authority (`hosted-session-auth`)

A second authentication kind, a sibling of `session-auth`, not a relaxation of it. The model
separates three things the old model could not:

```
credentialAuthority   { kind: hosted-provider, provider, protocols: [oauth2, pkce] }
session               { transport: cookie, custody: local, store: memory, durableAcrossRestart: false, … }
guard, csrf, providerSeam
```

The application never hashes a password, and the manifest is refused if it claims to
(`a hosted-provider capability must not claim to hash passwords`). Existing local-password
manifests validate unchanged; the GRAFTBench corpus is untouched (18/18, 0 false success,
0 missed mutations).

**Capability boundary.** Provider responsibilities: authorization URL, code/refresh exchange,
identity assertion, provider-session revocation. Local responsibilities — what the capability
*is*: state/PKCE custody in a short-lived flow cookie, opaque sessions keyed by the sha256 of
their id, the cookie contract (`HttpOnly`, `SameSite`, `Secure` + `__Host-` on HTTPS, `Path`,
`Max-Age`), absolute and idle expiry, same-origin checks on mutations, the guard, logout with
revoke, token refresh linkage. The IR preserves the split; the emitter keeps the provider side
behind one adapter.

### 2. TypeScript source, not build output

The harvester reads `.ts` as text, and the **source-side verification runs the editable
TypeScript directly** through Node's type transform (`--experimental-transform-types`) —
`dist/` is never executed, never edited, never required to exist. The Workspace Index already
keeps source and runtime entrypoints apart; the engine now honours it.

### 3. Bare `node:http` destination profile (`esm-node-http-central`)

Profiles are now **kind-aware**: a profile is supported *for a kind*, never in the abstract.
The new profile applies to an ESM server with one top-level `createServer(async (req, res) =>
{ … })` handler. It is available only to `hosted-session-auth`; `session-auth` and
`feature-flags` keep exactly their two profiles and their four built-in recipes.

`inspectCentralHandler` is deliberately narrow: one `createServer` call, one inline async
handler with two plain parameters and a block body. Anything else is refused by name
(`central-handler-is-not-async`, `create-server-handler-is-not-inline`, …).

### 4. Central-dispatch registration

Three insertions, every other byte preserved: an import after the last import, the capability
instance at module scope before `createServer`, and first refusal as the first statement of
the handler:

```js
// >>> graft:hosted-authentication
const graftHostedAuth = registerHostedAuth({ env: process.env });
// <<< graft:hosted-authentication
createServer(async (req, res) => {
  // >>> graft:hosted-authentication
  if (await graftHostedAuth.handle(req, res)) return;
  // <<< graft:hosted-authentication
  … existing static-file handling, traversal normalisation and fallthrough, unchanged …
```

The plan also carries **host-preservation probes**, derived from the Host Model and run as
*required* cases after the transplant: the destination's own routes must still answer and an
encoded traversal attempt must still be refused. A transplant that breaks its host is FAILED.

### 5. Provider-double verification

`packages/core/src/verify/provider-double.js` is a deterministic loopback stand-in for the
credential authority only: an OAuth 2.0 token endpoint that accepts an authorization code only
in the form `graft-ok:<code_challenge>` and only when `S256(code_verifier)` equals it — so the
PKCE lifecycle is proven, not skipped — a JWKS endpoint serving a real Ed25519 key, real
EdDSA-signed identity tokens, a revocation endpoint, and a call log so a test can require that
logout crossed the provider boundary.

It is injected in two ways, both recorded in the evidence:

| Side | Seam | How |
| --- | --- | --- |
| Source | `factory-injection` | GRAFT writes a harness **outside** the source repository that imports the source's own factories (auth, server, identity verifier — the same seam its tests use) and composes them with a provider port backed by the double |
| Destination | `endpoint-configuration` | the emitted **production** adapter is pointed at the double through the environment (`AUTH_PROVIDER_ORIGIN`, `AUTH_JWKS_URL`, …); loopback HTTP is accepted only outside production |

No test code ships in a destination (asserted: `graft-ok:`, `provider-double`,
`graft-verification-not-a-secret`, `__graft` never appear in emitted files). A source with no
seam is **refused by name** — `hosted-provider authentication is understood, but no
verification seam is available … GRAFT will not run it against a live provider` — and its
manifest carries that refusal; it is never run against the real provider.

### 6. Verification contract and DSL

New, bounded step fields: `headers` (fixed allowlist plus short custom `x-` headers, never
credential-bearing; `cookie` only as one plain `name=value` pair for the unknown-session
counterfactual), `query` (literals or `{ capture }` references), `captureQuery` (from a
redirect's Location). New expectations: `redirectPath`, `redirectPathStartsWith`,
`redirectToProvider`, `redirectQueryHas`, `providerCalled`, `providerNotCalled`.

The contract for the real capability: 10 required cases — 4 success, 6 counterfactual — plus
2 host-preservation probes; 9 declared invariants, 8 witnessed:

| Case | Proves |
| --- | --- |
| `hosted.login.redirects-to-provider` | 303 to the provider's authorize path with `state`, `code_challenge`, `S256`, `redirect_uri`; HttpOnly flow cookie |
| `hosted.callback.rejects-mismatched-state` | wrong state → no session, provider not contacted |
| `hosted.callback.rejects-provider-failure` | provider rejects the PKCE verifier → no session, boundary crossed |
| `hosted.callback.establishes-session` | opaque 43-char HttpOnly session cookie |
| `hosted.session.resolves-identity` | cookie → `{ subject }` |
| `hosted.session.rejects-anonymous` | 401, no session issued |
| `hosted.session.rejects-unknown-cookie` | well-formed unknown cookie → 401 |
| `hosted.logout.invalidates-session` | old cookie refused afterwards; provider revoke called |
| `hosted.logout.requires-same-origin` | cross-site logout → 403, session survives, no revoke |
| `hosted.session.not-durable-across-restart` | restart → old cookie refused (declared semantic, verified) |
| `host.routes-still-answer`, `host.traversal-still-refused` | the destination's own behaviour is intact |

Mutation checks against the emitted destination (skip state check, skip revoke, drop HttpOnly,
skip CSRF, make sessions durable) each produce FAILED on the intended case.

### 7. Honest refusals and honest warnings

Compatibility now says *which kind* a shape is unsupported for (`GRAFT can write session-auth
here, but has no hosted-session-auth emitter for this shape`), names a central-handler refusal
reason, and treats configuration the capability **introduces** (`AUTH_*`) as a warning to
configure before production rather than a block on the destination.

## Where the engine still stops

- One provider-double flavour (OAuth 2.0 code + PKCE with JWT identity). OIDC discovery,
  SAML and device flows are not modelled.
- The seam detector recognises factories by option names (`provider`, `identity`, `origin`,
  `auth`); a source that composes differently is refused, not guessed.
- The emitted identity verifier covers EdDSA, ES256, RS256, PS256. Nothing else is trusted.
- `sec.no-provider-secret-in-output` is declared and honestly unobserved: no witness scans
  responses for the secret value.
- Durable (database-backed) hosted sessions are refused by the emitter rather than approximated.
- The emitter writes one profile. Express and return-response destinations have no hosted emitter yet.
