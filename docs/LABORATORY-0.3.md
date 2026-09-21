# Laboratory 0.3 — Assembly Execution (one capability)

The first phase in which the Laboratory creates and modifies an application. Branch
`feature/laboratory-assembly-execution-0.3` from `feature/laboratory-assembly-plan-0.2`
(`969b0f9`).

Scope is deliberately narrow: **one** blank host (Node / ESM / bare `node:http`, one central
handler) and **one** capability (CUF hosted-provider authentication). The point is not arbitrary
app generation; it is that the chain

```
Blueprint → Assembly Plan → Create Host → Re-index → Transplant → Verify → Re-index → Result
```

runs through GRAFT's existing authority systems, with `createHost` as the only new operation.

## What is new

`packages/core/src/laboratory/execution.js`:

- **`createHost`** — the CREATE_HOST operation. Writes `package.json` (private, `type: module`,
  `engines.node >= 20`, `start: node server.mjs`, no dependencies), `server.mjs` (one module-scope
  `http.createServer(async (req, res) => …)` with `/health`, `/`, and a deterministic 404),
  `.gitignore` and `README.md` into a **new child folder** of a parent the person chose. Files are
  staged in a hidden sibling, `git init` + one commit authored "GRAFT Laboratory" runs there, and
  the folder is renamed into place — the rename is the authoritative handoff, so a failure before it
  leaves nothing behind. No remote is configured. Nothing in the created application references
  GRAFT; it runs with `npm start` like any other Node project.
- **`checkCreatedHost`** — compares the *actual* fingerprint of what was written against the plan
  (module system, framework, handler contract, emitter profile, central-handler support). GRAFT does
  not trust the specification merely because it wrote it.
- **`LaboratoryAssemblyExecution`** (schema 1.0.0) — `executionId`, `planId`, `blueprintId`,
  `planRevision`, `status`, `steps[]` (PENDING/RUNNING/DONE/FAILED/SKIPPED), `receipts[]`,
  `verification`, `hostPreservation`, `reindex`, `proofReferences[]`, `createdProject`, `worktree`,
  `transplantId`, `finalState`, `finalSummary`. Persisted atomically under
  `GRAFT_HOME/laboratory/executions`.
- **`checkExecutionEligibility`** and **`acquireExecutionLock`** — see below.

## Execution states

`PREPARING → CREATING_HOST → HOST_CREATED → INDEXING_HOST → PREPARING_WORKTREE →
PLANNING_TRANSPLANT → APPLYING → VERIFYING → REINDEXING → COMPLETED`, plus terminal `FAILED`,
`INCONCLUSIVE`, `BLOCKED`, `STALE`.

`COMPLETED` means the orchestration finished — never that anything is verified. The result is
reported in three separate lines:

```
Assembly:                      COMPLETED
Hosted authentication:         VERIFIED (15/15 required)
Final assembly verification:   one capability, verified by its own contract on the created host;
                               host behaviour preserved; no composed multi-capability proof exists
```

The stored wording says it outright: *"This is not a 'verified app' claim."*

## Eligibility and the lock

Before anything is written, the plan is re-read and re-checked against the blueprint as it is
*now*: plan freshness (`STALE` is refused), `READY_TO_ASSEMBLE`, a new-application host of
architecture `node-esm-http-central`, exactly one `TRANSPLANT_CAPABILITY` step, every step
supported, and a named capability id. A `wx` lock file per plan prevents a second concurrent
execution. Inside the run the banked capability's id is compared with the one the plan selected; a
different organ stops the execution as `BLOCKED`.

## Operation mapping

| Step | Operation |
| --- | --- |
| CREATE_HOST | `createHost` (new in this phase) |
| REINDEX_HOST | `fingerprintProject` → `buildHostModel` (+ `checkCreatedHost`, `addProject`) |
| CHECK_DEPENDENCIES | the plan's DECLARED dependencies |
| TRANSPLANT_CAPABILITY | `prepareTransplant` → `createTransplantPlan` → `checkPreconditions` → `applyTransplant` |
| VERIFY_CAPABILITY | `verifyCapability` → `decideVerdict` (verdict copied, never computed here) |
| REINDEX_HOST | `fingerprintProject` → `buildHostModel` → `discoverCapabilities` |
| FINAL_VERIFICATION | derived from the referenced outcomes only |

