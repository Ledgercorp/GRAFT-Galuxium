# Laboratory 0.1 — Capability Blueprint

The Laboratory answers "What are you building?" with what GRAFT already knows. Branch
`feature/laboratory-blueprint-0.1` from `feature/capability-export-0.1` (`1477d03`).

It sits above Capability Memory, the organ bank, Genome / IR / Host Model, Atlas, provenance and
the Proof Kernel, and reads them. It is not a second transplant engine: it never builds or mutates
an application, prepares no worktree, emits no code, registers no host profile and adds no
capability kind. A blueprint is a design GRAFT can plan assembly from later; its top readiness
state is `READY_FOR_ASSEMBLY_PLANNING`, never `VERIFIED`.

## Domain model (`packages/core/src/laboratory/index.js`, schema 1.0.0)

Authoritative fields are the person's decisions and GRAFT's own data; advisory fields are kept
apart and never promoted.

- `blueprintId` (`<slug>-<6 hex>`, stable), `name`, `description`, `hostIntent`
  (`decide-later` | `new-application` | `existing-project`, optional runtime/framework),
  `goals[]`, `agentAdvice` (`{advisory: true, authoritative: false, task, provider, model, value}` or
  null), `createdAt` / `updatedAt`.
- Goal: `goalId`, `category` (from the vocabulary or null for a free-text goal), `label`,
  `required`, `source` (`user` | `agent-advisory` | `inferred-from-dependency`), `derivedFrom`
  (`description-keywords`, `checklist`, `capability-page`, `agent-suggestion`), `selection`
  (`{kind: 'organ', slug, capabilityId, name}` | `{kind: 'observation', projectId, capability,
  name}` | null).
- Vocabulary (`GOAL_CATEGORIES`): authentication, organizations, billing, file-uploads, roles,
  admin, notifications, search, feature-flags. Each names the Capability Memory categories it can
  search (authentication → `authentication` + `hosted-authentication`; file-uploads →
  `file-uploads`; feature-flags → `feature-flags`; the others have no detector yet) and the
  DECLARED needs it provides/requires (user-identity, tenant-identity, authorization, …).

The stored file never holds the analysis; `viewBlueprint` recomputes it every time.

## Candidates and ranking

`candidatesFor(category)` reads the organ bank and the workspace index. Ranking is deterministic:

| Tier | Meaning |
| --- | --- |
| Best evidence | source VERIFIED and the local Atlas holds verified transplants of this exact capabilityId |
| Strong candidate | source VERIFIED, no transplant evidence yet |
| Possible candidate | TRANSPLANTABLE in Capability Memory but not harvested — "harvest it to gain evidence" |
| Unproven | observed / ambiguous, not harvestable yet |

Ties break by verified Atlas count, then detector signal count, then name. Each candidate shows
its origin (`your-project` / `open-source` by licence detection, or `workspace-observation`) and
its licence state (`detected` with the declared name — `UNLICENSED` carries the all-rights-reserved
caution — `not-detected`, `private-unspecified`, `not-inspected` for unharvested code). Unknown
stays unknown. An observation of a project that is already harvested says so rather than inviting a
second harvest. Missing goals read **NOT FOUND** with the reason (no detector, or searched and
nothing found); nothing is fabricated ("Create new capability — coming later").

Host evidence per emitter profile is reported as `verified-evidence` (Atlas count) or
`verified-evidence-unavailable (requires future compatibility analysis)` — absence of evidence,
not incompatibility.

## Dependencies, conflicts, readiness

Levels: `PROVEN` (Atlas co-verification; reported absent in 0.1), `DECLARED` (GRAFT's vocabulary;
satisfied only by a *selected* implementation's provides), `INFERRED` (a harvested organ's
declared external services, packages, runtime; supplied by configuration), `ADVISORY` (agent
dependency hints; never satisfied, never blocking), `UNKNOWN` (free-text goals). AI inference is
never upgraded to a fact.

Conflicts come from structural evidence only: exclusive routes registered by two selections,
session ownership, credential authority, module system (a note, non-blocking), duplicate goals,
runtime intent vs organ runtime, and `source-unavailable`. Each carries options; none is resolved
silently.

