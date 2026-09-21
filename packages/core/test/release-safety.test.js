import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest, harvestCapability } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant, inspectRepo } from '../src/apply/index.js';
import { writeManifest, readManifest } from '../src/manifest/io.js';
import { validateManifest } from '../src/manifest/schema.js';
import { addProject, loadRegistry } from '../src/registry/index.js';
import { SOURCE_FIXTURE, makeDestination } from './helpers.js';

const fresh = () => harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');
const planFor = (root) => createTransplantPlan(fresh(), fingerprintProject(root), { resolveConflicts: true });

for (const link of ['src/auth', '.graft', 'src/main.js']) {
  test(`apply refuses linked ${link} before any generated writes`, () => {
    const dest = makeDestination();
    try {
      const plan = planFor(dest.root);
      const outside = path.join(dest.work, 'outside');
      fs.mkdirSync(outside);
      const linked = path.join(dest.root, link);
      const target = link.endsWith('.js') ? path.join(outside, 'main.js') : outside;
      if (link.endsWith('.js')) { fs.copyFileSync(linked, target); fs.unlinkSync(linked); }
      const before = link.endsWith('.js') ? fs.readFileSync(target, 'utf8') : null;
      fs.symlinkSync(target, linked);
      const branch = inspectRepo(dest.root).branch;
      const result = applyTransplant(plan, dest.root, { allowDirty: true });
      assert.equal(result.refused, true);
      assert.ok(result.problems.some((p) => p.code === 'unsafe-project-path'));
      assert.equal(inspectRepo(dest.root).branch, branch);
      if (before) assert.equal(fs.readFileSync(target, 'utf8'), before);
      else assert.deepEqual(fs.readdirSync(outside), []);
      assert.equal(fs.existsSync(path.join(dest.root, 'src/auth/passwords.js')), false);
    } finally { dest.cleanup(); }
  });
}

for (const bad of ['../escape.js', '.git/config', '/tmp/graft-outside.js', 'src/../escape.js']) {
  test(`all outputs are preflighted: ${bad}`, () => {
    const dest = makeDestination();
    try {
      const plan = planFor(dest.root);
      plan.files.push({ path: bad, contents: 'bad' });
      assert.equal(applyTransplant(plan, dest.root).refused, true);
      assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false);
      assert.equal(inspectRepo(dest.root).branch, 'main');
    } finally { dest.cleanup(); }
  });
}

test('failed writes restore the entrypoint and remove only new files', (t) => {
  const dest = makeDestination();
  try {
    const plan = planFor(dest.root);
    const entry = fs.readFileSync(path.join(dest.root, plan.destination.entrypoint), 'utf8');
    const receiptDir = path.join(dest.root, '.graft/transplants');
    fs.mkdirSync(receiptDir, { recursive: true });
    const receipt = path.join(receiptDir, `${plan.id}.json`);
    fs.writeFileSync(receipt, 'keep existing receipt');
    const preflight = applyTransplant(plan, dest.root, { allowDirty: true });
    assert.equal(preflight.refused, true);
    assert.ok(preflight.problems.some((p) => p.code === 'would-overwrite-files'));
    fs.unlinkSync(receipt);
    const realWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
      if (typeof data === 'string' && data.includes('\"planId\"')) {
        realWrite(file, '{ partial receipt');
        throw new Error('simulated receipt storage failure');
      }
      return realWrite(file, data, ...args);
    });
    assert.throws(() => applyTransplant(plan, dest.root, { allowDirty: true }), /entrypoint restored/);
    assert.equal(fs.readFileSync(path.join(dest.root, plan.destination.entrypoint), 'utf8'), entry);
    assert.equal(fs.existsSync(receipt), false);
    for (const file of plan.files) assert.equal(fs.existsSync(path.join(dest.root, file.path)), false);
  } finally { dest.cleanup(); }
});

