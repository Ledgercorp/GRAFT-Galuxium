import fs from 'node:fs';
import path from 'node:path';
import { inspectExpressEntrypoint, inspectExpressGuardSite, inspectCentralHandler, parseJavaScript, walkNodes } from '../emit/entrypoint.js';
import { isProductionPath } from './production-paths.js';

const IGNORED_DIRS = new Set(['node_modules', '.git', '.graft', 'dist', 'build', '.next', 'coverage', 'var', '.graft-work']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

/** Canonical project-relative path: forward slashes, whatever the host separator. */
export const toProjectPath = (relative) => relative.split(path.sep).join('/');

export function walkSourceFiles(root, { maxFiles = 2000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      const ext = path.extname(entry.name);
      if (SOURCE_EXTENSIONS.has(ext) || entry.name === '.env.example' || ext === '.sql') {
        // Project-relative paths are canonical POSIX form on every platform: plans, receipts,
        // knowledge and safeProjectPath all speak that form, and path.join accepts it on Windows.
        out.push(toProjectPath(path.relative(root, full)));
      }
    }
  }
  return out.sort();
}

/**
 * Route registrations, extracted syntactically. Two idioms are recognised:
 *   router.add('POST', '/auth/login', ...)      -> "table" style
 *   app.post('/auth/login', ...)                -> "verb-method" style
 */
// Dispatch by comparing the method and the path — the idiom bare node:http servers use, and the
// one Dogfood Phase 1 found invisible. Recognised textually on any source, TypeScript included.
export function extractDispatchRoutes(relativePath, source) {
  const routes = [];
  const add = (method, routePath) => { if (!routes.some((r) => r.method === method && r.path === routePath)) routes.push({ method, path: routePath, file: relativePath, idiom: 'path-comparison' }); };
  for (const m of source.matchAll(/method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"][^\n]{0,120}?\b(?:path|pathname|url)\b\s*===?\s*['"](\/[^'"]*)['"]/g)) add(m[1], m[2]);
  for (const m of source.matchAll(/\b(?:path|pathname|url)\b\s*===?\s*['"](\/[^'"]*)['"][^\n]{0,120}?method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g)) add(m[2], m[1]);
  return routes;
}

export function extractRoutes(relativePath, source) {
  const routes = [];
  const dispatch = extractDispatchRoutes(relativePath, source);
  const ast = parseJavaScript(source);
  if (ast) {
    walkNodes(ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return;
      const method = node.callee.property.name;
      const args = node.arguments;
      if (method === 'add' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(args[0]?.value)
        && typeof args[1]?.value === 'string') {
        routes.push({ method: args[0].value, path: args[1].value, file: relativePath, idiom: 'table' });
      } else if (/^(get|post|put|patch|delete|head|options)$/.test(method)
        && typeof args[0]?.value === 'string' && args[0].value.startsWith('/')) {
        routes.push({ method: method.toUpperCase(), path: args[0].value, file: relativePath, idiom: 'verb-method' });
      }
    });
    return [...routes, ...dispatch];
  }
  const table = /\.add\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]\s*,\s*['"]([^'"]+)['"]/g;
  for (let m; (m = table.exec(source)); ) {
    routes.push({ method: m[1], path: m[2], file: relativePath, idiom: 'table' });
  }
  const verb = /\.(get|post|put|patch|delete)\(\s*['"](\/[^'"]*)['"]/g;
  for (let m; (m = verb.exec(source)); ) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], file: relativePath, idiom: 'verb-method' });
  }
  return [...routes, ...dispatch];
}

