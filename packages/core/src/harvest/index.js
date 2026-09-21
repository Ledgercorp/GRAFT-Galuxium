import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { MANIFEST_VERSION, redactSecrets } from '../manifest/schema.js';
import { inspectRepo, remoteOf } from '../apply/git.js';
import { verifySource } from '../verify/index.js';
import { architectureSignature } from '../capability/contract.js';
import { projectFingerprint, inheritedLineage } from '../capability/knowledge.js';
import * as authentication from './detectors/authentication.js';
import * as fileUploads from './detectors/file-uploads.js';
import * as featureFlags from './detectors/feature-flags.js';
import * as featureFlagsLibrary from './detectors/feature-flags-library.js';
import * as hostedAuth from './detectors/hosted-auth.js';
import { buildFeatureFlagsManifest } from './kinds/feature-flags.js';
import { buildFeatureFlagsLibraryManifest } from './kinds/feature-flags-library.js';
import { buildHostedSessionAuthManifest } from './kinds/hosted-session-auth.js';

const DETECTORS = [authentication, hostedAuth, fileUploads, featureFlags, featureFlagsLibrary];
// Keyed by the capability id a detector reports, so one kind can have more than one form.
const KIND_BUILDERS = { 'feature-flags': buildFeatureFlagsManifest, 'feature-flags-library': buildFeatureFlagsLibraryManifest, 'hosted-authentication': buildHostedSessionAuthManifest };

/** Read-only pass over a fingerprinted project. Returns every capability found. */
export function discoverCapabilities(fp) {
  const found = [];
  for (const detector of DETECTORS) {
    const result = detector.detect(fp);
    if (!result.found) continue;
    found.push({
      // Kind and form are orthogonal: `feature-flags` stays `feature-flags` in either form, so the
      // id carries the form only where two forms of one kind could otherwise collide.
      id: detector.meta.implementationForm === 'library' ? `${result.category}-library` : result.category,
      displayName: detector.meta.displayName,
      category: result.category,
      implementationForm: detector.meta.implementationForm || result.implementationForm || null,
      confidence: result.confidence,
      summary: detector.meta.describe(result),
      harvestable: detector.meta.harvestable,
      notHarvestableReason: detector.meta.notHarvestableReason || null,
      signals: result.signals,
      detail: result,
    });
  }
  return found;
}

/** Deterministic probe credentials. Never a real credential, never a secret. */
const PROBE = {
  email: 'graft-probe@example.invalid',
  password: 'graft-probe-password-9f3a',
  wrongPassword: 'graft-probe-wrong-password',
};

function buildBehavior(detail) {
  const roles = new Set(detail.routes.map((r) => r.role));
  const statements = [];
  const route = (role) => detail.routes.find((r) => r.role === role);

  if (roles.has('register')) {
    const r = route('register');
    statements.push({ id: 'auth.register', text: 'A visitor can create an account with an email address and a password.', evidence: [`${r.method} ${r.path} in ${r.file}`] });
  }
  if (roles.has('login')) {
    const r = route('login');
    statements.push({ id: 'auth.login', text: 'A registered user can sign in with correct credentials, and is refused with incorrect ones.', evidence: [`${r.method} ${r.path} in ${r.file}`, detail.hashing.evidence] });
  }
  if (roles.has('logout')) {
    const r = route('logout');
    statements.push({ id: 'auth.logout', text: 'A signed-in user can sign out, after which their session no longer authenticates them.', evidence: [`${r.method} ${r.path} in ${r.file}`] });
  }
  if (roles.has('currentUser')) {
    const r = route('currentUser');
    statements.push({ id: 'auth.session', text: 'A session persists across requests: the signed-in user can be read back from the session cookie.', evidence: [`${r.method} ${r.path} in ${r.file}`, detail.session.evidence] });
  }
  if (detail.guard && detail.protectedRoutes.length) {
    statements.push({ id: 'auth.protect', text: 'Protected routes reject unauthenticated requests before running any business logic.', evidence: [detail.guard.evidence, ...detail.protectedRoutes.map((r) => `${r.method} ${r.path} guarded in ${r.file}`)] });
  }
  return {
    summary: 'Email and password authentication with server-side sessions carried in an HTTP-only cookie.',
    statements,
    notFound: detail.absent,
  };
}

