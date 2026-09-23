# GRAFT Galuxium Nexus V2 Final Submission

Prepared September 22, 2026 from the verified GRAFT 0.6.0 release and public submission surfaces. This is the field-by-field copy package for the Devpost draft. The final Devpost submission remains a separate user action.

## Submission identity

| Field | Final value |
| --- | --- |
| Project name | GRAFT |
| Tagline | Find it. Fit it. Prove it. |
| Short description | GRAFT is an agent-independent software capability reuse and verification layer that remembers proven capability locally, determines whether it fits, specifies adaptation, records custody, and proves the transplant. |
| Hosted judge experience | https://judge-topaz.vercel.app |
| Public source | https://github.com/Ledgercorp/GRAFT-Galuxium |
| Final product demo (GRAFT 0.6, 4:32 live capture) | https://youtu.be/9c-u03Tj62Y |
| Earlier recordings (historical) | https://youtu.be/Oli6UA4X6Lg (earlier 0.6 walkthrough) · https://youtu.be/mIaXLjbHsIA (0.5.0) |
| Product download | https://graft-beta-downloads.fly.storage.tigris.dev/GRAFT-0.6.0-galuxium-arm64.dmg |

## Devpost draft state

- Draft project: **GRAFT**
- Draft route: `https://devpost.com/software/graft-xrwnol`
- Project name limit: 60 characters
- Elevator pitch limit: 200 characters
- Project story: Markdown
- Technology tags: up to 25
- Try-it-out links: multiple public URLs supported
- Gallery: up to 15 JPG, PNG, or GIF images, 5 MB each; 3:2 recommended
- Video: one required YouTube or Vimeo URL
- Additional submission file: required, 35 MB maximum
- Team: one creator; no team membership changes made
- Finalization: requires the user to accept the official rules and Devpost terms before clicking **Submit project**

The title, elevator pitch, project story, technology tags, hosted judge URL, public source URL, product download URL, demo video URL, four reviewed gallery images, project thumbnail, and executive-briefing PDF are saved in the draft. Finalization shows 4/5 steps complete; the rules/terms agreement remains unchecked and **Submit project** remains untouched.

## Official requirement matrix

The authoritative Galuxium Nexus V2 overview and rules were rechecked on September 21, 2026. The six submission requirements and judging weights below still match the published pages.

| Requirement | Submission Evidence | URL / Location | Status | Final Field / Copy | Notes |
| --- | --- | --- | --- | --- | --- |
| Production-Ready Deployment | Public, stable Vercel judge experience backed by sanitized evidence from a real workflow | https://judge-topaz.vercel.app | READY | **Try it out / live demo** | Read-only replay; it does not execute arbitrary repositories. |
| Verifiable Infrastructure | Complete security-reviewed submission source, professional README, architecture, dependencies, supported shapes, and reproduction steps | https://github.com/Ledgercorp/GRAFT-Galuxium | READY | **Code repository** | Deliberately sanitized publication mirror; provenance is explained below. |
| Operational MVP | Packaged desktop workflow and public replay show discovery, source verification, adaptation, application, destination verification, and evidence | Hosted judge experience, download, and demo video | READY | **What it does / video** | Claims are limited to supported capability profiles and fixture workflows. |
| Executive Briefing — Market Friction | Rebuilding already-working behavior wastes engineering time and loses assumptions and proof | Project story, “Inspiration” and “Executive briefing” | READY | **Inspiration / Problem** | No customer or market-size claims. |
| Executive Briefing — Architecture | Local-first discovery, verification, planning, adaptation, and revision-bound evidence | README and architecture summary below | READY | **How we built it** | Hosted surface uses sample data only. |
| Executive Briefing — Target Cohort | Developers, small teams, AI-assisted teams, and agencies that repeatedly build similar functionality | Executive briefing below | READY | **Who it is for** | Enterprise platform teams are a later cohort, not current customers. |
| Fiscal Architecture | Implemented $49 one-time desktop licence plus clearly labeled planned Team and Enterprise recurring plans | Monetization section below; `packages/licensing/README.md` | READY | **Monetization / Fiscal architecture** | Recurring subscriptions and enterprise features are not claimed as implemented. |
| Technical Keynote | 4:32 captioned 1080p live capture of the packaged GRAFT 0.6 app being operated | https://youtu.be/9c-u03Tj62Y | READY | **Demo video** | H.264, 30 fps, no audio track; sped-up segments are labelled on screen. |
| Technical Architecture & Scalability — 20% | Separated CLI/core, local workspace, desktop shell, deterministic plans, controlled processes, evidence store, and static public judge surface | README, SECURITY.md, project story | READY | **How we built it / Architecture** | No unsupported traffic or benchmark claims. |
| Enterprise Governance & Compliance — 20% | Local-first trust boundary, validated paths and plans, controlled execution, cleanup, recovery, redaction, revision-bound evidence, and stated limitations | SECURITY.md and governance response below | READY | **Security / Governance** | Not an OS sandbox or a security certification. |
| Product Innovation & Market Fit — 20% | Verified capability transfer addresses repeated manual reimplementation and risky copy/paste reuse | Project story and demo | READY | **Inspiration / What it does** | No unsupported capability breadth. |
| Monetization & Fiscal Design — 15% | Current one-time product economics and planned recurring Team/Enterprise architecture | Fiscal architecture below | READY | **Monetization** | Current and planned models are visibly separated. |
| UI/UX & Visual Refinement — 15% | Packaged desktop UI, hosted explorer, four real product images, and safe no-install judge path | Hosted judge experience and media list | READY | **Gallery / Try it out** | Images are real packaged-build captures. |
| Keynote Pitch & Demo Completeness — 10% | The 4:32 live demo follows Find → Fit → Prove in the real app: harvest, Laboratory composition to COMPOSITION VERIFIED, deterministic refusal, transplant verification, and CURRENT → STALE evidence | https://youtu.be/9c-u03Tj62Y | READY | **Video** | Captioned; no narration or audio. |
| Rule 3 build-window eligibility | Event start July 15, earliest reachable commit September 7, GitHub repository created September 9, and zero pre-window commits found | `docs/GALUXIUM-BUILD-EVIDENCE.md` | READY | **Build provenance note** | Git dates evidence activity; they do not prove when the idea was conceived. Project records indicate no prior hackathon submission. |
| Final Devpost submission | Finished draft requires final review and submission by the user | Devpost draft | USER ACTION REQUIRED | **Submit project** | Do not click until the user approves the saved draft. |

