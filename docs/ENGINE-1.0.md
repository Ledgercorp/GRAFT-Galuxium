# GRAFT Engine 1.0

Engine 1.0 is the proprietary core that turns GRAFT from "an app that moves code" into a
software capability transplantation system. It lives in `packages/core/src/engine/` and is
wired into the existing harvest → plan → apply → verify flow without replacing it. The
manifest (organ package 0.2.0) remains the portable unit; the capability contract remains
the behavioral identity; `decideVerdict()` in `verify/index.js` remains the only thing in
GRAFT that can say VERIFIED. The engine explains, structures and learns; it never overrules
a compatibility check or a verdict.

```
source implementation ──harvest──▶ manifest (organ)
                                      │
                                      ├─▶ Capability Genome ─▶ Capability Graph
                                      │          │
                                      │          ▼
                                      │       GRAFT IR ─────────┐
                                      │                         ▼
destination repository ──fingerprint──▶ Host Model ──▶ recipe selection ──▶ engine analysis ──▶ plan.engine / plan.semantic
                                                                                                        │
                                              verification contract (from IR) ──▶ verify ──▶ proof ──▶ Compatibility Atlas entry
```

## Capability Genome (`engine/genome.js`, `genome.json` version 1.0.0)

A structured model of a harvested capability, derived deterministically from the manifest
alone: identity (name, slug, category, kind, capabilityId), purpose (summary, behaviors with
evidence, behaviors not found), entrypoints (HTTP endpoints with role/method/path/purpose and
the tests that observed them; middleware provided to the host), inputs (request schemas with
the credential each requires; environment variables), outputs (response shapes and the cookie
each operation sets or clears), side effects (persistence create/read/update/delete per entity,
client-state cookie changes), dependent modules (source files with role and digest), dependent
libraries (packages, runtime, services), data dependencies (entities, relationships,
migrations, persistence assumptions), runtime assumptions (source shape, runtime ranges,
execution profile), security properties (assumptions, boundaries, notes, plus derived flags such
as HttpOnly, hash algorithm, constant-time comparison, guard status), verification expectations
(tests, behavior coverage, source verdict) and provenance. `genomeId` hashes the behavioral parts
only, so timestamps and paths never change a genome's identity; a changed cookie name does.

Kind-level semantics (what `register`, `login`, `logout`, `currentUser` do to state and to the
client) live in `engine/kinds/session-auth.js` and are attached only to endpoints the harvest
actually found. Engine 1.0 understands the session-auth kind; the structures are kind-agnostic.

## Capability Graph (`engine/graph.js`)

Typed nodes — capability, module, endpoint, middleware, dependency, runtime, service,
environment, entity, side-effect, test, behavior — and typed edges — contains, defines,
provides, requires, reads, writes, causes, relates, proves, exercises, guards, assumes — over the
genome. `neighbors(graph, id, { kind, direction })` answers questions such as "what does login
cause" (read users, create sessions, set cookie) or "what writes to sessions". Validation refuses
unknown kinds and dangling edges. In-memory and JSON; not a graph database.

## Host Model (`engine/host.js`)

A structured model of the destination: project, runtime (engines range, entrypoint, start
script), module system, framework, routing (idiom counts, routes, route files, how routes are
registered and whether the entrypoint wiring is supported), packages, testing (framework, script,
test-file count — reported as unknown when there is no signal), data layer (persistence kind,
store modules, SQL files), existing capability signals (the same detectors used for harvesting),
structure, environment and constraints (handler contract, the emitter profile that applies or the
reason none does). `hostId` hashes the architectural parts.

## GRAFT IR (`engine/ir.js`, version 1.0.0)

The first proprietary intermediate representation: operations (id, role, method, path, input
body and credential, guards, effects, emitted responses and cookie action, behaviors proven),
abstract state (stores with fields, keys and relations), policies that must be preserved exactly
(password hash, session cookie, guard status, uniform login failure), invariants (security, security
boundaries, data assumptions) and adaptation points — module system, handler contract, framework,
route registration, persistence binding — each with the source's value. The emitter profiles
regenerate code from these same parameters; the planner derives mismatches, adaptations and the
verification contract from the IR rather than from file names. Engine 1.1 work: emit directly from IR.

## Planner integration (`engine/planner.js`, `plan/index.js`)

