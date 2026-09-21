// Transplant Recipes — the reusable-recipe data model. A recipe is declarative: it names
// where it applies, which transformations the engine must perform and through which
// mechanism (an emitter profile the engine already owns), what dependencies substitute,
// and what verification must prove. Recipes carry no executable code; user-supplied
// recipes are validated data and can only select mechanisms the engine implements.
import fs from 'node:fs';
import path from 'node:path';
import { stableHash } from '../capability/contract.js';
import { SUPPORTED_PROFILES } from '../emit/profiles.js';

export const RECIPE_VERSION = '1.0.0';
export const TRANSFORMATION_KINDS = Object.freeze(['regenerate-module', 'rewrite-handler-contract', 'convert-module-system', 'bind-persistence', 'bind-configuration', 'register-routes', 'substitute-dependency']);

const finish = (recipe) => ({ ...recipe, recipeId: stableHash({ recipeVersion: recipe.recipeVersion, applicability: recipe.applicability, transformations: recipe.transformations, dependencySubstitutions: recipe.dependencySubstitutions, mechanism: recipe.mechanism }) });

// Built-in recipes: one per (capability kind, emitter profile) the engine implements. The
// transformation set is the kind's: session-auth binds persistence; feature-flags binds
// configuration and never touches a store.
const KIND_TRANSFORMATIONS = Object.freeze({
  'session-auth': (profile) => [
    { id: 'regenerate', kind: 'regenerate-module', description: 'Regenerate passwords, sessions, guard, routes and store adapter modules from the IR policies; nothing is copied from the source.' },
    { id: 'handlers', kind: 'rewrite-handler-contract', description: `Write handlers in the ${profile.handlerContract} contract.` },
    { id: 'modules', kind: 'convert-module-system', description: `Emit ${profile.moduleSystem} modules.` },
    { id: 'persistence', kind: 'bind-persistence', description: 'Bind users and sessions to the host shared store when one exists, otherwise to module state behind a store adapter.' },
    { id: 'routes', kind: 'register-routes', description: profile.framework === 'express' ? 'Register routes with app.<method> in the Express entrypoint.' : 'Register routes through the entrypoint route table.' },
  ],
  'hosted-session-auth': (profile) => [
    { id: 'regenerate', kind: 'regenerate-module', description: 'Regenerate the provider adapter, identity verifier, local session custody and routes from the IR policies; nothing is copied from the source.' },
    { id: 'handlers', kind: 'rewrite-handler-contract', description: `Write handlers in the ${profile.handlerContract} contract.` },
    { id: 'modules', kind: 'convert-module-system', description: `Emit ${profile.moduleSystem} modules.` },
    { id: 'provider', kind: 'bind-configuration', description: 'Bind the external credential authority through environment configuration (provider origin, client id/secret, issuer, audience, JWKS); the session layer stays local.' },
    { id: 'routes', kind: 'register-routes', description: profile.framework === 'express' ? 'Mount one guard middleware on the Express app before its routes; requests the capability declines continue to the existing routes unchanged.' : 'Give the capability first refusal on every request inside the central node:http handler; unrelated requests fall through unchanged.' },
  ],
  'feature-flags': (profile) => [
    { id: 'regenerate', kind: 'regenerate-module', description: 'Regenerate the flag defaults and route modules from the IR configuration policy; nothing is copied from the source.' },
    { id: 'handlers', kind: 'rewrite-handler-contract', description: `Write handlers in the ${profile.handlerContract} contract.` },
    { id: 'modules', kind: 'convert-module-system', description: `Emit ${profile.moduleSystem} modules.` },
    { id: 'configuration', kind: 'bind-configuration', description: 'Read enabled flag names from the process environment variable the source used; defaults stay in code.' },
    { id: 'routes', kind: 'register-routes', description: profile.framework === 'express' ? 'Register routes with app.<method> in the Express entrypoint.' : 'Register routes through the entrypoint route table.' },
  ],
});
const KIND_SUBSTITUTIONS = Object.freeze({
  'session-auth': [{ from: 'bcrypt|argon2', to: 'node:crypto scrypt', reason: 'Only when the source hash algorithm is scrypt or pbkdf2; other algorithms keep their npm package.', conditional: true }],
  'feature-flags': [],
  'hosted-session-auth': [],
});

