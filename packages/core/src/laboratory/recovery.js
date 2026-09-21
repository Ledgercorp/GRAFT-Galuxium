// Commercial Beta Readiness 0.1, Checkpoint A — customer recovery for assemblies.
//
// An assembly execution is an immutable record: it runs once, concludes in a terminal state, and is
// never rewritten. Recovery therefore never "continues" an execution. It offers exactly two safe
// moves, both from existing semantics:
//
//   Retry    a NEW execution of the same plan (the plan is immutable; eligibility is re-checked at
//            start as always), into the same folder under a name that is free — the failed run's
//            created project folder is left where it is, untouched, so the customer loses nothing.
//   Discard  close the failed workflow: remove GRAFT's own candidate worktree and graft/ branch for
//            the failed run (the existing `cleanupTransplant` semantics — never the customer's
//            repository, never the donor, never the ledger, never a proof) and note the discard on
//            the execution record as history. The record keeps its status; nothing pretends.
//
// An execution that is not in a terminal state and is not running in this process did not finish
// (the app quit, crashed or lost power mid-run). That is reported as "did not finish", not as
// FAILED: the state is uncertain, and it stays uncertain on the record; recovery is the same pair.
//
// Wording here is for the customer. Every mapped case is one that the product actually produces;
// anything else is "Something unexpected happened" with the technical detail kept, not hidden.
import fs from 'node:fs';
import path from 'node:path';
import { TERMINAL_STATES, executionsDir, normaliseHostName } from './execution.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------------------------
// Execution locks: one per plan, a `wx` file holding the pid. A lock whose process is gone is a
// leftover of a run that did not finish; it must not trap the plan forever.
// ---------------------------------------------------------------------------------------------
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
export function inspectExecutionLock(planId, { isAlive = pidAlive } = {}) {
  const file = path.join(executionsDir(), `.lock-${planId}`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return { held: false, stale: false, pid: null, file }; throw err; }
  let parsed = null; try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const pid = parsed?.pid ?? null;
  return { held: true, stale: !isAlive(pid), pid, at: parsed?.at || null, file };
}
/** Release a lock only when the process that took it is gone. A live lock is left alone. */
export function releaseStaleExecutionLock(planId, options) {
  const lock = inspectExecutionLock(planId, options);
  if (!lock.held) return { released: false, reason: 'not-held' };
  if (!lock.stale) return { released: false, reason: 'held-by-live-process', pid: lock.pid };
  fs.rmSync(lock.file, { force: true });
  return { released: true, reason: 'stale', pid: lock.pid };
}

