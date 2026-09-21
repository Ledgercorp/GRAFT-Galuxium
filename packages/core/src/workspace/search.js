// Deterministic search over the Workspace Capability Index.
//
// No model is involved and none is required: filters are structural and the text matcher is
// a fixed vocabulary over fields the index already stores. An agent may later re-rank these
// results or explain them, but it can neither produce them nor change what they say about
// harvestability, transplantability or support.
import { loadIndex, indexPath } from './store.js';

/** Words a person actually types, mapped to structural filters. Deterministic, no model. */
const VOCABULARY = [
  { match: /\bauth(entication|z)?\b|\blogin\b|\bsign[- ]?in\b|\blogged[- ]?in\b|\bsession/i, filter: { capability: 'authentication' }, why: 'authentication wording' },
  // Audience: who signs in. Deterministic phrases, no model.
  { match: /\buser[- ]facing\b|\bend[- ]users?\b|\bhuman\b|\bpeople\b|\bcustomers?\b|\b(users?|people|customers?|humans?) (log|sign)(ging)? ?in\b|\blogin for (users|people)\b|\bsign[- ]?in for (users|people)\b|\buser (login|sign[- ]?in|auth\w*)\b/i, filter: { audience: 'user' }, why: 'user-facing wording' },
  { match: /\bmachine\b|\bservice[- ]auth\w*|\bservice[- ]to[- ]service\b|\bapi authentication\b|\bapi auth\b|\bm2m\b|\bmachine[- ]to[- ]machine\b|\bprogrammatic\b|\bnon[- ]human\b|\bbot\b/i, filter: { audience: 'machine' }, why: 'machine-facing wording' },
  { match: /\bemail\b.*\bpassword\b|\bpassword\b|\bcredential/i, filter: { authSubtype: 'local-password' }, why: 'password wording' },
  { match: /\bcookie\b|\bkeeps? (users? )?logged[- ]?in\b|\bserver session/i, filter: { sessionTransport: 'cookie' }, why: 'cookie/session wording' },
  { match: /\boauth\b|\bsso\b|\bhosted provider\b|\bworkos\b|\bauth0\b|\bclerk\b|\bokta\b/i, filter: { authSubtype: 'hosted-provider-oauth' }, why: 'hosted OAuth wording' },
  { match: /\bpkce\b/i, filter: { authSubtype: 'oauth2-pkce' }, why: 'PKCE wording' },
  { match: /\boidc\b|\bopenid\b/i, filter: { authSubtype: 'oidc' }, why: 'OIDC wording' },
  { match: /\bjwt\b|\bbearer token\b|\bstateless\b/i, filter: { authSubtype: 'jwt-bearer' }, why: 'JWT wording' },
  { match: /\bapi[- ]?key\b|\bstatic (token|secret)\b|\bshared secret\b/i, filter: { authSubtype: 'api-key-static' }, why: 'API-key wording' },
  { match: /\bmachine[- ]to[- ]machine\b|\bm2m\b|\bclient[- ]credentials\b|\bservice account\b/i, filter: { authSubtype: 'm2m-client-credentials' }, why: 'machine-to-machine wording' },
  { match: /\bmagic[- ]?link\b|\bpasswordless\b/i, filter: { authSubtype: 'magic-link' }, why: 'magic-link wording' },
  { match: /\bfeature[- ]?flags?\b|\btoggles?\b|\brollout\b/i, filter: { capability: 'feature-flags' }, why: 'feature-flag wording' },
  { match: /\bcannot (yet )?(transplant|move|reuse)\b|\bunsupported\b|\bnot supported\b|\bblocked\b/i, filter: { transplantSupport: 'unsupported' }, why: 'asked for unsupported capabilities' },
  { match: /\bharvestable\b|\bready to (move|transplant|reuse)\b|\btransplantable\b/i, filter: { harvestable: true }, why: 'asked for harvestable capabilities' },
  { match: /\blocally verifiable\b|\bverif(y|iable) locally\b|\bwithout credentials\b|\boffline\b/i, filter: { localVerification: true }, why: 'asked for locally verifiable capabilities' },
  { match: /\bno external\b|\bself[- ]contained\b|\bwithout (a )?(provider|external service)\b/i, filter: { externalDependence: false }, why: 'asked to exclude external services' },
  { match: /\btypescript\b/i, filter: { language: 'typescript' }, why: 'TypeScript wording' },
  { match: /\bpython\b/i, filter: { language: 'python' }, why: 'Python wording' },
  { match: /\bjavascript\b|\bnode(\.js)?\b/i, filter: { runtime: 'node' }, why: 'Node wording' },
  { match: /\bexpress\b/i, filter: { framework: 'express' }, why: 'Express wording' },
  { match: /\bfastapi\b/i, filter: { framework: 'fastapi' }, why: 'FastAPI wording' },
];

