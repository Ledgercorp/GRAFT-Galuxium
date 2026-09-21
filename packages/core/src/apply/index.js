import fs from 'node:fs';
import path from 'node:path';
import { inspectRepo, createBranch, branchExists } from './git.js';
import { planEntrypointEdit } from '../emit/session-auth.js';
import { safeProjectPath } from '../util/paths.js';

/**
 * A refusal, not an exception. Callers render these to the user; every one of them
 * names what is wrong and what would make it safe.
 */
function refuse(code, message, remedy) {
  return { applied: false, refused: true, code, message, remedy };
}

/**
 * Preconditions that must hold before GRAFT writes into a project it does not own.
 * Pure inspection; safe to call to preview why an apply would be refused.
 */
export function checkPreconditions(plan, destRoot, opts = {}) {
  const { allowDirty = false, allowNoGit = false, allowNestedRepo = false } = opts;
  const repo = inspectRepo(destRoot);
  const problems = [];

  // Check the entire write set before changing branches or writing even one file.
  try {
    if (typeof plan.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(plan.id)) throw new Error('unsafe plan id');
    const paths = plan.files.map((f) => f.path);
    paths.push(plan.destination.entrypoint, `.graft/transplants/${plan.id}.json`);
    if (new Set(paths).size !== paths.length) throw new Error('duplicate output paths');
    for (const file of paths) safeProjectPath(destRoot, file);
  } catch (err) {
    return { ok: false, repo, problems: [refuse('unsafe-project-path', err.message, 'Use ordinary files and directories inside the destination, then re-plan.')] };
  }

  if (plan.status === 'blocked') {
    problems.push(refuse('plan-blocked',
      `The transplant plan is blocked by ${plan.compatibility.blocking.length} compatibility check(s): ${plan.compatibility.blocking.map((b) => b.title).join('; ')}.`,
      plan.compatibility.blocking.map((b) => b.remedy).filter(Boolean).join(' ') || 'Resolve the blocking checks and re-plan.'));
  }
  if (plan.status === 'needs-resolution') {
    problems.push(refuse('unresolved-conflicts',
      `The destination already answers ${plan.conflicts.routes.length} of the transplanted route(s): ${plan.compatibility.collisions.join(', ')}.`,
      'GRAFT will not silently overwrite existing behavior. Re-run with --resolve-conflicts to disable them in place (they are commented out, never deleted).'));
  }
  if (!repo.isRepo && !allowNoGit) {
    problems.push(refuse('not-a-git-repo',
      `${destRoot} is not inside a git repository, so GRAFT cannot guarantee the change is recoverable.`,
      'Run "git init && git add -A && git commit" in the destination first, or pass --allow-no-git to accept an unrecoverable write.'));
  }
  if (repo.isRepo && !repo.hasCommits && !allowNoGit) {
    problems.push(refuse('no-recovery-commit', 'The destination repository has no commit to recover from.',
      'Commit the destination before transplanting, or pass --allow-no-git to accept a write without a Git recovery point.'));
  }
  if (repo.isRepo && repo.isNestedProject && !allowNestedRepo) {
    problems.push(refuse('nested-in-outer-repo',
      `${destRoot} is not the root of its git repository (${repo.root} is). A branch created here would be a branch of the outer repository.`,
      'Transplant into a standalone repository, or pass --allow-nested-repo if you understand the branch will belong to the outer repo.'));
  }
  if (repo.isRepo && repo.dirty && !allowDirty) {
    problems.push(refuse('dirty-working-tree',
      `The destination has ${repo.dirtyFiles.length} uncommitted change(s); a transplant would be tangled up with work in progress.`,
      'Commit or stash the changes first, or pass --allow-dirty.'));
  }

  // Re-checked at apply time, not just at plan time: the filesystem may have moved on.
  const wouldOverwrite = plan.files.filter((f) => fs.existsSync(path.join(destRoot, f.path)));
  const receiptRelative = `.graft/transplants/${plan.id}.json`;
  if (fs.existsSync(path.join(destRoot, receiptRelative))) wouldOverwrite.push({ path: receiptRelative });
  if (wouldOverwrite.length) {
    problems.push(refuse('would-overwrite-files',
      `These files already exist and GRAFT does not overwrite files it did not write: ${wouldOverwrite.map((f) => f.path).join(', ')}.`,
      'Move them aside, or re-plan into a different directory with --dir.'));
  }

  const entryAbs = plan.destination.entrypoint ? path.join(destRoot, plan.destination.entrypoint) : null;
  if (!entryAbs || !fs.existsSync(entryAbs)) {
    problems.push(refuse('entrypoint-missing',
      `The entrypoint ${plan.destination.entrypoint ?? '(none found)'} does not exist, so routes cannot be registered.`,
      'Set "main" or a "start" script in the destination package.json.'));
  }

  return { ok: problems.length === 0, problems, repo };
}