// ---------------------------------------------------------------------------------------------
// Customer wording for the failures the beta scope actually produces.
// ---------------------------------------------------------------------------------------------
const KNOWN = [
  [/target-exists/, (e) => ({ kind: 'name-taken', title: 'That application name is already taken in the chosen folder.', next: 'Retry with a different name, or choose another folder.' })],
  [/execution-locked/, () => ({ kind: 'busy', title: 'This plan is already being assembled.', next: 'Wait for the running assembly to finish, or discard the one that did not finish.' })],
  [/worktree-has-changes/, () => ({ kind: 'candidate-changed', title: 'The assembly workspace has changes GRAFT did not make.', next: 'Discard them explicitly if you do not need them.' })],
  [/^(verdict|inconclusive)$/, (e) => (e.status === 'INCONCLUSIVE' || e.code === 'inconclusive'
    ? { kind: 'inconclusive', title: 'Verification could not reach a conclusion.', next: 'Nothing was recorded. Retry; if it happens again, save a diagnostic bundle.' }
    : { kind: 'failed-verification', title: 'Verification failed.', next: 'The capability did not behave as its contract requires in this application. Nothing was recorded as current.' })],
  [/host-preservation/, () => ({ kind: 'host-changed', title: 'The application stopped behaving as it did before.', next: 'Nothing was recorded as current. Retry, or save a diagnostic bundle.' })],
  [/candidate-moved|final-verification|not-verified/, () => ({ kind: 'not-verified', title: 'Not every capability was verified on one final revision.', next: 'Nothing was recorded as current. Retry, or save a diagnostic bundle.' })],
  [/proof-(persistence|unavailable)|proof-not-durable/, () => ({ kind: 'proof-not-stored', title: 'The proof could not be stored.', next: 'Nothing was recorded as current. Retry; if it happens again, save a diagnostic bundle.' })],
  [/proof-missing/, () => ({ kind: 'proof-missing', title: 'The stored proof for this capability is missing.', next: 'The capability itself is unchanged. Save a diagnostic bundle.' })],
  [/proof-mismatch|proof-store-conflict|proof-export/, () => ({ kind: 'proof-integrity', title: 'The stored proof did not pass its integrity check.', next: 'The capability itself is unchanged. Save a diagnostic bundle.' })],
  [/unsupported|no proven host adaptation|host-mismatch|host-shape-changed/, () => ({ kind: 'unsupported', title: 'This destination is not supported in the beta.', next: 'See What’s supported.' })],
  [/plan-stale|capability-set-mismatch|STALE/, () => ({ kind: 'stale-plan', title: 'The plan no longer matches the blueprint.', next: 'Build a fresh plan.' })],
  [/dirty|uncommitted/, () => ({ kind: 'dirty-repository', title: 'The repository has uncommitted changes.', next: 'Commit or stash them, then try again.' })],
  [/not-a-git-repo|no-commits/, () => ({ kind: 'not-a-repository', title: 'This folder is not a Git repository with a commit.', next: 'Create a Git repository with at least one commit first.' })],
  [/provider|AUTH_|credential/, () => ({ kind: 'provider', title: 'The identity provider stand-in was not available.', next: 'Retry; if it happens again, save a diagnostic bundle.' })],
];
/** Customer wording for an execution error (code + message + status) or a plain error; never throws. */
export function describeFailure(input) {
  const code = String(input?.code || ''); const message = String(input?.message || input || ''); const status = String(input?.status || '');
  for (const [pattern, describe] of KNOWN) if (pattern.test(code) || pattern.test(message)) return { ...describe({ code, message, status }), technical: message || null, code: code || null };
  return { kind: 'unexpected', title: 'Something unexpected happened.', next: 'Save a diagnostic bundle and send it to LeftSock Labs.', technical: message || null, code: code || null };
}

// ---------------------------------------------------------------------------------------------
// Recovery assessment for one execution.
// ---------------------------------------------------------------------------------------------
/** The first application name under `parent` that nothing occupies: name, name-2, name-3, … */
export function suggestFreeProjectName(parent, name) {
  const base = normaliseHostName(name);
  const exists = (slug) => { try { fs.lstatSync(path.join(parent, slug)); return true; } catch { return false; } };
  if (!exists(base)) return base;
  for (let n = 2; n < 100; n += 1) if (!exists(`${base}-${n}`)) return `${base}-${n}`;
  throw fail('no-free-name', `No free name under ${base} in the chosen folder.`);
}

/**
 * What a customer can do with this execution now. `running` says whether this process is still
 * executing it. Returns null for a completed assembly or one that is still running.
 */
export function assessRecovery(execution, { running = false } = {}) {
  if (!execution || running) return null;
  const terminal = TERMINAL_STATES.includes(execution.status);
  if (execution.status === 'COMPLETED') return null;
  const interrupted = !terminal;
  const failure = interrupted
    ? { kind: 'interrupted', title: 'This assembly did not finish.', next: 'GRAFT was closed or lost the run before it could conclude. Nothing was recorded as current.', technical: execution.currentStep ? `stopped during ${execution.currentStep}` : null, code: 'interrupted' }
    : describeFailure({ ...(execution.error || {}), status: execution.status });
  const discarded = (execution.recovery || []).find((r) => r.action === 'discard') || null;
  const parent = execution.host?.destinationParent || null; const name = execution.host?.projectName || execution.blueprintName || 'application';
  let suggestedProjectName = null; try { suggestedProjectName = parent ? suggestFreeProjectName(parent, name) : null; } catch { suggestedProjectName = null; }
  return Object.freeze({
    interrupted, status: execution.status, failure,
    retry: { available: Boolean(parent), planId: execution.planId, destinationParent: parent, suggestedProjectName },
    discard: { available: !discarded, transplantId: execution.transplantId || null, discardedAt: discarded?.at || null },
    diagnostics: { available: true },
  });
}

/** Note a recovery action on the record — history added, nothing else changed. */
export function annotateRecovery(execution, entry, { now = () => new Date().toISOString() } = {}) {
  execution.recovery = [...(execution.recovery || []), { at: now(), ...entry }];
  return execution;
}
