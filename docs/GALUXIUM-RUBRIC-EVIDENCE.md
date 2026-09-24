# GRAFT 0.6 against the Galuxium Nexus V2 judging categories

Every claim below points at something a judge can execute or inspect. Where a capability is planned rather than built, it says so. Test counts are from a fresh clone of public `main` at `ebbbeb6aa7fbb604c839fe6a768406e06e445fb0`, run on 2026-09-23; nothing here is projected.

Public surfaces: [judge site](https://judge-topaz.vercel.app) · [source](https://github.com/Ledgercorp/GRAFT-Galuxium) · [live demo, 4:32](https://youtu.be/9c-u03Tj62Y) · [macOS download](https://graft-beta-downloads.fly.storage.tigris.dev/GRAFT-0.6.0-galuxium-arm64.dmg).

## Technical Architecture & Scalability (20%)

| Claim | Implementation | Public evidence | Where the judge sees it |
|---|---|---|---|
| Agent-independent reuse and verification pipeline: Find → Fit → Prove | `packages/core/src` (workspace, harvest, engine, plan, apply, verify, laboratory) | Source; README "Architecture" with diagram | README; judge site "How GRAFT 0.6 works" |
| Capabilities are verified in their source before reuse | `packages/core/src/harvest`, `verify` | Demo 0:25–0:43 (8/8 and 13/13 required cases) | Demo; judge "Find it" view |
| Compatibility decided before any write | `packages/core/src/plan` (Compatibility Preview over a Host Model) | Demo 2:57 (ADAPTABLE), 3:32 (INCOMPATIBLE) | Demo; judge "Fit it" view |
| Composition of several capabilities with re-verification on one final revision | `packages/core/src/laboratory` | Demo 1:03–2:14, COMPOSITION VERIFIED at 1:51 | Demo |
| Verification delegated to a proof kernel with a single adapter | `packages/cuf-kernel` (vendored, `PROVENANCE.json`), `packages/proof-adapter` | Source | README "CUF verification" |
| Scales by design: all repository-sensitive work is local; the hosted surface is static | Local-first workspace bound to `127.0.0.1`; static judge site; small licensing service | `packages/web/src/server.js`, `packages/web/judge/` | README "Security and privacy" |
| Test coverage | Fresh clone of public `main` (`ebbbeb6`) on a clean machine, 2026-09-23: `npm test` 584 tests, 532 passed, 0 failed, 52 skipped (tests that need private dogfood material or the unpublished private-beta profile). Licensing 110 of 110. Desktop 54 tests: 53 passed, 1 skipped (private-beta profile). Judge-site browser acceptance: 43 assertions locally, 40 against production (the 3 local-only checks corrupt the evidence file). | `npm test`, `node --test packages/licensing/test/*.test.js`, `scripts/demo/judge-acceptance.cjs` | Reproducible from the repository |

No throughput, latency or fleet-size claims are made; none were measured.

## Enterprise Governance & Compliance (20%)

| Claim | Implementation | Public evidence | Where the judge sees it |
|---|---|---|---|
| Local-first: source never leaves the machine | Workspace scans only authorised roots; judge site has no executor or upload endpoint | `packages/core/src/workspace/store.js`, `packages/web/judge` | Demo 0:10 (authorized folder); judge site footer |
| Explicit Data Boundary before any agent egress | Data classes `NONE`…`GENERATED_DERIVATIVE`, ALLOW/DENY policy, custody records with fingerprints only | `packages/core/src/agent/data-boundary.js` | Judge "Provenance" view (custody ALLOW/DENY replay); demo 3:46 |
| Deterministic refusal before mutation | INCOMPATIBLE plans disable Apply; API returns 409 with no file change; unsupported Laboratory hosts are Blocked before any repository exists | `packages/core/src/plan`, `packages/web/src/server.js` (`/api/apply` guards), `laboratory/execution.js` eligibility gate | Demo 1:18 (Blocked host), 3:32–3:37 |
| Revision-bound, tamper-evident evidence | Proof files checked by digest (INTACT/MISMATCH), verifiable offline with `graft proof verify`; ledger records CURRENT/STALE | `packages/proof-adapter`, `packages/core/src/laboratory/continuity.js` | Demo 2:03–2:42 |
| Auditability | Recovery receipts per transplant; provenance from source revision to destination revision to proof ids; diagnostic bundles redact secrets and paths | `packages/core/src/apply`, `laboratory/diagnostics.js` | Demo 3:50 (receipt), 4:14 (diagnostics) |
| Hosted surface hardening | CSP with `frame-ancestors 'none'`, HSTS, `nosniff`, `no-referrer`, Permissions-Policy; no source maps | `packages/web/judge/vercel.json`; live headers | `curl -I https://judge-topaz.vercel.app` |
| Publication controls | `scripts/publication-check.mjs` enforces exclusions and scans for secrets and personal paths | Source | README "Public repository scope" |
| Honest limits | Not an OS sandbox; ad-hoc signed, not notarized; narrow supported shapes | README "Limitations", SECURITY.md | README |

## Product Innovation & Market Fit (20%)

| Claim | Implementation | Public evidence | Where the judge sees it |
|---|---|---|---|
| Category: complementary infrastructure for agentic development, not a coding agent | Agents are optional; the demonstrated workflow uses none; Blueprint hands constraints to any agent | `plan/agents-export`; Data Boundary | README "The problem"; demo 3:07 (AGENTS.md), 4:22 (Connect your own agent) |
| Market evidence | 2025 Stack Overflow Developer Survey: 84% use or plan to use AI tools; 46% distrust vs 33% trust accuracy; 66% "almost right, but not quite"; 45.2% debugging AI code more time-consuming | https://survey.stackoverflow.co/2025/ai | README, executive brief |
| One market, two entry points | AI-first builders and engineering organisations share the reuse-and-verification problem | Positioning only | README, judge site |
| Novel behaviours a judge can see | Refusal before mutation; evidence that goes STALE; composition verified on one revision | As above | Demo |

No market-size figures, user counts or competitor comparisons are claimed.

## Monetization & Fiscal Design (15%)

Three categories, kept strictly apart. Sandbox transactions are test data, not revenue.

**Implemented and tested** (automated tests against a Stripe fake; licensing suite 110 of 110):

| Claim | Implementation |
|---|---|
| $49 USD one-time GRAFT licence | `packages/licensing/src/catalog.js` (`DEFAULT_PRICE_USD_CENTS = 4900`) |
| Server-created Stripe Checkout with Managed Payments requested on every session | `src/stripe.js` (`managed_payments[enabled]=true`) |
| `/buy` redirect to a configured Stripe Payment Link (`buy.stripe.com` only) | `src/config.js`, `src/server.js`; `test/server.test.js`, `test/config.test.js` |
| Signature-verified webhook fulfilment, including full-refund revocation and dispute lifecycle | `src/server.js` `handleEvent`; `test/stripe-signature.test.js` |
| Server-side purchase verification: the Checkout Session is re-fetched and the exact price, product, GRAFT marker, tax code, amount and quantity are checked before any licence is issued; a redirect alone never issues | `src/server.js` `verifyGraftPurchase`; `test/server.test.js` |
| Licence activation, validation and deactivation with per-installation seats; desktop client with offline grace | `src/licenses.js`; `packages/desktop/src/license-service.js` |

**Configured but not end-to-end live:**

| Item | State |
|---|---|
| Stripe sandbox catalog | Product "GRAFT" with the `graft=desktop-onetime` marker and tax code `txcd_10202003`; $49 one-time USD price |
| Stripe Payment Link (test mode) | Active; Managed Payments enabled; automatic tax with Stripe liability; invoices issued by Stripe; redirects to the licensing service's `/success` |
| Webhook endpoint | Created in the sandbox for the eight events GRAFT consumes |
| Galuxium licensing service on Fly.io | App, volume, webhook secret and price staged; **not deployed** (its Stripe API key is not yet provisioned) |
| Commercial GRAFT 0.6.0 DMG | Built with Buy wired to that service; held as an unpublished draft release |

No test purchase has been completed end to end through this configuration yet.

**Roadmap (not implemented):** recurring Pro, Team and Enterprise tiers; shared capability memory and registry, organisational policy, governance and audit retention; live-mode payments. The intended expansion: individuals buy the desktop product; teams pay recurring fees for shared, governed verification infrastructure.

No revenue, customers, conversion or usage figures exist or are claimed. With Managed Payments, Stripe acts as merchant of record for GRAFT sales.

## UI/UX & Visual Refinement (15%)

| Claim | Implementation | Public evidence | Where the judge sees it |
|---|---|---|---|
| One workflow, seven sections, plain-language states | Desktop/web workspace: Workspace, Discover, Projects, Organ bank, Transplant, Laboratory, Activity | `packages/web/public/app.js` | Demo throughout |
| Refusals and staleness are first-class UI states, not errors | INCOMPATIBLE, Blocked, STALE, Intact badges with reasons | `app.js` | Demo 1:18, 2:26, 3:32 |
| Keyboard and mobile judge site | Skip link, `aria-current` stages, focus management; responsive layout | `packages/web/judge/app.js`, `style.css`; acceptance suite covers keyboard and 390px mobile | https://judge-topaz.vercel.app |
| Real captures, not mock-ups | All gallery images are frames from the live demo of the packaged build | Demo video | Devpost gallery |

## Keynote Pitch & Demo Completeness (10%)

| Claim | Evidence |
|---|---|
| 4:32 demo of the accepted build being operated | https://youtu.be/9c-u03Tj62Y; 92.6% genuine screen recording, sped-up segments labelled on screen |
| Find → Fit → Prove shown in order | FIND 0:10, FIT · LABORATORY 1:03, FIT · TRANSPLANT 2:52, PROVE 3:19 |
| Refusal shown | Blocked host 1:18; INCOMPATIBLE with Apply disabled 3:32–3:37 |
| COMPOSITION VERIFIED shown | 1:51–2:03, revision `71b6dcc607ed` |
| CURRENT → STALE shown | CURRENT 2:03; STALE after a later commit 2:26; proofs still Intact 2:31; plan STALE 2:41 |
| Access | Judge site, public source, download and demo linked from every surface |
