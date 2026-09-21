// Capability Export 0.1 — a harvested capability as a package a person can take away.
//
// An organ in the bank is a contract, not a copy of anyone's source: behaviour, interfaces,
// data model, security assumptions, acceptance tests, and the engine artifacts (Genome, IR,
// verification contract) GRAFT derived from it. The implementation GRAFT stands behind is the
// one it regenerates from that IR for a host profile it knows. A package therefore carries:
//
//   <name>/src/…                    GRAFT's regenerated implementation for one emitter profile
//   <name>/GRAFT.md                 how to integrate it, what it assumes, what was verified
//   <name>/graft-capability.json    stable, non-secret manifest
//   <name>/dependencies.json        runtime, packages, external services, persistence
//   <name>/configuration.example    configuration NAMES with empty placeholders
//   <name>/verification-contract.json  the contract plus what was actually verified, and where
//   <name>/provenance.json          logical identity, revision, ids, licence metadata — no local paths
//   <name>/LICENSES/…               licence text found in the source, when redistributable text exists
//
// Determinism: the same organ, revision and GRAFT version produce the same logical contents;
// no timestamps live inside package files (the local receipt carries createdAt). The package
// hash is over canonical (path, bytes) pairs, never filesystem metadata. Export decides
// nothing: it never touches verification, compatibility, proof or Atlas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readManifest, readOrganEngine } from '../manifest/io.js';
import { lowerToEmission } from '../engine/lower.js';
import { selectRecipe } from '../engine/recipes.js';
import { emitCapability } from '../emit/index.js';
import { SUPPORTED_PROFILES } from '../emit/profiles.js';
import { loadAtlas } from '../engine/atlas.js';
import { graftHome } from '../registry/index.js';
import { remoteOf } from '../apply/git.js';
// Cyclic with adapt/library-host.js (which takes detectLicense / recordedSourceIdentity from here);
// both sides use the other's exports inside functions only, never at module evaluation.
import { checkArtifactIdentity } from '../adapt/library-host.js';
import { sourceRevisionOf } from '../verify/proof-envelope.js';

export const PACKAGE_SCHEMA_VERSION = '1.0.0';
export const RECEIPT_VERSION = '1.0.0';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
const canonical = (value) => JSON.stringify(sortKeys(value), null, 2) + '\n';
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}
const sha256 = (buffer) => 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');

// ---------------------------------------------------------------------------------------------
// Licence metadata: preserved, never judged.
// ---------------------------------------------------------------------------------------------
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'COPYING', 'COPYING.md'];
export const LICENSE_WARNING = 'Licence metadata was not detected. Confirm you have the right to reuse or distribute this code.';
/** What the source declares about its licence. Reads only the manifest field and a licence file at the root. */
export function detectLicense(sourceRoot) {
  const result = { state: 'not-detected', declared: null, files: [], warning: LICENSE_WARNING };
  if (!sourceRoot || !fs.existsSync(sourceRoot)) return result;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
    if (typeof pkg.license === 'string' && pkg.license.trim()) result.declared = pkg.license.trim();
    else if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') result.declared = pkg.license.type;
    if (pkg.private === true && !result.declared) result.private = true;
  } catch { /* no manifest or unreadable: nothing declared */ }
  for (const name of LICENSE_FILES) {
    const file = path.join(sourceRoot, name);
    let stat; try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.size > 256 * 1024) continue;
    const text = fs.readFileSync(file, 'utf8');
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
    result.files.push({ name, firstLine: firstLine.slice(0, 120), sha256: sha256(Buffer.from(text)), text });
  }
  // "MIT" and "MIT License" are one licence; "MIT" and "Apache License 2.0" are two.
  const normalise = (l) => (l.toLowerCase().replace(/\b(the|license|licence|version|v)\b/g, '').replace(/[^a-z0-9.]+/g, ' ').trim().split(' ')[0] || '');
  const names = new Set([...(result.declared ? [normalise(result.declared)] : []), ...result.files.map((f) => f.firstLine).filter((l) => /licen[cs]e/i.test(l)).map(normalise)].filter(Boolean));
  if (result.declared && result.files.length) result.state = names.size > 1 ? 'multiple-detected' : 'detected';
  else if (result.declared || result.files.length) result.state = 'detected';
  else if (result.private) result.state = 'private-unspecified';
  if (result.state !== 'not-detected') result.warning = result.state === 'private-unspecified' ? 'The source is marked private and declares no licence. Confirm you have the right to reuse or distribute this code.' : /^UNLICENSED$/i.test(result.declared || '') ? 'The source declares UNLICENSED (all rights reserved). Confirm you have the right to reuse or distribute this code.' : null;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Building the logical package.
