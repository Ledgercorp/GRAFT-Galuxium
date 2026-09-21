import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareTransplant, listTransplants, getTransplant, assertApplyable, transition, stateForVerdict, changedFiles, cleanupTransplant, loadTransplants, TRANSPLANT_STATES } from '../src/apply/worktree.js';
import { startProviderDouble } from '../src/verify/provider-double.js';
import { validateAcceptanceTests } from '../src/manifest/schema.js';
import { observeCapabilities } from '../src/workspace/capabilities.js';
import { detectProject } from '../src/workspace/detect.js';
import { parseQuery, searchCapabilities } from '../src/workspace/search.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, files) => { for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } return root; };
function repo(root, files) {
  fs.mkdirSync(root, { recursive: true }); write(root, files);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  return fs.realpathSync(root);
}
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-workflow-')));
  const previous = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
const DEST = { 'package.json': JSON.stringify({ name: 'dest', type: 'module', scripts: { serve: 'node server.mjs' } }), 'server.mjs': 'import { createServer } from "node:http";\ncreateServer(async (req, res) => { res.end("ok"); }).listen(Number(process.env.PORT || 4000));\n' };

test('a transplant is prepared in a dedicated worktree on a safe branch cut from the recorded HEAD', (t) => {
  const work = sandbox(t);
  const dest = repo(path.join(work, 'dest'), DEST);
  const head = git(dest, 'rev-parse', 'HEAD');
  const prepared = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'hosted-authentication' });
  assert.equal(prepared.state, 'READY');
  assert.match(prepared.worktree.branch, /^graft\/hosted-authentication-[0-9a-f]{8}$/);
  assert.ok(prepared.worktree.path.startsWith(path.join(process.env.GRAFT_HOME, 'worktrees') + path.sep), 'beneath GRAFT_HOME');
  assert.equal(prepared.baseHead, head);
  assert.equal(git(prepared.worktree.path, 'rev-parse', 'HEAD'), head);
  assert.equal(git(prepared.worktree.path, 'symbolic-ref', '--short', 'HEAD'), prepared.worktree.branch);
  assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), 'main', 'the primary checkout stays on its branch');
  assert.equal(git(dest, 'status', '--porcelain'), '', 'the primary checkout is untouched');
  assert.deepEqual(prepared.history.map((h) => h.state), ['PREPARING', 'READY']);
  for (const h of prepared.history) assert.ok(TRANSPLANT_STATES.includes(h.state));
  // Persisted: a fresh process (new load) sees the same record.
  assert.equal(loadTransplants().transplants[0].id, prepared.id);
});

test('unsafe destinations are refused by name: source, GRAFT-managed folders, injection-shaped paths, symlinks resolve', (t) => {
  const work = sandbox(t);
  const dest = repo(path.join(work, 'dest'), DEST);
  const source = repo(path.join(work, 'src'), { 'package.json': '{"name":"src"}' });
  assert.throws(() => prepareTransplant({ destinationRoot: dest, sourceRoot: dest, capabilitySlug: 'x' }), /cannot also be the destination/);
  // Another checkout of the source repository is still the source.
  const sourceTwin = path.join(work, 'src-twin');
  git(source, 'worktree', 'add', '-q', '-b', 'twin', sourceTwin);
  assert.throws(() => prepareTransplant({ destinationRoot: sourceTwin, sourceRoot: source, capabilitySlug: 'x' }), (e) => e.code === 'source-repository-is-destination');
  assert.throws(() => prepareTransplant({ destinationRoot: path.join(process.env.GRAFT_HOME, 'worktrees'), capabilitySlug: 'x' }), (e) => ['destination-inside-graft-home', 'destination-missing'].includes(e.code));
  fs.mkdirSync(path.join(process.env.GRAFT_HOME, 'anything'), { recursive: true });
  assert.throws(() => prepareTransplant({ destinationRoot: path.join(process.env.GRAFT_HOME, 'anything'), capabilitySlug: 'x' }), (e) => e.code === 'destination-inside-graft-home');
  for (const bad of ['relative/path', '/tmp/does-not-exist-graft', 'x\0y']) assert.throws(() => prepareTransplant({ destinationRoot: bad, capabilitySlug: 'x' }));
  for (const badSlug of ['Bad Slug', '../x', 'x;rm', 'a'.repeat(60), '']) assert.throws(() => prepareTransplant({ destinationRoot: dest, capabilitySlug: badSlug }), (e) => e.code === 'invalid-slug');
  // A symlink to the destination resolves to the same real repository, so identity is preserved.
  const link = path.join(work, 'dest-link');
  fs.symlinkSync(dest, link);
  const viaLink = prepareTransplant({ destinationRoot: link, capabilitySlug: 'hosted-authentication' });
  assert.equal(viaLink.destination.root, dest);
  // The worktree GRAFT created cannot itself be chosen as a destination.
  assert.throws(() => prepareTransplant({ destinationRoot: viaLink.worktree.path, capabilitySlug: 'x' }), (e) => e.code === 'destination-inside-graft-home');
  // A nested folder of a repository is not a destination.
  fs.mkdirSync(path.join(dest, 'sub'), { recursive: true }); fs.writeFileSync(path.join(dest, 'sub', 'package.json'), '{"name":"sub"}');
  assert.throws(() => prepareTransplant({ destinationRoot: path.join(dest, 'sub'), capabilitySlug: 'x' }), (e) => e.code === 'destination-is-nested');
  // Not a repository / no commits.
  const plain = write(path.join(work, 'plain'), { 'package.json': '{"name":"plain"}' });
  assert.throws(() => prepareTransplant({ destinationRoot: plain, capabilitySlug: 'x' }), (e) => e.code === 'destination-not-a-repository');
});

