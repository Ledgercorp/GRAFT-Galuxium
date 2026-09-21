# Capability knowledge foundation

GRAFT remains the authority for compatibility decisions and observed verification. The new records are local descriptive evidence. They never make a plan supported, skip a test, or turn an external agent's claim into VERIFIED.

## Capability Contract 1.0.0

New organ packages include `capability-contract.json` alongside the unchanged manifest 0.2.0 sections. Old packages remain readable without a write or migration. An explicit harvest/write atomically adds the contract using the existing staging, lock and rollback mechanism. Unknown contract versions, hash mismatches and disagreement with the manifest are refused. No existing bank is silently rewritten.

The SHA-256 capability ID covers contract version and behavioral requirements: identity/category, behavior, interfaces, dependencies, data requirements, environment names/defaults, security invariants, acceptance tests and destination requirements. Object keys and declared sets are sorted; execution steps and arbitrary request-body arrays preserve order. Collection timestamps, paths, source layout, provenance and lineage do not change behavioral identity. Source architecture and a separate source fingerprint preserve implementation context. The fingerprint hashes parsed JavaScript without comments, offsets or literal formatting; unsupported syntax and other files use opaque content hashes. These hashes are identifiers, not signatures or proof that a repository is trusted.

Contract canonicalization uses JSON finite values and UTF-16 key ordering. Whitespace normalization applies to descriptive behavior/security prose only, never executable strings or HTTP payloads. Changing contract semantics requires a new major contract version and an explicit migration; changing evidence does not change the capability ID.

Project fingerprints bind each content digest to a hashed relative path and bind execution-relevant package metadata. Swapping the contents of two files therefore changes the project fingerprint even though formatting and input file order do not. Architecture metadata preserves ordinary version ranges; URL/local-path dependency specifications and nonstandard names become opaque digests, so credentials and local paths are not carried into compatibility history.

## Local lineage and compatibility

Applied receipts carry the source contract and a compatibility relation: source architecture + capability ID + destination architecture, explicit check codes/reasons, supported/refused/conditionally-supported result, adaptation and engine version. Existing recovery fields remain authoritative for restoring files.

After verification of an applied contract, the core appends a mode-0600 record under the destination's `.graft/compatibility/` directory. It contains digests, structural metadata, acceptance IDs/outcomes, summary and timestamp, without captured project code or paths. Failed and inconclusive observations are recorded too. A storage failure is returned as `knowledgeRecordingError`; it is not silently treated as a recorded success.

Re-harvest matches the current source fingerprint against a previous verified destination observation and carries its parent chain forward. Re-harvest still runs the source acceptance suite independently. Local history is editable by its owner and is not a cryptographic attestation. `inspectLocalCapability(manifest, destinationRoots)` projects destinations/outcomes into the organ's lineage without rewriting the bank. Roots are supplied locally by a trusted caller, never exported. Removing a project or its `.graft` directory removes that local history; back up it together with the repository and organ bank.

History readers enforce a 2 MiB per-record limit, a 1000-record directory limit and a 256-generation lineage limit. Reaching a history/generation limit requires explicit archival instead of silently discarding ancestry. Malformed records, mismatched content hashes and symlinked history are excluded; these checks provide consistency, not owner-proof attestation.

## GRAFTBench

Run `npm run bench`. The machine-readable definition is `bench/graftbench.json`; the report is `dist/graftbench-report.json`. A focused run uses `npm run bench -- --only=cjs-to-return/route-conflict` and writes a separate partial report. Partial reports cannot satisfy the release gate.

The benchmark creates disposable Git repositories, exercises actual harvest, plan, apply, HTTP verification, recovery baselines and re-harvest, then removes only those temporary repositories. Three donor architectures (CJS Node HTTP, ESM return-response with a shared store, ESM Express) feed two supported recipient architectures. The ESM donors are built through real verified transplants from the CJS donor, committed, and independently harvested; this also exercises multiple lineage generations. Unsupported CJS destinations, mounted Express routers and unapproved route conflicts must be refused without changing files.

Nine deliberate mutations cover password validation, authorization, session persistence, logout invalidation, cookie identity, route precedence, environment requirements, storage integration and runtime startup. HTTP failures must be observed by the designated acceptance test; runtime/environment crashes must yield NEEDS_REVIEW, never VERIFIED. A mutation whose patch target is missing fails the benchmark. Any false VERIFIED or failed mutation detection fails the run.

The report separates baseline successful transplants, correct refusals and mutation outcomes. These counts measure this explicit corpus, not support for all real-world applications. Current persistence tests prove behavior across requests, not durable storage across restarts.

Validated corpus: 18 scenarios, six verified successful transplants, three correct refusals, nine detected mutations, zero false VERIFIED results and zero failed mutation detections. All six supported combinations are conditional because they retain explicit route-resolution and/or persistence warnings.

