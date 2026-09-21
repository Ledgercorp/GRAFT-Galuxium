# Workspace Capability Index and Agent Runtime (0.1)

Two systems, deliberately separate:

- The **Workspace Capability Index** is a local structural map of the software you have
  already written. It answers *what have I built, where is it, what kind is it?*
- The **Agent Runtime** is an optional, replaceable reasoning layer that can interpret a
  request and reorder results. It decides nothing.

Both were built from Dogfood Phase 1 evidence: GRAFT could not see three real authentication
systems in a five-repository workspace, because the only question it could ask was "is this
the one shape I can transplant?".

## Discovery is not transplantability

This is the load-bearing distinction of the whole phase.

| Question | Answered by | Field |
| --- | --- | --- |
| Does something like this exist here? | index detectors | `state`, `signals` |
| Can GRAFT harvest it? | **GRAFT's own harvest detector, alone** | `harvestable` |
| Could it be moved out of here? | runtime + language + harvestability | `transplantSupport` |
| Could something be planted into here? | emitter profile + entrypoint + build layout | `asDestination` |
| Could GRAFT prove it locally? | server, entrypoint, external dependencies | `localVerification` |

A capability may be strongly detected, fully explained, and entirely unsupported. The index
says so; it never widens support to make a workspace look better.

## Project, repository, worktree

`packages/core/src/workspace/identity.js`.

- A **repository** is identified by its git *common directory*, so every worktree of one
  repository resolves to the same `repositoryId`. CUF's 31 extra checkouts under
  `~/.sockdev-agent-bridge/worktrees/` are recorded as alternate checkouts of one repository
  rather than 31 unrelated projects.
- A **project** is a repository root or a subproject inside it; `projectId` combines the
  repository id with the project's path relative to the checkout, so the same subproject in
  two worktrees is recognisably the same logical project.
- A **non-git directory** with a manifest is still a project (`dir:<hash>`).
- Remote URLs are stored with any embedded credentials stripped.

**Monorepo boundaries come from declared evidence only** (`findSubprojects`): npm/yarn
workspace globs, and `apps/*`, `packages/*`, `services/*` directories that actually carry a
manifest. A directory with no manifest is not a project, whatever it is called.

## What the index records

Per project (`indexProject`): logical project id, repository id, workspace root, absolute
root, relative root, subproject-of, boundary reason; language, runtime, runtime version
constraint, module system, framework, package manager, declared workspaces; source root,
build output directory, `isCompiled`; entrypoint candidates with reasons and confidence, and
the selected entrypoint split into **runtime** and **source**; `hasHttpServer`, server
signals, handler contract, route idioms and route shapes; every package script; dependency
names and ranges; test commands, test file count and locations; **environment variable names
only**; config file types; storage signals; external service hostnames; deployment targets;
git branch, HEAD, dirty state, alternate worktrees; file counts; indexed-at, elapsed, and an
invalidation fingerprint.

### Entrypoints

The old model — a fixed filename or `scripts.start` — missed `serve: "node server.mjs"`.
Entrypoints are now found from **every** package script (`node`, `tsx`, `ts-node`, `python`,
`uvicorn`), from `package.main`, and structurally from files that call `createServer`,
`listen`, or a framework constructor. Test scripts and test files are excluded.

For a compiled project the **runtime** entrypoint (`dist/index.js`) and the **source**
entrypoint (`src/index.ts`) are stored separately, mapped through `tsconfig` `rootDir`/
`outDir`. A transplant must never edit generated output, so the generated file is never
offered as the editable source.

### Route idioms

Recognised: `table` (`router.add('GET', …)`), `verb-method` (`app.get('/…')`), **`path-comparison`**
(`method === 'GET' && path === '/auth/login'`), **`switch-dispatch`**, and **`decorator`**
(FastAPI/Flask, discovery only). Recognition is not support: several of these have no
emitter, and the index says so in `asDestination.blockers`.

## Capability observations

`packages/core/src/workspace/capabilities.js`. States: `OBSERVED`, `STRONGLY_DETECTED`,
`HARVESTABLE`, `TRANSPLANTABLE`, `UNSUPPORTED`, `AMBIGUOUS` — kept distinct on purpose.

### Authentication taxonomy

Subtypes overlap because real systems combine them: `local-password`, `cookie-session`,
`hosted-provider-oauth`, `oidc`, `oauth2-pkce`, `jwt-bearer`, `api-key-static`,
`m2m-client-credentials`, `magic-link`, `custom-unknown`.

Three axes are recorded **separately** — the central Phase 1 finding:

```
credentialAuthority   local | hosted-provider | shared-secret | external-idp | unknown
sessionTransport      cookie | bearer-header | none
sessionCustody        local | provider | stateless | none
sessionStore          memory | database | provider | none
sessionDurableAcrossRestart
```

CUF is `credentialAuthority: hosted-provider (workos)`, `sessionTransport: cookie`,
`sessionCustody: local`, `sessionStore: memory`, `durable: false` — it owns a complete session
layer while owning no credentials. That is inexpressible as `auth: yes`.