test('dirty destinations are refused by default and allowed explicitly; the worktree never includes uncommitted work', (t) => {
  const work = sandbox(t);
  const dest = repo(path.join(work, 'dest'), DEST);
  fs.writeFileSync(path.join(dest, 'wip.txt'), 'uncommitted');
  assert.throws(() => prepareTransplant({ destinationRoot: dest, capabilitySlug: 'x' }), (e) => e.code === 'destination-dirty');
  const prepared = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'x', allowDirty: true });
  assert.equal(prepared.destination.dirtyAtPreparation, true);
  assert.equal(fs.existsSync(path.join(prepared.worktree.path, 'wip.txt')), false);
  assert.equal(fs.existsSync(path.join(dest, 'wip.txt')), true, 'the user\'s work is left alone');
});

test('HEAD drift, a touched worktree, staleness and concurrent preparation are detected', (t) => {
  const work = sandbox(t);
  const dest = repo(path.join(work, 'dest'), DEST);
  const prepared = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'x' });
  assert.equal(assertApplyable(prepared.id).id, prepared.id);
  // Someone commits inside the worktree: the base the plan was built for is gone.
  fs.writeFileSync(path.join(prepared.worktree.path, 'extra.txt'), 'x');
  assert.throws(() => assertApplyable(prepared.id), (e) => e.code === 'worktree-dirty');
  git(prepared.worktree.path, 'add', '-A'); git(prepared.worktree.path, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'drift');
  assert.equal(getTransplant(prepared.id).state, 'STALE', 'a moved base marks the record stale');
  assert.throws(() => assertApplyable(prepared.id), (e) => e.code === 'transplant-not-ready');

  // A worktree that disappears is stale, and cleanup still succeeds (prune).
  const second = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'y' });
  fs.rmSync(second.worktree.path, { recursive: true, force: true });
  assert.equal(getTransplant(second.id).state, 'STALE');
  assert.equal(cleanupTransplant(second.id).state, 'CLEANED');
  // Concurrency: a held registry lock refuses a second operation instead of racing it.
  const lock = `${path.join(process.env.GRAFT_HOME, 'transplants.json')}.lock`;
  fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
  assert.throws(() => prepareTransplant({ destinationRoot: dest, capabilitySlug: 'z' }), (e) => e.code === 'transplant-busy');
  fs.rmSync(lock);
  // Two transplants for one repository get distinct branches and paths.
  const a = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'z' });
  const b = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'z' });
  assert.notEqual(a.worktree.branch, b.worktree.branch);
  assert.notEqual(a.worktree.path, b.worktree.path);
});

