import path from 'node:path';

const ROUTE_ROLES = [
  { role: 'register', match: /\/(register|signup|sign-up)$/i },
  { role: 'login', match: /\/(login|signin|sign-in)$/i },
  { role: 'logout', match: /\/(logout|signout|sign-out)$/i },
  { role: 'currentUser', match: /\/(me|session|whoami)$/i },
  { role: 'passwordReset', match: /\/(reset|forgot|password-reset)/i },
];

const HASH_ALGORITHMS = [
  { algorithm: 'scrypt', match: /\bscrypt(Sync)?\s*\(/, builtin: true, npmPackage: null },
  { algorithm: 'bcrypt', match: /\bbcrypt\b/, builtin: false, npmPackage: 'bcrypt' },
  { algorithm: 'argon2', match: /\bargon2\b/, builtin: false, npmPackage: 'argon2' },
  { algorithm: 'pbkdf2', match: /\bpbkdf2(Sync)?\s*\(/, builtin: true, npmPackage: null },
];

function classifyRoutes(routes) {
  const classified = [];
  for (const route of routes) {
    for (const { role, match } of ROUTE_ROLES) {
      if (match.test(route.path)) { classified.push({ ...route, role }); break; }
    }
  }
  return classified;
}

function detectHashing(fp) {
  for (const f of fp.files) {
    const src = fp.readFile(f) || '';
    for (const candidate of HASH_ALGORITHMS) {
      if (candidate.match.test(src)) {
        const keyLength = Number(/scryptSync\([^,]+,[^,]+,\s*(\d+)\)/.exec(src)?.[1] || 64);
        const saltBytes = Number(/randomBytes\((\d+)\)\.toString\('hex'\)/.exec(src)?.[1] || 16);
        return { ...candidate, keyLength, saltBytes, evidence: `${f}: ${candidate.algorithm}` };
      }
    }
  }
  return null;
}

function detectSession(fp) {
  for (const f of fp.files) {
    const src = fp.readFile(f) || '';
    const cookieName =
      /COOKIE_NAME\s*=\s*['"]([^'"]+)['"]/.exec(src)?.[1] ||
      /['"`](\w+)=\$\{\s*\w*sid\w*\s*\}/i.exec(src)?.[1] ||
      null;
    if (!cookieName) continue;
    const idBytes = Number(/randomBytes\((\d+)\)\.toString\('hex'\)/.exec(src)?.[1] || 24);
    const ttlMatch = /SESSION_TTL_SECONDS\s*\|\|\s*(\d+)/.exec(src) || /Max-Age=\$\{[^}]*\}/.exec(src);
    return {
      transport: 'cookie',
      cookieName,
      httpOnly: /HttpOnly/i.test(src),
      secure: /;\s*Secure\s*(?:;|['"`])/i.test(src),
      sameSite: /SameSite=(\w+)/i.exec(src)?.[1] || 'Lax',
      cookiePath: /Path=(\/[^;'"`]*)/.exec(src)?.[1] || '/',
      ttlSeconds: Number(ttlMatch?.[1] || 86400),
      idBytes,
      ttlEnvVar: /SESSION_TTL_SECONDS/.test(src) ? 'SESSION_TTL_SECONDS' : null,
      evidence: `${f}: ${cookieName} cookie, HttpOnly=${/HttpOnly/i.test(src)}`,
    };
  }
  return null;
}

function detectGuard(fp) {
  for (const f of fp.files) {
    const src = fp.readFile(f) || '';
    const name = /function\s+(requireAuth|requireUser|ensureAuthenticated|withAuth|authGuard)\b/.exec(src)?.[1]
      || /const\s+(requireAuth|requireUser|ensureAuthenticated|withAuth|authGuard)\s*=/.exec(src)?.[1];
    if (!name) continue;
    const unauthenticatedStatus = Number(/,\s*(401|403)\s*,/.exec(src)?.[1] || /status:\s*(401|403)/.exec(src)?.[1] || 401);
    return { name, unauthenticatedStatus, evidence: `${f}: ${name}()` };
  }
  return null;
}

function detectEntities(fp) {
  const entities = [];
  for (const sqlFile of fp.sqlFiles) {
    const sql = fp.readFile(sqlFile) || '';
    const create = /CREATE TABLE\s+(\w+)\s*\(([^;]*)\)/gis;
    for (let m; (m = create.exec(sql)); ) {
      const name = m[1];
      if (!/^(users?|sessions?|accounts?|credentials?)$/i.test(name)) continue;
      const fields = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !/^(PRIMARY|UNIQUE|FOREIGN|CONSTRAINT)/i.test(l))
        .map((l) => {
          const parts = l.replace(/,$/, '').split(/\s+/);
          return { name: parts[0], type: parts[1] || 'TEXT', notNull: /NOT NULL/i.test(l), unique: /UNIQUE/i.test(l) };
        }).filter((f) => f.name && !/^\)/.test(f.name));
      entities.push({ name, source: sqlFile, fields });
    }
    const index = /CREATE (UNIQUE )?INDEX\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
    for (let m; (m = index.exec(sql)); ) {
      const target = entities.find((e) => e.name.toLowerCase() === m[3].toLowerCase());
      if (target) (target.indexes ||= []).push({ name: m[2], unique: Boolean(m[1]), columns: m[4].split(',').map((c) => c.trim()) });
    }
  }
  return entities;
}

/**
 * Detects an email+password session authentication capability.
 * Every claim it makes carries the file that produced it. It reports what it
 * found, never what the category usually contains.
 */
export function detect(fp) {
  const authRoutes = classifyRoutes(fp.routes);
  const roles = new Set(authRoutes.map((r) => r.role));
  const hashing = detectHashing(fp);
  const session = detectSession(fp);
  const guard = detectGuard(fp);

  const signals = [];
  if (roles.has('login')) signals.push({ id: 'login-route', evidence: authRoutes.find((r) => r.role === 'login').file });
  if (roles.has('register')) signals.push({ id: 'register-route', evidence: authRoutes.find((r) => r.role === 'register').file });
  if (hashing) signals.push({ id: 'password-hashing', evidence: hashing.evidence });
  if (session) signals.push({ id: 'session-management', evidence: session.evidence });
  if (guard) signals.push({ id: 'authorization-guard', evidence: guard.evidence });

  if (!roles.has('login') || !hashing || !session) {
    return { category: 'authentication', found: false, signals };
  }

  const protectedRoutes = [];
  for (const f of fp.files) {
    const src = fp.readFile(f) || '';
    if (!guard) break;
    const guarded = new RegExp(`\\.add\\(\\s*['"](\\w+)['"]\\s*,\\s*['"]([^'"]+)['"]\\s*,\\s*${guard.name}\\(`, 'g');
    for (let m; (m = guarded.exec(src)); ) protectedRoutes.push({ method: m[1], path: m[2], file: f });
  }

  const contributingFiles = [...new Set([
    ...authRoutes.map((r) => r.file),
    ...[hashing, session, guard].filter(Boolean).map((x) => x.evidence.split(':')[0]),
    ...protectedRoutes.map((r) => r.file),
  ])];

  return {
    category: 'authentication',
    found: true,
    confidence: signals.length >= 5 ? 'high' : signals.length >= 3 ? 'medium' : 'low',
    signals,
    routes: authRoutes,
    protectedRoutes,
    hashing,
    session,
    guard,
    entities: detectEntities(fp),
    contributingFiles,
    absent: [
      ...(roles.has('passwordReset') ? [] : ['password reset']),
      ...(fp.files.some((f) => /oauth|google|github/i.test(f)) ? [] : ['third-party OAuth']),
      ...(fp.files.some((f) => /(mfa|totp|2fa)/i.test(fp.readFile(f) || '')) ? [] : ['multi-factor authentication']),
      ...(fp.files.some((f) => /verif/i.test(fp.readFile(f) || '')) ? [] : ['email verification']),
    ],
  };
}

export const meta = {
  category: 'authentication',
  // These detectors require HTTP routes, so what they find is a service by construction.
  implementationForm: 'service',
  displayName: 'Authentication',
  harvestable: true,
  describe(result) {
    const roles = [...new Set(result.routes.map((r) => r.role))];
    return `${result.session ? 'session' : 'token'} auth (${roles.join(', ')})`;
  },
};
