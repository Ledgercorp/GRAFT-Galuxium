import { parse } from 'acorn';
import { identifier, moduleSpecifier } from '../util/safe.js';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const STATIC_PATH = /^\/[A-Za-z0-9\-._~/]*$/;

export function parseJavaScript(source) {
  try { return parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true }); }
  catch { return null; }
}

export function walkNodes(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) for (const child of value) walkNodes(child, visit);
    else if (value && typeof value === 'object') walkNodes(value, visit);
  }
}

function memberCall(call) {
  const c = call?.type === 'CallExpression' ? call.callee : null;
  if (c?.type !== 'MemberExpression' || c.computed || c.object.type !== 'Identifier') return null;
  return { app: c.object.name, method: c.property.name, call };
}

function directCall(statement) {
  return statement.type === 'ExpressionStatement' ? statement.expression : null;
}

/** A deliberately narrow Express entrypoint contract. Unknown wiring is refused. */
export function inspectExpressEntrypoint(source) {
  const ast = parseJavaScript(source);
  const refuse = (reason) => ({ supported: false, reason });
  if (!ast) return refuse('entrypoint-is-not-supported-javascript');
  const imports = ast.body.filter((n) => n.type === 'ImportDeclaration' && n.source.value === 'express');
  const expressName = imports[0]?.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')?.local.name;
  if (imports.length !== 1 || !expressName) return refuse('requires-one-default-express-import');
  const declarations = ast.body.flatMap((s) => {
    const n = s.type === 'ExportNamedDeclaration' ? s.declaration : s;
    return n?.type === 'VariableDeclaration' ? n.declarations : [];
  });
  const apps = declarations.filter((d) => d.id.type === 'Identifier' && d.init?.type === 'CallExpression'
    && d.init.callee.type === 'Identifier' && d.init.callee.name === expressName && d.init.arguments.length === 0);
  if (apps.length !== 1) return refuse('requires-one-top-level-express-application');
  const appName = apps[0].id.name;
  const topCalls = new Set(ast.body.map(directCall).filter(Boolean));
  const listenCalls = new Set(declarations.map((d) => d.init).filter(Boolean));
  const routes = [];
  let reason = null;
  let listens = 0;
  walkNodes(ast, (n) => {
    if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === appName && n.computed) {
      reason ||= 'computed-express-methods-are-not-supported';
    }
    const c = memberCall(n);
    if (c?.app === appName) {
      if (c.method === 'listen') {
        if (!topCalls.has(n) && !listenCalls.has(n)) reason ||= 'requires-top-level-app-listen';
        listens += 1;
      } else if (VERBS.has(c.method)) {
        if (!topCalls.has(n)) reason ||= 'nested-or-chained-routes-are-not-supported';
        const route = n.arguments[0];
        if (route?.type !== 'Literal' || typeof route.value !== 'string' || !STATIC_PATH.test(route.value)) {
          reason ||= 'dynamic-or-parameterized-routes-are-not-supported';
        } else routes.push({ method: c.method.toUpperCase(), path: route.value });
      } else if (c.method === 'use') {
        if (!topCalls.has(n)) reason ||= 'nested-middleware-is-not-supported';
        if (!n.arguments.length || n.arguments.some((a) => {
          if (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') return false;
          const middleware = memberCall(a);
          return !(middleware?.app === expressName && ['json', 'urlencoded', 'raw', 'text'].includes(middleware.method));
        })) reason ||= 'mounted-or-imported-middleware-needs-manual-integration';
      } else if (!['set', 'disable', 'enable'].includes(c.method)) reason ||= 'unsupported-express-registration-method';
    }
    if (n.type === 'CallExpression' && n.arguments.some((a) => a.type === 'Identifier' && a.name === appName)) {
      reason ||= 'external-app-registration-needs-manual-integration';
    }
  });
  if (listens !== 1) reason ||= 'requires-one-app-listen';
  if (!routes.length) reason ||= 'no-route-registration-site-found';
  return reason ? refuse(reason) : { supported: true, appName, routes };
}

/**
 * An Express entrypoint that can take a guard-first middleware: one default `express` import,
 * one top-level `express()` application, at least one top-level path-bearing registration
 * (`app.get('/x', …)` or a mounted router `app.use('/x', …)`) to insert before, and a top-level
 * `app.listen`. Mounted routers and imported middleware are welcome here: the guard runs before
 * them and declines every request that is not the capability's, so nothing else changes.
 */
