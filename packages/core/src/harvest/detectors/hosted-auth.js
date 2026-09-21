// Detects user-facing authentication whose credential authority is a hosted identity provider:
// an OAuth 2.0 authorization-code flow with PKCE, with the session kept locally in a cookie.
//
// This is the shape Dogfood Phase 1 found in real code and the local-password detector could
// not see. Every claim carries the file that produced it; TypeScript sources are read as text,
// so nothing here depends on build output. The detector also looks for the injection seam a
// verification double needs — a factory that takes the provider as an option — and records it
// honestly as unavailable when there is none.
import path from 'node:path';

const ROUTE_ROLES = [
  { role: 'login', match: /\/(login|signin|sign-in)$/i },
  { role: 'callback', match: /\/(callback|oauth\/callback)$/i },
  { role: 'logout', match: /\/(logout|signout|sign-out)$/i },
];
const PROVIDERS = [
  { id: 'workos', host: /api\.workos\.com/, keyPrefix: 'sk_' },
  { id: 'auth0', host: /\.auth0\.com/ },
  { id: 'okta', host: /\.okta\.com/ },
  { id: 'clerk', host: /clerk\./ },
];
const SOURCE = /\.(js|mjs|cjs|ts|tsx|jsx)$/;

function scanFiles(fp) {
  const found = {};
  const evidence = [];
  const note = (id, file, detail) => { if (!found[id]) { found[id] = { file, detail }; evidence.push({ id, evidence: `${file}: ${detail}` }); } };
  for (const file of fp.files) {
    if (!SOURCE.test(file) || /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\./.test(file)) continue;
    const src = fp.readFile(file) || '';
    if (!src) continue;
    for (const p of PROVIDERS) { const m = p.host.exec(src); if (m) note('provider-host', file, `${m[0]} (${p.id})`); }
    // An unrecognised provider is still a provider: an HTTPS host in the adapter that also builds
    // an /authorize URL (the base and the path may be separate literals).
    const generic = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})/.exec(src);
    if (generic && /\/authorize["'`]/.test(src) && !found['provider-host']) note('provider-host', file, `${generic[1]} (generic)`);
    if (/code_challenge/.test(src) && /S256/.test(src)) note('pkce', file, 'PKCE code_challenge with S256');
    if (/response_type["'\s:=]+code|\/authorize/.test(src)) note('authorization-url', file, 'authorization URL construction');
    if (/authorization_code/.test(src)) note('token-exchange', file, 'authorization_code exchange');
    if (/refresh_token/.test(src)) note('refresh', file, 'refresh_token handling');
    if (/revoke/.test(src) && /session/i.test(src)) note('provider-revoke', file, 'provider session revocation');
    if (/set-cookie|setCookie|appendHeader\(\s*["']set-cookie/i.test(src) && /HttpOnly/i.test(src)) note('session-cookie', file, 'HttpOnly cookie issued');
    if (/randomBytes\(\s*(\d+)\s*\)\.toString\(["']base64url["']\)/.test(src)) note('opaque-id', file, 'opaque base64url identifier');
    if (/new Map\s*</.test(src) || /sessions\s*=\s*new Map/.test(src)) note('memory-store', file, 'in-process Map session store');
    if (/sec-fetch-site/.test(src) && /headers\.origin/.test(src)) note('csrf', file, 'origin + Sec-Fetch-Site same-origin check');
    if (/timingSafeEqual/.test(src)) note('constant-time', file, 'constant-time comparison');
    if (/jwks|jwtVerify|createJwksIdentityVerifier/i.test(src)) note('identity-verification', file, 'signed identity token verification');
  }
  return { found, evidence };
}

/** The session policy, read from the file that issues the cookie. */
function sessionPolicy(fp, file) {
  const src = fp.readFile(file) || '';
  const names = (kind) => {
    // `const sessionName = secure ? "__Host-cuf_session" : "cuf_session"` — both spellings are the contract.
    const m = new RegExp(`${kind}\\s*=\\s*[^\\n;]*?["']__Host-([A-Za-z0-9_-]{1,40})["'][^\\n;]*?["']([A-Za-z0-9_-]{1,40})["']`).exec(src);
    if (m) return { secure: `__Host-${m[1]}`, loopback: m[2] };
    const single = new RegExp(`${kind}\\s*=\\s*["']([A-Za-z0-9_-]{1,40})["']`).exec(src);
    return single ? { secure: single[1], loopback: single[1] } : null;
  };
  const session = names('sessionName') || names('SESSION_COOKIE') || names('cookieName');
  const flow = names('flowName') || names('FLOW_COOKIE') || { secure: '__Host-graft_login', loopback: 'graft_login' };
  const idBytes = Number(/randomBytes\(\s*(\d+)\s*\)\.toString\(["']base64url["']\)/.exec(src)?.[1] || 32);
  const hours = /sessionMs\s*\?\?\s*(\d+)\s*\*\s*3600_?000/.exec(src);
  const idle = /idleMs\s*\?\?\s*(\d+)\s*\*\s*60_?000/.exec(src);
  return session ? {
    cookieName: session.secure, loopbackCookieName: session.loopback, flowCookieName: flow.secure, loopbackFlowCookieName: flow.loopback,
    httpOnly: /HttpOnly/i.test(src), secureWhenHttps: /\bsecure\b/.test(src) && /;\s*Secure/.test(src), sameSite: /SameSite=(\w+)/i.exec(src)?.[1] || 'Lax', path: /Path=(\/[^;'"`\s]*)/.exec(src)?.[1] || '/',
    idBytes, idLength: Math.ceil((idBytes * 4) / 3), sessionSeconds: hours ? Number(hours[1]) * 3600 : 8 * 3600, idleSeconds: idle ? Number(idle[1]) * 60 : 30 * 60,
    flowSeconds: Number(/expires:\s*now\(\)\s*\+\s*(\d+)_?000/.exec(src)?.[1] || 600),
    store: /new Map/.test(src) ? 'memory' : 'database', durableAcrossRestart: !/new Map/.test(src), evidence: `${file}: ${session.secure} cookie, HttpOnly=${/HttpOnly/i.test(src)}`,
  } : null;
}

/** Provider endpoints, read from the adapter that talks to the provider. */
function providerPolicy(fp, file, providerId) {
  const src = fp.readFile(file) || '';
  const origin = /https:\/\/([a-z0-9.-]+)/.exec(src)?.[1] || null;
  // The provider's base path: whatever follows the host in the adapter's URL literal, with a trailing
  // /authorize (contiguous literal) or a trailing quote/template boundary (split literals) removed.
  const base = (/https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_\-/]*?)\/?\$\{/.exec(src)?.[1]
    || /https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_\-/]+)\/authorize/.exec(src)?.[1]
    || /https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9_\-/]+?)\/?["'`]/.exec(src)?.[1] || '').replace(/\/$/, '');
  const literal = (name) => new RegExp(`["'\`](${name})["'\`]`).exec(src)?.[1] || null;
  const authorize = /\/authorize["'`]/.test(src) ? `${base}/authorize` : null;
  const token = literal('authenticate') ? `${base}/authenticate` : literal('token') ? `${base}/token` : `${base}/token`;
  const revoke = literal('sessions/revoke') ? `${base}/sessions/revoke` : literal('revoke') ? `${base}/revoke` : null;
  const csrfHeader = /["'](x-[a-z0-9-]*csrf[a-z0-9-]*)["']/i.exec(fp.files.map((f) => fp.readFile(f) || '').join('\n'))?.[1] || null;
  return { provider: providerId, defaultOrigin: origin ? `https://${origin}` : null, endpoints: { authorize, token, revoke },
    tokenRequest: /content-type["']?\s*:\s*["']application\/json/.test(src) ? 'json' : 'form', csrfHeader, evidence: `${file}: provider adapter` };
}

/**
 * The seam a verification double is injected through. GRAFT never edits the source to create
 * one; it uses a factory the source already exposes, or reports that none exists.
 */
function findSeam(fp) {
  const seam = { verification: { kind: 'unavailable', reason: 'no factory that accepts a provider was found' } };
  let auth = null, server = null, identity = null;
  for (const file of fp.files) {
    if (!SOURCE.test(file) || /(^|\/)(tests?|__tests__)\//.test(file)) continue;
    const src = fp.readFile(file) || '';
    const factory = /export\s+function\s+(create\w*(?:Auth|Session)\w*)\s*\(/.exec(src);
    if (factory && /\bprovider\b/.test(src) && /\bidentity\b/.test(src) && /\borigin\b/.test(src)) auth = { file, exportName: factory[1], options: { provider: 'provider', identity: 'identity', origin: 'origin', loopback: /allowHttpLoopback/.test(src) ? 'allowHttpLoopback' : null } };
    const serverFactory = /export\s+function\s+(create\w*Server)\s*\(/.exec(src);
    if (serverFactory && /\bauth\b/.test(src) && /createServer\(/.test(src)) server = { file, exportName: serverFactory[1], options: { auth: 'auth', indexPath: /indexPath/.test(src) ? 'indexPath' : null, apiOrigin: /apiOrigin/.test(src) ? 'apiOrigin' : null }, indexHtml: /indexPath/.test(src) ? (fp.files.find((f) => f.endsWith('public/index.html') && path.dirname(path.dirname(f)) === path.dirname(path.dirname(file))) || null) : null };
    const identityFactory = /export\s+function\s+(create\w*IdentityVerifier)\s*\(/.exec(src);
    if (identityFactory) identity = { file, exportName: identityFactory[1], staticJwks: /export\s+function\s+(staticJwks)\s*\(/.exec(src)?.[1] || null, options: { issuer: 'issuer', audience: 'audience', provider: 'provider', jwks: 'jwks' } };
  }
  if (auth && server && identity) {
    return { verification: { kind: 'factory-injection', reason: `${auth.file} exports ${auth.exportName}(options) taking the provider and identity verifier as options` },
      factory: { auth, server, identity, typescript: /\.tsx?$/.test(auth.file) } };
  }
  const missing = [!auth && 'an auth factory taking { provider, identity, origin }', !server && 'a server factory taking { auth }', !identity && 'an identity-verifier factory'].filter(Boolean);
  return { ...seam, verification: { kind: 'unavailable', reason: `missing ${missing.join(', ')}` } };
}

export function detect(fp) {
  const routes = [];
  for (const route of fp.routes) for (const { role, match } of ROUTE_ROLES) if (match.test(route.path) && !routes.some((r) => r.role === role)) routes.push({ ...route, role });
  const roles = new Set(routes.map((r) => r.role));
  const { found, evidence } = scanFiles(fp);
  const signals = [...routes.map((r) => ({ id: `${r.role}-route`, evidence: `${r.file}: ${r.method} ${r.path}` })), ...evidence];
  const providerId = PROVIDERS.find((p) => found['provider-host'] && p.host.test(found['provider-host'].detail))?.id || (found['provider-host'] ? 'generic' : null);
  const complete = roles.has('login') && roles.has('callback') && roles.has('logout') && found['authorization-url'] && found['token-exchange'] && found.pkce && found['session-cookie'] && providerId;
  if (!complete) return { category: 'hosted-authentication', found: false, signals };

  const session = sessionPolicy(fp, found['session-cookie'].file);
  const provider = providerPolicy(fp, found['provider-host'].file, providerId);
  if (!session || !provider.endpoints.authorize || !provider.defaultOrigin) return { category: 'hosted-authentication', found: false, signals, reason: 'provider endpoints or the session cookie contract could not be read' };
  const seam = findSeam(fp);
  const guardFile = fp.files.find((f) => /\bauthorize\s*\(/.test(fp.readFile(f) || '') && /401/.test(fp.readFile(f) || '')) || found['session-cookie'].file;
  const contributingFiles = [...new Set([...routes.map((r) => r.file), ...Object.values(found).map((f) => f.file), ...(seam.factory ? [seam.factory.auth.file, seam.factory.server.file, seam.factory.identity.file] : [])])];
  return {
    category: 'hosted-authentication', found: true,
    confidence: signals.length >= 10 ? 'high' : signals.length >= 6 ? 'medium' : 'low',
    signals, routes, session, provider, seam,
    guard: { name: 'authorize', unauthenticatedStatus: 401, evidence: `${guardFile}: authorize() answers 401 without a valid session` },
    csrf: found.csrf ? { headerName: provider.csrfHeader || 'x-csrf-token', requiresOrigin: true, requiresSecFetchSite: true, evidence: `${found.csrf.file}: ${found.csrf.detail}` } : null,
    identity: found['identity-verification'] ? { evidence: `${found['identity-verification'].file}: ${found['identity-verification'].detail}`, environment: fp.environmentVariables.filter((v) => /ISSUER|AUDIENCE|JWKS|CLIENT_ID|API_KEY/.test(v)) } : null,
    contributingFiles,
    absent: ['local password validation', ...(found.refresh ? [] : ['token refresh']), ...(found['provider-revoke'] ? [] : ['provider session revocation'])],
  };
}

export const meta = {
  category: 'hosted-authentication',
  // These detectors require HTTP routes, so what they find is a service by construction.
  implementationForm: 'service',
  displayName: 'Hosted-provider authentication',
  harvestable: true,
  describe(result) { return `${result.provider?.provider || 'hosted'} OAuth2/PKCE sign-in with a local ${result.session?.store || 'session'} cookie session (${result.routes.map((r) => r.role).join(', ')})`; },
};
