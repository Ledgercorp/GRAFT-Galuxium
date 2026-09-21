// Compatibility Atlas — the persistence and model layer for what GRAFT learns from runs.
//
// Each entry records one attempt: the source and destination architecture fingerprints,
// the capability type, the adaptations attempted, the result, the verification outcome,
// notable failure reasons, any repair, and confidence/relevance metadata. Entries live
// locally under GRAFT_HOME/atlas. Like the per-project compatibility history, the atlas is
// descriptive evidence: it can inform a plan's risk notes but never changes a
// compatibility check or a verdict.
//
// 1.1.0 binds an entry to the evidence it summarises, so an observation can be traced back to
// exactly what was observed instead of standing on its own: the source revision the capability
// was verified at, the committed destination revision the verification was about, the digest of
// the proof envelope (the join to the Assembly Ledger, which cites the same digest), the
// compatibility assumptions the plan made BEFORE the transplant, and — for a Laboratory assembly —
// how the attempt ended, including attempts that never reached verification. Every field is a
// digest, an identifier or an enumerated code: no path, repository name or free text. 1.0.0
// entries remain valid knowledge and load unchanged. No field here is consulted by ranking.
import fs from 'node:fs';
import path from 'node:path';
import { stableHash, canonicalSerialize } from '../capability/contract.js';
import { graftHome } from '../registry/index.js';

export const ATLAS_VERSION = '1.1.0';
export const ATLAS_VERSIONS = Object.freeze(['1.0.0', ATLAS_VERSION]);
export const atlasDir = () => path.join(graftHome(), 'atlas');
const RESULTS = ['supported', 'conditionally-supported', 'refused'];
const VERDICTS = ['VERIFIED', 'FAILED', 'NEEDS_REVIEW', null];
export const ASSEMBLY_FINAL_STATES = Object.freeze(['COMPLETED', 'FAILED', 'INCONCLUSIVE', 'BLOCKED', 'STALE']);
const ASSUMPTION_STATUSES = ['ok', 'warn', 'block', 'unknown'];
const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,120}$/;

// The fields the entry id commits to, per version. 1.0.0 ids stay recomputable exactly as issued.
// 1.1.0 also commits to `at`: an observation is one attempt at one time, so two identical refusals
// made at different times are two observations (a verified entry already carried its time inside
// `verification`; an attempt that never reached verification had nothing else to tell them apart).
const identityOf = (e) => ({
  atlasVersion: e.atlasVersion, capabilityId: e.capabilityId, sourceArchitecture: e.sourceArchitecture, destinationArchitecture: e.destinationArchitecture, hostId: e.hostId, adaptations: e.adaptations, recipeId: e.recipeId, result: e.result, verification: e.verification, failureReasons: e.failureReasons, repair: e.repair,
  ...(e.atlasVersion === '1.0.0' ? {} : { at: e.at, sourceRevision: e.sourceRevision, destinationRevision: e.destinationRevision, proofEnvelopeDigest: e.proofEnvelopeDigest, assumptions: e.assumptions, assembly: e.assembly }),
});

export function buildAtlasEntry({ capabilityId, capabilityCategory, capabilityKind = null, genomeId = null, sourceArchitecture, destinationArchitecture, hostId = null, adaptations = [], recipeId = null,
  result, verification = null, failureReasons = [], repair = null, confidence = null, at = new Date().toISOString(),
  sourceRevision = null, destinationRevision = null, proofEnvelopeDigest = null, assumptions = null, assembly = null }) {
  const entry = { atlasVersion: ATLAS_VERSION, capabilityId, capabilityCategory, capabilityKind, genomeId, sourceArchitecture, destinationArchitecture, hostId, adaptations, recipeId, result,
    verification: verification ? { verdict: verification.verdict, summary: verification.summary || null, at: verification.at || at } : null,
    failureReasons, repair,
    confidence: confidence || { basis: verification ? 'observed' : 'static', sampleSize: 1, relevance: 1 }, at,
    sourceRevision, destinationRevision, proofEnvelopeDigest,
    assumptions: assumptions ? assumptions.map((a) => ({ id: a?.id ?? null, status: a?.status ?? null })) : null,
    assembly: assembly ? { finalState: assembly.finalState ?? null, failedStep: assembly.failedStep ?? null, errorCode: assembly.errorCode ?? null } : null };
  entry.entryId = stableHash(identityOf(entry));
  return entry;
}

