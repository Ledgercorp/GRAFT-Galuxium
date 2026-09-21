import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositoryIdentity, projectId, relativeRoot, safeRemote } from '../src/workspace/identity.js';
import { detectProject, detectLanguage, detectBuildLayout, sourceForRuntimePath, scriptEntrypoints, extractRouteSignals, listFiles } from '../src/workspace/detect.js';
import { observeCapabilities, CAPABILITY_STATES, AUTH_SUBTYPES } from '../src/workspace/capabilities.js';
import { findProjectDirectories, findSubprojects, indexProject, scanWorkspaceRoot, buildIndex, refreshProject, staleProjects, invalidationFingerprint, isFixtureProjectRoot } from '../src/workspace/index.js';
import { loadIndex, saveIndex, addRoot, removeRoot, INDEX_VERSION } from '../src/workspace/store.js';
import { searchCapabilities, parseQuery, indexSummary, getCapability } from '../src/workspace/search.js';

function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-workspace-')));
  const previous = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
const write = (root, files) => {
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  return root;
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(root, files) {
  fs.mkdirSync(root, { recursive: true });
  write(root, files);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  return root;
}

test('a repository is identified by its git common directory, so worktrees are one repository', (t) => {
  const work = sandbox(t);
  const main = repo(path.join(work, 'app'), { 'package.json': '{"name":"app"}', 'index.js': 'console.log(1);\n' });
  const linked = path.join(work, 'linked');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

  const a = repositoryIdentity(main), b = repositoryIdentity(linked);
  assert.equal(a.repositoryId, b.repositoryId, 'a linked worktree is the same repository');
  assert.equal(a.isWorktree, false);
  assert.equal(b.isWorktree, true);
  assert.equal(b.branch, 'feature');
  assert.equal(a.branch, 'main');
  assert.equal(a.worktrees.length, 2);
  assert.ok(a.worktrees.some((w) => fs.realpathSync(w.path) === linked));
  // The logical project id is shared too: it is the same project, checked out twice.
  assert.equal(projectId(a, relativeRoot(a, main)), projectId(b, relativeRoot(b, linked)));
  // A different repository is a different id.
  const other = repositoryIdentity(repo(path.join(work, 'other'), { 'package.json': '{"name":"other"}' }));
  assert.notEqual(other.repositoryId, a.repositoryId);
});

test('a non-git directory is still indexable, and remote credentials are never kept', (t) => {
  const work = sandbox(t);
  const plain = write(path.join(work, 'plain'), { 'package.json': '{"name":"plain"}', 'server.js': 'require("http").createServer(()=>{}).listen(3000);\n' });
  fs.mkdirSync(plain, { recursive: true });
  const identity = repositoryIdentity(plain);
  assert.equal(identity.isGit, false);
  assert.equal(identity.kind, 'directory');
  assert.match(identity.repositoryId, /^dir:/);
  assert.equal(identity.head, null);
  const indexed = indexProject(plain);
  assert.equal(indexed.name, 'plain');
  assert.equal(indexed.hasHttpServer, true);
  assert.equal(safeRemote('https://user:secret@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(safeRemote('git@github.com:o/r.git'), 'github.com:o/r.git');
  assert.equal(safeRemote(null), null);
});

test('monorepo subprojects come from declared evidence, never invention', (t) => {
  const work = sandbox(t);
  const root = repo(path.join(work, 'mono'), {
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*', 'apps/api'] }),
    'packages/one/package.json': '{"name":"one"}',
    'packages/two/package.json': '{"name":"two"}',
    'packages/not-a-project/readme.md': '# no manifest',
    'apps/api/package.json': '{"name":"api"}',
    'apps/web/package.json': '{"name":"web"}',
    'scratch/notes/package-ish.txt': 'x',
  });
  const subs = findSubprojects(root).map((s) => path.relative(root, s.dir)).sort();
  assert.deepEqual(subs, ['apps/api', 'apps/web', 'packages/one', 'packages/two']);
  assert.equal(subs.includes('packages/not-a-project'), false, 'a directory without a manifest is not a project');
  assert.equal(subs.includes('scratch/notes'), false);
  const declared = findSubprojects(root).find((s) => s.dir.endsWith('packages/one'));
  assert.match(declared.reason, /workspaces/);
  const conventional = findSubprojects(root).find((s) => s.dir.endsWith('apps/web'));
  assert.match(conventional.reason, /conventional/);
});

test('language and runtime are named explicitly, including Python', (t) => {
  const work = sandbox(t);
  const py = write(path.join(work, 'py'), { 'requirements.txt': 'fastapi\n', 'server.py': 'from fastapi import FastAPI\napp = FastAPI()\n@app.get("/health")\ndef health(): return {}\n' });
  const detected = detectProject(py);
  assert.equal(detected.language, 'python');
  assert.equal(detected.runtime, 'python');
  assert.equal(detected.moduleSystem, 'python', 'a python project does not have an ESM module system');
  assert.equal(detected.framework, 'fastapi');
  assert.equal(detected.handlerContract, 'asgi');
  assert.equal(detected.entrypoint.runtime, 'server.py');
  assert.ok(detected.routes.some((r) => r.idiom === 'decorator' && r.path === '/health'));
  assert.notEqual(detected.runtime, 'unknown');

  const ts = write(path.join(work, 'ts'), { 'package.json': '{"name":"ts","type":"module"}', 'tsconfig.json': '{"compilerOptions":{"rootDir":"src","outDir":"dist"}}', 'src/index.ts': 'export const a = 1;\n' });
  const tsDetected = detectProject(ts);
  assert.equal(tsDetected.language, 'typescript');
  assert.equal(tsDetected.runtime, 'node');
  assert.equal(detectLanguage(ts, ['src/index.ts'], {}).language, 'typescript');
});

test('compiled projects keep source and runtime entrypoints apart', (t) => {
  const work = sandbox(t);
  const root = write(path.join(work, 'api'), {
    'package.json': JSON.stringify({ name: 'api', type: 'module', main: './dist/index.js', scripts: { start: 'node dist/index.js', build: 'tsc -p tsconfig.json' } }),
    'tsconfig.json': '{"compilerOptions":{"rootDir":"src","outDir":"dist"}}',
    'src/index.ts': 'import { createServer } from "node:http";\ncreateServer(() => {}).listen(1);\n',
  });
  const build = detectBuildLayout(root, ['tsconfig.json', 'src/index.ts'], 'typescript');
  assert.equal(build.isCompiled, true);
  assert.equal(build.sourceRoot, 'src');
  assert.equal(build.buildOutputDir, 'dist');
  assert.equal(sourceForRuntimePath('dist/index.js', build), 'src/index.ts');
  assert.equal(sourceForRuntimePath('src/index.ts', build), null);

  const detected = detectProject(root);
  assert.equal(detected.isCompiled, true);
  assert.equal(detected.entrypoint.source, 'src/index.ts', 'the editable entrypoint is the source file');
  assert.equal(detected.entrypoint.generated, false);
  // The generated file is still known as a candidate, but never chosen as the source.
  const generated = detected.entrypointCandidates.find((c) => c.file === 'dist/index.js');
  if (generated) assert.equal(generated.generated, true);
});

test('entrypoints are found through any package script, not a filename list', (t) => {
  const work = sandbox(t);
  const root = write(path.join(work, 'webmcp'), {
    'package.json': JSON.stringify({ name: 'webmcp', type: 'module', scripts: { serve: 'node server.mjs', test: 'node --test tests/*.test.mjs' } }),
    'server.mjs': 'import { createServer } from "node:http";\ncreateServer(async (req, res) => { res.end("ok"); }).listen(4173);\n',
    'tests/app.test.mjs': 'import { createServer } from "node:http";\ncreateServer(() => {}).listen(0);\n',
  });
  const detected = detectProject(root);
  assert.equal(detected.entrypoint.runtime, 'server.mjs', 'scripts.serve names the entrypoint');
  assert.match(detected.entrypoint.reason, /package script "serve"/);
  assert.equal(detected.hasHttpServer, true);
  assert.equal(detected.framework, 'node-http');
  assert.equal(detected.handlerContract, 'node-res');
  // A test file that starts a server must not become the project's entrypoint or framework.
  assert.equal(detected.entrypointCandidates.some((c) => c.file.startsWith('tests/')), false);
  assert.deepEqual(scriptEntrypoints({ scripts: { test: 'node tests/x.js' } }), [], 'test scripts are not entrypoints');
  assert.deepEqual(scriptEntrypoints({ scripts: { start: 'node --enable-source-maps src/app.js' } })[0].file, 'src/app.js');
  assert.equal(scriptEntrypoints({ scripts: { dev: 'tsx watch src/dev.ts' } })[0].file, 'src/dev.ts');
});

test('route idioms include bare node:http dispatch by method and path', () => {
  const source = `
    if (method === "GET" && path === "/auth/login") {}
    if (req.method === 'POST' && pathname === '/auth/logout') {}
    router.add('GET', '/table');
    app.post('/verb', handler);
    switch (pathname) { case '/switched': break; }
  `;
  const routes = extractRouteSignals('server.js', source);
  const idioms = [...new Set(routes.map((r) => r.idiom))].sort();
  assert.deepEqual(idioms, ['path-comparison', 'switch-dispatch', 'table', 'verb-method']);
  const comparison = routes.filter((r) => r.idiom === 'path-comparison');
  assert.deepEqual(comparison.map((r) => `${r.method} ${r.path}`).sort(), ['GET /auth/login', 'POST /auth/logout']);
  assert.equal(routes.filter((r) => r.path === '/switched').length, 1);
});

test('auth subtypes separate credential authority, session transport and storage', (t) => {
  const work = sandbox(t);
  const hosted = write(path.join(work, 'hosted'), {
    'package.json': JSON.stringify({ name: 'hosted', type: 'module', dependencies: { '@workos-inc/node': '1.0.0' } }),
    'src/auth.js': `
      import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
      const sessions = new Map();
      const sessionName = '__Host-app_session';
      export function handle(req, res, method, path) {
        if (method === 'GET' && path === '/auth/login') { const verifier = randomBytes(32).toString('base64url');
          const url = 'https://api.workos.com/user_management/authorize?response_type=code&code_challenge=' + createHash('sha256').update(verifier).digest('base64url') + '&code_challenge_method=S256'; return url; }
        if (method === 'GET' && path === '/auth/callback') { const body = { grant_type: 'authorization_code', code: 'x' }; return body; }
        if (method === 'POST' && path === '/auth/logout') { sessions.delete(1); }
        res.setHeader('set-cookie', sessionName + '=' + randomBytes(32).toString('base64url') + '; Path=/; HttpOnly; SameSite=Lax; Secure');
        if (req.headers.cookie) timingSafeEqual(Buffer.from('a'), Buffer.from('b'));
      }`,
  });
  const project = detectProject(hosted);
  const [auth] = observeCapabilities(project, { projectId: 'p1' });
  assert.equal(auth.capability, 'authentication');
  assert.ok(auth.subtypes.includes('hosted-provider-oauth'));
  assert.ok(auth.subtypes.includes('oauth2-pkce'));
  assert.ok(auth.subtypes.includes('cookie-session'));
  assert.equal(auth.subtypes.includes('local-password'), false, 'no password is validated here');
  assert.equal(auth.auth.credentialAuthority.kind, 'hosted-provider');
  assert.match(auth.auth.credentialAuthority.detail, /workos/);
  assert.equal(auth.auth.sessionTransport, 'cookie');
  assert.equal(auth.auth.sessionCustody, 'local', 'the session is this project\'s, even though the credential is not');
  assert.equal(auth.auth.sessionStore, 'memory');
  assert.equal(auth.auth.sessionDurableAcrossRestart, false);
  assert.equal(auth.auth.cookieFlags.httpOnly, true);
  assert.equal(auth.auth.cookieFlags.hostPrefix, true);
  assert.ok(CAPABILITY_STATES.includes(auth.state));
  for (const subtype of auth.subtypes) assert.ok(AUTH_SUBTYPES.includes(subtype), subtype);
});

test('a detected capability is not made harvestable, and missing signals explain why', (t) => {
  const work = sandbox(t);
  const root = write(path.join(work, 'hosted2'), {
    'package.json': JSON.stringify({ name: 'hosted2', type: 'module', dependencies: { '@workos-inc/node': '1.0.0' } }),
    'src/auth.js': `const sessions = new Map();
      if (method === 'GET' && path === '/auth/login') {}
      res.setHeader('set-cookie', 'app=' + require('crypto').randomBytes(32).toString('base64url') + '; HttpOnly; SameSite=Lax');`,
  });
  const [auth] = observeCapabilities(detectProject(root), { projectId: 'p2' });
  assert.equal(auth.harvestable, false, 'the harvest detector alone decides harvestability');
  assert.equal(auth.transplantSupport, 'unsupported');
  assert.ok(auth.state !== 'HARVESTABLE' && auth.state !== 'TRANSPLANTABLE');
  const missing = auth.missingSignals.map((m) => m.id);
  assert.ok(missing.includes('password-hashing'));
  const why = auth.missingSignals.find((m) => m.id === 'password-hashing').why;
  assert.match(why, /validates no password itself/);
  assert.ok(auth.blockers.some((b) => b.id === 'not-harvestable'));
  assert.ok(auth.signals.length > 0, 'it is still described with evidence');
  assert.ok(auth.signals.every((s) => typeof s.evidence === 'string'));
});

test('an unsupported runtime is detected and reported as unsupported, never as harvestable', (t) => {
  const work = sandbox(t);
  const root = write(path.join(work, 'pyauth'), {
    'requirements.txt': 'fastapi\n',
    'server.py': `import secrets
from fastapi import Depends, FastAPI, Header, HTTPException
app = FastAPI()
def auth(authorization: str | None = Header(default=None)):
    if not secrets.compare_digest(authorization or "", "Bearer " + TOKEN):
        raise HTTPException(401, "Unauthorized")
@app.get("/health", dependencies=[Depends(auth)])
def health(): return {"ok": True}
`,
  });
  const [auth] = observeCapabilities(detectProject(root), { projectId: 'p3' });
  assert.ok(auth.subtypes.includes('api-key-static'));
  assert.equal(auth.auth.credentialAuthority.kind, 'shared-secret');
  assert.equal(auth.auth.sessionTransport, 'bearer-header');
  assert.equal(auth.state, 'UNSUPPORTED');
  assert.equal(auth.harvestable, false);
  assert.ok(auth.blockers.some((b) => b.id === 'unsupported-runtime'));
  assert.equal(auth.asDestination.supported, false);
});

test('the index persists atomically, versions itself, and detects staleness', (t) => {
  const work = sandbox(t);
  repo(path.join(work, 'ws', 'one'), { 'package.json': JSON.stringify({ name: 'one', scripts: { start: 'node server.js' } }), 'server.js': 'require("http").createServer(()=>{}).listen(1);\n' });
  const file = path.join(work, 'index.json');

  assert.deepEqual(loadIndex({ file }).projects, []);
  assert.equal(loadIndex({ file }).indexVersion, INDEX_VERSION);
  saveIndex({ roots: [{ path: path.join(work, 'ws') }], projects: [] }, { file });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.telemetry, false);
  assert.equal(saved.uploads, 'never');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // A future version is rebuilt rather than misread; genuine corruption is reported.
  fs.writeFileSync(file, JSON.stringify({ indexVersion: '99.0.0', roots: [{ path: '/x' }], projects: [{ projectId: 'stale' }] }));
  const superseded = loadIndex({ file });
  assert.deepEqual(superseded.projects, []);
  assert.equal(superseded.supersededVersion, '99.0.0');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => loadIndex({ file }), /unreadable/);
  fs.rmSync(file);

  addRoot(path.join(work, 'ws'), { file });
  const built = buildIndex({ file });
  assert.equal(built.projects, 1);
  const project = loadIndex({ file }).projects[0];
  assert.equal(project.name, 'one');
  assert.deepEqual(staleProjects({ file }), []);

  // Reindexing without changes reuses entries; a real change invalidates them.
  const again = buildIndex({ file });
  assert.equal(again.roots[0].reused, 1);
  assert.equal(again.roots[0].scanned, 0);
  const before = invalidationFingerprint(project.root, { head: project.repository.head, dirty: false, branch: 'main' });
  fs.writeFileSync(path.join(project.root, 'package.json'), JSON.stringify({ name: 'one', scripts: { start: 'node server.js' }, dependencies: { express: '5.0.0' } }));
  assert.notEqual(invalidationFingerprint(project.root, { head: project.repository.head, dirty: false, branch: 'main' }), before);
  assert.equal(staleProjects({ file }).length, 1);
  const refreshed = refreshProject(project.projectId, { file });
  assert.ok(refreshed.project.dependencies.some((d) => d.name === 'express'));
  assert.deepEqual(staleProjects({ file }), []);

  // Removing a root drops its projects; the index is rebuildable from source at any time.
  removeRoot(path.join(work, 'ws'), { file });
  assert.deepEqual(loadIndex({ file }).projects, []);
  assert.throws(() => addRoot(os.homedir(), { file }), /specific development folder/);
});

test('a root added through a symlink can be removed through that symlink', (t) => {
  const work = sandbox(t);
  const real = path.join(work, 'real');
  repo(path.join(real, 'app'), { 'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node server.js' } }), 'server.js': 'require("http").createServer(()=>{}).listen(1);\n' });
  const link = path.join(work, 'link');
  fs.symlinkSync(real, link);
  const file = path.join(work, 'index.json');

  // addRoot stores the resolved path; removal through the symlink must still match it.
  const roots = addRoot(link, { file });
  assert.equal(roots.length, 1);
  assert.equal(roots[0].path, fs.realpathSync(real));
  buildIndex({ file });
  assert.equal(loadIndex({ file }).projects.length, 1);

  // Adding the same folder by both names must not create a second root.
  addRoot(real, { file });
  assert.equal(loadIndex({ file }).roots.length, 1);

  removeRoot(link, { file });
  assert.deepEqual(loadIndex({ file }).roots, []);
  assert.deepEqual(loadIndex({ file }).projects, [], 'its projects go with it');

  // A root whose folder has since disappeared is still removable.
  const vanishing = path.join(work, 'vanishing');
  fs.mkdirSync(vanishing, { recursive: true });
  addRoot(vanishing, { file });
  fs.rmSync(vanishing, { recursive: true, force: true });
  removeRoot(vanishing, { file });
  assert.deepEqual(loadIndex({ file }).roots, []);
});