export const BUILTIN_RECIPES = Object.freeze(Object.keys(KIND_TRANSFORMATIONS).flatMap((kind) => SUPPORTED_PROFILES.filter((profile) => profile.kinds.includes(kind)).map((profile) => finish({
  recipeVersion: RECIPE_VERSION,
  name: `${kind} → ${profile.id}`,
  applicability: { capabilityKind: kind, source: { any: true }, destination: { moduleSystem: profile.moduleSystem, handlerContract: profile.handlerContract, framework: profile.framework || null } },
  transformations: KIND_TRANSFORMATIONS[kind](profile),
  dependencySubstitutions: KIND_SUBSTITUTIONS[kind],
  verificationExpectations: { cases: 'all-required', invariants: 'declared', evidence: 'observed-http-acceptance-suite' },
  mechanism: { emitterProfile: profile.id },
  provenance: { origin: 'builtin', engine: 'graft-core', confidence: { basis: kind === 'session-auth' ? 'benchmarked' : kind === 'hosted-session-auth' ? 'real-transplant' : 'tested', note: kind === 'session-auth' ? 'Exercised by GRAFTBench baseline transplants.' : kind === 'hosted-session-auth' ? 'Exercised by the first real-world transplant trial.' : 'Exercised by the engine end-to-end suite.' } },
}))));

export function validateRecipe(recipe) {
  const errors = [];
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(recipe) || recipe.recipeVersion !== RECIPE_VERSION) return { ok: false, errors: [`recipeVersion must be ${RECIPE_VERSION}`] };
  if (typeof recipe.name !== 'string' || !recipe.name) errors.push('name is required');
  if (!object(recipe.applicability) || typeof recipe.applicability.capabilityKind !== 'string' || !object(recipe.applicability.destination)) errors.push('applicability must name a capabilityKind and destination');
  if (!Array.isArray(recipe.transformations) || !recipe.transformations.length) errors.push('transformations must be non-empty');
  for (const t of recipe.transformations || []) if (!TRANSFORMATION_KINDS.includes(t.kind)) errors.push(`unknown transformation kind ${t.kind}`);
  if (!Array.isArray(recipe.dependencySubstitutions)) errors.push('dependencySubstitutions must be an array');
  if (!object(recipe.verificationExpectations)) errors.push('verificationExpectations is required');
  if (!object(recipe.mechanism) || !SUPPORTED_PROFILES.some((p) => p.id === recipe.mechanism.emitterProfile)) errors.push('mechanism.emitterProfile must name an emitter profile the engine implements');
  if (!object(recipe.provenance) || !['builtin', 'user', 'learned'].includes(recipe.provenance.origin)) errors.push('provenance.origin must be builtin, user or learned');
  if (!/^sha256:[0-9a-f]{64}$/.test(recipe.recipeId || '')) errors.push('recipeId must be a sha256 digest');
  return { ok: errors.length === 0, errors };
}

/** Resolve a recorded recipe id: a built-in, or a stub that keeps the id when it was a learned/user recipe. */
export function recipeById(recipeId) {
  if (!recipeId) return null;
  return BUILTIN_RECIPES.find((r) => r.recipeId === recipeId) || { recipeId, name: 'recorded recipe', provenance: { origin: 'recorded', status: 'recorded' }, verificationExpectations: null };
}

