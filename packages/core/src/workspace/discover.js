// Natural-language capability discovery.
//
// The deterministic search is the product; an agent is an optional improvement to it. The
// flow is the same either way, and every authoritative field in the answer — what exists,
// what kind it is, whether it is harvestable, whether it can be transplanted, whether it can
// be verified locally — comes from GRAFT's index, never from a model.
//
//   request → (agent interprets, optional) → deterministic query → candidates
//           → (agent ranks/explains, optional) → GRAFT re-resolves and returns
import { searchCapabilities, parseQuery } from './search.js';
import { applyRanking, filtersFromAdvice, candidateContext } from '../agent/runtime.js';

export const DISCOVERY_VERSION = '1.0.0';

/**
 * Answer a capability request.
 *
 * `agent` is optional. Without it the answer is the deterministic result set, complete and
 * explained — an absent agent degrades the ranking, never the discovery.
 */
export async function discoverCapabilityCandidates(request, { agent = null, file, index = null, limit = 10, explain = false } = {}) {
  const started = process.hrtime.bigint();
  const text = String(request || '').trim();
  const steps = [];
  let filters = {};
  let interpretation = null;

  if (agent) {
    try {
      const advice = await agent.run('interpretCapabilityRequest', {
        request: text,
        // Only the shape of the workspace, so the model can pick sensible filters.
        workspace: (index?.projects || []).slice(0, 40).map((p) => ({ language: p.language, runtime: p.runtime, framework: p.framework,
          capabilities: (p.capabilities || []).map((c) => ({ capability: c.capability, subtypes: c.subtypes })) })),
      });
      filters = filtersFromAdvice(advice);
      interpretation = { source: 'agent', filters, rationale: advice.value.rationale || null, droppedFields: advice.droppedFields, usage: advice.usage, elapsedMs: advice.elapsedMs };
      steps.push({ step: 'interpret', by: 'agent', ok: true });
    } catch (err) {
      // An agent failure is never a discovery failure.
      interpretation = { source: 'deterministic', error: err.message, code: err.code || null };
      steps.push({ step: 'interpret', by: 'agent', ok: false, reason: err.message });
    }
  }
  if (!interpretation || interpretation.source !== 'agent') {
    const parsed = parseQuery(text);
    interpretation = { ...(interpretation || {}), source: 'deterministic', filters: parsed.filters, rationale: parsed.reasons.join('; ') || null };
    filters = {};
    steps.push({ step: 'interpret', by: 'deterministic', ok: true });
  }

  // GRAFT always runs its own query. Agent filters narrow it; they never bypass it.
  const deterministic = searchCapabilities({ text, ...filters }, { file, index, limit: Math.max(limit, 25) });
  steps.push({ step: 'search', by: 'graft', ok: true, total: deterministic.total });
  let candidates = deterministic.results.slice(0, limit);
  let ranking = { rankedByAgent: false, notes: null, ignoredCandidateIds: [] };
  let explanation = null;

  if (agent && candidates.length > 1) {
    try {
      const advice = await agent.run('rankCapabilityCandidates', {
        request: text,
        candidates: candidates.map((result, i) => candidateContext(result, i + 1)),
      });
      const applied = applyRanking(candidates, advice);
      candidates = applied.results;
      ranking = { rankedByAgent: applied.rankedByAgent, notes: applied.notes, ignoredCandidateIds: applied.ignoredCandidateIds, droppedFields: advice.droppedFields, usage: advice.usage, elapsedMs: advice.elapsedMs };
      steps.push({ step: 'rank', by: 'agent', ok: true, ranked: applied.rankedByAgent });
    } catch (err) {
      steps.push({ step: 'rank', by: 'agent', ok: false, reason: err.message });
      ranking = { rankedByAgent: false, notes: null, ignoredCandidateIds: [], error: err.message, code: err.code || null };
    }
  }

  if (agent && explain && candidates.length) {
    try {
      const advice = await agent.run('explainCandidate', { request: text, candidate: candidateContext(candidates[0], 1) });
      explanation = { text: advice.value.explanation || null, strengths: advice.value.strengths || [], concerns: advice.value.concerns || [], advisory: true };
      steps.push({ step: 'explain', by: 'agent', ok: true });
    } catch (err) { steps.push({ step: 'explain', by: 'agent', ok: false, reason: err.message }); }
  }

  return {
    discoveryVersion: DISCOVERY_VERSION,
    request: text,
    agentConfigured: Boolean(agent),
    agent: agent ? agent.describe() : null,
    interpretation,
    ranking,
    explanation,
    steps,
    // Everything below is GRAFT's, and is what the UI must show as fact.
    total: deterministic.total,
    candidates,
    authority: 'Capability existence, classification, harvestability, transplant support and verification are determined by GRAFT. Agent output is advisory ordering and prose only.',
    indexedAt: deterministic.indexedAt,
    projectsSearched: deterministic.projectsSearched,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
  };
}
