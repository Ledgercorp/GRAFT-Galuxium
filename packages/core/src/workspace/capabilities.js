// Capability observations for the Workspace Capability Index.
//
// A CapabilityObservation is what GRAFT *noticed*, with the evidence for it. It is not a
// Capability Genome and never becomes one implicitly: a Genome is a validated transplant
// contract, an observation is a structural sighting. Phase 1 dogfood found three real
// authentication systems that GRAFT could not represent at all because the only question it
// could ask was "is this the one shape I can transplant?". This model separates:
//
//   discovered   — GRAFT can see it and say what kind it is
//   harvestable  — GRAFT's own harvest detector accepts it (it alone decides this)
//   transplantable — an emitter profile and a supported runtime exist for the destination
//
// A capability may be strongly detected, clearly explained, and still unsupported. Saying so
// plainly is the product; pretending otherwise would be the defect.
import { detect as detectHarvestableAuth } from '../harvest/detectors/authentication.js';
import { detect as detectHarvestableHosted } from '../harvest/detectors/hosted-auth.js';
import { detect as detectHarvestableFlags } from '../harvest/detectors/feature-flags.js';
import { detect as detectFlagsLibrary } from '../harvest/detectors/feature-flags-library.js';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { SUPPORTED_PROFILES } from '../emit/profiles.js';
import { sha } from './identity.js';
import { describeLibraryIntegration } from '../adapt/library-host.js';

export const OBSERVATION_VERSION = '1.0.0';

/** Discovery states. Deliberately not collapsed: each answers a different question. */
export const CAPABILITY_STATES = Object.freeze(['OBSERVED', 'STRONGLY_DETECTED', 'HARVESTABLE', 'TRANSPLANTABLE', 'UNSUPPORTED', 'AMBIGUOUS']);
export const TRANSPLANT_SUPPORT = Object.freeze(['supported', 'unsupported', 'unknown']);

/** Authentication subtypes the index can recognise. Overlapping by design: real systems combine them. */
/** Who authenticates: a person through a browser, a program with a credential, both, or unclear. */
export const AUDIENCES = Object.freeze(['user', 'machine', 'mixed', 'unknown']);

export const AUTH_SUBTYPES = Object.freeze(['local-password', 'cookie-session', 'hosted-provider-oauth', 'oidc', 'oauth2-pkce',
  'jwt-bearer', 'api-key-static', 'm2m-client-credentials', 'magic-link', 'custom-unknown']);

/** Hosted identity providers recognised by dependency name or API host. */
const PROVIDERS = [
  { id: 'workos', dependency: /@workos-inc|workos/i, host: /(^|\.)workos\.com$/ },
  { id: 'auth0', dependency: /auth0/i, host: /(^|\.)auth0\.com$/ },
  { id: 'clerk', dependency: /@clerk/i, host: /(^|\.)clerk\.(com|dev|accounts\.dev)$/ },
  { id: 'okta', dependency: /@okta|okta-/i, host: /(^|\.)okta\.com$/ },
  { id: 'firebase', dependency: /firebase/i, host: /(^|\.)googleapis\.com$/ },
  { id: 'supabase', dependency: /@supabase/i, host: /(^|\.)supabase\.(co|com)$/ },
  { id: 'cognito', dependency: /amazon-cognito|@aws-sdk\/client-cognito/i, host: /cognito-idp\./ },
  { id: 'nextauth', dependency: /next-auth|@auth\/core/i, host: null },
  { id: 'netsuite', dependency: null, host: /suitetalk\.api\.netsuite\.com$/ },
  { id: 'stripe', dependency: /^stripe$/i, host: /(^|\.)stripe\.com$/ },
];

const ROUTE_ROLES = [
  { role: 'login', match: /\/(login|signin|sign-in|authorize)$/i },
  { role: 'register', match: /\/(register|signup|sign-up)$/i },
  { role: 'logout', match: /\/(logout|signout|sign-out)$/i },
  { role: 'callback', match: /\/(callback|oauth\/callback|auth\/callback)$/i },
  { role: 'currentUser', match: /\/(me|session|whoami|userinfo)$/i },
  { role: 'passwordReset', match: /\/(reset|forgot|password-reset)/i },
  { role: 'token', match: /\/(token|refresh)$/i },
];

