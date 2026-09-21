# Proof Integrity 0.1 — Discovery (no implementation)

Branch `feature/proof-integrity-0.1` from tag `CUF_KERNEL_INTEGRATION_0_1_BASELINE` (`c28794c`).
Inspected only: `packages/cuf-kernel/src/{evidence,capture}.js`, `packages/proof-adapter/src/index.js`,
the report/ledger shapes in `packages/core/src/verify/{index,library-runner}.js`,
`packages/core/src/laboratory/continuity.js` (record builder), `packages/core/src/export/index.js`
(portability only), and in `~/Developer/CUF` (main `b18f700`): `packages/cufseal/src/*.ts`,
`packages/contracts/src/index.ts` (CUFSeal types), `tests/cufseal.test.mjs` (names), `docs/CUFSEAL_SPEC.md`.
Nothing was vendored, generated, signed, or changed.

## 1. What proofRoot proves today

`proofRoot = sha256(canonicalJson(sortedUnique(evidence.digest…)))` where each
`digest = sha256(canonicalJson({ kind, metadata }))`, metadata scalar-only, `capturedAt` excluded
(the adapter passes a constant epoch), forbidden keys `verdict/pass/fail/inconclusive/result`,
credential patterns refused.

| Family | Evidence leaves |
|---|---|
| library | per observed step: `INVOCATION {observation, operation, arguments}` + `RESULT {observation, value, selected}` |
| HTTP | per step: `REQUEST {test, step, request:"METHOD /path"}` + `RESPONSE {test, step, status, checks:[{name,ok}]}`; restart → `INVOCATION {operation:'restart'}`; witness → `STATE_AFTER {witness}` |

So proofRoot is a **deterministic commitment to the set of observed facts** of one run: what was
invoked/asked and what came back. Same observations → same root, regardless of when, where, by whom,
or with what outcome.

**proofRoot does NOT bind**: the verdict (by design — no verdict enters a digest); the capability
identity (slug/genomeId/irId); the verification contract (`contractId`); source or destination
revision; the application/host; verifier identity or version (kernel provenance `b18f700`,
adapter 0.1.0, core 0.5.0); time; the set of cases that were *expected* (a missing case changes
the root only because its leaves are absent, not because coverage is recorded); the rationale.
A FAILED run also has a root (its RESULT leaves hold the wrong values). Adapter/kernel failure →
`proofRoot: null` (fail-closed, already true).

**Where it lives**: only in the in-memory/JSON verification report (`{ …decision }` spread in
`runAcceptanceSuiteRaw`; `report()` in the library runner) with `proofAuthority`. It does not
reach `evaluateVerificationContract`'s proof `{contractId, verdict, rationale, summary}`, hence not
`proofReference`, not the Assembly Ledger, not finalization, not the UI, not the export package
(`verification-contract.json` carries `contractId` + verification summary, not the root).

## 2. CUFSeal as it exists (CUF main b18f700)

- **Source**: `packages/cufseal/src/index.ts` (228 lines: eligibility, issue, registry, verify,
  applicability, re-derive), `external-signer.ts` (wrapper: timeout, ≤64 KiB payload, 64-byte
  signature, verify-against-declared-public-key before accepting; plus `createInMemoryTestSigner`
  dev/test only), `keychain-signer.ts` (macOS Keychain via subprocess script, "not an HSM"),
  `http-signer.ts` (generic POST `{keyId, algorithm, payloadB64}` → `{signatureB64}`),
  `vault-transit.ts` (HashiCorp Vault Transit ed25519, version-pinned). Compiled dist exists.
  Deps: `@cuf/contracts`, `@cuf/evidence`, and a *type-only* import of `VerificationPlan` from
  `@cuf/adversary-engine`.
- **API**: `assertCUFSealEligible(run, plan)`, `issueCUFSeal({run, plan, environmentId, signer, signal?, now?})
  → SignedCUFSeal`, `isIssuedSeal`, `createSigningKeyRegistry(records)`, `verifyCUFSeal(seal, registry)
  → {status: VALID|INVALID|UNKNOWN_KEY|REVOKED_KEY, keyStatus}`, `evaluateSealApplicability(seal, registry, current)`,
  `rederiveMaterialState({environmentId, run, verifierVersion?})`, `VERIFIER_VERSION` constant.
- **Payload v1** (all fields signed, canonicalJson → Ed25519 over the bytes; `payloadDigest` =
  sha256 of the same bytes): `version:1, issuer:"CUF", runId, issuedAt, environmentId,
  targetFingerprint, graphFingerprint, intentFingerprint, planFingerprint, evidenceRoot, caseCount,
  verdict:"PASS" (literal, never caller-supplied), keyId, verifierVersion`.
