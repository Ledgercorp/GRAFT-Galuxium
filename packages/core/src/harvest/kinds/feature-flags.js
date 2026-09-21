// Manifest assembly for a harvested feature-flags capability. The model is intent (defaults,
// configuration, endpoints); acceptance tests observe the behavior — including the ABSENCE of
// side effects, which is this kind's defining property.
export function buildFeatureFlagsManifest(fp, capability, { identity, provenance }) {
  const d = capability.detail;
  const route = (role) => d.routes.find((r) => r.role === role);
  const list = route('list'), evaluate = route('evaluate');
  const names = Object.keys(d.defaults);
  const enabledDefault = names.find((n) => d.defaults[n] === true) || names[0];
  const disabledDefault = names.find((n) => d.defaults[n] === false) || null;

  const statements = [
    { id: 'flags.list', text: 'A caller can read every feature flag and whether it is enabled.', evidence: [`${list.method} ${list.path} in ${list.file}`, `${d.defaultsFile}: DEFAULT_FLAGS`] },
    ...(evaluate ? [{ id: 'flags.evaluate', text: 'A caller can ask whether one named flag is enabled.', evidence: [`${evaluate.method} ${evaluate.path} in ${evaluate.file}`] },
      { id: 'flags.unknown', text: 'Asking about a flag that does not exist is refused rather than answered.', evidence: [`${evaluate.method} ${evaluate.path} in ${evaluate.file}`] }] : []),
    { id: 'flags.read-only', text: 'Reading or evaluating flags never changes state and never issues a credential.', evidence: [`${list.file}: handlers only read configuration`] },
  ];
  const tests = [
    { id: 'flags.list.reports-defaults', kind: 'http', required: true, provesBehavior: 'flags.list', description: 'The flag list reports the configured defaults.',
      steps: [{ name: 'list', method: 'GET', path: list.path, expect: { status: [200], bodyMatches: Object.fromEntries(names.slice(0, 3).map((n) => [`flags.${n}`, d.defaults[n]])), noSetCookie: true } }] },
    ...(evaluate ? [
      { id: 'flags.evaluate.known-flag', kind: 'http', required: true, provesBehavior: 'flags.evaluate', description: 'Evaluating a known flag answers with its state.',
        steps: [{ name: 'evaluate', method: 'POST', path: evaluate.path, body: { name: enabledDefault }, expect: { status: [200], bodyMatches: { name: enabledDefault, enabled: d.defaults[enabledDefault] } } }] },
      { id: 'flags.evaluate.unknown-flag', kind: 'http', required: true, provesBehavior: 'flags.unknown', description: 'Evaluating an unknown flag is refused with 404.',
        steps: [{ name: 'unknown', method: 'POST', path: evaluate.path, body: { name: 'graft-no-such-flag' }, expect: { status: [404] } }] },
    ] : []),
    { id: 'flags.list.is-read-only', kind: 'http', required: true, provesBehavior: 'flags.read-only', description: 'Reading and evaluating flags issues no cookie and changes nothing: a second read is identical to the first.',
      steps: [
        { name: 'first', method: 'GET', path: list.path, expect: { status: [200], noSetCookie: true } },
        ...(evaluate ? [{ name: 'evaluate-between', method: 'POST', path: evaluate.path, body: { name: disabledDefault || enabledDefault }, expect: { status: [200], noSetCookie: true } }] : []),
        { name: 'second', method: 'GET', path: list.path, expect: { status: [200], noSetCookie: true, sameBodyAs: 'first' } },
      ] },
  ];
  return {
    identity: { ...identity, name: 'Feature flags', slug: 'feature-flags', category: 'feature-flags', implementationForm: 'service' },
    behavior: { summary: 'Feature flags with defaults in code and names enabled through the environment; read-only.', statements, notFound: d.absent },
    architecture: {
      sourceShape: { moduleSystem: fp.moduleSystem.value, handlerContract: fp.handlerContract.value, framework: fp.framework.value, persistence: fp.persistence.value },
      capabilityModel: { kind: 'feature-flags', configuration: { envVar: d.envVar, format: d.envVar ? 'comma-separated-enabled-names' : null, defaults: d.defaults }, endpoints: d.routes.map((r) => ({ role: r.role, method: r.method, path: r.path })) },
      components: { frontend: [], backendRoutes: d.routes.map((r) => `${r.method} ${r.path}`), middleware: [], backgroundJobs: [], externalServices: [] },
    },
    dependencies: { packages: [], runtime: [{ name: 'node', range: '>=18', reason: 'process.env and JSON responses' }], services: [], notes: ['No packages; flags are plain configuration.'] },
    interfaces: {
      inbound: d.routes.map((r) => ({ role: r.role, method: r.method, path: r.path, ...(r.role === 'list' ? { request: {}, responses: { 200: { flags: 'object' } } } : { request: { name: 'string' }, responses: { 200: { name: 'string', enabled: 'boolean' }, 404: { error: 'string' } } }) })),
      outbound: [], providedToHost: [], consumedFromHost: [{ kind: 'configuration', description: 'Process environment for enabling flag names.' }],
    },
    dataModel: { entities: [], relationships: [], migrations: [], persistenceAssumptions: ['Flags are read from code defaults and the environment; nothing is stored.'] },
    environment: { variables: d.envVar ? [{ name: d.envVar, required: false, purpose: 'comma-separated flag names to enable', default: '' }] : [], note: 'Names only. GRAFT never records environment values in a manifest.' },
    security: {
      assumptions: [
        { id: 'flags.no-side-effects', text: 'Flag endpoints never write state and never set cookies.', witnessedBy: ['flags.list.is-read-only', 'flags.list.reports-defaults'] },
        { id: 'flags.unknown-refused', text: 'Unknown flag names are refused, so the endpoint cannot be used to probe arbitrary configuration.', witnessedBy: evaluate ? ['flags.evaluate.unknown-flag'] : [] },
        { id: 'flags.no-secrets', text: 'Flag values are booleans; no secret is exposed through the flag API.', witnessedBy: [] },
      ],
      boundaries: ['Flags are configuration, not authorization: enabling a flag must not grant access by itself.'],
      notes: [],
    },
    acceptanceTests: { tests },
    sourceMap: { note: 'Evidence trail back to the source project; nothing here is copied.', files: d.contributingFiles.map((file) => ({ file, role: file === d.defaultsFile ? 'flag defaults and routes' : 'routes', sha256: null })) },
    provenance,
  };
}
