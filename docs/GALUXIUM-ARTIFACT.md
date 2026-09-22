# GRAFT 0.6.0 Galuxium judge build

| Field | Value |
| --- | --- |
| Product | GRAFT Galuxium |
| Version | 0.6.0 |
| Platform | macOS Apple Silicon |
| Architecture | arm64 |
| Filename | `GRAFT-0.6.0-galuxium-arm64.dmg` |
| Download | <https://graft-beta-downloads.fly.storage.tigris.dev/GRAFT-0.6.0-galuxium-arm64.dmg> |
| Byte size | `167317360` |
| SHA-256 | `bb6e0e05501b595da72096f3a9d57de53c040495fed45117f0bf868876923ee1` |
| Source commit | `8b90365a3de2fa12cdab8c88e3d19522c60c70be` |
| Signing | Valid ad-hoc signature; no Apple Developer ID Team ID |
| Notarization | Not notarized |
| Acceptance | `116/116` packaged assertions passed; content/security scan, DMG verification, mount, app presence, and deep strict codesign passed |

## Install and open

1. Download the DMG and verify it: `shasum -a 256 GRAFT-0.6.0-galuxium-arm64.dmg`.
2. Open the DMG and copy **GRAFT Galuxium.app** to Applications.
3. Because the app is not notarized, use macOS's normal per-app approval: Control-click **GRAFT Galuxium.app** in Finder, choose **Open**, then confirm **Open**.

Do not disable Gatekeeper globally. Intel macOS, Windows, and Linux desktop artifacts are not part of this Galuxium build.

## Judge access and 0.6 workflow

This separately named build grants bounded local demo access without an external activation service, live licence key, entitlement, or operator token. Production and private-beta licensing behavior is unchanged.

The accepted package exercises Find, source verification, local revision-bound Capability Memory, Compatibility Preview, Blueprint and `AGENTS.md` export, Data Boundary custody, adaptation and apply, destination verification, typed evidence, Assembly Ledger provenance, incompatible refusal, and relaunch persistence. An incompatible plan blocks Apply, returns HTTP 409, and leaves the destination unchanged.

The app executes the sample workflow locally with its bundled Node runtime. Repository-sensitive discovery, adaptation, execution, and verification stay on the judge's Mac. Project execution uses the current user's operating-system privileges; GRAFT is not an untrusted-code sandbox. The [hosted judge experience](https://judge-topaz.vercel.app) remains available as a no-install static evidence replay.

The accepted artifact is bound to private source commit `8b90365a3de2fa12cdab8c88e3d19522c60c70be`. Its public-safe source delta is represented in the [public Galuxium repository](https://github.com/Ledgercorp/GRAFT-Galuxium).

## Historical rollback artifact

The immutable 0.5.0 artifact remains available at <https://graft-beta-downloads.fly.storage.tigris.dev/GRAFT-0.5.0-galuxium-arm64.dmg>. It is retained as release history and is not overwritten by 0.6.0.
