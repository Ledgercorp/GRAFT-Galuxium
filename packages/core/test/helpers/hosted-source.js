// Shared by the hosted-auth engine tests and the Laboratory execution tests.
import fs from 'node:fs';
import path from 'node:path';
export const write = (root, files) => { for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } return root; };
/**
 * A minimal but real hosted-provider source, in the shape the detector recognises: TypeScript,
 * a factory taking { origin, provider, identity, allowHttpLoopback }, a server factory taking
 * { indexPath, apiOrigin, auth }, and an identity-verifier factory with staticJwks. It is written
 * from the capability's semantics, not copied from any repository.
 */
export function hostedSource(root) {
  return write(root, {
    'package.json': JSON.stringify({ name: 'hosted-source', private: true, type: 'module', scripts: { build: 'tsc' } }),
    'apps/api/src/auth.ts': `import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
export interface Port { authorizationUrl(i: { state: string; challenge: string; redirectUri: string }): string; exchange(i: { code: string; verifier: string; redirectUri: string }): Promise<{ accessToken: string; refreshToken: string }>; refresh(t: string): Promise<{ accessToken: string; refreshToken: string }>; revoke(id: string): Promise<void>; }
export function createProviderPort(clientId: string, apiKey: string): Port {
  if (!apiKey.startsWith("sk_")) throw new Error("server credentials required");
  const base = "https://api.provider.example/user_management";
  async function post(path: string, body: object): Promise<Record<string, unknown>> { const r = await fetch(base + "/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return r.json() as Promise<Record<string, unknown>>; }
  return { authorizationUrl({ state, challenge, redirectUri }) { const url = new URL(base + "/authorize"); url.search = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" }).toString(); return url.href; },
    async exchange({ code, verifier, redirectUri }) { const d = await post("authenticate", { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }); return { accessToken: String(d.access_token), refreshToken: String(d.refresh_token) }; },
    async refresh(refresh_token) { const d = await post("authenticate", { grant_type: "refresh_token", refresh_token }); return { accessToken: String(d.access_token), refreshToken: String(d.refresh_token) }; },
    async revoke(session_id) { await post("sessions/revoke", { session_id }); } };
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
function cookie(req: IncomingMessage, name: string): string { const v = (req.headers.cookie ?? "").split(";").map((x) => x.trim()).filter((x) => x.startsWith(name + "=")); const value = v.length === 1 ? v[0]!.slice(name.length + 1) : ""; return OPAQUE.test(value) ? value : ""; }
function json(res: ServerResponse, status: number, error: string) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error })); }
interface Session { accessToken: string; refreshToken: string; subject: string; issuer: string; providerSession: string; tokenExpires: number; expires: number; lastUsed: number; }
export function createBrowserAuth(options: { origin: string; identity: { verify(t: string, s: AbortSignal): Promise<{ subject: string; issuer: string; expiresAt: string }> }; provider: Port; allowHttpLoopback?: boolean; sessionMs?: number; idleMs?: number }) {
  const origin = new URL(options.origin); const secure = origin.protocol === "https:";
  if (!secure && !(options.allowHttpLoopback && ["localhost", "127.0.0.1"].includes(origin.hostname))) throw new Error("An exact HTTPS origin is required (explicit loopback development exception only)");
  const sessionMs = options.sessionMs ?? 8 * 3600_000, idleMs = options.idleMs ?? 30 * 60_000;
  const sessionName = secure ? "__Host-app_session" : "app_session"; const flowName = secure ? "__Host-app_login" : "app_login";
  const callback = origin.origin + "/auth/callback";
  const sessions = new Map<string, Session>(); const flows = new Map<string, { state: string; verifier: string; expires: number; used?: boolean }>();
  const now = () => Date.now(); const expired = (s: Session) => now() >= s.expires || now() - s.lastUsed >= idleMs;
  function setCookie(res: ServerResponse, name: string, value: string, maxAge: number) { res.appendHeader("set-cookie", name + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + (secure ? "; Secure" : "")); }
  const clear = (res: ServerResponse, name: string) => setCookie(res, name, "", 0);
  const sessionKey = (req: IncomingMessage) => digest(cookie(req, sessionName));
  const sameOriginMutation = (req: IncomingMessage) => req.headers.origin === origin.origin && req.headers["x-app-csrf"] === "1" && req.headers["sec-fetch-site"] !== "cross-site";
  async function verified(tokens: { accessToken: string; refreshToken: string }) { const id = await options.identity.verify(tokens.accessToken, AbortSignal.timeout(5000)); const payload = JSON.parse(Buffer.from(tokens.accessToken.split(".")[1]!, "base64url").toString("utf8")) as { sid?: string }; if (typeof payload.sid !== "string") throw new Error("invalid_session"); return { ...tokens, subject: id.subject, issuer: id.issuer, providerSession: payload.sid, tokenExpires: Date.parse(id.expiresAt) }; }
  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (req.headers.host !== origin.host) { json(res, 400, "invalid_host"); return true; }
      const url = new URL(req.url ?? "/", origin); const path = url.pathname; const method = req.method ?? "GET";
      if (!path.startsWith("/auth/")) return false;
      if (method === "GET" && path === "/auth/login") { const id = random(), state = random(), verifier = random(); flows.set(digest(id), { state, verifier, expires: now() + 600_000 }); setCookie(res, flowName, id, 600); res.writeHead(303, { location: options.provider.authorizationUrl({ state, challenge: createHash("sha256").update(verifier).digest("base64url"), redirectUri: callback }) }); res.end(); return true; }
      if (method === "GET" && path === "/auth/callback") { const key = digest(cookie(req, flowName)); const flow = flows.get(key); clear(res, flowName); const state = url.searchParams.get("state") ?? "", code = url.searchParams.get("code") ?? "";
        if (!flow || flow.used || !equal(state, flow.state) || !code) { res.writeHead(303, { location: "/?auth_error=signin_failed" }); res.end(); return true; }
        flow.used = true; try { const tokens = await verified(await options.provider.exchange({ code, verifier: flow.verifier, redirectUri: callback })); const id = random(); sessions.set(digest(id), { ...tokens, expires: now() + sessionMs, lastUsed: now() }); setCookie(res, sessionName, id, Math.floor(sessionMs / 1000)); res.writeHead(303, { location: "/" }); res.end(); } catch { res.writeHead(303, { location: "/?auth_error=signin_failed" }); res.end(); } finally { flows.delete(key); } return true; }
      if (method === "POST" && path === "/auth/logout") { if (!sameOriginMutation(req)) { json(res, 403, "csrf_rejected"); return true; } const key = sessionKey(req); const s = sessions.get(key); sessions.delete(key); clear(res, sessionName); if (s) await options.provider.revoke(s.providerSession); res.writeHead(204); res.end(); return true; }
      json(res, 404, "not_found"); return true;
    },
    async authorize(req: IncomingMessage, res: ServerResponse): Promise<string | null> { const key = sessionKey(req); const s = sessions.get(key); if (!s || expired(s)) { sessions.delete(key); clear(res, sessionName); json(res, 401, "unauthenticated"); return null; }
      try { if (s.tokenExpires <= now() + 30_000) { const next = await verified(await options.provider.refresh(s.refreshToken)); if (next.subject !== s.subject || next.issuer !== s.issuer || next.providerSession !== s.providerSession) throw new Error("session_identity_changed"); Object.assign(s, next); } s.lastUsed = now(); return s.accessToken; }
      catch { sessions.delete(key); clear(res, sessionName); json(res, 401, "session_ended"); return null; } },
    close() { sessions.clear(); flows.clear(); },
  };
}
`,
    'apps/web/src/index.ts': `import { createServer, request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
export function createWebServer(options: { indexPath: string; apiOrigin: string; auth?: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>; authorize(req: IncomingMessage, res: ServerResponse): Promise<string | null> } }) {
  const html = readFileSync(options.indexPath, "utf8");
  return createServer((req, res) => { void (async () => {
    if (options.auth && await options.auth.handle(req, res)) return;
    if ((req.url ?? "/").startsWith("/api/")) { const token = await options.auth!.authorize(req, res); if (token === null) return;
      const upstream = httpRequest(new URL(req.url ?? "/", options.apiOrigin), { method: req.method, headers: { authorization: "Bearer " + token } }, (up) => { res.writeHead(up.statusCode ?? 502, { "content-type": "application/json" }); up.pipe(res); }); req.pipe(upstream); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(html);
  })(); });
}
`,
    'packages/identity/src/index.ts': `import { createPublicKey, verify as cryptoVerify } from "node:crypto";
export interface Jwk { readonly kid?: string; readonly kty: string; readonly [k: string]: unknown; }
export interface JwksSource { keys(signal: AbortSignal): Promise<readonly Jwk[]>; }
export function staticJwks(keys: readonly Jwk[]): JwksSource { return { async keys() { return keys; } }; }
export function fetchedJwks(url: string): JwksSource { if (!url.startsWith("https:")) throw new Error("JWKS URL must be HTTPS"); return { async keys() { return (await (await fetch(url)).json()).keys; } }; }
export function createJwksIdentityVerifier(options: { issuer: string; audience: string; provider: string; jwks: JwksSource }) {
  return { async verify(token: string, signal: AbortSignal) {
    const [h, p, s] = token.split("."); const header = JSON.parse(Buffer.from(h!, "base64url").toString()); const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    const jwk = (await options.jwks.keys(signal)).find((k) => k.kid === header.kid); if (!jwk) throw new Error("unknown key");
    if (!cryptoVerify(null, Buffer.from(h + "." + p), createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(s!, "base64url"))) throw new Error("bad signature");
    if (payload.iss !== options.issuer || payload.aud !== options.audience || payload.exp * 1000 <= Date.now()) throw new Error("rejected");
    return { subject: String(payload.sub), issuer: String(payload.iss), expiresAt: new Date(payload.exp * 1000).toISOString() };
  } };
}
`,
    'apps/web/public/index.html': '<!doctype html><title>app</title>',
  });
}
