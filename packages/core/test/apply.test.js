import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant, checkPreconditions } from '../src/apply/index.js';
import { SOURCE_FIXTURE, makeDestination } from './helpers.js';

const manifest = harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');
const planFor = (root, opts = {}) => createTransplantPlan(manifest, fingerprintProject(root), opts);
const codes = (r) => (r.problems || []).map((p) => p.code);

test('a plan with unresolved route collisions is refused', () => {
  const dest = makeDestination();
  try {
    const plan = planFor(dest.root); // destination already answers POST /auth/login
    assert.equal(plan.status, 'needs-resolution');
    const result = applyTransplant(plan, dest.root);
    assert.equal(result.applied, false);
    assert.ok(codes(result).includes('unresolved-conflicts'));
    assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false, 'nothing may be written when refused');
  } finally { dest.cleanup(); }
});

test('a dirty working tree is refused until explicitly allowed', () => {
  const dest = makeDestination();
  try {
    fs.writeFileSync(path.join(dest.root, 'src/scratch.js'), 'export const wip = 1;\n');
    const plan = planFor(dest.root, { resolveConflicts: true });
    assert.ok(codes(applyTransplant(plan, dest.root)).includes('dirty-working-tree'));
    const allowed = applyTransplant(plan, dest.root, { allowDirty: true });
    assert.equal(allowed.applied, true);
  } finally { dest.cleanup(); }
});

test('a project outside git is refused, because the change would not be recoverable', () => {
  const dest = makeDestination({ git: false });
  try {
    const plan = planFor(dest.root, { resolveConflicts: true });
    assert.ok(codes(applyTransplant(plan, dest.root)).includes('not-a-git-repo'));
  } finally { dest.cleanup(); }
});

test('existing files are never overwritten', () => {
  const dest = makeDestination();
  try {
    fs.mkdirSync(path.join(dest.root, 'src/auth'), { recursive: true });
    fs.writeFileSync(path.join(dest.root, 'src/auth/routes.js'), 'export const mine = 1;\n');
    const plan = planFor(dest.root, { resolveConflicts: true });
    const result = applyTransplant(plan, dest.root, { allowDirty: true });
    assert.equal(result.applied, false);
    assert.ok(codes(result).includes('would-overwrite-files'));
    assert.equal(fs.readFileSync(path.join(dest.root, 'src/auth/routes.js'), 'utf8'), 'export const mine = 1;\n');
  } finally { dest.cleanup(); }
});

test('a dry run reports the change without writing anything', () => {
  const dest = makeDestination();
  try {
    const plan = planFor(dest.root, { resolveConflicts: true });
    const result = applyTransplant(plan, dest.root, { dryRun: true });
    assert.equal(result.applied, false);
    assert.equal(result.dryRun, true);
    assert.ok(result.wouldWrite.length > 0);
    assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false);
  } finally { dest.cleanup(); }
});

test('an applied transplant is isolated on a branch and leaves a recovery point', () => {
  const dest = makeDestination();
  try {
    const before = fingerprintProject(dest.root);
    const plan = planFor(dest.root, { resolveConflicts: true });
    const result = applyTransplant(plan, dest.root);

    assert.equal(result.applied, true);
    assert.match(result.branch, /^graft\/authentication-/);
    assert.equal(result.recovery.branchBefore, 'main');
    assert.ok(result.recovery.headBefore);
    assert.ok(fs.existsSync(result.receiptPath), 'a receipt makes the transplant auditable');

    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    assert.equal(receipt.filesWritten.length, plan.files.length);
    assert.equal(receipt.verification, 'not-yet-run', 'applying is not verifying');

    // The conflicting route is disabled in place, never deleted.
    const entry = fs.readFileSync(path.join(dest.root, before.entrypoint), 'utf8');
    assert.match(entry, /\/\/ \[graft\] replaced by the transplanted authentication capability/);
    assert.match(entry, /\/\/app\.post\('\/auth\/login'/);
    assert.match(entry, /registerAuthRoutes\(app\)/);
  } finally { dest.cleanup(); }
});

test('transplanting twice is refused rather than duplicated', () => {
  const dest = makeDestination();
  try {
    const plan = planFor(dest.root, { resolveConflicts: true });
    assert.equal(applyTransplant(plan, dest.root).applied, true);
    const second = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true });
    const result = applyTransplant(second, dest.root, { allowDirty: true });
    assert.equal(result.applied, false);
    assert.ok(codes(result).some((c) => c === 'would-overwrite-files' || c === 'entrypoint-already-grafted'));
  } finally { dest.cleanup(); }
});

test('preconditions can be inspected without side effects', () => {
  const dest = makeDestination();
  try {
    const plan = planFor(dest.root, { resolveConflicts: true });
    const pre = checkPreconditions(plan, dest.root);
    assert.equal(pre.ok, true);
    assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false);
  } finally { dest.cleanup(); }
});

// ---------------- Repository identity: the recorded remote carries no credential ----------------
import os from 'node:os';
import { execFileSync as execGit } from 'node:child_process';
import { remoteOf, sanitiseRemote } from '../src/apply/git.js';

test('remoteOf records a repository identity without userinfo, query string or fragment, keeps SSH remotes, and refuses file/local remotes', (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-remote-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const git = (args) => execGit('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: work, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '-q', '-b', 'main']); fs.writeFileSync(path.join(work, 'a.txt'), 'a\n'); git(['add', '-A']); git(['commit', '-qm', 'one']);
  assert.equal(remoteOf(work), null, 'no origin: no identity');
  const cases = [
    ['https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://user:p%40ss@github.com/o/r.git', 'https://github.com/o/r.git'],
    ['https://github.com/o/r.git?token=abc123', 'https://github.com/o/r.git'],
    ['https://github.com/o/r.git#refs/heads/x@y', 'https://github.com/o/r.git'],
    ['https://user:secret@github.com/o/r.git?token=abc#frag', 'https://github.com/o/r.git'],
    ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
    ['http://git.example.internal/o/r', 'http://git.example.internal/o/r'],
    ['git@github.com:o/r.git', 'git@github.com:o/r.git'],
    ['ssh://git@github.com/o/r.git', 'ssh://github.com/o/r.git'],
    ['file:///tmp/elsewhere/r.git', null],
    ['/Users/someone/repos/r', null],
    ['../sibling', null],
  ];
  for (const [url, expected] of cases) assert.equal(sanitiseRemote(url), expected, `sanitise ${url}`);
  for (const [url, expected] of cases) {
    try { git(['remote', 'remove', 'origin']); } catch { /* none yet */ }
    git(['remote', 'add', 'origin', url]);
    const recorded = remoteOf(work);
    assert.equal(recorded, expected, `remoteOf ${url}`);
    if (recorded) for (const secret of ['ghp_', 'secret', 'token=', 'p%40ss', '#']) assert.equal(recorded.includes(secret), false, `${url} → ${recorded} must not carry ${secret}`);
  }
  assert.equal(sanitiseRemote(null), null); assert.equal(sanitiseRemote('https://?x=1'), 'https://', 'a degenerate URL keeps only what is left after the credential-bearing parts go');
});