// ---------------------------------------------------------------------------------------------
/** A minimal Host Model for an emitter profile: enough for lowering, nothing about any real destination. */
export function profileHost(profileId, kind) {
  const profile = SUPPORTED_PROFILES.find((p) => p.id === profileId && p.kinds.includes(kind));
  if (!profile) throw fail('unsupported-profile', `No emitter writes ${kind} for profile ${profileId}.`);
  return {
    moduleSystem: { value: profile.moduleSystem, evidence: 'export profile' },
    framework: { value: profile.framework || 'node-http', version: null, evidence: 'export profile' },
    runtime: { family: 'node', entrypoint: null },
    dataLayer: { persistence: 'module-state', modules: [] },
    constraints: { handlerContract: { value: profile.handlerContract, evidence: [] }, adaptationProfile: profile.id, profilesByKind: { [kind]: profile.id } },
  };
}
/** The default export profile for a kind: the least framework-bound emitter that can write it. */
export const defaultProfileFor = (kind) => [...SUPPORTED_PROFILES].filter((p) => p.kinds.includes(kind)).sort((a, b) => Number(Boolean(a.framework === 'express')) - Number(Boolean(b.framework === 'express')))[0]?.id || null;

/** The private-path terms a package must never contain. */
function privateTerms(extra = []) {
  const terms = new Set([os.homedir(), graftHome(), ...extra].filter((t) => typeof t === 'string' && t.length > 3));
  return [...terms];
}
function assertPrivate(files, terms) {
  const leaks = [];
  for (const [file, content] of Object.entries(files)) {
    const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
    for (const term of terms) if (text.includes(term)) leaks.push(`${file} mentions ${term}`);
  }
  if (leaks.length) throw fail('package-privacy', `The package would contain private local information: ${leaks.join('; ')}`);
}
const stripRoot = (value, roots) => { let out = String(value); for (const r of roots) out = out.split(r).join('<source>'); return out; };

/**
 * The source identity a capability's evidence came from, as the harvest recorded it: the revision
 * is `sourceRevisionOf` (the head of a clean checkout that did not change during verification,
 * else null) and the remote is the one recorded at harvest. The live checkout is consulted only
 * for a remote an older manifest did not record — never for the revision, because the checkout
 * may have moved since the capability was verified and a package must not name a revision its
 * evidence is not about. Also used by host adaptation, which writes the same identity into the
 * destination's provenance record.
 */
export function recordedSourceIdentity(manifest, sourceRoot = null) {
  const state = manifest?.provenance?.verifiedInSource?.sourceState || null;
  return { remote: state?.remote ?? (sourceRoot ? remoteOf(sourceRoot) : null), revision: sourceRevisionOf(manifest) };
}
export { remoteOf };

/**
 * Build the logical package for an organ. Pure with respect to the destination: nothing is
 * written. `sourceRoot` (the harvested project's checkout) is consulted only for licence text,
 * remote and revision, and only when it still exists.
 */
