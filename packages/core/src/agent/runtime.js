// GRAFT Agent Runtime.
//
// An agent is a replaceable reasoning layer bolted to the outside of a deterministic engine.
// It may interpret what a person meant, order candidates GRAFT already found, and explain
// things in words. It may not decide anything.
//
// The runtime is the only path from GRAFT to a provider, and it enforces, in this order:
//   permission scopes  →  context sanitization  →  send  →  authority firewall  →  advice
//
// Every result is an `AgentAdvice`: a value with no field that maps to a GRAFT verdict, and
// candidate references that are opaque ids GRAFT re-resolves against its own index.
import { DEFAULT_GRANT, requireScopes, escalationFor, createGrant, SCOPES, DEFAULT_SCOPES, PermissionError } from './permissions.js';
import { TASKS, projectResponse, taskPrompt, AuthorityViolation, isAuthorityField, AUTHORITY_FIELDS, TASK_VERSION } from './tasks.js';
import { adapterFor, extractJson, PROVIDER_IDS, validateEndpoint } from './providers.js';
import { assertSendable, candidateContext, projectContext, capabilityContext, SANITIZER_VERSION } from './sanitize.js';
import { createCustodyLedger, DATA_CLASSES, EGRESS_DECISIONS, requestEgress } from './data-boundary.js';

export const RUNTIME_VERSION = '1.0.0';
export { PROVIDER_IDS, SCOPES, DEFAULT_SCOPES, createGrant, PermissionError, AuthorityViolation, isAuthorityField, AUTHORITY_FIELDS };
export { projectContext, capabilityContext, candidateContext, assertSendable };

/**
 * Configure an agent. Credentials are supplied by the caller and held only for the lifetime
 * of this object; nothing here writes them to disk, logs them, or returns them.
 */
export function createAgentRuntime({ provider, apiKey = null, model = null, endpoint = null, grant = DEFAULT_GRANT,
  timeoutMs = 30000, maxTokens = 2048, fetchImpl = null, onRequest = null, dataBoundary = requestEgress,
  custodyLedger = null } = {}) {
  const adapter = adapterFor(provider);
  const ledger = custodyLedger || createCustodyLedger({ persist: true });
  if (adapter.requiresEndpoint && !endpoint) throw new Error(`The ${adapter.label} provider needs an endpoint URL.`);
  if (endpoint) validateEndpoint(endpoint);
  if (!apiKey && !adapter.requiresEndpoint) throw new Error(`The ${adapter.label} provider needs an API key. GRAFT stores it only where you tell it to and never sends it anywhere else.`);

  const describe = () => ({ provider: adapter.id, label: adapter.label, model: model || adapter.defaultModel,
    endpoint: endpoint || adapter.defaultEndpoint, scopes: [...grant.scopes], runtimeVersion: RUNTIME_VERSION });

  /**
   * Run one advisory task. Throws PermissionError when the grant is too narrow, and
   * AuthorityViolation when the model tried to assert something only GRAFT may assert.
   */
  async function run(taskId, context, { extraScopes = [], egress = {} } = {}) {
    const task = TASKS[taskId];
    if (!task) throw new Error(`Unknown agent task "${taskId}". Available: ${Object.keys(TASKS).join(', ')}.`);
    requireScopes(grant, [...task.requiredScopes, ...extraScopes]);

    // The sanitizer is the door; this is the lock on it. A caller cannot pass raw source or
    // secrets by mistake, because anything unsafe refuses to be sent at all.
    const payload = assertSendable(context);
    const custody = dataBoundary({
      provider: adapter.id,
      operation: `agent:${taskId}`,
      destination: endpoint || adapter.defaultEndpoint || adapter.id,
      dataClass: egress.dataClass || DATA_CLASSES.METADATA,
      sourceDerived: Boolean(egress.sourceDerived),
      policyContext: egress.policyContext || {},
      input: payload,
    });
    ledger.record(custody);
    if (custody.decision !== EGRESS_DECISIONS.ALLOW) {
      throw Object.assign(new Error(`Data Boundary denied ${taskId}: ${custody.reason}.`), { code: 'egress-denied', custody: custody.event });
    }
    const prompt = taskPrompt(taskId, payload);
    const started = process.hrtime.bigint();
    onRequest?.({ task: taskId, promptBytes: Buffer.byteLength(prompt, 'utf8'), contextKeys: Object.keys(payload || {}) });

    const raw = await adapter.complete({ prompt, apiKey, model, endpoint, timeoutMs, maxTokens, fetchImpl });
    const parsed = extractJson(raw.text);
    const { value, dropped } = projectResponse(taskId, parsed);
    return {
      adviceVersion: RUNTIME_VERSION, taskVersion: TASK_VERSION, sanitizerVersion: SANITIZER_VERSION,
      task: taskId, advisory: true, authoritative: false,
      value, droppedFields: dropped,
      provider: adapter.id, model: raw.model,
      usage: raw.usage || null,
      custody: custody.event,
      promptBytes: Buffer.byteLength(prompt, 'utf8'),
      elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
    };
  }

  return { describe, run, grant, provider: adapter.id,
    can: (taskId) => !escalationFor(grant, TASKS[taskId]?.requiredScopes || []),
    escalationFor: (taskId, extra = []) => escalationFor(grant, [...(TASKS[taskId]?.requiredScopes || []), ...extra]),
    custodyEvents: () => ledger.list() };
}