function buildAcceptanceTests(detail, behavior) {
  const p = (role) => detail.routes.find((r) => r.role === role)?.path;
  const cookie = detail.session.cookieName;
  const tests = [];
  const ids = new Set(behavior.statements.map((s) => s.id));

  if (ids.has('auth.register')) {
    tests.push({
      id: 'auth.register.creates-account', kind: 'http', required: true, provesBehavior: 'auth.register',
      description: 'Registering with a fresh email creates an account and opens a session.',
      steps: [{ name: 'register', method: 'POST', path: p('register'), body: { email: PROBE.email, password: PROBE.password }, expect: { status: [200, 201], setsCookie: cookie } }],
    });
  }
  if (ids.has('auth.login')) {
    tests.push({
      id: 'auth.login.accepts-valid-credentials', kind: 'http', required: true, provesBehavior: 'auth.login',
      description: 'Correct credentials are accepted and produce a session cookie.',
      steps: [
        { name: 'register', method: 'POST', path: p('register'), body: { email: `valid-${PROBE.email}`, password: PROBE.password }, expect: { status: [200, 201, 409] } },
        // The cookie's attributes and its opaque random value are witnessed here, so the
        // HttpOnly and opaque-session invariants are observed rather than asserted.
        { name: 'login', method: 'POST', path: p('login'), body: { email: `valid-${PROBE.email}`, password: PROBE.password }, expect: { status: [200], setsCookie: cookie,
          cookieFlags: { HttpOnly: detail.session.httpOnly === true, ...(detail.session.sameSite ? { SameSite: detail.session.sameSite } : {}) }, cookieValuePattern: `^[0-9a-f]{${detail.session.idBytes * 2}}$` } },
      ],
    });
    tests.push({
      id: 'auth.login.rejects-invalid-credentials', kind: 'http', required: true, provesBehavior: 'auth.login',
      description: 'An incorrect password is rejected. This is the test that fails if hashing was reimplemented wrongly.',
      steps: [
        { name: 'register', method: 'POST', path: p('register'), body: { email: `wrong-${PROBE.email}`, password: PROBE.password }, expect: { status: [200, 201, 409] } },
        { name: 'login-wrong', method: 'POST', path: p('login'), body: { email: `wrong-${PROBE.email}`, password: PROBE.wrongPassword }, expect: { status: [401], notSetsCookie: cookie } },
      ],
    });
  }
  if (ids.has('auth.session')) {
    tests.push({
      id: 'auth.session.persists-across-requests', kind: 'http', required: true, provesBehavior: 'auth.session',
      description: 'The session cookie issued at login identifies the same user on a later request.',
      steps: [
        { name: 'register', method: 'POST', path: p('register'), body: { email: `session-${PROBE.email}`, password: PROBE.password }, expect: { status: [200, 201, 409] } },
        { name: 'login', method: 'POST', path: p('login'), body: { email: `session-${PROBE.email}`, password: PROBE.password }, expect: { status: [200] } },
        { name: 'me', method: 'GET', path: p('currentUser'), expect: { status: [200], bodyMatches: { 'user.email': `session-${PROBE.email}` } } },
      ],
    });
  }
  if (ids.has('auth.logout')) {
    tests.push({
      id: 'auth.logout.ends-session', kind: 'http', required: true, provesBehavior: 'auth.logout',
      description: 'After logout the previously valid session no longer authenticates.',
      steps: [
        { name: 'register', method: 'POST', path: p('register'), body: { email: `logout-${PROBE.email}`, password: PROBE.password }, expect: { status: [200, 201, 409] } },
        { name: 'login', method: 'POST', path: p('login'), body: { email: `logout-${PROBE.email}`, password: PROBE.password }, snapshotCookies: 'before-logout', expect: { status: [200] } },
        { name: 'me-before', method: 'GET', path: p('currentUser'), expect: { status: [200] } },
        { name: 'logout', method: 'POST', path: p('logout'), expect: { status: [200, 204] } },
        // Deliberately re-presents the pre-logout cookie. Clearing the cookie client-side
        // is not logging out; the server must stop honouring the session it issued.
        { name: 'me-after-with-old-cookie', method: 'GET', path: p('currentUser'), useCookieSnapshot: 'before-logout', expect: { status: [401] } },
      ],
    });
  }
  if (ids.has('auth.protect')) {
    tests.push({
      id: 'auth.protect.rejects-anonymous', kind: 'http', required: true, provesBehavior: 'auth.protect',
      description: 'A protected route rejects a request carrying no session.',
      steps: [{ name: 'anonymous', method: 'GET', path: p('currentUser'), useCookies: false, expect: { status: [detail.guard.unauthenticatedStatus], noSetCookie: true } }],
    });
  }
  if (ids.has('auth.session') && ids.has('auth.login')) {
    // Not required: it observes durability across a process restart and reports it as
    // evidence (held or violated) without deciding the verdict — an in-memory store fails
    // it honestly rather than the capability being called unverified.
    tests.push({
      id: 'auth.session.survives-restart', kind: 'http', required: false, provesBehavior: 'auth.session',
      description: 'A session issued before the application restarts is still honoured after it (durable session storage).',
      steps: [
        { name: 'register', method: 'POST', path: p('register'), body: { email: `durable-${PROBE.email}`, password: PROBE.password }, expect: { status: [200, 201, 409] } },
        { name: 'login', method: 'POST', path: p('login'), body: { email: `durable-${PROBE.email}`, password: PROBE.password }, expect: { status: [200] } },
        { name: 'restart', restart: true },
        { name: 'me-after-restart', method: 'GET', path: p('currentUser'), expect: { status: [200] } },
      ],
    });
  }
  return { probeIdentity: PROBE, tests };
}

