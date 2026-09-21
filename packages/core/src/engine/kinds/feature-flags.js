// Feature flags: a read-only, configuration-driven capability. Its contrast with session-auth
// is the point — no persistence, no credentials, no cookies; inputs come from the environment
// and the request, outputs are pure JSON, and the invariant that matters is the ABSENCE of
// side effects. Adaptation is configuration binding and route registration, never persistence.
export const KIND = 'feature-flags';

export const ROLE_SEMANTICS = Object.freeze({
  list: { purpose: 'Report every flag and whether it is enabled', effects: [{ entity: 'flags', op: 'read' }], cookie: 'none', guarded: false },
  evaluate: { purpose: 'Answer whether one named flag is enabled', effects: [{ entity: 'flags', op: 'read' }], cookie: 'none', guarded: false },
});

export const ADAPTATION_POINTS = Object.freeze(['module-system', 'handler-contract', 'framework', 'route-registration', 'configuration-binding']);

export const REGISTRATION = Object.freeze({ name: 'registerFlagRoutes', marker: 'feature-flags', defaultDir: 'src/flags' });