/** Read user recipes from a directory (JSON files). Invalid files are reported, never applied. */
export function loadRecipes(directory) {
  const recipes = [], rejected = [];
  if (!directory || !fs.existsSync(directory)) return { recipes, rejected };
  for (const name of fs.readdirSync(directory).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const recipe = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      const validation = validateRecipe(recipe);
      if (validation.ok && recipe.provenance.origin !== 'builtin') recipes.push(recipe); else rejected.push({ file: name, errors: validation.ok ? ['builtin origin is reserved'] : validation.errors });
    } catch (err) { rejected.push({ file: name, errors: [err.message] }); }
  }
  return { recipes, rejected };
}

export function saveRecipe(directory, recipe) {
  const validation = validateRecipe(recipe);
  if (!validation.ok) throw new Error(`Invalid recipe: ${validation.errors.join('; ')}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${recipe.recipeId.slice(7, 23)}.json`);
  fs.writeFileSync(file, JSON.stringify(recipe, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

/** Why a recipe does or does not apply to this IR and host — every condition, with its verdict. */
const hostProfileFor = (host, kind) => (host.constraints.profilesByKind ? host.constraints.profilesByKind[kind] || null : host.constraints.adaptationProfile);

export function explainRecipe(recipe, ir, host) {
  const conditions = [
    { id: 'capability-kind', ok: recipe.applicability.capabilityKind === ir.capability.kind, detail: `${recipe.applicability.capabilityKind} vs ${ir.capability.kind}` },
    { id: 'destination-module-system', ok: recipe.applicability.destination.moduleSystem === host.moduleSystem.value, detail: `${recipe.applicability.destination.moduleSystem} vs ${host.moduleSystem.value}` },
    { id: 'destination-handler-contract', ok: recipe.applicability.destination.handlerContract === host.constraints.handlerContract.value, detail: `${recipe.applicability.destination.handlerContract} vs ${host.constraints.handlerContract.value}` },
    { id: 'destination-framework', ok: !recipe.applicability.destination.framework || recipe.applicability.destination.framework === host.framework.value, detail: `${recipe.applicability.destination.framework || 'any'} vs ${host.framework.value}` },
    // The emitter that can write *this kind* into the host (a host can take one kind and refuse another).
    { id: 'mechanism-implemented-for-host', ok: recipe.mechanism.emitterProfile === hostProfileFor(host, ir.capability.kind), detail: `${recipe.mechanism.emitterProfile} vs ${hostProfileFor(host, ir.capability.kind) || 'none'}` },
    ...(recipe.provenance.origin === 'learned' ? [{ id: 'learned-trust', ok: recipe.provenance.status === 'trusted', detail: `status ${recipe.provenance.status} (${recipe.provenance.supportingObservations} verified run(s), ${recipe.provenance.distinctHosts} host(s))` }] : []),
  ];
  return { applies: conditions.every((c) => c.ok), conditions };
}

/**
 * The recipe to apply for this IR and host. Precedence: built-in, then user, then TRUSTED
 * learned recipes; candidate/observed learned recipes are reported as alternatives only.
 * Applicability is strict — no recipe is forced when none fits.
 */
export function selectRecipe(ir, host, { extra = [], learned = [] } = {}) {
  const trusted = learned.filter((r) => r.provenance?.origin === 'learned' && r.provenance.status === 'trusted');
  const candidates = [...BUILTIN_RECIPES, ...extra, ...trusted];
  const explained = candidates.map((r) => ({ recipe: r, ...explainRecipe(r, ir, host) }));
  const matches = explained.filter((e) => e.applies).map((e) => e.recipe);
  const alternatives = learned.filter((r) => r.provenance?.status !== 'trusted').map((r) => ({ recipeId: r.recipeId, name: r.name, status: r.provenance.status, supportingObservations: r.provenance.supportingObservations }));
  const chosen = matches[0] || null;
  return { recipe: chosen, considered: candidates.length, matches: matches.map((r) => r.recipeId),
    explanation: chosen ? explainRecipe(chosen, ir, host) : { applies: false, conditions: explained.map((e) => ({ recipe: e.recipe.name, failed: e.conditions.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`) })) },
    alternatives };
}
