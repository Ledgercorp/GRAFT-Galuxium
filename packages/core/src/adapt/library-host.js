// Host adaptation for capabilities in LIBRARY form.
//
// The emitters write a service-shaped implementation from a service IR. A verified library is a
// different thing: it is somebody else's published artifact, and the honest way to put it into a
// destination is to carry that artifact across unchanged and write a small adapter beside it. That
// is all this module does.
//
// Three separations are deliberate and load-bearing:
//
//   1. The SOURCE representation is never touched. The harvested capability stays a library, with
//      no endpoints and no HTTP interfaces. Adaptation is a destination-side transformation.
//   2. Adaptation NEVER decides whether the capability works. It produces a deterministic write
//      plan; `decideVerdict` (through the existing library runner) remains the only authority on
//      VERIFIED. `adaptationStatus: 'completed'` means files were written, nothing more.
//   3. Support is STRUCTURAL. It derives from the capability's kind, implementation form, declared
//      operation roles, configuration shape and artifact module system, and from the destination's
//      profile — never from a package name, repository or revision.
//
// It installs nothing, builds nothing, runs no package lifecycle script and opens no socket.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { detectLicense, recordedSourceIdentity } from '../export/index.js';

export const ADAPTATION_SCHEMA_VERSION = '1.0.0';
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * The adaptation shapes GRAFT has actually proven, as data.
 *
 * Deliberately narrow. This is not "any JavaScript library into any host": it is one capability
 * kind, in library form, whose artifact is a CommonJS/UMD file, into one destination profile. A
 * new shape is a new entry with its own evidence, not a loosened predicate here.
 */
export const LIBRARY_HOST_ADAPTATIONS = Object.freeze([Object.freeze({
  id: 'feature-flags-library-into-esm-node-http-central',
  kind: 'feature-flags',
  implementationForm: 'library',
  host: Object.freeze({ profile: 'esm-node-http-central', moduleSystem: 'esm', runtime: 'node' }),
  // Probed empirically on Node >=20: a CommonJS/UMD artifact is loadable from an ESM host only as
  // a `.cjs` file through a default import. See `INTEROP` below.
  artifactModuleSystems: Object.freeze(['commonjs']),
  // Required by ROLE, as the capability model declares them — not by method name.
  operationRoles: Object.freeze(['select-value', 'invoke-branch']),
  configuration: Object.freeze({ shape: 'feature-map', contextShape: 'bucket-index', unknownFeature: 'disabled-outcome' }),
  method: 'vendored-commonjs-artifact-with-generated-esm-adapter',
  vendorDir: 'vendor',
  adapterModule: 'src/feature-flags.js',
})]);

/**
 * What the Node runtime actually does, recorded from measurement rather than assumption.
 *
 * A UMD artifact inside an ESM package is the trap here: Node parses it as ESM, the UMD wrapper
 * falls through to its browser-global branch, and the import SUCCEEDS while exporting nothing and
 * quietly assigning a global. Anything built on that would look like it worked.
 */
export const INTEROP = Object.freeze({
  probedOn: 'node >=20 (measured on v22.14.0)',
  chosen: 'byte-identical .cjs copy + static ESM default import',
  mechanisms: Object.freeze([
    Object.freeze({ id: 'esm-import-dot-js', what: 'ESM import() of the artifact as .js inside a "type":"module" package', works: false,
      observed: 'resolved without error, exported nothing (namespace had no keys) and assigned globalThis.Swivel as a side effect', rejected: 'silently exports nothing and pollutes the host global; a capability appearing to work through a global is a false success' }),
    Object.freeze({ id: 'create-require-dot-js', what: 'createRequire() of the artifact as .js inside a "type":"module" package', works: false,
      observed: 'require() resolved the file as ESM and returned an empty namespace, so the export was not constructible', rejected: 'the package type makes .js an ES module; require cannot reach the CommonJS export' }),
    Object.freeze({ id: 'esm-import-dot-cjs', what: 'ESM import() of a byte-identical .cjs copy', works: true,
      observed: 'namespace.default is the library export; behaviour correct; no global assigned', rejected: null }),
    Object.freeze({ id: 'create-require-dot-cjs', what: 'createRequire() of a byte-identical .cjs copy', works: true,
      observed: 'returns the library export directly; behaviour correct', rejected: 'works, but needs createRequire plumbing in generated code and is not statically analysable; the static default import is smaller' }),
    Object.freeze({ id: 'esm-named-import-dot-cjs', what: 'static NAMED import of the export from the .cjs copy', works: false,
      observed: "SyntaxError: Named export 'Swivel' not found", rejected: 'the UMD assigns its export dynamically, so the CommonJS lexer cannot see a named export; the default import is the supported form' }),
  ]),
});