| Donor | ESM return-response recipient | ESM Express recipient |
| --- | --- | --- |
| CJS Node HTTP | VERIFIED; lineage depth 1 | VERIFIED; lineage depth 1 |
| ESM return-response | VERIFIED; lineage depth 2 | VERIFIED; lineage depth 2 |
| ESM Express | VERIFIED; lineage depth 2 | VERIFIED; lineage depth 2 |

CJS recipients and mounted Express routers were refused by architecture checks. An unapproved route conflict was refused without modifying its recipient. Password, authorization, session, logout, cookie, route and storage mutations produced FAILED; environment/startup mutations produced NEEDS_REVIEW. An initial route-control placement did not affect behavior and failed the benchmark; placing the conflicting route before authentication made the intended defect observable. The verifier itself was not relaxed.

Next recommended defensibility milestone: broaden independent authentication fixtures and durable-storage acceptance controls, including restart persistence and expiry behavior, with held-out repository architectures. Expand measured compatibility knowledge before adding capability categories or agent transports.

## Engine knowledge boundary (Engine 1.1)

GRAFT's accumulated knowledge — the Compatibility Atlas, learned recipes and organ engine artifacts — is proprietary, local and private by default.

- **Where it lives.** `GRAFT_HOME/atlas/` (append-only, tamper-evident entries), organ packages in the local organ bank (`graft-engine.json`), and per-project `.graft/` receipts and compatibility history. Nothing is written anywhere else, and the core library writes under `GRAFT_HOME` only when the CLI or workspace explicitly asks (`atlas: 'local'`).
- **What it contains.** Structural metadata: capability ids and kinds, genome/IR/graph digests, architecture *families* (framework, module system, handler contract, persistence) and version ranges, adaptation and recipe identifiers, verdicts, test ids and outcomes, timestamps, host ids (digests). Since Atlas 1.1.0 an entry also cites the evidence it summarises — the source commit hash the capability was verified at, the committed destination commit hash, the proof envelope digest, the plan's pre-transplant check ids and statuses, and for a Laboratory assembly its final state, failed step type and error code — all digests, identifiers and enumerated codes. It never contains customer source text, file contents, secrets, environment values, repository names or paths.
- **Transplantation outcomes.** A Laboratory assembly is one observation per capability, recorded once from the execution's terminal state (`laboratory/atlas-outcomes.js`) — COMPLETED, FAILED, INCONCLUSIVE or BLOCKED, service or adapted library — so an attempt that never reached verification is evidence too, and three verifications of one transplant are not three corroborations. The Assembly Ledger record and the Atlas entry for the same attempt cite the same proof envelope digest; that shared digest is the join between them, and the execution record lists the entry ids under `atlas`. Verifications outside the Laboratory (CLI, Transplant page) still record themselves at verification time, with the same bindings where they exist (an uncommitted destination has no revision and cites no proof). Nothing ranks on these fields; they exist so that future analysis of repeated outcomes can be traced back to exact revisions and proofs rather than to summaries.
- **What learns from it.** Learned recipes are derived from VERIFIED atlas entries only, carry their evidence ids and thresholds, and can only name mechanisms the engine itself implements. They prefer structural metadata over anything customer-specific by construction: the grouping key is kind + architecture families + adaptations.
- **No telemetry, no upload.** No collector, exporter or network sender exists. Nothing leaves the machine. Verification runs a project locally with the user's privileges as before; the engine adds no network access.
- **Aggregate export, if ever.** Only by explicit invocation, previewed first, and constrained to the allowlisted shape below — enumerated families and validated numeric versions, never serialized local records. Excluded by rule: capability/project/event/genome/host hashes, timestamps, paths, repository and package names, user identity, source code, file contents, secrets and free-text reasons. Not implemented in this phase.

## The proprietary stack

GRAFT's defensibility is the accumulated, local, structural knowledge of how software is
actually shaped and how capabilities move between real architectures:

| Layer | What it is | Where it lives |
| --- | --- | --- |
| **Workspace Capability Index** | a local structural map of the software the user has already written — projects, repositories, worktrees, runtimes, entrypoints, server shapes, and classified capabilities with their evidence | `GRAFT_HOME/workspace-index.json` |
| **Capability Genome** | what a capability *is*, independent of how it was written | organ bank |
| **Capability Graph** | how a capability's parts depend on each other | organ bank |
| **GRAFT IR** | the architecture-neutral form a transplant is lowered from | organ bank |
| **Host Model** | what a destination can accept | derived per plan |
| **Compatibility Atlas** | what has actually worked, and what has not, between architecture pairs | `GRAFT_HOME/atlas/` |
| **Transplant Recipes** | built-in and learned transformations, with provenance and promotion thresholds | built-in + derived from the Atlas |
| **Organ Bank** | verified capabilities with their behavior contracts | `GRAFT_HOME/organ-bank/` |
| **Transplant Compiler** | IR → EmissionSpec → destination-native code | core |
| **Proof Kernel** | verification contracts, witnesses and the only thing that says VERIFIED | core |
| **Agent Runtime** | a *replaceable* reasoning layer that interprets and ranks, and decides nothing | core, optional |
| **Accumulated structural knowledge** | the compounding asset: architecture relationships, successful and unsuccessful adaptations, repair evidence, recipe candidates, verification knowledge | local, private |

