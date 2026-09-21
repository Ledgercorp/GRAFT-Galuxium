// Structural detection for the Workspace Capability Index.
//
// Phase 1 dogfood found the old fingerprint's assumptions too narrow to see real projects:
// an entrypoint was a fixed filename or `scripts.start`, so `serve: "node server.mjs"` was
// invisible; a route was one of two idioms, so a real server's `if (path === "/auth/login")` dispatch
// counted as zero routes; and a Python service reported unknown/unknown/unknown.
//
// This module answers "what shape is this project?" — never "can GRAFT transplant it?".
// Recognition and support are different questions, and everything here is read-only.
import fs from 'node:fs';
import path from 'node:path';
import { NON_PRODUCTION_PATH } from '../analyze/production-paths.js';

export const IGNORED_DIRS = new Set(['node_modules', '.git', '.graft', 'dist', 'build', '.next', 'out', 'coverage', 'var', '.graft-work',
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'vendor', 'target', '.svelte-kit', '.turbo', '.cache', 'tmp']);
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);
const CONFIG_FILES = new Set(['package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'deno.json',
  'vercel.json', 'netlify.toml', 'render.yaml', 'fly.toml', 'Dockerfile', 'docker-compose.yml', 'Procfile', '.env.example', 'go.mod', 'Cargo.toml']);
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'deno.json', 'go.mod', 'Cargo.toml'];
const DEPLOY_TARGETS = { 'vercel.json': 'vercel', 'netlify.toml': 'netlify', 'render.yaml': 'render', 'fly.toml': 'fly',
  Dockerfile: 'docker', 'docker-compose.yml': 'docker-compose', Procfile: 'procfile' };

