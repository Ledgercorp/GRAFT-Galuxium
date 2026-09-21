// Public demo fixtures — isolated from every customer, dogfood and development location.
//
//   /Users/Shared/graft-demo/existing-software/cuf        the real CUF repository (hosted sign-in)
//   /Users/Shared/graft-demo/existing-software/swiveljs   the real SwivelJS repository (feature flags)
//   /Users/Shared/graft-demo/new-software/                where GRAFT creates the new application
//
// No space in the path: CUF's web app derives file paths from import.meta.url and a %20 there breaks
// its own boot (a CUF quirk, not GRAFT's).
//
// Both sources are exact copies (git history, node_modules, built dist) of the checkouts the product
// has already been proven against, placed under a path with no personal segment. `--reset` returns
// the demo folder and the demo app home to the clean starting state; `--remove` deletes them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DEMO_ROOT = '/Users/Shared/graft-demo';
export const SOURCES = path.join(DEMO_ROOT, 'existing-software');
export const NEW_SOFTWARE = path.join(DEMO_ROOT, 'new-software');
export const DEMO_HOME = path.join(os.homedir(), '.graft-demo', 'public-demo');
const ORIGINS = { cuf: path.join(os.homedir(), 'Developer/CUF'), swiveljs: path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs') };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function setup({ reset = false } = {}) {
  for (const [name, origin] of Object.entries(ORIGINS)) {
    if (!fs.existsSync(path.join(origin, '.git'))) throw new Error(`${origin} is not a git checkout`);
    if (git(origin, ['status', '--porcelain'])) throw new Error(`${origin} has uncommitted changes; the demo copies a clean checkout only`);
  }
  if (reset) { fs.rmSync(NEW_SOFTWARE, { recursive: true, force: true }); fs.rmSync(DEMO_HOME, { recursive: true, force: true }); }
  fs.mkdirSync(SOURCES, { recursive: true }); fs.mkdirSync(NEW_SOFTWARE, { recursive: true });
  for (const [name, origin] of Object.entries(ORIGINS)) {
    const target = path.join(SOURCES, name);
    execFileSync('rsync', ['-a', '--delete', `${origin}/`, `${target}/`], { stdio: 'pipe' });
    const dirty = git(target, ['status', '--porcelain']);
    if (dirty) throw new Error(`${target} is not clean after copy: ${dirty.split('\n').length} entries`);
  }
  return { root: DEMO_ROOT, sources: Object.keys(ORIGINS).map((n) => path.join(SOURCES, n)), newSoftware: NEW_SOFTWARE, home: DEMO_HOME, revisions: Object.fromEntries(Object.keys(ORIGINS).map((n) => [n, git(path.join(SOURCES, n), ['rev-parse', '--short', 'HEAD'])])) };
}

export function remove() { fs.rmSync(DEMO_ROOT, { recursive: true, force: true }); fs.rmSync(DEMO_HOME, { recursive: true, force: true }); }

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--remove')) { remove(); console.log(`removed ${DEMO_ROOT} and ${DEMO_HOME}`); }
  else console.log(JSON.stringify(setup({ reset: process.argv.includes('--reset') }), null, 2));
}