- **Eligibility is authorization-domain**: plan `sealEligible` + no `blockedReasons`, run PASS, case
  count == plan case count, intent fingerprint matches plan, four 64-hex fingerprints, every case
  PASS with non-empty evidence, `setupVerified && cleanupVerified && !driftDetected` for every case.
  GRAFT has no plan/intent/graph/target fingerprints, no environmentId, no setup/cleanup/drift
  proofs. **Only PASS is sealable** — a seal is not a general proof envelope; FAIL/INCONCLUSIVE runs
  never get one.
- **Trust model**: signature validity and *applicability* are deliberately separate states. A seal
  is applicable only when environment, target, graph, intent, evidence root and verifier version all
  still re-derive to the signed values and no evidence record fails digest re-derivation
  (`rederiveMaterialState` recomputes every digest from content). Detects **post-issuance
  tampering** of stored records; explicitly "tampering before issuance is not detectable by this
  construction and is not claimed"; "does not certify regulatory compliance or future security".
  In-process `ISSUED_SEALS` WeakSet: a deserialized seal has no authority until verified.
- **Keys**: Ed25519 only; SPKI-DER-base64 public keys in a registry with status
  `ACTIVE|ROTATED|REVOKED`, `rotatedTo`, `revokedAt`, `revocationReason`. Rotation = new keyId
  (seals from a ROTATED key become *inapplicable*, still VALID); revocation → `REVOKED_KEY`.
  Spec: private bytes never in DB rows, browser output, logs, evidence, or model context.
  Production issuance expects an injected KMS/HSM/keychain signer; the in-memory signer is refused
  in production config.
- **Offline**: `issueCUFSeal` with the keychain signer is offline; http/Vault backends are online.
  `verifyCUFSeal` is fully offline given a registry (public material only). No revocation lookup
  online — the registry is a local list.
- **Portability**: `SignedCUFSeal` is plain JSON (payload + digest + base64url signature);
  verifiable anywhere with the public key and the same canonicalJson. Applicability additionally
  needs the stored run records.
- **Independent verification**: reconstruct canonical bytes → compare `payloadDigest` → find key by
  id → Ed25519 verify → separately evaluate applicability. `verifyCUFSeal` hard-checks
  `issuer === "CUF"`, `verdict === "PASS"`, `version === 1`; a GRAFT-shaped payload would be
  `INVALID` under it as-is.
- **Tests** (`tests/cufseal.test.mjs`, 9): eligible PASS seals and verifies; any payload alteration
  fails; changed intent/target/graph/evidence/environment/verifier → inapplicable; timestamps and
  evidence order irrelevant; only strict PASS sealable; revoked/unknown/rotated explicit; hand-built
  seal has no authority; failing/malformed signer → no seal; no private material exposed.
- **What is generic vs CUF-specific**: generic — signer boundary (`CUFSealSigner`), external-signer
  wrapper discipline, key registry + status handling, verify/applicability split, the
  re-derive-digests-from-content idea. CUF-specific — the payload, eligibility, the
  `VERIFIER_VERSION` string (Mission 1 Postgres assurance profile), the `issuer/verdict` hard-checks.
  Vendoring `index.ts` as-is would carry an eligibility function GRAFT could satisfy only by
  fabricating a `VerificationPlan` — dishonest, therefore rejected.

## 3. Threat model (what GRAFT can honestly defend)