export function validateAtlasEntry(entry) {
  const errors = [];
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(entry) || !ATLAS_VERSIONS.includes(entry.atlasVersion)) return { ok: false, errors: [`atlasVersion must be one of ${ATLAS_VERSIONS.join(', ')}`] };
  if (!/^sha256:[0-9a-f]{64}$/.test(entry.capabilityId || '')) errors.push('capabilityId must be a sha256 digest');
  if (typeof entry.capabilityCategory !== 'string') errors.push('capabilityCategory is required');
  if (!object(entry.sourceArchitecture) || !object(entry.destinationArchitecture)) errors.push('source and destination architectures are required');
  if (!Array.isArray(entry.adaptations)) errors.push('adaptations must be an array');
  if (!RESULTS.includes(entry.result)) errors.push(`result must be one of ${RESULTS.join(', ')}`);
  if (entry.verification !== null && !(object(entry.verification) && VERDICTS.includes(entry.verification.verdict))) errors.push('verification must be null or carry a known verdict');
  if (!Array.isArray(entry.failureReasons)) errors.push('failureReasons must be an array');
  if (!object(entry.confidence) || !['observed', 'static', 'imported'].includes(entry.confidence.basis)) errors.push('confidence.basis must be observed, static or imported');
  if (!Number.isFinite(Date.parse(entry.at))) errors.push('at must be a timestamp');
  if (entry.atlasVersion !== '1.0.0') {
    // Evidence bindings: each is a digest, an identifier or a code, or null when the observation
    // genuinely had none (a dirty-tree verification has no destination revision; a verification
    // outside the Laboratory has no assembly outcome). Nothing else is accepted.
    if (!(entry.sourceRevision === null || HEX40.test(entry.sourceRevision || ''))) errors.push('sourceRevision must be null or a commit hash');
    if (!(entry.destinationRevision === null || HEX40.test(entry.destinationRevision || ''))) errors.push('destinationRevision must be null or a commit hash');
    if (!(entry.proofEnvelopeDigest === null || HEX64.test(entry.proofEnvelopeDigest || ''))) errors.push('proofEnvelopeDigest must be null or a sha256 digest');
    if (!(entry.assumptions === null || (Array.isArray(entry.assumptions) && entry.assumptions.every((a) => object(a) && CODE.test(a.id || '') && ASSUMPTION_STATUSES.includes(a.status) && Object.keys(a).length === 2)))) errors.push(`assumptions must be null or a list of { id, status } with status in ${ASSUMPTION_STATUSES.join(', ')}`);
    if (!(entry.assembly === null || (object(entry.assembly) && ASSEMBLY_FINAL_STATES.includes(entry.assembly.finalState) && (entry.assembly.failedStep === null || CODE.test(entry.assembly.failedStep || '')) && (entry.assembly.errorCode === null || CODE.test(entry.assembly.errorCode || '')) && Object.keys(entry.assembly).length === 3))) errors.push(`assembly must be null or { finalState in ${ASSEMBLY_FINAL_STATES.join(', ')}, failedStep, errorCode }`);
    if (entry.assembly && entry.assembly.finalState === 'COMPLETED' && entry.verification?.verdict !== 'VERIFIED') errors.push('a COMPLETED assembly outcome must carry a VERIFIED verification');
    if (entry.assembly && entry.assembly.finalState === 'COMPLETED' && (!entry.destinationRevision || !entry.proofEnvelopeDigest)) errors.push('a COMPLETED assembly outcome must name its destination revision and proof envelope digest');
  }
  const { entryId } = entry;
  if (entryId !== stableHash(identityOf(entry))) errors.push('entryId does not match the entry');
  return { ok: errors.length === 0, errors };
}

/** Append an entry. Identical replays are no-ops; a differing entry with the same id is refused. */
export function recordAtlasEntry(entry, { directory = atlasDir() } = {}) {
  const validation = validateAtlasEntry(entry);
  if (!validation.ok) throw new Error(`Invalid atlas entry: ${validation.errors.join('; ')}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${entry.entryId.slice(7)}.json`);
  try { fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (canonicalSerialize(JSON.parse(fs.readFileSync(file, 'utf8'))) !== canonicalSerialize(entry)) throw new Error('An atlas entry with this id already exists and differs; nothing was overwritten.');
  }
  return { file, entry };
}

export function loadAtlas({ directory = atlasDir() } = {}) {
  if (!fs.existsSync(directory)) return [];
  const entries = [];
  for (const name of fs.readdirSync(directory).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).sort()) {
    try {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) continue;
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validateAtlasEntry(entry).ok) entries.push(entry);
    } catch { /* an unreadable entry is not knowledge */ }
  }
  return entries;
}

// Architecture families compared for relevance: framework, module system, handler
// contract and persistence — not dependency lists or versions.
const family = (a) => ({ framework: a?.framework || 'unknown', moduleSystem: a?.moduleSystem || 'unknown', handlerContract: a?.handlerContract || 'unknown', persistence: a?.persistence || 'unknown' });
const sameFamily = (a, b) => canonicalSerialize(family(a)) === canonicalSerialize(family(b));

// Relevance ranking. Deterministic weights, no model opinion: the same capability kind is a
// hard filter; destination similarity matters most (that is what a transplant must fit), then
// source similarity, adaptation/recipe overlap, verification outcome, corroboration by
// independent observations, and recency only as a minor tie-breaker.
const FAMILY_FIELDS = ['framework', 'moduleSystem', 'handlerContract', 'persistence'];
const WEIGHTS = Object.freeze({ destinationField: 10, destinationExact: 15, sourceField: 4, sourceExact: 6, adaptation: 10, recipe: 8, verified: 12, needsReview: 0, failed: -6, refused: -8, corroboration: 3, corroborationMax: 12, recencyMax: 4 });

