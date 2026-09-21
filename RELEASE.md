# GRAFT 0.5.0 desktop distribution candidate

Source branch: `codex/desktop-distribution-0.5.0`, based on the 0.4.0 browser workspace commit `791b50f`. This assessment accompanies the 0.5.0 candidate commit. The published 0.3.0 and 0.4.0 releases are unchanged.

## Included

An Apple Silicon macOS application that packages the existing browser workspace and engine, built with Electron Forge into `out/desktop/make/GRAFT-0.5.0-arm64.dmg` and a matching ZIP. A pinned, checksum-verified standalone Node 24.21.0 runtime ships inside application resources and runs every verified project, so the customer installs no Node toolchain. The CLI and engine remain usable independently and their behavior is unchanged outside the desktop process.

A new server-side workspace `packages/licensing` provides GRAFT's commerce and licensing: one product at $49 USD one-time through Stripe Checkout with **Stripe as Merchant of Record via Stripe Managed Payments** (Stripe handles tax). Payment success is established server-side; the desktop holds no Stripe secret and cannot forge a purchase; refunds revoke and the client fails closed. It is built and tested offline against a fake Stripe and is not yet connected to a live Stripe account. See `packages/licensing/README.md`.

Alongside the desktop work, newly written organ packages gain `capability-contract.json` 1.0.0, a canonical capability ID, local lineage and owner-only compatibility observations. Manifest format stays 0.2.0 and existing packages are read without migration or rewrite. See [docs/DESKTOP-0.5.md](docs/DESKTOP-0.5.md) and [docs/DEFENSIBILITY.md](docs/DEFENSIBILITY.md).

## Validation

Local checks on 2026-09-10, macOS 26.6.2 (Apple Silicon), Node 22.14.0, npm 10.9.2:

| Gate | Evidence |
| --- | --- |
| JavaScript syntax | 77 files checked |
| Engine, CLI, browser and desktop coverage | 175 tests passed, 0 failed |
| Installed package | `graft-0.5.0.tgz` installed outside the checkout; CLI help/version, source → transplant → HTTP verification and packaged browser workspace passed |
| GRAFTBench | 18 scenarios: 6 verified transplants, 3 correct refusals, 9 mutations detected, 0 false successes, 0 failures |
| Packaged artifact acceptance | `npm run desktop:accept`: 34 checks passed against the real packaged bundle |
| Production artifact | DMG and ZIP each carry GRAFT.app 0.5.0; `codesign --verify --deep --strict` valid and satisfying its designated requirement; ASAR closure is the engine plus `acorn` only, with no test code and no licensing fixture |
| Production launch | The final bundle launches, opens the licence page, fails closed with no product configured, exposes no Node primitives in the renderer, quits through the native Quit and leaves existing local GRAFT state untouched |
| Runtime dependency audit | `npm audit --omit=dev`: 0 vulnerabilities |

Packaged acceptance runs the real bundle against disposable instrumented repositories. It covers launch and version, the bundled-runtime path, the sandboxed context-isolated renderer with no Node primitives, refused remote navigation, the native About/License/Quit menu, an HTTP 402 before activation, activation through the real renderer/preload/IPC path, the painted workspace UI, project registration, verified harvest (VERIFIED 6/6), preview, transplant onto a new recovery branch, destination verification (VERIFIED 6/6), execution on the bundled Node with no surviving children, a native Quit issued while a verification is running, and reopen with and without the licence service.

This is **INTEGRATION VERIFIED** on the packaged Apple Silicon artifact, including the packaged workspace UI. It is not a production authentication assessment, and it is not a signed, notarized or commercially validated distribution.

## Local access and recovery

The workspace server still binds only to `127.0.0.1`, requires a per-process token, validates Host/Origin/Fetch Metadata and serves allowlisted assets under a restrictive CSP. In the desktop it additionally refuses every API call while the licence gate is closed. Project code still executes with the user's OS privileges; neither the dashboard nor the desktop is a sandbox.

Quit waits for the active operation and its verifier process group before exiting. A native Quit during live verification was measured to exit cleanly in well under a second while still letting the running verifier finish: no destination file was rewritten or truncated, the only new file was a complete owner-only compatibility record from the finished run, and the registry was intact. Abrupt OS termination or power loss still requires inspecting the recovery receipt. Switching branches is not rollback.

Recovery baseline for this candidate is `791b50f`. Receipts keep the original entrypoint bytes, written-file list, branch and previous HEAD under owner-only permissions.

## Distribution boundary

Do not publish this candidate publicly. It carries only a local ad-hoc development signature, has no Developer ID identity or notarization, and no configured licence product. Before any paid distribution: supply real product IDs and purchase/download URLs, validate real activation and deactivation, provide Developer ID signing and notarization credentials, validate the signature and the nested bundled Node entitlements, test on a clean Mac including the Apple Command Line Tools prerequisite, and rerun `npm run desktop:accept` plus the production launch check on that final signed artifact.

Build-only tooling still reports 20 high-severity advisories in the Electron Forge extraction and image dependency chain (`extract-zip`, `image-size`); patched `tar` and `tmp` versions are pinned through overrides. Those packages are absent from the shipped application closure, but review that build-host exposure before signing a public release. Windows and Intel builds are not supported commercial targets.