/**
 * Performs the transplant.
 *
 * Order matters: every precondition is checked before the first byte is written, the
 * recovery point is recorded before anything changes, and the entrypoint edit is
 * computed in memory and only then written. Nothing here deletes a file, and nothing
 * overwrites a file GRAFT did not create in this run.
 */
export function applyTransplant(plan, destRoot, opts = {}) {
  const { dryRun = false, branch: branchOpt = null, createBranch: wantBranch = true } = opts;
  const abs = path.resolve(destRoot);

  const pre = checkPreconditions(plan, abs, opts);
  if (!pre.ok) return { applied: false, refused: true, problems: pre.problems, repo: pre.repo };

  const routesFile = plan.files.find((f) => f.path.endsWith('routes.js'));
  if (!routesFile) throw new Error('plan contains no routes module to register');
  const routesAbs = path.join(abs, routesFile.path);
  const entryAbs = path.join(abs, plan.destination.entrypoint);
  const entrySource = fs.readFileSync(entryAbs, 'utf8');

  let routesModule = path.relative(path.dirname(entryAbs), routesAbs).split(path.sep).join('/');
  if (!routesModule.startsWith('.')) routesModule = './' + routesModule;

  let edit;
  try {
    edit = planEntrypointEdit(entrySource, {
      routesModule,
      conflictingRoutes: plan.conflicts.routes,
      resolveConflicts: plan.conflicts.resolutionApproved,
      profile: plan.adaptation.profile,
      registration: plan.registration || undefined,
    });
  } catch (err) {
    if (err.code !== 'unsafe-manifest-value') throw err;
    return { applied: false, refused: true, repo: pre.repo,
      problems: [refuse('unsafe-manifest-value', err.message, 'This manifest cannot be transplanted safely. Re-harvest it from a source you trust.')] };
  }
  if (!edit.applied) {
    return {
      applied: false,
      refused: true,
      problems: [refuse(`entrypoint-${edit.reason}`,
        `GRAFT could not plan a safe edit to ${plan.destination.entrypoint}: ${edit.reason}.`,
        edit.reason === 'already-grafted'
          ? 'This capability is already registered in the entrypoint.'
          : 'Register the capability manually using the plan\'s agentBrief, then re-run verification.')],
      repo: pre.repo,
    };
  }

  const recovery = {
    branchBefore: pre.repo.branch,
    headBefore: pre.repo.head,
    entrypointBefore: entrySource,
    rollback: `Restore ${plan.destination.entrypoint} from recovery.entrypointBefore in the receipt, remove only the receipt's filesWritten, then return to the recorded branch or HEAD. Branch switching alone does not undo uncommitted files.`,
  };

  if (dryRun) {
    return { applied: false, dryRun: true, repo: pre.repo, recovery, branch: null,
      wouldWrite: plan.files.map((f) => f.path), entrypointEdits: edit.edits, removedRoutes: edit.removedRoutes || [] };
  }

  // Isolate the change so the user's existing branch is untouched.
  let branch = null;
  if (wantBranch && pre.repo.isRepo && pre.repo.hasCommits) {
    const desired = branchOpt || `graft/${plan.capability.slug}-${plan.id.slice(-8)}`;
    if (branchExists(abs, desired)) {
      return { applied: false, refused: true, repo: pre.repo,
        problems: [refuse('branch-exists', `Branch ${desired} already exists.`, 'Pass --branch <name> with a fresh name.')] };
    }
    branch = createBranch(abs, desired);
  }

  const written = [];
  let entryWritten = false;
  let receiptPath;
  let receiptCreated = false;
  try {
    for (const file of plan.files) {
      const target = safeProjectPath(abs, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, 'wx');
      // Track ownership before writing so a partial disk failure is recoverable too.
      written.push(file.path);
      try { fs.writeFileSync(fd, file.contents, 'utf8'); } finally { fs.closeSync(fd); }
    }

    safeProjectPath(abs, plan.destination.entrypoint);
    if (fs.readFileSync(entryAbs, 'utf8') !== entrySource) throw new Error('entrypoint changed during transplant; re-plan');
    entryWritten = true;
    fs.writeFileSync(entryAbs, edit.source, 'utf8');

    // The receipt is what makes a transplant auditable after the fact.
    const receiptDir = path.join(abs, '.graft', 'transplants');
    fs.mkdirSync(receiptDir, { recursive: true });
    const receipt = {
      planId: plan.id,
      appliedAt: new Date().toISOString(),
      capability: plan.capability,
      source: plan.source,
      branch,
      recovery,
      filesWritten: written,
      entrypoint: { file: plan.destination.entrypoint, edits: edit.edits, disabledRoutes: edit.removedRoutes || [] },
      acceptanceTests: plan.acceptanceTests.tests.map((t) => ({ id: t.id, required: t.required })),
      provenance: plan.agentBrief.provenance,
      ...(plan.capabilityContract ? { capabilityContract: plan.capabilityContract, compatibilityKnowledge: plan.compatibilityKnowledge } : {}),
      ...(plan.engine ? { engine: { engineVersion: plan.engine.engineVersion, genomeId: plan.engine.genome.genomeId, irId: plan.engine.ir.irId, specId: plan.adaptation.specId || null, recipeId: plan.engine.recipe?.recipeId || null, registration: plan.registration || null } } : {}),
      verification: 'not-yet-run',
    };
    receiptPath = safeProjectPath(abs, `.graft/transplants/${plan.id}.json`);
    const receiptFd = fs.openSync(receiptPath, 'wx', 0o600);
    receiptCreated = true;
    try { fs.writeFileSync(receiptFd, JSON.stringify(receipt, null, 2) + '\n', 'utf8'); } finally { fs.closeSync(receiptFd); }

    return { applied: true, repo: pre.repo, branch, recovery, filesWritten: written,
      entrypointEdits: edit.edits, removedRoutes: edit.removedRoutes || [], receiptPath, receipt };
  } catch (err) {
    // Undo only bytes created by this attempt. Never discard the user's other work.
    const failures = [];
    const undo = (fn) => { try { fn(); } catch (error) { failures.push(error.message); } };
    if (entryWritten) undo(() => fs.writeFileSync(safeProjectPath(abs, plan.destination.entrypoint), entrySource, 'utf8'));
    for (const file of written.reverse()) undo(() => fs.unlinkSync(safeProjectPath(abs, file)));
    if (receiptCreated) undo(() => fs.unlinkSync(safeProjectPath(abs, `.graft/transplants/${plan.id}.json`)));
    err.message = `Transplant write failed; ${failures.length ? `recovery is incomplete: ${failures.join('; ')}` : 'generated files removed and entrypoint restored'}. ${branch ? `The recovery branch ${branch} remains selected. ` : ''}${err.message}`;
    throw err;
  }
}

export { inspectRepo };
