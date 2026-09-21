import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fingerprintProject, extractRoutes } from '../src/analyze/fingerprint.js';
import { harvest, harvestCapability } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { emitSessionAuth, planEntrypointEdit } from '../src/emit/session-auth.js';
import { verifyCapability } from '../src/verify/index.js';
import { bootServer } from '../src/verify/http-runner.js';
import { REPO, SOURCE_FIXTURE, copyDir, patchFile, makeSource } from './helpers.js';

const base = harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');
const fixtureRoot = path.join(REPO, 'fixtures/express-app');
const fixtureFp = fingerprintProject(fixtureRoot);
const original = fs.readFileSync(path.join(fixtureRoot, 'src/main.js'), 'utf8');
function destination() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-express-'));
  const root = path.join(work, 'express-app');
  copyDir(fixtureRoot, root);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.email=t@graft.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']]) {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  }
  return { root, work, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}
function apply(root, manifest = structuredClone(base)) {
  const plan = createTransplantPlan(manifest, fingerprintProject(root), { resolveConflicts: true });
  assert.equal(plan.adaptation.profile, 'express-req-res');
  assert.equal(plan.status, 'ready', JSON.stringify(plan.compatibility.blocking));
  const result = applyTransplant(plan, root);
  assert.equal(result.applied, true, JSON.stringify(result.problems));
  return result;
}

test('real Express destination preserves verified source behavior and surrounding middleware', async () => {
  const dest = destination();
  try {
    const { manifest, verification } = await harvestCapability(fingerprintProject(SOURCE_FIXTURE), 'authentication');
    assert.equal(verification.verdict, 'VERIFIED');
    assert.equal(createTransplantPlan(manifest, fingerprintProject(dest.root)).status, 'needs-resolution');
    const result = apply(dest.root, manifest);
    assert.equal(result.removedRoutes.length, 1);
    const report = await verifyCapability(manifest, dest.root);
    assert.equal(report.verdict, 'VERIFIED', report.rationale);
    assert.equal(report.summary.passed, 6);
    assert.equal(report.process.aliveAfterStop, false);
    const server = await bootServer(dest.root, 'src/main.js');
    try {
      assert.equal(server.ready, true);
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      assert.deepEqual(await health.json(), { ok: true, framework: 'express' });
      const anonymous = await fetch(`http://127.0.0.1:${server.port}/auth/me`);
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.headers.get('x-destination'), 'express-app');
      const missing = await fetch(`http://127.0.0.1:${server.port}/missing`);
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: 'not_found' });
    } finally { await server.stop(); }
  } finally { dest.cleanup(); }
});

for (const [name, file, before, after] of [
  ['password bypass', 'passwords.js', 'export function verifyPassword(password, salt, expectedHash) {', 'export function verifyPassword(password, salt, expectedHash) { return true;'],
  ['anonymous guard bypass', 'guard.js', 'export function requireAuth(req, res, next) {', 'export function requireAuth(req, res, next) { return next();'],
  ['session not persisted', 'sessions.js', 'export function getSession(id) {', 'export function getSession(id) { return null;'],
  ['logout session leak', 'sessions.js', 'export function destroySession(id) { sessions.remove(id); }', 'export function destroySession(id) {}'],
  ['cookie contract changed', 'sessions.js', 'COOKIE_NAME = "sid"', 'COOKIE_NAME = "renamed"'],
]) {
  test(`Express verifier catches ${name}`, async () => {
    const dest = destination();
    try {
      apply(dest.root);
      patchFile(dest.root, `src/auth/${file}`, before, after);
      const report = await verifyCapability(base, dest.root);
      assert.equal(report.verdict, 'FAILED', report.rationale);
    } finally { dest.cleanup(); }
  });
}

test('Express startup errors are inconclusive rather than verified', async () => {
  const dest = destination();
  try {
    apply(dest.root);
    fs.appendFileSync(path.join(dest.root, 'src/main.js'), '\nthrow new Error("startup control");\n');
    assert.equal((await verifyCapability(base, dest.root)).verdict, 'NEEDS_REVIEW');
  } finally { dest.cleanup(); }
});

