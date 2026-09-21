// Transplantation outcomes for the Compatibility Atlas.
//
// A Laboratory assembly is one real attempt to move a capability into a host. This module turns a
// TERMINAL execution record into exactly one Atlas entry per capability the plan applied — whether
// the attempt was COMPLETED, FAILED, INCONCLUSIVE or BLOCKED, and whether the capability travelled
// as a regenerated service or an adapted library. Every value is copied from records that already
// exist (the execution, the organ package, the destination fingerprint); nothing is decided here,
// and an attempt that never reached verification is recorded as such rather than dropped: a
// refusal is compatibility evidence too.
//
// One attempt, one observation. The Laboratory's own verifications run with the Atlas switched off
// (a dirty-tree verification, a re-verification alongside later capabilities and the proof of the
// committed revision would otherwise count as three observations of one transplant), and this
// module records the attempt once, from its final state. Verifications outside the Laboratory (the
// CLI, the Transplant page) keep recording themselves at verification time as they always did.
//
// The entry cites its evidence instead of copying it: the source revision the capability was
// verified at, the committed destination revision, and the proof envelope digest — the same digest
// the Assembly Ledger record carries in `proofReference.envelopeDigest`. That shared digest is the
// join between the two; the execution keeps the entry ids under `execution.atlas`.
import fs from 'node:fs';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { architectureSignature } from '../capability/contract.js';
import { buildAtlasEntry, recordAtlasEntry } from '../engine/atlas.js';
import { sourceRevisionOf } from '../verify/proof-envelope.js';
import { structuralAdaptations } from '../verify/index.js';
import { APPLYING_STEP_TYPES } from './assembly.js';
import { graftHome } from '../registry/index.js';

// Reasons are stored on the execution record, which keeps no GRAFT_HOME path outside its receipts.
const describe = (err) => String(err?.message || err).split(graftHome()).join('$GRAFT_HOME').slice(0, 400);
const HEX40 = /^[0-9a-f]{40}$/;
const CAPABILITY_ID = /^sha256:[0-9a-f]{64}$/;

/** The assumptions a plan made before writing: its compatibility checks, as { id, status } only. */
const assumptionsOf = (checks) => (Array.isArray(checks) ? checks.map((c) => ({ id: c.id, status: ['ok', 'warn', 'block'].includes(c.status) ? c.status : c.ok === true ? 'ok' : c.ok === false ? 'block' : 'unknown' })) : null);
/** What the plan concluded from those checks, in the Atlas's vocabulary. */
const resultOf = (assumptions) => (!assumptions ? 'refused' : assumptions.some((a) => a.status === 'block') ? 'refused' : assumptions.some((a) => a.status === 'warn') ? 'conditionally-supported' : 'supported');

/**
 * The per-capability facts of an execution, read from the record as the kernel or the single-
 * capability runner wrote them. Both shapes are the execution's own; nothing is inferred.
 */
function capabilityFacts(execution, capabilityId) {
  const composition = execution.composition;
  if (composition) {
    const c = (composition.capabilities || []).find((x) => x.capabilityId === capabilityId);
    if (!c) return null;
    const proof = (composition.proofs || []).find((p) => p.capabilityId === capabilityId) || null;
    const reverification = (composition.reverifications || []).filter((r) => r.capabilityId === capabilityId).at(-1) || null;
    // The last verification is the capability's verdict: the proof verification of the committed
    // final revision when one ran, else the re-verification after later capabilities, else the
    // initial one. A capability that passed on the dirty tree and failed on the committed revision
    // is FAILED here, with that verification's own failed cases.
    const proven = c.proofVerdict ? { verdict: c.proofVerdict, summary: c.proofSummary ?? null, outcomes: c.proofOutcomes ?? null } : null;
    const outcomes = proven?.outcomes || reverification?.outcomes || c.initialOutcomes || null;
    return { verdict: proven?.verdict || c.finalVerdict || null, summary: proven ? proven.summary : c.finalSummary || null, providerDouble: c.providerDouble ?? null, outcomes, adaptation: c.adaptation || null, transplantPlan: c.transplantPlan || null,
      // Revision and proof are cited only for a composition that completed as a whole — the same
      // rule as the single-capability path; a proof persisted for one capability before a later
      // one failed stays in the execution record, not here without the revision it binds.
      revision: composition.finalState === 'ALL_SELECTED_CAPABILITIES_VERIFIED' ? composition.finalRevision : null,
      proofEnvelopeDigest: composition.finalState === 'ALL_SELECTED_CAPABILITIES_VERIFIED' ? proof?.envelopeDigest ?? null : null };
  }
  const v = execution.verification;
  if (v && v.capabilityId && v.capabilityId !== capabilityId) return null;
  return { verdict: v?.verdict || null, summary: v?.summary || null, providerDouble: v?.providerDouble ?? null, outcomes: v?.outcomes || null, adaptation: execution.adaptation || null, transplantPlan: execution.transplantPlan || null,
    revision: execution.status === 'COMPLETED' ? execution.assembledRevision || execution.proof?.revision || null : null, proofEnvelopeDigest: execution.status === 'COMPLETED' ? execution.proof?.envelopeDigest ?? null : null };
}

/**
 * Build the Atlas entries for a terminal execution without writing them. `organ(slug)` resolves
 * the banked capability (`{ manifest, engine }`). Returns `{ entries, skipped }`: an entry per
 * applied capability whose organ could be read, and the reasons for any that could not. An
 * execution that never created a host has nothing to observe and yields no entries.
 */