/** Where the source project was when GRAFT looked at it. Truthful about uncommitted work. */
export function describeSourceState(root) {
  const repo = inspectRepo(root);
  if (!repo.isRepo) return { head: null, branch: null, dirty: null, marker: 'not-a-git-repository' };
  return {
    head: repo.head,
    branch: repo.branch,
    dirty: repo.dirty,
    dirtyFileCount: repo.dirtyFiles.length,
    repoRoot: repo.root,
    // The durable repository identity, so the revision above can be resolved after the local
    // checkout has moved or gone. Credentials are stripped; a file remote is no identity.
    remote: remoteOf(root),
    marker: !repo.head ? 'no-commits' : repo.dirty ? `${repo.head.slice(0, 12)}+uncommitted-changes` : repo.head.slice(0, 12),
  };
}

/**
 * Turns a discovered capability into a portable manifest.
 *
 * The manifest describes the capability, not the source files. `architecture.capabilityModel`
 * is what a transplant is generated from; `sourceMap` is evidence for a human, and is
 * deliberately not the transplant payload.
 */
export function harvest(fp, capabilityId, { now = () => new Date().toISOString() } = {}) {
  const capability = discoverCapabilities(fp).find((c) => c.id === capabilityId);
  if (!capability) throw new Error(`capability "${capabilityId}" was not found in ${fp.name}`);
  if (!capability.harvestable) throw new Error(`capability "${capabilityId}" is not harvestable yet: ${capability.notHarvestableReason}`);

  // Kinds other than session-auth assemble their manifest from their own builder; the
  // identity and provenance skeleton (verification NOT claimed) is shared.
  // Dispatch on the capability id: one kind may have several forms, each with its own builder.
  const builder = KIND_BUILDERS[capability.id] || KIND_BUILDERS[capability.category];
  if (builder) {
    const extractedAt = now();
    const identity = { sourceProject: fp.name, sourceProjectRoot: fp.root, extractedAt, manifestVersion: MANIFEST_VERSION };
    const provenance = {
      capabilitySource: { architecture: architectureSignature(fp), fingerprint: projectFingerprint(fp) }, capabilityLineage: inheritedLineage(fp, capability.category),
      generator: 'graft-core', generatorVersion: MANIFEST_VERSION, method: 'static-analysis', aiAssisted: false, aiProvider: null, harvestedAt: extractedAt,
      sourceProject: { name: fp.name, version: fp.version, root: fp.root }, detectorSignals: capability.signals, confidence: capability.confidence,
      verifiedInSource: { verdict: 'NEEDS_REVIEW', rationale: 'Source verification was not run; the capability was discovered by static analysis only.', at: extractedAt, skipped: true, runtime: { profile: null }, sourceState: describeSourceState(fp.root), tests: [] },
    };
    const built = builder(fp, capability, { identity, provenance });
    for (const f of built.sourceMap.files) { try { f.sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(fp.root, f.file))).digest('hex').slice(0, 16); } catch { f.sha256 = null; } }
    return built;
  }
  const detail = capability.detail;
  const behavior = buildBehavior(detail);
  const acceptanceTests = buildAcceptanceTests(detail, behavior);
  const routeOf = (role) => detail.routes.find((r) => r.role === role);

  const identity = {
    name: 'Email & password authentication',
    slug: 'authentication', implementationForm: 'service',
    category: 'authentication',
    sourceProject: fp.name,
    sourceProjectRoot: fp.root,
    extractedAt: now(),
    manifestVersion: MANIFEST_VERSION,
  };

  const architecture = {
    sourceShape: {
      moduleSystem: fp.moduleSystem.value,
      handlerContract: fp.handlerContract.value,
      framework: fp.framework.value,
      persistence: fp.persistence.value,
    },
    // Architecture-neutral description of the capability. A transplant is generated
    // from this, so it must be complete enough to rebuild the behavior from nothing.
    capabilityModel: {
      kind: 'session-auth',
      credential: 'email-password',
      passwordPolicy: { minLength: 8 },
      passwordHash: {
        algorithm: detail.hashing.algorithm,
        builtin: detail.hashing.builtin,
        npmPackage: detail.hashing.npmPackage,
        keyLength: detail.hashing.keyLength,
        saltBytes: detail.hashing.saltBytes,
        comparison: 'constant-time',
      },
      session: {
        transport: detail.session.transport,
        cookieName: detail.session.cookieName,
        httpOnly: detail.session.httpOnly,
        secure: detail.session.secure,
        sameSite: detail.session.sameSite,
        path: detail.session.cookiePath,
        ttlSeconds: detail.session.ttlSeconds,
        idBytes: detail.session.idBytes,
        storage: 'server-side',
      },
      guard: { name: detail.guard?.name || 'requireAuth', unauthenticatedStatus: detail.guard?.unauthenticatedStatus || 401 },
      endpoints: detail.routes.map((r) => ({ role: r.role, method: r.method, path: r.path })),
    },
    components: {
      frontend: [],
      backendRoutes: detail.routes.map((r) => `${r.method} ${r.path}`),
      middleware: detail.guard ? [detail.guard.name] : [],
      backgroundJobs: [],
      externalServices: [],
    },
  };

  const dependencies = {
    packages: detail.hashing.npmPackage ? [{ name: detail.hashing.npmPackage, reason: 'password hashing', required: true }] : [],
    runtime: [{ name: 'node', range: '>=18', reason: 'node:crypto scrypt, randomUUID, timingSafeEqual' }],
    services: [],
    notes: detail.hashing.builtin ? ['Password hashing uses the Node standard library; this capability adds no npm dependencies.'] : [],
  };

  const interfaces = {
    inbound: detail.routes.map((r) => {
      const shapes = {
        register: { request: { email: 'string', password: 'string' }, responses: { 201: { user: { id: 'string', email: 'string', createdAt: 'string' } }, 400: { error: 'string' }, 409: { error: 'string' } } },
        login: { request: { email: 'string', password: 'string' }, responses: { 200: { user: { id: 'string', email: 'string' } }, 401: { error: 'string' } } },
        logout: { request: {}, responses: { 200: { ok: 'boolean' } } },
        currentUser: { request: {}, responses: { 200: { user: { id: 'string', email: 'string' } }, 401: { error: 'string' } } },
      }[r.role] || { request: {}, responses: {} };
      return { role: r.role, method: r.method, path: r.path, ...shapes };
    }),
    outbound: [],
    providedToHost: detail.guard
      ? [{ kind: 'middleware', name: detail.guard.name, description: 'Wraps a handler so it only runs for an authenticated request; the host application uses this to protect its own routes.' }]
      : [],
    consumedFromHost: [{ kind: 'persistence', description: 'Somewhere to store user and session rows for the lifetime of the process or longer.' }],
  };

  const dataModel = {
    entities: detail.entities.length ? detail.entities : [
      { name: 'users', source: 'inferred from code', fields: [{ name: 'id', type: 'TEXT' }, { name: 'email', type: 'TEXT', unique: true }, { name: 'password_hash', type: 'TEXT' }, { name: 'salt', type: 'TEXT' }, { name: 'created_at', type: 'TEXT' }] },
      { name: 'sessions', source: 'inferred from code', fields: [{ name: 'id', type: 'TEXT' }, { name: 'user_id', type: 'TEXT' }, { name: 'expires_at', type: 'INTEGER' }] },
    ],
    relationships: [{ from: 'sessions.user_id', to: 'users.id', kind: 'many-to-one' }],
    migrations: fp.sqlFiles,
    persistenceAssumptions: [
      'Email is unique across users and is the login identifier.',
      'Sessions are looked up server-side by opaque id; the cookie carries no user data.',
      'Expired sessions are treated as absent.',
    ],
  };

  const environment = {
    variables: [
      ...(detail.session.ttlEnvVar ? [{ name: detail.session.ttlEnvVar, required: false, purpose: 'session lifetime in seconds', default: String(detail.session.ttlSeconds) }] : []),
      ...(fp.environmentVariables.includes('SESSION_SECRET') ? [{ name: 'SESSION_SECRET', required: false, purpose: 'reserved for signed cookies; the harvested implementation uses opaque random session ids and does not read it' }] : []),
    ],
    note: 'Names only. GRAFT never records environment values in a manifest.',
  };

  const security = {
    assumptions: [
      { id: 'sec.server-side-authorization', text: 'Authorization is decided on the server. The client is never trusted to assert who it is.' },
      { id: 'sec.opaque-session', text: `The session cookie is ${detail.session.idBytes} random bytes with no embedded claims, so it cannot be forged by editing it.` },
      { id: 'sec.httponly', text: `The session cookie is ${detail.session.httpOnly ? 'HttpOnly, so page scripts cannot read it' : 'NOT HttpOnly in the source project, which exposes it to page scripts'}.` },
      { id: 'sec.password-at-rest', text: `Passwords are stored as ${detail.hashing.algorithm} hashes with a per-user salt, never in plain text.` },
      { id: 'sec.constant-time', text: 'Password comparison is constant-time to avoid leaking the hash through response timing.' },
      { id: 'sec.uniform-login-failure', text: 'A wrong password and an unknown email return the same response, so the endpoint does not disclose which emails are registered.' },
      { id: 'data.durable-sessions', text: 'Sessions survive an application restart when the store is durable; with process-memory storage they do not.', witnessedBy: ['auth.session.survives-restart'] },
    ],
    boundaries: [
      'Every protected route passes through the guard; there is no second unguarded path to the same data.',
      'Session lookup rejects expired sessions rather than refreshing them silently.',
    ],
    notes: [
      ...(detail.session.httpOnly ? [] : ['Source cookie is not HttpOnly. Transplanting this preserves the weakness.']),
      ...(detail.session.sameSite === 'None' ? ['Source cookie uses SameSite=None.'] : []),
      ...(detail.session.secure ? [] : ['Cookies are not marked Secure in the source project; a destination serving over HTTPS should add it.']),
    ],
  };

  const sourceMap = {
    note: 'Evidence trail back to the source project. GRAFT does not copy these files into a destination; they are here so a human can audit what a claim was based on.',
    files: detail.contributingFiles.map((file) => ({
      file,
      role: file.includes('session') ? 'session management' : file.includes('user') ? 'user store and hashing' : file.includes('auth') ? 'routes and guard' : 'supporting',
      sha256: (() => {
        try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(fp.root, file))).digest('hex').slice(0, 16); }
        catch { return null; }
      })(),
    })),
  };

  const provenance = {
    capabilitySource: { architecture: architectureSignature(fp), fingerprint: projectFingerprint(fp) },
    capabilityLineage: inheritedLineage(fp, capability.category),
    generator: 'graft-core',
    generatorVersion: MANIFEST_VERSION,
    method: 'static-analysis',
    aiAssisted: false,
    aiProvider: null,
    harvestedAt: identity.extractedAt,
    sourceProject: { name: fp.name, version: fp.version, root: fp.root },
    detectorSignals: capability.signals,
    confidence: capability.confidence,
    // Static analysis found the capability; it has not watched it work. Until
    // harvestCapability() replaces this with observed evidence, the honest answer is
    // "not proven", and a manifest is not allowed to say otherwise.
    verifiedInSource: {
      verdict: 'NEEDS_REVIEW',
      rationale: 'Source verification was not run; the capability was discovered by static analysis only.',
      at: identity.extractedAt,
      skipped: true,
      runtime: { profile: null },
      sourceState: describeSourceState(fp.root),
      tests: [],
    },
  };

  return { identity, behavior, architecture, dependencies, interfaces, dataModel, environment, security, acceptanceTests, sourceMap, provenance };
}