The dashboard's apply path was extracted into one `applyAndVerify(...)` used by both the Apply
button and the Laboratory, so assembly cannot bypass any transplant safety check.

## Worktree isolation

The created repository is never written to by the capability apply. `prepareTransplant` cuts a
managed worktree (`graft/hosted-authentication-<id>`) from the created repo's initial commit inside
`GRAFT_HOME/worktrees`; the transplant is applied and verified there. The created checkout stays on
`main` at its initial commit, clean. The product says where the verified application lives and
offers *Open assembled project* / *Reveal in Finder*; nothing is merged or promoted automatically.

## Failure semantics

CREATE_HOST failure, a fingerprint that does not match the plan, a refused transplant plan, failed
preconditions, `FAILED` verification, or `INCONCLUSIVE` after the verifier's own single
transport-timeout retry: the run stops, the step is marked FAILED, every later step becomes
SKIPPED, and the final state is FAILED / INCONCLUSIVE / BLOCKED. No AI repair loop exists in this
phase, and no step is retried by the Laboratory.

## Agent

The agent may explain a plan (`explainAssemblyPlan`, advisory). It takes no part in execution: it
cannot start, skip, advance or conclude a step, and authority names are rejected by the projection.
Both packaged runs recorded `agentAdvice: null`.

## Product flow

*Assemble application* is enabled only on a CURRENT, READY_TO_ASSEMBLE plan for a new
`node-esm-http-central` host. It opens a confirmation naming the four things GRAFT will do, an
application name, **Choose folder**, and "No deployment will occur." Progress is rendered from the
execution record's own states — Creating host, Indexing host, Checking dependencies, Applying
capability, Verifying, Final check — never narrated ahead of it. A BLOCKED_BLUEPRINT plan keeps the
control disabled, and `/api/laboratory/execute` refuses it with 409.

## Real packaged run (dogfood `laboratory-assembly-execution-0.3`)

Packaged fixture app, isolated home, `~/Developer` authorized from the page, CUF harvested
**VERIFIED 13/13**, Client Portal planned → BLOCKED_BLUEPRINT (7 blockers, Assemble disabled), then
*Use in Laboratory → New blueprint* on the harvested capability → READY_TO_ASSEMBLE →
**Assemble application**, Terminal usage 0, no agent:

- Execution `exec-new-application-with-hosted-sign-in-work-3509d3-332c3b`, all seven steps DONE.
- Created `…/authenticated-application`: `.gitignore`, `README.md`, `package.json`, `server.mjs`;
  commit `5507e125` on `main`, clean, **no remote**. Post-create fingerprint: `node` / `esm` /
  `node-http` / `node-res`, central handler supported, profile `esm-node-http-central` — matching
  the plan, so the transplant proceeded.
- Worktree `graft/hosted-authentication-95219ad1`; transplant plan
  `graft-hosted-authentication-8dc0affd` (recipe `hosted-session-auth → esm-node-http-central`,
  4 files written, 3 entrypoint edits).
- Verification **VERIFIED 15/15**; proof: 12 cases passed, 10 invariants held, 0 violated, 7
  counterfactuals passed; deterministic provider double, no live WorkOS. Host preservation 2/2.
- Final re-index: hostId `sha256:7cef99d3`, profile `esm-node-http-central`, 2 routes; Capability
  Memory observed **no** authentication capability there (detector support) and none was invented.
- Scorecard final state **ASSEMBLED**; CUF and the organ bank unchanged.

Standalone check: the created app answers `/`, `/health` and 404; the assembled worktree app still
answers `/health` and now redirects `/auth/login` (303) to the provider.

## Environment honesty

This machine was memory-starved during the phase. One run's CUF source verification returned
NEEDS_REVIEW (12/13, one case inconclusive) and one assembly took 632 s and ended INCONCLUSIVE with
later steps SKIPPED — both correct refusals, preserved under
`~/.graft-demo/laboratory-assembly-execution-0.3-inconclusive-run`. The packaged harness also stalls
intermittently attaching DevTools after activation; a standalone probe rendered the same build in
4 s every time, so it is classified as harness/environment. The driver now polls gently and reloads
the renderer once; no product semantics were changed for it.
