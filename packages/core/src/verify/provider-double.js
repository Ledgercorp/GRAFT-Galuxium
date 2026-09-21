// Deterministic provider double for hosted-provider authentication.
//
// Verification of a capability whose credential authority is external cannot depend on that
// authority: no live provider, no credentials, no network. This double stands in for the
// provider ONLY — an OAuth 2.0 authorization-code + PKCE token endpoint, a JWKS endpoint and a
// session-revocation endpoint — over loopback HTTP, with fully deterministic behaviour:
//
//   - an authorization code is accepted only in the form `graft-ok:<code_challenge>`, and the
//     token exchange succeeds only when S256(code_verifier) equals that challenge — so the PKCE
//     lifecycle is proven end to end, not skipped;
//   - identity assertions are real EdDSA-signed JWTs whose public key is served at /jwks, so the
//     application's real token verification runs unchanged;
//   - every provider operation is recorded, so a test can require that logout revoked the
//     provider session through the provider boundary.
//
// It never touches the application's own code: the real session layer, cookie contract,
// state/PKCE custody, guard and CSRF checks all run exactly as shipped. It exists only for
// the duration of a verification run and is never emitted into a destination.
import http from 'node:http';
import crypto from 'node:crypto';

export const PROVIDER_DOUBLE_VERSION = '1.0.0';
export const DOUBLE_SUBJECT = 'graft-user';
export const DOUBLE_AUDIENCE = 'graft-verification';
export const CODE_PREFIX = 'graft-ok:';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseBody(text, contentType = '') {
  if (!text) return {};
  if (/json/.test(contentType)) { try { return JSON.parse(text); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

/**
 * Start the double. `endpoints` are the provider paths the capability declares (so the
 * application's real adapter, pointed at this origin, hits exactly the paths it would hit in
 * production). Resolves to { origin, issuer, audience, jwks, subject, calls(), stop() }.
 */
export async function startProviderDouble({ endpoints, subject = DOUBLE_SUBJECT, audience = DOUBLE_AUDIENCE, tokenLifetimeSeconds = 300, sessionIdPrefix = 'session_graft' } = {}) {
  if (!endpoints || typeof endpoints.authorize !== 'string' || typeof endpoints.token !== 'string' || typeof endpoints.revoke !== 'string') throw new Error('provider double needs authorize, token and revoke endpoint paths');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'graft-double', alg: 'EdDSA', use: 'sig' };
  const calls = [];
  let sessions = 0;
  let origin = null;
  // Verification-only controls: a contract may shorten the token lifetime so the application's
  // refresh threshold is reached deterministically (no wall-clock waiting), or make a refresh
  // assert a different subject so identity-change handling is observable. Reset per test.
  const defaults = { tokenLifetimeSeconds, refreshSubject: null };
  const control = { ...defaults };

  const mint = (sid, sub = subject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid }));
    const payload = b64url(JSON.stringify({ iss: origin, aud: audience, sub, sid, iat: now, exp: now + control.tokenLifetimeSeconds }));
    const signature = b64url(crypto.sign(null, Buffer.from(`${header}.${payload}`), privateKey));
    return `${header}.${payload}.${signature}`;
  };
  const tokens = (sid, sub) => ({ access_token: mint(sid, sub), refresh_token: `graft-refresh-${sid}`, token_type: 'Bearer', expires_in: control.tokenLifetimeSeconds });
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname;
      if (req.method === 'GET' && (path === '/jwks' || path === '/.well-known/jwks.json')) { calls.push({ op: 'jwks' }); return json(res, 200, { keys: [jwk] }); }
      if (req.method === 'GET' && path === '/__graft/calls') return json(res, 200, { calls });
      if (req.method === 'POST' && path === '/__graft/reset') { calls.length = 0; Object.assign(control, defaults); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && path === '/__graft/control') {
        const body = parseBody(await readBody(req), req.headers['content-type']);
        if (Number.isInteger(body.tokenLifetimeSeconds) && body.tokenLifetimeSeconds >= 1 && body.tokenLifetimeSeconds <= 3600) control.tokenLifetimeSeconds = body.tokenLifetimeSeconds;
        if (body.refreshSubject === null || (typeof body.refreshSubject === 'string' && /^[a-z0-9-]{1,40}$/.test(body.refreshSubject))) control.refreshSubject = body.refreshSubject ?? null;
        calls.push({ op: 'control', tokenLifetimeSeconds: control.tokenLifetimeSeconds, refreshSubject: control.refreshSubject });
        return json(res, 200, { ok: true, control });
      }
      if (req.method === 'GET' && path === endpoints.authorize) {
        // A real user agent would land here; the acceptance runner instead captures state and
        // challenge from the redirect and calls the application's callback directly.
        const redirect = url.searchParams.get('redirect_uri') || '/';
        const state = url.searchParams.get('state') || '';
        const challenge = url.searchParams.get('code_challenge') || '';
        calls.push({ op: 'authorize', state: Boolean(state), challenge: Boolean(challenge), method: url.searchParams.get('code_challenge_method') });
        const target = new URL(redirect); target.searchParams.set('code', `${CODE_PREFIX}${challenge}`); target.searchParams.set('state', state);
        res.writeHead(303, { location: target.href }); return res.end();
      }
      if (req.method === 'POST' && path === endpoints.token) {
        const body = parseBody(await readBody(req), req.headers['content-type']);
        const grant = body.grant_type;
        if (grant === 'authorization_code') {
          const code = String(body.code || ''), verifier = String(body.code_verifier || '');
          const ok = code.startsWith(CODE_PREFIX) && verifier.length >= 43 && b64url(sha256(verifier)) === code.slice(CODE_PREFIX.length);
          calls.push({ op: 'exchange', ok, pkceVerified: ok });
          if (!ok) return json(res, 400, { error: 'invalid_grant', error_description: 'code or PKCE verifier rejected by the provider double' });
          sessions += 1;
          return json(res, 200, tokens(`${sessionIdPrefix}${sessions}`));
        }
        if (grant === 'refresh_token') {
          const refresh = String(body.refresh_token || '');
          const ok = refresh.startsWith('graft-refresh-');
          calls.push({ op: 'refresh', ok, subject: control.refreshSubject || subject });
          if (!ok) return json(res, 400, { error: 'invalid_grant' });
          return json(res, 200, tokens(refresh.slice('graft-refresh-'.length), control.refreshSubject || undefined));
        }
        calls.push({ op: 'token', ok: false, grant: String(grant || '') });
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && path === endpoints.revoke) {
        const body = parseBody(await readBody(req), req.headers['content-type']);
        calls.push({ op: 'revoke', sessionId: String(body.session_id || body.sid || ''), authenticated: typeof req.headers.authorization === 'string' && req.headers.authorization.length > 0 });
        res.writeHead(204); return res.end();
      }
      calls.push({ op: 'unknown', method: req.method, path });
      return json(res, 404, { error: 'not_found' });
    } catch (err) { return json(res, 500, { error: 'double_error', detail: err.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    providerDoubleVersion: PROVIDER_DOUBLE_VERSION,
    origin, issuer: origin, audience, subject, jwksUrl: `${origin}/jwks`, jwk, endpoints,
    calls: () => calls.slice(),
    /** Verification-only: adjust the double for the next requests; `reset()` restores defaults. */
    control: async (settings) => { await fetch(`${origin}/__graft/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }); },
    reset: async () => { await fetch(`${origin}/__graft/reset`, { method: 'POST' }); },
    /** Values the verifier injects that must never appear in the application's observable output. */
    sentinels: () => [{ name: 'provider-client-secret', value: 'graft-verification-not-a-secret' }],
    /** Environment the application's real adapter reads to reach this double instead of the provider. */
    environment: (names) => ({ [names.providerOrigin]: origin, [names.clientId]: 'client_graftverification', [names.clientSecret]: 'graft-verification-not-a-secret',
      [names.jwksUrl]: `${origin}/jwks`, [names.issuer]: origin, [names.audience]: audience }),
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** Which environment variable names an application adapter reads. Names only; defaults are GRAFT's. */
export const DEFAULT_PROVIDER_ENV = Object.freeze({ providerOrigin: 'AUTH_PROVIDER_ORIGIN', clientId: 'AUTH_CLIENT_ID', clientSecret: 'AUTH_CLIENT_SECRET', jwksUrl: 'AUTH_JWKS_URL', issuer: 'AUTH_ISSUER', audience: 'AUTH_AUDIENCE', publicOrigin: 'AUTH_PUBLIC_ORIGIN' });
