# Laboratory 0.2 — Assembly Planning

A blueprint answers "what should this software do?". An assembly plan answers "how would GRAFT
build that from the selected capabilities?". Assembly Execution (0.3, not built) will answer
"perform those steps". Branch `feature/laboratory-assembly-plan-0.2` from
`feature/laboratory-blueprint-0.1` (`b7de243`).

The planner is an orchestration layer over GRAFT's existing systems — blueprint, Capability
Memory, organ artifacts, Host Model, emitter profiles, transplant plan / apply / verify, Atlas — and
performs none of them. It creates no folder, repository or worktree, writes into no project,
installs nothing and runs no verification. The one thing it writes is the plan, under
`GRAFT_HOME/laboratory/plans/<planId>.json`.

## Plan model (`packages/core/src/laboratory/assembly.js`, schema 1.0.0)

`LaboratoryAssemblyPlan`: `schemaVersion`, `planId` (`plan-<blueprintId>-<6 hex>`),
`blueprintId`, `blueprintName`, `blueprintRevision` (hash of goals, selections and host intent),
`blueprintReadiness`, `createdAt`, `host`, `steps[]`, `dependencies[]`, `order[]`, `edges[]`,
`blockers[]`, `warnings[]`, `evidence[]` (role `evidence-only`), `expectedCapabilities[]`
(capabilityId, kind, provides, configuration *names*, origin + licence), `inputs` (selected
capability ids, hostId, source states — used for staleness), `readiness`, `readinessReason`,
`executable`, `executionAvailable: false`, `authority {deterministic: true, agentDecided: false}`,
`agentAdvice` (advisory or null), `status` `CURRENT` | `STALE` (computed on view).

## Readiness

`DRAFT` (no goals) → `BLOCKED_BLUEPRINT` (blueprint not `READY_FOR_ASSEMBLY_PLANNING`) →
`NEEDS_HOST` → `UNSUPPORTED_HOST` → `BLOCKED_DEPENDENCIES` (cycle) →
`BLOCKED_CAPABILITY_SUPPORT` → `READY_TO_ASSEMBLE`.

`READY_TO_ASSEMBLE` means GRAFT has a deterministic execution path for every planned step. It is
not VERIFIED, not a compatibility claim, and no promise the build succeeds; the plan says so.

The blueprint gate: a blueprint that is `MISSING_CAPABILITIES`, `NEEDS_SELECTIONS` or
`HAS_CONFLICTS` never yields an executable plan. It yields a diagnostic plan: the same ordered
steps, each marked supported or not, plus explicit blockers (`missing-capability`,
`unselected-goal`, `source-unavailable`, `conflict:*`, `unmet-dependency`) with options.

## Host specification

- **Existing project**: `existingHostSpecification(projectId)` builds GRAFT's Host Model
  (`fingerprintProject → buildHostModel`, read-only) and keeps its `hostId`, shape (module system,
  framework, handler contract, persistence), emitter profile and `profilesByKind`, entrypoint and
  existing capabilities. The project root is not stored. A shape with no emitter profile is
  `UNSUPPORTED_HOST`.
- **New blank application**: `newHostSpecification(architectureId)` from an intentionally small
  table derived from the emitter profile table, each proven by a real transplant:
  `node-esm-http-central` (Node / ESM / bare node:http, one central handler → `esm-node-http-central`,
  writes hosted-session-auth) and `node-esm-express` (Node / ESM / Express → `express-req-res`,
  writes session-auth, feature-flags, hosted-session-auth). Persistence: none. Status
  `SPECIFIED_NOT_CREATED`; `exists: false`. No Hono/Fetch, no new profile.
- No host (`decide-later`) → `NEEDS_HOST`.

## Steps

