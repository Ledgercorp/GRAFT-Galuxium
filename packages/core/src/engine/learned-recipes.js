// Learned recipes: reusable recipe candidates derived from Compatibility Atlas history.
//
// Only VERIFIED observations contribute positively. FAILED, NEEDS_REVIEW and refused
// observations in the same signature count against promotion and can never become a trusted
// recipe by themselves. Promotion is explicit: candidate (one verified run) -> observed (two
// verified runs, no failures) -> trusted (three verified runs from at least two distinct
// hosts, no failures). Built-in recipes are separate and always take precedence.
import { stableHash, canonicalSerialize } from '../capability/contract.js';
import { BUILTIN_RECIPES, RECIPE_VERSION, validateRecipe } from './recipes.js';

export const PROMOTION = Object.freeze({
  candidate: { verifiedRuns: 1 },
  observed: { verifiedRuns: 2, failedRuns: 0 },
  trusted: { verifiedRuns: 3, distinctHosts: 2, failedRuns: 0 },
});
const CATEGORY_TO_KIND = Object.freeze({ authentication: 'session-auth', 'feature-flags': 'feature-flags' });
const family = (a) => ({ framework: a?.framework || 'unknown', moduleSystem: a?.moduleSystem || 'unknown', handlerContract: a?.handlerContract || 'unknown', persistence: a?.persistence || 'unknown' });

export function promotionStatus({ verifiedRuns, failedRuns, distinctHosts }) {
  if (verifiedRuns >= PROMOTION.trusted.verifiedRuns && distinctHosts >= PROMOTION.trusted.distinctHosts && failedRuns === PROMOTION.trusted.failedRuns) return 'trusted';
  if (verifiedRuns >= PROMOTION.observed.verifiedRuns && failedRuns === PROMOTION.observed.failedRuns) return 'observed';
  if (verifiedRuns >= PROMOTION.candidate.verifiedRuns) return 'candidate';
  return null;
}

export function deriveLearnedRecipes(entries) {
  const groups = new Map();
  for (const e of entries) {
    const kind = e.capabilityKind || CATEGORY_TO_KIND[e.capabilityCategory] || null;
    if (!kind || !e.adaptations?.length) continue;
    const key = canonicalSerialize({ kind, s: family(e.sourceArchitecture), d: family(e.destinationArchitecture), a: [...e.adaptations].sort() });
    if (!groups.has(key)) groups.set(key, { kind, source: family(e.sourceArchitecture), destination: family(e.destinationArchitecture), adaptations: [...e.adaptations].sort(), verified: [], failed: [], needsReview: [], refused: [], hosts: new Set(), ranges: new Set() });
    const g = groups.get(key);
    const verdict = e.verification?.verdict || null;
    if (e.result === 'refused') g.refused.push(e.entryId);
    else if (verdict === 'VERIFIED') { g.verified.push(e.entryId); if (e.hostId) g.hosts.add(e.hostId); const r = e.destinationArchitecture?.runtime?.range; if (r) g.ranges.add(r); }
    else if (verdict === 'FAILED') g.failed.push(e.entryId);
    else g.needsReview.push(e.entryId);
  }
  const recipes = [];
  for (const g of groups.values()) {
    const status = promotionStatus({ verifiedRuns: g.verified.length, failedRuns: g.failed.length, distinctHosts: g.hosts.size });
    if (!status) continue; // nothing verified: no positive recipe, ever
    const profile = g.adaptations[0];
    const template = BUILTIN_RECIPES.find((r) => r.applicability.capabilityKind === g.kind && r.mechanism.emitterProfile === profile);
    if (!template) continue; // the atlas cannot invent a mechanism the engine does not implement
    const total = g.verified.length + g.failed.length + g.needsReview.length;
    const recipe = {
      recipeVersion: RECIPE_VERSION,
      name: `learned: ${g.kind} ${g.source.moduleSystem}/${g.source.handlerContract} → ${profile}`,
      applicability: { capabilityKind: g.kind, source: g.source, destination: { moduleSystem: template.applicability.destination.moduleSystem, handlerContract: template.applicability.destination.handlerContract, framework: template.applicability.destination.framework, persistence: g.destination.persistence } },
      transformations: template.transformations, dependencySubstitutions: template.dependencySubstitutions,
      verificationExpectations: { ...template.verificationExpectations, minimumEvidence: `${g.verified.length} verified run(s)` },
      mechanism: { emitterProfile: profile },
      provenance: { origin: 'learned', status, engine: 'graft-core',
        sourceArchitecture: g.source, destinationArchitecture: g.destination, capabilityKind: g.kind, adaptations: g.adaptations,
        evidence: { verified: g.verified, failed: g.failed, needsReview: g.needsReview, refused: g.refused }, supportingObservations: g.verified.length, distinctHosts: g.hosts.size,
        confidence: { basis: 'observed', value: Math.round((g.verified.length / Math.max(1, total)) * 100) / 100, sampleSize: total },
        versionConstraints: g.ranges.size === 1 ? { destinationRuntime: [...g.ranges][0] } : null,
        thresholds: PROMOTION },
    };
    recipe.recipeId = stableHash({ recipeVersion: recipe.recipeVersion, applicability: recipe.applicability, transformations: recipe.transformations, dependencySubstitutions: recipe.dependencySubstitutions, mechanism: recipe.mechanism });
    if (validateRecipe(recipe).ok) recipes.push(recipe);
  }
  return recipes.sort((a, b) => b.provenance.supportingObservations - a.provenance.supportingObservations || a.name.localeCompare(b.name));
}

/** Only trusted learned recipes may be applied; candidates and observed ones are surfaced, never used. */
export const applicableLearned = (recipes) => recipes.filter((r) => r.provenance.origin === 'learned' && r.provenance.status === 'trusted');
