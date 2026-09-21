import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeManifest, readManifest, listOrganBank, SOURCE_EVIDENCE_FILE } from '../src/manifest/io.js';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { SOURCE_FIXTURE, REPO } from './helpers.js';

const base = harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');
function bank(t, { existing = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-bank-transaction-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = structuredClone(base);
  old.identity.name = 'original package';
  old.sourceVerificationReport = { evidenceMarker: 'previous harvest' };
  const next = structuredClone(base);
  next.identity.name = 'replacement package';
  next.behavior.summary = 'A changed package generation';
  const target = path.join(root, 'authentication.graft');
  if (existing) writeManifest(root, old);
  return { root, old, next, target, lock: path.join(root, '.authentication.graft.lock'), backup: path.join(root, '.authentication.graft.previous') };
}
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((file) => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
}
function ordinaryBank(root) { assert.deepEqual(fs.readdirSync(root), ['authentication.graft']); }

test('a replacement is complete and drops obsolete source-verification evidence', (t) => {
  const b = bank(t);
  assert.ok(fs.existsSync(path.join(b.target, SOURCE_EVIDENCE_FILE)));
  assert.equal(writeManifest(b.root, b.next), b.target);
  assert.deepEqual(readManifest(b.target), b.next);
  assert.equal(fs.existsSync(path.join(b.target, SOURCE_EVIDENCE_FILE)), false);
  ordinaryBank(b.root);
});

for (const existing of [false, true]) {
  test(`partial staging writes preserve ${existing ? 'the original package' : 'an empty bank'}`, (t) => {
    const b = bank(t, { existing });
    const before = existing ? snapshot(b.target) : null;
    const realWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
      if (typeof file === 'string' && file.includes('-stage-') && path.basename(file) === 'architecture.json') {
        realWrite(file, '{ truncated');
        throw new Error('simulated full disk');
      }
      return realWrite(file, data, ...args);
    });
    assert.throws(() => writeManifest(b.root, b.next), /Manifest update failed.*simulated full disk/);
    if (existing) { assert.deepEqual(snapshot(b.target), before); ordinaryBank(b.root); }
    else assert.deepEqual(fs.readdirSync(b.root), []);
  });
}

test('a failed replacement rename restores the complete original package', (t) => {
  const b = bank(t);
  const before = snapshot(b.target);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.includes('-stage-') && to === b.target) throw new Error('simulated rename failure');
    return rename(from, to);
  });
  assert.throws(() => writeManifest(b.root, b.next), /simulated rename failure/);
  assert.deepEqual(snapshot(b.target), before);
  assert.deepEqual(readManifest(b.target), b.old);
  ordinaryBank(b.root);
});

test('failed restoration retains the previous package and a visible recovery lock', (t) => {
  const b = bank(t);
  const before = snapshot(b.target);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === b.target) throw new Error('simulated destination unavailable');
    return rename(from, to);
  });
  assert.throws(() => writeManifest(b.root, b.next), /Recovery incomplete.*previous package preserved/);
  assert.deepEqual(snapshot(b.backup), before);
  assert.equal(fs.existsSync(b.target), false);
  assert.equal(fs.existsSync(b.lock), true);
  assert.throws(() => readManifest(b.target), { code: 'manifest-busy' });
  assert.throws(() => writeManifest(b.root, b.next), { code: 'manifest-busy' });
  const entries = listOrganBank(b.root);
  assert.equal(entries.length, 1, 'a pending package must not silently disappear from the bank');
  assert.equal(entries[0].dir, b.target);
  assert.match(entries[0].error, /needs recovery/);
});

test('a second process cannot read or replace a package during promotion', (t) => {
  const b = bank(t);
  const rename = fs.renameSync;
  const moduleUrl = pathToFileURL(path.join(REPO, 'packages/core/src/manifest/io.js')).href;
  let checked = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === b.target && to === b.backup) {
      rename(from, to);
      const program = `import { writeManifest, readManifest } from ${JSON.stringify(moduleUrl)};
        const failures = [];
        for (const operation of [() => readManifest(${JSON.stringify(b.target)}), () => writeManifest(${JSON.stringify(b.root)}, ${JSON.stringify(b.next)})]) {
          try { operation(); failures.push('unexpected success'); } catch (err) { failures.push(err.code); }
        }
        console.log(JSON.stringify(failures));`;
      const outcomes = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 5000 }));
      assert.deepEqual(outcomes, ['manifest-busy', 'manifest-busy']);
      checked = true;
      return;
    }
    return rename(from, to);
  });
  writeManifest(b.root, b.next);
  assert.equal(checked, true);
  assert.deepEqual(readManifest(b.target), b.next);
  ordinaryBank(b.root);
});

