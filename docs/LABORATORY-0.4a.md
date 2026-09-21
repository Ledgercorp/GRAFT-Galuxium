# Laboratory 0.4a — Composition Kernel

Branch `feature/laboratory-composition-kernel-0.4a` from `feature/laboratory-multi-capability-0.4`
(`83cd3cf`). This phase proves multi-capability transactional composition and nothing else.

> **ENGINEERING COMPOSITION TEST.** Both capabilities are GRAFT's own test sources. This is **not**
> evidence of open-source composition and makes no customer claim — see
> `docs/LABORATORY-0.4-FEASIBILITY.md` for why no open-source feature-flags capability is admissible
> today. No detector, capability kind, implementation form, host profile or dependency installation
> was added.

## What it proves

1. an assembly already holding verified capability A is the base for capability B;
2. B is applied in an isolated candidate;
3. B is verified;
4. every previously CURRENT capability is re-verified against the candidate combined revision;
5. the assembly revision advances only if every required check passes;
6. if anything fails, the previous A-only revision stays CURRENT and untouched.

## The kernel (`packages/core/src/laboratory/composition.js`)

`composeNextCapability(workspace, { capability, steps })` runs the transaction. Every authoritative
operation is injected (`prepareCandidate`, `applyAndVerify`, `reverifyCapability`,
`commitCandidate`, `disposeCandidate`), so the kernel orchestrates GRAFT's existing operations and
re-implements none of them.

```
CURRENT revision A
  → candidate worktree cut from EXACTLY that revision
  → plan + apply B against the candidate's own Host Model
  → verify B
  → re-verify every capability already CURRENT, on the combined candidate
  → host preservation
  → commit the candidate
  → advance currentRevision and ledger histories      ← the only step that changes CURRENT
```

**Base-revision rule.** The candidate must report the revision it was cut from, and it must equal
the assembly's current verified revision. Anything else raises `candidate-wrong-base`, disposes of
the candidate, and applies nothing. `prepareTransplant` gained an optional `fromRevision` so a
worktree can be cut from the assembly's revision instead of the checkout's HEAD; without it every
composition would silently start from the blank base, which is exactly the mistake this rule exists
to catch.

**Rollback is disposal.** A rejected candidate is removed through the normal cleanup path. Nothing
is reset, forced or destroyed; git verbs added anywhere in this phase are `add`, `commit`,
`rev-parse` and `worktree`.

## Ledger histories

After a successful composition both records bind to the combined revision, and history is kept:

| Record | appliedRevision | currentVerifiedRevision | verificationHistory |
| --- | --- | --- | --- |
| A | revision A | revision AB | `applied-and-verified` @A, `re-verified-with B` @AB |
| B | revision AB | revision AB | `applied-and-verified` @AB |

Revision binding evaluates `currentVerifiedRevision`, so a re-verified capability stays CURRENT at
the combined revision while its original application revision remains visible.

## Composition evidence

`AssemblyCompositionEvidence`: assemblyWorkspaceId, revision, capabilityRecords[],
verificationReferences[] (the authoritative proof contracts), hostPreservation,
interactionsChecked[], finalState. It reaches `ALL_SELECTED_CAPABILITIES_VERIFIED` only when every
record is CURRENT, verified, and bound to the same revision, with all re-verifications passed. Its
wording says so explicitly and adds: *"This is not a claim that the application as a whole is
verified."*

## Host selection (evidence)

The preferred Real-World Transplant 2B host could not be used for both capabilities, and the reason
is structural, not incidental:

```
express-js-example-app   esm/express/express-req-res
  express.supported = false  ("mounted-or-imported-middleware-needs-manual-integration")
  expressGuard.supported = true
  profilesByKind = { hosted-session-auth: express-req-res }
```

Its entrypoint mounts routers, so the guard-style hosted-session-auth fits (CUF authentication
verified there **15/15** during this phase) while feature-flags — which registers routes directly —
is correctly refused with `manifest.unsafe / block`. No other permitted host on this machine
supports both kinds. On the user's decision the kernel was therefore exercised on the only shape
that supports both without dependency installation: `esm-return-response`, a dependency-free
node:http host built once from `fixtures/new-startup` as a real git repository.

## Real run (dogfood `laboratory-composition-kernel-0.4a`, final state `COMPOSED_TEST`)

Host: `composition-host`, `esm/node-http/return-response`, 0 dependencies, no remote, base
`3836e9c0f16f`.

| Step | Result |
| --- | --- |
| A = authentication (session-auth, fixtures/old-saas-project) | **VERIFIED 6/6**, profile `esm-return-response`, 5 files, one conflicting route explicitly approved (`POST /auth/login`) |
| revision A | `70be58b58e87` on `graft/authentication-f06cd7bd` |
| A while planning B | `PRESENT_BY_ASSEMBLY_EVIDENCE`, CURRENT, dependency evidence satisfied, independent detector **not observed** |
| candidate for B | cut from `70be58b58e87` (expected == actual), contains A |
| B = feature-flags (fixtures/config-service) | **VERIFIED 4/4** |
| A re-verified on the candidate | **VERIFIED 6/6** |
| revision AB | `ace7a937ffd2`; both records CURRENT at that one revision |
| composition evidence | `ALL_SELECTED_CAPABILITIES_VERIFIED`, referencing both proof contracts |
| host checkout | unchanged: `main` at `3836e9c0f16f`, 0 dirty, no remote |

## Rollback experiment (dogfood `…-0.4a-mutation`, final state `SAFE_REFUSAL`)

Real mutation, real verifier: capability B applied and **verified 4/4**, but A's module was
deliberately broken inside the candidate. A's own contract caught it — re-verification returned
**NEEDS_REVIEW** (an application that cannot boot is inconclusive, never a pass). The candidate was
disposed of, its worktree removed, and the assembly stayed at revision A `318a02b63d33` with A still
CURRENT and revision A intact. This single experiment covers both "A fails after B" and
"INCONCLUSIVE → no promotion".

## Tests

`packages/core/test/composition.test.js` (4), all using real git worktrees and commits:

- composition onto revision A: candidate base, A present before B, single advance, ledger
  histories, both CURRENT at one revision, evidence references proofs, checkout untouched, earlier
  revision still reachable;
- a candidate cut from the wrong revision is refused and disposed of before anything is applied;
- five authoritative failures each reject and leave A CURRENT — B FAILED, B INCONCLUSIVE, A
  re-verification FAILED, A re-verification INCONCLUSIVE, host preservation failed — with the
  candidate worktree and branch gone and the checkout unmoved;
- composition refuses to start on a stale or dirty assembly, and the agent cannot advance it.