test('lifecycle is descriptive: a verdict is copied from a report and never invented; cleanup protects changes', (t) => {
  const work = sandbox(t);
  const dest = repo(path.join(work, 'dest'), DEST);
  const prepared = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'x' });
  assert.equal(stateForVerdict('VERIFIED'), 'VERIFIED');
  assert.equal(stateForVerdict('FAILED'), 'FAILED');
  assert.equal(stateForVerdict('NEEDS_REVIEW'), 'INCONCLUSIVE');
  assert.throws(() => transition(prepared.id, 'PASSED'), (e) => e.code === 'invalid-state');
  const applied = transition(prepared.id, 'APPLIED', { receipt: { filesWritten: ['src/auth/routes.js'], entrypoint: { file: 'server.mjs', edits: 3 } } });
  assert.equal(applied.verdict, null, 'APPLIED carries no verdict');
  fs.mkdirSync(path.join(prepared.worktree.path, 'src/auth'), { recursive: true }); fs.writeFileSync(path.join(prepared.worktree.path, 'src/auth/routes.js'), 'export const x = 1;\n');
  fs.appendFileSync(path.join(prepared.worktree.path, 'server.mjs'), '// edited\n');
  const changes = changedFiles(prepared.id);
  assert.deepEqual(changes.created, ['src/auth/routes.js']);
  assert.deepEqual(changes.modified, ['server.mjs']);
  assert.match(changes.diff, /\+\/\/ edited/);
  assert.throws(() => cleanupTransplant(prepared.id), (e) => e.code === 'worktree-has-changes');
  assert.equal(fs.existsSync(prepared.worktree.path), true, 'refused cleanup removes nothing');
  // If something moved the worktree onto another graft/ branch, cleanup removes that too; a
  // branch that is not GRAFT's is left alone.
  git(prepared.worktree.path, 'checkout', '-q', '-b', 'graft/moved-0123abcd');
  git(dest, 'branch', 'keep-me');
  const cleaned = cleanupTransplant(prepared.id, { confirmDiscard: true });
  assert.equal(cleaned.state, 'CLEANED');
  assert.equal(fs.existsSync(prepared.worktree.path), false);
  assert.equal(git(dest, 'branch', '--list', prepared.worktree.branch), '', 'the branch is gone');
  assert.equal(git(dest, 'branch', '--list', 'graft/moved-0123abcd'), '', 'the branch the worktree ended on is gone');
  assert.match(git(dest, 'branch', '--list', 'keep-me'), /keep-me/, 'unrelated branches survive');
  assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(listTransplants().find((x) => x.id === prepared.id).state, 'CLEANED', 'history is kept');
});

test('the secret-output witness sees body, headers, cookies and process output; it never passes vacuously', async () => {
  const validate = validateAcceptanceTests;
  const step = (expect) => [{ id: 't', kind: 'http', required: true, provesBehavior: 'b', steps: [{ name: 's', method: 'GET', path: '/x', expect }] }];
  assert.equal(validate(step({ status: [200], noSecretsInOutput: true })).ok, true);
  assert.equal(validate(step({ status: [200], noSecretsInOutput: 'yes' })).ok, false);
  assert.equal(validate([{ id: 't', kind: 'http', required: true, provesBehavior: 'b', steps: [{ name: 's', method: 'GET', path: '/x', providerControl: { tokenLifetimeSeconds: 2 }, expect: { status: [200] } }] }]).ok, true);
  assert.equal(validate([{ id: 't', kind: 'http', required: true, provesBehavior: 'b', steps: [{ name: 's', method: 'GET', path: '/x', providerControl: { tokenLifetimeSeconds: 0 }, expect: { status: [200] } }] }]).ok, false);
  assert.equal(validate([{ id: 't', kind: 'http', required: true, provesBehavior: 'b', steps: [{ name: 's', method: 'GET', path: '/x', providerControl: { refreshSubject: 'Bad Subject!' }, expect: { status: [200] } }] }]).ok, false);
  const double = await startProviderDouble({ endpoints: { authorize: '/a', token: '/t', revoke: '/r' } });
  try {
    assert.deepEqual(double.sentinels().map((s) => s.name), ['provider-client-secret']);
    await double.control({ tokenLifetimeSeconds: 2 });
    const post = (body) => fetch(`${double.origin}/t`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const tokens = await post({ grant_type: 'refresh_token', refresh_token: 'graft-refresh-session_graft1' });
    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
    assert.equal(payload.exp - payload.iat, 2, 'the requested short lifetime is honoured');
    assert.equal(payload.sub, 'graft-user');
    await double.control({ refreshSubject: 'someone-else' });
    const changed = await post({ grant_type: 'refresh_token', refresh_token: 'graft-refresh-session_graft1' });
    assert.equal(JSON.parse(Buffer.from(changed.access_token.split('.')[1], 'base64url').toString()).sub, 'someone-else');
    await double.reset();
    const restored = await post({ grant_type: 'refresh_token', refresh_token: 'graft-refresh-session_graft1' });
    const restoredPayload = JSON.parse(Buffer.from(restored.access_token.split('.')[1], 'base64url').toString());
    assert.equal(restoredPayload.sub, 'graft-user');
    assert.equal(restoredPayload.exp - restoredPayload.iat, 300, 'reset restores the default lifetime');
  } finally { await double.stop(); }
});

test('audience is structural and searchable: user-facing and machine-facing queries separate cleanly', (t) => {
  const work = sandbox(t);
  const userApp = write(path.join(work, 'user'), { 'package.json': JSON.stringify({ name: 'user-app', dependencies: { '@workos-inc/node': '1.0.0' } }), 'src/auth.js': `const sessions = new Map();
    if (method === 'GET' && path === '/auth/login') {}
    if (method === 'GET' && path === '/auth/callback') { const body = { grant_type: 'authorization_code' }; const url = 'https://api.workos.com/user_management/authorize?code_challenge=x&code_challenge_method=S256'; }
    res.setHeader('set-cookie', 'app=' + require('crypto').randomBytes(32).toString('base64url') + '; HttpOnly; SameSite=Lax');` });
  const machineApp = write(path.join(work, 'machine'), { 'package.json': '{"name":"machine-app"}', 'src/client.js': `const body = new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' });
    fetch('https://123.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token', { method: 'POST', body });` });
  const keyApp = write(path.join(work, 'key'), { 'package.json': '{"name":"key-app"}', 'src/server.js': `const { timingSafeEqual } = require('node:crypto');
    if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) return; timingSafeEqual(Buffer.from(req.headers.authorization), Buffer.from(process.env.API_TOKEN));` });
  const [u] = observeCapabilities(detectProject(userApp), { projectId: 'u' });
  const [m] = observeCapabilities(detectProject(machineApp), { projectId: 'm' });
  const [k] = observeCapabilities(detectProject(keyApp), { projectId: 'k' });
  assert.equal(u.audience, 'user');
  assert.equal(m.audience, 'machine');
  assert.equal(k.audience, 'machine');
  assert.equal(u.auth.audience, 'user');
  const project = (name, root, cap) => ({ projectId: name, name, root, relativeRoot: '.', repositoryId: name, repository: { name }, language: 'javascript', runtime: 'node', framework: 'node-http', moduleSystem: 'cjs', hasHttpServer: true, externalHosts: [], capabilities: [cap] });
  const index = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [project('user-app', userApp, u), project('machine-app', machineApp, m), project('key-app', keyApp, k)] };
  for (const q of ['find user-facing authentication I have already built', 'login for users', 'human login', 'user login']) assert.equal(parseQuery(q).filters.audience, 'user', q);
  for (const q of ['machine auth', 'service auth', 'API authentication', 'M2M', 'machine-to-machine']) assert.equal(parseQuery(q).filters.audience, 'machine', q);
  const users = searchCapabilities('find user-facing authentication I have already built', { index });
  assert.deepEqual(users.results.map((r) => r.project.name), ['user-app']);
  assert.ok(users.results[0].matchedBecause.some((w) => w.signal === 'audience'));
  const machines = searchCapabilities('machine auth', { index });
  assert.deepEqual(machines.results.map((r) => r.project.name).sort(), ['key-app', 'machine-app']);
  // Ranking ties break on evidence, never on names.
  const all = searchCapabilities('authentication', { index });
  for (let i = 1; i < all.results.length; i++) assert.ok(all.results[i - 1].score > all.results[i].score || all.results[i - 1].signalCount >= all.results[i].signalCount);
});

