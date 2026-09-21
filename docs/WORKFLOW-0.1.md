# Verified Transplant Workflow 0.1

Engine 1.2 proved that a real hosted sign-in capability could move from one real repository
into another and be VERIFIED without a live provider. It did so with a hand-built worktree and
a handful of Terminal steps. Workflow 0.1 turns that into something a person does inside the
product, with **zero Terminal steps**, and closes the two honesty gaps Engine 1.2 recorded.

Branch: `feature/verified-transplant-workflow-0.1`, from `feature/engine-1.2-real-transplant-1`
(`4796875`). No engine support was broadened: no new kinds, emitters, languages, providers or
agent authority.

## 1. The proof gap is closed with a witness, not a claim

`sec.no-provider-secret-in-output` was UNOBSERVED in Engine 1.2 because nothing could
honestly prove a negative. It is now witnessed by four cases:

- `expect.noSecretsInOutput: true` on the callback, session and logout steps. The verifier
  scans the raw response body, every raw header and every raw `Set-Cookie` for the sentinel
  values it injected through the provider double (`provider-client-secret`). With no sentinel
  attached the check **fails** rather than passing vacuously.
- `output.no-secret-in-process-output`: a required run-level result that scans the
  application's stdout and stderr. It exists only when sentinels exist.

The verification contract admits `output.*` runner witnesses in `checkedBy`, so the invariant
is `violated` when the process-output witness fails and `unobserved` when it is absent. The
first version of this phase reported the invariant as *held* on the three response cases while
the run failed on a secret in the log — no false VERIFIED, but a misleading proof — which the
leak-mutation test found and this fix removed. Mutations proven FAILED: secret in a body, in a
header, in a cookie, and in the log.

## 2. Token refresh is exercised deterministically

The provider double accepts verification-only controls (`POST /__graft/control`):
`tokenLifetimeSeconds` (1–3600) and `refreshSubject`. A step may carry `providerControl`; the
double is reset after every test. `hosted.refresh.keeps-identity` mints a 2-second token so the
application's own refresh threshold is crossed on the next request without sleeping;
`hosted.refresh.rejects-identity-change` makes the refresh assert another subject and requires
401, no cookie, and refusal of the old snapshot. New invariant `sec.refresh-identity-stable`.
The production token lifetime and the emitted code are unchanged.

## 3. Audience is a structural axis

`classifyAuth` derives `audience` (`user` | `machine` | `mixed` | `unknown`) from what the
code does: login/callback/register routes, cookie sessions, hosted OAuth or magic links mean a
person signs in; a static bearer secret or a client-credentials grant means a program does.
Search understands user-facing and machine wording, filters on audience, and breaks score ties
by evidence count, never by name. Routes and auth signals now come from production files only
(tests, specs and fixtures are excluded). "find user-facing authentication I have already
built": before, 17 candidates with a fixture first and the real source fourth; after, 7
candidates with the real source first.

## 4. Product-managed worktrees

`packages/core/src/apply/worktree.js` prepares an isolated transplant beneath
`GRAFT_HOME/worktrees/<repo>-<slug>-<id>` on `graft/<slug>-<id>`, cut from the recorded HEAD
with `git worktree add --quiet -b <branch> -- <path> <head>`; the new worktree's HEAD is checked
against the record. Refused by name: an invalid slug, a destination inside GRAFT's home, a
non-repository, a repository without commits, a nested folder, a dirty destination (unless the
user allows it, in which case uncommitted work is never included), the source checkout or any
other checkout of the source repository, a GRAFT worktree, branch/worktree collisions and a
concurrent preparation (lock file). The registry is one JSON document with atomic replace.

Lifecycle is descriptive: `PREPARING → READY → APPLIED → VERIFIED | FAILED | INCONCLUSIVE`,
with `STALE` when the worktree disappears or its HEAD moves before apply, and `CLEANED`. The
verdict is copied from the verifier's report. `assertApplyable` runs at plan time, at apply
time, and again immediately before the first write (HEAD equal to the base, no untracked
changes). Apply on a managed transplant writes on the prepared branch — it does not cut a
second branch — and reports that branch.

Cleanup is explicit: a worktree with changes is refused (409) until the user confirms; removal
covers the worktree and every `graft/` branch it ended on, drops the worktree's project
registration, and keeps the CLEANED record as history. Nothing else is ever removed.

## 5. The guided flow

Discover → search → select → **Harvest as source** → Transplant: choose the banked capability,
choose a destination from Capability Memory (`/api/destinations`: every indexed or registered
Node project with per-kind emitter profile, blockers such as `unsupported-profile`,
`no-entrypoint`, `not-a-repository`, `source-is-destination`, and repository state) → **Prepare
isolated transplant** (Open / Reveal in Finder / Copy path / Clean up; Open and Reveal are
desktop IPC restricted to real paths beneath `GRAFT_HOME/worktrees`) → **Build plan** with the
Semantic Changeset review (files to create, files to edit, dependencies, routes, security-
sensitive changes, configuration *names only*, verification contract) and an explicit
approval step when routes already exist → **Apply & verify** with the verifier's own stages
(Booting destination / Running verification / Checking counterfactuals / Checking host
preservation / Recording evidence / Updating Atlas) → **Proof** (required cases, invariants
held/violated/unobserved, counterfactuals, host preservation, repairs, provider boundary,
Atlas, changed files, evidence per case). No agent is involved anywhere in this flow.

## 6. Real acceptance (dogfood `verified-transplant-workflow-1`)

Source `@leftsock/cuf` (read-only, `ec1af9b`, no `.graft`), destination
`cuf-webmcp-challenge` (`7b0f56c`, main, clean). Three product runs; the last, after every
fix in this phase:

- re-harvest through the product (the banked organ was refused because its `contractId` no
  longer agreed with the engine — the message now says to harvest again): VERIFIED 13/13,
  10/10 invariants held, 0 unobserved;
- prepare `~/.graft/worktrees/cuf-webmcp-challenge-hosted-authentication-70d5ab7a` on
  `graft/hosted-authentication-70d5ab7a` from `7b0f56c`;
- plan ready (compatibility warn: introduced `AUTH_*` configuration), 4 files + `server.mjs`;
- apply + verify: **VERIFIED 15/15 required**, 10/10 invariants held including
  `sec.no-provider-secret-in-output` (3 response cases + the process-output witness), 7/7
  counterfactuals, host preservation 2/2, 0 repairs, provider boundary = deterministic double,
  Atlas `sha256:da0f4506…`;
- lifecycle `PREPARING → READY → READY → APPLIED → VERIFIED`; the worktree is on the prepared
  branch and no second `graft/` branch exists; destination main and CUF unchanged;
- cleanup of the previous run's worktree: unconfirmed → 409, confirmed → CLEANED and removed;
- Terminal steps: 0 (scorecard `terminal use 0`).

## 7. What this phase does not do

No Express/return-response hosted emitter, no Python, no new kinds, no new providers, no
autonomous loop, no Git client, no push, no Engine 1.3. GRAFT's own repository still ranks
4th/5th for a user-facing query because its detector sources contain the pattern strings
(recorded as UX friction, not special-cased). `worktree-head-drift` is reached only for a
record that is still READY; in practice `listTransplants` marks such a record STALE first.
