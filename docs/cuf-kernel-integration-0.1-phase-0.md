# CUF Kernel Integration 0.1 — Phase 0 discovery (no code moved)

Baseline: `REAL_MULTI_CAPABILITY_COMPOSITION_0_1_BASELINE` = `177dd38`. Branch: `feature/cuf-kernel-integration-0.1`.
CUF inspected at `~/Developer/CUF` @ `ec1af9b` (read-only; nothing written).

## Where the CUF kernel lives

| CUF package | Role | Size | Runtime deps |
|---|---|---|---|
| `packages/contracts` | `Verdict = PASS \| FAIL \| INCONCLUSIVE`, `VerificationTestCase`, `ExecutionObservation`, `EvidenceItem`, `CaseResult`, `VerificationRunResult`, `canonicalJson`, `sha256` | 454 lines | `node:crypto` only |
| `packages/evidence` | `evaluateCase` (per-case verdict), `aggregateVerdict` (FAIL > INCONCLUSIVE > PASS), `evidenceRoot` (content-addressed, deduplicated), `captureEvidence` (redacted, digested items), cleanup verification (authentic-only, WeakSet registry) | 409 lines | contracts (+ a type-only import from adversary-engine) |
| `packages/kernel` | `runVerification` (plan → execute each case → evaluate → aggregate; INCONCLUSIVE when the plan is not seal-eligible/blocked/empty; executor exceptions become INCONCLUSIVE cases) and `RunStateMachine` (CREATED … COMPLETED / FAILED_SAFE, illegal transitions throw) | 100 lines | evidence, contracts (+ type-only adversary-engine) |
| `packages/cufseal` | signing (external/http/keychain/vault) | 453 lines | out of scope |
| `packages/adversary-engine` | actors, verification plans | 349 lines | out of scope (types only) |

All three kernel packages are plain TypeScript compiled to ESM `dist/`; none imports the API, worker, web, database, runtime or provider packages. They are extractable as-is.

## CUF verdict and evidence model (as implemented)

- Per case: `expected: ALLOW|DENY` vs `actual: ALLOWED|DENIED|ERROR`. A contradiction with a verified setup and REQUEST+RESPONSE evidence is FAIL and outranks everything. Otherwise INCONCLUSIVE on: operational error, unverified setup, drift, cleanup not *independently* verified, missing required evidence kinds, ERROR. PASS only when everything held.
- Aggregation: any FAIL → FAIL; any INCONCLUSIVE → INCONCLUSIVE; none → INCONCLUSIVE (empty) ; else PASS.
- Evidence: `EvidenceItem { kind, digest, capturedAt, redacted: true, metadata }`; `evidenceRoot` = sha256 of the sorted, deduplicated digests.
- **Finding that shapes the plan**: `evaluateCase` is not domain-neutral. PASS *requires* an authentic `CleanupVerification` from an independent inspector (WeakSet-registered) and REQUEST/RESPONSE evidence — it encodes CUF's authorization-attack run (setup → attack → cleanup). GRAFT's acceptance cases (HTTP steps, library calls) have no tenant, no cleanup, no ALLOW/DENY. Feeding them to `evaluateCase` unchanged can only yield INCONCLUSIVE, or would require fabricating cleanup proofs — which is exactly what the kernel forbids.

## GRAFT's current verifier model

- One verdict engine: `packages/core/src/verify/index.js` `decideVerdict(results, { serverReady, reason, subject })` over per-test `{ id, required, outcome: passed|failed|inconclusive, detail, observations }` → `VERIFIED | FAILED | NEEDS_REVIEW` with the same precedence as CUF's aggregation (not ready → NEEDS_REVIEW; no required → NEEDS_REVIEW; failed → FAILED; inconclusive → NEEDS_REVIEW; incomplete → NEEDS_REVIEW; else VERIFIED).
- Callers: `runAcceptanceSuite` (HTTP, provider double), `library-runner.js` (`runLibrarySuite`), `engine/verification-contract.js` (proof projection).
- Per-test outcomes are decided by the runners (HTTP expectations, `library-driver.mjs` equals/branch/sameAs checks); `decideVerdict` only aggregates.

Mapping: PASS → VERIFIED, FAIL → FAILED, INCONCLUSIVE → NEEDS_REVIEW. The aggregation precedence is identical, so aggregation can move to CUF with no behaviour change. Per-case decisions cannot move to CUF's `evaluateCase` today (see finding).

## Recommended first migration: the library runner

