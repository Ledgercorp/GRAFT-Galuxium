// Manifest assembly for a harvested hosted-provider session-auth capability.
//
// The model separates who validates the credential (the provider) from how the session
// travels (a cookie) and where it is kept (locally, in memory). The acceptance tests are the
// verification contract: they run identically against the source (through its factory seam)
// and the destination (through endpoint configuration), always against a deterministic
// provider double — never a live provider. Cookie names in tests are the loopback spellings,
// because verification runs over plain HTTP; the secure `__Host-` spellings are preserved as
// the production contract.
export function buildHostedSessionAuthManifest(fp, capability, { identity, provenance }) {
  const d = capability.detail;
  const route = (role) => d.routes.find((r) => r.role === role);
  const login = route('login'), callback = route('callback'), logout = route('logout');
  const sessionPath = '/api/session';
  const s = d.session;
  const cookie = s.loopbackCookieName, flow = s.loopbackFlowCookieName;
  const csrfHeaders = d.csrf ? { origin: '${origin}', [d.csrf.headerName]: '1', 'sec-fetch-site': 'same-origin' } : { origin: '${origin}', 'sec-fetch-site': 'same-origin' };

  const statements = [
    { id: 'hosted.login', text: 'A visitor who starts sign-in is sent to the identity provider with a fresh state and a PKCE challenge, and a short-lived flow cookie remembers the attempt.', evidence: [`${login.method} ${login.path} in ${login.file}`, d.signals.find((x) => x.id === 'pkce')?.evidence].filter(Boolean) },
    { id: 'hosted.callback', text: 'Returning from the provider with the matching state and a valid code opens an opaque local session; a mismatched state or a rejected code opens nothing.', evidence: [`${callback.method} ${callback.path} in ${callback.file}`, d.signals.find((x) => x.id === 'token-exchange')?.evidence].filter(Boolean) },
    { id: 'hosted.session', text: 'A request carrying the session cookie resolves the signed-in identity; a request without one, or with an unknown cookie, is refused.', evidence: [d.guard.evidence, s.evidence] },
    { id: 'hosted.logout', text: 'Signing out ends the local session, so the old cookie stops authenticating, and revokes the provider session through the provider boundary.', evidence: [`${logout.method} ${logout.path} in ${logout.file}`, ...(d.signals.find((x) => x.id === 'provider-revoke') ? [d.signals.find((x) => x.id === 'provider-revoke').evidence] : [])] },
    ...(d.csrf ? [{ id: 'hosted.csrf', text: 'A state-changing request is honoured only when it proves it came from the application itself (matching Origin, same-site fetch metadata, CSRF header).', evidence: [d.csrf.evidence] }] : []),
    { id: 'hosted.non-durable', text: 'Sessions live in process memory by design: after a restart an old session cookie is refused rather than honoured.', evidence: [d.signals.find((x) => x.id === 'memory-store')?.evidence || s.evidence] },
  ];

  const loginStep = (name = 'login') => ({ name, method: login.method, path: login.path, captureQuery: { state: 'state', challenge: 'code_challenge' }, expect: { status: [303], redirectToProvider: d.provider.endpoints.authorize, redirectQueryHas: ['state', 'code_challenge', 'code_challenge_method', 'redirect_uri'], setsCookie: flow, cookieFlags: { HttpOnly: true, SameSite: s.sameSite } } });
  const callbackStep = (extra = {}) => ({ name: 'callback', method: callback.method, path: callback.path, query: { state: { capture: 'state' }, code: { capture: 'challenge', prefix: 'graft-ok:' } }, expect: { status: [303], redirectPath: '/', setsCookie: cookie, cookieFlags: { HttpOnly: true, SameSite: s.sameSite }, cookieValuePattern: `^[A-Za-z0-9_-]{${s.idLength}}$`, providerCalled: 'exchange', noSecretsInOutput: true }, ...extra });

  const tests = [
    { id: 'hosted.login.redirects-to-provider', kind: 'http', required: true, provesBehavior: 'hosted.login', description: 'Starting sign-in redirects to the provider with state, a PKCE S256 challenge and the callback, and sets an HttpOnly flow cookie.',
      steps: [loginStep()] },
    { id: 'hosted.callback.rejects-mismatched-state', kind: 'http', required: true, provesBehavior: 'hosted.callback', description: 'A callback whose state does not match the flow is refused and no session is opened.',
      steps: [loginStep(), { name: 'callback-wrong-state', method: callback.method, path: callback.path, query: { state: 'graft-wrong-state', code: 'graft-ok:irrelevant' }, expect: { status: [303], redirectPathStartsWith: '/?auth_error=', notSetsCookie: cookie, providerNotCalled: 'exchange' } }] },
    { id: 'hosted.callback.rejects-provider-failure', kind: 'http', required: true, provesBehavior: 'hosted.callback', description: 'A callback the provider rejects (a code that fails the PKCE check) opens no session.',
      steps: [loginStep(), { name: 'callback-bad-code', method: callback.method, path: callback.path, query: { state: { capture: 'state' }, code: 'graft-ok:not-the-challenge' }, expect: { status: [303], redirectPathStartsWith: '/?auth_error=', notSetsCookie: cookie, providerCalled: 'exchange' } }] },
    { id: 'hosted.callback.establishes-session', kind: 'http', required: true, provesBehavior: 'hosted.callback', description: 'A callback with the matching state and a code that passes the PKCE check opens an opaque HttpOnly session cookie.',
      steps: [loginStep(), callbackStep()] },
    { id: 'hosted.session.resolves-identity', kind: 'http', required: true, provesBehavior: 'hosted.session', description: 'The session cookie resolves the signed-in identity on a later request.',
      steps: [loginStep(), callbackStep(), { name: 'session', method: 'GET', path: sessionPath, expect: { status: [200], bodyMatches: { subject: 'graft-user' }, noSecretsInOutput: true } }] },
    // Provider tokens issued with a 2-second lifetime sit inside the application's refresh threshold
    // immediately, so the first guarded request must refresh through the provider boundary while the
    // subject stays the same and the session stays valid. No waiting is involved.
    { id: 'hosted.refresh.keeps-identity', kind: 'http', required: true, provesBehavior: 'hosted.session', description: 'When the provider token nears expiry, the session refreshes it through the provider boundary and keeps the same identity and session.',
      steps: [{ ...loginStep(), providerControl: { tokenLifetimeSeconds: 2 } }, callbackStep(), { name: 'session-refreshes', method: 'GET', path: sessionPath, expect: { status: [200], bodyMatches: { subject: 'graft-user' }, providerCalled: 'refresh', noSecretsInOutput: true } }, { name: 'session-still-valid', method: 'GET', path: sessionPath, expect: { status: [200], bodyMatches: { subject: 'graft-user' } } }] },
    { id: 'hosted.refresh.rejects-identity-change', kind: 'http', required: true, provesBehavior: 'hosted.session', description: 'If a refresh comes back asserting a different identity, the session is ended rather than silently re-bound.',
      steps: [{ ...loginStep(), providerControl: { tokenLifetimeSeconds: 2 } }, callbackStep({ snapshotCookies: 'before-refresh' }), { name: 'refresh-changes-identity', method: 'GET', path: sessionPath, providerControl: { refreshSubject: 'graft-someone-else' }, expect: { status: [d.guard.unauthenticatedStatus], providerCalled: 'refresh', notSetsCookie: cookie } }, { name: 'session-ended', method: 'GET', path: sessionPath, useCookieSnapshot: 'before-refresh', expect: { status: [d.guard.unauthenticatedStatus] } }] },
    { id: 'hosted.session.rejects-anonymous', kind: 'http', required: true, provesBehavior: 'hosted.session', description: 'A request carrying no session is refused without issuing anything.',
      // The source clears a stale cookie on refusal (Max-Age=0); what must never happen is a session being issued.
      steps: [{ name: 'anonymous', method: 'GET', path: sessionPath, useCookies: false, expect: { status: [d.guard.unauthenticatedStatus], notSetsCookie: cookie } }] },
    { id: 'hosted.session.rejects-unknown-cookie', kind: 'http', required: true, provesBehavior: 'hosted.session', description: 'A well-formed but unknown session cookie is refused.',
      steps: [{ name: 'unknown-cookie', method: 'GET', path: sessionPath, useCookies: false, headers: { cookie: `${cookie}=${'A'.repeat(s.idLength)}` }, expect: { status: [d.guard.unauthenticatedStatus] } }] },
    { id: 'hosted.logout.invalidates-session', kind: 'http', required: true, provesBehavior: 'hosted.logout', description: 'After logout the old cookie no longer authenticates, and the provider session was revoked through the provider boundary.',
      steps: [loginStep(), callbackStep({ snapshotCookies: 'before-logout' }), { name: 'logout', method: logout.method, path: logout.path, headers: csrfHeaders, expect: { status: [204, 200], providerCalled: 'revoke', noSecretsInOutput: true } },
        { name: 'session-after-logout', method: 'GET', path: sessionPath, useCookieSnapshot: 'before-logout', expect: { status: [d.guard.unauthenticatedStatus] } }] },
    ...(d.csrf ? [{ id: 'hosted.logout.requires-same-origin', kind: 'http', required: true, provesBehavior: 'hosted.csrf', description: 'A logout that cannot prove it came from the application is refused and the session survives.',
      steps: [loginStep(), callbackStep(), { name: 'logout-cross-site', method: logout.method, path: logout.path, expect: { status: [403], providerNotCalled: 'revoke' } }, { name: 'session-still-valid', method: 'GET', path: sessionPath, expect: { status: [200] } }] }] : []),
    { id: 'hosted.session.not-durable-across-restart', kind: 'http', required: true, provesBehavior: 'hosted.non-durable', description: 'A session opened before a restart is refused after it: memory-held sessions fail closed, as the source declares.',
      steps: [loginStep(), callbackStep(), { name: 'restart', restart: true }, { name: 'session-after-restart', method: 'GET', path: sessionPath, expect: { status: [d.guard.unauthenticatedStatus] } }] },
  ];

  const endpoints = [
    { role: 'login', method: login.method, path: login.path },
    { role: 'callback', method: callback.method, path: callback.path },
    { role: 'logout', method: logout.method, path: logout.path },
    { role: 'session', method: 'GET', path: sessionPath },
  ];
  const providerEnv = ['AUTH_PROVIDER_ORIGIN', 'AUTH_CLIENT_ID', 'AUTH_CLIENT_SECRET', 'AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_ORIGIN'];

  return {
    identity: { ...identity, name: `Hosted sign-in (${d.provider.provider}) with local sessions`, slug: 'hosted-authentication', category: 'hosted-authentication', implementationForm: 'service' },
    behavior: { summary: `User sign-in delegated to ${d.provider.provider} over OAuth 2.0 with PKCE; the application keeps its own opaque, HttpOnly, in-memory cookie session and guards requests locally.`, statements, notFound: d.absent },
    architecture: {
      sourceShape: { moduleSystem: fp.moduleSystem.value, handlerContract: fp.handlerContract.value, framework: fp.framework.value, persistence: fp.persistence.value, language: d.seam?.factory?.typescript ? 'typescript' : 'javascript' },
      capabilityModel: {
        kind: 'hosted-session-auth',
        audience: 'user',
        credentialAuthority: { kind: 'hosted-provider', provider: d.provider.provider, protocols: ['oauth2', 'pkce'] },
        provider: { defaultOrigin: d.provider.defaultOrigin, endpoints: d.provider.endpoints, tokenRequest: d.provider.tokenRequest, identity: { assertion: 'signed-jwt', verification: 'jwks', sessionClaim: 'sid' } },
        session: { transport: 'cookie', custody: 'local', store: s.store, durableAcrossRestart: s.durableAcrossRestart, cookieName: s.cookieName, loopbackCookieName: s.loopbackCookieName, flowCookieName: s.flowCookieName, loopbackFlowCookieName: s.loopbackFlowCookieName,
          httpOnly: s.httpOnly, secureWhenHttps: s.secureWhenHttps, sameSite: s.sameSite, path: s.path, idBytes: s.idBytes, idLength: s.idLength, sessionSeconds: s.sessionSeconds, idleSeconds: s.idleSeconds, flowSeconds: s.flowSeconds, keyed: 'sha256-of-id' },
        guard: { name: d.guard.name, unauthenticatedStatus: d.guard.unauthenticatedStatus },
        csrf: d.csrf ? { headerName: d.csrf.headerName, requiresOrigin: true, requiresSecFetchSite: true, appliesTo: 'mutations' } : null,
        providerSeam: d.seam,
        endpoints,
      },
      components: { frontend: [], backendRoutes: endpoints.map((e) => `${e.method} ${e.path}`), middleware: [d.guard.name], backgroundJobs: [], externalServices: [d.provider.provider] },
    },
    dependencies: { packages: [], runtime: [{ name: 'node', range: '>=20', reason: 'fetch, node:crypto (randomBytes, sha256, Ed25519/RSA/EC signature verification), URL' }], services: [{ name: d.provider.provider, role: 'credential authority', required: true, verifiedWith: 'deterministic provider double' }], notes: ['No packages: the provider is reached with fetch and identity tokens are verified with node:crypto.'] },
    interfaces: {
      inbound: [
        { role: 'login', method: login.method, path: login.path, request: {}, responses: { 303: { location: 'provider authorization URL' } } },
        { role: 'callback', method: callback.method, path: callback.path, request: { state: 'string', code: 'string' }, responses: { 303: { location: '/ or /?auth_error=signin_failed' } } },
        { role: 'logout', method: logout.method, path: logout.path, request: {}, responses: { 204: {}, 403: { error: 'csrf_rejected' } } },
        { role: 'session', method: 'GET', path: sessionPath, request: {}, responses: { 200: { subject: 'string' }, 401: { error: 'string' } } },
      ],
      outbound: [
        { target: `${d.provider.provider} ${d.provider.endpoints.authorize}`, purpose: 'user authorization (redirect)' },
        { target: `${d.provider.provider} ${d.provider.endpoints.token}`, purpose: 'authorization_code and refresh_token exchange' },
        ...(d.provider.endpoints.revoke ? [{ target: `${d.provider.provider} ${d.provider.endpoints.revoke}`, purpose: 'provider session revocation on logout' }] : []),
      ],
      providedToHost: [{ kind: 'guard', name: d.guard.name, description: 'Resolves the signed-in identity for a request, or answers 401; the host protects its own routes with it.' }],
      consumedFromHost: [{ kind: 'configuration', description: `Provider origin, client id and secret, issuer, audience and JWKS URL through the environment (${providerEnv.join(', ')}).` }],
    },
    dataModel: { entities: [{ name: 'sessions', source: 'inferred from code', fields: [{ name: 'id', type: 'TEXT' }, { name: 'subject', type: 'TEXT' }, { name: 'expires_at', type: 'INTEGER' }] }, { name: 'flows', source: 'inferred from code', fields: [{ name: 'id', type: 'TEXT' }, { name: 'state', type: 'TEXT' }, { name: 'verifier', type: 'TEXT' }, { name: 'expires_at', type: 'INTEGER' }] }],
      relationships: [], migrations: [], persistenceAssumptions: ['Sessions and sign-in flows are keyed by the sha256 of an opaque id and held in process memory; nothing survives a restart, by design.', 'The cookie carries only the opaque id; identity is resolved server-side from the provider tokens the session holds.'] },
    // `introduced`: the capability's own modules read these; the host is not expected to reference
    // them already. They must be configured before production, which the plan says plainly.
    environment: { variables: providerEnv.map((name) => ({ name, required: !['AUTH_PUBLIC_ORIGIN'].includes(name), introduced: true, purpose: { AUTH_PROVIDER_ORIGIN: `origin of the identity provider (default ${d.provider.defaultOrigin})`, AUTH_CLIENT_ID: 'OAuth client id', AUTH_CLIENT_SECRET: 'OAuth client secret (never logged)', AUTH_JWKS_URL: 'JWKS URL used to verify identity tokens', AUTH_ISSUER: 'expected token issuer', AUTH_AUDIENCE: 'expected token audience', AUTH_PUBLIC_ORIGIN: 'exact public origin of this application (HTTPS in production)' }[name], default: name === 'AUTH_PROVIDER_ORIGIN' ? d.provider.defaultOrigin : null })), note: 'Names only. GRAFT never records environment values in a manifest.' },
    security: {
      assumptions: [
        { id: 'sec.external-credential-authority', text: `Passwords are never seen by this application: ${d.provider.provider} validates credentials; the application only receives signed identity tokens.`, witnessedBy: ['hosted.callback.rejects-provider-failure'] },
        { id: 'sec.pkce-state-lifecycle', text: 'Each sign-in binds a random state and a PKCE verifier to a flow cookie; the callback is honoured only with the matching state and a code the provider accepts against the verifier.', witnessedBy: ['hosted.callback.rejects-mismatched-state', 'hosted.callback.rejects-provider-failure', 'hosted.callback.establishes-session'] },
        { id: 'sec.opaque-session', text: `The session cookie is ${s.idBytes} random bytes (base64url) with no embedded claims; sessions are looked up by the sha256 of that id.`, witnessedBy: ['hosted.callback.establishes-session', 'hosted.session.rejects-unknown-cookie'] },
        { id: 'sec.httponly', text: `Session and flow cookies are HttpOnly with SameSite=${s.sameSite}${s.secureWhenHttps ? ', and Secure with the __Host- prefix on HTTPS' : ''}.`, witnessedBy: ['hosted.login.redirects-to-provider', 'hosted.callback.establishes-session'] },
        { id: 'sec.server-side-authorization', text: 'Authorization is decided on the server from the session store; the client is never trusted to assert who it is.', witnessedBy: ['hosted.session.rejects-anonymous', 'hosted.session.rejects-unknown-cookie', 'hosted.logout.invalidates-session'] },
        ...(d.csrf ? [{ id: 'sec.csrf', text: `Mutations require a matching Origin, same-origin fetch metadata and the ${d.csrf.headerName} header.`, witnessedBy: ['hosted.logout.requires-same-origin'] }] : []),
        { id: 'sec.provider-revoke', text: 'Logout revokes the provider session as well as the local one, through the provider boundary.', witnessedBy: ['hosted.logout.invalidates-session'] },
        { id: 'data.non-durable-sessions', text: 'Sessions are intentionally not durable across restarts (fail closed).', witnessedBy: ['hosted.session.not-durable-across-restart'] },
        { id: 'sec.refresh-identity-stable', text: 'A provider token refresh keeps the same subject and provider session; a refresh that asserts a different identity ends the session.', witnessedBy: ['hosted.refresh.keeps-identity', 'hosted.refresh.rejects-identity-change'] },
        // Witnessed by the negative-output checks on the responses that carry provider material and by
        // the run-level scan of the process's own output; the verifier injects a sentinel secret.
        { id: 'sec.no-provider-secret-in-output', text: 'The client secret is read from the environment and never written to a response, a header, a cookie or a log.', witnessedBy: ['hosted.callback.establishes-session', 'hosted.session.resolves-identity', 'hosted.logout.invalidates-session', 'output.no-secret-in-process-output'] },
      ],
      boundaries: ['Only the provider adapter talks to the provider; the session layer never sees provider credentials.', 'The guard is the single path from a cookie to an identity; there is no second unguarded lookup.'],
      notes: ['Verification substitutes a deterministic provider double for the provider only; the application\'s own session, cookie, PKCE, guard and CSRF code runs unchanged.'],
    },
    acceptanceTests: { tests },
    sourceMap: { note: 'Evidence trail back to the source project; nothing here is copied.', files: d.contributingFiles.map((file) => ({ file, role: /browser-auth|auth/.test(file) ? 'sign-in lifecycle, session custody and guard' : /identity/.test(file) ? 'identity token verification' : /web|server/.test(file) ? 'server composition (factory seam)' : 'supporting', sha256: null })) },
    provenance,
  };
}