const HASHES = [
  { algorithm: 'scrypt', match: /\bscrypt(Sync)?\s*\(/ },
  { algorithm: 'bcrypt', match: /\bbcrypt\b/ },
  { algorithm: 'argon2', match: /\bargon2\b/ },
  { algorithm: 'pbkdf2', match: /\bpbkdf2(Sync)?\s*\(|hashlib\.pbkdf2_hmac/ },
];

const signal = (id, evidence, file) => ({ id, evidence, file: file || null });

/**
 * Read a project's sources once and collect every authentication-relevant signal, each with
 * the file that produced it. Nothing here interprets; `classifyAuth` does that.
 */
function authSignals(project) {
  const found = [];
  const dependencies = [...project.dependencies, ...project.devDependencies, ...project.pythonDependencies].map((d) => d.name);
  const providers = new Set();
  for (const provider of PROVIDERS) {
    const dependency = provider.dependency && dependencies.find((d) => provider.dependency.test(d));
    const host = provider.host && project.externalHosts.find((h) => provider.host.test(h));
    if (dependency) { providers.add(provider.id); found.push(signal('identity-provider-dependency', `dependency ${dependency} (${provider.id})`)); }
    else if (host) { providers.add(provider.id); found.push(signal('identity-provider-host', `calls ${host} (${provider.id})`)); }
  }

  const roles = new Map();
  for (const route of project.routes) {
    for (const { role, match } of ROUTE_ROLES) {
      if (match.test(route.path)) { if (!roles.has(role)) roles.set(role, route); break; }
    }
  }
  for (const [role, route] of roles) found.push(signal(`${role}-route`, `${route.method} ${route.path} [${route.idiom}]`, route.file));

  const scan = [
    { id: 'password-hashing', test: (src) => HASHES.find((h) => h.match.test(src)), describe: (hit) => `${hit.algorithm} hashing call` },
    { id: 'pkce', test: (src) => /code_challenge|code_verifier|\bS256\b/.test(src), describe: () => 'PKCE code_challenge/code_verifier' },
    { id: 'oauth-authorization-url', test: (src) => /response_type=code|\/authorize\?|authorizationUrl/.test(src), describe: () => 'authorization URL construction' },
    { id: 'token-exchange', test: (src) => /grant_type["'\s:=]+authorization_code|grant_type=authorization_code/.test(src), describe: () => 'authorization_code token exchange' },
    { id: 'client-credentials', test: (src) => /client_credentials/.test(src), describe: () => 'client_credentials grant' },
    { id: 'client-assertion-jwt', test: (src) => /client-assertion-type:jwt-bearer|client_assertion/.test(src), describe: () => 'JWT client assertion' },
    { id: 'refresh-token', test: (src) => /refresh_token/.test(src), describe: () => 'refresh token handling' },
    { id: 'openid-scope', test: (src) => /\bopenid\b|id_token/.test(src), describe: () => 'OpenID Connect scope or id_token' },
    { id: 'jwks-verification', test: (src) => /jwks|createRemoteJWKSet|verifyJwt|jwtVerify/i.test(src), describe: () => 'JWKS/JWT verification' },
    { id: 'jwt-library', test: (src) => /require\(['"]jsonwebtoken|from\s+['"]jsonwebtoken|from\s+['"]jose|import\s+jwt\b/.test(src), describe: () => 'JWT library import' },
    { id: 'bearer-header-check', test: (src) => /authorization[^\n]{0,40}(Bearer|startsWith\(['"]Bearer)|Header\(default=None\)/i.test(src), describe: () => 'Authorization header inspection' },
    { id: 'constant-time-comparison', test: (src) => /timingSafeEqual|compare_digest/.test(src), describe: () => 'constant-time secret comparison' },
    { id: 'api-key-header', test: (src) => /x-api-key|apiKey|api_key/i.test(src), describe: () => 'API key header or parameter' },
    { id: 'session-cookie', test: (src) => /set-?cookie|setCookie|appendHeader\(["']set-cookie/i.test(src), describe: () => 'Set-Cookie writing' },
    { id: 'cookie-reading', test: (src) => /headers\.cookie|req\.cookies|request\.cookies/.test(src), describe: () => 'cookie reading' },
    { id: 'opaque-session-id', test: (src) => /randomBytes\(\s*\d+\s*\)\.toString\(["'](hex|base64url)/.test(src), describe: () => 'random opaque identifier generation' },
    { id: 'session-map-store', test: (src) => /new Map\(\)[^\n]{0,40}|sessions\s*=\s*new Map/.test(src) && /session/i.test(src), describe: () => 'in-process session map' },
    { id: 'session-expiry', test: (src) => /expires|maxAge|Max-Age|idleMs|ttl/i.test(src) && /session/i.test(src), describe: () => 'session expiry handling' },
    { id: 'csrf-protection', test: (src) => /csrf|sec-fetch-site|samesite/i.test(src), describe: () => 'CSRF or same-site checking' },
    { id: 'magic-link', test: (src) => /magic[-_ ]?link|passwordless/i.test(src), describe: () => 'magic-link wording' },
    { id: 'provider-revoke', test: (src) => /sessions\/revoke|revokeSession|\brevoke\(/.test(src), describe: () => 'provider session revocation' },
  ];
  const details = {};
  const TEST_FILE = /(^|\/)(tests?|__tests__|spec|fixtures?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
  for (const file of project.files) {
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|py)$/.test(file) || TEST_FILE.test(file)) continue;
    const src = project.read(file) || '';
    if (!src) continue;
    for (const item of scan) {
      if (found.some((s) => s.id === item.id)) continue;
      const hit = item.test(src);
      if (!hit) continue;
      found.push(signal(item.id, item.describe(hit), file));
      if (item.id === 'password-hashing') details.hashAlgorithm = hit.algorithm;
    }
    if (!details.cookieFlags && /set-?cookie/i.test(src)) {
      const flags = { httpOnly: /HttpOnly/i.test(src), secure: /;\s*Secure/i.test(src), sameSite: /SameSite=(\w+)/i.exec(src)?.[1] || null,
        hostPrefix: /__Host-/.test(src), path: /Path=(\/[^;'"`\s]*)/.exec(src)?.[1] || null };
      if (flags.httpOnly || flags.sameSite || flags.hostPrefix) { details.cookieFlags = flags; details.cookieFile = file; }
    }
    if (!details.cookieName) {
      const name = /COOKIE_NAME\s*=\s*['"]([^'"]+)['"]/.exec(src)?.[1] || /(?:sessionName|cookieName)\s*=\s*[^\n;]*?['"]([A-Za-z0-9_-]{3,40})['"]/.exec(src)?.[1] || null;
      if (name) details.cookieName = name;
    }
  }
  const guard = (() => {
    for (const file of project.files) {
      const src = project.read(file) || '';
      const name = /function\s+(requireAuth|requireUser|ensureAuthenticated|withAuth|authGuard|authorize|auth)\s*\(/.exec(src)?.[1]
        || /const\s+(requireAuth|requireUser|ensureAuthenticated|withAuth|authGuard)\s*=/.exec(src)?.[1]
        || /def\s+(auth|require_auth|get_current_user)\s*\(/.exec(src)?.[1];
      if (name) return { name, file };
    }
    return null;
  })();
  if (guard) found.push(signal('authorization-guard', `${guard.name}()`, guard.file));
  const protectedRoutes = project.routes.filter((r) => /Depends\(|requireAuth|authGuard/.test(project.read(r.file) || '')).length;
  return { signals: found, providers: [...providers], roles: [...roles.keys()], details, protectedRoutes };
}

/** Turn signals into a subtype classification with the three axes separated. */
function classifyAuth({ signals, providers, roles, details }, project) {
  const has = (id) => signals.some((s) => s.id === id);
  const subtypes = [];
  if (has('password-hashing') && (roles.includes('login') || roles.includes('register'))) subtypes.push('local-password');
  if ((has('session-cookie') || has('cookie-reading')) && (has('opaque-session-id') || has('session-map-store') || details.cookieName)) subtypes.push('cookie-session');
  if (providers.length && (has('oauth-authorization-url') || has('token-exchange') || has('identity-provider-dependency'))) subtypes.push('hosted-provider-oauth');
  if (has('pkce')) subtypes.push('oauth2-pkce');
  if (has('openid-scope') || has('jwks-verification')) subtypes.push('oidc');
  if ((has('jwt-library') || has('jwks-verification')) && has('bearer-header-check')) subtypes.push('jwt-bearer');
  if (has('client-credentials') || has('client-assertion-jwt')) subtypes.push('m2m-client-credentials');
  // A static shared secret only: a hosted provider or a JWT library means the secret is not the credential.
  if (!providers.length && !has('jwt-library') && !has('jwks-verification') && has('constant-time-comparison')
    && (has('bearer-header-check') || has('api-key-header'))) subtypes.push('api-key-static');
  if (has('magic-link')) subtypes.push('magic-link');
  if (!subtypes.length && (roles.includes('login') || has('bearer-header-check') || has('session-cookie'))) subtypes.push('custom-unknown');

  // The three axes Phase 1 proved must never be collapsed.
  const credentialAuthority = has('password-hashing') ? { kind: 'local', detail: `${details.hashAlgorithm} password hashing in this project` }
    : providers.length ? { kind: 'hosted-provider', detail: `credentials validated by ${providers.join(', ')}` }
      : has('constant-time-comparison') && has('bearer-header-check') ? { kind: 'shared-secret', detail: 'a configured secret is compared in constant time' }
        : has('jwks-verification') ? { kind: 'external-idp', detail: 'tokens verified against an external issuer' }
          : { kind: 'unknown', detail: 'no credential validation observed in this project' };
  const sessionTransport = subtypes.includes('cookie-session') || has('session-cookie') ? 'cookie'
    : has('bearer-header-check') ? 'bearer-header' : 'none';
  const sessionCustody = has('session-map-store') || has('opaque-session-id') ? 'local'
    : providers.length && sessionTransport !== 'none' ? 'provider' : sessionTransport === 'bearer-header' ? 'stateless' : 'none';
  const sessionStore = has('session-map-store') ? 'memory'
    : project.storage.some((s) => ['postgres', 'mysql', 'sqlite', 'mongodb', 'redis'].includes(s.kind)) && sessionCustody === 'local' ? 'database'
      : sessionCustody === 'provider' ? 'provider' : sessionCustody === 'stateless' ? 'none' : sessionCustody === 'local' ? 'memory' : 'none';
  const sessionDurableAcrossRestart = sessionStore === 'memory' ? false : sessionStore === 'database' ? true : null;
  // Audience is structural: a login/callback route or a browser cookie session means a person
  // signs in; a static bearer secret or client-credentials grant means a program does.
  const userFacing = roles.includes('login') || roles.includes('callback') || roles.includes('register') || subtypes.includes('cookie-session') || subtypes.includes('local-password') || subtypes.includes('hosted-provider-oauth') || subtypes.includes('magic-link');
  const machineFacing = subtypes.includes('api-key-static') || subtypes.includes('m2m-client-credentials');
  const audience = userFacing && machineFacing ? 'mixed' : userFacing ? 'user' : machineFacing ? 'machine' : 'unknown';
  return { subtypes: [...new Set(subtypes)], audience, credentialAuthority, sessionTransport, sessionCustody, sessionStore, sessionDurableAcrossRestart,
    cookieName: details.cookieName || null, cookieFlags: details.cookieFlags || null, hashAlgorithm: details.hashAlgorithm || null, providers, roles };
}

/** Feature-flag shape, where one exists. A confident "none" is a result worth recording. */
function flagObservationFor(project) {
  const signals = [];
  let scope = null, source = null;
  for (const file of project.files) {
    if (!/\.(js|mjs|cjs|ts|tsx|jsx|py)$/.test(file)) continue;
    const src = project.read(file) || '';
    if (!src) continue;
    const add = (id, evidence) => { if (!signals.some((s) => s.id === id)) signals.push(signal(id, evidence, file)); };
    if (/\b(FEATURE_|FLAG_)[A-Z0-9_]+/.test(src)) { add('env-flag-names', 'FEATURE_/FLAG_ environment names'); source ||= 'environment'; }
    if (/\bflags?\s*[:=]\s*\{/.test(src) || /\bDEFAULT_FLAGS\b/.test(src)) { add('flag-defaults', 'flag default map'); source ||= 'config-file'; }
    if (/\bisEnabled\s*\(|\bflagEnabled\s*\(|featureEnabled/.test(src)) add('flag-evaluation', 'flag evaluation function');
    if (/launchdarkly|unleash|flagsmith|split\.io|posthog/i.test(src)) { add('remote-flag-provider', 'remote flag provider reference'); source = 'remote-provider'; }
    if (/\brollout\b|\bvariant\b|\bbucket\b/.test(src) && /flag/i.test(src)) add('rollout-or-variant', 'rollout/variant logic');
    if (/flags?.*\b(tenant|account)Id\b/i.test(src)) scope = 'tenant';
    else if (/flags?.*\buserId\b/i.test(src)) scope ||= 'user';
  }
  return { signals, scope: scope || (signals.length ? 'global' : null), source };
}

/**
 * Two different questions, deliberately kept apart:
 *   transplantSupport — could this capability be taken OUT of here and planted elsewhere?
 *   asDestination     — could a capability be planted INTO this project?
 * A CommonJS source can be perfectly harvestable while being an unsupported destination, and
 * conflating the two mislabels every source project in the workspace.
 */
function transplantAssessment(project, capability, harvestable) {
  const blockers = [];
  if (project.runtime !== 'node') blockers.push({ id: 'unsupported-runtime', detail: `GRAFT transplants Node projects; this is ${project.runtime}` });
  if (project.language === 'typescript' && !harvestable.seam) blockers.push({ id: 'typescript-source', detail: 'the capability is written in TypeScript and exposes no factory seam GRAFT can compose from source' });
  if (!harvestable.found) blockers.push({ id: 'not-harvestable', detail: `no ${capability} harvest detector accepted this project` });
  else if (harvestable.seam && harvestable.seam.verification?.kind === 'unavailable') blockers.push({ id: 'provider-seam-unavailable', detail: `hosted-provider authentication is understood, but no verification seam is available: ${harvestable.seam.verification.reason}` });

  const profile = SUPPORTED_PROFILES.find((p) => p.moduleSystem === project.moduleSystem && p.handlerContract === project.handlerContract);
  const destinationBlockers = [];
  if (project.runtime !== 'node') destinationBlockers.push({ id: 'unsupported-runtime', detail: `GRAFT writes Node projects; this is ${project.runtime}` });
  else if (!profile) destinationBlockers.push({ id: 'unsupported-profile', detail: `no emitter profile for ${project.moduleSystem}/${project.handlerContract}` });
  if (project.isCompiled) destinationBlockers.push({ id: 'compiled-destination', detail: 'generated output runs the project; GRAFT must never edit build output' });
  if (!project.entrypoint) destinationBlockers.push({ id: 'no-entrypoint', detail: 'no entrypoint was identified to register routes in' });

  return {
    transplantSupport: blockers.length ? 'unsupported' : 'supported', blockers,
    asDestination: { supported: destinationBlockers.length === 0, emitterProfile: profile?.id || null, blockers: destinationBlockers },
  };
}

/**
 * Observe one capability in one project. `harvestable` is decided by GRAFT's own harvest
 * detector — the index never promotes its own guess into harvestability.
 */
export function observeCapabilities(project, { projectId, repositoryRoot = null }) {
  // The harvest detectors speak "fingerprint"; give them exactly the shape they expect.
  // The declared package entry (main/exports) is what tells a library detector where the published
  // artifact is, so the real package.json is passed through when the project has one.
  const declared = (() => { try { return JSON.parse(project.read('package.json') || '{}'); } catch { return {}; } })();
  const asFingerprint = {
    files: project.files, readFile: project.read, routes: project.routes,
    sqlFiles: project.files.filter((f) => f.endsWith('.sql')),
    packageJson: { ...declared, dependencies: Object.fromEntries(project.dependencies.map((d) => [d.name, d.range])) },
    environmentVariables: project.environmentVariables,
    moduleSystem: { value: project.moduleSystem }, hasHttpServer: project.hasHttpServer, serverSignals: project.serverSignals || [],
    dependencies: project.dependencies,
  };
  const observations = [];

  const auth = authSignals(project);
  const classification = classifyAuth(auth, project);
  let harvestableAuth = { found: false, signals: [] };
  try { harvestableAuth = detectHarvestableAuth(asFingerprint); } catch { /* a detector failure is not a capability claim */ }
  // Engine 1.2: a hosted-provider capability is harvested by its own detector. Its factory seam
  // can span sibling packages of a monorepo, so when the project is a subproject the detector is
  // also asked at the repository root, and the observation records which root it was decided at.
  let harvestCategory = harvestableAuth.found ? 'authentication' : null, harvestRoot = harvestableAuth.found ? project.root : null;
  if (!harvestableAuth.found && classification.credentialAuthority.kind === 'hosted-provider') {
    // Only a project that carries the capability itself (its sign-in routes) is a candidate; the
    // repository root is consulted solely to complete a seam that spans sibling packages, and is
    // preferred only when it actually provides one.
    let local = { found: false };
    try { local = detectHarvestableHosted(asFingerprint); } catch { /* not a claim */ }
    if (local.found) {
      harvestableAuth = local; harvestCategory = 'hosted-authentication'; harvestRoot = project.root;
      if (local.seam?.verification?.kind !== 'factory-injection' && repositoryRoot && repositoryRoot !== project.root) {
        try {
          const wider = detectHarvestableHosted(fingerprintProject(repositoryRoot));
          if (wider.found && wider.seam?.verification?.kind === 'factory-injection') { harvestableAuth = wider; harvestRoot = repositoryRoot; }
        } catch { /* keep the local result */ }
      }
    }
  }
  if (classification.subtypes.length || harvestableAuth.found) {
    const assessment = transplantAssessment(project, 'authentication', harvestableAuth);
    const missing = [];
    if (!harvestableAuth.found) {
      const roles = classification.roles;
      if (!roles.includes('login')) missing.push({ id: 'login-route', requiredFor: 'harvest', why: 'no route matching /login, /signin or /authorize was recognised' });
      if (!classification.hashAlgorithm) missing.push({ id: 'password-hashing', requiredFor: 'harvest', why: 'this project validates no password itself' + (classification.credentialAuthority.kind === 'hosted-provider' ? ` (credentials live with ${classification.providers.join(', ')})` : '') });
      if (!classification.cookieName) missing.push({ id: 'session-cookie-constant', requiredFor: 'harvest', why: 'no cookie-name constant the harvester can read' });
    }
    const strong = auth.signals.length >= 5;
    const state = harvestableAuth.found && assessment.transplantSupport === 'supported' ? 'TRANSPLANTABLE'
      : harvestableAuth.found ? 'HARVESTABLE'
        : assessment.blockers.some((b) => b.id === 'unsupported-runtime') ? 'UNSUPPORTED'
          : classification.subtypes.includes('custom-unknown') && !strong ? 'AMBIGUOUS'
            : strong ? 'STRONGLY_DETECTED' : 'OBSERVED';
    observations.push(finalise({
      projectId, capability: 'authentication',
      state, subtypes: classification.subtypes, audience: classification.audience,
      auth: { audience: classification.audience, credentialAuthority: classification.credentialAuthority, sessionTransport: classification.sessionTransport,
        sessionCustody: classification.sessionCustody, sessionStore: classification.sessionStore,
        sessionDurableAcrossRestart: classification.sessionDurableAcrossRestart, cookieName: classification.cookieName,
        cookieFlags: classification.cookieFlags, hashAlgorithm: classification.hashAlgorithm, providers: classification.providers,
        routeRoles: classification.roles, protectedRoutes: auth.protectedRoutes },
      signals: auth.signals, missingSignals: missing,
      harvestable: harvestableAuth.found, harvestConfidence: harvestableAuth.confidence || null, harvestCategory, harvestRoot,
      providerSeam: harvestableAuth.seam?.verification || null,
      ...assessment,
      externalDependencies: classification.providers.map((p) => ({ provider: p, hosts: project.externalHosts.filter((h) => PROVIDERS.find((x) => x.id === p)?.host?.test(h) || []) })),
    }, project));
  }

  // Capability Forms 0.1a: the same kind can appear in library form, which the service detectors
  // cannot see. Its behaviour can be verified while no destination integration exists for it, so
  // the observation says both things and never claims transplant support.
  let libraryFlags = { found: false, signals: [] };
  try { libraryFlags = detectFlagsLibrary(asFingerprint); } catch { /* ignore */ }
  if (libraryFlags.found) {
    observations.push(finalise({
      projectId, capability: 'feature-flags', implementationForm: 'library',
      state: 'HARVESTABLE',
      subtypes: ['library', libraryFlags.packageName ? `package:${libraryFlags.packageName}` : null].filter(Boolean),
      signals: libraryFlags.signals,
      missingSignals: [],
      harvestable: true, harvestConfidence: libraryFlags.confidence || null, harvestCategory: 'feature-flags-library', harvestRoot: project.root,
      // Where a library can go is decided by the adaptation authority, never asserted here.
      ...(() => {
        const integration = describeLibraryIntegration({ kind: 'feature-flags' });
        const blockers = integration.supported ? [] : [{ id: 'library-integration-unavailable', detail: integration.reason }];
        return { transplantSupport: integration.supported ? 'supported-by-adaptation' : 'unsupported', transplantBlockers: blockers,
          destinationSupport: integration.supported ? 'supported-by-adaptation' : 'unsupported', destinationBlockers: blockers,
          destinationNote: integration.reason, destinationTargets: integration.targets };
      })(),
      library: { artifact: libraryFlags.entry, packageName: libraryFlags.packageName, packageVersion: libraryFlags.packageVersion, moduleSystem: libraryFlags.moduleSystem, runtime: libraryFlags.runtime, runtimeDependencies: libraryFlags.runtimeDependencies },
      externalDependencies: [],
    }, project));
  }
  const flags = flagObservationFor(project);
  let harvestableFlags = { found: false, signals: [] };
  try { harvestableFlags = detectHarvestableFlags(asFingerprint); } catch { /* ignore */ }
  if (flags.signals.length || harvestableFlags.found) {
    const assessment = transplantAssessment(project, 'feature-flags', harvestableFlags);
    observations.push(finalise({
      projectId, capability: 'feature-flags',
      state: harvestableFlags.found && assessment.transplantSupport === 'supported' ? 'TRANSPLANTABLE' : harvestableFlags.found ? 'HARVESTABLE' : flags.signals.length >= 3 ? 'STRONGLY_DETECTED' : 'OBSERVED',
      subtypes: [flags.source, flags.scope && `${flags.scope}-scoped`].filter(Boolean),
      flags: { source: flags.source, scope: flags.scope },
      signals: flags.signals, missingSignals: harvestableFlags.found ? [] : [{ id: 'flag-endpoint-or-defaults', requiredFor: 'harvest', why: 'the feature-flag harvester needs a flag module with defaults and an evaluation endpoint' }],
      harvestable: harvestableFlags.found, harvestConfidence: harvestableFlags.confidence || null,
      ...assessment, externalDependencies: [],
    }, project));
  }
  return observations;
}

/** Local-verification feasibility, and the observation id. Everything an operator needs to judge a candidate. */
function finalise(observation, project) {
  const externalHosts = observation.externalDependencies?.flatMap((d) => d.hosts) || [];
  const needsProvider = observation.auth?.credentialAuthority?.kind === 'hosted-provider' || observation.auth?.credentialAuthority?.kind === 'external-idp';
  const seam = observation.providerSeam?.kind === 'factory-injection';
  const reasons = [];
  if (!seam) {
    // Without a factory seam the usual constraints apply; with one, the source is composed from
    // its own modules with a provider double — no build step, no live provider.
    if (!project.hasHttpServer) reasons.push('the project starts no HTTP server GRAFT could exercise');
    if (!project.entrypoint) reasons.push('no entrypoint could be identified');
    if (project.entrypoint?.generated && !project.entrypoint.source) reasons.push('the only entrypoint is generated output that must be built first');
    if (project.isCompiled) reasons.push('a build step is required before the project runs');
    if (needsProvider) reasons.push(`credentials are validated by ${observation.auth.providers.join(', ')}, which GRAFT cannot exercise without live credentials and network access`);
  }
  if (externalHosts.length && !seam) reasons.push(`calls out to ${[...new Set(externalHosts)].join(', ')}`);
  const complete = { observationVersion: OBSERVATION_VERSION, ...observation,
    localVerification: { feasible: reasons.length === 0, reasons, ...(seam ? { strategy: 'factory-injection seam with a deterministic provider double' } : {}) },
    confidence: observation.signals.length >= 6 ? 'high' : observation.signals.length >= 3 ? 'medium' : 'low' };
  complete.observationId = sha({ projectId: complete.projectId, capability: complete.capability, subtypes: complete.subtypes,
    signals: complete.signals.map((s) => s.id).sort() });
  return complete;
}