export function scoreEntry(entry, query, { corroboration = 1, now = Date.now() } = {}) {
  const reasons = [];
  let score = 0;
  const df = family(entry.destinationArchitecture), dq = family(query.destinationArchitecture);
  const dHits = FAMILY_FIELDS.filter((f) => df[f] === dq[f]);
  score += dHits.length * WEIGHTS.destinationField; if (dHits.length) reasons.push(`destination ${dHits.join('/')} match`);
  if (dHits.length === FAMILY_FIELDS.length) { score += WEIGHTS.destinationExact; reasons.push('destination architecture family identical'); }
  const sf = family(entry.sourceArchitecture), sq = family(query.sourceArchitecture);
  const sHits = FAMILY_FIELDS.filter((f) => sf[f] === sq[f]);
  score += sHits.length * WEIGHTS.sourceField; if (sHits.length) reasons.push(`source ${sHits.join('/')} match`);
  if (sHits.length === FAMILY_FIELDS.length) { score += WEIGHTS.sourceExact; reasons.push('source architecture family identical'); }
  const wanted = new Set(query.adaptations || []);
  const overlap = (entry.adaptations || []).filter((a) => wanted.has(a));
  if (overlap.length) { score += WEIGHTS.adaptation; reasons.push(`same adaptation ${overlap.join(', ')}`); }
  if (query.recipeId && entry.recipeId === query.recipeId) { score += WEIGHTS.recipe; reasons.push('same recipe'); }
  const verdict = entry.verification?.verdict || null;
  if (entry.result === 'refused') { score += WEIGHTS.refused; reasons.push('refused by compatibility checks'); }
  else if (verdict === 'VERIFIED') { score += WEIGHTS.verified; reasons.push('verified transplant'); }
  else if (verdict === 'FAILED') { score += WEIGHTS.failed; reasons.push('failed verification (relevant as a warning)'); }
  else if (verdict === 'NEEDS_REVIEW') { score += WEIGHTS.needsReview; reasons.push('inconclusive verification'); }
  const corroborated = Math.min(WEIGHTS.corroborationMax, WEIGHTS.corroboration * Math.max(0, corroboration - 1));
  if (corroborated) { score += corroborated; reasons.push(`${corroboration} corroborating observations`); }
  const ageDays = Math.max(0, (now - Date.parse(entry.at)) / 86400000);
  const recency = Number.isFinite(ageDays) ? WEIGHTS.recencyMax * Math.max(0, 1 - ageDays / 365) : 0;
  score += recency;
  return { score: Math.round(score * 100) / 100, reasons, verdict, result: entry.result, support: corroboration };
}

const signature = (e) => canonicalSerialize({ s: family(e.sourceArchitecture), d: family(e.destinationArchitecture), a: [...(e.adaptations || [])].sort(), c: e.capabilityCategory });

/** Descriptive, relevance-ranked prior observations for this capability and architecture pair. */
export function queryAtlas({ capabilityCategory, capabilityKind = null, sourceArchitecture, destinationArchitecture, adaptations = [], recipeId = null, entries = null, directory = atlasDir(), limit = 5, now = Date.now() }) {
  const all = entries || loadAtlas({ directory });
  const eligible = all.filter((e) => e.capabilityCategory === capabilityCategory && (!capabilityKind || !e.capabilityKind || e.capabilityKind === capabilityKind));
  // Corroboration counts VERIFIED observations of the same signature: a failure never
  // corroborates a success (it is scored on its own as a warning).
  const groups = new Map();
  for (const e of eligible) { if (e.verification?.verdict !== 'VERIFIED') continue; const k = signature(e); groups.set(k, (groups.get(k) || 0) + 1); }
  const query = { sourceArchitecture, destinationArchitecture, adaptations, recipeId };
  const ranked = eligible.map((e) => ({ entryId: e.entryId, at: e.at, ...scoreEntry(e, query, { corroboration: groups.get(signature(e)) || 1, now }) }))
    .sort((a, b) => b.score - a.score || String(b.at).localeCompare(String(a.at)));
  const matches = eligible.filter((e) => sameFamily(e.sourceArchitecture, sourceArchitecture) && sameFamily(e.destinationArchitecture, destinationArchitecture));
  const verdicts = { VERIFIED: 0, FAILED: 0, NEEDS_REVIEW: 0, unverified: 0 };
  for (const e of matches) verdicts[e.verification?.verdict || 'unverified'] += 1;
  const reasons = {};
  for (const e of matches) for (const r of e.failureReasons) reasons[r] = (reasons[r] || 0) + 1;
  return { observations: matches.length, considered: eligible.length, verdicts, refused: matches.filter((e) => e.result === 'refused').length,
    adaptations: [...new Set(matches.flatMap((e) => e.adaptations))], failureReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
    lastAt: matches.map((e) => e.at).sort().at(-1) || null, matches: matches.map((e) => e.entryId),
    ranked: ranked.slice(0, limit), top: ranked[0] || null };
}