export function inspectExpressGuardSite(source) {
  const ast = parseJavaScript(source);
  const refuse = (reason) => ({ supported: false, reason });
  if (!ast) return refuse('entrypoint-is-not-supported-javascript');
  const imports = ast.body.filter((n) => n.type === 'ImportDeclaration' && n.source.value === 'express');
  const expressName = imports[0]?.specifiers.find((s) => s.type === 'ImportDefaultSpecifier')?.local.name;
  if (imports.length !== 1 || !expressName) return refuse('requires-one-default-express-import');
  const unwrap = (st) => (st.type === 'ExportNamedDeclaration' ? st.declaration : st);
  const appStatements = ast.body.filter((st) => { const n = unwrap(st); return n?.type === 'VariableDeclaration' && n.declarations.some((d) => d.id.type === 'Identifier' && d.init?.type === 'CallExpression' && d.init.callee.type === 'Identifier' && d.init.callee.name === expressName && d.init.arguments.length === 0); });
  if (appStatements.length !== 1) return refuse('requires-one-top-level-express-application');
  const appStatement = appStatements[0];
  const appName = unwrap(appStatement).declarations.find((d) => d.init?.callee?.name === expressName).id.name;
  let computed = false;
  walkNodes(ast, (n) => { if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === appName && n.computed) computed = true; });
  if (computed) return refuse('computed-express-methods-are-not-supported');
  const mounts = [];
  let firstRegistration = null;
  let listens = 0;
  for (const st of ast.body) {
    const call = directCall(st) || (unwrap(st)?.type === 'VariableDeclaration' ? unwrap(st).declarations.map((d) => d.init).find((i) => i?.type === 'CallExpression') : null);
    const c = memberCall(call);
    if (!c || c.app !== appName) continue;
    if (c.method === 'listen') { listens += 1; continue; }
    const first = call.arguments[0];
    const pathBearing = first?.type === 'Literal' && typeof first.value === 'string' && first.value.startsWith('/');
    if ((VERBS.has(c.method) || c.method === 'use' || c.method === 'all') && pathBearing) {
      if (!firstRegistration) firstRegistration = st;
      if (c.method === 'use' && STATIC_PATH.test(first.value)) mounts.push(first.value);
    }
  }
  if (listens !== 1) return refuse('requires-one-app-listen');
  if (!firstRegistration) return refuse('no-route-registration-site-found');
  if (firstRegistration.start < appStatement.end) return refuse('routes-registered-before-application');
  const lastImport = ast.body.filter((n) => n.type === 'ImportDeclaration').at(-1);
  return { supported: true, appName, mounts: [...new Set(mounts)], anchorStart: firstRegistration.start, anchorLine: firstRegistration.loc.start.line,
    appStatementEnd: appStatement.end, appLine: appStatement.loc.start.line, lastImportEnd: lastImport?.end ?? null, lastImportLine: lastImport?.loc.end.line ?? null };
}

/**
 * Register a guard-first capability on an Express application: create the instance once after
 * the application, then mount one middleware before the first route or router. Every existing
 * middleware that precedes the routes (body parsing, request context) still runs first; every
 * request the capability declines continues to the existing routes exactly as before.
 */
function planExpressGuardEdit(source, { specifier, registrationName, marker, MARKER_START, MARKER_END, conflictingRoutes, resolveConflicts, routesModule }) {
  const refusal = (reason) => ({ applied: false, reason, source, edits: [] });
  const shape = inspectExpressGuardSite(source);
  if (!shape.supported) return refusal(shape.reason);
  if (shape.lastImportEnd === null) return refusal('no-import-block-found');
  if (conflictingRoutes.length && !resolveConflicts) return refusal('unresolved-conflicts');
  if (conflictingRoutes.length) return refusal('guard-conflicts-need-manual-integration');
  const instance = identifier(`graft${registrationName.replace(/^register/, '')}`, 'registration.instance');
  const replacements = [
    { start: shape.lastImportEnd, end: shape.lastImportEnd, text: `\nimport { ${registrationName} } from ${specifier};\n` },
    { start: shape.appStatementEnd, end: shape.appStatementEnd, text: `\n${MARKER_START}\nconst ${instance} = ${registrationName}({ env: process.env });\n${MARKER_END}` },
    { start: shape.anchorStart, end: shape.anchorStart, text: `${MARKER_START}\n${shape.appName}.use(async (req, res, next) => { if (await ${instance}.handle(req, res)) return; next(); });\n${MARKER_END}\n` },
  ];
  const edits = [
    { kind: 'add-import', module: routesModule, atLine: shape.lastImportLine + 1 },
    { kind: 'create-instance', call: `${registrationName}({ env: process.env })`, atLine: shape.appLine + 1 },
    { kind: 'guard-express-middleware', call: `${shape.appName}.use(… ${instance}.handle(req, res) …)`, atLine: shape.anchorLine },
  ];
  let edited = source;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) edited = edited.slice(0, r.start) + r.text + edited.slice(r.end);
  if (!parseJavaScript(edited)) return refusal('edited-entrypoint-does-not-parse');
  return { applied: true, source: edited, edits, removedRoutes: [] };
}