export function buildCapabilityPackage({ organDir, graftVersion, profile = null, atlasDirectory = null, now = null } = {}) {
  const manifest = readManifest(organDir);
  // A library capability has no emitter and no host to register with: its package carries the
  // library's own artifact plus the metadata a person needs to use it, never generated host code.
  if (manifest.identity?.implementationForm === 'library') return buildLibraryPackage({ organDir, manifest, graftVersion });
  const engine = readOrganEngine(organDir);
  const ir = engine?.ir; const genome = engine?.genome; const contract = engine?.verificationContract;
  if (!ir || !genome) throw fail('organ-has-no-engine-artifacts', 'This capability was harvested without engine artifacts and cannot be exported.', 'Harvest it again with this version of GRAFT.');
  const kind = ir.capability.kind;
  const slug = manifest.identity.slug;
  if (!SLUG.test(slug)) throw fail('invalid-slug', 'The capability slug is not a safe package name.');
  const profileId = profile || defaultProfileFor(kind);
  if (!profileId) throw fail('unsupported-kind', `GRAFT has no emitter for ${kind}, so there is no implementation to export.`);
  const host = profileHost(profileId, kind);
  const selection = selectRecipe(ir, host);
  const spec = lowerToEmission(ir, host, selection.recipe, { dir: 'src' });
  const emission = emitCapability(spec);
  const sourceRoot = manifest.identity.sourceProjectRoot && fs.existsSync(manifest.identity.sourceProjectRoot) ? manifest.identity.sourceProjectRoot : null;
  const licence = detectLicense(sourceRoot);
  const { remote, revision } = recordedSourceIdentity(manifest, sourceRoot);
  const roots = [manifest.identity.sourceProjectRoot, manifest.provenance?.sourceProject?.root].filter(Boolean);

  // What was verified, and where: the source verdict and the local Atlas evidence for this
  // capability, by destination family. Universal compatibility is never claimed.
  const sourceVerification = manifest.provenance?.verifiedInSource ? { verdict: manifest.provenance.verifiedInSource.verdict, summary: manifest.provenance.verifiedInSource.summary || null, method: 'acceptance tests against the running source through its provider seam' } : { verdict: 'UNVERIFIED', summary: null, method: null };
  let transplantEvidence = [];
  try {
    // The local Atlas's own observations of this exact capability, grouped by destination family.
    const entries = loadAtlas(atlasDirectory ? { directory: atlasDirectory } : {}).filter((e) => e.capabilityId === genome.identity.capabilityId);
    const families = new Map();
    for (const e of entries) { const key = `${e.destinationArchitecture?.framework || '?'}/${e.destinationArchitecture?.handlerContract || '?'}`; const f = families.get(key) || { destination: key, verified: 0, failed: 0, other: 0 }; const v = e.verification?.verdict; if (v === 'VERIFIED') f.verified += 1; else if (v === 'FAILED') f.failed += 1; else f.other += 1; families.set(key, f); }
    transplantEvidence = [...families.values()];
  } catch { transplantEvidence = []; }

  const configuration = (manifest.environment?.variables || []).map((v) => ({ name: v.name, required: v.required === true, purpose: v.purpose || null, default: v.default ?? null }));
  const dependencies = {
    runtime: (manifest.dependencies?.runtime || []).map((r) => ({ name: r.name, range: r.range, reason: r.reason || null })),
    packages: [...(manifest.dependencies?.packages || []), ...(emission.dependencies || [])].map((p) => (typeof p === 'string' ? { name: p } : { name: p.name, range: p.range || p.version || null })),
    externalServices: (manifest.dependencies?.services || []).map((s) => ({ name: s.name, role: s.role, required: s.required === true, verifiedWith: s.verifiedWith || null })),
    persistence: { sessions: ir.policies?.session ? { store: ir.policies.session.store || 'memory', durableAcrossRestart: ir.policies.session.durableAcrossRestart === true } : null, notes: manifest.dependencies?.notes || [] },
    moduleSystem: host.moduleSystem.value,
    installation: 'GRAFT installs nothing. Add the packages above with your own package manager.',
  };
  const files = {};
  for (const f of emission.files) files[`${slug}/${f.path}`] = f.contents;
  const exportedFiles = emission.files.map((f) => f.path).sort();
  const registration = { name: emission.registration?.name || null, marker: emission.registration?.marker || null, style: emission.registration?.style || null, profile: profileId,
    provenHosts: SUPPORTED_PROFILES.filter((p) => p.kinds.includes(kind)).map((p) => p.id) };
  const capabilityManifest = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    name: slug, displayName: manifest.identity.name, capabilityId: genome.identity.capabilityId, kind, category: genome.identity.category,
    genomeId: genome.genomeId || null, irId: ir.irId || null, verificationContractId: contract?.contractId || null,
    implementation: { artifactId: spec.specId, profile: profileId, moduleSystem: host.moduleSystem.value, handlerContract: host.constraints.handlerContract.value, framework: host.framework.value, runtime: 'node', registration, files: exportedFiles },
    source: { project: manifest.identity.sourceProject, remote, revision, architecture: manifest.provenance?.capabilitySource?.architecture || null, manifestVersion: manifest.identity.manifestVersion, harvestMethod: manifest.provenance?.method || null, aiAssisted: manifest.provenance?.aiAssisted === true },
    verification: { source: sourceVerification, transplantEvidence, universalCompatibility: 'not-claimed' },
    configuration: configuration.map((c) => ({ name: c.name, required: c.required, purpose: c.purpose })),
    dependencies: { runtime: dependencies.runtime, packages: dependencies.packages, externalServices: dependencies.externalServices.map((s) => s.name) },
    assumptions: { session: ir.policies?.session ? { transport: manifest.architecture?.capabilityModel?.session?.transport || null, custody: manifest.architecture?.capabilityModel?.session?.custody || null, store: ir.policies.session.store || 'memory', durableAcrossRestart: ir.policies.session.durableAcrossRestart === true } : null, credentialAuthority: ir.policies?.credentialAuthority?.kind || null },
    licence: { state: licence.state, declared: licence.declared, files: licence.files.map((f) => ({ name: f.name, sha256: f.sha256 })), warning: licence.warning },
    generator: { name: 'graft', version: graftVersion || null, exportSchema: PACKAGE_SCHEMA_VERSION },
  };
  files[`${slug}/graft-capability.json`] = canonical(capabilityManifest);
  files[`${slug}/dependencies.json`] = canonical(dependencies);
  files[`${slug}/configuration.example`] = configuration.map((c) => `# ${c.required ? 'required' : 'optional'}${c.purpose ? ` — ${c.purpose}` : ''}\n${c.name}=\n`).join('\n');
  files[`${slug}/verification-contract.json`] = canonical({ contract: contract || null, verification: capabilityManifest.verification, acceptanceTests: (manifest.acceptanceTests?.tests || []).map((t) => ({ id: t.id, required: t.required === true, provesBehavior: t.provesBehavior, description: t.description || null })) });
  files[`${slug}/provenance.json`] = canonical({
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    sourceProject: { name: manifest.identity.sourceProject, version: manifest.provenance?.sourceProject?.version || null, remote, revision },
    harvest: { manifestVersion: manifest.identity.manifestVersion, method: manifest.provenance?.method || null, generator: manifest.provenance?.generator || null, generatorVersion: manifest.provenance?.generatorVersion || null, aiAssisted: manifest.provenance?.aiAssisted === true },
    ids: { capabilityId: genome.identity.capabilityId, genomeId: genome.genomeId || null, irId: ir.irId || null, verificationContractId: contract?.contractId || null, artifactId: spec.specId, fingerprint: manifest.provenance?.capabilitySource?.fingerprint || null },
    evidence: { detectorSignals: (manifest.provenance?.detectorSignals || []).map((s) => ({ id: s.id, evidence: stripRoot(s.evidence, roots) })), sourceFiles: (manifest.sourceMap?.files || []).map((f) => ({ file: f.file, role: f.role, sha256: f.sha256 })) },
    licence: { state: licence.state, declared: licence.declared, files: licence.files.map((f) => ({ name: f.name, sha256: f.sha256, includedAs: `LICENSES/${f.name}` })), warning: licence.warning },
    graft: { version: graftVersion || null },
    note: 'Nothing in this package is copied from the source project; the implementation is regenerated by GRAFT from the harvested contract. Local filesystem paths are intentionally absent.',
  });
  for (const f of licence.files) files[`${slug}/LICENSES/${f.name}`] = f.text;
  files[`${slug}/GRAFT.md`] = integrationDocument({ slug, manifest, kind, host, profileId, exportedFiles, configuration, dependencies, sourceVerification, transplantEvidence, licence, registration, graftVersion });
  assertPrivate(files, privateTerms(roots));
  const ordered = Object.keys(files).sort();
  const packageHash = sha256(Buffer.concat(ordered.flatMap((p) => [Buffer.from(`${p}\n`), Buffer.from(files[p]), Buffer.from('\n')])));
  return { name: slug, files, fileList: ordered, packageHash, manifest: capabilityManifest, licence: { state: licence.state, declared: licence.declared, warning: licence.warning }, verification: capabilityManifest.verification, configurationNames: configuration.map((c) => c.name), sourceProject: manifest.identity.sourceProject, revision, profile: profileId, artifactId: spec.specId, capabilityId: genome.identity.capabilityId };
}


