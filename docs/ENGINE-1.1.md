# GRAFT Engine 1.1

Engine 1.1 makes the 1.0 abstractions operational: generation is compiled from the IR, a
second capability kind proves the structures are not overfit to authentication, the
Compatibility Atlas ranks and learns, recipes are explained and applied, verification
failures can be repaired within hard limits, more invariants are witnessed, and the result is
described as a Semantic Changeset. Authority is unchanged from 1.0: compatibility checks decide
plan status; `decideVerdict()` alone says VERIFIED; the atlas and recipes never override either.

## IR-driven emission

```
manifest ─▶ Genome ─▶ GRAFT IR ─┐
                                ├─▶ lowerToEmission() ─▶ EmissionSpec ─▶ emitCapability(spec) ─▶ files
destination ─▶ Host Model ──────┘        ▲
                          selected recipe ┘
```

`engine/lower.js` produces the **EmissionSpec** — the explicit IR→emitter boundary: kind,
profile, directory, target (module system, handler contract, framework, persistence binding
and store module, entrypoint), the kind's route registration (name + marker), operations,
guards, policies, abstract state, environment inputs and the recipe reference, plus a `specId`.
Emitters (`emit/session-auth.js` `emitSessionAuthFromSpec`, `emit/feature-flags.js`) receive
only the spec — never the manifest, the source files or the raw fingerprint — and
`emit/index.js` dispatches by kind. `emitSessionAuth(manifest, destFp)` remains as an adapter.

Proven property: two manifests whose source layout, evidence, provenance, display name and
source architecture differ but whose intent is the same emit byte-identical files with the
same `specId`; a changed policy changes the output; the spec path equals the adapter. Two
defects surfaced by cutting the boundary were fixed on the way: the IR no longer coerces policy
values (a string `'false'` is not laundered into a boolean past the interpolation guards), and
operations come from the authoritative capability model rather than the evidence copy.

## Second kind: feature-flags

`fixtures/config-service` (CJS node-http) carries a read-only, configuration-driven
feature-flags capability with the opposite profile from session-auth: inputs are the environment
and a request body (never a credential), outputs are JSON (never a cookie), side effects are
reads only, there are no entities or guards, and the defining invariant is the *absence* of side
effects. Adaptation dimensions are module system, handler contract, framework, route
registration and **configuration binding** (no persistence binding). It is detected
(`harvest/detectors/feature-flags.js`), assembled (`harvest/kinds/feature-flags.js`),
validated by the schema, emitted for both profiles, and proven end to end: VERIFIED in its own
source over real HTTP, transplanted into the ESM destination, VERIFIED there with the read-only
invariant held, and a cookie-issuing mutation caught as FAILED with the invariant violated.

## Atlas relevance and learned recipes

`queryAtlas()` ranks with deterministic weights and returns `score`, `reasons` and `support`
per observation: same kind is a hard filter; destination family similarity weighs most, then
source similarity, adaptation/recipe overlap, verification outcome (verified up; failed and
refused down but visible as warnings), corroboration by VERIFIED observations sharing the same
signature, and recency only as a minor tie-breaker.

`engine/learned-recipes.js` derives recipe candidates from atlas history grouped by kind +
source family + destination family + adaptations. Only VERIFIED runs contribute; FAILED,
NEEDS_REVIEW and refused runs count against the group. Promotion is explicit:
**candidate** (1 verified) → **observed** (2 verified, 0 failed) → **trusted** (3 verified from
≥ 2 distinct hosts, 0 failed). Provenance carries architectures, kind, exact adaptations,
evidence ids, supporting count, distinct hosts, confidence, version constraints when consistent
and the thresholds. A learned recipe can only name a mechanism the engine implements. Built-ins
remain separate and take precedence; only trusted learned recipes are selectable — candidates
and observed ones are surfaced as alternatives.

## Recipe application

`selectRecipe()` explains every applicability condition (`explainRecipe`). The plan carries the
recipe and its explanation; the proof contract carries `appliedRecipe` (its expectations ride
along and never relax the verdict rule); the receipt records `engine.recipeId`; and the atlas
entry records it, so the next plan sees the observation ranked ("same recipe") and any learned
candidate — surfaced, not applied. No recipe is forced when none fits.

## Repair loop

`engine/repair.js`: VERIFY → if FAILED and classifiable → DIAGNOSE → bounded proposal → APPLY →
VERIFY AGAIN. One deterministic class is implemented: **missing-route-registration** (required
tests answer 404 on transplanted routes while the entrypoint carries no registration); the
repair re-applies the registration through the same guarded `planEntrypointEdit` and touches
only that file. Authority limits: hard cap `MAX_REPAIR_ATTEMPTS = 2` (a larger request is
clamped); NEEDS_REVIEW never triggers a mutation; unclassified failures are recorded without
changes; every attempt records class, reason, the original failure evidence, changed files and
edits; the final verdict is the authoritative verifier's last report — the loop has no verdict of
its own. The workspace apply job runs one attempt after a failed destination verification and
records it in the receipt; the atlas entry records the repair and its outcome.

## Verification witnesses

New expectations: `noSetCookie`, `sameBodyAs`, `cookieFlags`, `cookieValuePattern`, and a
`restart` step (the runner stops and reboots the application in place, keeping client cookies).
The session-auth harvest now witnesses `sec.httponly` and `sec.opaque-session` on the login
cookie, asserts no cookie on anonymous rejection, and adds a **non-required**
`auth.session.survives-restart` case so durability is reported as held/violated — violated for
the in-memory fixtures — without deciding the verdict. The proof carries `routeCoverage` (each
contracted operation answered non-404). `sec.constant-time` remains honestly unobserved. A
harvest may declare `security.assumptions[].witnessedBy`. GRAFTBench stays 18/18 with zero
false VERIFIED and zero missed mutations under the new witnesses.

## Semantic Changeset

`engine/changeset.js`: capability added, components introduced (with roles) and adapted,
dependencies added/removed, target-native substitutions, source components intentionally
omitted, security-sensitive changes, verification coverage, repair attempts, recipe used, prior
observations, evidence result — with the raw Git diff (branch, receipt, files written, recovery)
kept separately. Returned by the workspace apply job; printed by `graft apply`.

## Organ artifact v1.1

`graft-engine.json` carries `artifactVersion`, per-artifact `schema` versions and
host-independent `recipeHints`; 1.0.0 bundles still validate and read; unknown versions are
refused; drift against the manifest is still refused after the reader's replacement check.

## What is verified, and how

`packages/core/test/engine.test.js` (27 tests) covers every property above, including the
real-HTTP end-to-end runs for both kinds, the repair proof and its limits, the witnesses and a
stripped-HttpOnly mutation, atlas ranking, promotion thresholds, recipe application, the
changeset, organ round-trip and the 5,000-entry performance bounds. The desktop acceptance
drives the workspace plan form in the real renderer and asserts the engine review panel.

## Remaining weaknesses and Engine 1.2

Only one repair class; session-auth still has one hand-written emitter per profile (the spec
drives it, but the templates are not yet generated from IR operations generically); the
feature-flags kind has no GRAFTBench corpus; `sec.constant-time` cannot be witnessed over
HTTP; learned recipes are derived on demand and not yet materialized or versioned; the review
panel shows a bounded slice of the analysis. Engine 1.2 priorities: a generic operation-level
emitter over IR (templates per handler contract, not per kind), a bench corpus for the second
kind and held-out architectures, more repair classes (missing dependency wiring, module-system
mismatch) with the same limits, persisted and versioned learned recipes with expiry, and an
opt-in allowlisted export.