## Devpost field copy

### Project name

GRAFT

### Tagline

Find it. Fit it. Prove it.

### Short description

GRAFT harvests verified capabilities from working software, adapts them to new projects, and proves the transplanted behavior still works.

### Project story

#### Inspiration

Developers often know they solved a problem before: authentication, uploads, webhook validation, background jobs, or another piece of working behavior. Reusing it still means digging through an old repository, working out which pieces matter, copying code into a different architecture, reconstructing hidden assumptions, and hoping nothing subtle broke.

Source files alone are not the capability. The useful unit includes behavior, dependencies, architectural constraints, verification, and provenance. GRAFT exists to make that reuse explicit and testable.

#### What it does

**Find it. Fit it. Prove it.**

GRAFT discovers a supported capability in working software and verifies its required behavior in the source. It records a revision-bound capability in local Capability Memory, fingerprints the destination, and produces a deterministic Compatibility Preview: **COMPATIBLE**, **ADAPTABLE**, or **INCOMPATIBLE**. A Blueprint carries the adaptation constraints and verification requirements to any compatible execution actor. Data Boundary decisions record source-egress custody before an external provider can run. GRAFT then applies through a controlled write path and awards **VERIFIED** only when required typed evidence passes at the recorded destination revision.

The submitted workflow demonstrates supported authentication and feature-flag capability profiles with included fixture projects. Unsupported or ambiguous shapes are refused before writes. GRAFT is not a general claim that arbitrary code can move between any two repositories.

#### How we built it

GRAFT is a local-first JavaScript and Node.js product with a CLI, a loopback browser workspace, and an Electron desktop shell. The engine fingerprints repositories, discovers supported capability signals, runs source contracts, stores capability manifests and provenance, models destination architecture, and produces deterministic plans. Target-specific emitters generate new implementations of the verified contract instead of copying source files blindly.

Writes are preflighted and applied through an exclusive, recovery-aware path. Verification runs the destination behavior over local HTTP, records required and optional evidence separately, and binds proof to source and destination revisions. The local workspace and desktop package present the same engine through a reviewable interface.

Repository-sensitive work stays on the developer's machine. The hosted Galuxium experience on Vercel is a static, read-only replay built from sanitized evidence produced by a real fixture run. It does not accept repository uploads or execute arbitrary code. The competition organizer confirmed that this local-first product plus public hosted judge surface is an acceptable deployment model.

The public GitHub repository is a security-reviewed publication mirror of the submitted source. Private operational and beta history was excluded from publication; build provenance and milestone chronology are documented in the included Galuxium build-evidence record.

#### Challenges we ran into

