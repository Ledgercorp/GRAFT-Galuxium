// GRAFT IR — the first proprietary intermediate representation of a capability.
//
//   source implementation -> Capability Genome -> GRAFT IR -> transplant planning/adaptation
//
// The IR normalizes a capability into operations (what each entrypoint does to state and to
// the client), abstract state (entities as stores), policies (the parameters that must be
// preserved exactly), invariants (what must stay true) and adaptation points (the dimensions
// along which a destination differs). It is intent, not source: the emitter profiles
// regenerate code from these same parameters, and the planner derives mismatches,
// adaptations and the verification contract from the IR rather than from file names.
import { stableHash } from '../capability/contract.js';
import { kindSemantics } from './kinds/index.js';

export const IR_VERSION = '1.0.0';

export function buildGraftIR(genome, manifest) {
  const model = manifest.architecture.capabilityModel;
  const endpoints = genome.entrypoints.filter((e) => e.kind === 'http-endpoint');
  const guards = genome.entrypoints.filter((e) => e.kind === 'middleware').map((g) => ({ id: g.id, name: g.name, unauthenticatedStatus: model.guard?.unauthenticatedStatus ?? 401,
    appliesTo: endpoints.filter((e) => genome.inputs.find((i) => i.source === e.id)?.credential).map((e) => e.id) }));
  // Capability Forms 0.1a: a library registers no routes, so its operations are the public API the
  // manifest declares. Nothing here fabricates a method, a path or a response.
  const libraryOperations = model.implementationForm === 'library' ? (model.operations || []).map((o) => ({
    id: o.id, role: o.role, kind: 'library-operation', name: o.name,
    input: { parameters: o.inputs || [], configuration: model.configuration ? Object.keys(model.configuration) : [] },
    output: o.output || null,
    guards: [], effects: [],
    provesBehavior: [...new Set(manifest.acceptanceTests.tests.filter((t) => (t.steps || []).some((s) => s.call === o.name)).map((t) => t.provesBehavior).filter(Boolean))],
  })) : null;
  const operations = libraryOperations || endpoints.map((e) => {
    const input = genome.inputs.find((i) => i.source === e.id);
    const output = genome.outputs.find((o) => o.source === e.id);
    return {
      id: `op:${e.role}`, role: e.role, kind: 'http-operation', method: e.method, path: e.path, purpose: e.purpose,
      input: { body: input?.schema || {}, credential: input?.credential || null },
      guards: guards.filter((g) => g.appliesTo.includes(e.id)).map((g) => g.id),
      effects: genome.sideEffects.filter((s) => s.by === e.id).map((s) => ({ kind: s.kind, op: s.op, target: s.entity || s.target })),
      emits: { responses: output?.responses || {}, cookie: output?.cookie || null },
      provesBehavior: genome.verificationExpectations.tests.filter((t) => manifest.acceptanceTests.tests.find((x) => x.id === t.id)?.steps.some((s) => s.method === e.method && s.path === e.path)).map((t) => t.proves),
    };
  });
  const state = genome.dataDependencies.entities.map((ent) => ({ store: ent.name, fields: (ent.fields || []).map((f) => ({ name: f.name, type: f.type || null, unique: f.unique === true })),
    key: (ent.fields || []).find((f) => f.name === 'id')?.name || null,
    relations: genome.dataDependencies.relationships.filter((r) => String(r.from).startsWith(`${ent.name}.`)).map((r) => ({ field: String(r.from).split('.')[1], to: r.to, kind: r.kind })) }));
  const policies = {
    credential: model.credential || null,
    passwordPolicy: model.passwordPolicy || null,
    passwordHash: model.passwordHash ? { algorithm: model.passwordHash.algorithm, builtin: model.passwordHash.builtin === true, npmPackage: model.passwordHash.npmPackage || null, keyLength: model.passwordHash.keyLength ?? null, saltBytes: model.passwordHash.saltBytes ?? null, comparison: model.passwordHash.comparison || null } : null,
    // Policy values are carried through as harvested — never coerced — so the emitter's
    // interpolation guards still see (and refuse) a malformed or hostile manifest value.
    session: model.kind === 'hosted-session-auth' && model.session
      // Hosted kind: the full local-custody contract, carried as harvested.
      ? { transport: model.session.transport, custody: model.session.custody, store: model.session.store, durableAcrossRestart: model.session.durableAcrossRestart, cookieName: model.session.cookieName, loopbackCookieName: model.session.loopbackCookieName ?? null,
        flowCookieName: model.session.flowCookieName, loopbackFlowCookieName: model.session.loopbackFlowCookieName ?? null, httpOnly: model.session.httpOnly, secureWhenHttps: model.session.secureWhenHttps, sameSite: model.session.sameSite ?? null, path: model.session.path ?? '/',
        idBytes: model.session.idBytes ?? null, idLength: model.session.idLength ?? null, sessionSeconds: model.session.sessionSeconds ?? null, idleSeconds: model.session.idleSeconds ?? null, flowSeconds: model.session.flowSeconds ?? null, keyed: model.session.keyed ?? null }
      : model.session ? { transport: model.session.transport, cookieName: model.session.cookieName, httpOnly: model.session.httpOnly, secure: model.session.secure, sameSite: model.session.sameSite ?? null, path: model.session.path ?? '/', ttlSeconds: model.session.ttlSeconds ?? null, idBytes: model.session.idBytes ?? null, storage: model.session.storage ?? null } : null,
    guard: model.guard ? { name: model.guard.name, unauthenticatedStatus: model.guard.unauthenticatedStatus } : null,
    configuration: model.implementationForm === 'library'
      // A library is configured by its caller: there are no in-code defaults and no environment
      // variable to read, and saying so is the honest policy.
      ? { shape: model.configuration?.shape ?? null, contextShape: model.configuration?.contextShape ?? null, hierarchical: model.configuration?.hierarchical === true, unknownFeature: model.configuration?.unknownFeature ?? null, defaultsInCode: model.configuration?.defaultsInCode === true, envVar: null, format: null, defaults: null }
      : model.configuration ? { envVar: model.configuration.envVar ?? null, format: model.configuration.format ?? null, defaults: model.configuration.defaults } : null,
    // Engine 1.2: who validates the credential is a policy of its own, separate from how the
    // session travels and where it is kept. Carried raw from the model, never coerced.
    credentialAuthority: model.credentialAuthority ? { kind: model.credentialAuthority.kind, provider: model.credentialAuthority.provider ?? null, protocols: model.credentialAuthority.protocols ?? [] } : { kind: model.passwordHash ? 'local' : 'unknown', provider: null, protocols: [] },
    provider: model.provider ? { defaultOrigin: model.provider.defaultOrigin, endpoints: model.provider.endpoints, tokenRequest: model.provider.tokenRequest ?? 'json', identity: model.provider.identity ?? null } : null,
    csrf: model.csrf ?? null,
    providerSeam: model.providerSeam ?? null,
    failureDisclosure: model.kind === 'hosted-session-auth' ? 'uniform-signin-failure' : 'uniform-login-failure',
  };
  const invariants = [
    ...genome.securityProperties.assumptions.map((a) => ({ id: a.id, kind: 'security', text: a.text })),
    ...genome.securityProperties.boundaries.map((b, i) => ({ id: `boundary.${i + 1}`, kind: 'security-boundary', text: b })),
    ...genome.dataDependencies.assumptions.map((t, i) => ({ id: `data.${i + 1}`, kind: 'data', text: t })),
  ];
  const shape = genome.runtimeAssumptions;
  const ADAPTATION_POINTS = kindSemantics(genome.identity.kind).ADAPTATION_POINTS;
  const adaptationPoints = ADAPTATION_POINTS.map((id) => ({ id, source: {
    'module-system': shape.moduleSystem, 'handler-contract': shape.handlerContract, framework: shape.framework,
    'route-registration': shape.framework === 'express' ? 'express-app-methods' : 'entrypoint-route-table', 'persistence-binding': shape.persistence,
    'configuration-binding': genome.environment.length ? 'environment' : 'none',
    'provider-binding': model.providerSeam?.verification?.kind || 'none',
    'session-store-binding': model.session?.store || shape.persistence,
  }[id], preserve: false }));
  const ir = { irVersion: IR_VERSION, capability: { kind: genome.identity.kind, slug: genome.identity.slug, genomeId: genome.genomeId, capabilityId: genome.identity.capabilityId },
    operations, state, policies, guards, invariants, adaptationPoints,
    environment: genome.environment.map((v) => ({ name: v.name, required: v.required, default: v.default })),
    preserved: model.kind === 'hosted-session-auth'
      ? ['policies.credentialAuthority', 'policies.provider.endpoints', 'policies.session', 'policies.csrf', 'policies.guard.unauthenticatedStatus', 'operations[].method', 'operations[].path', 'operations[].emits.responses', 'policies.failureDisclosure']
      : ['policies.passwordHash', 'policies.session', 'policies.guard.unauthenticatedStatus', 'operations[].method', 'operations[].path', 'operations[].emits.responses', 'policies.failureDisclosure'] };
  ir.irId = stableHash({ irVersion: IR_VERSION, capability: ir.capability, operations, state, policies, guards, invariants: invariants.map((i) => i.id), adaptationPoints, environment: ir.environment });
  return ir;
}

