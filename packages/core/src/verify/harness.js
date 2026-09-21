// Source-side verification harness for a factory-injection provider seam.
//
// A capability whose credential authority is a hosted provider cannot be booted from its own
// entrypoint without live credentials. When the source exposes a factory that takes the
// provider and identity verifier as options — the seam its own tests use — GRAFT composes the
// source's real modules through that seam with the deterministic provider double substituted
// for the provider alone. The harness is written OUTSIDE the source repository, imports the
// source by absolute path (TypeScript directly, through Node's type transform), and exercises
// exactly the code the manifest describes. Nothing in the source is edited or built.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jsString, identifier } from '../util/safe.js';

export const HARNESS_VERSION = '1.0.0';

const contained = (root, rel) => { const abs = path.resolve(root, rel); return abs === root || abs.startsWith(root + path.sep); };

/**
 * Write a harness for `manifest` against the source checkout at `sourceRoot`. Returns the
 * harness path, the node arguments to run it, and the environment the harness reads.
 */
export function writeFactoryHarness({ sourceRoot, manifest, doubleOrigin, doubleAudience, doubleJwks }) {
  const model = manifest.architecture.capabilityModel;
  const seam = model.providerSeam;
  if (seam?.verification?.kind !== 'factory-injection' || !seam.factory) throw Object.assign(new Error('the source declares no factory-injection seam'), { code: 'provider-seam-unavailable' });
  const root = fs.realpathSync(sourceRoot);
  const { auth, server, identity, typescript } = seam.factory;
  for (const f of [auth.file, server.file, identity.file]) {
    if (!contained(root, f) || !fs.existsSync(path.join(root, f))) throw Object.assign(new Error(`seam module ${f} is not inside the source project`), { code: 'provider-seam-unavailable' });
  }
  const abs = (f) => path.join(root, f);
  const exportName = (v, field) => identifier(v, field);
  const ep = model.provider.endpoints;
  const publicDir = path.join(path.dirname(path.dirname(abs(server.file))), 'public', 'index.html');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-harness-'));
  const indexPath = fs.existsSync(publicDir) ? publicDir : path.join(dir, 'index.html');
  if (!fs.existsSync(publicDir)) fs.writeFileSync(indexPath, '<!doctype html><title>graft harness</title>\n');

  const source = `// GRAFT verification harness (generated; lives outside the source repository).
// Composes the source's real authentication through its own factory seam, with the provider
// double standing in for the credential authority only.
import http from 'node:http';
import { ${exportName(auth.exportName, 'seam.auth.exportName')} as createAuth } from ${jsString(abs(auth.file), 'seam.auth.file')};
import { ${exportName(server.exportName, 'seam.server.exportName')} as createAppServer } from ${jsString(abs(server.file), 'seam.server.file')};
import { ${exportName(identity.exportName, 'seam.identity.exportName')} as createIdentity${identity.staticJwks ? `, ${exportName(identity.staticJwks, 'seam.identity.staticJwks')} as staticJwks` : ''} } from ${jsString(abs(identity.file), 'seam.identity.file')};

const DOUBLE = process.env.GRAFT_PROVIDER_DOUBLE_ORIGIN;
const AUDIENCE = process.env.GRAFT_PROVIDER_DOUBLE_AUDIENCE;
const PORT = Number(process.env.PORT);
const origin = 'http://127.0.0.1:' + PORT;

async function post(path, body, bearer) {
  const response = await fetch(DOUBLE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('provider double rejected ' + path + ' (' + response.status + ')');
  return response.status === 204 ? {} : response.json();
}
// The provider port the source expects, backed by the deterministic double over loopback HTTP.
const provider = {
  authorizationUrl({ state, challenge, redirectUri }) {
    const url = new URL(DOUBLE + ${jsString(ep.authorize, 'provider.endpoints.authorize')});
    url.search = new URLSearchParams({ client_id: 'client_graftverification', response_type: 'code', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    return url.href;
  },
  async exchange({ code, verifier, redirectUri }) {
    const data = await post(${jsString(ep.token, 'provider.endpoints.token')}, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: 'client_graftverification' });
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  },
  async refresh(refreshToken) {
    const data = await post(${jsString(ep.token, 'provider.endpoints.token')}, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'client_graftverification' });
    return { accessToken: data.access_token, refreshToken: data.refresh_token };
  },
  async revoke(sessionId) { await post(${jsString(ep.revoke || '/revoke', 'provider.endpoints.revoke')}, { session_id: sessionId }, 'graft-verification-not-a-secret'); },
};
const jwks = await (await fetch(DOUBLE + '/jwks')).json();
const identity = createIdentity({ issuer: DOUBLE, audience: AUDIENCE, provider: 'graft-double', ${identity.staticJwks ? 'jwks: staticJwks(jwks.keys)' : 'jwks: { async keys() { return jwks.keys; } }'} });

// A stand-in for the upstream API the source proxies guarded requests to: it answers with the
// subject carried by the Bearer token the source attached, so the guard's decision is observable.
const upstream = http.createServer((req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ subject: payload.sub }));
  } catch { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthenticated' })); }
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

const auth = createAuth({ ${auth.options.origin}: origin, ${auth.options.provider}: provider, ${auth.options.identity}: identity${auth.options.loopback ? `, ${auth.options.loopback}: true` : ''} });
const app = createAppServer({ ${server.options.indexPath ? `${server.options.indexPath}: ${jsString(indexPath, 'harness.indexPath')}, ` : ''}${server.options.apiOrigin ? `${server.options.apiOrigin}: 'http://127.0.0.1:' + upstream.address().port, ` : ''}${server.options.auth}: auth });
app.listen(PORT, '127.0.0.1', () => console.log('graft harness listening on ' + origin));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close(); app.closeAllConnections?.(); upstream.close(); upstream.closeAllConnections?.(); });
`;
  const file = path.join(dir, 'harness.mjs');
  fs.writeFileSync(file, source, { mode: 0o600 });
  return {
    harnessVersion: HARNESS_VERSION, file, dir, typescript: Boolean(typescript),
    nodeArgs: [...(typescript ? ['--experimental-transform-types', '--no-warnings'] : []), '--', file],
    env: { GRAFT_PROVIDER_DOUBLE_ORIGIN: doubleOrigin, GRAFT_PROVIDER_DOUBLE_AUDIENCE: doubleAudience },
    seam: { kind: 'factory-injection', auth: `${auth.file}#${auth.exportName}`, server: `${server.file}#${server.exportName}`, identity: `${identity.file}#${identity.exportName}`, source: typescript ? 'typescript-source' : 'javascript-source' },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