`CREATE_HOST` (new application only; specified, `operation.exists: false` until 0.3),
`REINDEX_HOST` (`fingerprintProject → buildHostModel`), `CHECK_DEPENDENCIES` (the blueprint's
DECLARED dependencies), per capability in order `TRANSPLANT_CAPABILITY`
(`createTransplantPlan → prepareTransplant (isolated worktree) → applyTransplant`, profile named),
`VERIFY_CAPABILITY` (`verifyCapability → decideVerdict` over the organ's verification contract) and
`REINDEX_HOST`; for an existing project `CHECK_HOST_PRESERVATION` (`hostPreservationTests`) before
and after; `FINAL_VERIFICATION` (`decideVerdict` over every applied contract + proof). Each step
carries what GRAFT will do, why, whether it is supported and the reason, and the operation it
names.

## Ordering and cycles

Nodes are the planned goals (required, or optional with a selection); edges come only from
DECLARED dependencies (provider goal → requiring goal). Agent hints are never edges.
`topologicalOrder` is Kahn's algorithm whose frontier keeps the blueprint's DECLARED goal order
(Real Multi-Capability Composition 0.1: independent capabilities are applied in the order the
blueprint declares them, a declared dependency edge overrides that, and a goal id never decides).
The plan records the rule under `ordering` and each entry's `position` / `declaredPosition` /
`decidedBy` under `order`. A
cycle is reported as a `dependency-cycle` blocker naming the loop and the plan is
`BLOCKED_DEPENDENCIES`; nothing reorders around it.

## Capability support (structural)

Per selected implementation: artifact exists in the bank (an unharvested observation is not
applicable — harvest first), source available, engine artifacts (genome / IR / contract) present,
kind has an emitter, the host's profile writes that kind, configuration names known, dependencies
known, licence/provenance visible, transplant + verify operations exist. Every check is shown on the
step. Absence of Atlas history is never a support failure.

## Atlas

Evidence only: per capability the verified/failed families and the evidence status for the
chosen profile. Warnings: `no-prior-evidence` (support is structural, not historical),
`stronger-host-available` (another host shape carries verified transplants), `licence`.

## Agent

`explainAssemblyPlan` (explanation, blocker explanations, host suggestion, ordering rationale,
trade-offs) is projected through the allow-list; authority names (`supported`, `readiness`,
`verdict`, …) are rejected. The answer is stored under `agentAdvice` as advisory; the planner
never reads it. Without an agent `/plan/explain` is refused plainly and the plan is complete.

## Staleness

`checkPlanFreshness` compares the stored plan with the blueprint now: revision hash, blueprint
readiness, each selection's source state (AVAILABLE → SOURCE_UNAVAILABLE / UNSELECTED /
GOAL_REMOVED), and the host id. Any difference → `STALE`, `executable: false`, reasons listed;
the product shows a banner and asks for a fresh plan.

## Persistence and privacy

Atomic `wx` + rename, 0600/0700. `assertStorable` refuses secret-looking values and any home /
`/Users/<x>/` / `/home/<x>/` / `C:\Users\` / `GRAFT_HOME` string. Hosts and capabilities are
referenced by id. The dogfood recorder gets ids, readiness and counts; final state `PLANNED`.

## Product

Blueprint → **Assembly Plan** tab: host chooser (new application architecture, or a registered
project whose Host Model decides), *Build assembly plan*, STALE banner, readiness + reason, host
specification, ordered steps (what / why / support / operation), capabilities involved, blockers
with options, warnings, dependencies, prior evidence (evidence only), optional agent explanation,
and **Assemble application — Coming next** (disabled). Routes `/api/laboratory/plan`, `/plans`,
`/plan/view`, `/plan/delete`, `/plan/explain`; `/api/laboratory` lists the architectures and
registered projects.

## Real packaged run (dogfood `laboratory-assembly-plan-0.2`)

Packaged fixture app, isolated home, `~/Developer` authorized from the page, CUF harvested
VERIFIED 13/13, the Client Portal blueprint rebuilt from the page as in 0.1
(`client-portal-8acbbe`, MISSING_CAPABILITIES), then two plans, Terminal usage 0, no agent:

- **Case A — blocked.** Plan `plan-client-portal-8acbbe-3e3574`, host Node / ESM / Express:
  **BLOCKED_BLUEPRINT**. Blockers: missing-capability × 5 (organizations, billing, file uploads,
  admin, notifications) and unmet-dependency × 2 (billing needs tenant identity; admin needs
  authorization). Diagnostic steps 12 — CREATE_HOST, REINDEX_HOST, CHECK_DEPENDENCIES, the CUF
  transplant + verify + reindex (supported), five TRANSPLANT_CAPABILITY steps *not supported* ("no
  implementation exists in Capability Memory"), FINAL_VERIFICATION. `executable: false`. Nothing was
  manufactured to make it ready.
- **Case B — ready.** *Use in Laboratory → New blueprint* on the harvested capability gave
  `new-application-with-hosted-sign-in-work-27cc2e` (one required goal, CUF selected,
  READY_FOR_ASSEMBLY_PLANNING). Plan `plan-new-application-with-hosted-sign-in-work-27cc2e-40bd36`,
  host NEW APPLICATION — Node / ESM / Express (node ≥20, esm, express / express-req-res, persistence
  none, profile `express-req-res`, specified not created): **READY_TO_ASSEMBLE**. Steps: 1
  CREATE_HOST (supported; operation not built yet), 2 REINDEX_HOST, 3 CHECK_DEPENDENCIES (0
  declared), 4 TRANSPLANT_CAPABILITY Hosted sign-in (workos) via express-req-res in an isolated
  worktree, 5 VERIFY_CAPABILITY (5 success cases, 7 counterfactuals), 6 REINDEX_HOST, 7
  FINAL_VERIFICATION. Warnings: no-prior-evidence (no transplant of this capability into
  express-req-res recorded on this machine — support is structural), licence UNLICENSED caution.
  *Assemble application* shown disabled, "Coming next".
- Stored: 2 plan files under `GRAFT_HOME/laboratory/plans`, 0 local-path leaks, no worktrees
  directory, 0 transplants in the registry, no folder or repository created. Scorecard final state
  **PLANNED**. Screenshots `08-plan-blocked.png`, `09-plan-ready.png`.

Harness note: two launches stalled after activation (debug ports 9340/9341) and passed at once on
9343/9344; the standalone launch probe navigated within 2 s throughout — environment, not product.
The driver now reports the renderer target list when that wait fails.
