# Real-World Transplant 2 — generalization probe

Branch `feature/real-transplant-2` from `feature/real-product-demo-0.1` (`68df3e1`). Not
Engine 1.3. Mission: the same real CUF hosted-provider user-authentication capability into a
*meaningfully different real destination architecture*, through the packaged product, with at
most one small coherent engine extension — or a stop with evidence if no credible real pair
exists.

**Outcome: stop with evidence.** The authorized `~/Developer` workspace holds no real
destination that differs from the proven `esm-node-http-central` host and is admissible under
the rules. No engine code was changed; no destination was invented; no transplant was
attempted, so nothing could be falsely VERIFIED.

## Candidate discovery (read-only)

Source of truth: the Workspace Capability Index the packaged app built from `~/Developer`
during Real Product Demo 0.1 (30 projects, 5 repositories, 21 capabilities), plus read-only
`fingerprintProject` + `profilesByKind` on each Node project. Nothing was executed.

| project | repo | runtime / module | HTTP architecture | handler contract | route idiom | auth today | profile for hosted-session-auth | supported | expected adaptation | verification feasible | admissible? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| cuf-webmcp-challenge | cuf-webmcp-challenge | node / esm | bare `node:http`, central async handler | node-res | path-comparison | none | esm-node-http-central | yes | central-handler registration | yes (proven) | **excluded by mission** (the proven pair) |
| @leftsock/cuf | CUF | node / esm | `node:http` (authkit-web runner) | node-res | path-comparison | hosted-provider user auth (the source) | none (no createServer call found) | no | — | via factory seam (source only) | no: source repository; already has the capability |
| @cuf/api | CUF (apps/api) | node / esm (TS) | `node:http`, nested createServer | node-res | path-comparison | same capability | none (create-server-call-is-nested) | no | — | — | no: same repository as the source; already has it |
| @cuf/web | CUF (apps/web) | node / esm (TS) | `node:http`, non-async central handler | node-res | path-comparison | custom-unknown | none (central-handler-is-not-async) | no | would need a sync→async central-handler strategy | — | no: same repository as the source (product refuses `source-repository-is-destination`; CUF is read-only by rule) |
| @cuf/worker | CUF (apps/worker) | node / esm (TS) | `node:http`, no routes | node-res | — | custom-unknown | none | no | — | — | no: same repository as the source |
| SockDev-Agent-Bridge-v2 | SockDev-Agent-Bridge-v2 | **python** / FastAPI | FastAPI app, decorator routes | fastapi | decorator | bearer token, machine audience | none | no | Python emission | — | no: Python transplantation is out of scope by rule |
| seam-claude-bootstrap | SEAM | node / esm | **no HTTP server** (examples + library) | return-response (library idiom) | — | m2m client-credentials, machine audience | none (profile exists only for session-auth) | no | — | no: nothing to boot, nothing to preserve | no: no HTTP application surface |
| graft | GRAFT | node / esm | loopback dashboard, bare `node:http`; root fingerprint says *express* | express-req-res (misclassified) | — | session token, no user auth | none (`express.supported=false`) | no | would need hosted emission for Express | — | no: it is the product itself, and the classification is wrong (see Host Model finding) |
| old-saas-project, new-startup, config-service, graft-express-destination | GRAFT/fixtures, bench | node | various | various | various | fixtures | — | — | — | — | no: synthetic fixtures, excluded by mission |

The product's own Transplant view, driven from the packaged UI in Demo 0.1, lists the same
verdicts: *1 of 8 supported*, each refusal named (`no hosted-session-auth emitter for
esm/return-response`, `… cjs/node-res … central-handler-is-not-async`, `… esm/express-req-res
(express)`, `this is the capability's own source checkout`).

## Selection rule

- **A** — same source → different real *supported* host: none exists.
- **B** — same source → different real host needing one small extension: the only real non-CUF
  Node HTTP surface with a different shape is GRAFT's own repository, which is not a legitimate
  customer destination and whose "express" shape is a misclassification (below). SEAM has no
  HTTP surface. SockDev is Python.
- **C** — a second real hosted/session-auth source into the proven destination: none. SockDev's
  auth is Python bearer/machine; SEAM's is M2M client-credentials; CUF's apps are the same
  capability.
- **D** — another supported kind across two real repos: no real repository holds feature-flags.

Per the mission, this is a stop, recorded in dogfood `real-transplant-2`.

## Atlas, inspected before planning

`queryAtlas` over `~/.graft/atlas` (5 hosted-session-auth observations, all VERIFIED
CUF → node:http central, entries `3f80efa5…`, `46e89e5b…`, `8132d228…`, `d003ce9a…`,
`da0f4506…`; the demo home holds a sixth, `c90f575e…`).

| query destination | same-family observations | verdicts | top score | reused | irrelevant |
|---|---|---|---|---|---|
| node:http central (proven) | 5 | VERIFIED 5 | 120 (family identical, same 5 adaptations, same recipe, corroborated) | profile, registration, verification strategy, verdict history | — |
| Express host | 0 | — | 85, partial: source family identical, moduleSystem/persistence match, "verified transplant" | that the Genome verified elsewhere; adaptation vocabulary | profile, registration strategy, verdict counts (adaptations list empty) |
| return-response host | 0 | — | 95, partial | same | same |
| CJS node-res host | 0 | — | 95, partial | same | same |

So Atlas would have *retrieved* transplant 1 as a ranked partial match for a different host
but would not have contributed an adaptation or recipe for it — correct behaviour, and no
"learning" is claimed because no run in this phase was affected by stored evidence.

## Host Model finding (no engine change made)

`fingerprintProject` on the GRAFT repository root reports `framework: express` (devDependency
express 5.2.1) and `handlerContract: express-req-res` with evidence from
`bench/fixtures/express-mounted-router/main.js`, while the real entrypoint
`packages/web/src/server.js` is bare `node:http`. `express.supported === false`
(`requires-one-default-express-import`) keeps it refused — no false support — but the shape is
being read from bench/fixture files inside the repository rather than from the entrypoint's
reachable modules. The workspace detector already excludes tests/specs/fixtures for
capability signals; the fingerprint should do the same for framework and handler-contract
evidence. This is the one evidence-backed engine priority this probe produced.

## What this says about generalization

- Proven so far: one real source → one real host family, four times, through the product.
- Not yet proven, for lack of a real pair in this workspace: a second host family. The engine's
  structural pieces exist for it (profiles `esm-return-response` and `express-req-res` for
  session-auth; Host Model, recipe selection and the verification contract are host-agnostic
  by construction), but the hosted-session-auth emitter is wired to one profile only.
- Next credible step: obtain (not invent) a real Express or return-response application without
  hosted user auth — a second author's repository, or an existing project of the owner's that
  is not in this workspace — then wire hosted-session-auth to that existing profile as the one
  bounded extension and run the packaged demo driver against it.
