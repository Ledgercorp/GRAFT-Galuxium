# Changelog

## 0.5.0 — desktop distribution candidate and capability knowledge

- Package the existing browser workspace and engine as an Apple Silicon macOS application built with Electron Forge, producing a DMG and a ZIP. The engine and CLI remain usable on their own.
- Bundle a pinned, checksum-verified standalone Node runtime inside application resources and route all project execution through it, so a customer needs no Node installation. Verification never falls back to PATH or to Electron's own executable, and RunAsNode is disabled.
- Add a sandboxed, context-isolated renderer with an explicit preload bridge, sender-validated IPC, refused remote navigation/popups/webviews/permissions, a native application menu with About/License/Quit, a native folder picker, and a Quit that waits for the active operation and its verifier children.
- Add a fail-closed licence gate in the main process that also guards the local HTTP API. Activation records are encrypted with macOS `safeStorage` in owner-only files, with a bounded offline grace window that a network outage can never create or extend.
- Add `capability-contract.json` 1.0.0 to newly written organ packages, a canonical capability ID over behavioral requirements, project fingerprints, local lineage, and owner-only compatibility observations under a destination's `.graft/compatibility/`. Existing manifests stay format 0.2.0 and are read without migration; a recording failure is reported, never treated as success.
- Add GRAFTBench (`npm run bench`): 18 scenarios across three donor and two recipient architectures, including refusal and mutation-detection cases, with a machine-readable report.
- Add `npm run desktop:accept`: packaged-artifact acceptance against the real bundle, covering launch, the renderer boundary, the licence gate, the complete harvest → plan → apply → verify workflow, a native Quit issued during live verification, and reopen with and without the licence service.
- Ignore `.graft` when fingerprinting a project, so receipts and compatibility history are never mistaken for project source.

The desktop candidate carries only a local ad-hoc development signature. It is not notarized, no licence product is configured, and it is not suitable for public paid distribution.

## 0.4.0 — browser workspace

- Add a local browser dashboard with projects, organ bank, complete transplant previews, HTTP results, and saved receipt inspection.
- Add `graft ui` and `npm start`, including portable package assets, configurable local port, and graceful shutdown.
- Add sample project setup, explicit trusted-code confirmations, serialized operations, expiring single-use previews, and changed-project/manifest checks before apply.
- Restrict the browser API to loopback, validated Host/Origin/Fetch Metadata, a per-process token, capped JSON bodies, and allowlisted static assets. Keep CLI safety overrides out of the browser API.
- Save initial transplant test reports in owner-only recovery receipts and retain truthful partial-write outcomes if a later step fails.

## 0.3.0 — release candidate

- Make organ-bank replacements recoverable: stage/validate complete packages, serialize writers, reject mixed reader snapshots, preserve previous data on write/process failure, surface pending recovery, and remove obsolete source evidence.

- Add an ESM Express destination profile, regenerated authentication middleware, and real Express acceptance/mutation coverage.
- Parse complete JavaScript route registrations before editing; preserve multiline handlers, comments, middleware, and trailing 404 behavior.
- Refuse output symlinks, hard links, traversal, Git paths, receipt collisions, and repositories lacking a recovery commit. Recover generated writes on failure and retain the original entrypoint in the receipt.
- Validate imported manifests, source evidence correspondence, HTTP assertions, unique test IDs, and capability slugs.
- Apply shared runtime containment and evidence redaction to destination verification; cap response sizes and terminate surviving process-group descendants.
- Preserve corrupted registry data; serialize mutations and replace registry files atomically.
- Preserve Secure cookie flags and reject invalid session lifetime overrides.
- Add strict CLI options, command help/version, reliable exit codes, isolated demo projects, portable package smoke tests, and a Linux/macOS CI matrix.

Manifest format remains 0.2.0. Older valid manifests remain supported; malformed provenance or assertion-free tests previously accepted by mistake are now refused. This release is prepared locally; no public package or deployment has been published.
