import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Compare paths by their real location. On macOS /var is a symlink to /private/var; on
 * Windows git answers with forward slashes and long names while a temp path may carry an
 * 8.3 short name (RUNNER~1) and backslashes, and the filesystem is case-insensitive.
 * So both sides are resolved by the OS (realpathSync.native expands short names), put in
 * native separator form, and compared case-insensitively where the filesystem is.
 * Getting this wrong would refuse a perfectly safe transplant as "nested".
 */
export function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const canonical = (p) => (process.platform === 'win32' ? path.resolve(real(p)).toLowerCase() : real(p));
  return canonical(a) === canonical(b);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Read-only inspection of a destination repository.
 *
 * GRAFT modifies projects that belong to someone else. Before it writes anything it
 * has to be able to say exactly how the change can be undone. Everything here is a
 * read; nothing in this function can alter the repository.
 */
export function inspectRepo(root) {
  const abs = path.resolve(root);
  try {
    const top = git(abs, ['rev-parse', '--show-toplevel']);
    let branch;
    try { branch = git(abs, ['symbolic-ref', '--short', 'HEAD']); } catch { branch = 'HEAD'; }
    let head = null;
    try { head = git(abs, ['rev-parse', '--verify', 'HEAD']); } catch { head = null; } // repo with no commits yet
    // Scoped to the project directory: a nested project's dirtiness is its own, not the
    // outer repository's. For a root project this is the same as an unscoped status.
    const porcelain = git(abs, ['status', '--porcelain', '--', abs]);
    const dirtyFiles = porcelain ? porcelain.split('\n').map((l) => l.trim()) : [];
    return {
      isRepo: true,
      root: top,
      isNestedProject: !samePath(top, abs),
      branch,
      head,
      hasCommits: Boolean(head),
      dirty: dirtyFiles.length > 0,
      dirtyFiles,
    };
  } catch {
    return { isRepo: false, root: abs, isNestedProject: false, branch: null, head: null, hasCommits: false, dirty: false, dirtyFiles: [] };
  }
}

/**
 * The `origin` remote of a checkout as a repository identity, or null: not a git checkout, no
 * origin, or a local/file remote (a machine path is not a repository identity). Anything that can
 * carry a credential is removed and nothing else is normalised: the URL userinfo (`user:token@`),
 * and a query string or fragment (`?token=…`, `#…`), which are never part of a repository's
 * identity. scp-style SSH remotes (`git@host:owner/repo.git`) have neither and pass unchanged.
 */
export function remoteOf(root) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
    return sanitiseRemote(url);
  } catch { return null; }
}
export function sanitiseRemote(url) {
  if (typeof url !== 'string' || !/^(https?:\/\/|git@|ssh:\/\/)/.test(url) || url.startsWith('file:')) return null;
  const identity = url.replace(/[?#].*$/, '').replace(/\/\/[^@/]+@/, '//');
  return identity || null;
}

export function createBranch(root, name) {
  git(root, ['checkout', '-b', name]);
  return name;
}

export function branchExists(root, name) {
  try { git(root, ['rev-parse', '--verify', `refs/heads/${name}`]); return true; }
  catch { return false; }
}