/**
 * A bare node:http entrypoint with one central request handler — `createServer(async (req, res) =>
 * { … })` — the shape Dogfood Phase 1 found in every real Node server. Deliberately narrow: one
 * top-level createServer call, one inline async handler with two parameters and a block body.
 * Anything else is refused with the reason, never guessed at.
 */
export function inspectCentralHandler(source) {
  const ast = parseJavaScript(source);
  const refuse = (reason) => ({ supported: false, reason });
  if (!ast) return refuse('entrypoint-is-not-supported-javascript');
  const calls = [];
  walkNodes(ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const callee = n.callee;
    const named = (callee.type === 'Identifier' && callee.name === 'createServer')
      || (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'createServer');
    if (named) calls.push(n);
  });
  if (calls.length !== 1) return refuse(calls.length ? 'requires-one-create-server-call' : 'no-create-server-call-found');
  const call = calls[0];
  const handler = call.arguments.find((a) => a.type === 'ArrowFunctionExpression' || a.type === 'FunctionExpression');
  if (!handler) return refuse('create-server-handler-is-not-inline');
  if (!handler.async) return refuse('central-handler-is-not-async');
  if (handler.params.length < 2 || handler.params.slice(0, 2).some((p) => p.type !== 'Identifier')) return refuse('central-handler-parameters-are-not-plain-identifiers');
  if (handler.body.type !== 'BlockStatement') return refuse('central-handler-has-no-block-body');
  // The statement that contains the createServer call is where the capability instance is created.
  const statement = ast.body.find((s) => s.start <= call.start && s.end >= call.end);
  if (!statement) return refuse('create-server-call-is-not-top-level');
  // The server must be created directly at module scope (a statement or declaration), not inside
  // a function that may run later, more than once, or never.
  if (!['ExpressionStatement', 'VariableDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(statement.type)) return refuse('create-server-call-is-nested');
  let nested = false;
  walkNodes(statement, (n) => { if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && n !== handler && n.start <= call.start && n.end >= call.end) nested = true; });
  if (nested) return refuse('create-server-call-is-nested');
  return { supported: true, request: handler.params[0].name, response: handler.params[1].name, bodyStart: handler.body.start + 1, statementStart: statement.start,
    lastImportEnd: ast.body.filter((n) => n.type === 'ImportDeclaration').at(-1)?.end ?? null, lastImportLine: ast.body.filter((n) => n.type === 'ImportDeclaration').at(-1)?.loc.end.line ?? null,
    statementLine: statement.loc.start.line, handlerLine: handler.body.loc.start.line };
}

/**
 * Register a capability into a central handler: create the instance once at module scope, then
 * give it first refusal on every request. Everything already in the handler — static files,
 * traversal protection, fallthrough — runs exactly as before for any request it declines.
 */
function planCentralHandlerEdit(source, { specifier, registrationName, marker, MARKER_START, MARKER_END, conflictingRoutes, resolveConflicts, routesModule }) {
  const refusal = (reason) => ({ applied: false, reason, source, edits: [] });
  const shape = inspectCentralHandler(source);
  if (!shape.supported) return refusal(shape.reason);
  if (shape.lastImportEnd === null) return refusal('no-import-block-found');
  // A path the handler already dispatches would be shadowed by the guard; that needs a person.
  if (conflictingRoutes.length && !resolveConflicts) return refusal('unresolved-conflicts');
  if (conflictingRoutes.length) return refusal('central-handler-conflicts-need-manual-integration');
  const instance = identifier(`graft${registrationName.replace(/^register/, '')}`, 'registration.instance');
  const replacements = [
    { start: shape.lastImportEnd, end: shape.lastImportEnd, text: `\nimport { ${registrationName} } from ${specifier};\n` },
    { start: shape.statementStart, end: shape.statementStart, text: `${MARKER_START}\nconst ${instance} = ${registrationName}({ env: process.env });\n${MARKER_END}\n` },
    { start: shape.bodyStart, end: shape.bodyStart, text: `\n  ${MARKER_START}\n  if (await ${instance}.handle(${shape.request}, ${shape.response})) return;\n  ${MARKER_END}` },
  ];
  const edits = [
    { kind: 'add-import', module: routesModule, atLine: shape.lastImportLine + 1 },
    { kind: 'create-instance', call: `${registrationName}({ env: process.env })`, atLine: shape.statementLine },
    { kind: 'guard-central-handler', call: `${instance}.handle(${shape.request}, ${shape.response})`, atLine: shape.handlerLine },
  ];
  let edited = source;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) edited = edited.slice(0, r.start) + r.text + edited.slice(r.end);
  if (!parseJavaScript(edited)) return refusal('edited-entrypoint-does-not-parse');
  return { applied: true, source: edited, edits, removedRoutes: [] };
}