export function validateGraftIR(ir) {
  const errors = [];
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(ir) || ir.irVersion !== IR_VERSION) return { ok: false, errors: [`irVersion must be ${IR_VERSION}`] };
  if (!/^sha256:[0-9a-f]{64}$/.test(ir.irId || '')) errors.push('irId must be a sha256 digest');
  if (!object(ir.capability) || typeof ir.capability.kind !== 'string') errors.push('capability.kind is required');
  if (!Array.isArray(ir.operations) || !ir.operations.length) errors.push('operations must be non-empty');
  for (const op of ir.operations || []) {
    // Each form is held to its own shape: an HTTP operation must name a method and a path, a
    // library operation must name the call and what it takes and returns. Neither may borrow the
    // other's fields to look complete.
    if (op.kind === 'library-operation') {
      if (typeof op.name !== 'string' || !op.name) errors.push(`operation ${op.id} must name the public call it exercises`);
      if (typeof op.role !== 'string' || !op.role) errors.push(`operation ${op.id} must declare a role`);
      if (!object(op.input) || !Array.isArray(op.input.parameters)) errors.push(`operation ${op.id} must declare its input parameters`);
      if (!('output' in op)) errors.push(`operation ${op.id} must declare its output`);
      if ('method' in op || 'path' in op) errors.push(`operation ${op.id} is a library operation and must not declare a method or a path`);
    } else {
      if (op.kind !== 'http-operation' || typeof op.method !== 'string' || typeof op.path !== 'string') errors.push(`operation ${op.id} must be an http-operation with method and path`);
      if (!Array.isArray(op.effects) || !object(op.emits)) errors.push(`operation ${op.id} must declare effects and emits`);
    }
    for (const g of op.guards || []) if (!(ir.guards || []).some((x) => x.id === g)) errors.push(`operation ${op.id} references unknown guard ${g}`);
  }
  if (!Array.isArray(ir.state)) errors.push('state must be an array');
  if (!object(ir.policies)) errors.push('policies must be an object');
  if (!Array.isArray(ir.invariants)) errors.push('invariants must be an array');
  if (!Array.isArray(ir.adaptationPoints) || !ir.adaptationPoints.length) errors.push('adaptationPoints must be non-empty');
  if (!Array.isArray(ir.environment)) errors.push('environment must be an array');
  return { ok: errors.length === 0, errors };
}