/** What a source verdict permits. Decided here once, so the CLI and the plan agree. */
export function harvestPolicy(verdict, { implementationForm = 'service' } = {}) {
  // Source verification proves the capability behaves. Being transplant-ready is a separate claim
  // about host adaptation, and no adaptation path exists for library form yet — so it stays false.
  if (verdict === 'VERIFIED' && implementationForm === 'library') return { status: 'verified', bankable: true, transplantReady: false, label: 'Verified in source', integration: 'not-yet-proven', integrationReason: 'GRAFT has no host adaptation for library-form capabilities yet' };
  if (verdict === 'VERIFIED') return { status: 'verified', bankable: true, transplantReady: true, label: 'Verified in source' };
  if (verdict === 'FAILED') return { status: 'failed', bankable: false, transplantReady: false, label: 'Failed in source' };
  return { status: 'unproven', bankable: true, transplantReady: false, label: 'Discovered, not proven' };
}

/**
 * The M2 harvest: discover, then boot the source and watch the capability work before
 * the manifest is allowed to claim anything about it.
 *
 * The verdict comes from the same engine that judges a transplant. A source that cannot
 * be run, crashes, or stops answering yields NEEDS_REVIEW with the reason; a source whose
 * behavior contradicts the generated acceptance tests yields FAILED. Nothing here can
 * turn static discovery into a claim of working behavior.
 */
