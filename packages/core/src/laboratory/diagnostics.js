// Commercial Beta Readiness 0.1, Checkpoint A — the diagnostic bundle a customer can send to
// LeftSock Labs when something goes wrong. Local only: GRAFT never uploads it.
//
// Pipeline, in this order and no other: collect KNOWN support facts (never the environment, never
// repository contents, never licence or provider values) → redact with the product's existing
// secret redactor → scrub machine paths → validate with the product's existing leak detector plus
// a secret-shaped-key check → package as a ZIP with the project's own zip writer. Validation
// failure is fatal: no bundle rather than a bundle that might carry a secret.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graftHome } from '../registry/index.js';
import { redactSecrets, findSecretLeaks } from '../manifest/schema.js';
import { zipBuffer } from '../export/index.js';
import { loadExecution, listExecutions, TERMINAL_STATES } from './execution.js';
import { loadAssemblyWorkspace, evaluateWorkspace, listAssemblyWorkspaces } from './continuity.js';
import { loadAssemblyPlan } from './assembly.js';
import { getTransplant } from '../apply/worktree.js';
import { proofIntegrity, loadProofArtifact } from './proof-store.js';
import { assessRecovery, describeFailure } from './recovery.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
export const DIAGNOSTICS_SCHEMA = 'graft-diagnostics/1';
const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|license[_-]?key|licence[_-]?key|cookie|authorization|credential)/i;
const LICENSE_KEY = /\bGRAFT-(?:[A-Z0-9]{4,5}-){3,4}[A-Z0-9]{4,5}\b/; // the licensing registry's GRAFT-XXXX-XXXX-XXXX-XXXX-XXXX (and the older 5-group shape)
const CREDENTIAL_SHAPES = [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, /\bsb[p_][A-Za-z0-9_]{20,}\b/, /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/, /\bwhsec_[A-Za-z0-9]{8,}\b/, /\b(?:Bearer|Basic) [A-Za-z0-9._~+/=-]{16,}\b/i];

/** Machine paths become stable placeholders; the structure of a path survives, the identity does not. */
export function scrubPaths(value, { home = graftHome(), user = os.homedir(), tmp = os.tmpdir() } = {}) {
  const replace = (s) => { let out = s; for (const [needle, token] of [[home, '$GRAFT_HOME'], [tmp, '$TMPDIR'], [user, '~']]) if (needle && needle.length > 1) out = out.split(needle).join(token); return out; };
  const walk = (node) => (typeof node === 'string' ? replace(node) : Array.isArray(node) ? node.map(walk) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)])) : node);
  return walk(value);
}