/** Parse free text into structural filters. Unmatched words become a plain substring term. */
export function parseQuery(text) {
  const query = String(text || '');
  const filters = {};
  const reasons = [];
  for (const entry of VOCABULARY) {
    if (!entry.match.test(query)) continue;
    for (const [key, value] of Object.entries(entry.filter)) {
      if (key === 'authSubtype') (filters.authSubtypes ||= []).push(value);
      else filters[key] = value;
    }
    reasons.push(entry.why);
  }
  const terms = query.toLowerCase().match(/[a-z0-9][a-z0-9.-]{2,}/g) || [];
  return { filters, reasons, terms: [...new Set(terms)].slice(0, 12) };
}

const matchesText = (haystack, terms) => terms.filter((t) => haystack.includes(t));

/**
 * Search indexed capabilities. Every result carries the evidence for the match and the
 * current support status, because a highly relevant capability may be entirely unsupported.
 */
export function searchCapabilities(query = {}, { file = indexPath(), index = null, limit = 25 } = {}) {
  const loaded = index || loadIndex({ file });
  const text = typeof query === 'string' ? query : query.text || '';
  const parsed = parseQuery(text);
  const filters = { ...parsed.filters, ...(typeof query === 'string' ? {} : query) };
  delete filters.text;
  const includeNonProduction = filters.includeNonProduction === true;
  delete filters.includeNonProduction;
  filters.includeNonProduction = includeNonProduction;

  const results = [];
  for (const project of loaded.projects) {
    if (project.error) continue;
    // Fixture/test/bench projects are not what a person means by "what have I built".
    if (project.nonProduction && !filters.includeNonProduction) continue;
    for (const capability of project.capabilities || []) {
      const auth = capability.auth || null;
      const subtypes = capability.subtypes || [];
      const why = [];
      const fails = (condition) => condition === false;

      if (filters.capability && capability.capability !== filters.capability) continue;
      if (filters.capability) why.push({ signal: 'capability', detail: `capability is ${capability.capability}` });
      if (filters.authSubtypes?.length) {
        const hit = filters.authSubtypes.filter((s) => subtypes.includes(s));
        if (!hit.length) continue;
        why.push({ signal: 'subtype', detail: `subtype ${hit.join(', ')}` });
      }
      if (filters.audience) {
        const audience = capability.audience || auth?.audience || 'unknown';
        // "user" also admits mixed systems (a person still signs in); "machine" likewise.
        if (!(audience === filters.audience || audience === 'mixed')) continue;
        why.push({ signal: 'audience', detail: `audience is ${audience}` });
      }
      if (filters.sessionTransport && auth?.sessionTransport !== filters.sessionTransport) continue;
      if (filters.sessionTransport) why.push({ signal: 'session-transport', detail: `session transport is ${auth.sessionTransport}` });
      if (filters.credentialAuthority && auth?.credentialAuthority?.kind !== filters.credentialAuthority) continue;
      if (filters.credentialAuthority) why.push({ signal: 'credential-authority', detail: auth.credentialAuthority.detail });
      if (filters.state && capability.state !== filters.state) continue;
      if (typeof filters.harvestable === 'boolean' && capability.harvestable !== filters.harvestable) continue;
      if (typeof filters.harvestable === 'boolean') why.push({ signal: 'harvestable', detail: `harvestable is ${capability.harvestable}` });
      if (filters.transplantSupport && capability.transplantSupport !== filters.transplantSupport) continue;
      if (filters.transplantSupport) why.push({ signal: 'transplant-support', detail: `transplant support is ${capability.transplantSupport}` });
      if (typeof filters.localVerification === 'boolean' && capability.localVerification.feasible !== filters.localVerification) continue;
      if (typeof filters.localVerification === 'boolean') why.push({ signal: 'local-verification', detail: capability.localVerification.feasible ? 'verifiable locally' : capability.localVerification.reasons[0] });
      if (typeof filters.externalDependence === 'boolean') {
        const external = (capability.externalDependencies || []).length > 0 || (project.externalHosts || []).length > 0;
        if (external !== filters.externalDependence) continue;
        why.push({ signal: 'external-services', detail: external ? `depends on ${project.externalHosts.slice(0, 3).join(', ')}` : 'no external service calls found' });
      }
      if (filters.language && project.language !== filters.language) continue;
      if (filters.language) why.push({ signal: 'language', detail: `${project.language} project` });
      if (filters.runtime && project.runtime !== filters.runtime) continue;
      if (filters.runtime) why.push({ signal: 'runtime', detail: `${project.runtime} runtime` });
      if (filters.framework && project.framework !== filters.framework) continue;
      if (filters.framework) why.push({ signal: 'framework', detail: `${project.framework} framework` });
      if (filters.projectId && project.projectId !== filters.projectId) continue;
      if (fails(filters.hasHttpServer) && project.hasHttpServer) continue;
      if (filters.hasHttpServer === true && !project.hasHttpServer) continue;

      const haystack = [project.name, project.relativeRoot, project.language, project.runtime, project.framework,
        capability.capability, ...subtypes, auth?.credentialAuthority?.kind, auth?.sessionTransport,
        ...(capability.signals || []).map((s) => `${s.id} ${s.evidence}`)].filter(Boolean).join(' ').toLowerCase();
      const textHits = matchesText(haystack, parsed.terms);
      if (parsed.terms.length && !why.length && !textHits.length) continue;
      if (textHits.length) why.push({ signal: 'text', detail: `matched ${textHits.slice(0, 4).join(', ')}` });
      if (!why.length && (text || Object.keys(filters).length)) continue;

      // Ranking is deterministic and explainable: structural matches first, then evidence
      // strength, then how usable the capability actually is today.
      const score = why.filter((w) => w.signal !== 'text').length * 10
        + Math.min((capability.signals || []).length, 12)
        + (capability.harvestable ? 6 : 0)
        + ({ TRANSPLANTABLE: 8, HARVESTABLE: 6, STRONGLY_DETECTED: 4, OBSERVED: 2, AMBIGUOUS: 0, UNSUPPORTED: 0 }[capability.state] || 0)
        + (capability.localVerification.feasible ? 3 : 0)
        + textHits.length;

      results.push({
        audience: capability.audience || auth?.audience || null, signalCount: (capability.signals || []).length,
        projectId: project.projectId, project: { name: project.name, root: project.root, relativeRoot: project.relativeRoot,
          repositoryId: project.repositoryId, repository: project.repository?.name, branch: project.repository?.branch,
          language: project.language, runtime: project.runtime, framework: project.framework, moduleSystem: project.moduleSystem,
          entrypoint: project.entrypoint, hasHttpServer: project.hasHttpServer, externalHosts: project.externalHosts },
        capability: capability.capability, implementationForm: capability.implementationForm || 'service', library: capability.library || null, state: capability.state, subtypes,
        auth: auth ? { credentialAuthority: auth.credentialAuthority, sessionTransport: auth.sessionTransport,
          sessionCustody: auth.sessionCustody, sessionStore: auth.sessionStore, sessionDurableAcrossRestart: auth.sessionDurableAcrossRestart } : null,
        flags: capability.flags || null,
        matchedBecause: why, score,
        evidence: (capability.signals || []).slice(0, 12),
        confidence: capability.confidence,
        harvestable: capability.harvestable,
        transplantSupport: capability.transplantSupport,
        asDestination: capability.asDestination,
        localVerification: capability.localVerification,
        blockers: capability.blockers,
        missingSignals: capability.missingSignals,
      });
    }
  }
  // Ties break on evidence strength before names; a name is never a ranking signal on its own.
  results.sort((a, b) => b.score - a.score || b.signalCount - a.signalCount || a.project.name.localeCompare(b.project.name));
  return { query: text || null, filters, interpretedBecause: parsed.reasons, terms: parsed.terms,
    total: results.length, results: results.slice(0, limit),
    indexedAt: loaded.updatedAt, projectsSearched: loaded.projects.length };
}

