// The IR -> emitter boundary. lowerToEmission() turns normalized capability intent (GRAFT IR)
// plus the destination (Host Model) and the selected recipe into an EmissionSpec: everything a
// code emitter is allowed to know. Emitters take a spec and nothing else — not the manifest,
// not the source files, not the raw fingerprint — so what is generated is determined by
// normalized intent and destination architecture, not by the shape of the source project.
import { stableHash } from '../capability/contract.js';
import { kindSemantics } from './kinds/index.js';

export const EMISSION_SPEC_VERSION = '1.0.0';

export function lowerToEmission(ir, host, recipe, { dir = null } = {}) {
  const kind = kindSemantics(ir.capability.kind);
  const profile = host.constraints.profilesByKind ? (host.constraints.profilesByKind[ir.capability.kind] || null) : host.constraints.adaptationProfile;
  if (!profile) {
    const err = new Error(`no emitter can write a ${ir.capability.kind} capability into a ${host.moduleSystem.value}/${host.constraints.handlerContract.value}${host.framework?.value ? ` (${host.framework.value})` : ''} destination${host.constraints.centralHandler && !host.constraints.centralHandler.supported ? `; central handler: ${host.constraints.centralHandler.reason}` : ''}; supported profiles: ${host.constraints.supportedProfiles.join(', ')}`);
    err.code = 'unsupported-profile';
    throw err;
  }
  if (recipe && recipe.mechanism.emitterProfile !== profile) throw new Error(`recipe ${recipe.name} targets ${recipe.mechanism.emitterProfile}, but the host supports ${profile}`);
  const store = host.dataLayer.persistence === 'shared-store' ? host.dataLayer.modules.find((m) => m.kind === 'shared-store') || host.dataLayer.modules[0] : null;
  const spec = {
    specVersion: EMISSION_SPEC_VERSION,
    kind: ir.capability.kind, slug: ir.capability.slug, capabilityId: ir.capability.capabilityId, genomeId: ir.capability.genomeId, irId: ir.irId,
    profile, dir: dir || kind.REGISTRATION.defaultDir,
    target: {
      moduleSystem: host.moduleSystem.value, handlerContract: host.constraints.handlerContract.value, framework: host.framework.value,
      persistence: store ? { binding: 'shared-store', module: store.module, exportName: store.exportName || 'store' } : { binding: 'module-state', module: null, exportName: null },
      entrypoint: host.runtime.entrypoint,
    },
    registration: { ...kind.REGISTRATION },
    operations: ir.operations.map((op) => ({ id: op.id, role: op.role, method: op.method, path: op.path, guards: op.guards, emits: op.emits, effects: op.effects })),
    guards: ir.guards, policies: ir.policies, state: ir.state,
    environment: (ir.environment || []).map((v) => ({ name: v.name, default: v.default ?? null, required: v.required === true })),
    recipe: recipe ? { recipeId: recipe.recipeId, name: recipe.name, transformations: recipe.transformations.map((t) => t.kind) } : null,
  };
  spec.specId = stableHash({ specVersion: spec.specVersion, kind: spec.kind, profile, dir: spec.dir, target: spec.target, registration: spec.registration, operations: spec.operations, guards: spec.guards, policies: spec.policies, state: spec.state, environment: spec.environment });
  return spec;
}

export function validateEmissionSpec(spec) {
  const errors = [];
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(spec) || spec.specVersion !== EMISSION_SPEC_VERSION) return { ok: false, errors: [`specVersion must be ${EMISSION_SPEC_VERSION}`] };
  if (typeof spec.kind !== 'string' || typeof spec.profile !== 'string') errors.push('kind and profile are required');
  if (!object(spec.target) || !object(spec.target.persistence) || !['shared-store', 'module-state'].includes(spec.target.persistence.binding)) errors.push('target.persistence.binding must be shared-store or module-state');
  if (!object(spec.registration) || typeof spec.registration.name !== 'string' || typeof spec.registration.marker !== 'string') errors.push('registration name and marker are required');
  if (!Array.isArray(spec.operations) || !spec.operations.length) errors.push('operations must be non-empty');
  if (!object(spec.policies)) errors.push('policies must be an object');
  if (!/^sha256:[0-9a-f]{64}$/.test(spec.specId || '')) errors.push('specId must be a sha256 digest');
  return { ok: errors.length === 0, errors };
}