`runLibrarySuite` → `decideVerdict`: deterministic child-process driver, no network, no provider double, no cleanup; strong oracles already exist (`test/verify.test.js` decideVerdict matrix, `library-host-adaptation.test.js` 14 incl. FAILED / NEEDS_REVIEW paths, `library-assembly` 9, Swivel destination 10/10 and source 8/8 through composition-real / composition-assembly). Same report shape, same verdict, same Ledger.

## Adapter boundary

```
GRAFT runner (library-driver observations: id, outcome, detail, observations)
   ↓  packages/proof-adapter   toCufRun(results, { loaded, reason }) / fromCufVerdict(verdict)
   ↓  packages/cuf-kernel           aggregateVerdict, evidenceRoot, captureEvidence, canonicalJson, sha256, RunStateMachine
   ↑  VerificationRunResult-shaped record { verdict, cases[], evidenceRoot }
GRAFT report: { verdict (mapped), rationale (GRAFT wording), proofRoot (new, additive), results (unchanged) }
```
- GRAFT never reads CUF internals; CUF never imports GRAFT. The adapter is the only module that knows both vocabularies.
- The adapter may **not** decide PASS/FAIL. In 0.1 the per-case `CaseResult` is *constructed* from the runner's outcome (passed→PASS, failed→FAIL, inconclusive→INCONCLUSIVE, with `reason` = the runner's detail and evidence items digested from the observations); CUF `aggregateVerdict` decides the run. `serverReady === false` / no required cases map to CUF's empty-plan INCONCLUSIVE path.
- Fail-closed: INCONCLUSIVE is NEEDS_REVIEW, never VERIFIED; FAIL is never overridden.

## Package layout

- `packages/cuf-kernel/` — vendored *compiled* JS of `@cuf/contracts`, `@cuf/evidence`, `@cuf/kernel` (three files + provenance: CUF revision, per-file sha256, licence note), no build step, no TypeScript toolchain in GRAFT; an identity test compares the vendored bytes with `~/Developer/CUF/packages/*/dist` when that checkout is present. Independently testable: its tests import only `packages/cuf-kernel`.
- `packages/proof-adapter/` — `toCufRun`, `fromCufVerdict`, evidence digesting of GRAFT observations; tests are pure.
- Not a git/npm dependency on CUF in 0.1 (CUF's workspace is private/unpublished; a link to `../CUF` would not ship).

## Differential-test strategy

1. Pure: for every combination in `verify.test.js`'s decideVerdict matrix (and randomised result sets), assert `fromCufVerdict(aggregate(toCufRun(results)))` === `decideVerdict(results).verdict`.
2. Runner: run `runLibrarySuite` on the Swivel artifact (source 8/8), the adapted Swivel in a host (destination 10/10), the mutated adapter (FAILED 4/10), an unloadable artifact (NEEDS_REVIEW) with both engines behind a flag; assert identical verdict, rationale and result lists; then remove the flag.
3. `evidenceRoot` stability: same observations → same root across runs; a changed observation changes it.

## Non-goals for 0.1

No CUFSeal, no HTTP/provider-double verifier migration, no composition/Ledger/finalization changes, no packaged UX changes, no licensing, no CUF `evaluateCase` for GRAFT cases (requires a CUF-side domain-neutral evaluator first — a CUF change, proposed separately), no dependency acquisition, no moving CUF app/runtime code.

## Risks

- Authority is partial in 0.1: CUF owns aggregation, evidence normalization and proof digests; per-case pass/fail still originates in GRAFT's runner. Say so; do not present it as "CUF decides everything".
- Vendored kernel drift: mitigated by provenance + identity test; a later 0.2 can switch to a published `@cuf/*` package.
- `evaluateCase` semantics cannot be adopted without fabricated cleanup proofs — the plan refuses that route.

## Checkpoint A scope (proposed)

1. `packages/cuf-kernel` vendored from CUF `ec1af9b` (contracts, evidence, kernel dist JS) + provenance + identity test + pure kernel tests (aggregateVerdict precedence, evidenceRoot dedup, RunStateMachine transitions).
2. `packages/proof-adapter` with `toCufRun` / `fromCufVerdict` / evidence digesting + the pure differential test against `decideVerdict`.
3. `library-runner.js` computes its verdict through the adapter (flagged during the checkpoint), records `proofRoot`; runner-level differential tests on the real Swivel cases; flag removed once identical.
4. Governor review; no Ledger, composition, UX or licensing changes.