/** Bounded, ignore-aware file listing. Returns POSIX-relative paths. */
export function listFiles(root, { maxFiles = 4000, maxDepth = 12 } = {}) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  let truncated = false;
  while (stack.length) {
    if (out.length >= maxFiles) { truncated = true; break; }
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !IGNORED_DIRS.has(entry.name) && !(entry.name.startsWith('.') && entry.name !== '.github')) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (CODE_EXTENSIONS.has(ext) || ext === '.sql' || CONFIG_FILES.has(entry.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
  return { files: out.sort(), truncated };
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Language and runtime, stated explicitly. "python" is an answer; "unknown" is a last resort. */
export function detectLanguage(root, files, pkg) {
  const count = (ext) => files.filter((f) => f.endsWith(ext)).length;
  const ts = count('.ts') + count('.tsx'), js = count('.js') + count('.mjs') + count('.cjs') + count('.jsx'), py = count('.py');
  const pythonManifest = files.some((f) => ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'].includes(f));
  const evidence = [];
  if (pkg) evidence.push('package.json present');
  if (pythonManifest) evidence.push('python manifest present');
  evidence.push(`${ts} TypeScript, ${js} JavaScript, ${py} Python source file(s)`);
  if (py > 0 && (pythonManifest || py >= js + ts)) return { language: 'python', runtime: 'python', evidence };
  if (ts > 0 && ts >= js) return { language: 'typescript', runtime: 'node', evidence };
  if (js > 0 || pkg) return { language: 'javascript', runtime: 'node', evidence };
  if (files.some((f) => f === 'go.mod')) return { language: 'go', runtime: 'go', evidence };
  if (files.some((f) => f === 'Cargo.toml')) return { language: 'rust', runtime: 'rust', evidence };
  return { language: 'unknown', runtime: 'unknown', evidence };
}

/** Compiled-output mapping. A generated file is never the editable source. */
export function detectBuildLayout(root, files, language) {
  const tsconfig = files.includes('tsconfig.json') ? readJson(path.join(root, 'tsconfig.json')) : null;
  const options = tsconfig?.compilerOptions || {};
  const outDir = typeof options.outDir === 'string' ? options.outDir.replace(/^\.\//, '').replace(/\/$/, '') : null;
  const rootDir = typeof options.rootDir === 'string' ? options.rootDir.replace(/^\.\//, '').replace(/\/$/, '') : null;
  const sourceRoot = rootDir || (files.some((f) => f.startsWith('src/')) ? 'src' : '.');
  const isCompiled = language === 'typescript' && Boolean(outDir || tsconfig);
  return { isCompiled, sourceRoot, buildOutputDir: outDir || (isCompiled ? 'dist' : null), tsconfig: Boolean(tsconfig),
    buildOutputExists: Boolean(outDir && fs.existsSync(path.join(root, outDir))) };
}

/** Map a runtime (built) path back to its source file when a build layout says how. */
export function sourceForRuntimePath(runtimePath, build) {
  if (!runtimePath || !build.isCompiled || !build.buildOutputDir) return null;
  const prefix = build.buildOutputDir.endsWith('/') ? build.buildOutputDir : `${build.buildOutputDir}/`;
  if (!runtimePath.startsWith(prefix)) return null;
  const rest = runtimePath.slice(prefix.length).replace(/\.(js|mjs|cjs)$/, '');
  const base = build.sourceRoot && build.sourceRoot !== '.' ? `${build.sourceRoot}/` : '';
  return `${base}${rest}.ts`;
}

/** Commands that start a process, from every script — not only `start`. */
const TEST_SCRIPT = /^(test|check|lint|typecheck|validate|bench|coverage|e2e|acceptance|build|clean|prepare|postinstall|preinstall|format|release|manifest|db|migrate|fixtures|security|provider|desktop|licensing|deploy)/;
// Shared with the fingerprint: tests, specs, fixtures, benchmarks and coverage are not the application.
const TEST_PATH = NON_PRODUCTION_PATH;

export function scriptEntrypoints(pkg) {
  const found = [];
  for (const [name, command] of Object.entries(pkg?.scripts || {})) {
    if (typeof command !== 'string' || TEST_SCRIPT.test(name)) continue;
    for (const pattern of [/\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*([^\s&|;]+\.(?:js|mjs|cjs))/g, /\b(?:tsx|ts-node)\s+(?:[\w-]+\s+)*([^\s&|;]+\.tsx?)/g,
      /\bpython3?\s+([^\s&|;]+\.py)/g, /\buvicorn\s+([\w.]+):(\w+)/g]) {
      for (let m; (m = pattern.exec(command)); ) {
        const target = pattern.source.includes('uvicorn') ? `${m[1].replace(/\./g, '/')}.py` : m[1].replace(/^\.\//, '');
        if (!TEST_PATH.test(target)) found.push({ file: target, script: name, command, reason: `package script "${name}" runs ${target}` });
      }
    }
  }
  return found;
}

const SERVER_PATTERNS = [
  { id: 'node-http-create-server', match: /\bcreateServer\s*\(/, contract: 'node-res' },
  { id: 'listen-call', match: /\.listen\s*\(/, contract: null },
  { id: 'express-app', match: /\bexpress\s*\(\s*\)/, contract: 'express-req-res', framework: 'express' },
  { id: 'fastify', match: /\bfastify\s*\(/, contract: null, framework: 'fastify' },
  { id: 'koa', match: /new\s+Koa\s*\(/, contract: null, framework: 'koa' },
  { id: 'hapi', match: /Hapi\.server\s*\(/, contract: null, framework: 'hapi' },
  { id: 'fastapi', match: /\bFastAPI\s*\(/, contract: 'asgi', framework: 'fastapi' },
  { id: 'flask', match: /\bFlask\s*\(/, contract: 'wsgi', framework: 'flask' },
  { id: 'django', match: /\bget_wsgi_application\s*\(/, contract: 'wsgi', framework: 'django' },
];

/**
 * Route idioms, including the two Phase 1 found invisible: a bare node:http handler, and
 * dispatch by comparing method and path. Recognition only — several of these have no emitter.
 */
export function extractRouteSignals(relativePath, source) {
  const routes = [];
  const add = (method, routePath, idiom) => routes.push({ method, path: routePath, file: relativePath, idiom });
  for (const m of source.matchAll(/\.add\(\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]\s*,\s*['"]([^'"]+)['"]/g)) add(m[1], m[2], 'table');
  for (const m of source.matchAll(/\.(get|post|put|patch|delete|head|options)\(\s*['"](\/[^'"]*)['"]/g)) add(m[1].toUpperCase(), m[2], 'verb-method');
  // method + path comparison dispatch: `method === "GET" && path === "/auth/login"`.
  for (const m of source.matchAll(/method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"][^\n]{0,120}?\b(?:path|pathname|url)\b\s*===?\s*['"](\/[^'"]*)['"]/g)) add(m[1], m[2], 'path-comparison');
  for (const m of source.matchAll(/\b(?:path|pathname|url)\b\s*===?\s*['"](\/[^'"]*)['"][^\n]{0,120}?method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g)) add(m[2], m[1], 'path-comparison');
  // switch (path) { case "/login": ... }
  if (/switch\s*\(\s*(?:path|pathname|url|req\.url)\b/.test(source)) {
    for (const m of source.matchAll(/case\s+['"](\/[^'"]*)['"]/g)) add('ANY', m[1], 'switch-dispatch');
  }
  // FastAPI / Flask decorators — structural discovery only, never transplantable here.
  for (const m of source.matchAll(/@\w+\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)) add(m[1].toUpperCase(), m[2], 'decorator');
  const seen = new Set();
  return routes.filter((r) => { const key = `${r.method} ${r.path} ${r.idiom}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/** Everything structural about one project directory. Reads files; writes nothing. */
export function detectProject(root, { maxFiles = 4000 } = {}) {
  const abs = path.resolve(root);
  const { files, truncated } = listFiles(abs, { maxFiles });
  const pkg = files.includes('package.json') ? readJson(path.join(abs, 'package.json')) : null;
  const { language, runtime, evidence: languageEvidence } = detectLanguage(abs, files, pkg);
  const build = detectBuildLayout(abs, files, language);
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) { try { cache.set(rel, fs.readFileSync(path.join(abs, rel), 'utf8')); } catch { cache.set(rel, null); } }
    return cache.get(rel);
  };

  const codeFiles = files.filter((f) => CODE_EXTENSIONS.has(path.extname(f)));
  const serverSignals = [];
  const routes = [];
  const envVars = new Set();
  const externalHosts = new Set();
  for (const file of codeFiles) {
    const source = read(file) || '';
    for (const pattern of SERVER_PATTERNS) if (pattern.match.test(source)) serverSignals.push({ ...pattern, match: undefined, file, inTest: TEST_PATH.test(file) });
    if (!TEST_PATH.test(file)) routes.push(...extractRouteSignals(file, source));
    for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) envVars.add(m[1]);
    for (const m of source.matchAll(/process\.env\[['"]([A-Z0-9_]+)['"]\]/g)) envVars.add(m[1]);
    for (const m of source.matchAll(/os\.(?:environ\.get|getenv)\(\s*["']([A-Z0-9_]+)["']/g)) envVars.add(m[1]);
    for (const m of source.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:"']|$)/gi)) {
      const host = m[1].toLowerCase();
      if (!/^(localhost|127\.0\.0\.1|example\.(com|invalid|test)|\d+\.\d+\.\d+\.\d+)$/.test(host) && !host.endsWith('.local')) externalHosts.add(host);
    }
  }
  if (files.includes('.env.example')) for (const line of (read('.env.example') || '').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line); if (m) envVars.add(m[1]);
  }

  // Entrypoint candidates: package main, every script, then structural server signals.
  const candidates = [];
  const push = (file, reason, confidence) => { if (file && !candidates.some((c) => c.file === file)) candidates.push({ file, reason, confidence }); };
  for (const found of scriptEntrypoints(pkg)) push(found.file, found.reason, found.script === 'start' ? 'high' : 'medium');
  if (typeof pkg?.main === 'string') push(pkg.main.replace(/^\.\//, ''), 'package.json main', 'medium');
  const listeners = serverSignals.filter((s) => (s.id === 'listen-call' || s.id === 'node-http-create-server' || s.framework) && !s.inTest);
  for (const signal of listeners) push(signal.file, `${signal.id} in ${signal.file}`, 'medium');
  for (const name of ['src/main.js', 'src/index.js', 'server.js', 'server.mjs', 'index.js', 'app.js', 'main.py', 'app.py', 'server.py']) push(files.includes(name) ? name : null, 'conventional entrypoint filename', 'low');

  const exists = (file) => files.includes(file) || fs.existsSync(path.join(abs, file));
  const rank = { high: 3, medium: 2, low: 1 };
  const ordered = candidates.filter((c) => (exists(c.file) || sourceForRuntimePath(c.file, build)) && !TEST_PATH.test(c.file))
    .map((c) => {
      const generated = Boolean(build.buildOutputDir && c.file.startsWith(`${build.buildOutputDir}/`));
      return { ...c, generated, sourceFile: generated ? sourceForRuntimePath(c.file, build) : c.file,
        hasServerSignal: serverSignals.some((s) => s.file === c.file) };
    })
    .sort((a, b) => (b.hasServerSignal - a.hasServerSignal) || (rank[b.confidence] - rank[a.confidence]) || (a.generated - b.generated));
  const selected = ordered[0] || null;
  const sourceEntrypoint = selected ? (selected.sourceFile && exists(selected.sourceFile) ? selected.sourceFile : selected.generated ? null : selected.file) : null;

  const productionSignals = serverSignals.filter((s) => !s.inTest);
  const framework = productionSignals.find((s) => s.framework)?.framework
    || (pkg?.dependencies?.express ? 'express' : null)
    || (productionSignals.some((s) => s.id === 'node-http-create-server') ? 'node-http' : null)
    || 'none';
  const idioms = [...new Set(routes.map((r) => r.idiom))];
  const handlerContract = productionSignals.find((s) => s.contract)?.contract
    || (framework === 'express' ? 'express-req-res' : null)
    || (idioms.includes('table') ? 'return-response' : null)
    || (productionSignals.length ? 'node-res' : 'none');

  const moduleSystem = language === 'python' ? 'python'
    : pkg?.type === 'module' ? 'esm'
    : pkg?.type === 'commonjs' ? 'cjs'
      : codeFiles.some((f) => f.endsWith('.mjs')) ? 'esm'
        : codeFiles.some((f) => /\brequire\s*\(|module\.exports/.test(read(f) || '')) ? 'cjs'
          : codeFiles.some((f) => /^\s*(import|export)\s/m.test(read(f) || '')) ? 'esm'
            : 'unknown';

  const packageManager = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn'
    : files.includes('bun.lockb') ? 'bun' : files.includes('package-lock.json') ? 'npm'
      : language === 'python' ? (files.includes('Pipfile') ? 'pipenv' : files.includes('pyproject.toml') ? 'pip/pyproject' : 'pip') : pkg ? 'npm' : 'none';

  const storage = [];
  for (const [id, pattern] of [['postgres', /\bpg\b|postgres(ql)?:/i], ['mysql', /\bmysql2?\b/], ['sqlite', /\bsqlite3?\b|better-sqlite3/],
    ['mongodb', /\bmongodb\b|mongoose/], ['redis', /\bredis\b|ioredis/], ['supabase', /supabase/i], ['prisma', /@prisma\/client|prisma/]]) {
    const dependency = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies }).find((d) => pattern.test(d));
    if (dependency) storage.push({ kind: id, evidence: `dependency ${dependency}` });
  }
  if (files.some((f) => f.endsWith('.sql'))) storage.push({ kind: 'sql-files', evidence: `${files.filter((f) => f.endsWith('.sql')).length} .sql file(s)` });
  if (!storage.length) storage.push({ kind: 'module-state', evidence: 'no persistence dependency found' });

  const testCommands = Object.entries(pkg?.scripts || {}).filter(([name]) => /^(test|check|validate|typecheck|lint)/.test(name)).map(([name, command]) => ({ name, command }));
  const testFiles = files.filter((f) => /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)test_[^/]+\.py$/.test(f));

  return {
    root: abs,
    name: pkg?.name || path.basename(abs),
    version: pkg?.version || null,
    language, runtime, languageEvidence,
    runtimeVersion: pkg?.engines?.node || (pkg?.engines ? JSON.stringify(pkg.engines) : null),
    moduleSystem, framework, packageManager,
    workspaces: Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages || [],
    isCompiled: build.isCompiled, sourceRoot: build.sourceRoot, buildOutputDir: build.buildOutputDir, buildOutputExists: build.buildOutputExists,
    entrypointCandidates: ordered.slice(0, 8),
    entrypoint: selected ? { runtime: selected.file, source: sourceEntrypoint, generated: selected.generated, confidence: selected.confidence, reason: selected.reason } : null,
    hasHttpServer: productionSignals.some((s) => s.id !== 'listen-call') || listeners.length > 0,
    serverSignals: serverSignals.map((s) => ({ id: s.id, file: s.file, framework: s.framework || null, contract: s.contract || null, inTest: s.inTest })),
    handlerContract, routeIdioms: idioms,
    routes: routes.slice(0, 200),
    scripts: Object.fromEntries(Object.entries(pkg?.scripts || {})),
    dependencies: Object.entries(pkg?.dependencies || {}).map(([name, range]) => ({ name, range })),
    devDependencies: Object.entries(pkg?.devDependencies || {}).map(([name, range]) => ({ name, range })),
    pythonDependencies: files.includes('requirements.txt') ? (read('requirements.txt') || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => ({ name: l.split(/[=<>~[\s]/)[0], range: l })) : [],
    testCommands, testFileCount: testFiles.length, testLocations: [...new Set(testFiles.map((f) => f.split('/').slice(0, -1).join('/') || '.'))].slice(0, 10),
    environmentVariables: [...envVars].sort(),
    configFiles: files.filter((f) => CONFIG_FILES.has(path.basename(f)) && !f.includes('/')),
    storage, externalHosts: [...externalHosts].sort(),
    deployTargets: [...new Set(files.filter((f) => !f.includes('/')).map((f) => DEPLOY_TARGETS[f]).filter(Boolean))],
    fileCount: files.length, codeFileCount: codeFiles.length, truncated,
    files, read,
  };
}

/** True when a directory looks like a project in its own right rather than a plain folder. */
export function looksLikeProject(dir) {
  return MANIFESTS.some((manifest) => fs.existsSync(path.join(dir, manifest)));
}
