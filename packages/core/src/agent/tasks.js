// Agent task contracts and the authority firewall.
//
// The firewall is structural, not a prompt instruction. Two rules make it work:
//
//   1. Allow-list projection. Every task declares the exact fields and types its response
//      may contain. A response is rebuilt field by field from that declaration, so anything
//      a model invents is dropped before it can reach a caller.
//   2. Authority names are fatal. No task declares a field that maps to a GRAFT verdict, and
//      if a response mentions one anywhere — at any depth, under any casing or spelling
//      variant — the whole response is rejected rather than cleaned. A model must not be able
//      to nudge a verdict even by accident.
//
// Candidates are referenced by opaque id only. Rankings are re-resolved against GRAFT's own
// index, so even the candidate data a user finally sees comes from GRAFT, never from a model.
export const TASK_VERSION = '1.0.0';

/**
 * Field names that belong to deterministic GRAFT alone. Compared after stripping non-alphanumerics
 * and lowercasing, so `is_verified`, `Verified`, `over-ride_refusal` all collapse to the same key.
 */
export const AUTHORITY_FIELDS = Object.freeze(['verdict', 'verified', 'isverified', 'markverified', 'verification', 'proof', 'receipt',
  'pass', 'passed', 'fail', 'failed', 'inconclusive', 'testoutcome', 'testresult', 'outcome',
  'compatible', 'compatibility', 'compatibilitystatus', 'forcecompatibility', 'iscompatible',
  'harvestable', 'transplantable', 'transplantsupport', 'supported', 'issupported',
  'refusal', 'overriderefusal', 'override', 'bypass', 'approve', 'approved', 'authorized',
  'atlasresult', 'atlasoutcome', 'repairsucceeded', 'repaired', 'emitterapplicable', 'applicable']);

const normalise = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
export const isAuthorityField = (name) => AUTHORITY_FIELDS.includes(normalise(name));

const str = (max = 600) => ({ type: 'string', max });
const enumOf = (values) => ({ type: 'enum', values });
const arrayOf = (item, max = 20) => ({ type: 'array', item, max });
const objectOf = (fields) => ({ type: 'object', fields });

/**
 * The complete task surface. There is deliberately no task for deciding a verdict, marking
 * something verified, or forcing compatibility: those cannot be requested because they do
 * not exist here.
 */
export const TASKS = Object.freeze({
  interpretCapabilityRequest: {
    description: 'Turn a natural-language request into structural search filters GRAFT will run itself.',
    requiredScopes: ['workspace:metadata', 'capability:metadata'],
    response: objectOf({
      capability: enumOf(['authentication', 'feature-flags', 'unknown']),
      authSubtypes: arrayOf(enumOf(['local-password', 'cookie-session', 'hosted-provider-oauth', 'oidc', 'oauth2-pkce', 'jwt-bearer',
        'api-key-static', 'm2m-client-credentials', 'magic-link', 'custom-unknown']), 10),
      sessionTransport: enumOf(['cookie', 'bearer-header', 'none']),
      credentialAuthority: enumOf(['local', 'hosted-provider', 'shared-secret', 'external-idp', 'unknown']),
      audience: enumOf(['user', 'machine', 'mixed', 'unknown']),
      runtime: enumOf(['node', 'python', 'unknown']),
      language: enumOf(['javascript', 'typescript', 'python', 'unknown']),
      wantsLocallyVerifiable: { type: 'boolean' },
      terms: arrayOf(str(60), 12),
      rationale: str(600),
    }),
  },
  // Laboratory 0.1: turn a fuzzy description of a new application into suggested capability goals.
  // Suggestions only: GRAFT decides whether any such capability exists, is usable, or is chosen.
  interpretBlueprintIntent: {
    description: 'Suggest which capability goals a described new application needs, and questions that would sharpen the idea.',
    requiredScopes: ['workspace:metadata', 'capability:metadata'],
    response: objectOf({
      goals: arrayOf(objectOf({ label: str(60), category: enumOf(['authentication', 'organizations', 'billing', 'file-uploads', 'roles', 'notifications', 'admin', 'search', 'feature-flags', 'unknown']), required: { type: 'boolean' }, rationale: str(300) }), 12),
      questions: arrayOf(str(200), 8),
      dependencyHints: arrayOf(objectOf({ from: str(60), to: str(60), reason: str(200) }), 12),
      notes: str(800),
    }),
  },
  explainAssemblyPlan: {
    description: 'Explain an assembly plan GRAFT already built: what the steps mean, why it is blocked, host trade-offs. Advisory only.',
    requiredScopes: ['workspace:metadata', 'capability:metadata'],
    response: objectOf({
      explanation: str(1200),
      blockerExplanations: arrayOf(objectOf({ blocker: str(120), explanation: str(400), suggestion: str(300) }), 12),
      hostSuggestion: objectOf({ architectureId: str(60), rationale: str(400) }),
      orderingRationale: str(600),
      tradeoffs: arrayOf(str(300), 8),
    }),
  },
  rankCapabilityCandidates: {
    description: 'Propose an ordering of candidates GRAFT already found, by candidate id.',
    requiredScopes: ['capability:metadata', 'capability:rank'],
    response: objectOf({
      ranking: arrayOf(objectOf({ candidateId: str(40), reason: str(400) }), 25),
      notes: str(800),
    }),
  },
  explainCandidate: {
    description: 'Explain in words why a candidate might or might not suit a destination.',
    requiredScopes: ['capability:metadata', 'capability:explain'],
    response: objectOf({ explanation: str(1600), strengths: arrayOf(str(240), 8), concerns: arrayOf(str(240), 8) }),
  },
  explainArchitectureMismatch: {
    description: 'Describe the architectural distance between a source capability and a destination.',
    requiredScopes: ['capability:metadata', 'capability:explain'],
    response: objectOf({ explanation: str(1600), differences: arrayOf(objectOf({ dimension: str(60), detail: str(300) }), 12) }),
  },
  suggestRecipe: {
    description: 'Suggest a transformation recipe. GRAFT decides whether any recipe applies.',
    requiredScopes: ['capability:metadata', 'recipe:suggest'],
    response: objectOf({ name: str(120), rationale: str(800),
      transformations: arrayOf(objectOf({ kind: str(60), description: str(300) }), 12) }),
  },
  suggestRepair: {
    description: 'Suggest a repair hypothesis. GRAFT decides whether a repair applies and whether it worked.',
    requiredScopes: ['capability:metadata', 'repair:suggest'],
    response: objectOf({ hypothesis: str(600), proposedChange: str(800), affectedFileHints: arrayOf(str(200), 8), rationale: str(800) }),
  },
});

