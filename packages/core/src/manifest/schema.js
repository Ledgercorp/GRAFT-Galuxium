import path from 'node:path';

export const MANIFEST_VERSION = '0.2.0';

/** The eleven sections of a portable GRAFT feature package. */
export const SECTIONS = Object.freeze({
  identity: 'identity.json',
  behavior: 'behavior.md',
  architecture: 'architecture.json',
  dependencies: 'dependencies.json',
  interfaces: 'interfaces.json',
  dataModel: 'data-model.json',
  environment: 'environment.json',
  security: 'security.md',
  acceptanceTests: 'acceptance-tests.json',
  sourceMap: 'source-map.json',
  provenance: 'provenance.json',
});

export const CAPABILITY_CATEGORIES = Object.freeze([
  'authentication',
  'billing',
  'onboarding',
  'file-uploads',
  'dashboard',
  'crud',
  'api-integration',
  'ai-chat',
  'agent-tooling',
  'admin',
  'feature-flags',
  'hosted-authentication',
]);

// Request headers an acceptance step may set. Same-origin/CSRF witnesses need these; a
// credential header is never one of them. `cookie` is allowed only so a counterfactual can
// present a deliberately unknown session, and its value must be a plain name=value pair.
export const STEP_HEADER_NAMES = Object.freeze(['origin', 'x-csrf-token', 'x-requested-with', 'sec-fetch-site', 'sec-fetch-mode', 'referer', 'cookie']);
// Any short custom `x-` header is also allowed: a source's CSRF header name is its own, never a
// name GRAFT knows in advance. Credential-bearing headers stay excluded by the fixed list.
const CUSTOM_HEADER = /^x-[a-z0-9-]{1,40}$/;
const stepHeaderAllowed = (name) => STEP_HEADER_NAMES.includes(name) || (CUSTOM_HEADER.test(name) && !/authorization|token$|key$|secret/.test(name));
const HEADER_VALUE = /^[\x20-\x7e]{1,300}$/;
export const CAPTURE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const REDIRECT_PATH = /^\/[A-Za-z0-9\-._~/?=&]{0,255}$/;

/** Anything matching these is refused entry into a manifest. Manifests are portable; secrets are not. */
const SECRET_VALUE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

export const SOURCE_VERDICTS = Object.freeze(['VERIFIED', 'FAILED', 'NEEDS_REVIEW']);

// The only regex shape an acceptance test may carry: ^[class]{n} | {n,m} | + | *$ — linear-time by
// construction, so a hostile manifest cannot stall the verifier.
export const SAFE_VALUE_PATTERN = /^\^\[[A-Za-z0-9_\-]{1,40}\](?:\{\d{1,4}(?:,\d{1,4})?\}|\+|\*)\$$/;