/**
 * Apply an agent's proposed ordering to GRAFT's own results.
 *
 * The agent supplies ids and reasons. Every candidate object returned here comes from the
 * deterministic result set: an id GRAFT does not recognise is discarded, a candidate the
 * agent forgot keeps its deterministic position at the end, and no field of a result is ever
 * replaced by model output. The worst an agent can do is order things unhelpfully.
 */
export function applyRanking(results, advice) {
  const ranking = advice?.value?.ranking || [];
  const byId = new Map(results.map((result, index) => [`c${index + 1}`, result]));
  const ordered = [];
  const used = new Set();
  const ignored = [];
  for (const entry of ranking) {
    const candidate = byId.get(entry?.candidateId);
    if (!candidate || used.has(entry.candidateId)) { ignored.push(entry?.candidateId ?? null); continue; }
    used.add(entry.candidateId);
    // `agentReason` is prose attached beside the result; it replaces nothing GRAFT decided.
    ordered.push({ ...candidate, agentRank: ordered.length + 1, agentReason: typeof entry.reason === 'string' ? entry.reason : null });
  }
  for (const [id, candidate] of byId) if (!used.has(id)) ordered.push({ ...candidate, agentRank: null, agentReason: null });
  return { results: ordered, rankedByAgent: used.size > 0, ignoredCandidateIds: ignored.filter(Boolean), notes: typeof advice?.value?.notes === 'string' ? advice.value.notes : null };
}

/** Filters an agent proposed, re-validated against what the deterministic search accepts. */
export function filtersFromAdvice(advice) {
  const value = advice?.value || {};
  const filters = {};
  if (value.capability && value.capability !== 'unknown') filters.capability = value.capability;
  if (Array.isArray(value.authSubtypes) && value.authSubtypes.length) filters.authSubtypes = value.authSubtypes;
  if (value.sessionTransport && value.sessionTransport !== 'none') filters.sessionTransport = value.sessionTransport;
  if (value.credentialAuthority && value.credentialAuthority !== 'unknown') filters.credentialAuthority = value.credentialAuthority;
  if (value.audience && value.audience !== 'unknown') filters.audience = value.audience;
  if (value.runtime && value.runtime !== 'unknown') filters.runtime = value.runtime;
  if (value.language && value.language !== 'unknown') filters.language = value.language;
  if (value.wantsLocallyVerifiable === true) filters.localVerification = true;
  return filters;
}
