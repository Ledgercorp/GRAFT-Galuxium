// Product-managed transplant worktrees.
//
// The one Terminal step left in the first real transplant was creating the destination's
// isolated worktree. This module lets GRAFT do that itself, and never lets the workflow touch
// the user's primary checkout: every transplant runs in a dedicated git worktree beneath
// GRAFT_HOME on a uniquely named local branch, recorded so it can be found again after a
// restart, and removed only when the user explicitly asks.
//
// Lifecycle state here is descriptive. It records what happened; it can never manufacture a
// verification verdict — the verdict is copied from the verifier's report, or absent.
//
// Every git invocation is argument-vector only (no shell), paths are resolved through
// realpath before comparison, branch names are validated against a strict grammar, and the
// registry is updated under a lock so two operations cannot race on the same repository.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { graftHome } from '../registry/index.js';
import { inspectRepo, samePath } from './git.js';
import { repositoryIdentity } from '../workspace/identity.js';

export const TRANSPLANT_STATES = Object.freeze(['PREPARING', 'READY', 'APPLIED', 'VERIFIED', 'FAILED', 'INCONCLUSIVE', 'STALE', 'CLEANED']);
export const worktreesDir = () => path.join(graftHome(), 'worktrees');
export const transplantsPath = () => path.join(graftHome(), 'transplants.json');

const BRANCH = /^graft\/[a-z0-9][a-z0-9-]{0,48}-[0-9a-f]{8}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function git(cwd, args, { timeout = 20000 } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();
}
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });

// ---------------------------------------------------------------------------------------------
// Registry: one JSON document, atomic replace, lock-protected updates.
// ---------------------------------------------------------------------------------------------
const EMPTY = { version: 1, transplants: [] };

export function loadTransplants({ file = transplantsPath() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.transplants)) throw new Error('invalid structure');
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY, transplants: [] };
    throw fail('registry-unreadable', `The transplant registry at ${file} is unreadable (${err.message}). It records worktrees GRAFT created; repair or move it aside before continuing.`);
  }
}