function detectModuleSystem(pkg, files, read) {
  if (pkg?.type === 'module') return { value: 'esm', evidence: 'package.json type=module' };
  const cjsHit = files.find((f) => /\brequire\(|module\.exports\b/.test(read(f) || ''));
  if (cjsHit) return { value: 'cjs', evidence: `require()/module.exports in ${cjsHit}` };
  const esmHit = files.find((f) => /^\s*(import|export)\s/m.test(read(f) || ''));
  if (esmHit) return { value: 'esm', evidence: `import/export in ${esmHit}` };
  return { value: 'unknown', evidence: 'no module-system signal found' };
}

/**
 * How HTTP handlers return their result. This is the single most important thing
 * to get right before emitting code into a destination: a handler written for the
 * wrong contract compiles fine and fails at runtime.
 */
function detectHandlerContract(files, read, framework, entrypoint) {
  let returnResponse = 0;
  let nodeRes = 0;
  const evidence = [];
  // The contract follows the production server: the entrypoint and what it reaches, then the
  // remaining production files. Test and fixture handlers say nothing about this application.
  const reachable = reachableProductionFiles(files, read, entrypoint);
  const ordered = [...reachable, ...files.filter((f) => isProductionPath(f) && !reachable.includes(f))];
  for (const f of ordered) {
    const src = read(f) || '';
    if (framework.value === 'express' && /\bres\.(status|json|send|sendStatus)\(/.test(src)) {
      return { value: 'express-req-res', evidence: [`${f}: Express response methods`] };
    }
    if (/return\s*\{\s*status\s*:/.test(src) || /=>\s*\(\{\s*status\s*:/.test(src)) {
      returnResponse += 1;
      if (evidence.length < 4) evidence.push(`${f}: handler returns {status,...}`);
    }
    if (/res\.writeHead\(|res\.end\(/.test(src)) {
      nodeRes += 1;
      if (evidence.length < 4) evidence.push(`${f}: handler writes to res`);
    }
  }
  if (returnResponse > nodeRes) return { value: 'return-response', evidence };
  if (nodeRes > 0) return { value: 'node-res', evidence };
  return { value: 'unknown', evidence };
}

const FRAMEWORKS = ['next', 'express', 'fastify', 'koa', 'hono', '@hapi/hapi'];
/** Module specifiers a file really imports: from its syntax tree when it parses, else by pattern. */
function importedModules(src) {
  const found = new Set();
  const ast = parseJavaScript(src);
  if (ast) {
    walkNodes(ast, (n) => {
      if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ExportNamedDeclaration') { if (n.source?.value) found.add(n.source.value); }
      else if (n.type === 'ImportExpression' && n.source?.type === 'Literal') found.add(n.source.value);
      else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0]?.type === 'Literal') found.add(n.arguments[0].value);
    });
    return found;
  }
  for (const m of src.matchAll(/(?:from|require|import)\s*\(?\s*['"]([^'"]+)['"]/g)) found.add(m[1]);
  return found;
}
const importsModule = (src, name) => importedModules(src).has(name);

/**
 * The production modules the entrypoint can reach through static relative imports, in
 * breadth-first order with the entrypoint first. Bare specifiers (packages) are not followed.
 * A project without a recognised entrypoint yields every production file instead.
 */
export function reachableProductionFiles(files, read, entrypoint, { maxDepth = 6, maxFiles = 400 } = {}) {
  const production = files.filter(isProductionPath);
  if (!entrypoint || !production.includes(entrypoint)) return production;
  const known = new Set(production);
  const seen = new Set([entrypoint]);
  const order = [entrypoint];
  const queue = [{ file: entrypoint, depth: 0 }];
  const resolve = (from, spec) => {
    const base = spec.split('/').filter(Boolean);
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), base.join('/')));
    const candidates = [joined, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].map((e) => joined + e), ...['index.js', 'index.mjs', 'index.ts'].map((i) => path.posix.join(joined, i))];
    // TypeScript sources import './x.js' while the file on disk is './x.ts'.
    if (/\.js$/.test(joined)) candidates.push(joined.replace(/\.js$/, '.ts'), joined.replace(/\.js$/, '.tsx'));
    return candidates.find((c) => known.has(c)) || null;
  };
  while (queue.length && order.length < maxFiles) {
    const { file, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const src = read(file) || '';
    const specs = [];
    for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) specs.push(m[1]);
    for (const spec of specs) {
      const target = resolve(file, spec);
      if (target && !seen.has(target)) { seen.add(target); order.push(target); queue.push({ file: target, depth: depth + 1 }); }
    }
  }
  return order;
}

/**
 * The framework is what the production server is actually written with. A dependency alone is
 * not evidence — a devDependency used by a bench fixture must not make the application "Express".
 * Evidence comes from the entrypoint and the production modules it reaches; failing that, from
 * production files; never from tests, fixtures or benchmarks.
 */
function detectFramework(pkg, files, read, entrypoint) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const reachable = reachableProductionFiles(files, read, entrypoint);
  const rest = files.filter((f) => isProductionPath(f) && !reachable.includes(f));
  // Entrypoint first, then what it reaches, then the rest of the production tree: the first file
  // with a server signal decides, so a module that merely *mentions* a framework further away
  // cannot outvote the server the entrypoint actually creates.
  for (const f of [...reachable, ...rest]) {
    const imports = importedModules(read(f) || '');
    const known = FRAMEWORKS.find((name) => imports.has(name));
    if (known) return { value: known, version: deps[known] || null, evidence: `${known} imported by ${f}` };
    if (imports.has('node:http') || imports.has('http') || imports.has('node:https') || imports.has('https')) return { value: 'node-http', version: null, evidence: `node:http server in ${f}` };
  }
  return { value: 'unknown', version: null, evidence: 'no framework signal found in production code' };
}

/** A destination-side persistence idiom the emitter can target. */
function detectPersistence(files, read) {
  const deps = [];
  for (const f of files) {
    const src = read(f) || '';
    if (/export\s+(const|class)\s+[Ss]tore\b/.test(src)) {
      deps.push({ kind: 'shared-store', module: f, exportName: /export\s+const\s+store\b/.test(src) ? 'store' : 'Store', evidence: `${f} exports a store` });
    }
    if (/from ['"]better-sqlite3['"]|require\(['"]better-sqlite3['"]\)/.test(src)) {
      deps.push({ kind: 'sqlite', module: f, evidence: `${f} uses better-sqlite3` });
    }
    if (/@prisma\/client/.test(src)) deps.push({ kind: 'prisma', module: f, evidence: `${f} uses prisma` });
  }
  if (!deps.length) return { value: 'module-state', modules: [], evidence: 'no shared persistence layer found; features hold their own state' };
  return { value: deps[0].kind, modules: deps, evidence: deps[0].evidence };
}

const TEST_SCRIPT = /^(test|check|lint|typecheck|validate|bench|coverage|e2e|acceptance|build|clean|prepare|postinstall|preinstall|format|release|manifest|db|migrate|fixtures|security|provider|desktop|licensing|deploy)/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** The script that starts the application, if any: `start` first, then any other non-test script running node. */
export function startScriptFor(pkg) {
  const scripts = pkg?.scripts || {};
  const ordered = ['start', ...Object.keys(scripts).filter((n) => n !== 'start' && !TEST_SCRIPT.test(n))];
  for (const name of ordered) {
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    // `node app/server` (no extension) is how Node itself is invoked; the extension is resolved later.
    const m = /^\s*node\s+(?:--[\w-]+(?:=\S+)?\s+)*([^\s&|;]+?(?:\.(?:js|mjs|cjs))?)\s*$/.exec(command);
    if (m && !TEST_PATH.test(m[1])) return { name, file: m[1].replace(/^\.\//, ''), command };
  }
  return null;
}

function detectEntrypoint(root, pkg, files) {
  const candidates = [];
  // Dogfood Phase 1: an entrypoint declared as `serve: "node server.mjs"` was invisible when only
  // `start` was consulted. Every plain "node <file>" script now counts, `start` preferred.
  const script = startScriptFor(pkg);
  if (script) candidates.push(script.file);
  if (pkg?.main) candidates.push(pkg.main);
  candidates.push('src/main.js', 'src/index.js', 'server.js', 'server.mjs', 'index.js', 'app.js');
  for (const c of candidates) {
    // package.json values written on Windows may use backslashes; the project path is POSIX.
    const rel = c.replace(/\\/g, '/').replace(/^\.\//, '');
    if (files.includes(rel) || (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile())) return rel;
    // `node app/server` resolves the extension at run time; so must the fingerprint.
    for (const ext of ['.js', '.mjs', '.cjs']) if (files.includes(rel + ext)) return rel + ext;
    for (const index of ['/index.js', '/index.mjs', '/index.cjs']) if (files.includes(rel + index)) return rel + index;
  }
  return null;
}

/**
 * Deterministic, read-only description of a project. No AI, no network.
 */
export function fingerprintProject(root) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs)) throw new Error(`project not found: ${abs}`);

  let pkg = null;
  const pkgPath = path.join(abs, 'package.json');
  if (fs.existsSync(pkgPath)) { try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { pkg = null; } }

  const files = walkSourceFiles(abs);
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      try { cache.set(rel, fs.readFileSync(path.join(abs, rel), 'utf8')); } catch { cache.set(rel, null); }
    }
    return cache.get(rel);
  };

  const routes = [];
  for (const f of files) {
    if (!/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(f) || !isProductionPath(f)) continue;
    routes.push(...extractRoutes(f, read(f) || ''));
  }

  const envVars = new Set();
  for (const f of files) {
    const src = read(f) || '';
    const envPattern = /process\.env\.([A-Z0-9_]+)/g;
    for (let m; (m = envPattern.exec(src)); ) envVars.add(m[1]);
  }
  const envExample = path.join(abs, '.env.example');
  if (fs.existsSync(envExample)) {
    for (const line of fs.readFileSync(envExample, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
      if (m) envVars.add(m[1]);
    }
  }

  const entrypoint = detectEntrypoint(abs, pkg, files);
  const framework = detectFramework(pkg, files, read, entrypoint);
  return {
    root: abs,
    name: pkg?.name || path.basename(abs),
    version: pkg?.version || null,
    packageJson: pkg,
    files,
    readFile: read,
    routes,
    entrypoint,
    moduleSystem: detectModuleSystem(pkg, files, read),
    handlerContract: detectHandlerContract(files, read, framework, entrypoint),
    framework,
    ...(framework.value === 'express' ? { express: inspectExpressEntrypoint(read(entrypoint) || ''), expressGuard: inspectExpressGuardSite(read(entrypoint) || '') } : {}),
    ...(framework.value === 'node-http' && entrypoint ? { central: inspectCentralHandler(read(entrypoint) || '') } : {}),
    persistence: detectPersistence(files, read),
    dependencies: Object.entries(pkg?.dependencies || {}).map(([name, range]) => ({ name, range })),
    environmentVariables: [...envVars].sort(),
    sqlFiles: files.filter((f) => f.endsWith('.sql')),
  };
}

/** Fingerprint minus the closures, safe to serialise into a plan or report. */
export function serialisableFingerprint(fp) {
  const { readFile, ...rest } = fp;
  return rest;
}