test('the index never stores environment values, secrets or source text', (t) => {
  const work = sandbox(t);
  const root = repo(path.join(work, 'ws', 'secretive'), {
    'package.json': JSON.stringify({ name: 'secretive', scripts: { start: 'node server.js' } }),
    '.env.example': 'API_TOKEN=\nDATABASE_URL=\n',
    '.env': 'API_TOKEN=sk_live_51NotARealKeyButLooksLikeOne\n',
    'server.js': 'const SECRET_CONSTANT = "sk_live_51NotARealKeyButLooksLikeOne";\nprocess.env.API_TOKEN;\nrequire("http").createServer(()=>{}).listen(1);\n',
  });
  const file = path.join(work, 'index.json');
  addRoot(path.join(work, 'ws'), { file });
  buildIndex({ file });
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('sk_live_51NotARealKeyButLooksLikeOne'), false, 'a secret from source must never be indexed');
  assert.equal(raw.includes('SECRET_CONSTANT'), false, 'source text is not indexed');
  const project = loadIndex({ file }).projects[0];
  assert.ok(project.environmentVariables.includes('API_TOKEN'), 'names are indexed');
  assert.equal(JSON.stringify(project.environmentVariables).includes('sk_live'), false, 'values are not');
  assert.equal(root.includes('secretive'), true);
});

