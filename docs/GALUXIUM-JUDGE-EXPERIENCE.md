# GRAFT hosted judge experience

The organizer's hosting approval is quoted in `GALUXIUM-AUDIT.md`. It permits a public sample-data experience while repository-sensitive execution remains local. It does not waive the public repository, video, or build-window requirements.

## Architecture and ownership

`packages/web/judge/` is a standalone static build output owned by the existing `@graft/web` package. It reuses the product's canonical mark and restrained green/cream design. It deliberately does not import or mount `packages/web/src/server.js`, the local execution workspace. No new dependencies, backend, analytics, uploads, remote executor, or licensing mutations are introduced.

Public routes: `/` (interactive explorer), `/docs.html` (technical/local-first explanation), and `/evidence.json` (download). Relative asset URLs also support mounting the directory beneath an existing site's trailing-slash path such as `/graft/judge/` without a client router. The Find, Fit, Prove, and Provenance buttons expose one recorded workflow; the controls never claim new execution.

## Evidence and regeneration

Run from the GRAFT repository with Node 20+ and Git:

```sh
node scripts/demo/judge-evidence.mjs
node --test packages/web/test/judge.test.js
node scripts/demo/judge-preview.mjs
```

Open `http://127.0.0.1:4173`. The producer calls the existing real CLI demo on disposable copies of `fixtures/old-saas-project` and `fixtures/new-startup`. GRAFT discovers and harvests authentication, verifies the source, plans the CJS/node-res → ESM/return-response adaptation, approves the sample route conflict, applies generated files, and verifies the destination. The producer then commits only the generated application files and entrypoint in the **temporary fixture repository**, and runs destination verification again to obtain a clean revision-bound proof envelope. Private `.graft` recovery state is locally excluded, never staged or published.

The public projection contains actual discovery signals, captured behavior, source/destination reports with request/status/assertion outcomes, compatibility findings, actual Git patch, generated-file hashes, fixture commit IDs, GRAFT HEAD, and original envelope digest identifiers. Six required cases pass; the optional session-after-restart case fails in both fixtures and is visible. This fixture is reproducible without external CUF/SwivelJS checkouts, accounts, provider services, or credentials. It demonstrates the architecture adaptation more directly than the existing composition recording.

Regeneration changes timestamps and disposable fixture commit IDs. The GRAFT revision identifies engine source; fixture revisions belong to the disposable repositories. The exact sanitized JSON is committed. The original local proof envelopes are not publicly downloadable: their identifiers are traceability references, not a claim that this reduced projection independently proves or attests the run. The JSON wrapper SHA-256 detects accidental corruption and is checked before displaying any result; it is not a signature.

## Sanitization and failure handling

The producer projects explicit fields, never spreads raw reports, manifests, environment values, response bodies, cookies, receipts, or execution diagnostics into the output. The shared schema rejects unknown properties, private filesystem paths, common credentials/token patterns, contact addresses, recovery keys, and internal service domains. Only application files are included in the diff. Browser rendering uses text nodes. The preview server serves seven explicit assets and refuses other paths/methods. The static page uses a restrictive CSP and makes only a same-origin evidence request.

Review the full public directory before publication; pattern checks cannot detect every possible secret. No raw demo videos or screenshots are bundled. `evidence.json` is the only data asset; never deploy the repository root, demo workspaces, or `.graft` state. Missing, malformed, inconsistent, or checksum-mismatched data hides the explorer and shows an accessible error, never VERIFIED.

## Verification

```sh
node --test packages/web/test/judge.test.js
node_modules/.bin/electron scripts/demo/judge-acceptance.cjs --headed
node_modules/.bin/electron scripts/demo/judge-acceptance.cjs --headed --url https://judge-topaz.vercel.app
npm run test:web
npm run check
git diff --check
```

The browser test reuses installed Electron/Chromium and requires a graphical environment. It covers landing → discovery/source verification → destination/plan/diff → final verification/provenance, native keyboard activation and disclosure controls, 390px mobile overflow, docs, and missing/corrupt evidence. Set `GRAFT_JUDGE_SCREENSHOTS` to an output directory outside the public bundle for visual review. Unit/integration checks cover data consistency, optional failures, sensitive-field rejection, assets/links, and static-only routes.

Validated on 2026-09-20 before deployment: 6 focused judge tests passed; all 30 web-package tests passed (0 failures, 0 skips); Chromium acceptance passed 23 assertions; syntax check passed for 236 JavaScript files, with a fresh targeted syntax check after the final acceptance-script edit. Desktop and mobile screenshots were visually reviewed. The full product release suite was not run. Evidence capture passed the strict public schema and checksum checks. Production validation is recorded below.

## Production deployment

The judge experience is hosted by Vercel on the free Hobby plan:

- Project: `judge` (`prj_dPAGAxxNJ5QzCyU0ZBvdux5FfWYy`)
- Production URL: <https://judge-topaz.vercel.app>
- Initial production deployment: `dpl_9NFXPuMRXNEWCtcffbsd8ofnbUGQ`
- Published boundary: only `packages/web/judge/`; the upload contained the seven reviewed judge assets plus `vercel.json`. `.vercel`, `.gitignore`, and environment files were excluded.

`vercel.json` applies the same restrictive CSP as local preview, including `frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a camera/microphone/geolocation Permissions Policy. Project directory listing is disabled. The account default initially applied Vercel Authentication to non-custom domains; Workstream 1B disabled it for this project only so judges can access the public URL anonymously. No build, secret, environment variable, server function, analytics, upload, or remote executor is present.

Live acceptance on 2026-09-20 verified seven public assets and their MIME types, production headers, checksum/schema-valid public evidence, 20 Chromium assertions across the complete Find/Fit/Prove/Provenance flow, keyboard operation, 390px mobile layout, and documentation navigation. Ten representative private/internal or source-map paths returned 404, including `.git`, `.env`, `HANDOFF.md`, `scripts`, `packages`, licensing, and a traversal-shaped request. Public HTML/JS referenced no source maps or local paths. The optional restart case remains visibly failed, while the six required source and destination cases remain VERIFIED; the UI identifies the experience as a recorded hosted replay.

To redeploy the existing project after a reviewed change:

```sh
npx vercel@latest link --yes --cwd packages/web/judge --team colby-weiss-projects --project judge
npx vercel@latest deploy --dry --json --cwd packages/web/judge
npx vercel@latest deploy --prod --yes --cwd packages/web/judge
node_modules/.bin/electron scripts/demo/judge-acceptance.cjs --headed --url https://judge-topaz.vercel.app
```

Review the dry-run file list before every deployment. Roll back through the Vercel project to the previous verified production deployment; the initial deployment has no earlier GRAFT version to restore.

Try Interactive Demo, Technical Documentation, Security / Local-First Design, Download GRAFT, and View source on GitHub work publicly. The downloadable judge artifact and public source repository are complete; the compliant 2–5 minute video remains pending. Targeted link acceptance found no broken action link.
