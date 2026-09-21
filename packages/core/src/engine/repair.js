// Bounded repair loop for verification failures.
//
//   TRANSPLANT -> VERIFY -> if FAILED and the failure is classifiable -> DIAGNOSE ->
//   bounded repair proposal -> APPLY REPAIR -> VERIFY AGAIN
//
// Authority limits, deliberately narrow: only FAILED verdicts are considered (NEEDS_REVIEW /
// inconclusive evidence never triggers a mutation); only a known, deterministic repair class
// is applied (no free-form self-modification); the repair edits exactly the file the plan
// already owned through the same guarded editor (planEntrypointEdit) and never a byte more;
// attempts are hard-capped; every attempt records its evidence, reason and changed files;
// and the final verdict comes only from the authoritative verifier passed in.
import fs from 'node:fs';
import { planEntrypointEdit } from '../emit/entrypoint.js';
import { safeProjectPath } from '../util/paths.js';

export const REPAIR_VERSION = '1.0.0';
export const MAX_REPAIR_ATTEMPTS = 2;
export const REPAIR_CLASSES = Object.freeze(['missing-route-registration']);

const opPaths = (plan) => new Set((plan.engine?.ir?.operations || []).map((o) => `${o.method} ${o.path}`));

/** Decide whether a report describes a failure the engine knows how to repair. Pure. */
export function classifyFailure({ report, plan, entrypointSource }) {
  if (report.verdict !== 'FAILED') return { class: null, repairable: false, reason: report.verdict === 'NEEDS_REVIEW' ? 'inconclusive evidence is never repaired speculatively' : `verdict ${report.verdict} needs no repair` };
  const failed = (report.results || []).filter((r) => r.required && r.outcome === 'failed');
  if (!failed.length) return { class: null, repairable: false, reason: 'no required failure to diagnose' };
  const routes = opPaths(plan);
  const failingSteps = failed.map((r) => r.steps?.find((s) => !s.ok)).filter(Boolean);
  const all404OnOurRoutes = failingSteps.length === failed.length && failingSteps.every((s) => s.status === 404 && routes.has(s.request));
  const marker = `// >>> graft:${plan.registration?.marker || 'authentication'}`;
  const registered = typeof entrypointSource === 'string' && entrypointSource.includes(marker) && entrypointSource.includes(`${plan.registration?.name || 'registerAuthRoutes'}(`);
  if (all404OnOurRoutes && !registered) {
    return { class: 'missing-route-registration', repairable: true, reason: `${failed.length} required test(s) received 404 on transplanted routes and ${plan.destination.entrypoint} does not register ${plan.registration?.name || 'the capability'}`,
      evidence: failed.map((r) => ({ test: r.id, step: r.steps?.find((s) => !s.ok)?.name || null, request: r.steps?.find((s) => !s.ok)?.request || null, status: 404 })) };
  }
  return { class: null, repairable: false, reason: all404OnOurRoutes ? 'routes answer 404 but the entrypoint already registers the capability; not a registration fault' : 'failure is not a known deterministic repair class',
    evidence: failed.map((r) => ({ test: r.id, reason: r.reason || null })) };
}

/** A bounded proposal: what would change and why. Pure; nothing is written. */
export function proposeRepair(classification, { plan, entrypointSource }) {
  if (!classification.repairable) return null;
  if (classification.class === 'missing-route-registration') {
    const relative = (() => {
      const from = plan.destination.entrypoint.split('/').slice(0, -1);
      const to = plan.registration.module.split('/');
      while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
      const rel = [...from.map(() => '..'), ...to].join('/');
      return rel.startsWith('.') ? rel : `./${rel}`;
    })();
    const edit = planEntrypointEdit(entrypointSource, { routesModule: relative, conflictingRoutes: plan.conflicts?.routes || [], resolveConflicts: plan.conflicts?.resolutionApproved === true, profile: plan.adaptation.profile, registration: plan.registration });
    if (!edit.applied) return { class: classification.class, applicable: false, reason: `entrypoint edit refused: ${edit.reason}`, files: [] };
    return { class: classification.class, applicable: true, reason: classification.reason, action: 'reapply-entrypoint-registration', files: [plan.destination.entrypoint], edit, basis: entrypointSource };
  }
  return null;
}

/** Apply a proposal: writes only the file(s) it names, through the same path guards as apply. */
export function applyRepair(proposal, destRoot) {
  if (!proposal?.applicable) throw new Error('repair proposal is not applicable');
  const target = safeProjectPath(destRoot, proposal.files[0]);
  const before = fs.readFileSync(target, 'utf8');
  // The proposal was computed from an exact source; apply only onto that exact source. Any
  // concurrent edit — marker or not — refuses the repair rather than clobbering the file.
  if (before !== proposal.basis) throw new Error('entrypoint changed since the repair was proposed; nothing was written — re-verify');
  fs.writeFileSync(target, proposal.edit.source, 'utf8');
  return { changedFiles: proposal.files, before: { [proposal.files[0]]: before }, edits: proposal.edit.edits };
}

/**
 * Verify, and on a classifiable FAILED verdict repair and verify again, at most maxAttempts
 * times. `verify` is the authoritative verifier (verifyCapability bound to its options); its
 * last report is the result. The initial failure evidence is preserved verbatim.
 */
export async function repairAndVerify({ plan, destRoot, verify, maxAttempts = MAX_REPAIR_ATTEMPTS }) {
  const cap = Math.max(0, Math.min(MAX_REPAIR_ATTEMPTS, maxAttempts));
  const initial = await verify({});
  let report = initial;
  const attempts = [];
  const entrypoint = () => fs.readFileSync(safeProjectPath(destRoot, plan.destination.entrypoint), 'utf8');
  while (report.verdict === 'FAILED' && attempts.length < cap) {
    const classification = classifyFailure({ report, plan, entrypointSource: entrypoint() });
    if (!classification.repairable) { attempts.push({ attempt: attempts.length + 1, class: null, repaired: false, reason: classification.reason, evidence: classification.evidence || null, changedFiles: [] }); break; }
    const proposal = proposeRepair(classification, { plan, entrypointSource: entrypoint() });
    if (!proposal?.applicable) { attempts.push({ attempt: attempts.length + 1, class: classification.class, repaired: false, reason: proposal?.reason || 'no applicable repair', evidence: classification.evidence, changedFiles: [] }); break; }
    const applied = applyRepair(proposal, destRoot);
    const failureEvidence = { verdict: report.verdict, rationale: report.rationale, failed: (report.results || []).filter((r) => r.outcome !== 'passed').map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason || null })) };
    report = await verify({ repair: { attempted: true, class: classification.class, attempt: attempts.length + 1 } });
    attempts.push({ attempt: attempts.length + 1, class: classification.class, repaired: report.verdict === 'VERIFIED', reason: classification.reason, action: proposal.action, evidence: classification.evidence,
      before: failureEvidence, changedFiles: applied.changedFiles, edits: applied.edits, after: { verdict: report.verdict, rationale: report.rationale } });
  }
  return { repairVersion: REPAIR_VERSION, initial, report, attempts, repaired: attempts.some((a) => a.repaired), exhausted: report.verdict === 'FAILED' && attempts.length >= cap && attempts.every((a) => a.class), maxAttempts: cap };
}