test('deterministic search answers plain questions with no model and explains every match', (t) => {
  const work = sandbox(t);
  const ws = path.join(work, 'ws');
  repo(path.join(ws, 'classic'), {
    'package.json': JSON.stringify({ name: 'classic', scripts: { start: 'node server.js' } }),
    'server.js': `const { scryptSync, randomBytes } = require('node:crypto');
      const COOKIE_NAME = 'sid';
      const router = { add() {} };
      router.add('POST', '/login');
      router.add('POST', '/logout');
      router.add('GET', '/me');
      const hash = (p, s) => scryptSync(p, s, 64).toString('hex');
      const salt = randomBytes(16).toString('hex');
      res.setHeader('Set-Cookie', COOKIE_NAME + '=' + randomBytes(24).toString('hex') + '; HttpOnly; SameSite=Lax');
      function requireAuth(req, res) { return 401; }
      require('http').createServer(()=>{}).listen(1);`,
  });
  repo(path.join(ws, 'pyservice'), { 'requirements.txt': 'fastapi\n', 'server.py': 'import secrets\nfrom fastapi import FastAPI, Header, Depends, HTTPException\napp = FastAPI()\ndef auth(authorization: str | None = Header(default=None)):\n    secrets.compare_digest(authorization or "", "x")\n@app.get("/items", dependencies=[Depends(auth)])\ndef items(): return []\n' });
  const file = path.join(work, 'index.json');
  addRoot(ws, { file });
  buildIndex({ file });

  const parsed = parseQuery('find something that keeps users logged in');
  assert.equal(parsed.filters.capability, 'authentication');
  assert.equal(parsed.filters.sessionTransport, 'cookie');

  const sessions = searchCapabilities('find something that keeps users logged in', { file });
  assert.ok(sessions.total >= 1);
  assert.equal(sessions.results[0].project.name, 'classic');
  assert.ok(sessions.results[0].matchedBecause.length > 0);
  assert.ok(sessions.results[0].evidence.length > 0);
  assert.equal(sessions.results[0].harvestable, true);

  const apiKey = searchCapabilities('find API key auth', { file });
  assert.equal(apiKey.results[0].project.name, 'pyservice');
  assert.equal(apiKey.results[0].transplantSupport, 'unsupported');
  assert.ok(apiKey.results[0].blockers.some((b) => b.id === 'unsupported-runtime'));

  const unsupported = searchCapabilities('capabilities I cannot yet transplant', { file });
  assert.ok(unsupported.results.every((r) => r.transplantSupport === 'unsupported'));

  const structural = searchCapabilities({ capability: 'authentication', harvestable: true }, { file });
  assert.ok(structural.results.every((r) => r.harvestable === true));

  const summary = indexSummary({ file });
  assert.equal(summary.projects, 2);
  assert.equal(summary.languages.python, 1);
  assert.ok(summary.byState.TRANSPLANTABLE >= 1 || summary.byState.HARVESTABLE >= 1);
  const { capability } = getCapability(loadIndex({ file }).projects.find((p) => p.name === 'classic').projectId, 'authentication', { file });
  assert.equal(capability.capability, 'authentication');
  assert.throws(() => getCapability('nope', 'authentication', { file }), /Unknown project/);
});