Every plan now carries `plan.engine` (genome, graph, IR, host model, selected recipe,
verification contract, analysis) and `plan.semantic`. The analysis states what capability is
being moved, the required components (generated modules, dependencies with host presence,
runtime ranges, environment variables with host presence, entities and what they bind to,
middleware, endpoints), each architectural mismatch with its severity (none / adapted /
unsupported / unknown) and the concrete adaptation the recipe applies, risks (compatibility
warnings and blocks, security notes, unproven source, an existing capability of the same kind in
the host, unsupported mismatches), unknowns (no host test framework, non-durable persistence,
deployment HTTPS, invariants the HTTP verifier cannot witness) and what verification must prove.
The existing compatibility checks are unchanged and still decide the plan status.

## Verification contracts and proof (`engine/verification-contract.js`, `verify/index.js`)

A capability's verification contract classifies each acceptance test as a success case or a
counterfactual case (its decisive step must be refused, must not issue a credential, or
deliberately withholds one), declares invariants with the tests that can witness them — and
leaves `checkedBy` empty when the HTTP verifier cannot witness one, so `sec.httponly`,
`sec.opaque-session` and `sec.constant-time` are reported as *unobserved* rather than implied —
and names the expected evidence. Verification reports now include `proof`: the contract's cases
with their outcomes, invariants held/violated/unobserved, and an evidence summary. The verdict is
copied from `decideVerdict()`, never recomputed; test outcomes remain passed/failed/inconclusive.

## Compatibility Atlas (`engine/atlas.js`, `GRAFT_HOME/atlas/`)

Each destination verification records an atlas entry: capability id and category, genome id,
source and destination architecture signatures, host id, adaptations attempted, recipe, result
(supported / conditionally-supported / refused), verification verdict and summary, failure
reasons, repair outcome (if any), confidence (basis observed/static/imported, sample size,
relevance) and timestamp; `entryId` hashes the entry so tampering is detectable. Entries are
append-only (identical replays are no-ops; divergent replays are refused). `queryAtlas()` answers
by architecture family — framework, module system, handler contract, persistence, not dependency
lists or versions — and the planner attaches the result as `priorObservations`. The atlas is
descriptive: it never changes a check or a verdict. A recording failure is reported as
`atlasRecordingError`, never treated as recorded.

## Transplant recipes (`engine/recipes.js`)

A recipe is declarative data: applicability (capability kind, source/destination pattern),
transformations (regenerate-module, rewrite-handler-contract, convert-module-system,
bind-persistence, register-routes, substitute-dependency), dependency substitutions,
verification expectations, mechanism (the emitter profile the engine implements) and provenance
with confidence. Two built-in recipes cover the two emitter profiles; `selectRecipe(ir, host)`
matches applicability and requires the mechanism to be the profile the host actually supports.
User recipes are JSON validated on load and can only select mechanisms the engine implements — a
recipe carries no executable code.

## Semantic output (`engine/semantic.js`)

`plan.semantic` is machine-readable: capability, dependent components, target mismatches,
expected changes (create-file, edit-entrypoint, resolve-route-conflicts), transplanted
components, skipped components (source files are evidence and are regenerated, never copied;
behaviors absent in the source), adaptations, risks, unknowns, the verification contract used,
prior observations and the result. `renderSemanticSummary()` renders it for the CLI (`graft plan`
prints "What GRAFT understands") and the workspace review panel shows the same block. After
verification, `semanticOutcome()` adds the verdict, evidence and proof summary.

## Organ alignment (`manifest/io.js`)

An organ package now carries `graft-engine.json` — genome, graph, IR and verification contract —
written under the existing staging/lock/rollback mechanism and re-derived and checked on read:
stored ids that disagree with the manifest are refused. `readManifest()` still returns exactly
the manifest; `readOrganEngine()` returns the validated bundle, or `null` for a pre-engine
package, which remains readable without migration.

## What CI proves

`packages/core/test/engine.test.js` covers genome/graph/host/IR structure, determinism and
validation; verification-contract classification, honest invariant witnessing and proof
evaluation for VERIFIED/FAILED/NEEDS_REVIEW; recipe validation, selection and user-recipe
loading; atlas persistence, tamper detection and queries; planner integration (engine analysis
attached, deciding checks unchanged, unsupported hosts explained); semantic output; and organ
round-trip, drift refusal and pre-engine compatibility. Existing suites continue to prove the
end-to-end transplant and verification behavior the engine describes.

## Engine 1.1 and beyond

Emit code from the IR rather than from the manifest model; add a second capability kind to
exercise the kind-agnostic structures; learned recipes recorded from verified atlas entries;
restart-durability and cookie-flag witnesses so more invariants become observable; atlas
relevance weighting by sample size and recency; an opt-in aggregate export constrained to the
allowlisted shape in `docs/DEFENSIBILITY.md`.
