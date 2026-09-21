# GRAFT

**Find it. Fit it. Prove it.**

Harvest a working capability from an existing project, regenerate it in another project's architecture, and verify its behavior over HTTP.

GRAFT is a local developer tool with a macOS desktop application, a browser workspace and a CLI. The 0.5.0 release candidate supports email/password authentication with cookie sessions, two destination architectures, and deterministic source and destination verification. It does not require an AI provider, account, or hosted service.

## Hosted judge experience

The [Galuxium judge experience](https://judge-topaz.vercel.app) is a read-only replay of a real, sanitized fixture workflow. It lets judges inspect discovery, source verification, architecture adaptation, generated changes, destination verification, and provenance without uploading a repository or executing code remotely. Repository-sensitive execution remains local. See [docs/GALUXIUM-JUDGE-EXPERIENCE.md](docs/GALUXIUM-JUDGE-EXPERIENCE.md) for the evidence boundary and reproduction steps.

The public downloadable product artifact is a separate submission item and is still pending. Its final download location will be linked here after the signed publication candidate passes release acceptance.

## Quick start

Requires Node.js 20 or newer and Git. macOS and Linux are the supported release targets; Windows process-tree cleanup is not supported to the same level.

```sh
npm ci --ignore-scripts
npm start
```

Open **http://127.0.0.1:4317**. The workspace lets you add projects, inspect discovered capabilities, harvest verified authentication, review complete generated files and before/after entrypoint edits, apply a transplant, and inspect HTTP test results. Click **Create sample workspace** to try it with two isolated copies of the bundled projects. These sample repositories remain under `GRAFT_HOME` for inspection.

Choose **Projects → Explore → Harvest** for the source, then **Organ bank → Plan transplant** for a destination. A clean, committed destination and explicit approval of conflicting route changes are required. The final action asks you to approve the reviewed changes and trusted code execution. Every displayed verdict comes from the engine's observed results.

Alternatively, `npm run demo` runs the same underlying workflow in the terminal on temporary repositories.

To install a distributable CLI from this checkout:

```sh
npm pack
npm install --global ./graft-0.5.0.tgz
graft ui
```

The tarball includes the browser workspace, CLI, core, and demo fixtures. It works outside this checkout. Use `graft ui --port 4318` (or `GRAFT_UI_PORT=4318 npm start`) if the default port is in use. Public registry publishing remains disabled with `private: true`.

The dashboard binds only to `127.0.0.1`; it is a local application, not a cloud service. Leave its process running while using it. Refresh the page after a server restart to establish a new session. Closing the server with Ctrl+C waits for the active operation to finish. Initial transplant test results are saved in recovery receipts; later re-verification runs and other session activity remain in memory. Projects, the organ bank, and transplant history persist across restarts. Do not expose this server through a proxy or tunnel.

## Desktop application

An Apple Silicon macOS build packages the same workspace and engine with a bundled Node runtime, so it needs no Node installation of its own. Build it with `npm run desktop:make` and verify a build with `npm run desktop:package -- --fixture` followed by `npm run desktop:accept`. The candidate carries only a local ad-hoc development signature and no configured licence product, so it is not notarized or ready for public distribution. See [docs/DESKTOP-0.5.md](docs/DESKTOP-0.5.md).

GRAFT's purchase and licensing backend lives in `packages/licensing`: one product at $49 one-time through Stripe Checkout, with Stripe as merchant of record (Stripe Managed Payments handles tax). The desktop app never holds a Stripe secret; payment is verified server-side. See [packages/licensing/README.md](packages/licensing/README.md).

## Use your projects

```sh
graft add /path/to/old-project
graft add /path/to/new-project
graft harvest old-project
graft harvest old-project --capability authentication
graft bank
graft plan authentication --to new-project --json graft-plan.json
graft transplant authentication --to new-project --dry-run
graft transplant authentication --to new-project
graft verify authentication --in new-project
```

Use a committed, clean destination repository. Review the plan first. If routes collide, inspect the listed conflicts and explicitly supply `--resolve-conflicts` to comment out the complete old registrations. Unrecognized options and missing values are errors; a failed or inconclusive verification exits nonzero. `graft plan` also exits nonzero for blocked or unresolved plans.

`harvest` without `--capability` only discovers candidates. Harvesting a selected capability starts and tests the source by default. `--no-verify-source` skips execution and records the result as unproven. `--bank-unverified` retains a failing source manifest for inspection; it cannot be transplanted.

**Verification executes project code with your operating-system privileges.** Only run projects you trust. The controlled child environment, timeouts, and process-group cleanup are not an operating-system sandbox. See [SECURITY.md](SECURITY.md).

## Supported shapes

| Capability / destination | Support |
| --- | --- |
| Email/password auth, scrypt, opaque cookie sessions | Harvest and transplant |
| ESM app with handlers returning `{ status, body, headers }` | `esm-return-response` emitter |
| ESM Express app with direct top-level `app.get/post/...` and `app.listen` | `express-req-res` emitter; exercised against Express 5.2.1 |
| CommonJS source using `node:http` / `req, res` | Source discovery and verification |
| File uploads | Discovery only |
| CommonJS Express destination, mounted routers, dynamic routes, framework-managed startup | Refused for automatic transplant |

The Express profile supports one default Express import, one application, direct static routes, and inline/body-parser middleware. GRAFT preserves surrounding middleware and trailing 404 handling. Unsupported wiring is reported before writes. Generated files are new implementations of the manifest contract, not copied source files.

The runtime starts `node -- <entrypoint>` and requires the application to listen on `process.env.PORT`. Install the project's own dependencies before verification. GRAFT neither installs destination dependencies nor loads its `.env` credentials.

## What VERIFIED means

- `VERIFIED`: every required acceptance test passed against the running application.
- `FAILED`: a required assertion failed.
- `NEEDS_REVIEW`: behavior could not be established, for example because the app did not start or a request timed out.

Empty/unsupported assertions, missing required evidence, duplicate test IDs, inconsistent source summaries, and invalid imported manifests are refused. Reports redact recognized secret patterns and cap captured output and response sizes. Source provenance is an auditable local record, not a cryptographic attestation; rerun verification for manifests from another party.

Passing these tests establishes the specified behavior. It is not a production security assessment of the generated authentication system. In-memory users/sessions do not survive restart. Production adoption requires an appropriate persistent store, HTTPS/cookie policy, abuse controls, and application-specific security review. OAuth, MFA, password reset, email verification, and AI-provider integration are not included.

## Local state and recovery

Projects and harvested packages live in `~/.graft`, or the directory named by `GRAFT_HOME`. Registry updates use a lock and atomic file replacement. Corrupt registry files are preserved and reported; restore or repair them before retrying. A stale `registry.lock` may be removed only after confirming no GRAFT command is running.

Organ-bank updates stage and validate a complete replacement, hold a per-package lock, and keep the previous directory until the new package is installed. Failed writes restore the previous package; a reader never accepts sections mixed across generations. A re-harvest also removes obsolete source-verification evidence. Extra files you added to a package cause a refusal rather than being deleted.

### Recover an interrupted organ-bank update

A crashed writer leaves `.<slug>.graft.lock` beside the package. `graft bank` reports it even if the main directory is temporarily absent. The lock records the writer PID, target, and previous-package path. Confirm that the writer has stopped before recovery; a PID alone is not proof of ownership because operating systems reuse PIDs.

1. Back up the target, `.<slug>.graft.previous`, matching `.<slug>.graft-stage-*` directories, and the lock outside the organ bank before changing anything.
2. If `<slug>.graft` exists, keep it. If it is absent and `.<slug>.graft.previous` exists, rename that previous directory back to `<slug>.graft`. If neither exists, keep the backup and re-harvest after cleanup.
3. Move leftover staging/previous directories out of the bank, then remove the stale lock. Run `graft bank` to validate the recovered package; re-harvest if it is unreadable. Keep the external backup until satisfied.

The process-crash and ordinary I/O failure paths are tested. This is not a guarantee against filesystem corruption or whole-machine power loss. Reads require no writable lock file, so completed packages can still be read from a read-only bank. Concurrent edits outside GRAFT's lock remain unsupported.

Transplants create a `graft/<capability>-<id>` branch and `.graft/transplants/<plan-id>.json` receipt. The receipt records the previous branch/HEAD, written files, original entrypoint, and applied edits. **The original entrypoint may contain sensitive project code; keep receipts private.**

To undo a transplant, stop the destination, inspect the receipt, restore the entrypoint from `recovery.entrypointBefore`, and remove only the generated paths in `filesWritten`. Preserve any changes you made after the transplant. Then return to `recovery.branchBefore` (or `recovery.headBefore` for a detached HEAD). Switching branches alone does not undo uncommitted changes. Save or remove the receipt after reviewing it.

GRAFT preflights all output, entrypoint, and receipt paths, refuses symbolic/hard links and traversal, and exclusively creates new files. A write failure removes files created by that attempt and restores the entrypoint; the temporary recovery branch may remain selected. Avoid concurrent edits to the destination during apply. Safety override flags are documented in `graft transplant --help`.

## Development and release checks

```sh
npm run check          # parse-check every JavaScript file
npm test               # unit, mutation, filesystem, process, CLI, and dashboard integration tests
npm run test:web       # dashboard security and real workflow tests
npm run test:package   # pack, install elsewhere, run the CLI demo and browser server
npm run release:check  # all of the above
npm audit --omit=dev
```

CI is configured for Node 20, 22, and 24 on Linux and macOS. Local test results do not establish that the remote matrix has passed. [RELEASE.md](RELEASE.md) records the exact local release assessment, and [docs/GALUXIUM-BUILD-EVIDENCE.md](docs/GALUXIUM-BUILD-EVIDENCE.md) records the factual Galuxium build-window evidence.
