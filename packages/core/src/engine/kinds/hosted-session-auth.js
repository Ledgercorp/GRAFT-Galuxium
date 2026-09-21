// Hosted-provider session authentication (Engine 1.2).
//
// The credential authority is external: a hosted identity provider validates who the person is
// through an OAuth 2.0 authorization-code flow with PKCE. Everything else is local and is what
// this capability actually consists of — the login/callback/logout lifecycle, PKCE and state
// custody, opaque session ids, the cookie contract, expiry, CSRF checks, the authenticated
// request guard, and provider-session linkage (refresh, revoke on logout).
//
// The application never hashes a password; modelling it as if it did would be a lie. The
// existing session-auth kind is untouched — this is a sibling, not a relaxation.
export const KIND = 'hosted-session-auth';

export const ROLE_SEMANTICS = Object.freeze({
  login: { purpose: 'Begin sign-in: mint state and a PKCE verifier, remember them in a short-lived flow cookie, and redirect to the provider', effects: [{ entity: 'flows', op: 'create' }], cookie: 'set', guarded: false, redirects: 'provider' },
  callback: { purpose: 'Complete sign-in: check state, exchange the code (with the PKCE verifier) for tokens, verify the identity, and open an opaque local session', effects: [{ entity: 'flows', op: 'delete' }, { entity: 'sessions', op: 'create' }], cookie: 'set', guarded: false, redirects: 'application' },
  logout: { purpose: 'End the local session, clear its cookie, and revoke the provider session through the provider boundary', effects: [{ entity: 'sessions', op: 'delete' }], cookie: 'clear', guarded: true, csrf: true },
  session: { purpose: 'Resolve the signed-in identity from the opaque session cookie, refreshing provider tokens through the provider boundary when needed', effects: [{ entity: 'sessions', op: 'read' }], cookie: 'none', guarded: true },
});

// Which parts belong to whom. The IR preserves this split; the emitter keeps the provider side
// behind one adapter so verification can substitute a deterministic double for it alone.
export const RESPONSIBILITIES = Object.freeze({
  provider: ['authorization URL / login initiation target', 'authorization-code and refresh-token exchange', 'identity assertion (signed token)', 'provider session revocation'],
  local: ['state and PKCE verifier lifecycle', 'opaque local session creation and lookup', 'cookie contract (HttpOnly, SameSite, Secure/__Host- when HTTPS, Path, Max-Age)', 'authenticated request guard', 'absolute and idle session expiry', 'logout and local invalidation', 'same-origin (CSRF) checks on mutations', 'provider token and session linkage'],
});

export const ADAPTATION_POINTS = Object.freeze(['module-system', 'handler-contract', 'framework', 'route-registration', 'provider-binding', 'session-store-binding']);

// Registered by giving the capability first refusal inside a central request handler; it returns
// an instance whose handle(req, res) answers true when it served the request.
export const REGISTRATION = Object.freeze({ name: 'registerHostedAuth', marker: 'hosted-authentication', defaultDir: 'src/auth', style: 'guard' });