- Separating static discovery signals from behavior actually observed during execution.
- Proving a source capability before treating it as reusable.
- Adapting a behavioral contract to a different supported architecture without presenting copied code as a valid transplant.
- Making **VERIFIED** mean that every required acceptance check passed at the recorded revision.
- Preventing unsafe filesystem writes and preserving enough recovery information when an operation fails.
- Giving judges a public experience without turning local repository execution into a public remote-code-execution service.
- Packaging bounded judge access without weakening the private-beta and production licensing paths.

#### Accomplishments that we're proud of

- A real source-to-destination workflow that discovers, verifies, adapts, applies, and verifies again.
- Required evidence and provenance bound to recorded source and destination revisions.
- Deterministic Compatibility Preview, correct pre-write refusal for incompatible hosts, and recovery-aware writes.
- Local revision-bound Capability Memory and a machine-enforced Data Boundary with source-egress custody records.
- A public, static judge experience made from sanitized real workflow evidence.
- A security-reviewed public source mirror and a tested downloadable Apple Silicon desktop build.
- The final 4:32 demo is a live capture of the accepted 0.6 build; earlier recordings remain available as historical references.

#### What we learned

Reuse needs behavior and evidence, not just code. Static inference is useful for finding candidates, but it cannot stand in for observed execution. Verification must keep required and optional evidence distinct, and a verdict must identify the exact revision it describes.

We also learned that local-first execution is a practical product decision for source privacy. A public judge surface can explain and expose evidence without accepting private repositories. When generation or AI-assisted tooling participates, the evidence boundary matters more than the prose: the product must identify what was observed, what was inferred, and what actually passed.

#### What's next for GRAFT

Next steps include broader capability contracts, more destination architectures, stronger optional isolation, broader compatibility profiles, and richer policy controls. A team capability registry could add shared manifests, evidence history, and governance. Enterprise work could add SSO, private deployment, retention controls, and organization-wide policy. These are roadmap directions; they are not features claimed in the submitted build.

#### Planned benchmark: raw repository access versus GRAFT (roadmap, not run)

This is a planned, protected evaluation. It has not been run, it is not part of the submitted build, and nothing here claims that GRAFT outperforms raw repository access.

The evaluation compares two arms. Both use the same frontier coding agent, the same target request and the same destination.

- **Arm A: raw repository.** The agent receives the target request, the source repository and the destination repository.
- **Arm B: GRAFT.** The agent receives the same target request and destination, plus GRAFT Capability Memory, the Capability Genome, the Compatibility Atlas, the Blueprint (AGENTS.md handoff), and CUF verification evidence.

Planned measures:
- transplant success
- behavioural equivalence to the source contract
- incorrect reuse decisions
- rejection of incompatible hosts
- false-compatible and false-incompatible decisions
- regressions in the destination
- attempts and steps
- wall-clock time
- model and token usage, and estimated model cost
- strength of the resulting verification
- destination mutation before a correct refusal
- reproducibility across repeated runs

The benchmark cases and expected answers will be held back from publication so they cannot leak into model training or tuning.

**Motivation.** Miao, J., Davis, J. R., Zhang, Y., Pritchard, J. K. & Zou, J. "Reimagining research papers as interactive and reliable AI agents." *Nature*, published 16 September 2026, https://doi.org/10.1038/s41586-026-11044-y. That work presents Paper2Agent, which turns published research papers into interactive AI agents. It reports comparisons against a baseline of Claude Code with direct access to the same code repository.

Paper2Agent is not GRAFT. It addresses a different problem, did not evaluate GRAFT, and its results do not show that GRAFT works. Its published direct-repository baseline motivates this planned experiment: testing whether GRAFT's validated capability abstraction gives a comparable advantage over raw repository access for cross-project software transplantation. GRAFT has not yet run this comparison.

## Executive briefing

### Market friction

Teams repeatedly rebuild behavior that already works in their own software portfolios. Manual reuse requires engineers to rediscover dependencies and assumptions, translate the implementation into a new architecture, and reconstruct proof that the result still behaves correctly. That wastes time and creates risk precisely where “we already built this” should reduce both.

GRAFT treats reuse as a verified capability transfer. It carries a behavioral contract and evidence through discovery, adaptation, application, and destination verification.

### Target cohort

The initial users are individual software developers, small engineering teams, AI-assisted development teams, and agencies or consultancies that repeatedly build similar functionality. A later enterprise cohort includes internal platform teams and organizations with large portfolios of existing software capabilities. GRAFT does not claim current enterprise customers.

### Architecture

