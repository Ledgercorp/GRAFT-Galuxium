import path from 'node:path';
import { jsString, intIn, identifier, routePath, cookieName, cookieAttributeValue, moduleSpecifier, COOKIE_PATH, SAME_SITE, UnsafeManifestValue } from '../util/safe.js';
import { expressGuard, expressRoutes, expressSessionReader } from './express-session-auth.js';
export { planEntrypointEdit } from './entrypoint.js';

export { SUPPORTED_PROFILES, profileFor } from './profiles.js';
import { profileFor as _profileFor } from './profiles.js';
import { validateEmissionSpec, lowerToEmission } from '../engine/lower.js';
import { buildEngineArtifacts } from '../engine/index.js';
import { buildHostModel } from '../engine/host.js';
import { selectRecipe } from '../engine/recipes.js';

function relativeImport(fromFile, toFile) {
  let rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/**
 * Generates a session-auth capability in the destination's own idiom from an EmissionSpec.
 *
 * The spec is the IR -> emitter boundary: normalized policies, operations, guards and the
 * destination's shape. Nothing here reads the manifest, the source files or the raw
 * fingerprint, so the output is determined by capability intent plus destination
 * architecture. What is preserved is exactly what the IR marks preserved: the cookie name
 * and flags, the hash algorithm and parameters, the status codes, the uniform login failure.
 */
export function emitSessionAuthFromSpec(spec) {
  const validation = validateEmissionSpec(spec);
  if (!validation.ok) throw new Error(`invalid emission spec: ${validation.errors.join('; ')}`);
  if (spec.kind !== 'session-auth') throw new Error(`session-auth emitter cannot emit a ${spec.kind} capability`);
  const profile = { id: spec.profile };
  const dir = spec.dir;
  const { session, passwordHash, guard } = spec.policies;
  const model = { passwordPolicy: spec.policies.passwordPolicy, endpoints: spec.operations };
  for (const field of ['httpOnly', 'secure']) {
    if (field === 'secure' && session[field] === undefined) continue; // Older manifests omit the false flag.
    if (typeof session[field] !== 'boolean') throw new UnsafeManifestValue(`session.${field}`, session[field], 'expected a boolean');
  }

  // Everything below is interpolated into files that will be written and then executed.
  // Validate it all up front so a hostile or malformed spec fails here, loudly, rather
  // than becoming code in the user's project.
  const safe = {
    cookieName: cookieName(session.cookieName, 'session.cookieName'),
    cookiePath: cookieAttributeValue(session.path, 'session.path', COOKIE_PATH),
    sameSite: cookieAttributeValue(session.sameSite, 'session.sameSite', SAME_SITE),
    ttlSeconds: intIn(session.ttlSeconds, 'session.ttlSeconds', { min: 1, max: 60 * 60 * 24 * 365 }),
    idBytes: intIn(session.idBytes, 'session.idBytes', { min: 16, max: 128 }),
    keyLength: intIn(passwordHash.keyLength, 'passwordHash.keyLength', { min: 16, max: 512 }),
    saltBytes: intIn(passwordHash.saltBytes, 'passwordHash.saltBytes', { min: 8, max: 128 }),
    guardName: identifier(guard.name, 'guard.name'),
    unauthenticatedStatus: intIn(guard.unauthenticatedStatus, 'guard.unauthenticatedStatus', { min: 400, max: 499 }),
    minLength: intIn(model.passwordPolicy?.minLength ?? 8, 'passwordPolicy.minLength', { min: 1, max: 1024 }),
  };

  const endpoint = (role) => {
    const found = model.endpoints.find((e) => e.role === role);
    if (!found) return null;
    return { ...found, path: routePath(found.path, `endpoints.${role}.path`) };
  };

  const usesSharedStore = spec.target.persistence.binding === 'shared-store';
  const storeModule = usesSharedStore ? { module: spec.target.persistence.module } : null;

  const files = [];
  const f = (name) => `${dir}/${name}`;

  // ---- persistence adapter: bridge the capability onto the destination's storage ----
  const storeImport = usesSharedStore
    ? `import { store } from ${moduleSpecifier(relativeImport(f('store-adapter.js'), storeModule.module), 'destination.storeModule')};`
    : null;

  files.push({
    path: f('store-adapter.js'),
    contents: usesSharedStore
      ? `${storeImport}

// The capability needs to keep users and sessions somewhere. The destination already
// has a store, so it uses that rather than introducing a second source of truth.
export const users = {
  insert(user) { return store.insert('users', user.id, user); },
  byEmail(email) { return store.find('users', (u) => u.email === email); },
  byId(id) { return store.get('users', id); },
};

export const sessions = {
  insert(record) { return store.insert('sessions', record.id, record); },
  byId(id) { return store.get('sessions', id); },
  remove(id) { return store.delete('sessions', id); },
};
`
      : `// The destination has no shared persistence layer, so the capability keeps its own.
// Swap these two maps for a database when the destination grows one; nothing else changes.
const userRows = new Map();
const sessionRows = new Map();

export const users = {
  insert(user) { userRows.set(user.id, user); return user; },
  byEmail(email) { for (const u of userRows.values()) if (u.email === email) return u; return null; },
  byId(id) { return userRows.get(id) ?? null; },
};

export const sessions = {
  insert(record) { sessionRows.set(record.id, record); return record; },
  byId(id) { return sessionRows.get(id) ?? null; },
  remove(id) { return sessionRows.delete(id); },
};
`,
  });

  // ---- password hashing ----
  if (passwordHash.algorithm !== 'scrypt') {
    throw new Error(`emitter cannot reproduce password hashing algorithm "${passwordHash.algorithm}"`);
  }
  files.push({
    path: f('passwords.js'),
    contents: `import crypto from 'node:crypto';

// Parameters carried over from the harvested capability. Changing them would
// silently invalidate every password hash written by this build.
const KEY_LENGTH = ${safe.keyLength};
const SALT_BYTES = ${safe.saltBytes};

export function hashPassword(password, salt = crypto.randomBytes(SALT_BYTES).toString('hex')) {
  return { salt, passwordHash: crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex') };
}

export function verifyPassword(password, salt, expectedHash) {
  const { passwordHash } = hashPassword(password, salt);
  const actual = Buffer.from(passwordHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  // Constant-time: a fast rejection would leak how much of the hash matched.
  return crypto.timingSafeEqual(actual, expected);
}
`,
  });

  // ---- sessions ----
  const ttlExpr = spec.environment.some((v) => v.name === 'SESSION_TTL_SECONDS')
    ? `Number(process.env.SESSION_TTL_SECONDS || ${safe.ttlSeconds})`
    : safe.ttlSeconds;

  files.push({
    path: f('sessions.js'),
    contents: `import crypto from 'node:crypto';
import { sessions } from './store-adapter.js';

export const COOKIE_NAME = ${jsString(safe.cookieName, 'session.cookieName')};
const TTL_SECONDS = ${ttlExpr};
if (!Number.isInteger(TTL_SECONDS) || TTL_SECONDS < 1 || TTL_SECONDS > 31536000) {
  throw new Error('SESSION_TTL_SECONDS must be an integer between 1 and 31536000');
}
const ID_BYTES = ${safe.idBytes};

export function createSession(userId) {
  // Opaque random id. The cookie carries no claims, so it cannot be forged by editing it.
  const id = crypto.randomBytes(ID_BYTES).toString('hex');
  sessions.insert({ id, userId, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  return id;
}

export function getSession(id) {
  const record = sessions.byId(id);
  if (!record) return null;
  if (record.expiresAt < Date.now()) { sessions.remove(id); return null; }
  return record;
}

export function destroySession(id) { sessions.remove(id); }

export function sessionCookie(id) {
  return \`\${COOKIE_NAME}=\${id};${session.httpOnly ? ' HttpOnly;' : ''}${session.secure ? ' Secure;' : ''} Path=${safe.cookiePath}; SameSite=${safe.sameSite}; Max-Age=\${TTL_SECONDS}\`;
}

export function clearedCookie() {
  return \`\${COOKIE_NAME}=;${session.httpOnly ? ' HttpOnly;' : ''}${session.secure ? ' Secure;' : ''} Path=${safe.cookiePath}; SameSite=${safe.sameSite}; Max-Age=0\`;
}
${profile.id === 'express-req-res' ? expressSessionReader : ''}
`,
  });

  // ---- guard, in the destination's handler contract ----
  files.push({
    path: f('guard.js'),
    contents: profile.id === 'express-req-res' ? expressGuard(safe) : `import { COOKIE_NAME, getSession } from './sessions.js';
import { users } from './store-adapter.js';

/**
 * Wraps a route handler so it only runs for an authenticated request.
 * Written for this application's handler contract: handlers receive ctx and
 * return { status, body }.
 */
export function ${safe.guardName}(handler) {
  return async (ctx) => {
    const sessionId = ctx.cookies?.[COOKIE_NAME];
    const session = sessionId ? getSession(sessionId) : null;
    if (!session) return { status: ${safe.unauthenticatedStatus}, body: { error: 'unauthenticated' } };
    const user = users.byId(session.userId);
    if (!user) return { status: ${safe.unauthenticatedStatus}, body: { error: 'unauthenticated' } };
    return handler({ ...ctx, session, user });
  };
}
`,
  });

  // ---- routes ----
  const publicUser = `function publicUser(user) {\n  return { id: user.id, email: user.email, createdAt: user.createdAt };\n}`;
  const parts = [
    `import crypto from 'node:crypto';`,
    `import { hashPassword, verifyPassword } from './passwords.js';`,
    `import { createSession, destroySession, sessionCookie, clearedCookie, COOKIE_NAME } from './sessions.js';`,
    `import { users } from './store-adapter.js';`,
    `import { ${safe.guardName} } from './guard.js';`,
    '',
    publicUser,
    '',
    `function normaliseEmail(email) {\n  return String(email ?? '').trim().toLowerCase();\n}`,
    '',
    `export function registerAuthRoutes(app) {`,
  ];

  if (endpoint('register')) {
    parts.push(`  app.post(${jsString(endpoint('register').path, 'endpoints.register.path')}, async (ctx) => {
    const email = normaliseEmail(ctx.body?.email);
    const password = ctx.body?.password;
    if (!email || !password) return { status: 400, body: { error: 'email_and_password_required' } };
    if (String(password).length < ${safe.minLength}) return { status: 400, body: { error: 'password_too_short' } };
    if (users.byEmail(email)) return { status: 409, body: { error: 'email_already_registered' } };

    const { salt, passwordHash } = hashPassword(String(password));
    const user = { id: crypto.randomUUID(), email, salt, passwordHash, createdAt: new Date().toISOString() };
    users.insert(user);

    const sessionId = createSession(user.id);
    return { status: 201, body: { user: publicUser(user) }, headers: { 'set-cookie': sessionCookie(sessionId) } };
  });
`);
  }

  if (endpoint('login')) {
    parts.push(`  app.post(${jsString(endpoint('login').path, 'endpoints.login.path')}, async (ctx) => {
    const email = normaliseEmail(ctx.body?.email);
    const user = users.byEmail(email);
    // An unknown email and a wrong password return the same thing, so this endpoint
    // cannot be used to discover which addresses are registered.
    if (!user || !verifyPassword(String(ctx.body?.password ?? ''), user.salt, user.passwordHash)) {
      return { status: 401, body: { error: 'invalid_credentials' } };
    }
    const sessionId = createSession(user.id);
    return { status: 200, body: { user: publicUser(user) }, headers: { 'set-cookie': sessionCookie(sessionId) } };
  });
`);
  }

  if (endpoint('logout')) {
    parts.push(`  app.post(${jsString(endpoint('logout').path, 'endpoints.logout.path')}, async (ctx) => {
    const sessionId = ctx.cookies?.[COOKIE_NAME];
    if (sessionId) destroySession(sessionId);
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': clearedCookie() } };
  });
`);
  }

  if (endpoint('currentUser')) {
    parts.push(`  app.get(${jsString(endpoint('currentUser').path, 'endpoints.currentUser.path')}, ${safe.guardName}(async (ctx) => ({
    status: 200,
    body: { user: publicUser(ctx.user) },
  })));
`);
  }

  parts.push('}');
  files.push({ path: f('routes.js'), contents: profile.id === 'express-req-res' ? expressRoutes(safe, endpoint) : parts.join('\n') + '\n' });

  return { profile: profile.id, dir, files, usesSharedStore, specId: spec.specId, registration: spec.registration };
}

/**
 * Manifest-facing adapter kept for callers and tests: genome -> IR -> host model -> recipe ->
 * EmissionSpec -> emitter. Refuses an unsupported destination exactly as before.
 */
export function emitSessionAuth(manifest, destFp, { dir = 'src/auth' } = {}) {
  if (!_profileFor(destFp)) {
    const err = new Error(`no emitter profile for a ${destFp.moduleSystem.value}/${destFp.handlerContract.value} destination; supported: esm/return-response, esm/express-req-res`);
    err.code = 'unsupported-profile';
    throw err;
  }
  const { ir } = buildEngineArtifacts(manifest);
  const host = buildHostModel(destFp);
  const { recipe } = selectRecipe(ir, host);
  return emitSessionAuthFromSpec(lowerToEmission(ir, host, recipe, { dir }));
}
