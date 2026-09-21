// GRAFT Engine 1.0 — the proprietary core. Everything here is derived deterministically
// from the organ manifest (and, for planning, the destination fingerprint), so an organ can
// carry its genome, graph, IR and verification contract and have them re-derived and
// checked at any time. Nothing in the engine can say VERIFIED; that stays with verify/.
import { buildCapabilityGenome, validateCapabilityGenome } from './genome.js';
import { buildCapabilityGraph, validateCapabilityGraph } from './graph.js';
import { buildGraftIR, validateGraftIR } from './ir.js';
import { buildVerificationContract, validateVerificationContract } from './verification-contract.js';
import { buildHostModel } from './host.js';
import { selectRecipe, BUILTIN_RECIPES } from './recipes.js';
import { analyzeTransplant } from './planner.js';
import { loadAtlas, atlasDir } from './atlas.js';
import { deriveLearnedRecipes } from './learned-recipes.js';

export const GRAFT_ENGINE_VERSION = '1.1.0';
// The stored organ artifact format. 1.0.0 bundles (genome/graph/ir/contract) remain valid;
// 1.1.0 adds an explicit artifactVersion, per-artifact schema versions and recipe hints.
export const ENGINE_ARTIFACT_VERSION = '1.1.0';
const ACCEPTED_ARTIFACT_VERSIONS = ['1.0.0', '1.1.0'];

/** The engine artifacts an organ carries: genome, graph, IR and verification contract. */
export function buildEngineArtifacts(manifest) {
  const genome = buildCapabilityGenome(manifest);
  const graph = buildCapabilityGraph(genome);
  const ir = buildGraftIR(genome, manifest);
  const verificationContract = buildVerificationContract(manifest, ir);
  return { engineVersion: GRAFT_ENGINE_VERSION, artifactVersion: ENGINE_ARTIFACT_VERSION,
    schema: { genome: genome.genomeVersion, graph: graph.graphVersion, ir: ir.irVersion, verificationContract: verificationContract.contractVersion },
    genome, graph, ir, verificationContract,
    // Which built-in recipes could apply to this kind (host-independent hints; selection happens at plan time).
    recipeHints: BUILTIN_RECIPES.filter((r) => r.applicability.capabilityKind === genome.identity.kind).map((r) => ({ recipeId: r.recipeId, name: r.name, destination: r.applicability.destination, origin: r.provenance.origin })) };
}

/** Structural validation plus, when the manifest is given, agreement with a fresh derivation. */
export function validateEngineArtifacts(bundle, manifest = null) {
  const errors = [];
  if (!bundle || typeof bundle.engineVersion !== 'string') return { ok: false, errors: ['engineVersion is required'] };
  const artifactVersion = bundle.artifactVersion || (bundle.engineVersion === '1.0.0' ? '1.0.0' : null);
  if (!ACCEPTED_ARTIFACT_VERSIONS.includes(artifactVersion)) return { ok: false, errors: [`unsupported engine artifact version ${bundle.artifactVersion || bundle.engineVersion}; accepted: ${ACCEPTED_ARTIFACT_VERSIONS.join(', ')}`] };
  if (artifactVersion === '1.1.0') {
    if (!bundle.schema || typeof bundle.schema !== 'object') errors.push('schema versions are required in artifact 1.1.0');
    if (!Array.isArray(bundle.recipeHints)) errors.push('recipeHints must be an array in artifact 1.1.0');
  }
  for (const [name, check] of [['genome', validateCapabilityGenome], ['graph', validateCapabilityGraph], ['ir', validateGraftIR], ['verificationContract', validateVerificationContract]]) {
    const result = check(bundle[name]);
    if (!result.ok) errors.push(...result.errors.map((e) => `${name}: ${e}`));
  }
  if (manifest && errors.length === 0) {
    const fresh = buildEngineArtifacts(manifest);
    for (const [name, key] of [['genome', 'genomeId'], ['graph', 'graphId'], ['ir', 'irId'], ['verificationContract', 'contractId']]) {
      if (fresh[name][key] !== bundle[name][key]) errors.push(`${name}.${key} disagrees with the manifest (stored ${bundle[name][key]}, derived ${fresh[name][key]})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Engine analysis for one destination: host model, recipe selection and the semantic plan analysis. */
export function analyzeForHost(manifest, destFp, { emission = null, compatibility = null, extraRecipes = [], atlas = null, context = null } = {}) {
  const artifacts = context?.artifacts || buildEngineArtifacts(manifest);
  const host = context?.host || buildHostModel(destFp);
  let learned = [];
  if (atlas) { try { learned = deriveLearnedRecipes(loadAtlas(typeof atlas === 'string' && atlas !== 'local' ? { directory: atlas } : { directory: atlasDir() })); } catch { learned = []; } }
  const selection = context?.selection || selectRecipe(artifacts.ir, host, { extra: extraRecipes, learned });
  const { recipe, matches, considered, explanation, alternatives } = selection;
  // The proof contract carries the applied recipe's expectations (never relaxing the verdict rule).
  const verificationContract = buildVerificationContract(manifest, artifacts.ir, { recipe });
  const analysis = analyzeTransplant({ ...artifacts, host, recipe, emission, compatibility, verificationContract, atlas });
  return { ...artifacts, verificationContract, host, recipe, recipeSelection: { matches, considered, explanation, alternatives, learnedRecipes: learned.map((r) => ({ recipeId: r.recipeId, name: r.name, status: r.provenance.status, supportingObservations: r.provenance.supportingObservations })) }, analysis };
}

export { buildCapabilityGenome, validateCapabilityGenome } from './genome.js';
export { buildCapabilityGraph, validateCapabilityGraph, neighbors, graphStats } from './graph.js';
export { buildHostModel, validateHostModel } from './host.js';
export { buildGraftIR, validateGraftIR } from './ir.js';
export { buildVerificationContract, evaluateVerificationContract, validateVerificationContract } from './verification-contract.js';
export { BUILTIN_RECIPES, validateRecipe, loadRecipes, saveRecipe, selectRecipe, explainRecipe } from './recipes.js';
export { deriveLearnedRecipes, promotionStatus, applicableLearned, PROMOTION } from './learned-recipes.js';
export { scoreEntry } from './atlas.js';
export { buildAtlasEntry, validateAtlasEntry, recordAtlasEntry, loadAtlas, queryAtlas, atlasDir } from './atlas.js';
export { analyzeTransplant } from './planner.js';
export { semanticSummary, renderSemanticSummary, semanticOutcome } from './semantic.js';
export { buildSemanticChangeset, renderSemanticChangeset, CHANGESET_VERSION } from './changeset.js';
export { classifyFailure, proposeRepair, applyRepair, repairAndVerify, MAX_REPAIR_ATTEMPTS, REPAIR_CLASSES } from './repair.js';
export { lowerToEmission, validateEmissionSpec, EMISSION_SPEC_VERSION } from './lower.js';