Local-first execution is intentional: repositories, project processes, and repository-sensitive evidence stay on the developer's machine. A local Node.js engine serves the CLI, loopback workspace, and Electron shell. It fingerprints source and destination projects, verifies source behavior, records a manifest and provenance, generates a destination-specific plan and implementation, and verifies the final behavior. The hosted Galuxium site exposes only a sanitized, static replay for judges.

## Architecture summary

```text
Developer machine

Repository
  ↓
Fingerprint and Discovery
  ↓
Source Verification
  ↓
Genome
  ↓
Private Capability Memory
  ↓
Compatibility Atlas
  ↓
COMPATIBLE / ADAPTABLE / INCOMPATIBLE
  ↓
Blueprint
  ↓
Data Boundary / Execution Actor
  ↓
Adaptation and Apply
  ↓
Destination Verification
  ↓
Typed Evidence
  ↓
Assembly Ledger / Capability Custody

Public surfaces
  • Vercel: static hosted judge experience
  • GitHub: sanitized source publication mirror
  • Tigris/Fly.io: immutable public desktop artifact
```

The local engine stores Capability Memory, manifests, registry state, typed proofs, custody events, ledgers, and recovery receipts as local files; it does not require an application database. The separate licensing service has its own server-side persistent state. Licensing infrastructure is not part of the repository execution boundary.

## Security and governance

Implemented controls include loopback-only workspace binding, a per-process token, Host/Origin/Fetch Metadata checks, a restrictive content-security policy, renderer isolation, remote-navigation refusal, validated manifests and plans, restricted child environments, per-step timeouts, process-group cleanup, bounded response and output capture, recognized secret-pattern redaction, path-containment checks, traversal and Git-internal path refusal, symlink and hardlink protection, preflighted exclusive writes, rollback for ordinary write failures, visible recovery locks and receipts, an explicit Data Boundary before external provider calls, source-free custody records, and revision-bound typed verification evidence. Public evidence is projected through a strict allowlist and rejects private paths, contact addresses, common credential patterns, recovery data, and internal service domains.

The trust boundary is explicit. Local verification executes trusted project code with the user's operating-system privileges; process controls are not a hardened OS sandbox. Pattern-based redaction cannot recognize every possible secret. A **VERIFIED** verdict means that the stated acceptance contract passed at the recorded revision, not that the entire application passed a production security audit. Provenance is auditable local evidence rather than cryptographic attestation. The Galuxium macOS build has a valid ad-hoc signature and is not Apple-notarized.

The public judge site runs no arbitrary repository code and accepts no repository upload. It serves sanitized evidence from the supported fixture workflow.

## Monetization and fiscal architecture

### Current product economics — implemented

GRAFT's current commercial model is a **$49 USD one-time desktop licence** sold through Stripe Checkout. The implemented catalogue uses a single one-time price and rejects recurring price configuration. Stripe Managed Payments is the recorded merchant-of-record architecture. The submission does not claim that recurring subscriptions, paying customers, or live commercial traction have been proven.

### Planned recurring commercial architecture — roadmap

- **Individual:** retain a one-time local developer licence or entry tier for private, on-device use.
- **Team:** recurring per-seat plan for a shared capability registry, centralized policy, audit and evidence history, and team administration.
- **Enterprise:** recurring contract for SSO, private deployment, governance and retention controls, organization-wide registries, and support.
- **Possible usage component:** metered hosted evidence storage or managed verification compute only if GRAFT later provides isolated remote execution.

The recurring Team and Enterprise features are a fiscal blueprint for future development. They are not implemented in the submitted product.

## Technology tags

Use the smallest accurate set Devpost accepts:

- JavaScript
- Node.js
- Electron
- Express
- Git
- HTML
- CSS
- Vercel
- Fly.io
- Tigris
- Stripe

Do not add AI model-provider tags: the submitted deterministic workflow does not require an AI provider.

## Video field

- URL: https://youtu.be/9c-u03Tj62Y
- Title: **GRAFT 0.6 — Galuxium Nexus V2 Demo**
- Duration: 4:32
- Format: 1920×1080, H.264 High, 30 fps, no audio track
- Content: 92.6% genuine screen recording of the accepted packaged GRAFT 0.6 app being operated with real input; sped-up segments and two replayed evidence stills are labelled on screen
- Visibility: unlisted and viewable by anyone with the URL, without signing in

### Concise pitch text

GRAFT turns software reuse into a verified capability transfer. The demo shows the packaged product find a working capability, verify it in source, adapt it to a supported destination architecture, apply it, and prove the final behavior at a recorded revision.

