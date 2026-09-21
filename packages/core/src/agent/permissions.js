// Agent permission scopes.
//
// An agent is a guest in someone's workspace. The default grant is metadata: enough to
// interpret a request and rank candidates GRAFT already found, and nothing more. Raw source
// access is not default, running commands is not grantable to an agent at all, and modifying
// a destination is not something an agent can be given — those belong to GRAFT and the user.
export const PERMISSION_VERSION = '1.0.0';

/**
 * Every scope an agent task can require. `grantable: false` means no configuration can
 * give it to an agent: the capability does not exist on this side of the boundary.
 */
export const SCOPES = Object.freeze({
  'workspace:metadata': { description: 'project names, languages, runtimes, frameworks, entrypoint shapes', default: true, grantable: true, sensitive: false },
  'capability:metadata': { description: 'capability classifications, subtypes, signal ids and support status', default: true, grantable: true, sensitive: false },
  'capability:rank': { description: 'propose an ordering of candidates GRAFT already found', default: true, grantable: true, sensitive: false },
  'capability:explain': { description: 'describe a candidate or an architecture mismatch in words', default: true, grantable: true, sensitive: false },
  'engine:genome': { description: 'read a Capability Genome summary', default: false, grantable: true, sensitive: false },
  'engine:host-model': { description: 'read a Host Model summary', default: false, grantable: true, sensitive: false },
  'engine:ir': { description: 'read a GRAFT IR summary', default: false, grantable: true, sensitive: false },
  'atlas:summary': { description: 'read Compatibility Atlas entry ids, scores and reasons', default: false, grantable: true, sensitive: false },
  'recipe:suggest': { description: 'suggest a transformation recipe for GRAFT to evaluate', default: false, grantable: true, sensitive: false },
  'repair:suggest': { description: 'suggest a repair for GRAFT to evaluate', default: false, grantable: true, sensitive: false },
  'source:snippet': { description: 'read a bounded excerpt of one named file', default: false, grantable: true, sensitive: true },
  'source:file': { description: 'read a whole source file', default: false, grantable: true, sensitive: true },
  'command:run': { description: 'run commands', default: false, grantable: false, sensitive: true },
  'destination:write': { description: 'modify destination files', default: false, grantable: false, sensitive: true },
});

export const DEFAULT_SCOPES = Object.freeze(Object.entries(SCOPES).filter(([, s]) => s.default).map(([id]) => id));
export const SENSITIVE_SCOPES = Object.freeze(Object.entries(SCOPES).filter(([, s]) => s.sensitive).map(([id]) => id));

export class PermissionError extends Error {
  constructor(message, { required, granted, scope } = {}) { super(message); this.name = 'PermissionError'; this.code = 'agent-permission-denied'; this.required = required; this.granted = granted; this.scope = scope; }
}

/** A grant is an explicit, recorded set of scopes. Ungrantable scopes are refused outright. */
export function createGrant(scopes = DEFAULT_SCOPES, { reason = null, grantedAt = new Date().toISOString() } = {}) {
  const requested = [...new Set(scopes)];
  const unknown = requested.filter((s) => !Object.hasOwn(SCOPES, s));
  if (unknown.length) throw new PermissionError(`Unknown agent scope(s): ${unknown.join(', ')}`, { required: unknown, granted: [] });
  const ungrantable = requested.filter((s) => !SCOPES[s].grantable);
  if (ungrantable.length) throw new PermissionError(`These scopes can never be granted to an agent: ${ungrantable.join(', ')}. GRAFT performs those actions itself.`, { required: ungrantable, granted: [] });
  return Object.freeze({ permissionVersion: PERMISSION_VERSION, scopes: Object.freeze(requested), reason, grantedAt,
    sensitive: Object.freeze(requested.filter((s) => SCOPES[s].sensitive)) });
}

export const DEFAULT_GRANT = createGrant(DEFAULT_SCOPES, { reason: 'conservative default: structural metadata only' });

/** Assert a grant covers every scope a task needs, naming what is missing and why. */
export function requireScopes(grant, required) {
  const granted = grant?.scopes || [];
  const missing = required.filter((s) => !granted.includes(s));
  if (missing.length) {
    throw new PermissionError(`This request needs additional permission: ${missing.map((s) => `${s} (${SCOPES[s]?.description || 'unknown scope'})`).join('; ')}.`,
      { required: missing, granted: [...granted] });
  }
  return true;
}

/**
 * Does answering this need more than the caller holds? Returned rather than thrown so the
 * product can ask the user for a narrow, specific escalation instead of failing.
 */
export function escalationFor(grant, required) {
  const granted = grant?.scopes || [];
  const missing = required.filter((s) => !granted.includes(s));
  if (!missing.length) return null;
  return {
    needed: missing,
    sensitive: missing.filter((s) => SCOPES[s]?.sensitive),
    ungrantable: missing.filter((s) => SCOPES[s] && !SCOPES[s].grantable),
    describe: missing.map((s) => `${s}: ${SCOPES[s]?.description || 'unknown scope'}`),
  };
}
