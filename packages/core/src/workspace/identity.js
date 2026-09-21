// Repository, worktree and project identity for the Workspace Capability Index.
//
// Phase 1 dogfood found a real repository with 31 additional worktrees living outside the
// workspace directory, each on a different branch. A directory walk alone would both miss
// them and count one repository many times. Identity is therefore resolved through git's
// common directory: every worktree of one repository shares it, so it — not the checkout
// path — is what a repository id is derived from.
//
// Everything here is read-only. No git command run by this module can alter a repository:
// only rev-parse, symbolic-ref, status --porcelain, remote get-url and worktree list.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const sha = (value) => 'sha256:' + crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const shortId = (value) => sha(value).slice(7, 31);

/** Read-only git. Returns null instead of throwing: absence is data, not an error. */
export function git(root, args, { timeout = 10000 } = {}) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout }).trim(); }
  catch { return null; }
}

/** A remote URL with any embedded credentials removed. Host and path only. */
export function safeRemote(remote) {
  if (!remote) return null;
  try { const u = new URL(remote); u.username = ''; u.password = ''; return u.toString(); }
  catch { return remote.replace(/^ssh:\/\//, '').replace(/^[^@/]+@/, ''); }
}

/**
 * Identity of the repository a directory belongs to, or a non-git identity for a plain
 * directory. `repositoryId` is stable across every worktree of the same repository.
 */
export function repositoryIdentity(dir) {
  const abs = path.resolve(dir);
  const common = git(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) {
    return { repositoryId: `dir:${shortId(abs)}`, kind: 'directory', isGit: false, commonDir: null, root: abs,
      name: path.basename(abs), branch: null, head: null, remote: null, dirty: null, dirtyFiles: 0, isWorktree: false, worktrees: [] };
  }
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const commonDir = real(common);
  // The primary checkout is the parent of a plain .git directory; a linked worktree's
  // common dir still points at it, which is exactly what makes the id shared.
  const primary = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  const top = git(abs, ['rev-parse', '--show-toplevel']);
  const status = git(abs, ['status', '--porcelain']);
  return {
    repositoryId: `git:${shortId(commonDir)}`,
    kind: 'git',
    isGit: true,
    commonDir,
    root: top ? real(top) : abs,
    primaryRoot: real(primary),
    name: path.basename(real(primary)),
    branch: git(abs, ['symbolic-ref', '--short', 'HEAD']) || (git(abs, ['rev-parse', '--verify', 'HEAD']) ? 'detached' : null),
    head: git(abs, ['rev-parse', '--verify', 'HEAD']),
    remote: safeRemote(git(abs, ['remote', 'get-url', 'origin'])),
    dirty: status === null ? null : status.length > 0,
    dirtyFiles: status ? status.split('\n').filter(Boolean).length : 0,
    isWorktree: top ? real(top) !== real(primary) : false,
    worktrees: worktreesOf(abs),
  };
}

/** Every checkout of this repository: path, branch and head. Paths outside the scanned root included. */
export function worktreesOf(dir) {
  const listing = git(dir, ['worktree', 'list', '--porcelain']);
  if (!listing) return [];
  const out = [];
  let current = null;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9), head: null, branch: null, detached: false, prunable: false }; out.push(current); }
    else if (!current) continue;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  return out;
}

/**
 * Logical project id: stable for a project within a repository, derived from the repository
 * identity and the project's path relative to the checkout — so the same subproject in two
 * worktrees of one repository is recognisably the same logical project.
 */
export function projectId(repository, relativeRoot) {
  return `${repository.repositoryId}#${relativeRoot === '.' || !relativeRoot ? 'root' : shortId(relativeRoot).slice(0, 12)}`;
}

/** Project path relative to its repository checkout, POSIX form; '.' for the repository root. */
export function relativeRoot(repository, root) {
  if (!repository.isGit) return '.';
  const rel = path.relative(repository.root, path.resolve(root));
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}
