import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SOURCE_FIXTURE = path.join(REPO, 'fixtures/old-saas-project');
export const DEST_FIXTURE = path.join(REPO, 'fixtures/new-startup');

export function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

/** A disposable copy of the destination fixture with its own git repository. */
export function makeDestination({ git = true } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-test-'));
  const root = path.join(work, 'new-startup');
  copyDir(DEST_FIXTURE, root);
  if (git) {
    const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    run(['init', '-q', '-b', 'main']);
    run(['add', '-A']);
    run(['-c', 'user.email=t@graft.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  }
  return { work, root, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

/** A disposable copy of the SOURCE fixture with its own git repository. */
export function makeSource() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-src-'));
  const root = path.join(work, 'old-saas-project');
  copyDir(SOURCE_FIXTURE, root);
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run(['init', '-q', '-b', 'main']);
  run(['add', '-A']);
  run(['-c', 'user.email=t@graft.local', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  return { work, root, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

/** In-place text substitution that refuses to silently do nothing. */
export function patchFile(root, file, from, to) {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`patch target not found in ${file}: ${from}`);
  fs.writeFileSync(p, src.replace(from, to), 'utf8');
}
