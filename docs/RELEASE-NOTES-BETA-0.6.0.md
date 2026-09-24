# GRAFT 0.6.0 — release notes

GRAFT 0.6.0 keeps the Find it. Fit it. Prove it. workflow and makes the
compatibility and custody decisions explicit before a transplant is applied.

## What changed

- **Compatibility Preview** classifies a destination as `COMPATIBLE`,
  `ADAPTABLE`, or `INCOMPATIBLE` from deterministic host evidence. An
  incompatible plan is refused before adaptation, provider execution, or
  destination writes.
- **Capability Memory** remembers verified capabilities locally using
  revision/content-bound identity. It stores verification and compatibility
  observations without cloud synchronization or implicit network access.
- **Data Boundary and Capability Custody** require source-derived information
  to pass an explicit policy decision before an external provider call. The
  local Assembly Ledger records the provider, operation, data class, decision,
  and artifact reference without storing raw source prompts or credentials.
- **AGENTS.md handoff** exports transplant-specific constraints, adaptation
  requirements, verification commands, evidence expectations, and provenance.
  Existing destination `AGENTS.md` files are never silently overwritten.
- **Typed verification evidence** preserves distinctions such as build, unit,
  integration, behavioral contract, source revision, destination revision, and
  deployment evidence while retaining the existing `VERIFIED` semantics.

GRAFT remains agent-independent: a compatible executor may perform adaptation,
but GRAFT owns the capability memory, compatibility decision, data-boundary
policy, provenance, and verification requirements.

## Candidate checks

```sh
npm run check
npm test
npm run desktop:make
npm run desktop:accept
```

The Galuxium judge build is a bounded local-demo build for macOS Apple Silicon.
It is ad-hoc signed, not notarized, and requires no activation for judge access.
The accepted source is `8b90365a3de2fa12cdab8c88e3d19522c60c70be`. Packaged acceptance passed `116/116` assertions. The immutable public artifact is `GRAFT-0.6.0-galuxium-arm64.dmg` (`167,317,360` bytes; SHA-256 `bb6e0e05501b595da72096f3a9d57de53c040495fed45117f0bf868876923ee1`). The 0.5.0 download remains available as a historical asset. The GRAFT 0.6 demo is published at https://youtu.be/9c-u03Tj62Y.