export function buildAssemblyOutcomes({ execution, plan, organ, now = () => new Date().toISOString() }) {
  const skipped = [];
  if (!execution || !['COMPLETED', 'FAILED', 'INCONCLUSIVE', 'BLOCKED', 'STALE'].includes(execution.status)) return { entries: [], skipped: ['the execution is not terminal'] };
  const root = [execution.worktree?.path, execution.createdProject?.root].find((p) => p && fs.existsSync(p)) || null;
  if (!root) return { entries: [], skipped: ['no destination exists for this execution'] };
  const fp = fingerprintProject(root);
  const destinationArchitecture = architectureSignature(fp);
  const hostId = execution.reindex?.hostId || execution.receipts?.find((r) => r.fingerprint?.hostId)?.fingerprint?.hostId || null;
  const failedStep = execution.steps?.find((s) => s.status === 'FAILED')?.type || null;
  const assembly = { finalState: execution.finalState || execution.status, failedStep, errorCode: execution.error?.code || null };
  const at = execution.finishedAt || now();
  const entries = [];
  for (const step of (plan?.steps || []).filter((s) => APPLYING_STEP_TYPES.includes(s.type))) {
    const slug = step.capability?.slug || null;
    let manifest = null, engine = null;
    try { ({ manifest, engine } = organ(slug)); } catch (err) { skipped.push(`${slug || step.stepId}: ${describe(err)}`); continue; }
    const genome = engine?.genome || null;
    const capabilityId = genome?.identity?.capabilityId || (CAPABILITY_ID.test(step.capability?.capabilityId || '') ? step.capability.capabilityId : null);
    const sourceArchitecture = genome?.provenance?.sourceArchitecture || manifest?.provenance?.capabilitySource?.architecture || null;
    if (!capabilityId || !sourceArchitecture) { skipped.push(`${slug}: the organ carries no capability identity or source architecture`); continue; }
    const facts = capabilityFacts(execution, capabilityId) || { verdict: null, summary: null, providerDouble: null, outcomes: null, adaptation: null, transplantPlan: null, revision: null, proofEnvelopeDigest: null };
    const library = step.type === 'ADAPT_LIBRARY_CAPABILITY';
    const assumptions = assumptionsOf(library ? facts.adaptation?.checks : facts.transplantPlan?.checks);
    const failed = (facts.outcomes || []).filter((o) => o.outcome !== 'passed').map((o) => `${o.id}:${o.outcome}`);
    entries.push(buildAtlasEntry({
      capabilityId, capabilityCategory: manifest.identity.category, capabilityKind: genome?.identity?.kind || manifest.architecture?.capabilityModel?.kind || null, genomeId: genome?.genomeId || null,
      sourceArchitecture, destinationArchitecture, hostId, recipeId: facts.transplantPlan?.recipeId || null,
      adaptations: library
        ? [...(facts.adaptation?.id ? [facts.adaptation.id] : []), ...(facts.adaptation?.method ? [`method:${facts.adaptation.method}`] : [])]
        : structuralAdaptations(manifest, fp, { profile: facts.transplantPlan?.profile || step.profile || null, providerDouble: facts.verdict ? facts.providerDouble || 'none' : null }),
      result: resultOf(assumptions),
      verification: facts.verdict ? { verdict: facts.verdict, summary: facts.summary, at } : null,
      // A capability's own failed cases; for one that never reached verification, why the attempt ended.
      failureReasons: failed.length ? failed : facts.verdict ? [] : assembly.errorCode ? [`assembly:${assembly.errorCode}`] : [],
      at, sourceRevision: HEX40.test(sourceRevisionOf(manifest) || '') ? sourceRevisionOf(manifest) : null,
      destinationRevision: HEX40.test(facts.revision || '') ? facts.revision : null, proofEnvelopeDigest: facts.proofEnvelopeDigest, assumptions, assembly,
    }));
  }
  return { entries, skipped };
}

/**
 * Record the outcomes of a terminal execution in the local Atlas and note the entry ids on the
 * execution (`execution.atlas`), so the record names the knowledge it produced. Never throws for
 * a recording failure: the failure is written on the execution instead, and is never a success.
 *
 * At most once per execution: `execution.atlas` is the already-recorded state. A terminal path that
 * runs again for the same execution (a persistence or event failure after the first recording sent
 * the runner through its failure exit) finds the first observation and adds nothing — one attempt
 * cannot become two contradictory observations, and the first record stays as it was.
 */
export function recordAssemblyOutcomes({ execution, plan, organ, directory = undefined, now = () => new Date().toISOString() }) {
  if (execution?.atlas && typeof execution.atlas === 'object') return execution.atlas;
  const errors = [];
  let built;
  try { built = buildAssemblyOutcomes({ execution, plan, organ, now }); }
  catch (err) { built = { entries: [], skipped: [] }; errors.push(describe(err)); }
  const recorded = [];
  for (const entry of built.entries) {
    try { recordAtlasEntry(entry, directory ? { directory } : {}); recorded.push({ capabilityId: entry.capabilityId, entryId: entry.entryId, result: entry.result, verdict: entry.verification?.verdict || null }); }
    catch (err) { errors.push(`${entry.capabilityId}: ${describe(err)}`); }
  }
  execution.atlas = { entries: recorded, skipped: built.skipped, errors };
  return execution.atlas;
}