/** Returns a deep copy with every secret-shaped string replaced. Used on captured evidence. */
export function redactSecrets(value) {
  const walk = (node) => {
    if (typeof node === 'string') {
      let out = node;
      for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(new RegExp(pattern.source, 'g'), '[redacted]');
      return out;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    return node;
  };
  return walk(value);
}

export function findSecretLeaks(value, path = '$') {
  const leaks = [];
  const walk = (node, at) => {
    if (typeof node === 'string') {
      for (const pattern of SECRET_VALUE_PATTERNS) {
        if (pattern.test(node)) leaks.push({ at, pattern: String(pattern) });
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${at}[${i}]`));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
    }
  };
  walk(value, path);
  return leaks;
}

function req(errors, cond, message) { if (!cond) errors.push(message); }

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => Array.isArray(value) ? value : [];
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

/** Validate the executable test language before a project is started. */
export function validateAcceptanceTests(tests) {
  const errors = [];
  req(errors, Array.isArray(tests) && tests.length > 0, 'acceptanceTests.tests must be non-empty');
  const ids = new Set();
  for (const [i, test] of list(tests).entries()) {
    const at = `acceptanceTests.tests[${i}]`;
    if (!record(test)) { errors.push(`${at} must be an object`); continue; }
    req(errors, nonempty(test.id) && !ids.has(test.id), `${at}.id must be non-empty and unique`);
    ids.add(test.id);
    req(errors, ['http', 'library'].includes(test.kind), `${at}.kind must be "http" or "library"`);
    if (test.kind === 'library') {
      // A library case constructs the capability from configuration and calls its operations.
      req(errors, typeof test.required === 'boolean', `${at}.required must be boolean`);
      req(errors, nonempty(test.provesBehavior), `${at}.provesBehavior must reference a behavior id`);
      req(errors, Array.isArray(test.steps) && test.steps.length > 0, `${at}.steps must be non-empty`);
      req(errors, test.construct === undefined || (record(test.construct) && record(test.construct.options)), `${at}.construct must carry options when present`);
      for (const [j, step] of list(test.steps).entries()) {
        const where = `${at}.steps[${j}]`;
        if (!record(step)) { errors.push(`${where} must be an object`); continue; }
        req(errors, nonempty(step.name), `${where}.name is required`);
        req(errors, /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(step.call || ''), `${where}.call must name a public operation`);
        req(errors, step.args === undefined || Array.isArray(step.args), `${where}.args must be an array`);
        req(errors, record(step.expect) && ['equals', 'branch', 'sameAs'].some((k) => k in step.expect), `${where}.expect must state equals, branch or sameAs`);
      }
      continue;
    }
    req(errors, typeof test.required === 'boolean', `${at}.required must be boolean`);
    req(errors, nonempty(test.provesBehavior), `${at}.provesBehavior must reference a behavior id`);
    req(errors, Array.isArray(test.steps) && test.steps.length > 0, `${at}.steps must be non-empty`);
    for (const [j, step] of list(test.steps).entries()) {
      const where = `${at}.steps[${j}]`;
      if (!record(step)) { errors.push(`${where} must be an object`); continue; }
      if (step.restart === true) { req(errors, nonempty(step.name) && Object.keys(step).every((k) => ['name', 'restart'].includes(k)), `${where} restart step carries only a name`); continue; }
      req(errors, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(step.method), `${where}.method is unsupported`);
      req(errors, typeof step.path === 'string' && /^\/(?!\/)[^\s\\#?]*$/.test(step.path), `${where}.path must be a local absolute HTTP path without a query string (use query)`);
      // Engine 1.2 step fields: fixed headers, a query built from literals or earlier captures, and
      // captures taken from a redirect's Location query. Each is bounded and validated here.
      if ('headers' in step) req(errors, record(step.headers) && Object.entries(step.headers).every(([k, v]) => stepHeaderAllowed(k.toLowerCase()) && typeof v === 'string' && HEADER_VALUE.test(v) && (k.toLowerCase() !== 'cookie' || /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}=[A-Za-z0-9_\-]{1,128}$/.test(v))), `${where}.headers may only set ${STEP_HEADER_NAMES.join(', ')} or a short custom x- header to short printable values (cookie: one plain name=value pair)`);
      if ('query' in step) req(errors, record(step.query) && Object.keys(step.query).length <= 8 && Object.entries(step.query).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) && ((typeof v === 'string' && HEADER_VALUE.test(v)) || (record(v) && typeof v.capture === 'string' && CAPTURE_NAME.test(v.capture) && Object.keys(v).length <= 2 && (v.prefix === undefined || (typeof v.prefix === 'string' && /^[A-Za-z0-9_\-:]{0,32}$/.test(v.prefix)))))), `${where}.query must map safe names to short literal strings or { capture } references`);
      if ('providerControl' in step) req(errors, record(step.providerControl) && Object.keys(step.providerControl).every((k) => ['tokenLifetimeSeconds', 'refreshSubject'].includes(k)) && (step.providerControl.tokenLifetimeSeconds === undefined || (Number.isInteger(step.providerControl.tokenLifetimeSeconds) && step.providerControl.tokenLifetimeSeconds >= 1 && step.providerControl.tokenLifetimeSeconds <= 3600)) && (step.providerControl.refreshSubject === undefined || step.providerControl.refreshSubject === null || (typeof step.providerControl.refreshSubject === 'string' && /^[a-z0-9-]{1,40}$/.test(step.providerControl.refreshSubject))), `${where}.providerControl may set tokenLifetimeSeconds (1-3600) and refreshSubject only`);
      if ('captureQuery' in step) req(errors, record(step.captureQuery) && Object.keys(step.captureQuery).length <= 8 && Object.entries(step.captureQuery).every(([k, v]) => CAPTURE_NAME.test(k) && typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(v)), `${where}.captureQuery must map capture names to redirect query parameter names`);
      const expect = step.expect;
      if (!record(expect) || Object.keys(expect).length === 0) { errors.push(`${where}.expect must contain an assertion`); continue; }
      for (const key of Object.keys(expect)) req(errors, ['status', 'setsCookie', 'notSetsCookie', 'bodyMatches', 'noSetCookie', 'sameBodyAs', 'cookieFlags', 'cookieValuePattern', 'redirectPath', 'redirectPathStartsWith', 'redirectQueryHas', 'redirectToProvider', 'providerCalled', 'providerNotCalled', 'noSecretsInOutput'].includes(key), `${where}.expect.${key} is unsupported`);
      if ('noSecretsInOutput' in expect) req(errors, expect.noSecretsInOutput === true, `${where}.expect.noSecretsInOutput must be true`);
      if ('redirectPath' in expect) req(errors, typeof expect.redirectPath === 'string' && REDIRECT_PATH.test(expect.redirectPath), `${where}.expect.redirectPath must be a local path`);
      if ('redirectPathStartsWith' in expect) req(errors, typeof expect.redirectPathStartsWith === 'string' && REDIRECT_PATH.test(expect.redirectPathStartsWith), `${where}.expect.redirectPathStartsWith must be a local path prefix`);
      if ('redirectQueryHas' in expect) req(errors, Array.isArray(expect.redirectQueryHas) && expect.redirectQueryHas.length > 0 && expect.redirectQueryHas.length <= 8 && expect.redirectQueryHas.every((k) => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)), `${where}.expect.redirectQueryHas must list query parameter names`);
      if ('redirectToProvider' in expect) req(errors, expect.redirectToProvider === true || (typeof expect.redirectToProvider === 'string' && REDIRECT_PATH.test(expect.redirectToProvider)), `${where}.expect.redirectToProvider must be true or the provider path the redirect must end with`);
      for (const key of ['providerCalled', 'providerNotCalled']) if (key in expect) req(errors, typeof expect[key] === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(expect[key]), `${where}.expect.${key} must name a provider operation`);
      if ('noSetCookie' in expect) req(errors, expect.noSetCookie === true, `${where}.expect.noSetCookie must be true`);
      if ('sameBodyAs' in expect) req(errors, nonempty(expect.sameBodyAs) && list(test.steps).slice(0, j).some((s) => s?.name === expect.sameBodyAs), `${where}.expect.sameBodyAs must name an earlier step`);
      if ('cookieFlags' in expect) req(errors, record(expect.cookieFlags) && Object.entries(expect.cookieFlags).every(([k, v]) => ['HttpOnly', 'Secure', 'SameSite', 'Path'].includes(k) && (typeof v === 'boolean' || nonempty(v))), `${where}.expect.cookieFlags must map HttpOnly/Secure/SameSite/Path to booleans or values`);
      if ('cookieValuePattern' in expect) req(errors, SAFE_VALUE_PATTERN.test(expect.cookieValuePattern || ''), `${where}.expect.cookieValuePattern must be an anchored character class with a bounded quantifier, e.g. ^[0-9a-f]{48}$`);
      if ('status' in expect) {
        const statuses = Array.isArray(expect.status) ? expect.status : [expect.status];
        req(errors, statuses.length > 0 && statuses.every((s) => Number.isInteger(s) && s >= 100 && s <= 599), `${where}.expect.status must contain HTTP status codes`);
      }
      for (const key of ['setsCookie', 'notSetsCookie']) if (key in expect) req(errors, nonempty(expect[key]), `${where}.expect.${key} must name a cookie`);
      if ('bodyMatches' in expect) req(errors, record(expect.bodyMatches) && Object.keys(expect.bodyMatches).length > 0 && Object.entries(expect.bodyMatches).every(([k, v]) => nonempty(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))), `${where}.expect.bodyMatches must contain scalar assertions`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Structural validation of a manifest object. Pure; no I/O.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest is not an object'] };

  const { identity, behavior, architecture, dependencies, interfaces, dataModel, environment, security, acceptanceTests, sourceMap, provenance } = manifest;

  req(errors, identity && typeof identity.name === 'string' && identity.name.length > 0, 'identity.name is required');
  req(errors, identity && typeof identity.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identity.slug), 'identity.slug must be a safe lowercase slug');
  req(errors, identity && CAPABILITY_CATEGORIES.includes(identity.category), `identity.category must be one of ${CAPABILITY_CATEGORIES.join(', ')}`);
  req(errors, identity && typeof identity.sourceProject === 'string', 'identity.sourceProject is required');
  req(errors, identity && typeof identity.extractedAt === 'string', 'identity.extractedAt is required');
  req(errors, identity && identity.manifestVersion === MANIFEST_VERSION, `identity.manifestVersion must be ${MANIFEST_VERSION}`);
  // Capability Forms 0.1a: an optional, closed dimension. Absent means "not recorded" — never a
  // claim — so every manifest written before this field stays valid.
  req(errors, identity?.implementationForm === undefined || identity?.implementationForm === null || ['service', 'library'].includes(identity.implementationForm), 'identity.implementationForm must be service or library when present');

  req(errors, behavior && Array.isArray(behavior.statements) && behavior.statements.length > 0, 'behavior.statements must be a non-empty array');
  if (behavior && Array.isArray(behavior.statements)) {
    behavior.statements.forEach((s, i) => {
      req(errors, s && typeof s.id === 'string', `behavior.statements[${i}].id is required`);
      req(errors, s && typeof s.text === 'string', `behavior.statements[${i}].text is required`);
      req(errors, s && Array.isArray(s.evidence) && s.evidence.length > 0,
        `behavior.statements[${i}] must cite evidence (a behavior claim without evidence is a fabrication)`);
    });
  }

  req(errors, architecture && typeof architecture === 'object', 'architecture is required');
  if (identity?.category === 'feature-flags' && (identity?.implementationForm === 'library' || architecture?.capabilityModel?.implementationForm === 'library')) {
    // Library form: no routes exist, so none are required or allowed to be invented. What must be
    // present is the artifact a consumer loads and the operations it exposes.
    const model = architecture?.capabilityModel;
    req(errors, record(model) && model.kind === 'feature-flags' && model.implementationForm === 'library', 'architecture.capabilityModel must describe feature-flags in library form');
    req(errors, record(model?.artifact) && typeof model.artifact.entry === 'string' && model.artifact.entry.length > 0 && !path.isAbsolute(model.artifact.entry), 'capabilityModel.artifact.entry must be a project-relative path');
    req(errors, ['commonjs', 'esm'].includes(model?.artifact?.moduleSystem), 'capabilityModel.artifact.moduleSystem must be commonjs or esm');
    req(errors, Array.isArray(model?.operations) && model.operations.length > 0 && model.operations.every((o) => record(o) && nonempty(o.id) && nonempty(o.name) && nonempty(o.role) && Array.isArray(o.inputs)), 'capabilityModel.operations must describe the public operations');
    req(errors, !Array.isArray(model?.endpoints) || model.endpoints.length === 0, 'a library capability must declare no HTTP endpoints');
    req(errors, !Array.isArray(interfaces?.inbound) || interfaces.inbound.length === 0, 'a library capability must declare no inbound HTTP interfaces');
  } else if (identity?.category === 'feature-flags') {
    const model = architecture?.capabilityModel;
    req(errors, record(model) && model.kind === 'feature-flags', 'architecture.capabilityModel must describe feature-flags');
    req(errors, record(model?.configuration) && record(model.configuration.defaults) && Object.keys(model.configuration.defaults).length > 0
      && Object.entries(model.configuration.defaults).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'boolean'), 'feature-flags defaults must map safe names to booleans');
    req(errors, model?.configuration?.envVar === null || model?.configuration?.envVar === undefined || /^[A-Z][A-Z0-9_]{0,63}$/.test(model.configuration.envVar), 'feature-flags envVar must be an environment variable name');
    req(errors, Array.isArray(model?.endpoints) && model.endpoints.length > 0 && model.endpoints.every((e) => record(e) && ['list', 'evaluate'].includes(e.role) && ['GET', 'POST'].includes(e.method) && typeof e.path === 'string'), 'feature-flags endpoints must have list/evaluate roles');
  }
  if (identity?.category === 'hosted-authentication') {
    const model = architecture?.capabilityModel;
    req(errors, record(model) && model.kind === 'hosted-session-auth', 'architecture.capabilityModel must describe hosted-session-auth');
    req(errors, record(model?.credentialAuthority) && model.credentialAuthority.kind === 'hosted-provider' && nonempty(model.credentialAuthority.provider) && Array.isArray(model.credentialAuthority.protocols) && model.credentialAuthority.protocols.includes('oauth2'), 'hosted-session-auth must name a hosted-provider credential authority using oauth2');
    req(errors, record(model?.provider) && record(model.provider.endpoints) && ['authorize', 'token', 'revoke'].every((k) => typeof model.provider.endpoints[k] === 'string' && /^\/[A-Za-z0-9\-._~/]{0,120}$/.test(model.provider.endpoints[k])) && typeof model.provider.defaultOrigin === 'string' && /^https:\/\/[a-z0-9.-]+$/.test(model.provider.defaultOrigin), 'hosted-session-auth must describe the provider endpoints and an https default origin');
    req(errors, record(model?.session) && model.session.transport === 'cookie' && model.session.custody === 'local' && ['memory', 'database'].includes(model.session.store) && typeof model.session.durableAcrossRestart === 'boolean' && nonempty(model.session.cookieName) && nonempty(model.session.flowCookieName), 'hosted-session-auth session must be a locally custodied cookie session with a declared store and durability');
    req(errors, record(model?.guard) && Number.isInteger(model.guard.unauthenticatedStatus), 'hosted-session-auth guard must declare its unauthenticated status');
    req(errors, record(model?.providerSeam) && ['factory-injection', 'endpoint-configuration', 'unavailable'].includes(model.providerSeam.verification?.kind), 'hosted-session-auth must declare how a verification provider double is injected, or that no seam is available');
    const roles = new Set();
    for (const endpoint of list(model?.endpoints)) {
      const methods = { login: 'GET', callback: 'GET', logout: 'POST', session: 'GET' };
      req(errors, record(endpoint) && Object.hasOwn(methods, endpoint.role) && !roles.has(endpoint.role) && endpoint.method === methods[endpoint.role] && typeof endpoint.path === 'string', 'hosted-session-auth endpoints must have unique login/callback/logout/session roles with matching methods');
      roles.add(endpoint?.role);
    }
    for (const role of ['login', 'callback', 'logout', 'session']) req(errors, roles.has(role), `hosted-session-auth must declare a ${role} endpoint`);
    req(errors, !record(model?.passwordHash), 'a hosted-provider capability must not claim to hash passwords');
  }
  if (identity?.category === 'authentication') {
    const model = architecture?.capabilityModel;
    req(errors, record(model) && model.kind === 'session-auth', 'architecture.capabilityModel must describe session-auth');
    for (const field of ['session', 'passwordHash', 'guard']) req(errors, record(model?.[field]), `architecture.capabilityModel.${field} must be an object`);
    req(errors, Array.isArray(model?.endpoints) && model.endpoints.length > 0, 'architecture.capabilityModel.endpoints must be non-empty');
    const roles = new Set();
    for (const endpoint of list(model?.endpoints)) {
      const methods = { register: 'POST', login: 'POST', logout: 'POST', currentUser: 'GET' };
      req(errors, record(endpoint) && Object.hasOwn(methods, endpoint.role) && !roles.has(endpoint.role) && endpoint.method === methods[endpoint.role] && typeof endpoint.path === 'string', 'capability endpoints must have unique supported roles, matching HTTP methods, and string paths');
      roles.add(endpoint?.role);
    }
  }
  req(errors, dependencies && Array.isArray(dependencies.packages), 'dependencies.packages must be an array');
  req(errors, interfaces && Array.isArray(interfaces.inbound), 'interfaces.inbound must be an array');
  req(errors, dataModel && Array.isArray(dataModel.entities), 'dataModel.entities must be an array');
  req(errors, environment && Array.isArray(environment.variables), 'environment.variables must be an array');
  if (environment && Array.isArray(environment.variables)) {
    environment.variables.forEach((v, i) => {
      req(errors, v && typeof v.name === 'string', `environment.variables[${i}].name is required`);
      req(errors, !(record(v) && 'value' in v), `environment.variables[${i}] carries a value; manifests record names only`);
    });
  }
  req(errors, security && Array.isArray(security.assumptions), 'security.assumptions must be an array');

  errors.push(...validateAcceptanceTests(acceptanceTests?.tests).errors);
  if (acceptanceTests && Array.isArray(acceptanceTests.tests)) {
    acceptanceTests.tests.forEach((t, i) => {
      req(errors, t && typeof t.id === 'string', `acceptanceTests.tests[${i}].id is required`);
      req(errors, t && ['http', 'library'].includes(t.kind), `acceptanceTests.tests[${i}].kind must be "http" or "library" in manifest v${MANIFEST_VERSION}`);
      req(errors, t && Array.isArray(t.steps) && t.steps.length > 0, `acceptanceTests.tests[${i}].steps must be non-empty`);
      req(errors, t && typeof t.required === 'boolean', `acceptanceTests.tests[${i}].required must be boolean`);
      req(errors, t && typeof t.provesBehavior === 'string', `acceptanceTests.tests[${i}].provesBehavior must reference a behavior id`);
    });
    const behaviorIds = new Set(list(behavior?.statements).map((s) => s?.id));
    for (const t of acceptanceTests.tests) {
      if (t && t.provesBehavior && !behaviorIds.has(t.provesBehavior)) {
        errors.push(`acceptanceTests test "${t.id}" proves unknown behavior "${t.provesBehavior}"`);
      }
    }
    const covered = new Set(acceptanceTests.tests.map((t) => t?.provesBehavior));
    for (const s of list(behavior?.statements)) {
      if (s && !covered.has(s.id)) errors.push(`behavior "${s.id}" has no acceptance test; it cannot be verified after transplant`);
    }
  }

  req(errors, sourceMap && Array.isArray(sourceMap.files), 'sourceMap.files must be an array');
  req(errors, provenance && typeof provenance.generator === 'string', 'provenance.generator is required');
  // Source verification is a structured claim, never a bare true/false. A manifest that
  // cannot say how it knows the source worked is not allowed to say that it did.
  const vis = provenance?.verifiedInSource;
  req(errors, vis && typeof vis === 'object', 'provenance.verifiedInSource must be an object');
  if (vis && typeof vis === 'object') {
    req(errors, SOURCE_VERDICTS.includes(vis.verdict), `provenance.verifiedInSource.verdict must be one of ${SOURCE_VERDICTS.join(', ')}`);
    req(errors, typeof vis.rationale === 'string' && vis.rationale.length > 0, 'provenance.verifiedInSource.rationale is required');
    req(errors, typeof vis.at === 'string', 'provenance.verifiedInSource.at is required');
    if (vis.verdict === 'VERIFIED') {
      const required = list(acceptanceTests?.tests).filter((t) => t?.required === true);
      const evidence = list(vis.tests);
      req(errors, required.length > 0 && required.every((test) => evidence.filter((r) => r?.id === test.id && r.required === true && r.outcome === 'passed').length === 1)
        && new Set(evidence.map((r) => r?.id)).size === evidence.length
        && evidence.every((r) => record(r) && (/^output\./.test(r.id) || list(acceptanceTests?.tests).some((t) => t?.id === r.id && t.required === r.required)) && ['passed', 'failed', 'inconclusive'].includes(r.outcome)),
        'provenance.verifiedInSource claims VERIFIED without a passing test for every required acceptance test');
      // Only runtimes GRAFT itself owns can back a VERIFIED claim: the entrypoint boot, or the
      // factory-injection harness that composes a hosted capability with the provider double.
      req(errors, ['node-entrypoint', 'factory-injection-harness', 'library-artifact'].includes(vis.runtime?.profile), 'provenance.verifiedInSource.runtime.profile must be supported for a VERIFIED claim');
      // The verifier may add its own required witnesses (ids prefixed `output.`, e.g. the process-output
      // secret scan); they must all have passed too, and nothing else may inflate the summary.
      const witnesses = (vis.tests || []).filter((t) => /^output\./.test(t.id));
      req(errors, witnesses.every((t) => t.required === true && t.outcome === 'passed') && (vis.tests || []).every((t) => /^output\./.test(t.id) || list(acceptanceTests?.tests).some((x) => x?.id === t.id)), 'provenance.verifiedInSource.tests may only add passing runner witnesses beyond the manifest tests');
      req(errors, vis.summary?.required === required.length + witnesses.length && vis.summary?.passed === required.length + witnesses.length && vis.summary?.failed === 0 && vis.summary?.inconclusive === 0, 'provenance.verifiedInSource.summary must agree with required acceptance tests');
      req(errors, vis.skipped !== true, 'provenance.verifiedInSource cannot be both skipped and VERIFIED');
    }
  }

  for (const leak of findSecretLeaks(manifest)) errors.push(`possible secret value at ${leak.at}`);

  return { ok: errors.length === 0, errors };
}