function saveTransplants(registry, { file = transplantsPath() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.transplants-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function withLock(update, { file = transplantsPath() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') throw fail('transplant-busy', 'Another transplant operation is in progress. Wait for it to finish; remove the stale lock only after confirming nothing is running.', lock);
    throw err;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    const registry = loadTransplants({ file });
    const result = update(registry);
    saveTransplants(registry, { file });
    return result;
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}

// ---------------------------------------------------------------------------------------------
// Preparation.
// ---------------------------------------------------------------------------------------------

/**
 * Prepare an isolated transplant for `destinationRoot`.
 *
 * Refuses: a destination that is not a git repository or has no commit; a destination that is
 * the source (by realpath or by repository identity); a destination that is itself one of
 * GRAFT's worktrees; a path under GRAFT_HOME; a branch or worktree that already exists; a
 * dirty destination unless `allowDirty` (the worktree is cut from HEAD, so uncommitted work is
 * never included — but the user should know).
 */
/**
 * `fromRevision` (Laboratory 0.4a): cut the worktree from a specific commit in this repository
 * rather than the checkout's HEAD, so a composition can continue from the revision it has already
 * verified. It must be an existing commit here; the checkout itself is never moved.
 */
export function prepareTransplant({ destinationRoot, sourceRoot = null, capabilitySlug, capabilities = null, allowDirty = false, fromRevision = null, file = transplantsPath(), now = () => new Date().toISOString() }) {
  // A composition candidate carries several capabilities in one worktree; `capabilities` names them
  // all, and `capabilitySlug` then names the composition (it is the branch and folder name).
  if (capabilities !== null && (!Array.isArray(capabilities) || !capabilities.length || capabilities.some((c) => typeof c !== 'string' || !SLUG.test(c)))) throw fail('invalid-capabilities', 'Capabilities must be a non-empty list of short lowercase slugs.');
  if (typeof capabilitySlug !== 'string' || !SLUG.test(capabilitySlug) || capabilitySlug.length > 40) throw fail('invalid-slug', 'Capability slug must be a short lowercase slug.');
  const destination = resolveRoot(destinationRoot, 'destination');
  const home = fs.realpathSync(ensureDir(graftHome()));
  if (destination === home || destination.startsWith(home + path.sep)) throw fail('destination-inside-graft-home', 'The destination cannot be a folder GRAFT manages. Choose your own project checkout; GRAFT will create the worktree.');
  const repo = inspectRepo(destination);
  if (!repo.isRepo) throw fail('destination-not-a-repository', 'The destination is not a Git repository, so an isolated worktree cannot be created.', 'Initialise Git and commit the project first.');
  if (!repo.hasCommits) throw fail('destination-has-no-commits', 'The destination repository has no commit to branch from.', 'Commit the project first.');
  if (repo.isNestedProject) throw fail('destination-is-nested', 'The destination is a folder inside a larger repository; GRAFT creates worktrees only for a repository root.');
  if (repo.dirty && !allowDirty) throw fail('destination-dirty', `The destination has ${repo.dirtyFiles.length} uncommitted change(s). The worktree would be cut from the last commit, so that work would not be part of the transplant.`, 'Commit or stash first, or confirm that the transplant should ignore the uncommitted work.');
  let base = repo.head;
  if (fromRevision !== null) {
    if (typeof fromRevision !== 'string' || !/^[0-9a-f]{7,40}$/.test(fromRevision)) throw fail('invalid-from-revision', 'The revision to branch from must be a commit id.');
    let resolved; try { resolved = git(destination, ['rev-parse', '--verify', '--quiet', `${fromRevision}^{commit}`]); } catch { resolved = ''; }
    if (!resolved) throw fail('unknown-from-revision', `Commit ${fromRevision.slice(0, 12)} is not in this repository.`);
    base = resolved;
  }
  const identity = repositoryIdentity(destination);
  if (sourceRoot) {
    const source = resolveRoot(sourceRoot, 'source');
    if (samePath(source, destination)) throw fail('source-is-destination', 'The source checkout cannot also be the destination.');
    const sourceIdentity = repositoryIdentity(source);
    if (sourceIdentity.isGit && identity.isGit && sourceIdentity.repositoryId === identity.repositoryId) throw fail('source-repository-is-destination', 'The destination is another checkout of the source repository. GRAFT will not transplant a capability into the repository it came from.');
  }
  const registry = loadTransplants({ file });
  if (registry.transplants.some((t) => t.state !== 'CLEANED' && t.destination.repositoryId === identity.repositoryId && t.destination.root !== destination && samePath(t.worktree.path, destination))) throw fail('destination-is-graft-worktree', 'The destination is itself a GRAFT transplant worktree. Choose the project\'s own checkout.');

  const id = crypto.randomBytes(4).toString('hex');
  const branch = `graft/${capabilitySlug}-${id}`;
  if (!BRANCH.test(branch)) throw fail('invalid-branch', 'Could not derive a safe branch name.');
  const worktreePath = path.join(ensureDir(worktreesDir()), `${safeName(identity.name)}-${capabilitySlug}-${id}`);
  if (fs.existsSync(worktreePath)) throw fail('worktree-collision', `A worktree already exists at ${worktreePath}.`);
  try { git(destination, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); throw fail('branch-collision', `Branch ${branch} already exists in the destination.`); } catch (err) { if (err.code === 'branch-collision') throw err; /* absent: good */ }

  const record = withLock((reg) => {
    if (reg.transplants.some((t) => t.state === 'PREPARING' && t.destination.repositoryId === identity.repositoryId)) throw fail('transplant-in-progress', 'Another transplant is being prepared for this repository.');
    const entry = {
      id, state: 'PREPARING', createdAt: now(), updatedAt: now(), capabilitySlug, capabilities: capabilities || [capabilitySlug],
      source: sourceRoot ? { root: fs.realpathSync(sourceRoot), repositoryId: repositoryIdentity(fs.realpathSync(sourceRoot)).repositoryId } : null,
      destination: { root: destination, repositoryId: identity.repositoryId, name: identity.name, branchBefore: repo.branch, dirtyAtPreparation: repo.dirty, dirtyFilesAtPreparation: repo.dirtyFiles.length },
      baseHead: base, worktree: { path: worktreePath, branch }, plan: null, receipt: null, verdict: null, history: [{ at: now(), state: 'PREPARING' }],
    };
    reg.transplants.push(entry);
    return entry;
  }, { file });

  try {
    // `--` terminates options; the path and commit are data. Branch is created from the exact
    // HEAD recorded above, so the base cannot drift between the check and the checkout.
    git(destination, ['worktree', 'add', '--quiet', '-b', branch, '--', worktreePath, base]);
    const created = inspectRepo(worktreePath);
    if (created.head !== base) throw fail('worktree-head-mismatch', 'The new worktree is not at the recorded base commit.');
    // Installed dependencies are not part of the commit. When the checkout has an ignored
    // node_modules and the worktree has none, link it so the worktree can boot; the link is
    // read-through, never a copy, and git sees nothing new because the path is ignored.
    linkIgnoredDependencies(destination, worktreePath);
  } catch (err) {
    withLock((reg) => { const t = reg.transplants.find((x) => x.id === id); if (t) { t.state = 'FAILED'; t.error = err.message; t.updatedAt = now(); t.history.push({ at: now(), state: 'FAILED', reason: err.message }); } }, { file });
    try { git(destination, ['worktree', 'remove', '--force', '--', worktreePath]); } catch { /* nothing to remove */ }
    try { git(destination, ['branch', '-D', '--', branch]); } catch { /* nothing to delete */ }
    throw err;
  }
  return transition(id, 'READY', { file, now });
}

/** Move a transplant to a new state, attaching descriptive facts. Verdicts are copied, never invented. */
export function transition(id, state, { file = transplantsPath(), now = () => new Date().toISOString(), plan = null, receipt = null, verdict = null, reason = null } = {}) {
  if (!TRANSPLANT_STATES.includes(state)) throw fail('invalid-state', `Unknown transplant state ${state}.`);
  return withLock((reg) => {
    const t = reg.transplants.find((x) => x.id === id);
    if (!t) throw fail('unknown-transplant', `Unknown transplant ${id}.`);
    t.state = state; t.updatedAt = now();
    if (plan) t.plan = plan;
    if (receipt) t.receipt = receipt;
    if (verdict) t.verdict = verdict;
    t.history.push({ at: now(), state, ...(reason ? { reason } : {}), ...(verdict ? { verdict: verdict.verdict } : {}) });
    return structuredClone(t);
  }, { file });
}

/** The state a verification report implies: copied from the verifier, never decided here. */
export function stateForVerdict(verdict) {
  return verdict === 'VERIFIED' ? 'VERIFIED' : verdict === 'FAILED' ? 'FAILED' : 'INCONCLUSIVE';
}

// ---------------------------------------------------------------------------------------------
// Recovery, staleness, cleanup.
// ---------------------------------------------------------------------------------------------

/** Refresh each record against reality: worktree present, base still the recorded commit. */
export function listTransplants({ file = transplantsPath(), now = () => new Date().toISOString() } = {}) {
  const registry = loadTransplants({ file });
  let changed = false;
  for (const t of registry.transplants) {
    if (t.state === 'CLEANED') continue;
    const present = fs.existsSync(t.worktree.path) && fs.existsSync(path.join(t.worktree.path, '.git'));
    let head = null, dirty = null;
    if (present) { const repo = inspectRepo(t.worktree.path); head = repo.head; dirty = repo.dirty; }
    t.live = { present, head, dirty, checkedAt: now() };
    if (!present && t.state !== 'STALE') { t.state = 'STALE'; t.history.push({ at: now(), state: 'STALE', reason: 'worktree missing' }); changed = true; }
    else if (present && head && head !== t.baseHead && !['APPLIED', 'VERIFIED', 'FAILED', 'INCONCLUSIVE'].includes(t.state) && t.state !== 'STALE') { t.state = 'STALE'; t.history.push({ at: now(), state: 'STALE', reason: 'worktree head moved before apply' }); changed = true; }
  }
  if (changed) saveTransplants(registry, { file });
  return registry.transplants.map((t) => structuredClone(t));
}

export function getTransplant(id, { file = transplantsPath() } = {}) {
  const t = listTransplants({ file }).find((x) => x.id === id);
  if (!t) throw fail('unknown-transplant', `Unknown transplant ${id}.`);
  return t;
}

/** Guard before apply: the worktree exists and is still at the base the plan was built for. */
export function assertApplyable(id, { file = transplantsPath() } = {}) {
  const t = getTransplant(id, { file });
  if (t.state !== 'READY') throw fail('transplant-not-ready', `Transplant ${id} is ${t.state}, not READY.`);
  if (!t.live.present) throw fail('worktree-missing', `The worktree ${t.worktree.path} no longer exists.`);
  if (t.live.head !== t.baseHead) throw fail('worktree-head-drift', `The worktree moved from ${t.baseHead.slice(0, 12)} to ${String(t.live.head).slice(0, 12)} since it was prepared. Prepare a fresh transplant.`);
  if (t.live.dirty) throw fail('worktree-dirty', 'The worktree has uncommitted changes that GRAFT did not make. Prepare a fresh transplant.');
  return t;
}

/** What the transplant changed in its worktree: files from the receipt, plus a bounded diff of the edited entrypoint. */
export function changedFiles(id, { file = transplantsPath(), maxDiffBytes = 64 * 1024 } = {}) {
  const t = getTransplant(id, { file });
  if (!t.live.present) return { created: [], modified: [], diff: null, note: 'worktree missing' };
  const created = t.receipt?.filesWritten || [];
  const modified = t.receipt?.entrypoint?.file ? [t.receipt.entrypoint.file] : [];
  let diff = null;
  if (modified.length) {
    try { diff = git(t.worktree.path, ['diff', '--no-color', '--', ...modified]); if (diff.length > maxDiffBytes) diff = `${diff.slice(0, maxDiffBytes)}\n… (truncated)`; } catch { diff = null; }
  }
  const status = (() => { try { return git(t.worktree.path, ['status', '--porcelain']).split('\n').filter(Boolean); } catch { return []; } })();
  return { created, modified, diff, status, worktree: t.worktree.path, branch: t.worktree.branch };
}

/**
 * Remove a worktree and its branch. A worktree with changes is refused unless the caller
 * explicitly confirms; a CLEANED record stays in the registry as history.
 */
export function cleanupTransplant(id, { confirmDiscard = false, file = transplantsPath(), now = () => new Date().toISOString() } = {}) {
  const t = getTransplant(id, { file });
  if (t.state === 'CLEANED') return t;
  const destination = t.destination.root;
  const branches = new Set([t.worktree.branch]);
  if (t.live.present) {
    const repo = inspectRepo(t.worktree.path);
    if (repo.dirty && !confirmDiscard) throw fail('worktree-has-changes', `The worktree has ${repo.dirtyFiles.length} changed file(s)${t.state === 'VERIFIED' ? ' (the verified transplant)' : ''}. Cleaning it up discards them.`, 'Confirm that the changes may be discarded, or keep the worktree.');
    // Whatever graft/ branch the worktree ended up on belongs to this transplant too.
    if (repo.branch && BRANCH.test(repo.branch)) branches.add(repo.branch);
    git(destination, ['worktree', 'remove', '--force', '--', t.worktree.path]);
  } else {
    try { git(destination, ['worktree', 'prune']); } catch { /* best effort */ }
  }
  for (const branch of branches) { try { git(destination, ['branch', '-D', '--', branch]); } catch { /* already gone */ } }
  return transition(id, 'CLEANED', { file, now, reason: confirmDiscard ? 'user confirmed discarding changes' : 'worktree removed' });
}

// ---------------------------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------------------------
function linkIgnoredDependencies(destination, worktreePath) {
  const source = path.join(destination, 'node_modules');
  const target = path.join(worktreePath, 'node_modules');
  try {
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory() || fs.existsSync(target)) return;
    // Only an ignored folder is linked: a tracked node_modules is part of the commit already.
    execFileSync('git', ['check-ignore', '-q', '--', 'node_modules'], { cwd: destination, stdio: 'ignore', timeout: 10000 });
    fs.symlinkSync(source, target, 'dir');
  } catch { /* not ignored, or cannot link: the worktree boots without dependencies and verification will say so */ }
}
function resolveRoot(value, label) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) throw fail(`invalid-${label}`, `The ${label} must be an absolute folder path.`);
  let real;
  try { real = fs.realpathSync(value); } catch { throw fail(`${label}-missing`, `The ${label} folder does not exist.`); }
  if (!fs.statSync(real).isDirectory()) throw fail(`${label}-not-a-folder`, `The ${label} is not a folder.`);
  return real;
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
function safeName(name) { return String(name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'; }