export async function harvestCapability(fp, capabilityId, { verifySource: shouldVerify = true, now, timeoutMs, stepTimeoutMs } = {}) {
  const manifest = harvest(fp, capabilityId, now ? { now } : {});
  if (!shouldVerify) {
    return { manifest, verification: null, policy: harvestPolicy('NEEDS_REVIEW') };
  }

  // The source's state is taken before it runs and checked again after. If the run
  // changed the tree (or HEAD moved underneath it), the provenance says so rather than
  // presenting the result as a verification of the state it started from.
  const before = describeSourceState(fp.root);
  // Redacted once, here, at the boundary where someone else's output enters GRAFT: the
  // provenance, the evidence file and anything the CLI prints all derive from this.
  const report = redactSecrets(await verifySource(fp, manifest, { timeoutMs, stepTimeoutMs }));
  const after = describeSourceState(fp.root);
  const changedDuringVerification = before.head !== after.head || before.dirty !== after.dirty || before.dirtyFileCount !== after.dirtyFileCount;

  manifest.provenance.verifiedInSource = {
    verdict: report.verdict,
    rationale: report.rationale,
    at: report.finishedAt,
    skipped: false,
    runtime: report.runtime,
    sourceState: changedDuringVerification
      ? { ...before, marker: `${before.marker}+changed-during-verification`, changedDuringVerification: true, after }
      : { ...before, changedDuringVerification: false },
    summary: report.summary,
    tests: report.results.map((r) => ({ id: r.id, required: r.required, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) })),
    evidence: 'source-verification.json',
    // A hosted capability that could not be composed through a seam is refused by name, so the
    // manifest carries the reason rather than a bare NEEDS_REVIEW.
    ...(report.diagnostics?.reason === 'provider-seam-unavailable' ? { refusal: report.diagnostics.detail } : {}),
  };
  manifest.sourceVerificationReport = report;
  return { manifest, verification: report, policy: harvestPolicy(report.verdict, { implementationForm: manifest.identity?.implementationForm || 'service' }) };
}
