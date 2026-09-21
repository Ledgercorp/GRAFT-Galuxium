# Real-World Transplant 3 — return-response generalization probe

Branch `feature/real-transplant-3-return-response` from `feature/generalization-hardening-0.1`
(`a0b3ee7`). Not Engine 1.3.

**Outcome: stop with evidence.** The proposed external candidate is a fetch-style Hono
application on `@hono/node-server`, written in TypeScript and run through `tsx` or a `tsc`
build. It is meaningfully different from both proven hosts — but it is not GRAFT's
`esm-return-response` host model, and admitting it would need a new handler contract and
profile, a Request/Response emission (or reliance on the node-server's raw-response escape
hatch), and verification of a project the verifier cannot boot without running its toolchain.
That is more than the one bounded extension this phase allows, and it includes a new host
profile, which it forbids. No engine code was changed, no transplant attempted, nothing could
be falsely VERIFIED.

## Candidate

`https://github.com/jackjakarta/mcp42` @ `ff2e1655ca141ea7f9da56f1ae8e52278f33b559` (main,
2026-08-24), MIT, cloned read-only to `~/Developer/GRAFT-Dogfood/mcp42`; clean; nothing
installed or built; no fork, push or PR.

## Qualification matrix (read-only, structural)

| # | condition | finding | pass |
|---|---|---|---|
| 1 | independently authored | yes (jackjakarta) | ✓ |
| 2 | permissive licence | MIT | ✓ |
| 3 | production runtime is Node | yes — Dockerfile `CMD node dist/index.js`; but the production *source* is TypeScript (`src/index.ts`, `src/app.ts`) with `.js`-suffixed specifiers, run via `tsx` (`start: envee -f .env -- tsx src/index.ts`) or after `tsc` | ✓ (with a toolchain) |
| 4 | server is Hono / a fetch-Response contract | Hono 4.12 on `@hono/node-server` 2.0: `serve({ fetch: createApp().fetch, port })`; handlers `ctx.json` / `ctx.text`; `app.all('/mcp', ctx => handleMcpRequest(ctx.req.raw))` | ✓ |
| 5 | GRAFT sees a contract different from node-res and express-req-res | framework `hono` (imported by `src/app.ts`), handlerContract **unknown**, entrypoint **null**, routes `GET /health`, `GET /llms.txt`, `profilesByKind {}` | ✓ different — and unsupported |
| 6 | maps to the existing `esm-return-response` host model | **no**: that profile is a route-table host whose handlers return `{status, headers, body}` objects dispatched by `node:http` (`fixtures/new-startup`, `registerAuthRoutes(app)`); Hono's contract is Web `Request → Response` on a fetch adapter | ✗ |
| 7 | real HTTP behaviour for preservation | `GET /health` 200 JSON; `GET /llms.txt` markdown; unknown paths → static fallthrough/404; `/mcp` OPTIONS 204, GET 405, POST JSON-RPC via the Web-standard streamable transport with `enableJsonResponse` (no Node response ownership, no held SSE) | ✓ |
| 8 | no equivalent hosted user auth | correct — the MCP endpoint is explicitly unauthenticated, CORS `*` | ✓ |
| 9 | boots without production credentials | no cloud credential, but only after `pnpm install` (native `better-sqlite3`), `tsx` or `tsc`, and `./data/music.db` from `db:snapshot`/seed, opened at import (`fileMustExist` when read-only) | ✗ for the product |
| 10 | no destructive external services | correct | ✓ |
| 11 | verifiable without rewriting its architecture | **no**: `resolveRuntime` → "no entrypoint found"; the verifier boots only a plain `node <file>` entrypoint and never runs build or seed scripts | ✗ |

## Why this is not the existing return-response profile

GRAFT's `esm-return-response` (from Engine 1.0/1.1, proven for `session-auth`) is: an ESM
project, a `node:http` server that dispatches through a small route table, handlers that
*return* `{ status, headers?, body }` plain objects; the emitter writes handlers in that shape
and registers them with `registerAuthRoutes(app)` after the last route registration. The
fingerprint recognises it by `return { status: … }` idioms. mcp42 has none of that: Hono
handlers receive a context and return Web `Response`s, the router is Hono's, the server is the
node-server adapter over `app.fetch`. The emitted hosted-auth modules speak Node `req`/`res`
(which Express requests and responses satisfy — the basis of Transplant 2); on Hono they could
only be attached through `@hono/node-server`'s raw `incoming`/`outgoing` escape hatch (adapter-
specific, not return-response) or by re-emitting the capability for `Request`/`Response` — a
new emitter. Either is a new host profile.

## MCP / Hono boundary (for the record)

The MCP path uses `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse`, stateless
per request, and refuses GET (405) rather than holding an SSE stream: the transport never takes
ownership of the Node response. Had the host been admissible, `/mcp` OPTIONS/GET and `/health`,
`/llms.txt`, and a deterministic 404 would have been sound baseline probes, and a guard
registered as Hono middleware would not have interfered with the transport.

## Atlas, queried before planning

All local stores (7 hosted-session-auth observations: 5 node:http central-handler, 2 Express
guard-middleware). With the candidate's architecture (node · hono · esm · unknown · sqlite):
same-family observations 0; adaptations offered none. Ranked partial matches: node:http entries
70 (source family identical; moduleSystem match; shared `credential-authority:hosted-provider`,
`session:cookie/local/memory`, `verification:provider-double/endpoint-configuration`; verified,
corroborated), the Express entry `ea1d2f6c…` 58. Transfers: the Genome/IR verified twice and
the provider-double strategy. Irrelevant: `registration:central-handler`,
`registration:guard-middleware`, both recipes. Atlas has no return-response evidence and none
is claimed.

## What this changes

Nothing in the engine or product. The source `~/Developer/CUF` (`ec1af9b`) and the clone are
untouched. Gates are those of the base `a0b3ee7` (full suite 366/366, GRAFTBench 0 false
successes, packaged acceptance 60/60, Governor risk NONE); there is no delta to re-gate.

## Evidence-backed recommendation

The third axis is real but is **fetch-style (Web Request/Response)**, not GRAFT's current
`return-response` route-table contract. Two honest options, each a bounded phase of its own:

1. Find a real destination that actually is `esm-return-response` as GRAFT defines it (a
   `node:http` server with a route table and `{status, body}` handlers) — such projects are
   rare outside GRAFT's own fixtures, which is itself evidence about the profile's reach.
2. Treat "fetch-style Node host" (Hono/itty/plain `Request → Response` on `@hono/node-server`
   or `node:http` adapters) as the next generalization axis: one new handler contract in the
   Host Model, one fetch-native lowering of the hosted-auth routes (cookies, redirects and the
   guard expressed on `Request`/`Response`), Hono-middleware registration, and a destination
   runtime rule for compiled TypeScript (`dist/` present) — explicitly *not* running `tsx` or
   build scripts. That is a new profile and belongs in a phase that allows one.
