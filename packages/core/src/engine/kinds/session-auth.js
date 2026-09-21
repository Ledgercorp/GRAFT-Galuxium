// Kind-level semantics GRAFT Engine 1.0 understands for a session-auth capability: what
// each operation role does to state and to the client. This is engine knowledge, not
// harvested evidence; it is only ever attached to endpoints the harvest actually found,
// and verification still decides whether the behavior holds.
export const KIND = 'session-auth';

export const ROLE_SEMANTICS = Object.freeze({
  register: { purpose: 'Create an account from an email address and a password', effects: [{ entity: 'users', op: 'create' }, { entity: 'sessions', op: 'create' }], cookie: 'set', guarded: false },
  login: { purpose: 'Exchange correct credentials for a session', effects: [{ entity: 'users', op: 'read' }, { entity: 'sessions', op: 'create' }], cookie: 'set', guarded: false },
  logout: { purpose: 'End the current session so its cookie stops authenticating', effects: [{ entity: 'sessions', op: 'delete' }], cookie: 'clear', guarded: true },
  currentUser: { purpose: 'Resolve the signed-in user from the session cookie', effects: [{ entity: 'sessions', op: 'read' }, { entity: 'users', op: 'read' }], cookie: 'none', guarded: true },
  passwordReset: { purpose: 'Reset a password through an out-of-band token', effects: [{ entity: 'users', op: 'update' }], cookie: 'none', guarded: false },
});

// The adaptation dimensions a session-auth capability varies along between architectures.
export const ADAPTATION_POINTS = Object.freeze(['module-system', 'handler-contract', 'framework', 'route-registration', 'persistence-binding']);

// How this kind's routes are registered in a destination entrypoint, and the module that
// owns them. The entrypoint editor uses the marker to stay idempotent.
export const REGISTRATION = Object.freeze({ name: 'registerAuthRoutes', marker: 'authentication', defaultDir: 'src/auth' });
