// Workspace Capability Index — scanning and project modelling.
//
// Answers "what have I already built, where is it, and what kind is it?" over explicitly
// authorized roots only. It never walks the filesystem at large, never executes project
// code, and never stores source text or environment values.
//
// Discovery and transplantability are separate: this module is allowed to recognise shapes
// GRAFT cannot transplant, and must say so rather than quietly widen support.
import fs from 'node:fs';
import path from 'node:path';
import { repositoryIdentity, projectId as makeProjectId, relativeRoot, sha } from './identity.js';
import { detectProject, looksLikeProject, IGNORED_DIRS } from './detect.js';
import { NON_PRODUCTION_PATH } from '../analyze/production-paths.js';

/**
 * A project whose own root lives beneath a tests/fixtures/bench/coverage folder of its
 * repository (or of the workspace root, outside git) is a fixture of that repository, not a
 * project a person would transplant into. The rule is the shared production-path policy applied
 * to the project's *root*, so a real project that merely contains a tests/ folder is unaffected,
 * and monorepo apps/packages are unaffected.
 */
export function isFixtureProjectRoot(projectRoot, containerRoot) {
  const relative = path.relative(path.resolve(containerRoot), path.resolve(projectRoot)).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) return false;
  return NON_PRODUCTION_PATH.test(`${relative}/`);
}
import { observeCapabilities } from './capabilities.js';
import { loadIndex, saveIndex, addRoot, removeRoot, indexPath, INDEX_VERSION } from './store.js';

export { loadIndex, saveIndex, addRoot, removeRoot, indexPath, INDEX_VERSION };
export * from './identity.js';
export { detectProject, listFiles, extractRouteSignals, detectLanguage, detectBuildLayout, sourceForRuntimePath, scriptEntrypoints } from './detect.js';
export { observeCapabilities, CAPABILITY_STATES, AUTH_SUBTYPES, TRANSPLANT_SUPPORT, OBSERVATION_VERSION } from './capabilities.js';
export { searchCapabilities, parseQuery, getCapability, indexSummary } from './search.js';
export { discoverCapabilityCandidates, DISCOVERY_VERSION } from './discover.js';

/** Directories that are project candidates beneath a workspace root. Bounded and evidence-based. */
export function findProjectDirectories(workspaceRoot, { maxDepth = 3 } = {}) {
  const found = [];
  const stack = [{ dir: path.resolve(workspaceRoot), depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    const isGit = fs.existsSync(path.join(dir, '.git'));
    const hasManifest = looksLikeProject(dir);
    if (depth > 0 && (isGit || hasManifest)) found.push({ dir, isGit, hasManifest });
    // Keep descending: a workspace root may hold plain folders that contain repositories.
    if (depth >= maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Subprojects of a repository, from declared evidence only: npm/yarn workspace globs, and
 * conventional app/package directories that actually carry their own manifest. Boundaries
 * are never invented where nothing declares them.
 */
export function findSubprojects(root) {
  const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; } })();
  const globs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages || [];
  const out = new Map();
  const consider = (relative, reason) => {
    const dir = path.join(root, relative);
    if (dir === root || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory() || !looksLikeProject(dir)) return;
    if (!out.has(dir)) out.set(dir, { dir, reason });
  };
  for (const glob of globs) {
    if (typeof glob !== 'string') continue;
    if (glob.endsWith('/*')) {
      const parent = path.join(root, glob.slice(0, -2));
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) consider(path.join(glob.slice(0, -2), entry.name), `declared by package.json workspaces "${glob}"`);
      }
    } else consider(glob, `declared by package.json workspaces "${glob}"`);
  }
  // Conventional layout, but only where a manifest is actually present.
  for (const parent of ['apps', 'packages', 'services']) {
    const dir = path.join(root, parent);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) consider(path.join(parent, entry.name), `manifest under conventional ${parent}/ directory`);
    }
  }
  return [...out.values()];
}

/** Cheap change signal: if this is unchanged, the project's entry can be reused. */
export function invalidationFingerprint(root, repository) {
  const stamps = [];
  for (const file of ['package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', '.']) {
    try { const s = fs.statSync(path.join(root, file)); stamps.push(`${file}:${Math.floor(s.mtimeMs)}:${s.size}`); }
    catch { stamps.push(`${file}:absent`); }
  }
  return sha({ head: repository.head, dirty: repository.dirty, branch: repository.branch, stamps });
}

/** Index one project directory: structure, capabilities and the evidence for both. */
export function indexProject(root, { workspaceRoot = null, repository = null, subprojectOf = null, reason = null, maxFiles = 4000 } = {}) {
  const abs = path.resolve(root);
  const repo = repository || repositoryIdentity(abs);
  const relative = relativeRoot(repo, abs);
  const id = makeProjectId(repo, relative);
  const started = process.hrtime.bigint();
  const project = detectProject(abs, { maxFiles });
  const capabilities = observeCapabilities(project, { projectId: id, repositoryRoot: repo.primaryRoot || repo.root });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const { files, read, ...structure } = project;
  return {
    projectId: id,
    repositoryId: repo.repositoryId,
    workspaceRoot,
    root: abs,
    relativeRoot: relative,
    subprojectOf,
    boundaryReason: reason || (relative === '.' ? 'repository root' : 'subproject'),
    repository: {
      kind: repo.kind, isGit: repo.isGit, name: repo.name, primaryRoot: repo.primaryRoot || repo.root,
      branch: repo.branch, head: repo.head, remote: repo.remote, dirty: repo.dirty, dirtyFiles: repo.dirtyFiles,
      isWorktree: repo.isWorktree,
      worktrees: (repo.worktrees || []).map((w) => ({ path: w.path, branch: w.branch, head: w.head, detached: w.detached })),
    },
    ...structure,
    capabilities,
    fileCount: project.fileCount,
    indexedAt: new Date().toISOString(),
    indexElapsedMs: Math.round(elapsedMs * 100) / 100,
    invalidation: invalidationFingerprint(abs, repo),
  };
}

