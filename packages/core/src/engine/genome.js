// Capability Genome — the structured internal representation of a harvested capability.
//
// A genome is derived deterministically from the organ manifest (the portable package) and
// nothing else, so it can be rebuilt and checked at any time and never drifts from its
// evidence. It goes beyond "these files were selected": entrypoints, inputs, outputs, side
// effects, dependencies, data, runtime assumptions, security properties and what proves
// it, each traceable back to a manifest section. The genomeId hashes the behavioral parts
// only; provenance (timestamps, paths) never changes a genome's identity.
import { stableHash, toCapabilityContract } from '../capability/contract.js';
import { kindSemantics } from './kinds/index.js';

export const GENOME_VERSION = '1.0.0';

const stepsFor = (manifest, endpoint) => manifest.acceptanceTests.tests.flatMap((t) => t.steps.filter((s) => s.method === endpoint.method && s.path === endpoint.path).map((s) => ({ test: t.id, step: s })));

export function buildCapabilityGenome(manifest) {
  const m = manifest;
  const model = m.architecture.capabilityModel;
  const contract = toCapabilityContract(m);
  const kind = model.kind;
  const semantics = kindSemantics(kind).ROLE_SEMANTICS;
  const cookie = model.session?.cookieName || null;

  // Operations come from the capability model — the authoritative endpoint list the contract
  // hashes and compatibility checks — enriched with the request/response shapes recorded for
  // the same role in interfaces.inbound. interfaces is evidence; the model is intent.
  const endpoints = model.endpoints.map((e) => {
    const shape = m.interfaces.inbound.find((x) => x.role === e.role) || { request: {}, responses: {} };
    const i = { role: e.role, method: e.method, path: e.path, request: shape.request || {}, responses: shape.responses || {} };
    const observed = stepsFor(m, i);
    const setsCookie = observed.some(({ step }) => step.expect?.setsCookie);
    const anonymousRejected = observed.some(({ step }) => step.useCookies === false && (Array.isArray(step.expect?.status) ? step.expect.status : [step.expect?.status]).every((s) => s >= 400));
    return { id: `endpoint:${i.role}`, role: i.role, method: i.method, path: i.path, request: i.request, responses: i.responses,
      purpose: semantics[i.role]?.purpose || null,
      cookie: semantics[i.role]?.cookie || (setsCookie ? 'set' : 'none'),
      guarded: semantics[i.role]?.guarded ?? anonymousRejected,
      observedBy: observed.map((o) => o.test) };
  });

  const entrypoints = [
    ...endpoints.map((e) => ({ kind: 'http-endpoint', id: e.id, role: e.role, method: e.method, path: e.path, purpose: e.purpose, observedBy: e.observedBy })),
    ...m.interfaces.providedToHost.map((p) => ({ kind: p.kind, id: `provided:${p.name}`, name: p.name, description: p.description })),
  ];
  const inputs = [
    ...endpoints.map((e) => ({ source: e.id, kind: 'http-request', schema: e.request, credential: e.guarded ? { kind: 'cookie', name: cookie } : null })),
    ...m.environment.variables.map((v) => ({ source: `env:${v.name}`, kind: 'environment', name: v.name, required: v.required === true, default: v.default ?? null, purpose: v.purpose || null })),
  ];
  const outputs = endpoints.map((e) => ({ source: e.id, kind: 'http-response', responses: e.responses, cookie: e.cookie === 'none' ? null : { name: cookie, action: e.cookie } }));

  const sideEffects = [];
  for (const e of endpoints) {
    for (const effect of semantics[e.role]?.effects || []) sideEffects.push({ id: `effect:${e.role}:${effect.op}:${effect.entity}`, kind: 'persistence', entity: effect.entity, op: effect.op, by: e.id });
    if (e.cookie !== 'none') sideEffects.push({ id: `effect:${e.role}:cookie-${e.cookie}`, kind: 'client-state', target: `cookie:${cookie}`, op: e.cookie, by: e.id });
  }

  const genome = {
    genomeVersion: GENOME_VERSION,
    identity: { name: m.identity.name, slug: m.identity.slug, category: m.identity.category, kind, capabilityId: contract.capabilityId },
    purpose: { summary: m.behavior.summary || null, behaviors: m.behavior.statements.map((s) => ({ id: s.id, text: s.text, evidence: s.evidence })), notFound: m.behavior.notFound || [] },
    entrypoints, inputs, outputs, sideEffects,
    dependentModules: m.sourceMap.files.map((f) => ({ file: f.file, role: f.role, sha256: f.sha256 })),
    dependentLibraries: { packages: m.dependencies.packages, runtime: m.dependencies.runtime, services: m.dependencies.services, notes: m.dependencies.notes || [] },
    environment: m.environment.variables.map((v) => ({ name: v.name, required: v.required === true, default: v.default ?? null, purpose: v.purpose || null })),
    dataDependencies: { entities: m.dataModel.entities, relationships: m.dataModel.relationships, migrations: m.dataModel.migrations || [], assumptions: m.dataModel.persistenceAssumptions || [], consumedFromHost: m.interfaces.consumedFromHost },
    runtimeAssumptions: { ...m.architecture.sourceShape, runtime: m.dependencies.runtime.map((r) => ({ name: r.name, range: r.range })), executionProfile: 'node-entrypoint', middleware: m.architecture.components?.middleware || [] },
    securityProperties: {
      assumptions: m.security.assumptions, boundaries: m.security.boundaries || [], notes: m.security.notes || [],
      derived: model.session ? { cookieHttpOnly: model.session.httpOnly === true, cookieSecure: model.session.secure === true, cookieSameSite: model.session.sameSite || null,
        opaqueSessionIdBytes: model.session.idBytes ?? null, passwordHash: model.passwordHash?.algorithm || null, constantTimeComparison: model.passwordHash?.comparison === 'constant-time', guardStatus: model.guard?.unauthenticatedStatus ?? null } : {},
    },
    verificationExpectations: {
      tests: m.acceptanceTests.tests.map((t) => ({ id: t.id, kind: t.kind, required: t.required, proves: t.provesBehavior, steps: t.steps.length })),
      coverage: m.behavior.statements.map((s) => ({ behavior: s.id, tests: m.acceptanceTests.tests.filter((t) => t.provesBehavior === s.id).map((t) => t.id) })),
      sourceVerdict: m.provenance.verifiedInSource?.verdict || null,
    },
    provenance: { capabilityId: contract.capabilityId, sourceFingerprint: contract.sourceFingerprint, sourceArchitecture: contract.sourceArchitecture,
      sourceProject: m.identity.sourceProject, method: m.provenance.method, aiAssisted: m.provenance.aiAssisted === true, harvestedAt: m.provenance.harvestedAt,
      lineageDepth: (m.provenance.capabilityLineage?.parents || []).length, contractVersion: contract.contractVersion },
  };
  // Identity for hashing excludes the descriptive name, as the capability id does.
  genome.genomeId = stableHash({ genomeVersion: GENOME_VERSION, identity: { slug: genome.identity.slug, category: genome.identity.category, kind, capabilityId: contract.capabilityId }, entrypoints, inputs, outputs, sideEffects,
    dataDependencies: genome.dataDependencies, runtimeAssumptions: genome.runtimeAssumptions, security: genome.securityProperties.derived, verification: genome.verificationExpectations.tests });
  return genome;
}

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function validateCapabilityGenome(genome) {
  const errors = [];
  const req = (c, msg) => { if (!c) errors.push(msg); };
  req(object(genome) && genome.genomeVersion === GENOME_VERSION, `genomeVersion must be ${GENOME_VERSION}`);
  if (!object(genome)) return { ok: false, errors };
  req(/^sha256:[0-9a-f]{64}$/.test(genome.genomeId || ''), 'genomeId must be a sha256 digest');
  req(object(genome.identity) && typeof genome.identity.slug === 'string' && typeof genome.identity.kind === 'string' && /^sha256:/.test(genome.identity.capabilityId || ''), 'identity must carry slug, kind and capabilityId');
  req(Array.isArray(genome.entrypoints) && genome.entrypoints.length > 0, 'entrypoints must be non-empty');
  for (const key of ['inputs', 'outputs', 'sideEffects', 'dependentModules', 'environment']) req(Array.isArray(genome[key]), `${key} must be an array`);
  req(object(genome.dependentLibraries) && Array.isArray(genome.dependentLibraries.packages), 'dependentLibraries.packages must be an array');
  req(object(genome.dataDependencies) && Array.isArray(genome.dataDependencies.entities), 'dataDependencies.entities must be an array');
  req(object(genome.runtimeAssumptions) && typeof genome.runtimeAssumptions.moduleSystem === 'string', 'runtimeAssumptions must describe the source shape');
  req(object(genome.securityProperties) && Array.isArray(genome.securityProperties.assumptions), 'securityProperties.assumptions must be an array');
  req(object(genome.verificationExpectations) && Array.isArray(genome.verificationExpectations.tests) && genome.verificationExpectations.tests.length > 0, 'verificationExpectations.tests must be non-empty');
  req(object(genome.provenance) && /^sha256:/.test(genome.provenance.capabilityId || ''), 'provenance must carry the capabilityId');
  const ids = new Set(genome.entrypoints?.map((e) => e.id));
  for (const i of genome.inputs || []) if (i.kind === 'http-request') req(ids.has(i.source), `input ${i.source} references an unknown entrypoint`);
  for (const s of genome.sideEffects || []) req(ids.has(s.by), `side effect ${s.id} references an unknown entrypoint`);
  return { ok: errors.length === 0, errors };
}