/**
 * The destination shapes a library-form capability of this kind can be adapted into.
 *
 * Host-independent, so a capability can be described honestly before a host is chosen: empty means
 * no destination integration exists yet, and a non-empty list names exactly what has been proven.
 */
export function libraryAdaptationTargets({ kind, implementationForm = 'library' } = {}) {
  return LIBRARY_HOST_ADAPTATIONS
    .filter((a) => a.kind === kind && a.implementationForm === implementationForm)
    .map((a) => ({ adaptation: a.id, profile: a.host.profile, runtime: a.host.runtime, moduleSystem: a.host.moduleSystem, method: a.method }));
}

/** One plain sentence about where a library-form capability can go, for a person to read. */
export function describeLibraryIntegration({ kind, implementationForm = 'library' } = {}) {
  const targets = libraryAdaptationTargets({ kind, implementationForm });
  if (!targets.length) return { supported: false, targets, reason: `GRAFT has no destination integration for ${kind || 'this kind'} in library form yet` };
  return { supported: true, targets,
    reason: `GRAFT can add this to a ${targets.map((t) => `${t.runtime} / ${t.moduleSystem} ${t.profile}`).join(' or ')} application, by carrying the verified artifact across unchanged and generating an adapter; other destination shapes are not proven yet` };
}

/** The artifact the capability declared, and the identity harvest recorded for it. */
export function libraryArtifactOf(manifest) {
  const model = manifest?.architecture?.capabilityModel;
  const artifact = model?.artifact;
  if (!artifact?.entry) throw fail('no-library-artifact', 'The capability does not declare a library artifact to adapt.');
  const recorded = (manifest.sourceMap?.files || []).find((f) => f.role === 'library-artifact' && f.file === artifact.entry) || null;
  return { entry: artifact.entry, moduleSystem: artifact.moduleSystem || null, exportName: artifact.exportName || null,
    packageName: artifact.packageName || null, packageVersion: artifact.packageVersion || null, committed: artifact.committed === true,
    recordedSha256: recorded?.sha256 ?? null };
}

/**
 * Does a proven adaptation shape cover this capability and this destination?
 *
 * Returns every check with its detail so a refusal can say which structural fact was missing.
 * Nothing here reads a package name, repository or revision.
 */
