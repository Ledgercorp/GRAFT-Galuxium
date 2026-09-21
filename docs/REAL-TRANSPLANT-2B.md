# Real-World Transplant 2B — external Express generalization

Branch `feature/real-transplant-2b-express` from `feature/real-transplant-2` (`5108d9a`). Not
Engine 1.3.

**Outcome:** the same real CUF hosted-provider user-authentication capability, harvested from the
real source through Capability Memory, was transplanted by the packaged GRAFT application into an
independently authored real Express application, with a destination-native registration, and
**VERIFIED 15/15** by the same proof kernel that verified the node:http transplant. CUF and the
external checkout are unchanged. Terminal usage for the product workflow: 0.

## Part A — Host Model contamination (fixed generically, `f72b817`)

Defect: the GRAFT root fingerprint said `framework: express`, `handlerContract: express-req-res`
because the express devDependency and `bench/fixtures/express-mounted-router/main.js` were
evidence, while the real entrypoint is bare `node:http`.

Fix: one production-path policy shared by the workspace detector and the fingerprint
(`packages/core/src/analyze/production-paths.js`: `tests?`, `__tests__`, `specs?`, `fixtures?`,
`bench`, `benchmarks?`, `coverage`, `__mocks__`, `__snapshots__`, `*.test.*`, `*.spec.*`);
framework evidence is entrypoint-first through statically reachable production modules using
AST-level imports (a framework name inside a template string no longer counts); a dependency
alone proves nothing; the handler contract and routes follow the same scope; `node app/server`
resolves the extension Node would. Regressions in `packages/core/test/fingerprint.test.js`: a
bench Express fixture does not classify the parent; a real Express entrypoint does; node:http
stays node:http with Express elsewhere; the contract follows the production server. GRAFT's root
is now `node-http` / `node-res` (its central handler honestly refused as nested).

## Part B — the external destination

- `https://github.com/mikro-orm/express-js-example-app.git` @ `7d43ab0c179fc43867f22169f628167bc0e3d6d6`
  (master, 2026-09-05), MIT, cloned into `~/Developer/GRAFT-Dogfood/express-js-example-app`,
  clean. Dependencies installed with `--legacy-peer-deps` (upstream's own peer conflict:
  express-promise-router peers express ^4 while the app uses express ^5; the router package is
  not imported by the app); npm's lockfile rewrite reverted so the checkout is byte-identical to
  upstream. No fork, push or PR.
- Qualification (read-only plus one boot in a scratch working directory): Express 5, one
  default import, `express()` app, `express.json()` + a RequestContext middleware, `app.get('/')`,
  mounted routers `app.use('/author'|'/book', Router)`, JSON 404 fallthrough, `app.listen`;
  no authentication routes or cookies; boots with no credentials (SQLite file created in the
  working directory at init); `/` 200 JSON, `/nope` 404, traversal paths 404; `/author` and
  `/book` answer **500** on their own because `server.js` never creates the schema (`/author/1`
  400). Structurally different from `esm-node-http-central` on every axis that matters:
  framework, handler contract, middleware chain, mounted routers.

## The engine extension (one coherent change, `e265d91`)

- `express-req-res` gains kind `hosted-session-auth`. The shape check is kind-aware: a
  route-registering kind still needs the strict Express entrypoint (`inspectExpressEntrypoint`,
  which refuses mounted routers), while the hosted kind needs only a guard site
  (`inspectExpressGuardSite`: one default express import, one top-level `express()`, a first
  top-level path-bearing registration to insert before, one `app.listen`; mounted routers welcome).
- `planExpressGuardEdit`: import, instance created after the app, and one
  `app.use(async (req, res, next) => { if (await graftHostedAuth.handle(req, res)) return; next(); })`
  immediately before the first route/mount — after the app's own body parsing and request context,
  before anything it routes. Every other byte preserved (tested).
- The hosted kind's registration style is `guard` on every host; the plan carries it so apply
  plans the same edit; recipe applicability and lowering use the per-kind profile; the hosted
  emitter accepts the Express profile. The emitted modules speak Node's request/response
  contract, which Express requests and responses satisfy — the destination-native part is the
  registration and the middleware chain, not a second implementation of the capability.
- Host preservation for Express probes root, existing static GET routes **and mounted-router
  prefixes**, compared with a **baseline captured before mutation** (`captureHostBaseline`: boot
  the unmodified worktree, record each probe's status, remove the files the boot created, make
  the probes expect exactly those answers). A host that already answered 500 is preserved when it
  still answers 500; a guard that swallows requests turns 200 into 404 and is FAILED (tested).
- Product: prepared worktrees link the checkout's ignored `node_modules` read-through so a
  worktree can boot; the apply route records "how the destination answers today" as a stage.

## Atlas, queried before planning

