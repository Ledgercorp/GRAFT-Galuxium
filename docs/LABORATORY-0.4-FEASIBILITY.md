# Laboratory 0.4 — Multi-Capability Composition: STOPPED AT THE FEASIBILITY GATE

Branch `feature/laboratory-multi-capability-0.4` from `feature/laboratory-assembly-continuity-0.3.5`
(`21db0e4`). Phase 0 (composition feasibility) and Phase 1 (open-source qualification) were run
read-only, as instructed. **Two independent blockers stop the phase before orchestration work
begins.** Nothing was implemented, no engine was broadened, no detector was added.

## Phase 0 — composition feasibility (read-only)

Profiles, read from `packages/core/src/emit/profiles.js` via GRAFT itself:

| Capability kind | Supported emitter profiles |
| --- | --- |
| `session-auth` | `esm-return-response`, `express-req-res` |
| `feature-flags` | `esm-return-response`, `express-req-res` |
| `hosted-session-auth` | `express-req-res`, `esm-node-http-central` |

**Intersection of `hosted-session-auth` (capability A) and `feature-flags` (capability B):
`express-req-res` — exactly one common profile.**

Consequences:

- The host must be **Node / ESM / Express**. The `node-esm-http-central` host used in 0.3 cannot
  take feature flags, and the `esm-return-response` profile cannot take CUF hosted authentication.
- The Assembly Planner already handles this: `node-esm-express` exists in `NEW_HOST_ARCHITECTURES`
  with `kinds [session-auth, feature-flags, hosted-session-auth]`, so it **can structurally plan
  both capabilities on one host**. Planning is not the blocker.
- Execution is. `createHost` deliberately writes only the zero-dependency `node:http` shell
  (`unsupported-host-architecture` for anything else). A blank Express application needs the
  `express` package to boot, and verification boots the application. GRAFT has **no dependency
  installer** — `plan/compatibility.js` reports missing packages and tells the person
  `Run: npm install …`. Adding an installer is on this phase's DO-NOT-BUILD list.

So a *new blank* Express host is not executable in this phase. (An *existing* Express project as
host would avoid this, since its `node_modules` already exists and the worktree links them — but
that changes the phase's "new blank application" thesis and is the user's decision, not mine.)

## Phase 1 — open-source qualification (read-only)

Candidate cloned read-only, no fork, no push, no modification:

```
upstream   https://github.com/microsoft/FeatureManagement-JavaScript.git
commit     a5b4f0e6237e6afe673e90956642a4ce27ca5845
branch     main
licence    MIT (Copyright (c) Microsoft Corporation)
status     clean (0 modified files)
location   ~/Developer/GRAFT-Dogfood/feature-management-js
```

Run through **GRAFT's own capability systems only** (`fingerprintProject`,
`discoverCapabilities`, `detectors/feature-flags.js`):

```
name feature-flags detector: found = false, signals = []
discovered capabilities: []
fingerprint: cjs / express / express-req-res, 60 files, entrypoint null
routes found: GET /  ·  GET /Beta  ·  GET /api/getGreetingMessage  ·  POST /api/like
              (all in examples/, none flag-serving)
DEFAULT_FLAGS literal: absent from the entire repository
/flags, /features, /feature-flags route: absent from the entire repository
```

**Qualification condition 1 (existing detector identifies the capability) fails**, so conditions
3–7 are unreachable. The phase forbids adding detector patterns to make it match — doing so would
invalidate the experiment.

### Why it fails, structurally

GRAFT's `feature-flags` capability kind is *an application that serves flags over HTTP with
defaults declared in code*. The detector requires both:

1. a route `GET /flags` (or `/features`, `/feature-flags`), and
2. a source literal `DEFAULT_FLAGS = { name: true|false, … }`.

Microsoft's library is *a feature-management library consumed by applications*: it exposes
`FeatureManager` and provider classes, has no HTTP surface of its own, and its examples take flag
state from **Azure App Configuration** — a hosted flag service as the authority. These are
different things, not a near-miss.

A wider check confirms how narrow the qualifying shape is: across every fixture and dogfood
repository on this machine, the **only** source that yields a `feature-flags` capability is GRAFT's
own fixture `config-service`. `DEFAULT_FLAGS` is GRAFT's own emitter convention
(`emit/feature-flags.js` writes `export const DEFAULT_FLAGS = Object.freeze({…})`), so the detector
currently recognises the shape GRAFT itself emits. An independently authored project matching it by
chance is improbable, which is why no replacement hunt was started (the phase says not to search
endlessly, and to stop early rather than consume usage).

## What this means

The experiment was well posed and the answer is informative:

- **Composition planning is ready.** One common profile exists, the planner already accepts both
  kinds on `node-esm-express`, and 0.3.5's ledger/evidence model supports "A is
  PRESENT_BY_ASSEMBLY_EVIDENCE while planning B".
- **Composition execution is blocked by host bootstrap**, not by orchestration: a new blank Express
  app needs a dependency GRAFT will not install.
- **Capability B is blocked by the capability model**, not by the library: GRAFT can represent a
  flags *service* but not a flags *library*, so ordinary open-source feature-flag software is
  currently inadmissible as a GRAFT capability.

Both are honest limits of today's engine. Neither can be removed without work this phase explicitly
forbids, so no orchestration, ledger or UI code was written.

## Options for the next decision (not taken here)

1. **Existing-project host** — run composition into an Express project that already has its
   dependencies. Removes the host blocker only; capability B remains inadmissible.
2. **Host bootstrap as its own phase** — teach `createHost` an Express shell plus an explicit,
   reviewable dependency step. A real phase, on the DO-NOT-BUILD list here.
3. **Library-shaped capabilities as their own phase** — extend the `feature-flags` kind (detector,
   IR, emitter, contract) to represent a flags library GRAFT wires into a host, which is what would
   actually make "your software + open-source software + GRAFT" true for ordinary libraries.
4. **Two capabilities that are both already admissible** — the only other honest multi-capability
   pairing available today is `session-auth` + `feature-flags` on `esm-return-response`, both
   harvestable from existing fixtures, but neither is open-source-imported, so it proves composition
   without proving the import thesis.

No work beyond this evidence was performed.
