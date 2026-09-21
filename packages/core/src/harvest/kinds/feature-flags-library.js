// Manifest assembly for a feature-flags capability in LIBRARY form.
//
// A library has no routes, so this manifest declares none. What it declares instead are the public
// operations the library actually exposes, the artifact a consumer loads, and the configuration
// shape those operations read. Every acceptance test is a real call into the real artifact.
//
// The behaviour encoded here was characterised from the library itself, not from its README: a
// feature is on when its mask includes the caller's bucket, an empty mask is off, an unknown
// feature takes the disabled outcome, and a nested feature also requires its parent to be on.
const PROBE = {
  // Deterministic configuration used by the acceptance suite. `Parent`/`Parent.child` exist to
  // observe hierarchy; `Off` exists to observe an explicitly empty mask.
  map: { Graft: [1, 2], 'Graft.enabled': [1], 'Graft.off': [], Parent: [1], 'Parent.child': [1] },
  enabledBucket: 1,
  otherBucket: 2,
};

export function buildFeatureFlagsLibraryManifest(fp, capability, { identity, provenance }) {
  const d = capability.detail;
  const moduleSystem = /\.mjs$/.test(d.entry) || fp.moduleSystem?.value === 'esm' ? 'esm' : 'commonjs';
  const exportName = d.packageName === 'swiveljs' ? 'Swivel' : null;
  const evidence = [...d.api.predicate, ...d.api.selection, ...d.api.registry].slice(0, 6);

  const statements = [
    { id: 'flags.evaluate', text: 'A caller can ask whether a named feature is on for a given context, and gets a different answer for a context the feature is not enabled for.', evidence: d.api.predicate.concat(d.api.selection).slice(0, 3) },
    { id: 'flags.disabled', text: 'A feature configured with no enabled context is off.', evidence: d.api.registry.slice(0, 2) },
    { id: 'flags.unknown', text: 'Asking about a feature that is not configured takes the disabled outcome rather than failing.', evidence: d.api.selection.slice(0, 2) },
    { id: 'flags.hierarchy', text: 'A nested feature is on only when its parent is also on for that context.', evidence: d.api.predicate.slice(0, 2) },
    { id: 'flags.branch', text: 'A caller can hand the capability two outcomes and have it choose the one the feature selects.', evidence: d.api.selection.slice(0, 2) },
    { id: 'flags.deterministic', text: 'The same configuration and context always produce the same answer.', evidence: evidence.slice(0, 2) },
  ];

  const construct = (bucketIndex) => ({ options: { map: PROBE.map, bucketIndex } });
  const enabled = construct(PROBE.enabledBucket), other = construct(PROBE.otherBucket);
  const tests = [
    { id: 'flags.enabled-for-context', kind: 'library', required: true, provesBehavior: 'flags.evaluate', description: 'A feature whose mask includes the caller’s bucket is on.',
      construct: enabled, steps: [{ name: 'enabled', call: 'returnValue', args: ['Graft.enabled', 'on', 'off'], expect: { equals: 'on' } }] },
    { id: 'flags.disabled-for-other-context', kind: 'library', required: true, provesBehavior: 'flags.evaluate', description: 'The same feature is off for a bucket its mask does not include.',
      construct: other, steps: [{ name: 'disabled', call: 'returnValue', args: ['Graft.enabled', 'on', 'off'], expect: { equals: 'off' } }] },
    { id: 'flags.empty-mask-is-off', kind: 'library', required: true, provesBehavior: 'flags.disabled', description: 'A feature configured with an empty mask is off.',
      construct: enabled, steps: [{ name: 'off', call: 'returnValue', args: ['Graft.off', 'on', 'off'], expect: { equals: 'off' } }] },
    { id: 'flags.unknown-takes-fallback', kind: 'library', required: true, provesBehavior: 'flags.unknown', description: 'An unconfigured feature takes the disabled outcome.',
      construct: enabled, steps: [{ name: 'unknown', call: 'returnValue', args: ['Graft.not-configured', 'on', 'off'], expect: { equals: 'off' } }] },
    { id: 'flags.parent-gates-child', kind: 'library', required: true, provesBehavior: 'flags.hierarchy', description: 'A nested feature is off when its parent is off for that bucket, even though the child’s own mask allows it.',
      construct: other, steps: [{ name: 'child', call: 'returnValue', args: ['Parent.child', 'on', 'off'], expect: { equals: 'off' } }] },
    { id: 'flags.branch-selection', kind: 'library', required: true, provesBehavior: 'flags.branch', description: 'Handed two outcomes, the capability takes the enabled one for an enabled feature and the disabled one otherwise.',
      construct: enabled, steps: [{ name: 'enabled-branch', call: 'invoke', args: ['Graft.enabled', { $callback: 'enabled' }, { $callback: 'disabled' }], expect: { branch: 'enabled' } }] },
    { id: 'flags.branch-selection-disabled', kind: 'library', required: true, provesBehavior: 'flags.branch', description: 'The disabled outcome is taken for a feature that is off.',
      construct: other, steps: [{ name: 'disabled-branch', call: 'invoke', args: ['Graft.enabled', { $callback: 'enabled' }, { $callback: 'disabled' }], expect: { branch: 'disabled' } }] },
    { id: 'flags.deterministic', kind: 'library', required: true, provesBehavior: 'flags.deterministic', description: 'Repeating an evaluation with the same configuration gives the same answer.',
      construct: enabled, steps: [
        { name: 'first', call: 'returnValue', args: ['Graft.enabled', 'on', 'off'], expect: { equals: 'on' } },
        { name: 'second', call: 'returnValue', args: ['Graft.enabled', 'on', 'off'], expect: { sameAs: 'first' } }] },
  ];

  return {
    // The kind is unchanged — this is feature-flags. The slug distinguishes the artifact, because
    // the organ bank addresses one artifact per slug and two forms of one kind are two artifacts.
    identity: { ...identity, name: 'Feature flags', slug: 'feature-flags-library', category: 'feature-flags', implementationForm: 'library' },
    behavior: { summary: 'Feature evaluation exposed as a library: a program asks whether a named feature is on for a context, and the capability answers or chooses between outcomes.', statements, notFound: d.absent },
    architecture: {
      sourceShape: { moduleSystem: fp.moduleSystem?.value || null, handlerContract: null, framework: null, persistence: 'none' },
      capabilityModel: {
        kind: 'feature-flags', implementationForm: 'library',
        artifact: { entry: d.entry, moduleSystem, exportName, packageName: d.packageName, packageVersion: d.packageVersion, committed: true },
        configuration: { shape: 'feature-map', contextShape: 'bucket-index', hierarchical: true, unknownFeature: 'disabled-outcome', defaultsInCode: false },
        operations: [
          { id: 'op:select-value', name: 'returnValue', role: 'select-value', inputs: [{ name: 'feature', type: 'string' }, { name: 'enabledValue', type: 'any' }, { name: 'disabledValue', type: 'any' }], output: { type: 'any', meaning: 'the value chosen for the feature’s state' } },
          { id: 'op:invoke-branch', name: 'invoke', role: 'invoke-branch', inputs: [{ name: 'feature', type: 'string' }, { name: 'onEnabled', type: 'function' }, { name: 'onDisabled', type: 'function' }], output: { type: 'void', meaning: 'the branch matching the feature’s state is called' } },
        ],
        // A library registers nothing: this is the field that would carry routes for a service.
        endpoints: [],
      },
      components: { frontend: [], backendRoutes: [], middleware: [], backgroundJobs: [], externalServices: [] },
    },
    dependencies: {
      runtime: [{ name: 'node', range: fp.packageJson?.engines?.node || '>=20' }],
      packages: [],
      services: [],
      // What a destination would need is the library itself — recorded as a requirement, never as
      // something GRAFT has installed or will install.
      hostRequirements: [{ kind: 'package', name: d.packageName, version: d.packageVersion, reason: 'a destination must resolve this library to use the capability', satisfiedByGraft: false }],
    },
    // A library exposes an API to the program that loads it; it registers nothing with a host.
    interfaces: { inbound: [], outbound: [], providedToHost: [
      { kind: 'module-export', name: 'returnValue', description: 'Choose between two values according to whether a named feature is on for the caller’s context.', export: exportName, operation: 'op:select-value' },
      { kind: 'module-export', name: 'invoke', description: 'Call one of two callbacks according to whether a named feature is on for the caller’s context.', export: exportName, operation: 'op:invoke-branch' },
    ], consumedFromHost: [
      { kind: 'configuration', name: 'feature map', description: 'A map of feature name to the contexts it is enabled for.' },
      { kind: 'configuration', name: 'bucket index', description: 'The caller context a feature is evaluated against.' },
    ] },
    dataModel: { entities: [], relationships: [], persistenceAssumptions: [{ id: 'flags.stateless', text: 'The capability stores nothing: every answer is computed from the configuration it was given.' }] },
    environment: { variables: [] },
    security: {
      assumptions: [
        { id: 'flags.configuration-is-the-callers', text: 'The consumer supplies the feature configuration and the context to evaluate against.' },
        { id: 'flags.no-io', text: 'The capability performs no I/O, issues no credential and reaches no network.' },
      ],
      boundaries: [], secrets: [],
    },
    acceptanceTests: { tests },
    sourceMap: { files: [{ file: d.entry, role: 'library-artifact', purpose: 'the published implementation a consumer loads' }] },
    provenance,
  };
}