`~/.graft/atlas`: 5 hosted-session-auth observations, all VERIFIED CUF → node:http central. With
the external host's real architecture (node ≥22.17, express, esm, express-req-res, module-state):
same-family observations 0, adaptations offered none, failure reasons none; ranked partial matches
score 77 (58 for the earliest) — source family identical, destination moduleSystem/persistence
match, same adaptations `credential-authority:hosted-provider`, `session:cookie/local/memory`,
`verification:provider-double/endpoint-configuration`, verified, 4 corroborating. Transfers: the
Genome/IR verified elsewhere, the provider-double/endpoint-configuration verification strategy,
the session policy. Does not transfer: the node:http profile, `registration:central-handler`, the
node:http recipe, the destination-family verdict counts. Atlas did not select the Express recipe;
selection is structural. The final run recorded observation `sha256:ea1d2f6c…`, the first of its family, with adaptations
`express-req-res`, `credential-authority:hosted-provider`, `session:cookie/local/memory`,
`registration:guard-middleware`, `verification:provider-double/endpoint-configuration`.

## The packaged product run (`~/.graft-demo/real-transplant-2b-express/`)

`npm run desktop:demo -- --session real-transplant-2b-express --workspace ~/Developer,~/Developer/GRAFT-Dogfood --destination ~/Developer/GRAFT-Dogfood/express-js-example-app --source ~/Developer/CUF`
(GRAFT Fixture 0.5.0; final run built from `4dfcc4e`; clicks, typing and page reads only).

1. Licence → Discover → two folders authorized from the page → Index: 32 projects, 6
   repositories, 21 capabilities.
2. "find user-facing authentication I have already built" → `@leftsock/cuf` first (7 results).
3. Harvest as source → VERIFIED 13/13.
4. Transplant: 9 destinations, 3 supported — `cuf-webmcp-challenge` (esm-node-http-central),
   `graft-express-destination` (a GRAFT fixture), **`mikro-orm-express-js-example`
   (express-req-res)**. External app chosen.
5. Prepare → `graft/hosted-authentication-dbc3a8c2` from `7d43ab0c`, worktree beneath the app home (final run; an earlier run `03144731` verified identically before the Governor fixes, and one rerun ended NEEDS_REVIEW in an environment stall — see the dogfood notes).
6. Plan: ready, compatibility warn (introduced configuration, names only), recipe
   `hosted-session-auth → express-req-res`, create `src/auth/{provider,identity,session,routes}.js`,
   edit `app/server.js`.
7. Apply & verify: stages "Recording how the destination answers today" → verification →
   **VERIFIED, 15/15 required**.
8. Proof: invariants 10 held / 0 violated / 0 unobserved (`sec.external-credential-authority`,
   `sec.pkce-state-lifecycle`, `sec.opaque-session`, `sec.httponly`,
   `sec.server-side-authorization`, `sec.csrf`, `sec.provider-revoke`,
   `data.non-durable-sessions`, `sec.refresh-identity-stable`,
   `sec.no-provider-secret-in-output`); counterfactuals 7/7; routes login/callback/logout/session
   all registered; host preservation passed — `/` 200→200, `/author` 500→500, `/book` 500→500,
   traversal 404→404 (the app's own answers, unchanged); repairs 0; provider boundary
   deterministic double, no live provider; Atlas observation recorded.
9. Changed files: 4 created, `app/server.js` modified (3 edits: import, instance, guard).

Immutability, asserted by the driver: CUF `ec1af9b` main, clean, no `.graft`; external checkout
`7d43ab0` master, clean — the only addition to that repository is the product's own worktree
branch. Manual interventions: licence key, two folder choices, three trust confirmations.
Terminal steps by the product user: 0. Wall clock 35 s.

## What generalized, what did not

Generalized without special casing: the Genome and IR (same ids as the node:http plan), the
verification contract (same `contractId`), the provider double and its injection through
endpoint configuration, the session/cookie/CSRF/refresh/secret invariants, the proof kernel and
its counts, worktree isolation, the dogfood scorecard. Host-specific by design: the emitter
profile, the registration strategy (central-handler body vs. Express guard middleware), the
preservation probes (mounted prefixes), the recipe.

Found and fixed on the way (all covered by tests): apply re-planned the entrypoint edit without
the registration style; recipe applicability compared against the kind-agnostic profile; the
baseline artefact cleanup silently did nothing (missing `fs` import inside a try/catch) so the
booted app's SQLite file made the worktree dirty and apply refused.

## Remaining friction

- The Transplant view lists GRAFT's own fixtures as supported destinations when the GRAFT
  repository is inside an authorized root; a filter for fixture folders would help a customer.
- The external app's `/author` and `/book` cannot be shown as 200 without a schema step the app
  itself lacks; preservation proves "unchanged", not "working", for those two.
- `express-promise-router` in upstream's `package.json` requires `--legacy-peer-deps` to install.