| Threat | Model A (hash-only envelope) | With a signature (B/C/D) |
|---|---|---|
| A. accidental file modification | **Detected** (digest mismatch) | detected |
| B. verdict edit VERIFIED↔FAILED | **Detected** if the verdict is inside the hashed envelope | detected |
| C. destinationRevision swapped | **Detected** if revision is inside the envelope; *truth* of the revision still relies on git | detected |
| D. root attached to another capability | **Detected** if capability identity + contractId are in the envelope | detected |
| E. root attached to another application | **Detected** if destination identity/revision + host profile are in the envelope | detected |
| F. verifier identity/version changed | **Detected** as inconsistency if verifier identity is in the envelope | detected |
| G. evidence modified/removed | **Detected** when the evidence manifest is present and re-derived (CUFSeal's `rederive` idea) | detected |
| H. copying a legitimate artifact between machines | **Not a threat to integrity** — an envelope is portable by design; it proves "this claim/evidence pair is intact", not "this machine ran it". Which machine is provenance, not integrity | signature adds *who issued*, still not *where it ran* |
| I. malicious local user with full filesystem access | **Not defended**: can recompute the hash after editing | **Not defended** with a local key (can re-sign); only defended if the key is *not* on that machine (C/D) — and even then they can alter evidence *before* issuance |
| J. malicious party without the signing secret | n/a (no secret) | **Defended**: cannot forge an issuer-attributed envelope; can still produce an unsigned/self-signed one |

Honest statement: GRAFT can defend against accident, drift, mis-association and post-hoc editing by
anyone who does not control the issuing machine/key. It cannot defend against a fully compromised
verifying machine under any model, because evidence is captured on that machine before any
integrity mechanism sees it (CUF says the same).

## 4. Integrity models

| Criterion | A hash-only | B per-install key | C org key | D LeftSock signer | E hybrid |
|---|---|---|---|---|---|
| Solves | A–G (self-consistency, mis-association) | A–G + J (issuer attribution per machine) | A–G + J (issuer = org) | A–G + J (issuer = LeftSock-attested account) | A–G local; J opt-in |
| Does not solve | I, J (anyone can re-hash) | I; key on the same disk as the proof | I on the machine holding the key; pre-issuance tampering | I; pre-issuance tampering; LeftSock attests only "we signed what was submitted" | same as A by default |
| Customer value | "proof matches evidence"; portable; diffable | low for solo (who checks *my* key?); modest for CI attestations | real for teams: "signed by our release key" | trust anchor for third parties; account-bound | A's value now; C/D's later without redoing A |
| Offline | full | full | full (verify: registry) | **issuance online** → violates offline-first if required | full |
| Privacy | envelope holds only digests/ids | key id reveals install | org identity in artifact | proof identity/root leaves the machine | A privacy by default |
| Key management | none | generate, store (keychain), back up, rotate, revoke — for every solo dev | org custody, distribution of public keys, rotation policy | LeftSock's; account/login required | none by default |
| Recovery | none needed | lost machine = lost key; old proofs still *verify* (public key kept) but nothing new attributable | org holds it | LeftSock holds it | none by default |
| Revocation | n/a | local registry only — nobody consults it | registry distribution problem | central, real | n/a by default |
| Portability | best (self-contained) | needs public key alongside | needs org key distribution | needs LeftSock reachable or cached key | best by default |
| CI usefulness | high (recompute + compare) | medium | high (CI holds org key) | high but online | high |
| Team usefulness | medium (integrity, not attribution) | low | high | high | medium→high |
| Implementation cost | small: envelope schema + canonical hash + `verify` | medium: keygen, keychain, registry, rotation, UX | high | high + service + auth + billing | small now; optional later |
| UX complexity | none visible | keys visible to every user | org admin | login | none by default |
| Defensibility | moderate: evidence-bound claim ≠ "ran tests" | low | moderate | moderate-high (network effect) but easily copied | moderate now, path to more |

Complexity filter: B fails ("every solo developer manages keys", "losing a machine"), D fails
("normal verification depends on cloud", "requires accounts"). C is a team feature, not a core one.

## 5. Recommendation

**Model E with Model A as the only 0.1 scope.** A content-addressed *proof envelope* that binds
what proofRoot currently does not, verified by recomputation, offline, no keys. Signing (C or D)
is a later opt-in layer over the same envelope — the envelope digest is what a signer would sign,
so A is a strict prerequisite for any signing and is never wasted.

### Proposed envelope (content, not code)

```
{ schema: "graft-proof-envelope/1",
  capability: { id, slug, kind, implementationForm, genomeId, irId },
  contract: { contractId, contractVersion },
  source: { project?, revision },
  destination: { revision, hostProfile: { framework, handlerContract, … from architectureSignature } },
  verifier: { product: "graft", coreVersion, adapterVersion,
              proofKernel: { sourceCommit, vendoredSha256 of the kernel files } },
  verdict: "VERIFIED"|"FAILED"|"NEEDS_REVIEW", kernelVerdict: "PASS"|"FAIL"|"INCONCLUSIVE",
  proofRoot, proofAuthority,
  evidence: { count, manifestDigest }   // sha256 over canonical sorted [{kind, digest}] (no metadata → no secrets)
  cases: [{ id, outcome }], createdAt,
  createdBy: "graft", proofAuthority: "cuf-kernel" }
envelopeDigest = sha256(canonicalJson(envelope))   // the integrity mechanism in 0.1
```

Rules: `verdict` is copied from the kernel decision, never derived from the envelope; the envelope
carries FAILED and NEEDS_REVIEW runs too (unlike CUFSeal) because an intact record of a failure is
as valuable as one of a pass; `createdAt` is outside nothing — it is inside the envelope but never
inside proofRoot; no metadata values, no paths, no secrets (redactSecrets already applies to reports).

### Ledger boundary

Keep it. `proofReference` grows by at most `{ envelopeDigest, envelopePath? }` — a *reference*.
The Ledger continues to answer continuity (CURRENT/STALE/INVALIDATED, revisions); the envelope
answers "is this claim/evidence binding intact and what exactly did it bind". No ledger schema
migration in 0.1; even the reference is a later checkpoint.

### Verdict authority

Unchanged: kernel PASS/FAIL/INCONCLUSIVE → adapter VERDICT_MAP. An envelope that verifies means
"unmodified"; an envelope that fails to verify means "do not trust this record" — it never means
FAILED, and a verifying envelope never means VERIFIED. UI wording (later) must be two separate
states: verdict, and integrity (intact / mismatch / absent).

### Verifier/version binding

Bind: `@graft/core` version, `@graft/proof-adapter` version, kernel `PROVENANCE.sourceCommit` and
the vendored file digests (already recorded). Do not bind a CUF "VERIFIER_VERSION" string — GRAFT
runs the vendored kernel, not CUF's verifier.

### Source/destination revision binding

Bind `destinationRevisionAfter` (the revision the verdict is about) and `sourceRevision` when known
(donor git head; workspace copies without git record `null`, honestly). Binding a revision proves
the claim *names* that revision, not that the tree at that revision was what ran — that second
property needs the run to be at a committed revision, which the composition kernel already
guarantees for re-verification (`recordKnowledge:false` + `candidate-moved` refusal).

### Customer value (ranked)

1. "Verified at revision R" that survives export/copy (envelope in the export package) — high.
2. CI/release proof: recompute-and-compare in CI, no keys — high.
3. Code-review attachment (PR comment with envelopeDigest + verdict + revision) — medium-high.
4. Audit trail / provenance validation (Ledger → envelope → kernel provenance) — medium.
5. External verifier command (`graft proof verify <file>`) — medium, cheap, enables 1–3.
6. Team verification with org signing — medium, later (Model C).
7. SBOM-style release bundle attachment — low now.

### Defensibility

Yes, moderately: it turns "AI copied code and ran tests" into "here is a canonical, recomputable,
evidence-bound record of exactly what was observed at revision R by a provenance-pinned proof
kernel". Trivially copyable as a *format*; not trivially copyable as a *system* because it
compounds with the contract (`contractId`), the vendored kernel provenance, Capability Memory /
Atlas (verification history keyed by the same ids) and the Ledger. Signing alone would not add
moat; the envelope + kernel provenance does.

### What NOT to build (0.1)

Keys of any kind; keychain/subprocess signer; hosted signer; login; revocation registries; CUFSeal
vendoring; a Ledger schema change; UI beyond a single integrity line (later); SBOM/in-toto/SLSA
formats; timestamping authorities; "tamper-proof" claims.

### Should CUFSeal be integrated?

**Not now, and not as-is.** Its payload and eligibility are authorization-domain and PASS-only; its
`verifyCUFSeal` rejects non-CUF issuers. What should be *reused later* (when Model C is wanted) is
the generic part: the `CUFSealSigner` boundary, the external-signer discipline (verify against the
declared public key, bounds, timeouts), the registry/status model and the validity-vs-applicability
split. That reuse would be a CUF change to split a domain-neutral `@cuf/sealing` primitive out of
`@cuf/cufseal` — a later CUF feature branch, not a GRAFT vendoring of today's file.

### Proposed Checkpoint A (if approved)

Scope: `packages/proof-adapter` gains `buildProofEnvelope(report, identity)` and
`verifyProofEnvelope(envelope)` (recompute digest; return `{ intact, reasons }`; never a verdict);
`verifyCapability`/library `report()` attach `proofEnvelope` to the report (additive, no consumer
change); tests: determinism, every bound field flips the digest, verdict copied not derived,
FAILED/NEEDS_REVIEW envelopes exist, `proofRoot: null` → no envelope (fail-closed), no secrets/paths
in the envelope, engine-guard intact. No Ledger, UI, export, CLI, key, or CUF change.
Estimated diff: ~150 lines + tests.

### Governor findings

- Truthful claims: integrity ≠ authenticity; I/H stated honestly; "tamper-evident under the
  no-secret model", never "tamper-proof".
- No signature-as-verdict: envelope verify returns `intact`, not a verdict.
- Offline-first preserved; no cloud dependency; no key lifecycle in 0.1.
- No Ledger overloading: reference only, and not even that in Checkpoint A.
- No UI explosion; no AI authority (kernel decides; envelope binds).
- Portable and independently verifiable with sha256 + canonicalJson (both already vendored).
- Minimal scope; commercial value concentrated in items 1–3 above.
- Residual risk to flag before Checkpoint A: canonicalJson must remain byte-stable across GRAFT
  versions for old envelopes to re-verify — pin the envelope schema version and never reorder or
  rename fields within a schema version.