export function libraryHostAdaptationSupport({ manifest, host }) {
  const checks = [];
  const check = (id, ok, detail) => (checks.push({ id, ok, detail }), ok);
  const identity = manifest?.identity || {};
  const model = manifest?.architecture?.capabilityModel || {};
  const kind = identity.category || model.kind || null;
  const form = identity.implementationForm || model.implementationForm || null;

  let artifact = null;
  try { artifact = libraryArtifactOf(manifest); } catch { /* reported by the artifact check below */ }

  const candidates = LIBRARY_HOST_ADAPTATIONS.filter((a) => a.kind === kind && a.implementationForm === form);
  check('capability-kind', candidates.length > 0, candidates.length ? `${kind} in ${form} form has a proven adaptation` : `no proven host adaptation for ${kind || 'an unknown kind'} in ${form || 'an unknown'} form`);
  // A host that has not been chosen yet is unknown, not wrong: the capability-side facts are still
  // worth reporting so a planner can show what this capability needs before a host exists.
  const hostChosen = host !== null && host !== undefined;
  const spec = candidates.find((a) => a.host.profile === host?.profile) || null;
  check('host-profile', hostChosen ? Boolean(spec) : null, !hostChosen ? 'no host chosen yet' : spec ? `the ${host.profile} host has a proven adaptation for this capability` : `no proven adaptation writes ${kind || 'this capability'} in ${form || 'this'} form into ${host?.profile ? `the ${host.profile} host` : 'the chosen host'}`);
  // Evaluate the capability against the one shape it could use, so the remaining checks are real.
  const against = spec || (!hostChosen && candidates.length === 1 ? candidates[0] : null);
  if (!against) return { supported: false, checks, adaptation: null, kind, implementationForm: form, artifact };

  check('host-module-system', hostChosen ? host.moduleSystem === against.host.moduleSystem : null, hostChosen ? `destination module system ${host.moduleSystem || 'unknown'} (adaptation needs ${against.host.moduleSystem})` : `a destination must be ${against.host.moduleSystem}`);
  // No fake service shape: a library adaptation refuses a capability that declares HTTP surface.
  const endpoints = model.endpoints || [];
  const inbound = manifest?.interfaces?.inbound || [];
  check('library-shaped', endpoints.length === 0 && inbound.length === 0, endpoints.length || inbound.length ? `the capability declares ${endpoints.length} endpoint(s) and ${inbound.length} inbound interface(s); that is a service, not a library` : 'the capability declares no endpoints and no inbound interfaces');
  check('artifact-declared', Boolean(artifact?.entry), artifact?.entry ? `artifact ${artifact.entry}` : 'the capability declares no library artifact');
  check('artifact-module-system', Boolean(artifact) && against.artifactModuleSystems.includes(artifact.moduleSystem), artifact ? `artifact module system ${artifact.moduleSystem || 'unknown'} (adaptation handles ${against.artifactModuleSystems.join(', ')})` : 'no artifact');
  check('artifact-committed', artifact?.committed === true, artifact?.committed ? 'the artifact is committed in the source, so it can be carried across unchanged' : 'the artifact is not committed in the source; GRAFT will not build or fetch one');
  check('artifact-identity-recorded', Boolean(artifact?.recordedSha256), artifact?.recordedSha256 ? `harvest recorded the artifact identity (${artifact.recordedSha256})` : 'harvest recorded no identity for the artifact, so it cannot be proven unchanged');
  const roles = new Set((model.operations || []).map((o) => o.role));
  const missingRoles = against.operationRoles.filter((r) => !roles.has(r));
  check('verified-operations', missingRoles.length === 0, missingRoles.length ? `the capability does not declare the operation role(s) the adapter needs: ${missingRoles.join(', ')}` : `operation roles present: ${against.operationRoles.join(', ')}`);
  const config = model.configuration || {};
  const configMismatch = Object.entries(against.configuration).filter(([k, v]) => config[k] !== v);
  check('configuration-shape', configMismatch.length === 0, configMismatch.length ? `configuration shape differs from the proven one: ${configMismatch.map(([k, v]) => `${k} is ${JSON.stringify(config[k])}, adaptation proved ${JSON.stringify(v)}`).join('; ')}` : `configuration ${against.configuration.shape} / ${against.configuration.contextShape}`);

  // Supported means every check actually passed: an unknown host is not a pass.
  return { supported: checks.every((c) => c.ok === true), checks, adaptation: spec?.id || null, spec, kind, implementationForm: form, artifact,
    // Capability-side readiness, independent of any host: what a planner shows before a host exists.
    capabilityReady: checks.filter((c) => !c.id.startsWith('host-')).every((c) => c.ok === true) };
}

/**
 * Is the artifact on disk the one GRAFT verified?
 *
 * Compared against the identity harvest recorded, at whatever width it recorded (harvest keeps a
 * truncated digest; the full digest is returned too and travels into the destination provenance).
 */
