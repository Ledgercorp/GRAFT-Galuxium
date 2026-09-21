// Engine analysis for transplant planning: mismatches, adaptations, required components,
// risks, unknowns and what verification must prove — derived from the Capability Genome,
// Capability Graph, GRAFT IR and Host Model, plus the selected recipe. Descriptive prior
// observations from the Compatibility Atlas are attached but never change a decision.
import { queryAtlas } from './atlas.js';

const POINT_TO_TRANSFORMATION = Object.freeze({ 'module-system': 'convert-module-system', 'handler-contract': 'rewrite-handler-contract', framework: 'regenerate-module', 'route-registration': 'register-routes', 'persistence-binding': 'bind-persistence', 'configuration-binding': 'bind-configuration' });

function hostValue(point, host) {
  switch (point) {
    case 'module-system': return host.moduleSystem.value;
    case 'handler-contract': return host.constraints.handlerContract.value;
    case 'framework': return host.framework.value;
    case 'route-registration': return host.routing.registration.style === 'express' ? 'express-app-methods' : host.routing.registration.style === 'unknown' ? 'unknown' : 'entrypoint-route-table';
    case 'persistence-binding': return host.dataLayer.persistence;
    case 'configuration-binding': return host.environment.variables.length || host.environment.hasEnvExample ? 'environment' : 'none';
    default: return 'unknown';
  }
}

export function analyzeTransplant({ genome, graph, ir, host, recipe, emission, compatibility, verificationContract, atlas = 'local' }) {
  const mismatches = ir.adaptationPoints.map((p) => {
    const destination = hostValue(p.id, host);
    const same = p.source === destination;
    const transformation = recipe?.transformations.find((t) => t.kind === POINT_TO_TRANSFORMATION[p.id]) || null;
    return { dimension: p.id, source: p.source, destination, same,
      severity: same ? 'none' : transformation ? 'adapted' : destination === 'unknown' ? 'unknown' : 'unsupported',
      adaptation: transformation ? { id: transformation.id, kind: transformation.kind, description: transformation.description } : null };
  });
  const adaptations = (recipe?.transformations || []).map((t) => ({ id: t.id, kind: t.kind, description: t.description, mechanism: recipe.mechanism.emitterProfile,
    concrete: t.kind === 'bind-persistence' ? (host.dataLayer.persistence === 'shared-store' ? `bind users and sessions to ${host.dataLayer.modules[0]?.module}` : 'module-state behind store-adapter.js (not durable across restarts)')
      : t.kind === 'register-routes' ? `${host.routing.registration.style === 'express' ? 'app.<method>' : 'route table'} in ${host.runtime.entrypoint || '(no entrypoint)'}` : null }));

  const requiredComponents = {
    modules: (emission?.files || []).map((f) => ({ path: f.path, generated: true })),
    dependencies: genome.dependentLibraries.packages.map((p) => ({ name: p.name, reason: p.reason, presentInHost: host.packages.declared.some((d) => d.name === p.name) })),
    runtime: genome.dependentLibraries.runtime.map((r) => ({ name: r.name, range: r.range, hostRange: host.runtime.range })),
    environment: genome.environment.map((v) => ({ name: v.name, required: v.required, default: v.default, presentInHost: host.environment.variables.includes(v.name) })),
    entities: ir.state.map((s) => ({ store: s.store, fields: s.fields.length, boundTo: host.dataLayer.persistence === 'shared-store' ? host.dataLayer.modules[0]?.module || 'shared-store' : 'module-state' })),
    middleware: genome.entrypoints.filter((e) => e.kind === 'middleware').map((e) => e.name),
    endpoints: ir.operations.map((op) => `${op.method} ${op.path}`),
  };

  const risks = [];
  for (const c of compatibility?.checks || []) if (c.status !== 'ok') risks.push({ id: c.id, level: c.status === 'block' ? 'high' : 'medium', text: `${c.title}: ${c.detail}`, remedy: c.remedy || null, source: 'compatibility' });
  for (const [i, note] of genome.securityProperties.notes.entries()) risks.push({ id: `security.note.${i + 1}`, level: 'medium', text: note, remedy: null, source: 'genome' });
  if (genome.verificationExpectations.sourceVerdict !== 'VERIFIED') risks.push({ id: 'source.unproven', level: 'high', text: 'The capability was never observed working in its source; the destination verdict is the first proof.', remedy: 'Re-harvest with source verification.', source: 'genome' });
  const priorAuth = host.existingCapabilities.find((c) => c.category === genome.identity.category);
  if (priorAuth) risks.push({ id: 'host.existing-capability', level: 'medium', text: `The host already shows ${genome.identity.category} signals (${priorAuth.signals} signal(s), ${priorAuth.confidence} confidence); two implementations may coexist.`, remedy: 'Decide which implementation owns the routes and data before relying on either.', source: 'host' });
  for (const m of mismatches) if (m.severity === 'unsupported') risks.push({ id: `mismatch.${m.dimension}`, level: 'high', text: `${m.dimension}: source ${m.source} vs destination ${m.destination} with no adaptation available.`, remedy: 'Add a recipe/emitter profile for this destination shape.', source: 'engine' });

  const unobservable = (verificationContract?.invariants || []).filter((i) => !i.checkedBy.length).map((i) => i.id);
  const unknowns = [
    ...(host.testing.framework ? [] : ['The host has no identifiable test framework; GRAFT verification is the only automated proof.']),
    ...(host.dataLayer.persistence === 'module-state' ? ['Durability of users and sessions across restarts is not verified (process memory).'] : []),
    ...(genome.securityProperties.derived.cookieSecure ? [] : ['Whether the deployment serves HTTPS, which the non-Secure session cookie assumes it does not need.']),
    ...unobservable.map((id) => `Invariant ${id} is asserted by the genome but cannot be witnessed by the HTTP verifier.`),
  ];

  const verificationShouldProve = verificationContract ? {
    contractId: verificationContract.contractId,
    successCases: verificationContract.successCases.map((c) => c.id), counterfactualCases: verificationContract.counterfactualCases.map((c) => c.id),
    invariantsObservable: verificationContract.invariants.filter((i) => i.checkedBy.length).map((i) => i.id), invariantsUnobservable: unobservable,
  } : null;

  let priorObservations = null;
  if (atlas) {
    try { priorObservations = queryAtlas({ capabilityCategory: genome.identity.category, capabilityKind: genome.identity.kind, sourceArchitecture: genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, adaptations: recipe ? [recipe.mechanism.emitterProfile] : [], recipeId: recipe?.recipeId || null, ...(typeof atlas === 'string' && atlas !== 'local' ? { directory: atlas } : {}) }); }
    catch { priorObservations = null; }
  }

  return {
    capability: { name: genome.identity.name, slug: genome.identity.slug, kind: genome.identity.kind, capabilityId: genome.identity.capabilityId, genomeId: genome.genomeId, irId: ir.irId, graphId: graph.graphId },
    host: { name: host.project.name, hostId: host.hostId, profile: host.constraints.adaptationProfile, architecture: host.architecture },
    recipe: recipe ? { recipeId: recipe.recipeId, name: recipe.name, origin: recipe.provenance.origin } : null,
    mismatches, adaptations, requiredComponents, risks, unknowns, verificationShouldProve, priorObservations,
    summary: { mismatches: mismatches.filter((m) => !m.same).length, adapted: mismatches.filter((m) => m.severity === 'adapted').length, unsupported: mismatches.filter((m) => m.severity === 'unsupported').length,
      risks: risks.length, highRisks: risks.filter((r) => r.level === 'high').length, unknowns: unknowns.length, graph: graph.stats },
  };
}