/**
 * A capability package for library form. Nothing is regenerated and nothing is emitted: the
 * package carries the library's own published artifact, the metadata GRAFT proved about it, and
 * its licence and provenance. Destination integration is explicitly not claimed, because GRAFT has
 * no adaptation for this form yet.
 */
function buildLibraryPackage({ organDir, manifest, graftVersion }) {
  const engine = readOrganEngine(organDir);
  const ir = engine?.ir; const genome = engine?.genome; const contract = engine?.verificationContract;
  if (!ir || !genome) throw fail('organ-has-no-engine-artifacts', 'This capability was harvested without engine artifacts and cannot be exported.', 'Harvest it again.');
  const slug = manifest.identity.slug;
  if (!SLUG.test(slug)) throw fail('invalid-slug', 'The capability slug is not a safe package name.');
  const model = manifest.architecture.capabilityModel;
  const artifactSpec = model.artifact || {};
  const sourceRoot = manifest.identity.sourceProjectRoot && fs.existsSync(manifest.identity.sourceProjectRoot) ? manifest.identity.sourceProjectRoot : null;
  if (!sourceRoot) throw fail('source-unavailable', 'The library source checkout is no longer present, so its artifact cannot be packaged.', 'Restore the project and harvest again.');
  const roots = [manifest.identity.sourceProjectRoot, manifest.provenance?.sourceProject?.root].filter(Boolean);
  const licence = detectLicense(sourceRoot);
  const { remote, revision } = recordedSourceIdentity(manifest, sourceRoot);

  // The one file that is copied: the library's own published artifact, read from inside the
  // project only, by the exact relative path the manifest recorded.
  const artifactPath = path.resolve(sourceRoot, artifactSpec.entry || '');
  const realRoot = fs.realpathSync(sourceRoot);
  const realArtifact = (() => { try { return fs.realpathSync(artifactPath); } catch { return null; } })();
  if (!realArtifact || !(realArtifact === realRoot || realArtifact.startsWith(realRoot + path.sep))) throw fail('artifact-outside-source', 'The library artifact is not inside the source project.');
  if (!fs.lstatSync(realArtifact).isFile()) throw fail('artifact-not-a-file', 'The library artifact is not a regular file.');
  const artifactBytes = fs.readFileSync(realArtifact);
  if (artifactBytes.length > 2 * 1024 * 1024) throw fail('artifact-too-large', 'The library artifact is larger than this package format carries.');
  // The bytes are read live, the provenance below names the revision the harvest verified: the two
  // agree only if the artifact is still the one GRAFT verified. The same identity authority the
  // Laboratory consults before adapting decides it; a changed artifact is refused, never packaged
  // under the recorded revision and never quietly re-harvested.
  const identity = checkArtifactIdentity({ manifest, sourceRoot });
  if (!identity.matched) throw fail(identity.reason || 'artifact-identity-mismatch', `The library artifact cannot be packaged: ${identity.detail}.`, 'Harvest the capability again from the source as it is now, then export that.');
  if (`sha256:${identity.actualFull}` !== sha256(artifactBytes)) throw fail('artifact-identity-mismatch', 'The library artifact changed while it was being packaged.');
  const artifactName = path.posix.basename(artifactSpec.entry);
  const artifactSha = sha256(artifactBytes);

  const sourceVerification = manifest.provenance?.verifiedInSource
    ? { verdict: manifest.provenance.verifiedInSource.verdict, summary: manifest.provenance.verifiedInSource.summary || null, method: manifest.provenance.verifiedInSource.runtime?.profile || null, at: manifest.provenance.verifiedInSource.at || null }
    : null;
  const dependencies = {
    runtime: (manifest.dependencies?.runtime || []).map((r) => ({ name: r.name, range: r.range, reason: r.reason || null })),
    packages: [],
    externalServices: [],
    sourceExecution: { requiresInstall: false, note: 'GRAFT verified this library by loading the published artifact in this package. Nothing was installed or built.' },
    destinationIntegration: { established: false, requirements: (manifest.dependencies?.hostRequirements || []).map((r) => ({ kind: r.kind, name: r.name, version: r.version || null, reason: r.reason })), note: 'GRAFT has no host adaptation for library-form capabilities yet, so what a destination needs beyond this library is not yet established.' },
    moduleSystem: artifactSpec.moduleSystem || null,
    installation: 'GRAFT installs nothing.',
  };
  const capabilityManifest = {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    name: slug, displayName: manifest.identity.name, capabilityId: genome.identity.capabilityId, kind: ir.capability.kind, category: genome.identity.category,
    implementationForm: 'library',
    genomeId: genome.genomeId || null, irId: ir.irId || null, verificationContractId: contract?.contractId || null,
    implementation: {
      form: 'library', artifact: { file: `library/${artifactName}`, sha256: artifactSha, bytes: artifactBytes.length, moduleSystem: artifactSpec.moduleSystem || null, exportName: artifactSpec.exportName || null, packageName: artifactSpec.packageName || null, packageVersion: artifactSpec.packageVersion || null },
      operations: (model.operations || []).map((o) => ({ id: o.id, name: o.name, role: o.role, inputs: o.inputs, output: o.output })),
      configuration: model.configuration || null,
      runtime: (manifest.dependencies?.runtime || []).map((r) => `${r.name} ${r.range}`).join(', ') || null,
    },
    source: { project: manifest.identity.sourceProject, remote, revision, manifestVersion: manifest.identity.manifestVersion, harvestMethod: manifest.provenance?.method || null, aiAssisted: manifest.provenance?.aiAssisted === true },
    verification: { source: sourceVerification, transplantEvidence: [], destinationIntegration: 'not-yet-proven', universalCompatibility: 'not-claimed' },
    configuration: [],
    dependencies: { runtime: dependencies.runtime, packages: [], externalServices: [] },
    assumptions: { statedBySource: (manifest.security?.assumptions || []).map((a) => a.text) },
    licence: { state: licence.state, declared: licence.declared, files: licence.files.map((f) => ({ name: f.name, sha256: f.sha256 })), warning: licence.warning },
    generator: { name: 'graft', version: graftVersion || null, exportSchema: PACKAGE_SCHEMA_VERSION },
  };
  const files = {};
  files[`${slug}/library/${artifactName}`] = artifactBytes;
  files[`${slug}/graft-capability.json`] = canonical(capabilityManifest);
  files[`${slug}/dependencies.json`] = canonical(dependencies);
  files[`${slug}/verification-contract.json`] = canonical({ contract: contract || null, verification: capabilityManifest.verification, acceptanceTests: (manifest.acceptanceTests?.tests || []).map((t) => ({ id: t.id, kind: t.kind, required: t.required, proves: t.provesBehavior, description: t.description || null })) });
  files[`${slug}/provenance.json`] = canonical({
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    sourceProject: { name: manifest.identity.sourceProject, version: manifest.provenance?.sourceProject?.version || null, remote, revision },
    implementationForm: 'library',
    artifact: { file: `library/${artifactName}`, originalPath: artifactSpec.entry, sha256: artifactSha, copiedVerbatim: true, note: 'This file is the library’s own published artifact, copied unchanged. GRAFT did not author or modify it.' },
    harvest: { manifestVersion: manifest.identity.manifestVersion, method: manifest.provenance?.method || null, generator: manifest.provenance?.generator || null, harvestedAt: manifest.provenance?.harvestedAt || null },
    ids: { capabilityId: genome.identity.capabilityId, genomeId: genome.genomeId || null, irId: ir.irId || null, verificationContractId: contract?.contractId || null },
    evidence: { detectorSignals: (manifest.provenance?.detectorSignals || []).map((s) => ({ id: s.id, evidence: stripRoot(s.evidence, roots) })) },
    licence: { state: licence.state, declared: licence.declared, files: licence.files.map((f) => ({ name: f.name, sha256: f.sha256, includedAs: `LICENSES/${f.name}` })), warning: licence.warning },
    graft: { version: graftVersion || null },
    note: 'The implementation in this package belongs to the upstream project named above and is redistributed under its own licence. GRAFT verified its behaviour; it did not write it.',
  });
  for (const f of licence.files) files[`${slug}/LICENSES/${f.name}`] = f.text;
  files[`${slug}/GRAFT.md`] = libraryDocument({ slug, manifest, capabilityManifest, dependencies, artifactName, licence, remote, revision, sourceVerification });
  assertPrivate(files, privateTerms(roots));
  const ordered = Object.keys(files).sort();
  const packageHash = sha256(Buffer.concat(ordered.flatMap((p) => [Buffer.from(`${p}\n`), Buffer.from(files[p]), Buffer.from('\n')])));
  return { name: slug, files, fileList: ordered, packageHash, manifest: capabilityManifest, licence: { state: licence.state, declared: licence.declared, warning: licence.warning }, implementationForm: 'library',
    verification: { source: sourceVerification || { verdict: 'NEEDS_REVIEW' }, transplantEvidence: [], destinationIntegration: 'not-yet-proven' } };
}