The Agent Runtime is explicitly the replaceable layer. Any provider or model can be swapped in
or removed entirely, and the product keeps working: discovery, compatibility, refusal,
verification and VERIFIED all come from deterministic GRAFT.

## Provider-double boundary (Engine 1.2)

Verification of a capability whose credential authority is external never touches that authority. A deterministic provider double stands in for the provider alone — token exchange with a real PKCE check, a real signing key at `/jwks`, revocation, a call log — over loopback HTTP for the duration of a run. The application's own session, cookie, PKCE, guard and CSRF code runs unchanged, on the source through the factory seam its own tests use, on the destination through the same production adapter pointed at the double by environment. Nothing from the double is emitted into a destination, nothing is written into a source, and a source without a seam is refused by name rather than run against a live provider. Atlas entries record the pattern (`credential-authority:hosted-provider`, `session:cookie/local/memory`, `registration:central-handler`, `verification:provider-double/endpoint-configuration`) as structural descriptors — never source, never credentials.

## Workspace Capability Index boundary (0.1)

- **Only authorized roots.** The index scans folders the user explicitly added and nothing else; the filesystem at large is never walked.
- **What it contains.** Structure and classification: names, relative paths, language/runtime/framework/module system, entrypoint paths, route methods and paths, dependency names and ranges, environment variable **names**, external service hostnames, deploy targets, git branch/HEAD/dirty, capability subtypes, credential authority, session transport/custody/store, cookie **flags**, signal ids with short detector evidence strings, missing signals and blockers.
- **What it never contains.** Source text, environment variable **values**, secrets or credentials, cookie or session values, database contents, or remote URLs with credentials. Proven by test and by the real-workspace acceptance, which greps the produced index for credential-shaped strings and for source lines taken from every indexed entrypoint.
- **Derived and disposable.** The index is rebuildable from source at any time; deleting it loses nothing but time.
- **No cloud index in this phase.** There is no exporter, uploader or remote store, and no telemetry.

## Agent boundary

`packages/core/src/capability/agent-interface.js` defines transport-neutral operations and host approval requirements for search, inspect, harvest, plan, transplant and verify. No MCP listener, remote API, provider dependency or agent account is enabled. The interface deliberately has no `submitVerdict` operation. A future adapter must resolve local opaque IDs, retain human approvals and bind plans to exact current inputs before calling the existing core APIs.

The Agent Runtime (`packages/core/src/agent/`, see [WORKSPACE-INDEX.md](WORKSPACE-INDEX.md)) is the first implementation of that boundary, and it is enforced structurally rather than by prompting:

- **The agent may:** interpret intent, rank candidates GRAFT already found, explain candidates and architecture mismatches, suggest a recipe, suggest a repair.
- **The agent may never:** determine that a capability exists, that it is harvestable, that a transplant is compatible or permitted, that a test passed, or that anything is PASS / FAIL / INCONCLUSIVE / VERIFIED; nor write a proof, receipt, Atlas outcome or repair result.
- **How it is enforced:** no task exists whose response could carry those fields; every response is rebuilt from an allow-listed schema; any response mentioning a reserved authority name at any depth is rejected in full; rankings carry opaque candidate ids that GRAFT re-resolves from its own index; and `command:run` / `destination:write` are ungrantable scopes. Adversarial tests assert each of these.
- **Credentials are the user's.** Keys are read from the environment or OS-backed secure storage at request time, never written to GRAFT's config, never logged, never placed in a request body or an error message.

## Future aggregate export — design only, disabled

A future opt-in export may emit only this allowlisted shape:

```json
{
  "schemaVersion": "1.0.0",
  "source": { "frameworkFamily": "node-http", "runtimeFamily": "node", "runtimeMajor": 24 },
  "destination": { "frameworkFamily": "express", "frameworkMajor": 5, "runtimeFamily": "node", "runtimeMajor": 24 },
  "capabilityCategory": "authentication",
  "compatibility": "conditionally-supported",
  "verification": "VERIFIED",
  "graftVersion": "0.5.0"
}
```

No exporter or network sender is implemented. A future implementation must reconstruct this object from enumerated families and validated numeric versions, never serialize local records or arbitrary dependency strings. Exclude capability/project/event hashes, timestamps, paths, repository/package names, user identity, source code, file contents, secrets and free-text reasons. Preview and explicit consent must precede any export. No telemetry runs in this milestone.