test('manifest slug traversal and linked sections cannot escape the bank', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-bank-safe-'));
  try {
    const manifest = fresh();
    manifest.identity.slug = '../../escape';
    assert.throws(() => writeManifest(work, manifest), /slug/);
    manifest.identity.slug = 'authentication';
    const dir = writeManifest(work, manifest);
    const outside = path.join(work, 'outside.json');
    fs.writeFileSync(outside, 'keep');
    fs.unlinkSync(path.join(dir, 'identity.json'));
    fs.symlinkSync(outside, path.join(dir, 'identity.json'));
    assert.throws(() => writeManifest(work, manifest), /symbolic link/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('empty assertions and unknown assertions cannot be read as a valid manifest', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-manifest-safe-'));
  try {
    const manifest = fresh();
    const dir = writeManifest(work, manifest);
    for (const expect of [{}, { madeUpAssertion: true }, { status: [] }, { bodyMatches: {} }]) {
      manifest.acceptanceTests.tests[0].steps[0].expect = expect;
      fs.writeFileSync(path.join(dir, 'acceptance-tests.json'), JSON.stringify(manifest.acceptanceTests));
      assert.throws(() => readManifest(dir), /invalid manifest/);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('VERIFIED provenance must match the actual required tests exactly', async () => {
  const { manifest } = await harvestCapability(fingerprintProject(SOURCE_FIXTURE), 'authentication');
  assert.equal(validateManifest(manifest).ok, true);
  for (const mutate of [
    (m) => { m.provenance.verifiedInSource.tests = [{ id: 'nonexistent', required: false, outcome: 'failed' }]; },
    (m) => { const t = m.provenance.verifiedInSource.tests; t.splice(t.findIndex((x) => x.required), 1); }, // a REQUIRED test's evidence is missing
    (m) => { m.provenance.verifiedInSource.tests[0].required = false; },
    (m) => { m.provenance.verifiedInSource.tests.push(m.provenance.verifiedInSource.tests[0]); },
    (m) => { m.provenance.verifiedInSource.summary.passed = 99; },
  ]) {
    const modified = structuredClone(manifest); mutate(modified);
    assert.equal(validateManifest(modified).ok, false);
  }
});

test('malformed nested manifest values return validation errors instead of crashing', () => {
  for (const mutate of [
    (m) => { m.behavior.statements = {}; },
    (m) => { m.behavior.statements = [null]; },
    (m) => { m.environment.variables = ['bad']; },
    (m) => { m.acceptanceTests.tests = [null]; },
  ]) {
    const manifest = fresh(); mutate(manifest);
    assert.equal(validateManifest(manifest).ok, false);
  }
});

test('corrupt and concurrently locked registries are preserved', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-registry-safe-'));
  const previous = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = work;
  try {
    const registry = path.join(work, 'registry.json');
    for (const value of ['{ truncated', '{"version":1,"projects":null,"transplants":[]}']) {
      fs.writeFileSync(registry, value);
      assert.throws(() => addProject(SOURCE_FIXTURE), /existing data was preserved/);
      assert.equal(fs.readFileSync(registry, 'utf8'), value);
      assert.equal(fs.existsSync(path.join(work, 'registry.lock')), false);
    }
    fs.unlinkSync(registry);
    addProject(SOURCE_FIXTURE);
    const before = fs.readFileSync(registry, 'utf8');
    fs.writeFileSync(path.join(work, 'registry.lock'), 'other process');
    assert.throws(() => addProject(work), /Registry is busy/);
    assert.equal(fs.readFileSync(registry, 'utf8'), before);
    assert.equal(loadRegistry().projects.length, 1);
  } finally {
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('an unborn git repository is identified honestly', () => {
  const dest = makeDestination({ git: false });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dest.root });
    const repo = inspectRepo(dest.root);
    assert.equal(repo.isRepo, true);
    assert.equal(repo.branch, 'main');
    assert.equal(repo.hasCommits, false);
    assert.equal(repo.head, null);
    const result = applyTransplant(planFor(dest.root), dest.root, { allowDirty: true });
    assert.ok(result.problems.some((p) => p.code === 'no-recovery-commit'));
  } finally { dest.cleanup(); }
});

test('CONTRACT: every project-relative path the fingerprint produces is canonical POSIX and accepted by safeProjectPath on this platform', async () => {
  const { walkSourceFiles, toProjectPath, fingerprintProject } = await import('../src/analyze/fingerprint.js');
  const { safeProjectPath } = await import('../src/util/paths.js');
  const root = path.resolve('fixtures/new-startup');
  const files = walkSourceFiles(root);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.doesNotMatch(f, /\\/, `backslash in project path ${f}`);
    assert.ok(!path.isAbsolute(f));
    assert.doesNotThrow(() => safeProjectPath(root, f), f);
    assert.ok(fs.existsSync(path.join(root, f)), `${f} resolves on the host`);
  }
  assert.equal(toProjectPath(path.join('src', 'auth', 'routes.js')), 'src/auth/routes.js');
  const fp = fingerprintProject(root);
  assert.equal(fp.entrypoint, 'src/main.js');
  for (const r of fp.routes) assert.doesNotMatch(r.file, /\\/);
  assert.doesNotThrow(() => safeProjectPath(root, fp.entrypoint));
});