Readiness precedence: `DRAFT` (no goals) → `HAS_CONFLICTS` → `MISSING_CAPABILITIES` (a required
goal has no candidate) → `NEEDS_SELECTIONS` → `READY_FOR_ASSEMBLY_PLANNING` ("every required goal
has a selected implementation, no declared dependency is unmet and no structural conflict is known
— this is not a compatibility or verification claim"). `analysis.authority` is always
`{deterministic: true, agentDecided: false}`.

A selection whose organ vanished from the bank (or whose capabilityId changed), or whose observed
project left the workspace, becomes **SOURCE UNAVAILABLE**; nothing is substituted and readiness
drops to `HAS_CONFLICTS` until the person chooses again.

## Agent (optional)

`interpretBlueprintIntent` may suggest goals (category from the vocabulary or `unknown`),
questions, dependency hints and notes. The response is projected through the allow-list; authority
names are rejected as `AuthorityViolation`. Suggestions are stored under `agentAdvice` and shown as
*advisory*; a goal enters the blueprint only when the person clicks *Accept as a goal*
(`source: agent-advisory`). Without an agent the product refuses `/advise` plainly and everything
else works from the description, the guided checklist and manual goals.

## Persistence and privacy

One JSON per blueprint under `GRAFT_HOME/laboratory/blueprints/<id>.json`, written through a
`wx` temp file and rename (0600/0700). `assertStorable` refuses secret-looking values (keys
matching secret/token/password/api-key/private-key), any string containing the home directory,
`/Users/<x>/`, `/home/<x>/`, `C:\Users\` or `GRAFT_HOME`. Blueprints reference capabilities by id,
never by path; the dogfood recorder receives ids and counts only (never the description).

## Product

- Sidebar **Laboratory**. Home: name, description, "Do people need to…" checklist, starting point,
  *Create blueprint*, saved blueprints (open / delete).
- Blueprint: Overview (readiness badge + reason, goal tree with selections and declared needs, host
  intent, agent advice and *Help me design this* when an agent is configured) · Capabilities (add
  goal, required/optional, remove, ranked candidates, NOT FOUND, SOURCE UNAVAILABLE) ·
  Dependencies (level table) · Conflicts · Evidence ("Why did GRAFT recommend this?": origin and
  licence, source verdict and count, genome/capability ids, architecture, Atlas families, host
  evidence per profile, declared dependencies, configuration *names*, external services).
- Capability page **Use in Laboratory**: choose a draft or a new blueprint; the organ becomes the
  selected implementation of its goal, unless the person already chose something else for that goal
  (kept; the organ is then a candidate).
- Routes: `/api/laboratory`, `/blueprint`, `/create`, `/delete`, `/goal`, `/select`, `/host`,
  `/use`, `/advise` — strict field allow-lists; every response is the stored blueprint plus a fresh
  analysis.
- Dogfood final state `BLUEPRINTED` (a `laboratory.create` event with no plan/apply); never
  `SUCCESS`.

## Real packaged run (dogfood `laboratory-blueprint-0.1`)

Packaged fixture app, isolated home, `~/Developer` authorized from the page (33 projects, 21
capabilities), CUF harvested VERIFIED 13/13, then the Laboratory: "A client portal: customers sign
in, belong to an organization, upload files, pay invoices, and get notifications; staff use admin
controls." with the six checklist boxes. Result, unedited:

- 6 required goals. Authentication: 8 candidates — the CUF organ *Strong candidate* (source
  VERIFIED, no Atlas evidence in this fresh home; origin Your project, licence UNLICENSED with
  caution), 4 Possible observations, 3 Unproven. Organizations, billing, admin, notifications:
  NOT FOUND (no detector). File uploads: searched, NOT FOUND.
- Selected the CUF organ. Dependencies: user-identity DECLARED satisfied for five goals;
  tenant-identity for billing unmet (blocking); authorization for admin unmet (blocking, no goal
  provides it); INFERRED external service workos. Conflicts: none. Host evidence: unavailable for
  both profiles (shown as absence).
- Readiness **MISSING_CAPABILITIES** ("5 required goal(s) have no implementation in Capability
  Memory"). No agent. Stored `client-portal-5dae54`: 0 path leaks, no secret values, no analysis.
  Product-user Terminal usage 0; manual interventions 5. Scorecard final state BLUEPRINTED.

Driver note: two launches stalled after activation on the fixed debug port 9336 (the page never
navigated); the same build passed on `--port 9338` at once — harness environment, not product.
`real-demo.mjs` now takes `--port` and `--blueprint`.
