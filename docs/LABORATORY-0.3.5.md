# Laboratory 0.3.5 — Assembly Continuity

A bounded infrastructure phase between first assembly execution and multi-capability assembly.
Branch `feature/laboratory-assembly-continuity-0.3.5` from
`feature/laboratory-assembly-execution-0.3` (`e080e55`). No second capability was added.

0.3 left two continuity problems:

1. the created checkout still held the blank host on `main`, while the verified application lived
   only in a GRAFT-managed worktree;
2. the final re-index did not independently detect the transplanted capability, so the Laboratory
   could not safely treat the assembled result as input for anything else.

This phase fixes both — without forcing heuristic detection to become authoritative.

## The uncommitted-state discovery

The transplant writes files but does not commit: after 0.3 the managed branch still pointed at the
blank-host commit, with the capability present only as working-tree changes. Promotion by
fast-forward was therefore impossible. `commitAssembledState` now commits the verified state on the
managed branch at the end of a successful execution, which gives the assembly an exact revision and
makes promotion a true fast-forward.

## Assembly Workspace (`packages/core/src/laboratory/continuity.js`, schema 1.0.0)

`LaboratoryAssemblyWorkspace`: `assemblyWorkspaceId` (`asm-<blueprintId>-<6 hex>`), `blueprintId`,
`blueprintName`, `planId`, `executionIds[]`, `createdProjectId`, `repositoryIdentity`,
`baseRevision`, `currentRevision`, `workingBranch`, `primaryBranch`, `locations {worktree,
primary}`, `hostId`, `capabilities[]`, `status` (ACTIVE | FINALIZED | STALE | CLEANED),
`finalization`, timestamps. Identity is portable; the two filesystem locations are the local facts
the product needs to open the application, and are the only paths permitted in the record.

This is the single evolving workspace a future 0.4 will apply a second capability to — it is not
recreated per capability. This phase creates the abstraction and proves it retains the already
verified result.

## Assembly Ledger

`AssemblyCapabilityRecord`: capabilityId, capability, kind, genomeId, irId, artifactId,
sourceRevision, sourceVerification, destinationRevisionBefore/After, verificationContractId,
verificationVerdict, verificationSummary, invariantSummary, counterfactualSummary,
hostPreservation, transplantId, filesWritten, proofReference, executionId, appliedAt, `state`
(CURRENT | STALE | INVALIDATED).

**The ledger is not a proof.** It references the authoritative proof, contract, receipt and
transplant record, and copies only verdicts and summaries. A capability enters it only when GRAFT
itself applied it, the execution COMPLETED, the verifier returned VERIFIED and host preservation
held — a FAILED or INCONCLUSIVE outcome is refused outright, and the ledger stays empty.

## Two evidence sources, kept apart

| Source | Meaning |
| --- | --- |
| `PRESENT_BY_ASSEMBLY_EVIDENCE` | GRAFT applied it, the verifier passed it, at a known revision |
| `OBSERVED_BY_DETECTOR` | Capability Memory's heuristics recognise it in the code |
| `CLAIMED_BY_AGENT` | never evidence |

A detector that cannot see an implementation does not erase assembly evidence; a detector that can
see one does not replace proof. The product states both plainly: *"Added and verified by GRAFT. The
workspace detector does not independently recognize this implementation."* No detector observation
is ever fabricated — `capabilityPresence` is given whatever `discoverCapabilities` actually returned.

## Revision binding and staleness

Deterministic, with no source analysis: a record is CURRENT exactly while the assembly stands at
the revision the capability was verified at; any other revision — an edit and commit made outside
the Laboratory, a missing working tree — makes it STALE with the reason stated. A finalized
assembly is evaluated against the person's own checkout, so cleaning up the managed worktree does
not invalidate the ledger.

## Future dependency evidence (prepared, not exercised)

`dependencyEvidence(workspace, {capability})` is satisfied only by a CURRENT record and reports the
verdict, revision and proof reference it relies on. A STALE record satisfies nothing, and an agent's
claim is never a source. Nothing broader was implemented.

## Finalization and promotion

*Finalize assembled project* is explicit and confirmed. `checkPromotion` refuses if: the assembly
is already finalized or cleaned, the worktree or project is missing, the execution was not
COMPLETED, verification was not VERIFIED, any ledger record is not CURRENT, the checkout is dirty,
the checkout moved off `baseRevision`, it is on an unexpected branch, the worktree is dirty or not
at the verified revision, or the checkout's commit is not an ancestor of the assembled revision.

`promoteAssembly` then performs exactly one operation: `git merge --ff-only <working branch>` in the
person's checkout. Git verbs used anywhere in this module: `add`, `commit`, `merge --ff-only`,
`merge-base --is-ancestor`, `remote`, `rev-parse`. There is no `reset`, `checkout`, `clean`,
`rebase`, `push`, `fetch`, and no `--force`. The blank-host commit stays in history as the parent of
the assembly commit, and no remote is configured or contacted.

After finalization the managed worktree may be cleaned up through the existing cleanup path; the
workspace, ledger and proof references survive it.

## Product

The Assembly Plan tab shows, for a completed assembly: **Assembled application** with each
capability's verdict, its presence label, the evidence line (required/passed, revision, contract
id), the independent detector status, the plain-language explanation, the current revision, where
the application lives, *Open assembled project* / *Reveal in Finder*, and either **Finalize
assembled project** or the reasons it is refused. After finalization it reads *Finalized — primary
project now points to the verified assembled revision*. Routes: `/api/laboratory/assemblies`,
`/assembly`, `/assembly/finalize` (requires `confirmed: true`).

## Real packaged run (dogfood `laboratory-assembly-continuity-0.3.5`)

Packaged fixture app, `~/Developer` authorized, CUF harvested VERIFIED 13/13, assembled onto a new
bare node:http host, then the continuity flow — Terminal usage 0, no agent:

- Workspace `asm-new-application-with-hosted-sign-in-work-c690b7-485144`.
- Ledger: `hosted-authentication`, **CURRENT**, **VERIFIED 15/15**, revision `20165d6c7561`,
  contract `sha256:8bb46724…`, genome `sha256:83a9ba9e…`, IR `sha256:cc9d13e8…`, proof 12 cases /
  10 invariants held / 0 violated.
- Detector: **not observed** — reported separately, nothing fabricated.
- Finalization: fast-forward `main` `7a60654961` → `20165d6c7561`, `forced: false`,
  `remotesContacted: []`, ancestry preserved (blank-host commit is the parent; history length 2).
- Primary checkout after: `main`, 0 dirty files, no remote, contains `src/auth` and the `.graft`
  apply receipt.
- Standalone run from the person's own checkout: `/health` → `{"ok":true}`, `/auth/login` → 303 to
  `https://provider.invalid/user_management/authorize`.
- GRAFT reopened: **FINALIZED**, capability still **CURRENT** at the promoted revision.
- Scorecard final state **FINALIZED**. The application is never called universally verified.

Note: `git add --all` commits the transplant's `.graft/` receipts alongside the code, matching what
a normal transplant leaves in a destination — the provenance travels with the application.