test('a prepared worktree shares the checkout\'s ignored node_modules by link, and never a tracked one', (t) => {
  const work = sandbox(t);
  const dest = repo(path.join(work, 'dest'), { ...DEST, '.gitignore': 'node_modules\n' });
  fs.mkdirSync(path.join(dest, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'node_modules', 'left-pad', 'index.js'), 'module.exports = (s) => s;\n');
  const prepared = prepareTransplant({ destinationRoot: dest, capabilitySlug: 'x' });
  const link = path.join(prepared.worktree.path, 'node_modules');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'linked, not copied');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(dest, 'node_modules')));
  assert.equal(git(prepared.worktree.path, 'status', '--porcelain'), '', 'git sees nothing new in the worktree');
  assert.equal(assertApplyable(prepared.id).id, prepared.id);
  cleanupTransplant(prepared.id, { confirmDiscard: true });
  assert.equal(fs.existsSync(path.join(dest, 'node_modules', 'left-pad', 'index.js')), true, 'cleanup never touches the checkout\'s dependencies');
  // A tracked node_modules is part of the commit: nothing to link.
  const tracked = repo(path.join(work, 'tracked'), { ...DEST, 'node_modules/vendored/index.js': 'module.exports = 1;\n' });
  const second = prepareTransplant({ destinationRoot: tracked, capabilitySlug: 'x' });
  assert.equal(fs.lstatSync(path.join(second.worktree.path, 'node_modules')).isSymbolicLink(), false);
  // No node_modules at all: nothing happens.
  const bare = repo(path.join(work, 'bare'), DEST);
  const third = prepareTransplant({ destinationRoot: bare, capabilitySlug: 'x' });
  assert.equal(fs.existsSync(path.join(third.worktree.path, 'node_modules')), false);
});
