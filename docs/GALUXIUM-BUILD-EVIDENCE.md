# GRAFT Galuxium Build-Window Evidence

This document records reproducible source-control facts for the Galuxium Nexus V2 submission. Timestamps are evidence of repository activity. They do not prove when the product idea was first conceived, and they do not replace the original private repository or the competition organizer's records.

## Competition window

- The official Galuxium rules page recorded the event start as July 15, 2026 (`2026-07-15T00:00:00.000-04:00`) when inspected on September 20, 2026.
- `git rev-list --all --before=2026-07-15T00:00:00-04:00 --count` returned `0` in the private development repository on September 20, 2026.

## Repository facts

- Private development repository: `Ledgercorp/GRAFT` (not public; it also holds private-beta, deployment and protected-benchmark material).
- GitHub API `created_at`, observed September 20, 2026: `2026-09-09T12:18:16Z`.
- Earliest reachable commit: `6a503bdeac7c8116b2451b980ce7a6b80ff779ce`.
- Earliest reachable commit date: `2026-09-07T10:40:36-04:00`.
- Earliest reachable commit subject: `GRAFT baseline: repo scaffold and two fixture projects`.
- Commits reachable from checkpoint `fd85777`: 128 (137 across all private branches at that time). As of September 23, 2026: 150 across all branches, 140 reachable from the accepted 0.6 source `8b90365`, and 0 dated before July 15, 2026.

The local commit date predates the GitHub repository creation date because the repository existed locally before its GitHub remote was created.

## Milestones

| Date | Commit | Recorded milestone |
| --- | --- | --- |
| 2026-09-07 | `6a503bde` | Baseline repository scaffold and two fixture projects |
| 2026-09-10 | `4a46ea5` | 0.5.0 desktop candidate |
| 2026-09-13 | `55ade3f` | Private beta program implementation |
| 2026-09-20 | `eb57745` | Static Galuxium judge experience |
| 2026-09-20 | `fd85777` | Hosted judge deployment and live acceptance |
| 2026-09-22 | `bad22a9` | GRAFT 0.6.0 release candidate |
| 2026-09-22 | `8b90365` | Accepted GRAFT 0.6 source (the judge DMG build) |

The live judge experience for the final checkpoint is [https://judge-topaz.vercel.app](https://judge-topaz.vercel.app).

## This public repository

`Ledgercorp/GRAFT-Galuxium` (created September 21, 2026) is a security-reviewed submission mirror of the private development tree, not a copy of its history. Its commits are publication snapshots, so private commit identifiers cited here do not resolve in it.

- Public `7bb2c69` contains the same 317 files, byte for byte, as private `95c0168` (September 20, 2026).
- Public `3816bae` is the sanitized accepted 0.6 source, private `8b90365`. No product source file differs; the 7 differing paths are `.gitattributes`, `README.md`, three documents, `scripts/publication-check.mjs` and `packages/core/test/graft-0.6.test.js` (the protected-benchmark exclusion).
- Later public commits (the judge-site refresh, the Stripe Payment Link redirect and documentation) were made for publication after the accepted build.
- `GRAFT Submission`, `GRAFT Release` and `Colby Weiss` are the same single developer. `Co-Authored-By` trailers record AI coding-assistant use.

The private repository and its metadata are retained unchanged. Its history is not publicly accessible, so the private facts above are the developer's own record rather than something a reader can check directly.

## Vendored verification component

`packages/cuf-kernel` is compiled JavaScript from CUF, a separate proprietary verification project by the same developer. It is not a third-party or open-source dependency. The earliest recovered CUF implementation dates from September 2, 2026 (repository created September 3; no CUF commits before July 15, 2026). GRAFT vendored its compiled output on September 13, 2026, at CUF commit `b18f700`; `packages/cuf-kernel/PROVENANCE.json` records the source commit and file digests. CUF's TypeScript source is not part of this repository.