/** Edit only complete parsed statements; preserve every other byte of the entrypoint. */
export function planEntrypointEdit(source, { routesModule, conflictingRoutes = [], resolveConflicts = false, profile = 'esm-return-response', registration = { name: 'registerAuthRoutes', marker: 'authentication' } }) {
  const registrationName = identifier(registration.name, 'registration.name');
  const marker = String(registration.marker || 'authentication');
  if (!/^[a-z0-9-]{1,64}$/.test(marker)) return { applied: false, reason: 'invalid-registration-marker', source, edits: [] };
  const MARKER_START = `// >>> graft:${marker}`;
  const MARKER_END = `// <<< graft:${marker}`;
  const refusal = (reason) => ({ applied: false, reason, source, edits: [] });
  if (source.includes(MARKER_START)) return refusal('already-grafted');
  const specifier = moduleSpecifier(routesModule, 'routesModule');
  const ast = parseJavaScript(source);
  if (!ast) return refusal('unsupported-javascript-syntax');
  const imports = ast.body.filter((n) => n.type === 'ImportDeclaration');
  if (!imports.length) return refusal('no-import-block-found');
  if (imports.some((n) => n.specifiers.some((s) => s.local.name === registrationName))) return refusal('registration-name-already-bound');
  if (profile === 'esm-node-http-central') return planCentralHandlerEdit(source, { specifier, registrationName, marker, MARKER_START, MARKER_END, conflictingRoutes, resolveConflicts, routesModule });
  if (profile === 'express-req-res' && registration.style === 'guard') return planExpressGuardEdit(source, { specifier, registrationName, marker, MARKER_START, MARKER_END, conflictingRoutes, resolveConflicts, routesModule });

  let appName;
  if (profile === 'express-req-res') {
    const shape = inspectExpressEntrypoint(source);
    if (!shape.supported) return refusal(shape.reason);
    appName = shape.appName;
  }
  const registrations = [];
  for (const statement of ast.body) {
    const call = directCall(statement);
    const c = memberCall(call);
    if (c && VERBS.has(c.method) && (!appName || appName === c.app)) {
      registrations.push({ statement, app: c.app, key: `${c.method.toUpperCase()} ${call.arguments[0]?.value}` });
    } else if (profile !== 'express-req-res' && call?.type === 'CallExpression' && call.callee.type === 'Identifier'
      && /^register\w+$/.test(call.callee.name) && call.arguments[0]?.type === 'Identifier') {
      registrations.push({ statement, app: call.arguments[0].name, key: null });
    }
  }
  if (!registrations.length) return refusal('no-route-registration-site-found');
  const appNames = new Set(registrations.map((r) => r.app));
  if (appNames.size !== 1) return refusal('ambiguous-application-registration');
  appName = identifier(registrations[0].app, 'destination.appVariable');
  const conflictSet = new Set(conflictingRoutes.map((r) => `${r.method} ${r.path}`));
  if (conflictSet.size && !resolveConflicts) return refusal('unresolved-conflicts');
  for (const key of conflictSet) {
    if (!registrations.some((r) => r.key === key)) return refusal('conflicting-route-is-not-a-top-level-statement');
  }

  const edits = [];
  const replacements = [];
  const removed = [];
  for (const { statement, key } of registrations) {
    if (!conflictSet.has(key)) continue;
    const text = source.slice(statement.start, statement.end);
    // A line comment also consumes following source on the same line. End with a
    // newline and prefix every original line so no callback fragment remains live.
    const commented = '// [graft] replaced by the transplanted authentication capability:\n'
      + text.split(/\r?\n|\u2028|\u2029/).map((line) => `//${line}`).join('\n') + '\n';
    replacements.push({ start: statement.start, end: statement.end, text: commented });
    removed.push({ line: statement.loc.start.line, key, text });
    edits.push({ kind: 'disable-conflicting-route', route: key, atLine: statement.loc.start.line });
  }
  const lastImport = imports.at(-1);
  replacements.push({ start: lastImport.end, end: lastImport.end, text: `\nimport { ${registrationName} } from ${specifier};\n` });
  edits.push({ kind: 'add-import', module: routesModule, atLine: lastImport.loc.end.line + 1 });
  const anchor = profile === 'express-req-res' ? registrations[0].statement.start : registrations.at(-1).statement.end;
  replacements.push({ start: anchor, end: anchor, text: `\n${MARKER_START}\n${registrationName}(${appName});\n${MARKER_END}\n` });
  edits.push({ kind: 'register-routes', call: `${registrationName}(${appName})` });
  let edited = source;
  // At a shared offset replace a statement before inserting immediately before it.
  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  for (const r of replacements) edited = edited.slice(0, r.start) + r.text + edited.slice(r.end);
  if (!parseJavaScript(edited)) return refusal('edited-entrypoint-does-not-parse');
  return { applied: true, source: edited, edits, removedRoutes: removed };
}