/** The leak check the bundle must pass: the product's patterns, plus secret-shaped keys, licence keys and credential shapes. */
export function findDiagnosticLeaks(value, at = '$') {
  const leaks = findSecretLeaks(value, at).map((l) => ({ at: l.at, reason: `matches ${l.pattern}` }));
  const walk = (node, where) => {
    if (typeof node === 'string') { if (LICENSE_KEY.test(node)) leaks.push({ at: where, reason: 'looks like a GRAFT licence key' }); for (const shape of CREDENTIAL_SHAPES) if (shape.test(node)) leaks.push({ at: where, reason: `looks like a credential (${shape.source.slice(0, 24)}…)` }); return; }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${where}[${i}]`));
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (SECRET_KEY.test(k) && typeof v === 'string' && v.length) leaks.push({ at: `${where}.${k}`, reason: 'secret-shaped key with a value' }); walk(v, `${where}.${k}`); }
  };
  walk(value, at);
  return leaks;
}

const stepSummary = (s) => ({ stepId: s.stepId, order: s.order, type: s.type, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, error: s.error || null, outcome: s.outcome && typeof s.outcome === 'object' ? Object.fromEntries(Object.entries(s.outcome).filter(([k, v]) => ['verdict', 'passed', 'required', 'revision', 'tests', 'failed', 'captured', 'filesWritten', 'hostId', 'profile', 'stepsFailed'].includes(k) && (typeof v !== 'object' || Array.isArray(v)))) : null });
function executionFacts(e, { running = false } = {}) {
  return {
    executionId: e.executionId, planId: e.planId, blueprintId: e.blueprintId, blueprintName: e.blueprintName, status: e.status, finalState: e.finalState, startedAt: e.startedAt, finishedAt: e.finishedAt, currentStep: e.currentStep,
    host: e.host ? { architectureId: e.host.architectureId || e.host.hostArchitectureId || null, profile: e.host.profile || null, projectName: e.host.projectName || null, destinationParent: e.host.destinationParent || null } : null,
    error: e.error || null, failure: TERMINAL_STATES.includes(e.status) && e.status !== 'COMPLETED' ? describeFailure({ ...(e.error || {}), status: e.status }) : null,
    recovery: assessRecovery(e, { running }), recoveryHistory: e.recovery || [],
    steps: (e.steps || []).map(stepSummary),
    verification: e.verification ? { capability: e.verification.capability, verdict: e.verification.verdict, summary: e.verification.summary || null, rationale: e.verification.rationale || null } : null,
    hostPreservation: e.hostPreservation || null,
    composition: e.composition ? { finalState: e.composition.finalState, finalRevision: e.composition.finalRevision, capabilities: (e.composition.capabilities || []).map((c) => ({ capability: c.capability, initialVerdict: c.initialVerdict, reverifiedVerdict: c.reverifiedVerdict, finalVerdict: c.finalVerdict, finalSummary: c.finalSummary || null, appliedRevision: c.appliedRevision })), proofs: e.composition.proofs || [], reverifications: e.composition.reverifications || [] } : null,
    finalSummary: e.finalSummary || null, assemblyWorkspaceId: e.assemblyWorkspaceId || null, assembledRevision: e.assembledRevision || null, transplantId: e.transplantId || null,
    proofReferences: (e.proofReferences || []).map((r) => ({ kind: r.kind, contractId: r.contractId || null, envelopeDigest: r.envelopeDigest || null })), proof: e.proof || null,
  };
}
function workspaceFacts(id) {
  const workspace = loadAssemblyWorkspace(id);
  const evaluated = evaluateWorkspace(workspace);
  return {
    assemblyWorkspaceId: workspace.assemblyWorkspaceId, status: evaluated.status, currentRevision: workspace.currentRevision, baseRevision: workspace.baseRevision, executionIds: workspace.executionIds || [],
    capabilities: (evaluated.capabilities || []).map((c) => ({ capability: c.capability, capabilityId: c.capabilityId, state: c.state, stateReason: c.stateReason, implementationForm: c.implementationForm, verificationVerdict: c.verificationVerdict, verificationSummary: c.verificationSummary || null, currentVerifiedRevision: c.currentVerifiedRevision, destinationRevisionAfter: c.destinationRevisionAfter, sourceRevision: c.sourceRevision || null, proofReference: c.proofReference || null, proofIntegrity: proofIntegrity(c), verificationHistory: c.verificationHistory || [] })),
    promotion: workspace.promotion || null,
  };
}
function transplantFacts(id) {
  try { const t = getTransplant(id); return { id: t.id, state: t.state, capability: t.capability || null, worktreeBranch: t.worktree?.branch || null, live: t.live || null, verdict: t.verdict?.verdict || null, rationale: t.verdict?.rationale || null }; }
  catch { return { id, state: 'unknown' }; }
}

/**
 * Collect the diagnostic facts for a situation: an execution, its assembly workspace (if any), the
 * plan's identity, the transplant record, the proof integrity of every cited proof (and, when the
 * proofs are intact, the proof artifacts themselves — they contain no secrets by construction), the
 * tail of the app log if the caller has one, and the product/platform identity.
 */
export function collectDiagnostics({ executionId = null, assemblyWorkspaceId = null, planId = null, version = null, platform = null, appLog = null, running = new Set(), now = () => new Date().toISOString() } = {}) {
  const facts = { schema: DIAGNOSTICS_SCHEMA, createdAt: now(), graft: { version, platform: platform || { os: os.platform(), arch: os.arch(), release: os.release(), node: process.versions.node } }, execution: null, executions: [], assembly: null, plan: null, transplant: null, proofs: [], appLog: null, notes: [] };
  const proofFiles = {};
  let execution = null;
  if (executionId) { execution = loadExecution(executionId); facts.execution = executionFacts(execution, { running: running.has(executionId) }); }
  const wsId = assemblyWorkspaceId || execution?.assemblyWorkspaceId || null;
  if (wsId) { try { facts.assembly = workspaceFacts(wsId); } catch (err) { facts.notes.push(`assembly ${wsId} could not be read: ${err.message}`); } }
  const pId = planId || execution?.planId || null;
  if (pId) { try { const plan = loadAssemblyPlan(pId); facts.plan = { planId: plan.planId, blueprintId: plan.blueprintId, blueprintName: plan.blueprintName, readiness: plan.readiness, host: plan.host ? { architectureId: plan.host.architectureId || null, profile: plan.host.profile || null, kind: plan.host.kind || null } : null, steps: (plan.steps || []).map((s) => ({ stepId: s.stepId, order: s.order, type: s.type, capability: s.capability?.slug || null })) }; } catch (err) { facts.notes.push(`plan ${pId} could not be read: ${err.message}`); } }
  if (execution?.transplantId) facts.transplant = transplantFacts(execution.transplantId);
  // Sibling executions of the same plan, briefly: a retry history is support context.
  if (pId) facts.executions = listExecutions({ planId: pId }).map((x) => ({ executionId: x.executionId, status: x.status, startedAt: x.startedAt, finishedAt: x.finishedAt || null }));
  // Proof integrity for every cited proof; intact artifacts travel with the bundle.
  const digests = new Set([...(facts.assembly?.capabilities || []).map((c) => c.proofReference?.envelopeDigest), ...(facts.execution?.composition?.proofs || []).map((p) => p.envelopeDigest), facts.execution?.proof?.envelopeDigest].filter(Boolean));
  for (const digest of digests) {
    const stored = loadProofArtifact(digest);
    facts.proofs.push({ digest, found: stored.found, intact: stored.intact, reasons: stored.reasons });
    if (stored.intact) proofFiles[`proofs/graft-proof-${digest}.json`] = JSON.stringify(stored.envelope, null, 2) + '\n';
  }
  if (typeof appLog === 'string' && appLog.length) facts.appLog = appLog.split('\n').slice(-400).join('\n');
  if (!executionId && !wsId && !pId) { facts.executions = listExecutions().slice(0, 10).map((x) => ({ executionId: x.executionId, planId: x.planId, status: x.status, startedAt: x.startedAt })); facts.assemblies = listAssemblyWorkspaces().slice(0, 10).map((w) => ({ assemblyWorkspaceId: w.assemblyWorkspaceId, status: w.status || null })); }
  return { facts, files: proofFiles };
}

/** Redact, scrub, validate (fail closed), package. Returns the ZIP bytes and its manifest. */
export function packageDiagnostics({ facts, files = {} }) {
  const safeFacts = scrubPaths(redactSecrets(facts));
  const safeFiles = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, scrubPaths(redactSecrets(String(text)))]));
  const leaks = [...findDiagnosticLeaks(safeFacts, 'diagnostics'), ...Object.entries(safeFiles).flatMap(([name, text]) => findDiagnosticLeaks(text, name))];
  if (leaks.length) throw fail('diagnostics-unsafe', `The diagnostic bundle was not created: ${leaks.length} value(s) still look like secrets (${leaks.map((l) => l.at).slice(0, 3).join(', ')}).`);
  const entries = { 'diagnostics.json': Buffer.from(JSON.stringify(safeFacts, null, 2) + '\n'), 'README.txt': Buffer.from(readme(safeFacts)), ...Object.fromEntries(Object.entries(safeFiles).map(([name, text]) => [name, Buffer.from(text)])) };
  return { bytes: zipBuffer(entries), entries: Object.keys(entries).sort(), facts: safeFacts };
}
function readme(facts) {
  return `GRAFT diagnostic bundle (${facts.schema})\n\nCreated ${facts.createdAt} by GRAFT ${facts.graft.version || 'unknown'} on ${facts.graft.platform?.os || '?'} ${facts.graft.platform?.arch || ''}.\n\nThis bundle was saved locally by the person using GRAFT and contains only support facts: execution status and steps, the assembly ledger, verification summaries, proof integrity, and any intact proof artifacts. Secrets are never collected; machine paths are replaced by placeholders; no source code or repository contents are included. GRAFT never uploads it — send it to LeftSock Labs yourself if you want help.\n${facts.execution?.failure ? `\nWhat happened: ${facts.execution.failure.title} ${facts.execution.failure.next}\n` : ''}`;
}

/** The customer-facing file name: derived from the situation, never from a path. */
export const diagnosticsFileName = ({ executionId = null, assemblyWorkspaceId = null } = {}) => `graft-diagnostics-${(executionId || assemblyWorkspaceId || 'workspace').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50)}.zip`;

/** Collect, package and write to `destination` (a directory or a .zip path). Returns { file, bytes, entries }. */
export function saveDiagnostics(options, destination) {
  const packaged = packageDiagnostics(collectDiagnostics(options));
  const isDir = fs.existsSync(destination) && fs.statSync(destination).isDirectory();
  const file = isDir ? path.join(destination, diagnosticsFileName(options)) : destination;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, packaged.bytes);
  return { file, bytes: packaged.bytes.length, entries: packaged.entries, failure: packaged.facts.execution?.failure || null };
}
