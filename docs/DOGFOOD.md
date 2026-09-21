# GRAFT dogfood harness

A local, append-only record of one real GRAFT session, used to study how the product and
Engine 1.1 behave against real repositories. It records what GRAFT observed, decided and
proved — never customer source text — and gives the operator a way to tag observations.

## Recording a session

The harness is opt-in. Nothing is recorded unless a session is named:

```
GRAFT_DOGFOOD=<session> graft ui                       # browser workspace
GRAFT_DOGFOOD=<session> /path/to/GRAFT.app/Contents/MacOS/GRAFT   # packaged desktop app, launched from a shell
```

`startDashboard({ dogfood: '<session>' })` is the programmatic equivalent. Session names
are 1–64 characters of letters, digits, dot, dash or underscore. The workspace footer shows
`Dogfood record: <session> (local file, never uploaded)` while a session is active.

Files land under `GRAFT_HOME/dogfood/<session>/` (default `~/.graft/dogfood/`):

| File | Contents |
| --- | --- |
| `session.json` | session metadata: version, platform, node, engine version, `telemetry: false`, `uploads: never` |
| `events.jsonl` | one JSON event per line, numbered `seq`, appended with mode 0600 |

## What an event records

| Event | Stage | Data |
| --- | --- | --- |
| `session.open` | setup | context of the surface that opened the record |
| `project.register` | register | repository identity of the registered project |
| `harvest` | harvest | source repository identity, capability requested, kind detected, capabilities discovered, harvest policy, source verification report summary, banked or not, elapsed |
| `plan` | plan | source project + fingerprint, destination repository identity, Genome summary, Host Model summary, IR summary, recipe + selection explanation + learned candidates, compatibility, plan status, mismatches/adaptations/risks/unknowns, verification contract counts, Atlas observations consulted (ranked entry ids, scores, reasons), safety preconditions, elapsed |
| `apply` | apply | starting HEAD, transplant branch, files written (paths), entrypoint edit count, receipt engine ids (genome/IR/spec/recipe), initial and final verification report summaries, repair attempts (class, reason, changed files — no edit text), Semantic Changeset (sanitised), Atlas entry generated, elapsed by apply / each verify run / repair loop |
| `apply.refused` | apply | the precondition problems that refused the write |
| `verify` | verify | destination identity, report summary, Atlas entry generated, elapsed |
| `error` | any | message, HTTP status, route or job — refusals (409) and failures alike |
| `observation` | any | operator tag, text, optional `ref` to the event it is about, `intervention`, `terminal` |

`intervention: true` marks a point where a person had to act (trust confirmations and
conflict approvals are recorded as `confirmations` on the event; operator notes can add more).

A **repository identity** is: package name/version, a hash of the root path, the basename,
git HEAD / branch / origin URL with credentials stripped / dirty flag and dirty-file count, the
architecture signature, the source-free structure hash (`projectFingerprint`), shape counts
(files, routes, entrypoint path, dependency names, env-var count, SQL files) and the detector
verdicts with their evidence strings.

## Privacy boundary

Enforced by `sanitize()` in `packages/core/src/dogfood/index.js`, applied to every event:

- Keys that carry source or payload text are replaced by a byte count and sha256 digest
  (`contents`, `before`, `after`, `basis`, `entrypointBefore`, `body`, `headers`, `cookies`,
  `request`, `response`, `stack`, `agentBrief`, `packageJson`) or by a count (`edits`, `steps`).
  A `source` value is dropped only when it is multi-line text; single-line `source` values
  (`plan.source`, `mismatch.source = 'esm'`) are structural and kept.
- Secret-looking tokens (`sk_…`, `whsec_…`, `Bearer …`, long base64 runs) are redacted;
  hex digests (git SHAs, sha256 ids) are identifiers and kept.
- Strings are capped at 2000 characters, arrays at 500 entries, nesting at 12 levels.
- Verification results keep id / outcome / required / reason only; HTTP steps are dropped.

The harness never opens a socket. The product never reads these files back. There is no
export, upload or aggregation path; the files are the operator's to read or delete.

Recording never changes an outcome: the null recorder is used when no session is named, a
write failure is noted in memory and swallowed, and a summariser failure is stored as
`describeError` instead of failing the customer's request.

## Operator commands

```
graft dogfood list                                   # sessions under GRAFT_HOME/dogfood
graft dogfood show <session> [--json]                # every event, one line each
graft dogfood note <session> "<text>" --tag <TAG> [--stage <stage>] [--ref <seq>] [--intervention] [--terminal]
graft dogfood score <session> [--json]               # the scorecard
```

Tags: `ENGINE_DEFECT`, `MISSING_ENGINE_CAPABILITY`, `VERIFICATION_GAP`, `UX_FRICTION`,
`PERFORMANCE`, `EXPECTED_REFUSAL`, `SUCCESS`. Stages: `setup`, `register`, `harvest`, `plan`,
`apply`, `verify`, `repair`, `review`, `rollback`, `other`. `--terminal` marks something a
customer should have been able to do inside GRAFT; `--intervention` marks babysitting.

A false VERIFIED is recorded as a `VERIFICATION_GAP` whose text starts with `false VERIFIED`;
a missed mutation or error as a `VERIFICATION_GAP` whose text contains `missed mutation` or
`missed error`. The scorecard counts those phrases; it never infers them.

## Scorecard

`graft dogfood score` reports observable counts only, each naming the events it came from:
capability recognition (harvests, recognised, verified in source, banked, kinds), Host Model
(profile, unknown dimensions, unknowns), compatibility prediction (per plan status/compatibility
vs the observed verdict and whether they agree), manual interventions, Terminal use, transplant
(applied, branches, final verdict, final PASS / FAIL / INCONCLUSIVE), repair (attempts,
classified, repaired), verification coverage (passed/failed/inconclusive, required, invariants,
route coverage), evidence quality (verdict, rationale, proof contract, Atlas entry, recording
errors), Atlas used/generated, elapsed by stage and total, and the per-tag counts including
false VERIFIED and missed mutations.

Final state is one of five, in priority order — a correct refusal is never scored as a failure,
and `SUCCESS` is only ever the verifier's own `VERIFIED`, copied:

| State | When |
| --- | --- |
| `SUCCESS` | the last recorded verification reported VERIFIED |
| `FAIL` | the last verification reported FAILED, or a non-refusal error stopped the session before any verification |
| `INCONCLUSIVE` | verification ran without deciding, files were written and never verified, or pipeline work never reached verification |
| `SAFE_REFUSAL` | GRAFT was asked to act and declined (an `apply.refused` event, a 409, or an operator `EXPECTED_REFUSAL` note on a session that did ask the pipeline for something); nothing was written |
| `NO_TRANSPLANT_ATTEMPTED` | no harvest, plan, apply or verify was recorded — a discovery-only session |

`finalStateReason` always names the evidence the state came from. Observation tags never
promote a session to `SUCCESS`: a `SUCCESS` note on an unverified session still scores
`INCONCLUSIVE`.

## Rollback and isolation during a trial

GRAFT's own apply path already refuses a dirty destination, a destination without a commit,
and a nested repository unless explicitly allowed; it creates an isolated `graft/…` branch,
writes a receipt with `recovery.entrypointBefore` and the exact `filesWritten`, and records the
rollback instruction. The dogfood `plan` and `apply` events capture the destination's starting
HEAD so the run can be undone by returning to it. Nothing in the harness pushes, commits or
deploys.
