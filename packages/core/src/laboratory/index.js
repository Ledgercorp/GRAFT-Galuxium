// GRAFT Laboratory 0.1 — the capability blueprint.
//
// A blueprint answers, from deterministic GRAFT data, what a new application would be made of:
// which capability goals it needs, which implementations in Capability Memory can serve them,
// what depends on what, what conflicts, what is missing, and how ready the design is for
// assembly planning. It sits above Capability Memory, the organ bank, the engine artifacts and
// the Atlas; it never harvests, transplants, verifies or writes into any application.
//
// Two kinds of fields live side by side and are never mixed:
//   authoritative — goals and selections the person made, and the analysis GRAFT derives
//                   from its own data (candidates, dependencies, conflicts, readiness);
//   advisory      — whatever an agent suggested (`agentAdvice`), which the person may accept
//                   into goals but which changes nothing by itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { graftHome, bankDir } from '../registry/index.js';
import { listOrganBank, readOrganEngine } from '../manifest/io.js';
import { loadIndex } from '../workspace/store.js';
import { searchCapabilities } from '../workspace/search.js';
import { loadAtlas } from '../engine/atlas.js';
import { SUPPORTED_PROFILES } from '../emit/profiles.js';
import { detectLicense } from '../export/index.js';
import { describeLibraryIntegration } from '../adapt/library-host.js';

export const BLUEPRINT_SCHEMA_VERSION = '1.0.0';
export const READINESS = Object.freeze(['DRAFT', 'NEEDS_SELECTIONS', 'MISSING_CAPABILITIES', 'HAS_CONFLICTS', 'READY_FOR_ASSEMBLY_PLANNING']);
export const DEPENDENCY_LEVELS = Object.freeze(['PROVEN', 'DECLARED', 'INFERRED', 'ADVISORY', 'UNKNOWN']);
export const GOAL_SOURCES = Object.freeze(['user', 'agent-advisory', 'inferred-from-dependency']);
export const HOST_INTENTS = Object.freeze(['decide-later', 'existing-project', 'new-application']);
export const CANDIDATE_TIERS = Object.freeze(['best-evidence', 'strong', 'possible', 'unproven']);
const fail = (code, message, remedy = null) => Object.assign(new Error(message), { code, remedy });
const ID = /^[a-z0-9][a-z0-9-]{3,63}$/;

// ---------------------------------------------------------------------------------------------
// Goal vocabulary: what a person can ask for, mapped to what GRAFT can look for.
// `memory` names the Capability Memory category (null when GRAFT has no detector for it yet —
// such a goal can only ever be MISSING in 0.1, and says so). `provides` / `requires` are GRAFT's
// own DECLARED relationships between goal categories.
// ---------------------------------------------------------------------------------------------
export const GOAL_CATEGORIES = Object.freeze({
  authentication: { label: 'User authentication', memory: ['authentication', 'hosted-authentication'], provides: ['user-identity', 'session'], requires: [], keywords: /\b(sign[- ]?in|log[- ]?in|auth\w*|account|password|sso|oauth)\b/i },
  organizations: { label: 'Organizations / account grouping', memory: null, provides: ['tenant-identity'], requires: ['user-identity'], keywords: /\b(organi[sz]ations?|teams?|tenants?|workspaces?|companies|company|account grouping)\b/i },
  billing: { label: 'Billing / payments', memory: null, provides: ['billing'], requires: ['user-identity', 'tenant-identity'], keywords: /\b(bill\w*|invoic\w*|pay\w*|subscri\w*|checkout|stripe)\b/i },
  'file-uploads': { label: 'File uploads', memory: ['file-uploads'], provides: ['file-storage'], requires: ['user-identity'], keywords: /\b(upload\w*|documents?|files?|attachments?|media)\b/i },
  roles: { label: 'Roles / permissions', memory: null, provides: ['authorization'], requires: ['user-identity'], keywords: /\b(roles?|permissions?|rbac|access control)\b/i },
  admin: { label: 'Admin dashboard', memory: null, provides: ['admin'], requires: ['user-identity', 'authorization'], keywords: /\b(admin\w*|back[- ]?office|moderat\w*)\b/i },
  notifications: { label: 'Notifications', memory: null, provides: ['notifications'], requires: ['user-identity'], keywords: /\b(notif\w*|alerts?|emails?|sms|push)\b/i },
  search: { label: 'Search', memory: null, provides: ['search'], requires: [], keywords: /\b(search\w*|find|filter\w*)\b/i },
  'feature-flags': { label: 'Feature flags', memory: ['feature-flags'], provides: ['feature-flags'], requires: [], keywords: /\b(feature[- ]?flags?|toggles?|rollouts?)\b/i },
});
const CAPABILITY_LABEL = { 'user-identity': 'User identity', session: 'Session', 'tenant-identity': 'Organization / tenant identity', billing: 'Billing', 'file-storage': 'File storage', authorization: 'Roles / authorization', admin: 'Admin', notifications: 'Notifications', search: 'Search', 'feature-flags': 'Feature flags' };