/**
 * Scan one authorized workspace root. Repositories are identified through git's common
 * directory, so every worktree of a repository resolves to one repositoryId and alternate
 * checkouts are recorded rather than counted as separate repositories.
 */
export function scanWorkspaceRoot(workspaceRoot, { maxFiles = 4000, previous = [], force = false, onProgress = null } = {}) {
  const abs = path.resolve(workspaceRoot);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Workspace root not found: ${abs}`);
  const directories = findProjectDirectories(abs);
  const byRoot = new Map(previous.map((p) => [p.root, p]));
  const projects = [];
  const seen = new Set();
  let reused = 0;

  for (const { dir } of directories) {
    if (seen.has(dir)) continue;
    const repository = repositoryIdentity(dir);
    // A linked worktree of a repository already indexed from its primary checkout is
    // recorded on that repository, not indexed again as a separate project.
    const targets = [{ dir, subprojectOf: null, reason: repository.isGit ? 'git repository root' : 'directory with a manifest' }];
    for (const sub of findSubprojects(dir)) targets.push({ dir: sub.dir, subprojectOf: null, reason: sub.reason });

    for (const target of targets) {
      if (seen.has(target.dir)) continue;
      seen.add(target.dir);
      const existing = byRoot.get(target.dir);
      if (!force && existing && existing.invalidation === invalidationFingerprint(target.dir, repository)) { projects.push({ ...existing, reusedAt: new Date().toISOString() }); reused += 1; onProgress?.({ root: target.dir, reused: true }); continue; }
      try {
        const indexed = indexProject(target.dir, { workspaceRoot: abs, repository: target.dir === dir ? repository : repositoryIdentity(target.dir), subprojectOf: target.dir === dir ? null : makeProjectId(repository, relativeRoot(repository, dir)), reason: target.reason, maxFiles });
        // Fixture projects stay in the index (they explain what was scanned) but are marked, so
        // ordinary discovery and destination lists leave them out unless a caller opts in.
        const container = repository.isGit && repository.root ? repository.root : abs;
        if (isFixtureProjectRoot(target.dir, container) || isFixtureProjectRoot(target.dir, abs)) indexed.nonProduction = true;
        projects.push(indexed);
        onProgress?.({ root: target.dir, reused: false, capabilities: indexed.capabilities.length });
      } catch (err) {
        projects.push({ projectId: `error:${sha(target.dir).slice(7, 19)}`, root: target.dir, workspaceRoot: abs, error: err.message, indexedAt: new Date().toISOString(), capabilities: [] });
      }
    }
  }
  // Subprojects annotate their parent rather than duplicating it.
  for (const project of projects) {
    if (!project.subprojectOf) project.subprojects = projects.filter((p) => p.subprojectOf === project.projectId).map((p) => p.projectId);
  }
  return { workspaceRoot: abs, projects, scanned: projects.length - reused, reused };
}

/** Full (or incremental) index of every authorized root, persisted atomically. */
export function buildIndex({ file = indexPath(), force = false, maxFiles = 4000, onProgress = null } = {}) {
  const index = loadIndex({ file });
  if (!index.roots.length) throw new Error('No workspace roots are authorized yet. Add one first (for example ~/Developer).');
  const started = process.hrtime.bigint();
  const projects = [];
  const perRoot = [];
  for (const root of index.roots) {
    const previous = index.projects.filter((p) => p.workspaceRoot === root.path);
    const rootStarted = process.hrtime.bigint();
    const result = scanWorkspaceRoot(root.path, { maxFiles, previous, force, onProgress });
    perRoot.push({ root: root.path, projects: result.projects.length, scanned: result.scanned, reused: result.reused,
      elapsedMs: Math.round(Number(process.hrtime.bigint() - rootStarted) / 1e4) / 100 });
    projects.push(...result.projects);
  }
  const elapsedMs = Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
  const saved = saveIndex({ ...index, projects }, { file });
  return { ...saved, projects: projects.length, roots: perRoot, elapsedMs,
    capabilities: projects.reduce((sum, p) => sum + (p.capabilities?.length || 0), 0),
    repositories: new Set(projects.map((p) => p.repositoryId)).size };
}

/** Re-index a single project in place, leaving the rest of the index untouched. */
export function refreshProject(projectIdValue, { file = indexPath(), maxFiles = 4000 } = {}) {
  const index = loadIndex({ file });
  const existing = index.projects.find((p) => p.projectId === projectIdValue);
  if (!existing) throw new Error(`Unknown project ${projectIdValue}. Rebuild the index or add its workspace root.`);
  const started = process.hrtime.bigint();
  const updated = indexProject(existing.root, { workspaceRoot: existing.workspaceRoot, subprojectOf: existing.subprojectOf, reason: existing.boundaryReason, maxFiles });
  index.projects = index.projects.map((p) => (p.projectId === projectIdValue ? { ...updated, subprojects: p.subprojects } : p));
  saveIndex(index, { file });
  return { project: updated, elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100 };
}

/** Projects whose invalidation fingerprint no longer matches what was indexed. */
export function staleProjects({ file = indexPath() } = {}) {
  return loadIndex({ file }).projects.filter((p) => {
    if (p.error || !p.root) return true;
    try { return p.invalidation !== invalidationFingerprint(p.root, repositoryIdentity(p.root)); }
    catch { return true; }
  }).map((p) => ({ projectId: p.projectId, root: p.root, name: p.name }));
}