export function checkArtifactIdentity({ manifest, sourceRoot }) {
  const artifact = libraryArtifactOf(manifest);
  const abs = path.resolve(sourceRoot, artifact.entry);
  const root = path.resolve(sourceRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { matched: false, reason: 'artifact-outside-source', detail: `${artifact.entry} resolves outside the source project`, expected: artifact.recordedSha256, actual: null, artifact };
  let bytes;
  try { bytes = fs.readFileSync(abs); }
  catch { return { matched: false, reason: 'artifact-missing', detail: `${artifact.entry} is not present in the source`, expected: artifact.recordedSha256, actual: null, artifact }; }
  const full = sha256(bytes);
  const expected = artifact.recordedSha256;
  if (!expected) return { matched: false, reason: 'no-recorded-identity', detail: `harvest recorded no identity for ${artifact.entry}`, expected: null, actual: full, bytes, artifact };
  const actual = expected.length < full.length ? full.slice(0, expected.length) : full;
  if (actual !== expected) return { matched: false, reason: 'artifact-identity-mismatch', detail: `${artifact.entry} is not the artifact GRAFT verified: expected ${expected}, found ${actual}`, expected, actual, actualFull: full, bytes, artifact };
  return { matched: true, reason: null, detail: `${artifact.entry} is byte-for-byte the artifact GRAFT verified (${expected})`, expected, actual, actualFull: full, bytes, artifact };
}

// ---------------------------------------------------------------------------------------------
// The generated adapter.
// ---------------------------------------------------------------------------------------------
function adapterSource({ importPath, exportName, artifactFile, artifactSha256, licenceFile, provenanceFile, spec, source }) {
  return `// Feature flags for this application, adapted by GRAFT from a verified library capability.
//
// The implementation is the library's own published artifact, vendored unchanged at
// ${artifactFile}. GRAFT wrote only this adapter: it gives the application a small, stable
// interface and forwards every decision to that library. GRAFT did not author, modify, transpile,
// bundle or rebuild the vendored artifact${licenceFile ? `; its licence is kept at ${licenceFile}` : ''}.
//
//   upstream    ${source.repository || 'unknown'}
//   revision    ${source.revision || 'unknown'}
//   package     ${source.package || 'unknown'}
//   licence     ${source.licence || 'see the provenance record'}
//   artifact    sha256:${artifactSha256}
//   provenance  ${provenanceFile}
//
// The artifact is CommonJS, so it is vendored with a .cjs extension: this package is an ES module
// package, where a .js file would be parsed as ESM and the artifact's own wrapper would then
// export nothing. The bytes are unchanged — only the file name differs.
import libraryExport from '${importPath}';

// A CommonJS artifact reaches an ES module through its default export. Some builds expose the
// library under a named property instead, so both shapes are accepted — and nothing else is.
const EXPORT_NAME = ${JSON.stringify(exportName)};
const Library = typeof libraryExport === 'function' ? libraryExport
  : EXPORT_NAME && libraryExport && typeof libraryExport[EXPORT_NAME] === 'function' ? libraryExport[EXPORT_NAME]
  : null;
if (Library === null) throw new TypeError('The vendored feature-flag library did not expose a usable export.');

/**
 * Feature evaluation for this application.
 *
 * The application owns the configuration: a map of feature name to the contexts it is enabled
 * for, and the one context this instance evaluates against. Nothing is read from the environment,
 * nothing is stored, and no network call is made.
 *
 *   const flags = new FeatureFlags({ map: { checkout: [1, 2] }, bucketIndex: 1 });
 *   if (flags.isEnabled('checkout')) { ... }
 */
export default class FeatureFlags {
  #library;

  constructor(configuration = {}) {
    this.#library = new Library({ map: configuration.map ?? {}, bucketIndex: configuration.bucketIndex ?? 0 });
  }

  /** Is \`featureName\` on for this instance's context? A feature that is not configured is off. */
  isEnabled(featureName) {
    return this.#library.returnValue(featureName, true, false) === true;
  }

  /** \`enabledValue\` when \`featureName\` is on, \`disabledValue\` when it is off. */
  choose(featureName, enabledValue, disabledValue) {
    return this.#library.returnValue(featureName, enabledValue, disabledValue);
  }

  /** Call \`onEnabled\` when \`featureName\` is on, otherwise call \`onDisabled\`. */
  branch(featureName, onEnabled, onDisabled) {
    return this.#library.invoke(featureName, onEnabled, onDisabled);
  }
}
`;
}

/** How each adapter operation maps to the library operation the source proved. */
function operationMapping(model) {
  const byRole = new Map((model.operations || []).map((o) => [o.role, o]));
  const select = byRole.get('select-value'), invoke = byRole.get('invoke-branch');
  return [
    { adapterOperation: 'isEnabled(featureName)', sourceOperation: select?.id || null, sourceCall: select?.name || null,
      normalised: true, translation: `${select?.name}(featureName, true, false) === true`,
      justification: 'the library selects between two values; asking it for true/false is a predicate, and the translation is total and deterministic',
      provenBy: ['destination.flags.enabled', 'destination.flags.disabled-for-other-context', 'destination.flags.empty-mask-is-off', 'destination.flags.unknown-takes-fallback', 'destination.flags.parent-gates-child'] },
    { adapterOperation: 'choose(featureName, enabledValue, disabledValue)', sourceOperation: select?.id || null, sourceCall: select?.name || null,
      normalised: false, translation: `${select?.name}(featureName, enabledValue, disabledValue)`, justification: 'the same operation under a plainer name; arguments and result are passed through unchanged',
      provenBy: ['destination.flags.choose-enabled', 'destination.flags.choose-disabled'] },
    { adapterOperation: 'branch(featureName, onEnabled, onDisabled)', sourceOperation: invoke?.id || null, sourceCall: invoke?.name || null,
      normalised: false, translation: `${invoke?.name}(featureName, onEnabled, onDisabled)`, justification: 'the same operation under a plainer name; the callbacks are passed through unchanged',
      provenBy: ['destination.flags.branch-enabled', 'destination.flags.branch-disabled'] },
  ];
}

/**
 * The destination verification contract: the adapter's own behaviour, in the destination.
 *
 * Every case exercises the generated adapter (which in turn runs the vendored artifact), and
 * every case covers a semantic the adapter genuinely exposes. The configuration is the same
 * deterministic probe the source contract used, so the two proofs are comparable.
 */
export function destinationVerificationContract(manifest) {
  const probe = { map: { Graft: [1, 2], 'Graft.enabled': [1], 'Graft.off': [], Parent: [1], 'Parent.child': [1] }, enabled: 1, other: 2 };
  const on = { options: { map: probe.map, bucketIndex: probe.enabled } };
  const off = { options: { map: probe.map, bucketIndex: probe.other } };
  return [
    { id: 'destination.flags.enabled', kind: 'library', required: true, provesBehavior: 'flags.evaluate', description: 'In the destination, a feature whose mask includes the caller’s context reads as on.',
      construct: on, steps: [{ name: 'enabled', call: 'isEnabled', args: ['Graft.enabled'], expect: { equals: true } }] },
    { id: 'destination.flags.disabled-for-other-context', kind: 'library', required: true, provesBehavior: 'flags.evaluate', description: 'The same feature reads as off for a context its mask does not include.',
      construct: off, steps: [{ name: 'disabled', call: 'isEnabled', args: ['Graft.enabled'], expect: { equals: false } }] },
    { id: 'destination.flags.empty-mask-is-off', kind: 'library', required: true, provesBehavior: 'flags.disabled', description: 'A feature configured with an empty mask reads as off.',
      construct: on, steps: [{ name: 'off', call: 'isEnabled', args: ['Graft.off'], expect: { equals: false } }] },
    { id: 'destination.flags.unknown-takes-fallback', kind: 'library', required: true, provesBehavior: 'flags.unknown', description: 'An unconfigured feature reads as off rather than failing.',
      construct: on, steps: [{ name: 'unknown', call: 'isEnabled', args: ['Graft.not-configured'], expect: { equals: false } }] },
    { id: 'destination.flags.parent-gates-child', kind: 'library', required: true, provesBehavior: 'flags.hierarchy', description: 'A nested feature reads as off when its parent is off for that context.',
      construct: off, steps: [{ name: 'child', call: 'isEnabled', args: ['Parent.child'], expect: { equals: false } }] },
    { id: 'destination.flags.choose-enabled', kind: 'library', required: true, provesBehavior: 'flags.branch', description: 'Handed two values, the adapter returns the enabled one for an enabled feature.',
      construct: on, steps: [{ name: 'chosen', call: 'choose', args: ['Graft.enabled', 'on', 'off'], expect: { equals: 'on' } }] },
    { id: 'destination.flags.choose-disabled', kind: 'library', required: true, provesBehavior: 'flags.branch', description: 'It returns the disabled value for a feature that is off.',
      construct: off, steps: [{ name: 'chosen', call: 'choose', args: ['Graft.enabled', 'on', 'off'], expect: { equals: 'off' } }] },
    { id: 'destination.flags.branch-enabled', kind: 'library', required: true, provesBehavior: 'flags.branch', description: 'Handed two callbacks, the adapter calls the enabled one for an enabled feature.',
      construct: on, steps: [{ name: 'enabled-branch', call: 'branch', args: ['Graft.enabled', { $callback: 'enabled' }, { $callback: 'disabled' }], expect: { branch: 'enabled' } }] },
    { id: 'destination.flags.branch-disabled', kind: 'library', required: true, provesBehavior: 'flags.branch', description: 'It calls the disabled callback for a feature that is off.',
      construct: off, steps: [{ name: 'disabled-branch', call: 'branch', args: ['Graft.enabled', { $callback: 'enabled' }, { $callback: 'disabled' }], expect: { branch: 'disabled' } }] },
    { id: 'destination.flags.deterministic', kind: 'library', required: true, provesBehavior: 'flags.deterministic', description: 'Repeating an evaluation in the destination gives the same answer.',
      construct: on, steps: [{ name: 'first', call: 'isEnabled', args: ['Graft.enabled'], expect: { equals: true } }, { name: 'second', call: 'isEnabled', args: ['Graft.enabled'], expect: { sameAs: 'first' } }] },
  ];
}

/**
 * Plan the adaptation. Writes NOTHING and decides NO verdict.
 *
 * Refuses, in this order, before any file content is produced: an unsupported structural shape,
 * then an artifact that is not the one GRAFT verified.
 */
export function adaptLibraryCapability({ manifest, sourceRoot, host, now = () => new Date().toISOString() }) {
  const support = libraryHostAdaptationSupport({ manifest, host });
  if (!support.supported) {
    const missing = support.checks.filter((c) => c.ok !== true).map((c) => c.detail);
    throw Object.assign(fail('adaptation-unsupported', `GRAFT has no proven host adaptation for this capability and this destination: ${missing.join('; ')}.`), { checks: support.checks });
  }
  const spec = support.spec;
  const identity = checkArtifactIdentity({ manifest, sourceRoot });
  if (!identity.matched) {
    throw Object.assign(fail(identity.reason, `The artifact cannot be adapted: ${identity.detail}.`, 'Re-harvest the capability from the source you intend to use, then adapt again.'),
      { expected: identity.expected, actual: identity.actual, artifact: identity.artifact });
  }

  const artifact = identity.artifact;
  // Destination packaging only: the same bytes under a .cjs name, because this package is ESM.
  const stem = path.basename(artifact.entry).replace(/\.[cm]?js$/i, '');
  const artifactFile = `${spec.vendorDir}/${stem}.cjs`;
  const licence = detectLicense(sourceRoot);
  const licenceSource = licence.files[0] || null;
  const licenceFile = licenceSource ? `${spec.vendorDir}/${stem}.LICENSE` : null;
  const provenanceFile = `${spec.vendorDir}/${stem}.provenance.json`;
  // The upstream identity is the one the harvest recorded when the artifact was verified, the same
  // identity the export package carries: the checkout may have moved since, and the identity check
  // above proves the bytes, not the revision.
  const sourceProvenance = manifest.provenance?.sourceProject || {};
  const recorded = recordedSourceIdentity(manifest, sourceRoot);
  const source = {
    repository: recorded.remote || sourceProvenance.name || null,
    revision: recorded.revision,
    package: artifact.packageName ? `${artifact.packageName}@${artifact.packageVersion || 'unknown'}` : null,
    licence: licence.declared || (licence.state === 'detected' ? 'detected' : null),
  };

  const importPath = path.posix.relative(path.posix.dirname(spec.adapterModule), artifactFile).replace(/^(?!\.)/, './');
  const adapter = adapterSource({ importPath, exportName: artifact.exportName, artifactFile, artifactSha256: identity.actualFull, licenceFile, provenanceFile, spec, source });

  const provenance = {
    note: 'This folder holds a third-party artifact, carried across unchanged by GRAFT. GRAFT did not author or modify it.',
    capability: { kind: support.kind, implementationForm: support.implementationForm },
    artifact: { file: artifactFile, originalPath: artifact.entry, sha256: `sha256:${identity.actualFull}`, bytes: identity.bytes.length, copiedVerbatim: true,
      renamed: { from: path.basename(artifact.entry), to: `${stem}.cjs`, reason: 'destination packaging only: this package is an ES module package, where a .js file would be parsed as ESM; the bytes are unchanged' } },
    source: { repository: source.repository, revision: source.revision, package: artifact.packageName, version: artifact.packageVersion, moduleSystem: artifact.moduleSystem, exportName: artifact.exportName },
    licence: { declared: licence.declared, state: licence.state, file: licenceFile, originalFile: licenceSource?.name || null, sha256: licenceSource?.sha256 || null, warning: licence.warning },
    adaptation: { id: spec.id, method: spec.method, adapter: spec.adapterModule, adapterAuthoredBy: 'GRAFT', interop: INTEROP.chosen, schemaVersion: ADAPTATION_SCHEMA_VERSION },
  };

  const files = [
    { path: artifactFile, contents: identity.bytes, role: 'vendored-artifact', authoredBy: 'third-party', verbatim: true },
    ...(licenceSource ? [{ path: licenceFile, contents: Buffer.from(licenceSource.text, 'utf8'), role: 'licence', authoredBy: 'third-party', verbatim: true }] : []),
    { path: provenanceFile, contents: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8'), role: 'provenance', authoredBy: 'GRAFT', verbatim: false },
    { path: spec.adapterModule, contents: Buffer.from(adapter, 'utf8'), role: 'adapter', authoredBy: 'GRAFT', verbatim: false },
  ];

  return {
    kind: 'LibraryHostAdaptationPlan', schemaVersion: ADAPTATION_SCHEMA_VERSION, adaptation: spec.id, method: spec.method,
    capability: { kind: support.kind, implementationForm: support.implementationForm, slug: manifest.identity?.slug || null },
    host: { profile: host.profile, moduleSystem: host.moduleSystem },
    artifactIdentity: { matched: true, expected: identity.expected, actual: identity.actual, sha256: `sha256:${identity.actualFull}`, bytes: identity.bytes.length, sourcePath: artifact.entry, destinationPath: artifactFile, byteIdentical: true },
    interop: { mechanism: INTEROP.chosen, importPath, artifactModuleSystem: artifact.moduleSystem, adapterModuleSystem: 'esm' },
    files, mapping: operationMapping(manifest.architecture.capabilityModel), provenance,
    verificationContract: destinationVerificationContract(manifest),
    verifyThrough: { runner: 'library-artifact', entry: spec.adapterModule, moduleSystem: 'esm', exportName: null },
    // Adaptation never decides truth. These stay null until the verifier speaks.
    adaptationStatus: 'planned', verdict: null, plannedAt: now(),
    authority: { deterministic: true, agentDecided: false, verdictDecidedHere: false, note: 'This plan describes writes only. The capability verdict comes from destination verification, never from adaptation.' },
  };
}

/**
 * Apply a plan into one destination root — expected to be a managed worktree.
 *
 * Every path is confined to the destination, nothing outside it is touched, and an existing file
 * is never overwritten (a collision is a refusal, so an adaptation cannot silently replace part
 * of somebody's application).
 */
export function applyLibraryAdaptation({ plan, destinationRoot, now = () => new Date().toISOString() }) {
  const root = path.resolve(destinationRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw fail('destination-missing', 'The destination folder does not exist.');
  const resolved = plan.files.map((f) => {
    if (path.isAbsolute(f.path) || f.path.split('/').includes('..')) throw fail('unsafe-adaptation-path', `The adaptation plan names an unsafe path (${f.path}).`);
    const abs = path.resolve(root, f.path);
    if (!abs.startsWith(root + path.sep)) throw fail('unsafe-adaptation-path', `${f.path} resolves outside the destination.`);
    if (fs.existsSync(abs)) throw fail('adaptation-path-occupied', `${f.path} already exists in the destination; GRAFT will not overwrite it.`);
    return { ...f, abs };
  });
  const realRoot = fs.realpathSync.native(root);
  const written = [];
  for (const file of resolved) {
    const dir = path.dirname(file.abs);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    // The prefix check above is on the path as written; a symlinked folder inside the destination
    // would still let a write land outside it. Resolve the real folder and confirm it is inside.
    const realDir = fs.realpathSync.native(dir);
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw fail('unsafe-adaptation-path', `${file.path} resolves outside the destination through a symbolic link.`);
    // 'wx' fails rather than following a symlink at the file itself or replacing an existing file.
    fs.writeFileSync(file.abs, file.contents, { flag: 'wx', mode: 0o644 });
    written.push({ path: file.path, role: file.role, authoredBy: file.authoredBy, bytes: file.contents.length, sha256: `sha256:${sha256(file.contents)}` });
  }
  return {
    kind: 'LibraryHostAdaptationReceipt', schemaVersion: ADAPTATION_SCHEMA_VERSION, adaptation: plan.adaptation, method: plan.method,
    destinationRoot: root, files: written, artifactIdentity: plan.artifactIdentity, mapping: plan.mapping,
    adaptationStatus: 'completed', verdict: null, appliedAt: now(),
    note: 'The files were written. Whether the capability works in this destination is decided by destination verification, not by this receipt.',
  };
}