## Product links and judge instructions

### Zero-install path

Open https://judge-topaz.vercel.app to inspect Find → source verification → Capability Memory → Compatibility Preview → Blueprint → Capability Custody → typed verification → provenance. This is a static replay of sanitized evidence from a real fixture run.

### Downloadable build

- Product: GRAFT 0.6.0 Galuxium judge build
- Platform: macOS Apple Silicon (arm64)
- Download: https://graft-beta-downloads.fly.storage.tigris.dev/GRAFT-0.6.0-galuxium-arm64.dmg
- Size: 167,317,360 bytes
- SHA-256: `bb6e0e05501b595da72096f3a9d57de53c040495fed45117f0bf868876923ee1`
- Accepted source: `8b90365a3de2fa12cdab8c88e3d19522c60c70be`
- Acceptance: `116/116` packaged assertions passed
- Signing: valid ad-hoc signature; not notarized; no Apple Team ID
- Access: bounded automatic local demo access; no activation, live licence key, entitlement, or operator token

Install by opening the DMG and copying **GRAFT Galuxium.app** to Applications. Because the app is not notarized, Control-click the app in Finder, choose **Open**, then confirm **Open**. This uses macOS's normal per-app approval; do not disable Gatekeeper globally. Intel macOS, Windows, and Linux desktop artifacts are not part of this submission. The hosted judge experience is the no-install alternative.

## Public repository history note

The public Galuxium repository is a security-reviewed publication mirror of the submitted source. Private operational and beta history was excluded from publication; build provenance and milestone chronology are documented in the included Galuxium build-evidence record.

The build-evidence record states that the official competition window began July 15, 2026; the earliest reachable GRAFT commit is `6a503bde` from September 7, 2026; GitHub recorded repository creation on September 9, 2026; and a full-history check found zero commits before the build window. These facts establish a development chronology. They do not prove when the product idea was conceived, and the submission does not represent the public mirror's short curated history as the full private development history.

## Media selections

Use four real packaged-build captures, in this order:

1. `01-scene-opening.png` — GRAFT workspace overview and local-first workflow.
2. `04-scene-found.png` — capability discovery with concrete signals and transplantability status.
3. `10-scene-fit.png` — destination plan, compatibility checks, and architecture-specific adaptation steps.
4. `17-scene-prove.png` — final composition verdict, source and destination verification, and revision-bound evidence.

The selected frames are 2360×1576 captures from the packaged Galuxium build. They contain no local username, home-directory path, credentials, private repository URL, private beta URL, customer data, or notification content.

## Executive briefing attachment

- Filename: `GRAFT-Galuxium-Executive-Brief.pdf`
- Pages: 3
- Page size: US Letter
- Byte size: 8,996
- SHA-256: `65d9de3e2851659a638e63028a00c669b3a52cd5dca06b6e4ef52f99899d0e33`
- Content check: passed; no local path, private operational content, credentials, contact address, or customer data
- Upload status: uploaded and saved in the Devpost draft

## Claim audit

The final copy deliberately avoids or corrects these unsupported claims:

- No claim that arbitrary capabilities, repositories, languages, or frameworks are supported.
- No claim that repository-sensitive work executes in the cloud.
- No claim of hardened sandboxing, complete security assurance, compliance certification, or cryptographic attestation.
- No claim that the macOS artifact is Developer ID signed or notarized.
- No claim of paying customers, revenue, market share, traffic, or performance scale.
- No claim that Team, Enterprise, SSO, shared registries, remote compute, or subscriptions are implemented.
- No claim that the public mirror's short history is the full development history or that all development was public.
- No claim that Git timestamps prove when the idea was conceived.
- No claim that the video contains narration or audio.
- No claim that **VERIFIED** means the whole destination application received a general security or correctness certification.

## Final pre-submission checklist

- [x] Project name
- [x] Tagline / short description
- [x] Project story
- [x] Market friction
- [x] Target cohort
- [x] Architecture
- [x] Security / governance
- [x] Current monetization and planned recurring blueprint
- [x] Technology tags
- [x] Live judge URL
- [x] Public GitHub repository
- [x] Product download
- [x] 2–5 minute demo video
- [x] Screenshots / media selected
- [x] Screenshots / media uploaded
- [x] Executive briefing PDF prepared and validated
- [x] Executive briefing PDF uploaded
- [x] Build-window evidence
- [x] Installation notes
- [x] All URLs tested on final review
- [x] Claims audited
- [x] Devpost draft saved
- [ ] Final rules / terms agreement reviewed by user
- [x] Final Submit **not** clicked