test('scanning a workspace root finds repositories, subprojects and worktrees without double counting', (t) => {
  const work = sandbox(t);
  const ws = path.join(work, 'ws');
  const mono = repo(path.join(ws, 'mono'), {
    'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*'] }),
    'packages/a/package.json': '{"name":"a"}',
    'packages/b/package.json': '{"name":"b"}',
  });
  git(mono, 'worktree', 'add', '-q', '-b', 'side', path.join(work, 'side'));
  repo(path.join(ws, 'solo'), { 'package.json': '{"name":"solo"}' });

  // The walker surfaces every manifest-bearing directory; the scan is what decides boundaries.
  const directories = findProjectDirectories(ws).map((d) => path.relative(ws, d.dir)).sort();
  assert.deepEqual(directories, ['mono', 'mono/packages/a', 'mono/packages/b', 'solo']);
  const { projects } = scanWorkspaceRoot(ws);
  const names = projects.map((p) => p.name).sort();
  assert.deepEqual(names, ['a', 'b', 'mono', 'solo']);
  const repositories = new Set(projects.map((p) => p.repositoryId));
  assert.equal(repositories.size, 2, 'two repositories, four projects');
  const monoProject = projects.find((p) => p.name === 'mono');
  assert.equal(monoProject.repository.worktrees.length, 2);
  assert.deepEqual(monoProject.subprojects.length, 2);
  assert.equal(projects.find((p) => p.name === 'a').subprojectOf, monoProject.projectId);
  assert.equal(projects.find((p) => p.name === 'a').repositoryId, monoProject.repositoryId);
  const summary = indexSummary({ index: { indexVersion: INDEX_VERSION, roots: [], projects, updatedAt: null } });
  assert.equal(summary.worktrees, 1, 'the extra checkout is counted once for the repository');
});

