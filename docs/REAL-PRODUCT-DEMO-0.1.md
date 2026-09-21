# Real Product Demo 0.1

Using the packaged GRAFT desktop application and no Terminal or API-driver shortcut, the real
CUF hosted-auth capability was discovered through Capability Memory, selected in the UI,
transplanted into a product-managed isolated `cuf-webmcp-challenge` worktree, and VERIFIED
with real GRAFT proof. CUF and the destination's `main` remained unchanged.

Branch `feature/real-product-demo-0.1` from `feature/verified-transplant-workflow-0.1`
(`7c05f70`). This is not Engine 1.3: no engine, emitter, kind, provider or agent change.

## What ran

- Application: the packaged macOS fixture artifact of GRAFT 0.5.0 (`out/fixture/GRAFT
  Fixture-darwin-arm64/GRAFT Fixture.app`, `app.isPackaged === true`, bundled Node 24.21.0),
  built from `583c7c1`. The fixture artifact is the same product with the fixture licence
  service; it is the only packaged build that can be activated without spending money.
- Driver: `npm run desktop:demo` (`scripts/desktop/real-demo.mjs`). It launches the app with an
  isolated home (`~/.graft-demo/real-product-demo-0.1`, `GRAFT_HOME` beneath it), the dogfood
  recorder, and one automation seam — the fixture artifact answers the native "Choose a folder"
  dialog from `GRAFT_FIXTURE_CHOOSE` because native dialogs cannot be scripted. Everything else
  is a click, a typed value, or a read of the page over the DevTools protocol, with bounded
  polling of the page's own progress strip and job dialog. The driver never calls the
  workspace API, never creates a worktree, never chooses a branch, never runs a harvest or a
  verification. After the run it reads what the product wrote.
- Workspace: the real `~/Developer` (30 projects, 5 repositories + 33 alternate worktrees, 21
  capabilities, 7 harvestable, 7 transplantable).

## The click path, as a customer would do it

1. Licence page: type the key, Activate.
2. Discover → **Add a workspace folder** → `~/Developer` → **Index workspace**.
3. Search: *find user-facing authentication I have already built*. Results (7):
   1. `@leftsock/cuf` — harvestable; credentials: hosted-provider · session: cookie · custody:
      local · store: memory; cookie-session, hosted-provider-oauth, oauth2-pkce, oidc, jwt-bearer
   2. `@cuf/api` 3. `old-saas-project` 4. `graft` 5. `@graft/core`
   6. `new-startup` (not harvestable) 7. `graft-express-destination` (not harvestable)
4. Top harvestable result → **Why GRAFT thinks this** → **Harvest as source** → trust
   confirmation. Source verified through its factory seam with the deterministic provider
   double: **VERIFIED 13/13**.
5. Transplant → source *Hosted sign-in (workos) with local sessions · from @leftsock/cuf ·
   verified in source* → destination cards (8; 1 supported): `cuf-webmcp-challenge` ·
   javascript/node · esm · node-http · central handler · server.mjs · HEAD 7b0f56c3a575 · clean ·
   Supported · esm-node-http-central. `@leftsock/cuf` itself is offered and refused
   (*this is the capability's own source checkout*; no emitter for its shape).
6. **Prepare isolated transplant** → confirmation → READY: `graft/hosted-authentication-ece180e8`
   in `~/.graft-demo/real-product-demo-0.1/graft-state/worktrees/cuf-webmcp-challenge-hosted-authentication-ece180e8`.
7. **Build plan** → *Ready to transplant*; will create `src/auth/{provider,identity,session,routes}.js`,
   will edit `server.mjs`; recipe `hosted-session-auth → esm-node-http-central`;
   compatibility *warn*: configuration this capability introduces (names only):
   `AUTH_PROVIDER_ORIGIN, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, AUTH_JWKS_URL, AUTH_ISSUER,
   AUTH_AUDIENCE` required, `AUTH_PUBLIC_ORIGIN` optional.
8. **Apply & verify** → trust confirmation → stages → **VERIFIED, 15 / 15 required tests passed**.
9. Proof: Required cases 15/15 · Invariants 10 held, 0 violated, 0 unobserved · Counterfactuals
   7/7 · Host preservation passed · Repairs 0 · Provider boundary deterministic provider double
   (endpoint-configuration, no live provider) · Atlas observation recorded.
10. Changed files: created `src/auth/provider.js`, `src/auth/identity.js`, `src/auth/session.js`,
    `src/auth/routes.js`; modified `server.mjs` (3 edits), with the diff preview.

Whole run: 33 s wall clock. Manual interventions: the five normal UI confirmations (licence key,
folder choice, harvest trust, prepare, apply trust). Terminal steps by the product user: 0.

## Evidence

- Final run `ece180e8` (`~/.graft-demo/real-product-demo-0.1/evidence.json`, screenshots
  `01-search-results`, `02-source-and-destination`, `03-plan-review`, `04-proof`,
  `05-changed-files`): verdict VERIFIED 15/15/0/0; proof summary cases 12 passed, invariants
  held 10, violated 0, unobserved 0; every contracted route registered; repairs 0; Atlas entry
  `sha256:c90f575e6af7fef044c9e2e4ace3bf47d6f3adda4870920f7da81ba3d7665971`; record history
  PREPARING → READY → READY → APPLIED → VERIFIED; worktree on the prepared branch at
  `7b0f56c` with exactly the transplanted changes.
- Immutability, asserted by the driver from before/after snapshots: CUF `ec1af9b` main, clean, no
  `.graft`, unchanged; destination `main` `7b0f56c`, clean, unchanged. The only new thing in the
  destination repository is the branch the product created for its worktree.
- Dogfood `real-product-demo-0.1`: final state SUCCESS (verdict VERIFIED); terminal use 0;
  manual intervention 0 recorded by the product (confirmations are normal UI); false VERIFIED 0.
- Earlier runs of the same click path in this phase: `f00c3e4b` VERIFIED, `31f292b3` VERIFIED,
  `9d107992` VERIFIED, each cleaned up afterwards **through the app** (Clean up → warning that the
  worktree contains changes → confirm → row, folder and branch gone; `cleanup.json` kept beside
  each run under `~/.graft-demo/real-product-demo-0.1-run*`).
- One run, `c1443b61`, ended **NEEDS_REVIEW**: five required cases inconclusive on 10 s step
  transport timeouts while the machine was memory-starved (verification took 197 s instead of
  1–3 s). The verifier reported INCONCLUSIVE rather than guessing. Re-verifying that worktree
  three times with the banked manifest (dev tooling, diagnosis only) gave VERIFIED 13/13 in
  ~600 ms each; classified as an environment stall, not a product defect, and recorded as such.

## Defects found and fixed in this phase

None in the product. The packaged path from Workflow 0.1 (prepare confirmation, proof panel
persistence, conflict approval) held. Driver-side slips only: newline escaping inside injected
expressions, dismissing dialogs with the DOM `close()` instead of the page's × control (the
page then reopened the job dialog), and the Governor's review of the driver — verdicts recorded
but not asserted, no source snapshot — which was fixed before the final run.

## Remaining friction

- `@leftsock/cuf` is listed among destination candidates (correctly refused). A future filter
  could hide the capability's own source checkout by default.
- GRAFT's own repository still ranks 4th/5th for the user-facing query (detector source strings).
- The demo needs the fixture artifact for licence activation; the production artifact needs a
  real key and the licence service.
