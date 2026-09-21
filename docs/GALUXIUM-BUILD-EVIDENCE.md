# GRAFT Galuxium Build-Window Evidence

This document records reproducible source-control facts for the Galuxium Nexus V2 submission. Timestamps are evidence of repository activity. They do not prove when the product idea was first conceived, and they do not replace the original private repository or the competition organizer's records.

## Competition window

- The official Galuxium rules page recorded the event start as July 15, 2026 (`2026-07-15T00:00:00.000-04:00`) when inspected on September 20, 2026.
- `git rev-list --all --before=2026-07-15T00:00:00-04:00 --count` returned `0` in the private development repository on September 20, 2026.

## Repository facts

- GitHub repository: `Ledgercorp/GRAFT`.
- GitHub API `created_at`, observed September 20, 2026: `2026-09-09T12:18:16Z`.
- Earliest reachable commit: `6a503bdeac7c8116b2451b980ce7a6b80ff779ce`.
- Earliest reachable commit date: `2026-09-07T10:40:36-04:00`.
- Earliest reachable commit subject: `GRAFT baseline: repo scaffold and two fixture projects`.
- Reachable commits at checkpoint `fd85777`: 137.

The local commit date predates the GitHub repository creation date because the repository existed locally before its GitHub remote was created.

## Milestones

| Date | Commit | Recorded milestone |
| --- | --- | --- |
| 2026-09-07 | `6a503bde` | Baseline repository scaffold and two fixture projects |
| 2026-09-10 | `4a46ea5` | 0.5.0 desktop candidate |
| 2026-09-13 | `55ade3f` | Private beta program implementation |
| 2026-09-20 | `eb57745` | Static Galuxium judge experience |
| 2026-09-20 | `fd85777` | Hosted judge deployment and live acceptance |

The live judge experience for the final checkpoint is [https://judge-topaz.vercel.app](https://judge-topaz.vercel.app).

## Independent preservation

Retain the private development repository, GitHub repository metadata, and release/deployment records. A sanitized public mirror can cite the original commit identifiers without claiming that its curated public history is the complete private development history. Commit identifiers remain independently verifiable against the retained private repository.
