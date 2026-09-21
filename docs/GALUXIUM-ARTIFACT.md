# GRAFT 0.5.0 Galuxium judge build

| Field | Value |
| --- | --- |
| Product | GRAFT Galuxium |
| Version | 0.5.0 |
| Platform | macOS Apple Silicon |
| Architecture | arm64 |
| Filename | `GRAFT-0.5.0-galuxium-arm64.dmg` |
| Download | <https://graft-beta-downloads.fly.storage.tigris.dev/GRAFT-0.5.0-galuxium-arm64.dmg> |
| Byte size | `167309005` |
| SHA-256 | `0a2ab2a4b4b23c11f1025fb77f0a39711653f284537d59e21ec9f633902bd27a` |
| Source commit | `8b7343c1390203ecf011bf0b8ff2df8fcff26a20` |
| Signing | Valid ad-hoc signature; no Apple Developer ID Team ID |
| Notarization | Not notarized |
| Acceptance | Packaged acceptance passed; the public re-download matched the accepted bytes and passed DMG, mount, app-presence, and strict signature checks on September 21, 2026 |

## Install and open

1. Download the DMG and verify its SHA-256 if desired: `shasum -a 256 GRAFT-0.5.0-galuxium-arm64.dmg`.
2. Open the DMG and copy **GRAFT Galuxium.app** to Applications.
3. Because the app is not notarized, use macOS's normal per-app approval: Control-click **GRAFT Galuxium.app** in Finder, choose **Open**, then confirm **Open**.

Do not disable Gatekeeper globally. Intel macOS, Windows, and Linux desktop artifacts are not part of this Galuxium build.

## Judge access

This separately named bundle uses GRAFT's deterministic local demo provider and grants bounded local judge/demo access automatically. It needs no external activation, private-beta licence, live entitlement, universal key, or operator token. It does not bypass or modify production and private-beta licensing paths.

The app executes the sample workflow locally with its bundled Node runtime. Repository-sensitive discovery, adaptation, execution, and verification stay on the judge's Mac. Project execution uses the current user's operating-system privileges; GRAFT is not an untrusted-code sandbox. The [hosted judge experience](https://judge-topaz.vercel.app) remains available as a no-install recorded workflow.

The artifact's source commit is retained in the private development repository and its submitted product-code delta is represented in the [public Galuxium repository](https://github.com/Ledgercorp/GRAFT-Galuxium).