test('Express emitter shares all interpolation safety guards', () => {
  for (const [section, field, value] of [
    ['session', 'cookieName', 'sid";globalThis.PWNED=1;//'],
    ['session', 'path', '/${globalThis.PWNED=1}'],
    ['session', 'sameSite', '${globalThis.PWNED=1}'],
    ['session', 'idBytes', '24;globalThis.PWNED=1'],
    ['session', 'ttlSeconds', '1);globalThis.PWNED=1'],
    ['session', 'httpOnly', 'false'], ['session', 'secure', 'false'],
    ['passwordHash', 'keyLength', '64;globalThis.PWNED=1'],
    ['passwordHash', 'saltBytes', '16;globalThis.PWNED=1'],
    ['guard', 'name', 'x(){};globalThis.PWNED=1;function y'],
    ['guard', 'unauthenticatedStatus', '401};globalThis.PWNED=1;'],
    ['passwordPolicy', 'minLength', '8){globalThis.PWNED=1;}'],
  ]) {
    const manifest = structuredClone(base);
    manifest.architecture.capabilityModel[section][field] = value;
    const plan = createTransplantPlan(manifest, fixtureFp, { resolveConflicts: true });
    assert.equal(plan.status, 'blocked', `${section}.${field}`);
    assert.equal(plan.files.length, 0);
  }
  const manifest = structuredClone(base);
  manifest.architecture.capabilityModel.endpoints[0].path = '/x";globalThis.PWNED=1;//';
  assert.throws(() => emitSessionAuth(manifest, fixtureFp), { code: 'unsafe-manifest-value' });
});

for (const [name, change] of [
  ['mounted router', (s) => s.replace("app.get('/health'", "app.use('/api', express.Router());\napp.get('/health'")],
  ['dynamic route', (s) => s.replace("app.get('/health'", "app.get(process.env.ROUTE")],
  ['conditional route', (s) => s.replace("app.get('/health'", "if (process.env.ENABLED) app.get('/health'")],
  ['chained route', (s) => s.replace("app.get('/health'", "app.route('/health').get(")],
  ['CommonJS module', (s) => s.replace("import express from 'express';", "const express = require('express');")],
]) {
  test(`unsupported Express ${name} is blocked before writes`, () => {
    const dest = destination();
    try {
      fs.writeFileSync(path.join(dest.root, 'src/main.js'), change(original));
      const plan = createTransplantPlan(base, fingerprintProject(dest.root), { resolveConflicts: true });
      assert.equal(plan.status, 'blocked');
      assert.equal(plan.files.length, 0);
      assert.equal(applyTransplant(plan, dest.root, { allowDirty: true }).refused, true);
    } finally { dest.cleanup(); }
  });
}

test('entrypoint edits handle multiline routes, same-line statements, and comment-only routes', () => {
  const source = `import express from 'express'; const app = express();
// app.post('/auth/login', imaginary);
app.post('/auth/login', (req, res) => {
  res.json({ text: '} ); // not syntax' });
}); app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(process.env.PORT);`;
  const edit = planEntrypointEdit(source, { routesModule: './auth/routes.js', profile: 'express-req-res', conflictingRoutes: [{ method: 'POST', path: '/auth/login' }], resolveConflicts: true });
  assert.equal(edit.applied, true, edit.reason);
  assert.equal(extractRoutes('main.js', edit.source).filter((r) => r.path === '/auth/login').length, 0);
  assert.equal(extractRoutes('main.js', edit.source).filter((r) => r.path === '/health').length, 1);
  assert.equal(planEntrypointEdit(edit.source, { routesModule: './auth/routes.js' }).reason, 'already-grafted');
});

test('Secure cookies are preserved and invalid TTL configuration refuses to start', () => {
  const dest = destination();
  try {
    const manifest = structuredClone(base);
    manifest.architecture.capabilityModel.session.secure = true;
    apply(dest.root, manifest);
    const sessions = fs.readFileSync(path.join(dest.root, 'src/auth/sessions.js'), 'utf8');
    assert.equal((sessions.match(/Secure;/g) || []).length, 2);
    for (const ttl of ['NaN', '-1', '0', '1.5', '31536001']) {
      const result = spawnSync(process.execPath, ['src/main.js'], { cwd: dest.root, encoding: 'utf8', timeout: 3000, env: { PATH: process.env.PATH, SESSION_TTL_SECONDS: ttl, PORT: '0' } });
      assert.equal(result.status, 1, ttl);
      assert.match(result.stderr, /SESSION_TTL_SECONDS must be/);
    }
  } finally { dest.cleanup(); }
});

test('harvest preserves a source Secure cookie flag through the emitter', () => {
  const source = makeSource();
  try {
    patchFile(source.root, 'lib/sessions.js', 'HttpOnly;', 'HttpOnly; Secure;');
    const manifest = harvest(fingerprintProject(source.root), 'authentication');
    assert.equal(manifest.architecture.capabilityModel.session.secure, true);
    const emitted = emitSessionAuth(manifest, fixtureFp);
    assert.match(emitted.files.find((file) => file.path.endsWith('/sessions.js')).contents, /HttpOnly; Secure;/);
  } finally { source.cleanup(); }
});