/** Deterministic interpretation of a description: the person's own words, no model. */
export function goalsFromDescription(description) {
  const text = String(description || '');
  return Object.entries(GOAL_CATEGORIES).filter(([, def]) => def.keywords.test(text)).map(([category, def]) => ({ category, label: def.label, required: true, source: 'user', derivedFrom: 'description-keywords' }));
}
/** The guided checklist a person can tick, with or without an agent. */
export const GUIDED_QUESTIONS = Object.freeze([
  { category: 'authentication', question: 'Sign in' }, { category: 'file-uploads', question: 'Upload files' }, { category: 'billing', question: 'Pay invoices' },
  { category: 'organizations', question: 'Belong to organizations' }, { category: 'notifications', question: 'Receive notifications' }, { category: 'admin', question: 'Use an admin dashboard' },
  { category: 'roles', question: 'Have different roles and permissions' }, { category: 'search', question: 'Search their data' }, { category: 'feature-flags', question: 'See features switched on gradually' },
]);

// ---------------------------------------------------------------------------------------------
// Persistence: one JSON file per blueprint beneath GRAFT_HOME/laboratory/blueprints, atomic.
// ---------------------------------------------------------------------------------------------
export const blueprintsDir = () => path.join(graftHome(), 'laboratory', 'blueprints');
const blueprintFile = (id) => { if (!ID.test(id)) throw fail('invalid-blueprint-id', 'Blueprint id must be a short lowercase id.'); return path.join(blueprintsDir(), `${id}.json`); };
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${crypto.randomUUID()}.tmp`);
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}
const PRIVATE_KEYS = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
/** Refuse to persist anything that looks like a secret value or a local absolute path. */
function assertStorable(blueprint) {
  const walk = (value, trail) => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${trail}[${i}]`));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => { if (PRIVATE_KEYS.test(k) && typeof v === 'string' && v.length > 0 && !/^[A-Z0-9_]+$/.test(v)) throw fail('blueprint-privacy', `${trail}.${k} looks like a secret value; blueprints store configuration names only.`); walk(v, `${trail}.${k}`); });
    if (typeof value === 'string' && (value.includes(os.homedir()) || /(^|[\s"'(])\/Users\/[^/\s]+\//.test(value) || /(^|[\s"'(])\/home\/[^/\s]+\//.test(value) || /[A-Za-z]:\\Users\\/.test(value) || value.includes(graftHome()))) throw fail('blueprint-privacy', `${trail} would store a local path (${value.slice(0, 40)}…); blueprints reference capabilities by id.`);
  };
  walk(blueprint, 'blueprint');
}
export function createBlueprint({ name, description = '', hostIntent = 'decide-later', now = () => new Date().toISOString() } = {}) {
  const title = String(name || '').trim();
  if (!title || title.length > 80) throw fail('invalid-name', 'Give the blueprint a short name.');
  if (!HOST_INTENTS.includes(hostIntent)) throw fail('invalid-host-intent', 'Unknown host intent.');
  const blueprintId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'blueprint'}-${crypto.randomBytes(3).toString('hex')}`;
  const stamp = now();
  const blueprint = { schemaVersion: BLUEPRINT_SCHEMA_VERSION, blueprintId, name: title, description: String(description || '').slice(0, 4000), createdAt: stamp, updatedAt: stamp,
    hostIntent: { kind: hostIntent, runtime: null, framework: null }, goals: [], agentAdvice: null };
  saveBlueprint(blueprint, { now });
  return blueprint;
}
export function saveBlueprint(blueprint, { now = () => new Date().toISOString() } = {}) {
  if (blueprint.schemaVersion !== BLUEPRINT_SCHEMA_VERSION) throw fail('unsupported-schema', `Blueprint schema ${blueprint.schemaVersion} is not supported.`);
  const stored = { ...blueprint, updatedAt: now() };
  delete stored.analysis; // derived, never stored as truth
  assertStorable(stored);
  writeAtomic(blueprintFile(stored.blueprintId), stored);
  return stored;
}
export function loadBlueprint(id) {
  const file = blueprintFile(id);
  if (!fs.existsSync(file)) throw fail('unknown-blueprint', `No blueprint ${id}.`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== BLUEPRINT_SCHEMA_VERSION) throw fail('unsupported-schema', `Blueprint schema ${parsed.schemaVersion} is not supported.`);
  return parsed;
}
export function listBlueprints() {
  const dir = blueprintsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => { try { const b = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { blueprintId: b.blueprintId, name: b.name, updatedAt: b.updatedAt, goals: (b.goals || []).length, selected: (b.goals || []).filter((g) => g.selection).length }; } catch { return null; } }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export function deleteBlueprint(id) { fs.rmSync(blueprintFile(id), { force: true }); }

// ---------------------------------------------------------------------------------------------
// Goals and selections (authoritative: the person's decisions).
// ---------------------------------------------------------------------------------------------
export function addGoal(blueprint, { category, label = null, required = true, source = 'user', derivedFrom = null, description = '' }) {
  if (!GOAL_SOURCES.includes(source)) throw fail('invalid-goal-source', 'Unknown goal source.');
  const def = GOAL_CATEGORIES[category];
  if (!def && !(typeof label === 'string' && label.trim())) throw fail('invalid-goal', 'A goal needs a known category or a label.');
  if (def && blueprint.goals.some((g) => g.category === category)) return blueprint.goals.find((g) => g.category === category);
  const goal = { goalId: `goal-${crypto.randomBytes(3).toString('hex')}`, category: def ? category : null, label: (label || def?.label || '').trim().slice(0, 80), description: String(description || '').slice(0, 400), required: required !== false, source, derivedFrom, selection: null };
  blueprint.goals.push(goal);
  return goal;
}
export function removeGoal(blueprint, goalId) { blueprint.goals = blueprint.goals.filter((g) => g.goalId !== goalId); }
export function updateGoal(blueprint, goalId, patch) {
  const goal = blueprint.goals.find((g) => g.goalId === goalId); if (!goal) throw fail('unknown-goal', `No goal ${goalId}.`);
  if (patch.required !== undefined) goal.required = patch.required === true;
  if (patch.label !== undefined) goal.label = String(patch.label).trim().slice(0, 80);
  return goal;
}
/** Select an implementation for a goal by stable reference (organ slug + capabilityId, or an index observation). */
export function selectImplementation(blueprint, goalId, selection) {
  const goal = blueprint.goals.find((g) => g.goalId === goalId); if (!goal) throw fail('unknown-goal', `No goal ${goalId}.`);
  if (selection === null) { goal.selection = null; return goal; }
  if (selection.kind === 'organ') { if (typeof selection.slug !== 'string' || typeof selection.capabilityId !== 'string') throw fail('invalid-selection', 'An organ selection needs slug and capabilityId.'); goal.selection = { kind: 'organ', slug: selection.slug, capabilityId: selection.capabilityId, name: selection.name || null }; }
  else if (selection.kind === 'observation') { if (typeof selection.projectId !== 'string' || typeof selection.capability !== 'string') throw fail('invalid-selection', 'An observation selection needs projectId and capability.'); goal.selection = { kind: 'observation', projectId: selection.projectId, capability: selection.capability, name: selection.name || null }; }
  else throw fail('invalid-selection', 'Unknown selection kind.');
  return goal;
}
export function setHostIntent(blueprint, { kind, runtime = null, framework = null }) {
  if (!HOST_INTENTS.includes(kind)) throw fail('invalid-host-intent', 'Unknown host intent.');
  blueprint.hostIntent = { kind, runtime: runtime ? String(runtime).slice(0, 40) : null, framework: framework ? String(framework).slice(0, 40) : null };
}
/** Agent output lives only here. Accepting a suggestion is a separate, explicit person action. */
export function recordAgentAdvice(blueprint, advice) {
  blueprint.agentAdvice = advice ? { advisory: true, authoritative: false, task: advice.task || null, provider: advice.provider || null, model: advice.model || null, value: advice.value || null, receivedAt: advice.receivedAt || null } : null;
}

// ---------------------------------------------------------------------------------------------
// Candidates from Capability Memory (the bank, then the index) with deterministic evidence tiers.
// ---------------------------------------------------------------------------------------------
function atlasFamilies(capabilityId, atlasDirectory) {
  const families = new Map();
  for (const e of loadAtlas(atlasDirectory ? { directory: atlasDirectory } : {})) {
    if (e.capabilityId !== capabilityId) continue;
    const key = `${e.destinationArchitecture?.framework || '?'}/${e.destinationArchitecture?.handlerContract || '?'}`;
    const f = families.get(key) || { destination: key, verified: 0, failed: 0, other: 0 };
    const v = e.verification?.verdict; if (v === 'VERIFIED') f.verified += 1; else if (v === 'FAILED') f.failed += 1; else f.other += 1;
    families.set(key, f);
  }
  return [...families.values()].sort((a, b) => a.destination.localeCompare(b.destination));
}
const PROFILE_FAMILY = { 'esm-node-http-central': 'node-http/node-res', 'express-req-res': 'express/express-req-res', 'esm-return-response': 'node-http/return-response' };
function hostEvidence(kind, families) {
  return SUPPORTED_PROFILES.filter((p) => p.kinds.includes(kind)).map((p) => { const f = families.find((x) => x.destination === PROFILE_FAMILY[p.id]); return { profile: p.id, family: PROFILE_FAMILY[p.id], verified: f?.verified || 0, failed: f?.failed || 0, status: f?.verified ? 'verified-evidence' : 'verified-evidence-unavailable' }; });
}
function originOf(manifest, sourceRoot) {
  const licence = detectLicense(sourceRoot);
  return { project: manifest.identity.sourceProject, kind: licence.state === 'detected' && licence.declared && !/UNLICENSED/i.test(licence.declared) ? 'open-source' : 'your-project', licence: { state: licence.state, declared: licence.declared, warning: licence.warning } };
}
/** Everything GRAFT knows about a banked capability, from its own artifacts. */
export function organCandidate(entry, { atlasDirectory = null } = {}) {
  if (entry.error) return null;
  const m = entry.manifest;
  const engine = (() => { try { return readOrganEngine(entry.dir); } catch { return null; } })();
  const kind = engine?.genome?.identity?.kind || m.architecture?.capabilityModel?.kind || null;
  const capabilityId = engine?.genome?.identity?.capabilityId || null;
  const families = capabilityId ? atlasFamilies(capabilityId, atlasDirectory) : [];
  const verified = m.provenance?.verifiedInSource?.verdict === 'VERIFIED';
  const sourceRoot = m.identity.sourceProjectRoot && fs.existsSync(m.identity.sourceProjectRoot) ? m.identity.sourceProjectRoot : null;
  const tier = verified && families.some((f) => f.verified) ? 'best-evidence' : verified ? 'strong' : 'possible';
  return {
    kind: 'organ', slug: m.identity.slug, name: m.identity.name, category: m.identity.category, capabilityKind: kind, capabilityId, genomeId: engine?.genome?.genomeId || null, irId: engine?.ir?.irId || null, contractId: engine?.verificationContract?.contractId || null,
    tier, tierReason: tier === 'best-evidence' ? `source VERIFIED and ${families.filter((f) => f.verified).length} verified transplant famil${families.filter((f) => f.verified).length === 1 ? 'y' : 'ies'}` : tier === 'strong' ? 'source VERIFIED, no transplant evidence yet' : 'harvested but not verified in source',
    implementationForm: m.identity?.implementationForm || null,
    // A library's behaviour can be verified while no destination integration exists for its form.
    // Those are different claims, and the candidate says both. Where an integration DOES exist, it
    // is named by the adaptation authority, so this can never claim more or less than what is proven.
    integration: m.identity?.implementationForm === 'library' ? describeLibraryIntegration({ kind: m.identity.category }) : { supported: true, reason: null },
    verification: { source: m.provenance?.verifiedInSource?.verdict || 'UNVERIFIED', summary: m.provenance?.verifiedInSource?.summary || null, families, hostEvidence: kind ? hostEvidence(kind, families) : [] },
    architecture: m.provenance?.capabilitySource?.architecture || null,
    model: m.architecture?.capabilityModel ? { credentialAuthority: m.architecture.capabilityModel.credentialAuthority?.kind || null, provider: m.architecture.capabilityModel.provider?.provider || null, session: m.architecture.capabilityModel.session ? { transport: m.architecture.capabilityModel.session.transport, custody: m.architecture.capabilityModel.session.custody, store: m.architecture.capabilityModel.session.store, durableAcrossRestart: m.architecture.capabilityModel.session.durableAcrossRestart === true } : null } : null,
    operations: (engine?.ir?.operations || []).map((op) => ({ id: op.id, role: op.role, method: op.method, path: op.path })),
    provides: goalProvidesFor(m.identity.category, engine?.ir),
    configurationNames: (m.environment?.variables || []).map((v) => v.name),
    dependencies: { packages: (m.dependencies?.packages || []).map((p) => (typeof p === 'string' ? p : p.name)), services: (m.dependencies?.services || []).map((s) => ({ name: s.name, role: s.role, required: s.required === true })), runtime: (m.dependencies?.runtime || []).map((r) => `${r.name} ${r.range || ''}`.trim()) },
    origin: originOf(m, sourceRoot), sourceAvailable: Boolean(sourceRoot),
  };
}
function goalProvidesFor(category, ir) {
  const provides = new Set();
  for (const [goal, def] of Object.entries(GOAL_CATEGORIES)) if ((def.memory || []).includes(category)) def.provides.forEach((p) => provides.add(p));
  if (ir?.policies?.session) provides.add('session');
  return [...provides];
}
function observationCandidate(result) {
  const state = result.state || result.capability?.state;
  // Unharvested code is at most a possible candidate: nothing has been verified about it yet.
  const usable = result.transplantSupport === 'supported' || result.harvestable || state === 'TRANSPLANTABLE' || state === 'HARVESTABLE';
  const tier = usable ? 'possible' : 'unproven';
  return { kind: 'observation', projectId: result.projectId, capability: result.capability, name: `${result.project?.name || result.projectId}`, category: result.capability, capabilityKind: null, capabilityId: null,
    tier, tierReason: usable ? `${state === 'TRANSPLANTABLE' || result.transplantSupport === 'supported' ? 'transplantable' : 'harvestable'} in Capability Memory, not yet harvested — harvest it to gain evidence` : `${state || 'observed'} in Capability Memory; not harvestable yet`,
    verification: { source: 'NOT_HARVESTED', summary: null, families: [], hostEvidence: [] }, state, subtypes: result.subtypes || [], audience: result.audience || null, signalCount: result.signalCount || 0,
    project: { name: result.project?.name, repository: result.project?.repository, language: result.project?.language, runtime: result.project?.runtime, framework: result.project?.framework, moduleSystem: result.project?.moduleSystem },
    provides: goalProvidesFor(result.capability, null), operations: [], configurationNames: [], dependencies: { packages: [], services: [], runtime: [] },
    origin: { project: result.project?.name || null, kind: 'workspace-observation', licence: { state: 'not-inspected', declared: null, warning: 'Licence metadata is inspected when the capability is harvested.' } }, sourceAvailable: true };
}
const TIER_ORDER = { 'best-evidence': 0, strong: 1, possible: 2, unproven: 3 };
/** Candidate implementations for a goal category, best evidence first. Deterministic; no model. */
export function candidatesFor(category, { bank = null, index = null, atlasDirectory = null, includeNonProduction = false } = {}) {
  const def = GOAL_CATEGORIES[category];
  if (!def) return { candidates: [], searched: false, reason: 'unknown goal category' };
  if (!def.memory) return { candidates: [], searched: false, reason: `GRAFT has no detector for ${def.label.toLowerCase()} yet` };
  const organs = (bank || listOrganBank(bankDir())).map((e) => organCandidate(e, { atlasDirectory })).filter((c) => c && def.memory.includes(c.category));
  const seen = new Set(organs.map((c) => c.slug));
  const observations = [];
  for (const memoryCategory of def.memory) {
    const loaded = index || loadIndex();
    const { results } = searchCapabilities({ text: '', capability: memoryCategory === 'hosted-authentication' ? 'authentication' : memoryCategory, ...(includeNonProduction ? { includeNonProduction: true } : {}) }, { index: loaded, limit: 25 });
    for (const r of results) {
      const key = `${r.projectId}:${r.capability}`; if (seen.has(key)) continue; seen.add(key);
      const candidate = observationCandidate(r);
      // The same project may already be in the bank as a harvested organ; say so instead of inviting a second harvest.
      const harvested = organs.find((o) => o.origin.project && o.origin.project === r.project?.name);
      if (harvested) candidate.tierReason = `${candidate.tierReason}; this project is already harvested as "${harvested.name}" — that entry carries the evidence`;
      observations.push(candidate);
    }
  }
  const candidates = [...organs, ...observations].sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || (b.verification.families.reduce((n, f) => n + f.verified, 0) - a.verification.families.reduce((n, f) => n + f.verified, 0)) || (b.signalCount || 0) - (a.signalCount || 0) || a.name.localeCompare(b.name));
  return { candidates, searched: true, reason: null };
}

// ---------------------------------------------------------------------------------------------
// Analysis: dependencies, conflicts, readiness — derived from GRAFT data every time it is asked.
// ---------------------------------------------------------------------------------------------
function resolveSelection(goal, options) {
  const sel = goal.selection; if (!sel) return null;
  if (sel.kind === 'organ') {
    const entry = (options.bank || listOrganBank(bankDir())).find((e) => !e.error && e.manifest.identity.slug === sel.slug);
    const c = entry ? organCandidate(entry, { atlasDirectory: options.atlasDirectory }) : null;
    if (!c || (sel.capabilityId && c.capabilityId !== sel.capabilityId)) return { ...(c || { kind: 'organ', slug: sel.slug, name: sel.name || sel.slug }), status: 'SOURCE_UNAVAILABLE', unavailableReason: !c ? 'the harvested capability is no longer in the organ bank' : 'the capability in the bank is not the one this blueprint selected (capability id differs)', provides: [], operations: [], verification: { source: 'UNKNOWN', families: [], hostEvidence: [] }, origin: c?.origin || { project: sel.name || sel.slug, kind: 'unknown', licence: { state: 'not-detected', declared: null, warning: null } } };
    return { ...c, status: 'AVAILABLE' };
  }
  const loaded = options.index || loadIndex();
  const project = (loaded.projects || []).find((p) => p.projectId === sel.projectId);
  const capability = project?.capabilities?.find((c) => c.capability === sel.capability);
  if (!project || !capability) return { kind: 'observation', projectId: sel.projectId, capability: sel.capability, name: sel.name || sel.projectId, status: 'SOURCE_UNAVAILABLE', unavailableReason: 'the observed project or capability is no longer in the workspace index', provides: [], operations: [], verification: { source: 'UNKNOWN', families: [], hostEvidence: [] }, origin: { project: sel.name || null, kind: 'workspace-observation', licence: { state: 'not-inspected', declared: null, warning: null } } };
  const { results } = searchCapabilities({ text: '', capability: sel.capability === 'hosted-authentication' ? 'authentication' : sel.capability, projectId: sel.projectId, includeNonProduction: true }, { index: loaded, limit: 5 });
  const r = results.find((x) => x.projectId === sel.projectId && x.capability === sel.capability);
  return { ...(r ? observationCandidate(r) : observationCandidate({ projectId: sel.projectId, capability: sel.capability, project, state: capability.state })), status: 'AVAILABLE' };
}
export function analyseBlueprint(blueprint, options = {}) {
  const goals = blueprint.goals.map((g) => {
    const def = g.category ? GOAL_CATEGORIES[g.category] : null;
    const lookup = g.category ? candidatesFor(g.category, options) : { candidates: [], searched: false, reason: 'no category for this goal' };
    const selected = resolveSelection(g, options);
    const status = selected ? (selected.status === 'SOURCE_UNAVAILABLE' ? 'source-unavailable' : 'matched') : lookup.candidates.length ? 'unresolved' : 'missing';
    return { ...g, definition: def ? { label: def.label, provides: def.provides, requires: def.requires } : null, candidates: lookup.candidates, searched: lookup.searched, searchReason: lookup.reason, selected, status };
  });
  // Dependencies: DECLARED by GRAFT's goal vocabulary; INFERRED from a selected implementation's
  // own artifacts (its external services and configuration); PROVEN only when an Atlas observation
  // covers the pair (none exist in 0.1 — the level is reported honestly as absent); ADVISORY from
  // the agent's hints; UNKNOWN for goals GRAFT has no vocabulary for.
  const provided = new Map();
  for (const g of goals) { const p = g.selected && g.selected.status === 'AVAILABLE' ? g.selected.provides : []; for (const cap of p) provided.set(cap, g); }
  const dependencies = [];
  for (const g of goals) {
    if (!g.definition) { dependencies.push({ from: g.goalId, fromLabel: g.label, needs: null, level: 'UNKNOWN', satisfied: null, detail: 'GRAFT has no dependency vocabulary for this goal' }); continue; }
    for (const need of g.definition.requires) {
      const by = provided.get(need);
      const needGoal = goals.find((x) => x.definition?.provides.includes(need));
      dependencies.push({ from: g.goalId, fromLabel: g.label, needs: need, needsLabel: CAPABILITY_LABEL[need] || need, level: 'DECLARED', satisfied: Boolean(by), satisfiedBy: by ? { goalId: by.goalId, label: by.label, implementation: by.selected.name } : null, detail: needGoal ? (by ? `provided by the ${by.label} selection` : `the ${needGoal.label} goal has no selected implementation yet`) : `no goal in this blueprint provides ${CAPABILITY_LABEL[need] || need}`, blocking: g.required && !by });
    }
    if (g.selected?.status === 'AVAILABLE') {
      for (const svc of g.selected.dependencies?.services || []) dependencies.push({ from: g.goalId, fromLabel: g.label, needs: `service:${svc.name}`, needsLabel: `external service ${svc.name} (${svc.role})`, level: 'INFERRED', satisfied: null, detail: 'declared by the harvested capability; supplied by configuration, not by another capability', blocking: false });
    }
  }
  for (const hint of blueprint.agentAdvice?.value?.dependencyHints || []) dependencies.push({ from: null, fromLabel: hint.from, needs: null, needsLabel: hint.to, level: 'ADVISORY', satisfied: null, detail: hint.reason || 'suggested by the agent; not a fact', blocking: false });
  // Conflicts: only where GRAFT holds structural evidence.
  const conflicts = [];
  const available = goals.filter((g) => g.selected?.status === 'AVAILABLE').map((g) => ({ goal: g, impl: g.selected }));
  for (let i = 0; i < available.length; i += 1) for (let j = i + 1; j < available.length; j += 1) {
    const a = available[i], b = available[j];
    const routes = new Set(a.impl.operations.map((o) => `${o.method} ${o.path}`));
    const shared = b.impl.operations.filter((o) => routes.has(`${o.method} ${o.path}`)).map((o) => `${o.method} ${o.path}`);
    if (shared.length) conflicts.push({ kind: 'exclusive-route', between: [a.goal.goalId, b.goal.goalId], labels: [a.goal.label, b.goal.label], detail: `both implementations register ${shared.join(', ')}`, options: ['choose another implementation for one of them', 'mark one goal optional and remove its selection'] });
    if (a.impl.model?.session && b.impl.model?.session) conflicts.push({ kind: 'session-ownership', between: [a.goal.goalId, b.goal.goalId], labels: [a.goal.label, b.goal.label], detail: 'both implementations own user sessions (cookie custody); an application has one session owner', options: ['choose one implementation to own sessions'] });
    if (a.impl.model?.credentialAuthority && b.impl.model?.credentialAuthority && a.impl.model.credentialAuthority !== b.impl.model.credentialAuthority) conflicts.push({ kind: 'credential-authority', between: [a.goal.goalId, b.goal.goalId], labels: [a.goal.label, b.goal.label], detail: `${a.impl.model.credentialAuthority} versus ${b.impl.model.credentialAuthority} credential authority`, options: ['choose implementations that agree on where credentials are validated'] });
    if (a.impl.architecture?.moduleSystem && b.impl.architecture?.moduleSystem && a.impl.architecture.moduleSystem !== b.impl.architecture.moduleSystem) conflicts.push({ kind: 'module-system', between: [a.goal.goalId, b.goal.goalId], labels: [a.goal.label, b.goal.label], detail: `${a.impl.architecture.moduleSystem} versus ${b.impl.architecture.moduleSystem} source module systems; GRAFT regenerates for the host, so this is a note for assembly, not a blocker`, options: [], blocking: false });
  }
  const byCategory = new Map();
  for (const g of goals) if (g.category) { if (byCategory.has(g.category)) conflicts.push({ kind: 'duplicate-goal', between: [byCategory.get(g.category).goalId, g.goalId], labels: [byCategory.get(g.category).label, g.label], detail: 'two goals ask for the same capability category', options: ['merge the goals'] }); else byCategory.set(g.category, g); }
  if (blueprint.hostIntent?.runtime && blueprint.hostIntent.runtime !== 'node') for (const { goal, impl } of available) if (impl.kind === 'organ') conflicts.push({ kind: 'runtime', between: [goal.goalId], labels: [goal.label], detail: `the implementation is regenerated for Node; the host intent says ${blueprint.hostIntent.runtime}`, options: ['choose a Node host, or decide the host later'] });
  for (const g of goals) if (g.status === 'source-unavailable') conflicts.push({ kind: 'source-unavailable', between: [g.goalId], labels: [g.label], detail: g.selected.unavailableReason, options: ['choose another implementation', 'restore the capability to the organ bank'] });
  const blockingConflicts = conflicts.filter((c) => c.blocking !== false);
  const required = goals.filter((g) => g.required);
  const readiness = !goals.length ? 'DRAFT'
    : blockingConflicts.length ? 'HAS_CONFLICTS'
      : required.some((g) => g.status === 'missing') ? 'MISSING_CAPABILITIES'
        : required.some((g) => g.status !== 'matched') || dependencies.some((d) => d.blocking) ? 'NEEDS_SELECTIONS'
          : 'READY_FOR_ASSEMBLY_PLANNING';
  const readinessReason = { DRAFT: 'no capability goals yet', HAS_CONFLICTS: `${blockingConflicts.length} structural conflict(s) need a decision`, MISSING_CAPABILITIES: `${required.filter((g) => g.status === 'missing').length} required goal(s) have no implementation in Capability Memory`, NEEDS_SELECTIONS: `${required.filter((g) => g.status !== 'matched').length} required goal(s) without a selected implementation${dependencies.some((d) => d.blocking) ? '; a declared dependency is unmet' : ''}`, READY_FOR_ASSEMBLY_PLANNING: 'every required goal has a selected implementation, no declared dependency is unmet and no structural conflict is known — this is not a compatibility or verification claim' }[readiness];
  const provenance = { origins: Object.fromEntries(available.map(({ goal, impl }) => [goal.goalId, impl.origin])), licenceStates: [...new Set(available.map(({ impl }) => impl.origin?.licence?.state).filter(Boolean))] };
  return { goals, dependencies, conflicts, readiness, readinessReason, provenance, dependencyLevelsPresent: [...new Set(dependencies.map((d) => d.level))], provenLevelAvailable: false, authority: { deterministic: true, agentDecided: false }, analysedAt: null };
}
/** A blueprint as the product shows it: stored decisions plus fresh analysis, clearly separated. */
export function viewBlueprint(blueprint, options = {}) { return { ...blueprint, analysis: analyseBlueprint(blueprint, options) }; }