/** One capability in full, for an inspector view. */
export function getCapability(projectIdValue, capabilityName, { file = indexPath(), index = null } = {}) {
  const loaded = index || loadIndex({ file });
  const project = loaded.projects.find((p) => p.projectId === projectIdValue);
  if (!project) throw new Error(`Unknown project ${projectIdValue}.`);
  const capability = (project.capabilities || []).find((c) => c.capability === capabilityName);
  if (!capability) throw new Error(`${project.name} has no indexed ${capabilityName} capability.`);
  return { project, capability };
}

/** Workspace-level summary: what exists, and how much of it GRAFT can actually act on. */
export function indexSummary({ file = indexPath(), index = null } = {}) {
  const loaded = index || loadIndex({ file });
  const projects = loaded.projects.filter((p) => !p.error);
  const capabilities = projects.flatMap((p) => (p.capabilities || []).map((c) => ({ project: p, capability: c })));
  const tally = (list, key) => list.reduce((out, item) => { const k = key(item); out[k] = (out[k] || 0) + 1; return out; }, {});
  return {
    indexVersion: loaded.indexVersion, updatedAt: loaded.updatedAt, roots: loaded.roots,
    projects: projects.length, errors: loaded.projects.filter((p) => p.error).length,
    repositories: new Set(projects.map((p) => p.repositoryId)).size,
    // Counted once per repository: a monorepo's 18 subprojects all report the same checkouts.
    worktrees: [...new Map(projects.map((p) => [p.repositoryId, p.repository?.worktrees?.length || 1])).values()]
      .reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    languages: tally(projects, (p) => p.language), runtimes: tally(projects, (p) => p.runtime),
    servers: projects.filter((p) => p.hasHttpServer).length,
    capabilities: capabilities.length,
    byCapability: tally(capabilities, (c) => c.capability.capability),
    byState: tally(capabilities, (c) => c.capability.state),
    harvestable: capabilities.filter((c) => c.capability.harvestable).length,
    transplantable: capabilities.filter((c) => c.capability.transplantSupport === 'supported').length,
    authSubtypes: tally(capabilities.flatMap((c) => c.capability.subtypes || []), (s) => s),
  };
}