/** The human-readable document for a library package: what it is, what was proved, what was not. */
function libraryDocument({ slug, manifest, capabilityManifest, dependencies, artifactName, licence, remote, revision, sourceVerification }) {
  const a = capabilityManifest.implementation.artifact;
  const operations = capabilityManifest.implementation.operations;
  return `# ${manifest.identity.name} — ${slug}

**This capability is implemented by an external library.** GRAFT did not write it, and does not
own it. The file in \`library/${artifactName}\` is the library's own published artifact, copied
unchanged from its source project.

- Upstream: ${remote || manifest.identity.sourceProject}${revision ? ` @ ${revision}` : ''}
- Package: ${a.packageName || manifest.identity.sourceProject}${a.packageVersion ? `@${a.packageVersion}` : ''}
- Licence: ${licence.declared || licence.state}${licence.warning ? ` — ${licence.warning}` : ''}
- Module form: ${a.moduleSystem}${a.exportName ? `, exported as \`${a.exportName}\`` : ''}
- Runtime: ${capabilityManifest.implementation.runtime || 'not stated'}

## What GRAFT verified

GRAFT loaded this exact artifact and exercised its public operations against a verification
contract built from the behaviour it actually shows:

${(manifest.acceptanceTests?.tests || []).map((t) => `- ${t.description || t.id}`).join('\n')}