test('a reader detects a complete replacement that happened between section reads', (t) => {
  const b = bank(t);
  const read = fs.readFileSync;
  let replaced = false;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    const result = read(file, ...args);
    if (!replaced && file === path.join(b.target, 'identity.json')) {
      replaced = true;
      writeManifest(b.root, b.next);
    }
    return result;
  });
  assert.throws(() => readManifest(b.target), /changed while being read/);
  assert.equal(replaced, true);
  assert.deepEqual(readManifest(b.target), b.next);
});

test('unrecognized files survive a refused re-harvest', (t) => {
  const b = bank(t);
  fs.writeFileSync(path.join(b.target, 'my-notes.md'), 'keep my notes');
  const before = snapshot(b.target);
  assert.throws(() => writeManifest(b.root, b.next), /unrecognized files: my-notes.md/);
  assert.deepEqual(snapshot(b.target), before);
  ordinaryBank(b.root);
});

test('a cleanup failure keeps the new package, previous copy, and recovery information', (t) => {
  const b = bank(t);
  const previous = snapshot(b.target);
  const remove = fs.rmSync;
  t.mock.method(fs, 'rmSync', (file, ...args) => {
    if (file === b.backup) throw new Error('simulated cleanup failure');
    return remove(file, ...args);
  });
  assert.throws(() => writeManifest(b.root, b.next), /New manifest was installed, but cleanup is incomplete/);
  assert.deepEqual(snapshot(b.backup), previous);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.target, 'identity.json'))).name, b.next.identity.name);
  assert.throws(() => readManifest(b.target), { code: 'manifest-busy' });
  assert.ok(fs.existsSync(b.lock));
});

test('reading packages requires no writable lock or staging file', (t) => {
  const b = bank(t);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    assert.equal(flags, 'r', 'readManifest must be usable from a read-only bank');
    return open(file, flags, ...args);
  });
  assert.deepEqual(readManifest(b.target), b.old);
  ordinaryBank(b.root);
});

for (const phase of ['staging', 'after-backup']) {
  test(`process death during ${phase} leaves the original package recoverable`, (t) => {
    const b = bank(t);
    const before = snapshot(b.target);
    const moduleUrl = pathToFileURL(path.join(REPO, 'packages/core/src/manifest/io.js')).href;
    const program = `import fs from 'node:fs';
      import path from 'node:path';
      import { writeManifest } from ${JSON.stringify(moduleUrl)};
      const phase = ${JSON.stringify(phase)};
      const write = fs.writeFileSync;
      fs.writeFileSync = (file, ...args) => {
        const result = write(file, ...args);
        if (phase === 'staging' && typeof file === 'string' && file.includes('-stage-') && path.basename(file) === 'architecture.json') process.kill(process.pid, 'SIGKILL');
        return result;
      };
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        const result = rename(from, to);
        if (phase === 'after-backup' && to === ${JSON.stringify(b.backup)}) process.kill(process.pid, 'SIGKILL');
        return result;
      };
      writeManifest(${JSON.stringify(b.root)}, ${JSON.stringify(b.next)});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 5000 });
    // A process that kills itself is reported by signal on POSIX; on Windows TerminateProcess
    // surfaces to the parent as exit code 1 with no signal (libuv only records signals it sent).
    if (process.platform === 'win32') assert.notEqual(result.status, 0, `the child must not complete normally: ${result.stderr}`); else assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert.deepEqual(snapshot(phase === 'staging' ? b.target : b.backup), before);
    assert.throws(() => readManifest(b.target), { code: 'manifest-busy' });
    assert.equal(listOrganBank(b.root).length, 1);
    // Follow the documented recovery path only after the owning process is dead.
    if (phase === 'after-backup') fs.renameSync(b.backup, b.target);
    for (const name of fs.readdirSync(b.root)) if (name.startsWith('.authentication.graft-stage-')) fs.rmSync(path.join(b.root, name), { recursive: true });
    fs.unlinkSync(b.lock);
    assert.deepEqual(readManifest(b.target), b.old);
    ordinaryBank(b.root);
  });
}