export class AuthorityViolation extends Error {
  constructor(fields) {
    super(`The agent response was rejected: it contained ${fields.length} field(s) reserved for GRAFT (${fields.join(', ')}). Verdicts, compatibility and support status are decided by GRAFT alone.`);
    this.name = 'AuthorityViolation';
    this.code = 'agent-authority-violation';
    this.fields = fields;
  }
}

/** Every key in a response, at any depth, including keys inside arrays of objects. */
function collectKeys(value, out = [], depth = 0) {
  if (depth > 12 || !value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) collectKeys(item, out, depth + 1); return out; }
  for (const [key, child] of Object.entries(value)) { out.push(key); collectKeys(child, out, depth + 1); }
  return out;
}

function coerce(spec, value, trail, dropped) {
  if (spec.type === 'string') {
    if (typeof value !== 'string') { dropped.push(`${trail}: expected string`); return undefined; }
    return value.length > spec.max ? value.slice(0, spec.max) : value;
  }
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') { dropped.push(`${trail}: expected boolean`); return undefined; }
    return value;
  }
  if (spec.type === 'enum') {
    if (!spec.values.includes(value)) { dropped.push(`${trail}: "${String(value).slice(0, 40)}" is not one of ${spec.values.join('|')}`); return undefined; }
    return value;
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) { dropped.push(`${trail}: expected array`); return undefined; }
    const items = value.slice(0, spec.max).map((item, i) => coerce(spec.item, item, `${trail}[${i}]`, dropped)).filter((v) => v !== undefined);
    return items;
  }
  if (spec.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { dropped.push(`${trail}: expected object`); return undefined; }
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(spec.fields, key)) { dropped.push(`${trail ? `${trail}.` : ''}${key}: not part of this task's response`); continue; }
      const coerced = coerce(spec.fields[key], child, `${trail ? `${trail}.` : ''}${key}`, dropped);
      if (coerced !== undefined) out[key] = coerced;
    }
    return out;
  }
  dropped.push(`${trail}: unknown field specification`);
  return undefined;
}

/**
 * Project a raw provider response onto a task's declared shape.
 *
 * Rejects outright — never silently cleans — if any authority-reserved name appears anywhere
 * in the response. Everything that survives is a value the task explicitly declared.
 */
export function projectResponse(taskId, raw) {
  const task = TASKS[taskId];
  if (!task) throw new Error(`Unknown agent task "${taskId}".`);
  const offending = [...new Set(collectKeys(raw).filter(isAuthorityField))];
  if (offending.length) throw new AuthorityViolation(offending);
  const dropped = [];
  const value = coerce(task.response, raw, '', dropped);
  return { value: value ?? {}, dropped };
}

/** The instruction text a provider is given. Advisory framing is stated, then enforced in code. */
export function taskPrompt(taskId, context) {
  const task = TASKS[taskId];
  const fields = Object.entries(task.response.fields).map(([name, spec]) => {
    const shape = spec.type === 'enum' ? spec.values.join(' | ')
      : spec.type === 'array' ? `array of ${spec.item.type === 'enum' ? spec.item.values.join(' | ') : spec.item.type}`
        : spec.type;
    return `  "${name}": ${shape}`;
  }).join('\n');
  return [
    'You are an advisory component inside GRAFT, a software-capability transplantation tool.',
    'GRAFT alone determines whether a capability exists, whether it is harvestable, whether a transplant is compatible, whether it is permitted, and whether it succeeded.',
    'You interpret, rank and explain. You never decide outcomes, and any response asserting a verdict, compatibility or support status is discarded in full.',
    '',
    `Task: ${task.description}`,
    '',
    'Reply with JSON only, using exactly these fields (omit any you cannot answer):',
    '{', fields, '}',
    '',
    'Context (structural metadata produced by GRAFT):',
    JSON.stringify(context, null, 2),
  ].join('\n');
}