Source behaviour: **${sourceVerification?.verdict || 'not verified'}**${sourceVerification?.summary ? ` (${sourceVerification.summary.passed}/${sourceVerification.summary.required} required cases)` : ''}.

That is a statement about this library, observed by running it. It is not a statement about your
application.

## What GRAFT has NOT proved

- **Destination integration is not yet proven.** GRAFT has no host adaptation for library-form
  capabilities, so it cannot yet wire this library into an application for you, and it does not
  claim the result would work if it did.
- **Universal compatibility is not claimed.** Nothing here says this library suits every project.
- Using it in your own application may require handling the dependency yourself, and any wiring
  between the library and your code is yours to write and to review.

## Using it

The operations this capability exposes:

${operations.map((o) => `- \`${o.name}(${(o.inputs || []).map((i) => i.name).join(', ')})\` — ${o.output?.meaning || o.role}`).join('\n')}

Configuration is supplied by the caller${capabilityManifest.implementation.configuration?.shape ? ` as a ${capabilityManifest.implementation.configuration.shape}` : ''}; the library reads no
environment variable of its own and stores nothing.

${dependencies.destinationIntegration.note}
`;
}

function integrationDocument({ slug, manifest, kind, host, profileId, exportedFiles, configuration, dependencies, sourceVerification, transplantEvidence, licence, registration, graftVersion }) {
  const model = manifest.architecture?.capabilityModel || {};
  const arch = manifest.provenance?.capabilitySource?.architecture || {};
  const lines = [];
  const h = (t) => lines.push('', `## ${t}`, '');
  lines.push(`# ${manifest.identity.name}`, '', `Capability package \`${slug}\` exported by GRAFT${graftVersion ? ` ${graftVersion}` : ''}.`);
  h('Capability'); lines.push(`${manifest.identity.category} (${kind})`);
  h('Harvest source'); lines.push(`Project: ${manifest.identity.sourceProject}`, `Source architecture: ${[arch.runtime?.family, arch.moduleSystem, arch.framework, arch.handlerContract].filter(Boolean).join(' / ') || 'unknown'}`);
  h('Verification'); lines.push(`Source capability verification: ${sourceVerification.verdict}${sourceVerification.summary ? ` (${sourceVerification.summary.passed}/${sourceVerification.summary.required} required acceptance tests)` : ''}.`);
  if (transplantEvidence.length) { lines.push('', 'Known transplant evidence recorded by GRAFT on this machine:'); for (const e of transplantEvidence) lines.push(`- ${e.destination}: ${e.verified} VERIFIED${e.failed ? `, ${e.failed} FAILED` : ''}${e.other ? `, ${e.other} inconclusive` : ''}`); }
  lines.push('', 'Universal compatibility: NOT CLAIMED. This implementation was regenerated for the', `\`${profileId}\` host profile (${host.moduleSystem.value} / ${host.constraints.handlerContract.value}${host.framework.value ? ` / ${host.framework.value}` : ''}).`, 'Adaptation may be required for other application architectures.');
  h('Implementation architecture'); lines.push(`Node / ${host.moduleSystem.value} / ${kind}${model.credentialAuthority ? ` / credential authority: ${model.credentialAuthority.kind}${model.provider?.provider ? ` (${model.provider.provider})` : ''}` : ''}${model.session ? ` / sessions: ${model.session.transport} transport, ${model.session.custody} custody, ${model.session.store} store${model.session.durableAcrossRestart === false ? ', not durable across restart' : ''}` : ''}`);
  h('What this package provides'); for (const f of exportedFiles) lines.push(`- \`${f}\``); lines.push('', ...((manifest.behavior?.statements || []).map((s) => `- ${s.text || s}`)));
  h('Required dependencies'); lines.push(...(dependencies.runtime.map((r) => `- ${r.name} ${r.range || ''}${r.reason ? ` — ${r.reason}` : ''}`)), ...(dependencies.packages.length ? dependencies.packages.map((p) => `- package ${p.name}${p.range ? ` ${p.range}` : ''}`) : ['- no packages']), ...(dependencies.externalServices.map((s) => `- external service: ${s.name} (${s.role})${s.verifiedWith ? ` — verified against a ${s.verifiedWith}` : ''}`)));
  h('Required configuration names'); lines.push(...(configuration.length ? configuration.map((c) => `- \`${c.name}\` (${c.required ? 'required' : 'optional'})${c.purpose ? ` — ${c.purpose}` : ''}`) : ['- none']), '', 'See `configuration.example`. Values are never part of this package.');
  h('Important assumptions'); lines.push(...((manifest.security?.assumptions || []).map((a) => `- ${a.text || a.id}`)), ...(model.session?.durableAcrossRestart === false ? ['- Sessions live in process memory and do not survive a restart (fail closed).'] : []));
  h('Known portability constraints'); lines.push(`- Written for the \`${profileId}\` profile: ${host.moduleSystem.value} modules, the ${host.constraints.handlerContract.value} handler contract.`, ...(registration.provenHosts.length > 1 ? [`- GRAFT can also register this capability on: ${registration.provenHosts.filter((p) => p !== profileId).join(', ')}.`] : []), '- Other frameworks and runtimes are not covered by this package.');
  h('Verification performed by GRAFT'); lines.push(`- Source: ${sourceVerification.verdict}${sourceVerification.method ? ` — ${sourceVerification.method}` : ''}.`, '- The acceptance tests and invariants are in `verification-contract.json`; they describe observable HTTP behaviour and can be re-run by GRAFT against any application that hosts this implementation.', '- Exporting is packaging only. It does not verify anything and is not a compatibility claim.');
  h('How to integrate manually'); lines.push(`1. Copy \`src/\` into your project (default location: \`${manifest.architecture?.capabilityModel ? 'src/auth' : 'src'}\`).`, `2. Provide the configuration names above in your environment.`, registration.name ? `3. Import \`${registration.name}\` from \`src/routes.js\`${registration.style === 'guard' ? ', create it once (`const auth = ' + registration.name + '({ env: process.env })`), and give it first refusal on every request: in a central node:http handler `if (await auth.handle(req, res)) return;`, or on Express `app.use(async (req, res, next) => { if (await auth.handle(req, res)) return; next(); })` before your routes.' : ' and call it with your application/router.'}` : '3. Register the routes with your application.', '4. Run the acceptance tests in `verification-contract.json` (or let GRAFT do it: Add to a project).');
  h('Licence'); lines.push(licence.state === 'not-detected' ? `⚠ ${licence.warning}` : licence.state === 'private-unspecified' ? `⚠ ${licence.warning}` : `Detected: ${licence.declared || licence.files.map((f) => f.firstLine).join('; ')}${licence.files.length ? ` — text preserved under LICENSES/.` : ''}`, '', 'GRAFT preserves licence metadata; it does not decide what you may do with the code.');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// ZIP: minimal, deterministic (stored entries, fixed timestamps, sorted paths).
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buffer) { let c = 0xffffffff; for (const b of buffer) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function zipBuffer(files) {
  const entries = Object.keys(files).sort();
  const locals = []; const centrals = []; let offset = 0;
  const dosTime = 0; const dosDate = (1 << 5) | 1; // 1980-01-01 00:00:00, fixed on purpose
  for (const name of entries) {
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw fail('unsafe-entry', `Refusing to write archive entry ${name}.`);
    const data = Buffer.isBuffer(files[name]) ? files[name] : Buffer.from(String(files[name]), 'utf8');
    const nameBytes = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}
/** Entries of a ZIP produced by zipBuffer (or any single-disk, stored, non-zip64 archive): name → bytes. */
export function readZip(buffer) {
  const out = {};
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(eocd + 10); let p = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(p + 10); const size = buffer.readUInt32LE(p + 24); const nameLength = buffer.readUInt16LE(p + 28); const extra = buffer.readUInt16LE(p + 30); const comment = buffer.readUInt16LE(p + 32); const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (method !== 0) throw new Error(`unsupported compression for ${name}`);
    const ln = buffer.readUInt16LE(localOffset + 26); const le = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + ln + le;
    out[name] = buffer.subarray(start, start + size);
    p += 46 + nameLength + extra + comment;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writing the archive: a security-sensitive filesystem operation.
// ---------------------------------------------------------------------------------------------
export const receiptsPath = () => path.join(graftHome(), 'exports', 'receipts.json');
export const defaultExportDir = () => path.join(graftHome(), 'exports');
export function loadExportReceipts({ file = receiptsPath() } = {}) {
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); return parsed?.version === 1 && Array.isArray(parsed.receipts) ? parsed : { version: 1, receipts: [] }; } catch { return { version: 1, receipts: [] }; }
}
function saveExportReceipt(receipt, { file = receiptsPath() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const registry = loadExportReceipts({ file }); registry.receipts.push(receipt);
  const temporary = path.join(path.dirname(file), `.receipts-${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file);
}
/** A deterministic alternate filename beside an existing one: name-2.zip, name-3.zip, … */
export function alternateDestination(destination) {
  const dir = path.dirname(destination); const base = path.basename(destination, '.zip');
  for (let n = 2; n < 1000; n += 1) { const candidate = path.join(dir, `${base}-${n}.zip`); if (!fs.existsSync(candidate)) return candidate; }
  throw fail('destination-exhausted', 'Too many packages with that name already exist there.');
}

/**
 * Write the package as a ZIP at `destination` (an absolute .zip path in an existing directory).
 * Refuses a path inside the harvested source checkout or inside the organ bank, a symlinked
 * parent, and an existing file unless `overwrite` or `alternate` is set. The archive is written
 * to a temporary file beside the destination and renamed into place; nothing else is touched.
 */
export function exportCapabilityPackage({ organDir, destination, graftVersion, profile = null, overwrite = false, alternate = false, atlasDirectory = null, receiptsFile = receiptsPath(), now = () => new Date().toISOString() }) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) throw fail('invalid-destination', 'Choose an absolute .zip file path.');
  if (path.extname(destination).toLowerCase() !== '.zip') throw fail('invalid-destination', 'The package is a .zip file.');
  const dir = path.dirname(destination);
  let realDir; try { realDir = fs.realpathSync(dir); } catch { throw fail('destination-missing', 'The folder to save into does not exist.'); }
  if (!fs.statSync(realDir).isDirectory()) throw fail('invalid-destination', 'The destination parent is not a folder.');
  if (fs.lstatSync(dir).isSymbolicLink()) throw fail('destination-symlink', 'GRAFT does not save through a symlinked folder.');
  const built = buildCapabilityPackage({ organDir, graftVersion, profile, atlasDirectory });
  const manifest = readManifest(organDir);
  // Never into the harvested checkout, never into the organ bank (the organ or the bank folder
  // itself). GRAFT's own exports folder beneath GRAFT_HOME is the browser dashboard's default
  // and stays allowed on purpose.
  const forbidden = [manifest.identity.sourceProjectRoot, path.resolve(organDir), path.join(graftHome(), 'organ-bank')].filter(Boolean).map((p) => { try { return fs.realpathSync(p); } catch { return null; } }).filter(Boolean);
  for (const root of forbidden) if (realDir === root || realDir.startsWith(root + path.sep)) throw fail('destination-inside-source', 'Save the package outside the harvested project and outside GRAFT\'s organ bank.');
  let target = path.join(realDir, path.basename(destination));
  const present = (() => { try { fs.lstatSync(target); return true; } catch { return false; } })();
  if (present) {
    if (alternate) target = alternateDestination(target);
    else if (!overwrite) throw fail('destination-exists', `${path.basename(target)} already exists there.`, 'Choose another name, or confirm replacing it.');
    else if (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile()) throw fail('destination-not-a-file', 'The existing destination is not a regular file and will not be replaced.');
  }
  const archive = zipBuffer(built.files);
  const temporary = path.join(realDir, `.${path.basename(target, '.zip')}-${crypto.randomUUID()}.part`);
  try {
    fs.writeFileSync(temporary, archive, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
  const receipt = {
    receiptVersion: RECEIPT_VERSION, kind: 'CapabilityExportReceipt', createdAt: now(),
    capabilityId: built.capabilityId, artifactId: built.artifactId, capability: built.name, profile: built.profile,
    packageHash: built.packageHash, archiveSha256: sha256(archive), exportedFileCount: built.fileList.length, files: built.fileList,
    destination: target, sourceProject: built.sourceProject, sourceRevision: built.revision,
    verification: { source: built.verification.source.verdict, transplantEvidence: built.verification.transplantEvidence, universalCompatibility: 'not-claimed' },
    licence: built.licence, configurationNames: built.configurationNames, graftVersion: graftVersion || null,
  };
  saveExportReceipt(receipt, { file: receiptsFile });
  return { receipt, package: { name: built.name, files: built.fileList, packageHash: built.packageHash, manifest: built.manifest } };
}