test('the file walker is bounded and ignores dependency and build directories', (t) => {
  const work = sandbox(t);
  const root = write(path.join(work, 'big'), {
    'package.json': '{"name":"big"}', 'src/a.js': 'a', 'node_modules/x/index.js': 'x', 'dist/out.js': 'o', '.venv/lib/y.py': 'y', '__pycache__/z.pyc': 'z',
  });
  const { files } = listFiles(root);
  assert.deepEqual(files.sort(), ['package.json', 'src/a.js']);
  const limited = listFiles(root, { maxFiles: 1 });
  assert.equal(limited.files.length, 1);
  assert.equal(limited.truncated, true);
});

test('fixture, test and bench projects are indexed but excluded from ordinary discovery; real projects and monorepo members stay', (t) => {
  const work = sandbox(t);
  const file = path.join(work, 'index.json');
  const ws = path.join(work, 'ws');
  // A real repository that contains fixtures/, bench/ and tests/ projects plus workspace members.
  const repoRoot = repo(path.join(ws, 'tooling'), {
    'package.json': JSON.stringify({ name: 'tooling', type: 'module', workspaces: ['packages/*'], scripts: { start: 'node server.mjs' } }),
    'server.mjs': "import { createServer } from 'node:http';\ncreateServer(async (req, res) => { res.end('ok'); }).listen(process.env.PORT);\n",
    'tests/e2e/app.test.js': 'export const t = 1;\n',
    'fixtures/old-app/package.json': JSON.stringify({ name: 'old-app', scripts: { start: 'node server.js' } }),
    'fixtures/old-app/server.js': "require('node:http').createServer((req, res) => res.end()).listen(process.env.PORT);\n",
    'bench/express-router/package.json': JSON.stringify({ name: 'express-router', dependencies: { express: '5.0.0' } }),
    'bench/express-router/main.js': "import express from 'express'; const app = express(); app.get('/x', (req, res) => res.json({})); app.listen(process.env.PORT);\n",
    'tests/harness-app/package.json': JSON.stringify({ name: 'harness-app' }),
    'tests/harness-app/index.js': 'export const a = 1;\n',
    'packages/api/package.json': JSON.stringify({ name: '@tooling/api', scripts: { start: 'node index.js' } }),
    'packages/api/index.js': "require('node:http').createServer((req, res) => res.end()).listen(process.env.PORT);\n",
    'packages/api/tests/api.test.js': 'module.exports = 1;\n',
  });
  // A plain (non-git) project under a fixtures folder of the workspace itself, and a real neighbour.
  write(path.join(ws, 'fixtures', 'sample'), { 'package.json': '{"name":"sample"}', 'index.js': 'exports.x = 1;\n' });
  repo(path.join(ws, 'real-app'), { 'package.json': '{"name":"real-app","scripts":{"start":"node server.js"}}', 'server.js': "require('node:http').createServer((req, res) => res.end()).listen(process.env.PORT);\n", 'tests/unit.test.js': 'module.exports = 1;\n' });
  addRoot(ws, { file });
  buildIndex({ file });
  const byName = Object.fromEntries(loadIndex({ file }).projects.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName).sort(), ['@tooling/api', 'express-router', 'harness-app', 'old-app', 'real-app', 'sample', 'tooling'], JSON.stringify(Object.keys(byName)));
  assert.equal(byName['tooling'].nonProduction, undefined, 'the repository root is a real project even though it contains tests/ and fixtures/');
  assert.equal(byName['@tooling/api'].nonProduction, undefined, 'a monorepo member with its own tests/ stays');
  assert.equal(byName['real-app'].nonProduction, undefined, 'a real project with a tests/ child stays');
  assert.equal(byName['old-app'].nonProduction, true, 'a project under fixtures/ is a fixture');
  assert.equal(byName['express-router'].nonProduction, true, 'a project under bench/ is a fixture');
  assert.equal(byName['harness-app'].nonProduction, true, 'a project under tests/ is a fixture');
  assert.equal(byName['sample'].nonProduction, true, 'a fixtures/ folder of the workspace root counts too');
  for (const [root, container, expected] of [['/w/r/fixtures/a', '/w/r', true], ['/w/r/bench/x/y', '/w/r', true], ['/w/r/tests/app', '/w/r', true], ['/w/r/__tests__/app', '/w/r', true], ['/w/r/apps/web', '/w/r', false], ['/w/r/packages/api', '/w/r', false], ['/w/r', '/w/r', false], ['/w/r/src/testing', '/w/r', false], ['/w/other', '/w/r', false]]) assert.equal(isFixtureProjectRoot(root, container), expected, `${root} in ${container}`);
  // Ordinary search never surfaces them; an explicit opt-in does.
  const ordinary = searchCapabilities('', { file });
  assert.equal(ordinary.results.some((r) => ['old-app', 'express-router', 'harness-app', 'sample'].includes(r.project.name)), false);
  const everything = searchCapabilities({ text: '', includeNonProduction: true }, { file });
  assert.ok(everything.results.length >= ordinary.results.length);
});