Signals carry their evidence and file: login/callback/logout/current-user routes, provider
dependency or host, authorization-URL construction, token exchange, PKCE, password hashing
and algorithm, bearer-header checks, constant-time comparison, session cookie and flags,
opaque id generation, session store and expiry, guards, CSRF, outbound M2M token acquisition.

**Negative information is preserved.** `missingSignals` explains why a real capability is not
harvestable — for example *"this project validates no password itself (credentials live with
workos)"* — which is what lets GRAFT be useful about something it cannot yet move.

### Feature flags

Source (`environment`, `config-file`, `remote-provider`), scope (`global`, `user`, `tenant`),
rollout/variant signals, and a confidently detected *none*.

## Storage

One versioned JSON document at `GRAFT_HOME/workspace-index.json`, written atomically
(temp file + rename, mode 0600), rebuildable from source at any time. A mismatched
`indexVersion` triggers a rebuild rather than a misread; genuine corruption is reported, never
silently replaced. Only authorized roots are ever scanned. Incremental re-scans reuse projects
whose invalidation fingerprint (git HEAD, dirty flag, branch, manifest mtimes/sizes) is
unchanged; `staleProjects()` lists the rest; `refreshProject()` re-indexes one.

**Never stored:** environment variable values, secrets, credentials, source text, or remote
URLs with credentials.

## Deterministic search

`searchCapabilities` needs no model. A fixed vocabulary maps plain wording to structural
filters ("keeps users logged in" → capability `authentication` + `sessionTransport: cookie`),
and results carry `matchedBecause`, the evidence signals, harvestability, transplant support,
local-verification feasibility and current blockers. Ranking is structural matches, then
evidence strength, then how usable the capability actually is.

## Agent Runtime

`packages/core/src/agent/`. Advisory by construction.

**Tasks:** `interpretCapabilityRequest`, `rankCapabilityCandidates`, `explainCandidate`,
`explainArchitectureMismatch`, `suggestRecipe`, `suggestRepair`. There is deliberately **no**
task for deciding a verdict, marking something verified, or forcing compatibility — those do
not exist on this side of the boundary.

**Providers:** Anthropic, OpenAI, and any OpenAI-compatible endpoint (including a local model
server over loopback HTTP). Endpoints must be HTTPS or loopback and may not carry credentials.

**Credentials:** yours. `GRAFT_HOME/agent.json` stores provider, model, endpoint and scopes —
never a key. Keys are read at request time from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`GRAFT_AGENT_API_KEY`, or from OS-backed secure storage in the desktop app. A config file
found to contain a key is refused rather than used. **The product is fully functional with no
agent configured.**

### Permission scopes

Default grant is metadata only: `workspace:metadata`, `capability:metadata`,
`capability:rank`, `capability:explain`. Off by default: `engine:genome`, `engine:host-model`,
`engine:ir`, `atlas:summary`, `recipe:suggest`, `repair:suggest`, and the sensitive
`source:snippet` / `source:file`. **Ungrantable at any setting:** `command:run`,
`destination:write` — GRAFT performs those itself. Needing more permission returns a narrow,
named escalation rather than failing.

### Context sanitization

Allow-list, not deny-list: context objects are rebuilt field by field from named safe values,
so an unconsidered field cannot leak. Then `assertSendable` refuses the whole request if
anything resembling a credential, an absolute home path, a sensitive field name with a value,
or source text survived. Source excerpts exist only behind an explicit grant, are bounded to a
named file and line window, and are redacted.

**Safe by default:** project and repository names, relative paths, language/runtime/framework,
route paths and methods, dependency names and ranges, environment variable *names*, auth
subtype, credential authority, session transport, cookie *flags*, capability signals, missing
signals, detector explanations, support status, architecture fingerprints, Atlas ids/scores/
reasons, Genome/Host/IR summaries.

**Sensitive (explicit grant only):** raw source text, absolute home paths, environment values,
secret/key files, credentials, Authorization headers, cookies and session values, database
contents, customer data, git remote credentials, full commit history.

### Authority firewall

Structural, not a prompt instruction:

1. **Allow-list projection.** Each task declares exactly which fields and types its response
   may contain; the response is rebuilt from that declaration and everything else is dropped.
2. **Authority names are fatal.** If a response mentions a reserved name anywhere, at any
   depth, under any casing or spelling (`verdict`, `verified`, `is_verified`, `compatible`,
   `harvestable`, `transplantSupport`, `proof`, `receipt`, `passed`, `overrideRefusal`, …),
   the **entire response is rejected** — never cleaned and used.
3. **Ids, not data.** Rankings reference opaque candidate ids; GRAFT re-resolves every
   candidate from its own index, so no field a user sees originates from a model. An unknown
   id is discarded and a forgotten candidate keeps its deterministic position.

An agent failure — network, malformed JSON, permission, authority violation — degrades the
ranking and never the discovery.

## Privacy summary

Local by default. No telemetry. No source upload. No cloud index. No training collection. No
hidden aggregation. No source-code Atlas entries. The index and agent config are files under
`GRAFT_HOME` that the user can read or delete, and the index can always be rebuilt.
