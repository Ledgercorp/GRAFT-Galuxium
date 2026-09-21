# Capability Export 0.1

A harvested capability can now leave GRAFT as a package — the missing normal-user action beside
*Add to a project*. Branch `feature/capability-export-0.1` from
`feature/real-transplant-3-return-response` (`b3488e0`).

## What the package is

An organ in the bank is a contract, not a copy of anyone's source (behaviour, interfaces, data
model, security assumptions, acceptance tests, and the engine's Genome / IR / verification
contract). The implementation GRAFT stands behind is the one it regenerates from that IR. So the
package carries GRAFT's regenerated implementation for one emitter profile — the least
framework-bound profile that can write the kind (`esm-node-http-central` for hosted
authentication; the same modules register on Express through a guard middleware, and `GRAFT.md`
explains both) — plus honest metadata:

```
<name>/
  src/                       regenerated modules (e.g. identity.js, provider.js, routes.js, session.js)
  GRAFT.md                   integration document
  graft-capability.json      schema 1.0.0 manifest
  dependencies.json          runtime, packages, external services, persistence
  configuration.example      configuration NAMES, empty values
  verification-contract.json contract + what was verified, and where
  provenance.json            logical identity, revision, ids, licence metadata — no local paths
  LICENSES/                  licence text found at the source root, when present
```

Nothing from the donor checkout is copied; `.git`, `node_modules`, `.env`, keys, tests and
fixtures cannot appear because export never walks the source tree — only its manifest field and a
root licence file are read, and git supplies the remote (credentials stripped) and revision.

## Manifest (`graft-capability.json`, schemaVersion 1.0.0)

`name`, `displayName`, `capabilityId`, `kind`, `category`, `genomeId`, `irId`,
`verificationContractId`, `implementation` (artifactId, profile, moduleSystem, handlerContract,
framework, runtime, registration {name, marker, style, profile, provenHosts}, files), `source`
(project, remote, revision, architecture, manifestVersion, harvestMethod, aiAssisted),
`verification` (source verdict + summary + method; transplantEvidence by destination family from
the local Atlas; `universalCompatibility: "not-claimed"`), `configuration` (names, required,
purpose), `dependencies`, `assumptions` (session transport/custody/store/durability, credential
authority), `licence` (state, declared, files, warning), `generator` (graft version, schema).

## Verification wording

Source capability verification: the verdict and summary the harvest recorded (VERIFIED 13/13 for
CUF). Known transplant evidence: whatever the local Atlas holds for this exact capabilityId,
grouped by destination family (node:http central, Express guard) — never invented, empty in a
fresh home. Universal compatibility: **not claimed**, in the manifest, the contract file, the
document and the product's receipt dialog. `GRAFT.md` says "Adaptation may be required for other
application architectures" and never "drop this into any project".

## Provenance and privacy

`provenance.json` carries the logical project name and version, the remote URL (userinfo
stripped) and revision, the harvest method and generator, the ids (capabilityId, genomeId, irId,
contractId, artifactId, source fingerprint), the detector signals with source roots replaced by
`<source>`, the source-map roles and hashes, and the licence metadata. Before any file is
accepted, the whole package is scanned for the home directory, `GRAFT_HOME` and the source
roots; a hit refuses the export (`package-privacy`). Tests plant a `.env` with secrets, a private
key and a credentialed remote in the source and assert none of them travel.

## Licence handling

States: `detected` (manifest field and/or a LICENSE/LICENCE/COPYING file at the root, licence
text preserved under `LICENSES/`), `multiple-detected` (family names disagree), `not-detected`
(warning: "Licence metadata was not detected. Confirm you have the right to reuse or distribute
this code."), `private-unspecified` (private package, nothing declared). `UNLICENSED` is shown
with an all-rights-reserved caution. No compatibility engine, no "safe for commercial use".
Licence files are read with `lstat` (no symlink follow) and a size cap.

## Determinism and the receipt

No timestamps inside package files. `packageHash` = SHA-256 over sorted canonical `(path, bytes)`
pairs; the ZIP writer stores entries uncompressed with fixed 1980-01-01 timestamps in sorted
order, so the archive bytes are deterministic too. The same organ, revision and GRAFT version
give the same hash; a different GRAFT version gives a different one. A
`CapabilityExportReceipt` (receiptVersion 1.0.0) is appended atomically to
`GRAFT_HOME/exports/receipts.json`: capabilityId, artifactId, capability, profile, packageHash,
archiveSha256, exportedFileCount, files, destination, sourceProject, sourceRevision, verification
(source verdict, transplant evidence, not-claimed), licence, configurationNames, graftVersion,
createdAt. It is not a verdict; export reads the organ and touches nothing else.

## Filesystem safety

Destination must be an absolute `.zip` in an existing folder whose real path is not inside the
harvested source checkout or the organ bank; a symlinked parent is refused; an existing file is
refused (409 in the product) unless the person chooses *Replace it* (regular files only, checked
with `lstat`) or *Save with a new name* (deterministic `name-2.zip`, `name-3.zip`, …). The
archive is written to a `.part` file with `wx` and renamed into place; the part is removed on any
failure. Entry names are always `<slug>/…` with the slug validated; the writer refuses `..`,
leading `/` and backslashes.

## Product flow

Organ bank card and the harvest-complete dialog show three exits: **Download capability**
("Get the reusable code and everything needed to integrate it yourself"), **Add to a project**
("Let GRAFT adapt it to another project and verify the result"), **Use in Laboratory** (disabled,
"Coming soon"). Download → native save dialog (desktop; the browser dashboard saves into
`GRAFT_HOME/exports/`) → package written → "Capability downloaded" dialog with package path,
capability · profile, source verification, source implementation @ revision, file count,
configuration names, licence (with caution), package hash, and *Reveal in Finder* / *Copy path* /
*Done*. Reveal is allowed only for paths the app's own save dialog produced this session (or
managed worktrees, as before).

## Real packaged run (dogfood `capability-export-0.1`)

Packaged app, isolated home, `~/Developer` authorized from the page, CUF found first for "find
user-facing authentication I have already built" (4 candidates — the fixture projects no longer
appear), harvested VERIFIED 13/13, *Download capability* → package
`~/.graft-demo/capability-export-0.1-package/hosted-authentication.zip`: 11 entries, hash
`sha256:b2f7f6bd9ca2175fe5862476b8c637cd66588cbe4f9b5114076977505165e69b` equal to the receipt,
archive SHA-256 equal to the receipt, no home/GRAFT_HOME/dogfood paths, no sentinel or secret
values, seven `AUTH_*` names with empty values, source `@leftsock/cuf @ ec1af9bb` (remote
`https://github.com/Ledgercorp/CUF.git`), licence `UNLICENSED` with the caution. Product-workflow
Terminal usage 0.

## Harness notes

The demo driver now activates through the licence page's bridge call (the same preload → IPC
path the page's form uses; the form-submit automation stalled on this bundle). The fixture
artifact answers the native save dialog from `GRAFT_FIXTURE_SAVE`; production shows the real
dialog with overwrite confirmation.
