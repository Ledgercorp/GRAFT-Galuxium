// Laboratory 0.2 — Assembly Planning.
//
// A blueprint says what the software should do. An assembly plan says how GRAFT would build it
// from the selected capabilities, step by step, using the operations GRAFT already has: fingerprint
// → host model → transplant plan → prepare (worktree) → apply → verify → proof. This module only
// DESCRIBES those steps. It never performs them: no folders, no repositories, no worktrees, no
// destination writes, no package installs, no verification runs. The one thing it writes is the
// plan itself, under GRAFT_HOME/laboratory/plans.
//
// Authority. The planner alone decides whether a blueprint may proceed, what host information is
// still needed, the capability order, the structural blockers, which existing operation each
// step names, and whether that step is supported. "Supported" is structural: the organ artifact
// exists with its engine artifacts, its kind has an emitter for the host's profile, and GRAFT has
// an operation to apply and verify it. Atlas history explains and warns; it never decides.
// An agent may explain a plan (see `recordPlanAdvice`); its words live under `agentAdvice` and
// change nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { graftHome, bankDir } from '../registry/index.js';
import { readOrganEngine, readManifest } from '../manifest/io.js';
import { loadIndex } from '../workspace/store.js';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { buildHostModel } from '../engine/host.js';
import { SUPPORTED_PROFILES } from '../emit/profiles.js';
import { stableHash } from '../capability/contract.js';
import { analyseBlueprint } from './index.js';
import { libraryHostAdaptationSupport, destinationVerificationContract } from '../adapt/library-host.js';

export const ASSEMBLY_SCHEMA_VERSION = '1.0.0';
export const PLAN_READINESS = Object.freeze(['DRAFT', 'BLOCKED_BLUEPRINT', 'NEEDS_HOST', 'UNSUPPORTED_HOST', 'BLOCKED_DEPENDENCIES', 'BLOCKED_CAPABILITY_SUPPORT', 'READY_TO_ASSEMBLE']);
export const STEP_TYPES = Object.freeze(['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'VERIFY_SOURCE_ARTIFACT_IDENTITY', 'TRANSPLANT_CAPABILITY', 'ADAPT_LIBRARY_CAPABILITY', 'VERIFY_CAPABILITY', 'REVERIFY_CAPABILITY', 'CHECK_HOST_PRESERVATION', 'FINAL_VERIFICATION']);
/** The steps that apply a capability: a service transplant or a library adaptation. */
export const APPLYING_STEP_TYPES = Object.freeze(['TRANSPLANT_CAPABILITY', 'ADAPT_LIBRARY_CAPABILITY']);
/** How independent capabilities are ordered. Stated once, so the plan and the execution can both cite it. */
export const ORDERING_RULE = Object.freeze({ rule: 'blueprint-declared-order', detail: 'capabilities are applied in the order the blueprint declares them; a DECLARED dependency edge overrides that order, and nothing else does' });
const fail = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------------------------
// Host strategies. A new application can only start from a shape GRAFT's emitters already write
// for and that a real transplant has already proven. Both come straight from the profile table;
// nothing here adds a profile.
// ---------------------------------------------------------------------------------------------
export const NEW_HOST_ARCHITECTURES = Object.freeze([
  { id: 'node-esm-http-central', label: 'Node / ESM / bare node:http (one central handler)', runtime: 'node', moduleSystem: 'esm', framework: 'node-http', handlerContract: 'node-res', profile: 'esm-node-http-central', persistence: 'none', provenBy: 'real transplants into a node:http destination (Engine 1.2, Workflow 0.1, Real Product Demo 0.1)' },
  { id: 'node-esm-express', label: 'Node / ESM / Express', runtime: 'node', moduleSystem: 'esm', framework: 'express', handlerContract: 'express-req-res', profile: 'express-req-res', persistence: 'none', provenBy: 'real transplant into an Express destination (Real-World Transplant 2B)' },
].map((a) => ({ ...a, kinds: SUPPORTED_PROFILES.find((p) => p.id === a.profile)?.kinds || [] })));

/** The host specification for a new blank application: a description, not a folder. */
export function newHostSpecification(architectureId) {
  const a = NEW_HOST_ARCHITECTURES.find((x) => x.id === architectureId);
  if (!a) throw fail('unknown-architecture', `GRAFT cannot start a new application as "${architectureId}"; supported: ${NEW_HOST_ARCHITECTURES.map((x) => x.id).join(', ')}.`);
  const spec = { kind: 'new-application', architectureId: a.id, label: a.label, runtime: { family: a.runtime, range: '>=20' }, moduleSystem: a.moduleSystem, framework: a.framework, handlerContract: a.handlerContract, persistence: a.persistence, profile: a.profile, profilesByKind: Object.fromEntries(a.kinds.map((k) => [k, a.profile])), provenBy: a.provenBy, exists: false, status: 'SPECIFIED_NOT_CREATED' };
  spec.hostId = stableHash({ assembly: ASSEMBLY_SCHEMA_VERSION, spec: { architectureId: a.id, runtime: spec.runtime, moduleSystem: a.moduleSystem, framework: a.framework, handlerContract: a.handlerContract, persistence: a.persistence } });
  return spec;
}

/** The host for an existing project: GRAFT's own Host Model, read from the project, kept by id. */
export function existingHostSpecification(projectId, { index = null, project = null } = {}) {
  const loaded = project ? { projects: [project] } : index || loadIndex();
  project = (loaded.projects || []).find((p) => p.projectId === projectId);
  if (!project) throw fail('unknown-project', `Project ${projectId} is not in the workspace index.`);
  if (!fs.existsSync(project.root)) throw fail('project-missing', `The project folder for ${project.name} is no longer present.`);
  const host = buildHostModel(fingerprintProject(project.root));
  return {
    kind: 'existing-project', projectId, name: project.name, hostId: host.hostId, hostModelVersion: host.hostModelVersion,
    runtime: { family: host.runtime.family, range: host.runtime.range }, moduleSystem: host.moduleSystem.value, framework: host.framework.value, handlerContract: host.constraints.handlerContract.value,
    persistence: host.dataLayer.persistence, profile: host.constraints.adaptationProfile, profilesByKind: host.constraints.profilesByKind, unsupportedReason: host.constraints.unsupportedReason,
    entrypoint: host.runtime.entrypoint, existingCapabilities: host.existingCapabilities.map((c) => c.category), routes: host.routing.routes.length, exists: true, status: 'EXISTING',
  };
}

// ---------------------------------------------------------------------------------------------
// Ordering: a deterministic DAG over the blueprint's goals from DECLARED dependencies only.
// Independent goals keep the order the blueprint DECLARES them in (`nodes` arrives in that
// order): that is an order a person can see and explain, where a goal id is random per blueprint.
// ---------------------------------------------------------------------------------------------
/** Kahn's algorithm with a declared-order frontier; returns the order, or the cycle it could not break. */
export function topologicalOrder(nodes, edges) {
  const ids = [...new Set(nodes)];
  const rank = new Map(ids.map((id, i) => [id, i]));
  const byDeclaration = (a, b) => rank.get(a) - rank.get(b);
  const incoming = new Map(ids.map((id) => [id, new Set()]));
  const outgoing = new Map(ids.map((id) => [id, new Set()]));
  for (const [from, to] of edges) { if (!incoming.has(from) || !incoming.has(to)) continue; incoming.get(to).add(from); outgoing.get(from).add(to); }
  const order = []; const ready = ids.filter((id) => incoming.get(id).size === 0);
  while (ready.length) {
    ready.sort(byDeclaration); const id = ready.shift(); order.push(id);
    for (const dependant of [...outgoing.get(id)].sort(byDeclaration)) { incoming.get(dependant).delete(id); if (incoming.get(dependant).size === 0) ready.push(dependant); }
  }
  if (order.length === ids.length) return { order, cycle: null };
  const stuck = ids.filter((id) => !order.includes(id));
  // Walk from any stuck node along unresolved requirements until a node repeats: that is the cycle.
  const trail = []; let cursor = stuck[0]; const seen = new Set();
  while (cursor && !seen.has(cursor)) { seen.add(cursor); trail.push(cursor); cursor = [...incoming.get(cursor)].filter((x) => stuck.includes(x)).sort(byDeclaration)[0]; }
  const start = trail.indexOf(cursor);
  return { order: null, cycle: start >= 0 ? [...trail.slice(start), cursor] : [...trail, cursor].filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------
// Plan construction.
// ---------------------------------------------------------------------------------------------
const OPERATIONS = Object.freeze({
  CREATE_HOST: { module: 'laboratory/execution', function: 'createHost', exists: true },
  REINDEX_HOST: { module: 'analyze/fingerprint + engine/host', function: 'fingerprintProject → buildHostModel', exists: true },
  CHECK_DEPENDENCIES: { module: 'laboratory', function: 'analyseBlueprint (DECLARED / INFERRED dependencies)', exists: true },
  TRANSPLANT_CAPABILITY: { module: 'plan + apply', function: 'createTransplantPlan → prepareTransplant (isolated worktree) → applyTransplant', exists: true },
  // A library is not emitted from an IR: its own verified artifact is carried across unchanged and
  // a small adapter is generated beside it. Separate steps, because calling this a transplant would
  // tell the person a service was written into their application.
  VERIFY_SOURCE_ARTIFACT_IDENTITY: { module: 'adapt/library-host', function: 'checkArtifactIdentity', exists: true },
  ADAPT_LIBRARY_CAPABILITY: { module: 'adapt/library-host', function: 'adaptLibraryCapability → applyLibraryAdaptation (isolated worktree)', exists: true },
  VERIFY_CAPABILITY: { module: 'verify', function: 'verifyCapability → decideVerdict (verification contract)', exists: true },
  // The same contract, run again on the combined candidate after a LATER capability was applied.
  // A separate step type, because the original VERIFY_CAPABILITY says nothing about that state.
  REVERIFY_CAPABILITY: { module: 'verify', function: 'verifyCapability → decideVerdict (same contract, re-run on the combined candidate)', exists: true },
  CHECK_HOST_PRESERVATION: { module: 'plan', function: 'hostPreservationTests (captured baseline re-run)', exists: true },
  FINAL_VERIFICATION: { module: 'verify', function: 'decideVerdict over every applied contract + proof', exists: true },
});
// Goals are hashed in DECLARED order: that order decides how independent capabilities are applied.
const blueprintRevision = (blueprint) => stableHash({ goals: blueprint.goals.map((g) => ({ goalId: g.goalId, category: g.category, label: g.label, required: g.required, selection: g.selection })), hostIntent: blueprint.hostIntent });

/**
 * Support for a capability in LIBRARY form.
 *
 * The planner does not decide this. It asks the same structural authority the adaptation operation
 * itself uses (`libraryHostAdaptationSupport`), so there is exactly one definition of what GRAFT can
 * adapt and the planner cannot drift from it. Source VERIFIED is deliberately not consulted here:
 * a proven library with no proven destination adaptation is still unsupported.
 *
 * What the planner adds on top is availability, which is its own job: the organ's recorded source
 * checkout must still be reachable, because a library's artifact is carried from the source (the
 * organ bank holds manifest sections, not the artifact's bytes).
 */
function librarySupport({ sel, checks, check, kind, engine, host }) {
  let manifest = null;
  try { manifest = readManifest(path.join(bankDir(), `${sel.slug}.graft`)); } catch { manifest = null; }
  if (!manifest) {
    check('library-manifest', false, 'the organ manifest could not be read, so the capability shape cannot be established');
    return { checks, supported: false, kind, engine, profile: null, implementationForm: 'library', adaptation: null };
  }
  const support = libraryHostAdaptationSupport({ manifest, host: host ? { profile: host.profile, moduleSystem: host.moduleSystem } : null });
  for (const c of support.checks) check(`adaptation:${c.id}`, c.ok, c.detail);
  // The artifact travels from the source checkout, so it has to still be there.
  const sourceRoot = manifest.provenance?.sourceProject?.root || null;
  const reachable = Boolean(sourceRoot) && fs.existsSync(sourceRoot) && fs.existsSync(path.join(sourceRoot, support.artifact?.entry || ''));
  check('library-source-reachable', reachable, reachable
    ? `the verified artifact ${support.artifact.entry} is present in the recorded source checkout`
    : sourceRoot ? `the source checkout that holds ${support.artifact?.entry || 'the artifact'} is no longer reachable, so the verified artifact cannot be carried across` : 'the organ records no source checkout for the library artifact');
  check('licence-visible', Boolean(sel.origin?.licence?.state), sel.origin?.licence ? `${sel.origin.kind} · licence ${sel.origin.licence.declared || sel.origin.licence.state}` : 'provenance unknown');
  check('operation', OPERATIONS.ADAPT_LIBRARY_CAPABILITY.exists && OPERATIONS.VERIFY_SOURCE_ARTIFACT_IDENTITY.exists && OPERATIONS.VERIFY_CAPABILITY.exists,
    'artifact identity check → library adaptation → destination verification exist');
  // `ok !== false` is the planner's convention: an unknown (no host yet) is not a blocker here, it
  // surfaces as NEEDS_HOST from the host blocker instead.
  return { checks, supported: checks.every((c) => c.ok !== false), kind, engine,
    profile: support.adaptation ? host?.profile || null : null, implementationForm: 'library',
    adaptation: support.adaptation, adaptationSpec: support.spec || null, libraryArtifact: support.artifact || null, sourceRoot, sourceReachable: reachable,
    destinationContractCases: (() => { try { return destinationVerificationContract(manifest).length; } catch { return null; } })(),
    adapterModule: support.spec?.adapterModule || null, adaptationMethod: support.spec?.method || null };
}

/** Everything the planner needs to know about one selected implementation, from its artifacts only. */
function capabilitySupport(goal, host) {
  const sel = goal.selected;
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok, detail });
  if (!sel) { check('selected', false, 'no implementation selected'); return { checks, supported: false, kind: null, engine: null }; }
  if (sel.kind !== 'organ') { check('artifact', false, 'the selection is an unharvested workspace observation; harvest it to obtain an organ GRAFT can apply'); return { checks, supported: false, kind: null, engine: null }; }
  check('source-available', sel.status === 'AVAILABLE', sel.status === 'AVAILABLE' ? 'organ present in the bank' : sel.unavailableReason || 'source unavailable');
  let engine = null;
  try { engine = readOrganEngine(path.join(bankDir(), `${sel.slug}.graft`)); } catch { engine = null; }
  check('engine-artifacts', Boolean(engine?.genome && engine?.ir && engine?.verificationContract), engine ? 'genome, IR and verification contract present' : 'engine artifacts (genome / IR / contract) are missing');
  const kind = engine?.genome?.identity?.kind || sel.capabilityKind || null;
  const form = sel.implementationForm || engine?.genome?.identity?.implementationForm || null;
  // Implementation form decides whether an emitter can consume this capability at all. The
  // emitters write service-shaped implementations from a service IR; a verified library is a
  // different artifact, and no adaptation for it exists yet. Source VERIFIED never implies this.
  if (form === 'library') return librarySupport({ sel, checks, check, kind, engine, host });
  const writer = SUPPORTED_PROFILES.some((p) => p.kinds.includes(kind));
  check('supported-kind', Boolean(kind) && writer, kind ? (writer ? `kind ${kind} has an emitter` : `no emitter writes kind ${kind}`) : 'capability kind unknown');
  const profile = host ? host.profilesByKind?.[kind] || null : null;
  check('host-profile', host ? Boolean(profile) : null, host ? (profile ? `host profile ${profile} writes ${kind}` : `the host (${host.moduleSystem}/${host.handlerContract}${host.framework ? `, ${host.framework}` : ''}) has no emitter profile for ${kind}`) : 'no host chosen yet');
  check('configuration-names', Array.isArray(sel.configurationNames), `${(sel.configurationNames || []).length} configuration name(s) known (values are never stored)`);
  check('dependencies-known', Boolean(sel.dependencies), sel.dependencies ? `${(sel.dependencies.services || []).length} external service(s), ${(sel.dependencies.packages || []).length} package(s), runtime ${(sel.dependencies.runtime || []).join(', ') || 'unspecified'}` : 'dependency artifact missing');
  check('licence-visible', Boolean(sel.origin?.licence?.state), sel.origin?.licence ? `${sel.origin.kind} · licence ${sel.origin.licence.declared || sel.origin.licence.state}` : 'provenance unknown');
  check('operation', OPERATIONS.TRANSPLANT_CAPABILITY.exists && OPERATIONS.VERIFY_CAPABILITY.exists, 'transplant plan → prepare → apply → verify exist');
  return { checks, supported: checks.every((c) => c.ok !== false), kind, engine, profile };
}

/**
 * Build the assembly plan for a blueprint. `host` is a host specification (see
 * `newHostSpecification` / `existingHostSpecification`) or null when the person has not chosen.
 * Deterministic: the same blueprint, analysis and host give the same steps and readiness.
 */
export function buildAssemblyPlan(blueprint, { host = null, analysis = null, index = null, atlasDirectory = null, now = () => new Date().toISOString() } = {}) {
  const a = analysis || analyseBlueprint(blueprint, { index: index || loadIndex(), atlasDirectory });
  const blockers = [], warnings = [], steps = [], evidence = [];
  const planned = a.goals.filter((g) => g.required || g.selected);
  // 1. Blueprint gate.
  const gateOpen = a.readiness === 'READY_FOR_ASSEMBLY_PLANNING';
  if (!a.goals.length) blockers.push({ kind: 'empty-blueprint', detail: 'the blueprint has no capability goals', options: ['add goals in the blueprint'] });
  if (!gateOpen && a.goals.length) {
    for (const g of a.goals.filter((x) => x.required && x.status === 'missing')) blockers.push({ kind: 'missing-capability', goalId: g.goalId, label: g.label, detail: `${g.label}: ${g.searched ? 'no suitable capability in Capability Memory' : g.searchReason || 'not found'}`, options: ['make the goal optional', 'remove the goal', 'authorize another workspace', 'create the capability (coming later)'] });
    for (const g of a.goals.filter((x) => x.required && x.status === 'unresolved')) blockers.push({ kind: 'unselected-goal', goalId: g.goalId, label: g.label, detail: `${g.label}: ${g.candidates.length} candidate(s), none selected`, options: ['select an implementation in the blueprint'] });
    for (const g of a.goals.filter((x) => x.status === 'source-unavailable')) blockers.push({ kind: 'source-unavailable', goalId: g.goalId, label: g.label, detail: `${g.label}: ${g.selected.unavailableReason}`, options: ['choose another implementation', 'restore the capability to the organ bank'] });
    for (const c of a.conflicts.filter((x) => x.blocking !== false)) blockers.push({ kind: `conflict:${c.kind}`, label: c.labels.join(' ↔ '), detail: c.detail, options: c.options });
    for (const d of a.dependencies.filter((x) => x.blocking)) blockers.push({ kind: 'unmet-dependency', goalId: d.from, label: d.fromLabel, detail: `${d.fromLabel} needs ${d.needsLabel}: ${d.detail}`, options: ['select an implementation that provides it', 'add a goal that provides it'] });
  }
  // 2. Ordering from DECLARED dependencies between planned goals (advisory hints are never edges).
  const nodes = planned.map((g) => g.goalId);
  const providerOf = (need) => planned.find((g) => g.definition?.provides.includes(need))?.goalId || null;
  const edges = [];
  for (const g of planned) for (const need of g.definition?.requires || []) { const p = providerOf(need); if (p && p !== g.goalId) edges.push([p, g.goalId]); }
  const { order, cycle } = topologicalOrder(nodes, edges);
  if (cycle) blockers.push({ kind: 'dependency-cycle', detail: `capability goals require each other in a cycle: ${cycle.map((id) => planned.find((g) => g.goalId === id)?.label || id).join(' → ')}`, options: ['remove or change one of the goals so the requirement graph has a direction'] });
  const ordered = (order || nodes).map((id) => planned.find((g) => g.goalId === id));
  // 3. Host.
  if (!host) blockers.push({ kind: 'host-undecided', detail: blueprint.hostIntent?.kind === 'decide-later' ? 'the blueprint has not chosen a host: an existing project or a new blank application' : `choose the ${blueprint.hostIntent?.kind === 'existing-project' ? 'existing project' : 'starting architecture'} for this plan`, options: ['plan for a new blank application', 'plan for an existing project'] });
  else if (host.kind === 'existing-project' && !host.profile) blockers.push({ kind: 'unsupported-host', detail: `${host.name}: ${host.unsupportedReason || 'no emitter profile for this project shape'}`, options: ['choose another project', 'plan for a new blank application'] });
  // 4. Capability support, in order.
  const support = new Map();
  for (const g of ordered) {
    const s = capabilitySupport(g, host);
    support.set(g.goalId, s);
    if (g.selected && !s.supported && !cycle) blockers.push({ kind: 'capability-unsupported', goalId: g.goalId, label: g.label, detail: s.checks.filter((c) => c.ok === false).map((c) => c.detail).join('; '), options: ['choose another implementation', 'choose a host whose shape this capability can be written into'] });
    if (g.selected?.status === 'AVAILABLE') {
      const fams = g.selected.verification?.families || [];
      const hostEvidence = g.selected.verification?.hostEvidence || [];
      const forProfile = s.profile ? hostEvidence.find((h) => h.profile === s.profile) : null;
      evidence.push({ goalId: g.goalId, label: g.label, capabilityId: g.selected.capabilityId, name: g.selected.name, sourceVerdict: g.selected.verification?.source || null, atlasFamilies: fams, hostEvidence, chosenProfile: s.profile, chosenProfileEvidence: forProfile ? forProfile.status : 'n/a', origin: g.selected.origin, role: 'evidence-only' });
      if (host && s.profile && (!forProfile || forProfile.status !== 'verified-evidence')) warnings.push({ kind: 'no-prior-evidence', goalId: g.goalId, detail: `${g.label}: no verified transplant of ${g.selected.name} into ${s.profile} is recorded on this machine; support is structural (emitter + contract), not historical` });
      if (host && fams.some((f) => f.verified) && (!forProfile || !forProfile.verified)) warnings.push({ kind: 'stronger-host-available', goalId: g.goalId, detail: `${g.label}: verified evidence exists for ${fams.filter((f) => f.verified).map((f) => `${f.destination} (${f.verified})`).join(', ')}; that host shape would carry prior evidence` });
      if (g.selected.origin?.licence?.warning) warnings.push({ kind: 'licence', goalId: g.goalId, detail: `${g.label}: ${g.selected.origin.licence.warning}` });
    }
  }
  // 5. Steps. Always described, so a blocked plan still explains what assembly would be.
  let n = 0;
  const step = (type, fields) => { n += 1; const op = OPERATIONS[type]; steps.push({ stepId: `step-${String(n).padStart(2, '0')}`, order: n, type, operation: { module: op.module, function: op.function, exists: op.exists, note: op.note || null }, ...fields }); };
  if (host?.kind === 'new-application') step('CREATE_HOST', { what: `Create a new ${host.label} application shell (${host.persistence === 'none' ? 'no persistence' : host.persistence}) in a folder the person chooses`, why: 'the selected capabilities need a host with this exact shape for their emitter profile', supported: true, supportReason: 'createHost writes the shell and the fingerprint must then confirm it independently', host: { architectureId: host.architectureId, hostId: host.hostId } });
  else if (host?.kind === 'existing-project') step('CHECK_HOST_PRESERVATION', { what: `Capture ${host.name}'s baseline behaviour (its own tests and routes) before anything is written`, why: 'every later step must leave the existing application working as it did', supported: true, supportReason: 'hostPreservationTests exists and runs inside the isolated worktree', host: { projectId: host.projectId, hostId: host.hostId } });
  step('REINDEX_HOST', { what: host ? `Fingerprint the host and build its Host Model${host.kind === 'new-application' ? ' once the shell exists' : ''}` : 'Fingerprint the host and build its Host Model', why: 'transplant plans are made against the Host Model, never against assumptions', supported: true, supportReason: 'fingerprintProject and buildHostModel exist' });
  step('CHECK_DEPENDENCIES', { what: `Confirm every DECLARED dependency is provided by a selected implementation (${a.dependencies.filter((d) => d.level === 'DECLARED').length} declared)`, why: 'a capability whose requirement is unmet must not be applied', supported: true, supportReason: 'the blueprint analysis is deterministic', dependencies: a.dependencies.filter((d) => d.level === 'DECLARED').map((d) => ({ from: d.fromLabel, needs: d.needsLabel, satisfied: d.satisfied })) });
  // More than one planned capability makes this a composition: the plan then also says how the
  // earlier ones are re-verified after the later ones, and that one final revision binds them all.
  const composition = planned.length > 1;
  for (const g of ordered) {
    const s = support.get(g.goalId);
    const name = g.selected?.name || g.label;
    const last = g === ordered[ordered.length - 1];
    if (!g.selected) { step('TRANSPLANT_CAPABILITY', { what: `Transplant an implementation of ${g.label}`, why: 'required by the blueprint', goalId: g.goalId, capability: null, supported: false, supportReason: g.status === 'missing' ? 'no implementation exists in Capability Memory' : 'no implementation selected' }); continue; }
    // A library is added to the host differently from a service, and the plan says so rather than
    // calling it a transplant: its own verified artifact is carried across and an adapter is written.
    if (s.implementationForm === 'library') {
      const capability = { slug: g.selected.slug, capabilityId: g.selected.capabilityId, genomeId: g.selected.genomeId || null, kind: s.kind, name, implementationForm: 'library' };
      const entry = s.libraryArtifact?.entry || 'the library artifact';
      step('VERIFY_SOURCE_ARTIFACT_IDENTITY', { what: `Confirm ${entry} is byte-for-byte the artifact GRAFT verified before anything is written`, why: 'the capability that gets added must be the capability that was proven', goalId: g.goalId, capability,
        artifact: s.libraryArtifact ? { entry: s.libraryArtifact.entry, recordedSha256: s.libraryArtifact.recordedSha256, moduleSystem: s.libraryArtifact.moduleSystem } : null,
        // Whether the artifact can be checked does not depend on the host: an unsupported host
        // blocks the adaptation step, and this step says only what it can honestly say.
        supported: Boolean(s.libraryArtifact?.recordedSha256) && s.sourceReachable === true,
        supportReason: !s.libraryArtifact?.recordedSha256 ? 'no recorded artifact identity to check against'
          : s.sourceReachable !== true ? 'the recorded source checkout that holds the verified artifact is not reachable'
            : 'harvest recorded the artifact identity and the source checkout is reachable' });
      step('ADAPT_LIBRARY_CAPABILITY', { what: `Add ${name} to the host: carry the verified library artifact across unchanged and generate an adapter beside it, inside an isolated worktree`, why: g.required ? `required goal ${g.label}` : `optional goal ${g.label} with a selection`, goalId: g.goalId, capability,
        integration: { method: s.adaptationMethod, adaptation: s.adaptation, artifact: s.libraryArtifact?.entry || null, adapter: s.adapterModule, hostProfile: s.profile, generatedBy: 'GRAFT', installsPackage: false, buildsAnything: false, registersRoutes: false },
        profile: s.profile, supported: s.supported, supportReason: s.supported ? `the verified artifact is carried across unchanged and a ${s.adapterModule} adapter is generated for the ${s.profile} host` : s.checks.filter((c) => c.ok === false).map((c) => c.detail).join('; '), checks: s.checks, configurationNames: g.selected.configurationNames || [] });
      step('VERIFY_CAPABILITY', { what: `Run ${name}'s destination contract against the generated adapter inside the host (${s.destinationContractCases ?? '?'} case(s))`, why: 'the source proof covers the library on its own; this proves the adapted capability in this host', goalId: g.goalId,
        capability: { slug: g.selected.slug, capabilityId: g.selected.capabilityId, contractId: s.engine?.verificationContract?.contractId || null },
        supported: Boolean(s.destinationContractCases), supportReason: s.destinationContractCases ? 'the destination contract runs the generated adapter through decideVerdict, the same authority as every other verdict' : 'no destination contract could be derived' });
      // In a composition the LAST capability's preservation and re-index are the composition's own
      // final checks below (against the baseline captured before anything was applied), not a
      // second pair of the same probes on the same tree.
      if (!composition || !last) step('CHECK_HOST_PRESERVATION', { what: 'Confirm the host still answers exactly as it did before the adaptation', why: 'the baseline is captured before anything is written, so this compares the application with how it really behaved', goalId: g.goalId, supported: true, supportReason: 'hostPreservationTests with a baseline captured before the writes' });
      if (!composition || !last) step('REINDEX_HOST', { what: 'Rebuild the Host Model after the adaptation and record what the detectors independently observe', why: composition ? 'the next capability must see the host as it now is' : 'the honest result is recorded even when the detectors do not recognise an embedded library', supported: true, supportReason: 'fingerprintProject and buildHostModel exist' });
      continue;
    }
    step('TRANSPLANT_CAPABILITY', { what: `Transplant ${name} into the host through profile ${s.profile || '(none)'} inside an isolated worktree`, why: g.required ? `required goal ${g.label}` : `optional goal ${g.label} with a selection`, goalId: g.goalId, capability: { slug: g.selected.slug, capabilityId: g.selected.capabilityId, genomeId: g.selected.genomeId || null, kind: s.kind, name }, profile: s.profile, supported: s.supported, supportReason: s.supported ? 'artifact, emitter profile and operations all present' : s.checks.filter((c) => c.ok === false).map((c) => c.detail).join('; '), checks: s.checks, configurationNames: g.selected.configurationNames || [] });
    step('VERIFY_CAPABILITY', { what: `Run ${name}'s verification contract against the running host (${s.engine?.verificationContract?.successCases?.length ?? '?'} success case(s), ${s.engine?.verificationContract?.counterfactualCases?.length ?? '?'} counterfactual(s))`, why: 'a transplant is only VERIFIED by its own contract; nothing else can say so', goalId: g.goalId, capability: { slug: g.selected.slug, capabilityId: g.selected.capabilityId, contractId: s.engine?.verificationContract?.contractId || null }, supported: Boolean(s.engine?.verificationContract), supportReason: s.engine?.verificationContract ? 'verifyCapability and decideVerdict exist for this contract' : 'no verification contract in the organ' });
    // A composition checks host preservation after EVERY earlier capability, against the one
    // baseline captured before composition began; a single transplant carries its preservation
    // probes inside its own verification report.
    if (composition && !last) step('CHECK_HOST_PRESERVATION', { what: 'Confirm the host still answers exactly as it did before anything was applied', why: 'the next capability must be applied to an application that still behaves as it did', goalId: g.goalId, supported: true, supportReason: 'hostPreservationTests with a baseline captured before the writes' });
    if (!composition || !last) step('REINDEX_HOST', { what: 'Rebuild the Host Model after the transplant', why: 'the next capability must see the host as it now is', supported: true, supportReason: 'fingerprintProject and buildHostModel exist' });
  }
  // Composition: what a LATER capability did to an EARLIER one is only known by running the
  // earlier contract again on the combined candidate. The original VERIFY_CAPABILITY step is
  // evidence about the intermediate state and says nothing about this one.
  if (composition) {
    const applied = ordered.filter((g) => g.selected);
    for (const g of applied.slice(0, -1)) {
      const later = applied.slice(applied.indexOf(g) + 1).map((x) => x.selected?.name || x.label);
      const s = support.get(g.goalId);
      step('REVERIFY_CAPABILITY', { what: `Run ${g.selected.name || g.label}'s contract again on the combined application, after ${later.join(', ')}`, why: 'a later capability can break an earlier one; the earlier proof covers the state before it was applied', goalId: g.goalId,
        capability: { slug: g.selected.slug, capabilityId: g.selected.capabilityId, contractId: s?.engine?.verificationContract?.contractId || null }, alongside: later,
        supported: steps.some((x) => x.type === 'VERIFY_CAPABILITY' && x.goalId === g.goalId && x.supported), supportReason: 'the same contract and the same verdict authority as the original verification' });
    }
    step('CHECK_HOST_PRESERVATION', { what: 'Confirm the composed application still answers exactly as the host did before composition began', why: 'the authoritative preservation question is about the baseline captured before any capability was applied', supported: true, supportReason: 'hostPreservationTests with the baseline captured before the first write' });
    step('REINDEX_HOST', { what: 'Rebuild the Host Model of the composed application and record what the detectors independently observe', why: 'the honest result is recorded even when the detectors do not recognise an embedded library', supported: true, supportReason: 'fingerprintProject and buildHostModel exist' });
  }
  if (host?.kind === 'existing-project' && !composition) step('CHECK_HOST_PRESERVATION', { what: `Re-run ${host.name}'s baseline behaviour`, why: 'the application must still do everything it did before', supported: true, supportReason: 'hostPreservationTests exists' });
  step('FINAL_VERIFICATION', { what: composition ? 'Confirm every capability is verified on the one final combined revision, then bind the ledger to it' : 'Decide the final verdict from every applied contract and write the proof', why: 'the assembled application is described by its evidence, never by intent', supported: true, supportReason: composition ? 'every capability must be VERIFIED at the same revision, with host preservation held; the ledger transition is refused otherwise' : 'decideVerdict is the only source of VERIFIED' });
  // 6. Readiness.
  const kinds = new Set(blockers.map((b) => b.kind));
  const readiness = !a.goals.length ? 'DRAFT'
    : !gateOpen ? 'BLOCKED_BLUEPRINT'
      : kinds.has('host-undecided') ? 'NEEDS_HOST'
        : kinds.has('unsupported-host') ? 'UNSUPPORTED_HOST'
          : kinds.has('dependency-cycle') ? 'BLOCKED_DEPENDENCIES'
            : kinds.has('capability-unsupported') || steps.some((s) => s.supported === false) ? 'BLOCKED_CAPABILITY_SUPPORT'
              : 'READY_TO_ASSEMBLE';
  const readinessReason = {
    DRAFT: 'the blueprint has no goals', BLOCKED_BLUEPRINT: `the blueprint is ${a.readiness}; it must reach READY_FOR_ASSEMBLY_PLANNING before an executable plan exists`, NEEDS_HOST: 'choose an existing project or a new blank application', UNSUPPORTED_HOST: 'the chosen project has no emitter profile GRAFT can write into',
    BLOCKED_DEPENDENCIES: 'the capability goals require each other in a cycle', BLOCKED_CAPABILITY_SUPPORT: 'at least one planned step has no deterministic execution path',
    READY_TO_ASSEMBLE: 'GRAFT has a deterministic execution path for every planned step — not a verification, not a compatibility guarantee, not a promise the build succeeds',
  }[readiness];
  const createdAt = now();
  const plan = {
    schemaVersion: ASSEMBLY_SCHEMA_VERSION, planId: `plan-${blueprint.blueprintId}-${crypto.randomBytes(3).toString('hex')}`, blueprintId: blueprint.blueprintId, blueprintName: blueprint.name, blueprintRevision: blueprintRevision(blueprint), blueprintReadiness: a.readiness, createdAt,
    host: host || { kind: blueprint.hostIntent?.kind || 'decide-later', status: 'NOT_CHOSEN' },
    steps, dependencies: a.dependencies.map((d) => ({ from: d.fromLabel, fromGoalId: d.from, needs: d.needsLabel || d.needs, level: d.level, satisfied: d.satisfied, blocking: Boolean(d.blocking) })),
    order: ordered.map((g, i) => ({ position: i + 1, goalId: g.goalId, label: g.label, implementation: g.selected?.name || null, declaredPosition: planned.indexOf(g) + 1, decidedBy: edges.some(([, to]) => to === g.goalId) ? 'declared-dependency' : 'blueprint-declared-order' })),
    ordering: { ...ORDERING_RULE, dependencyEdges: edges.length }, edges: edges.map(([from, to]) => ({ from, to })),
    composition: composition ? { capabilities: planned.length, reverified: steps.filter((s) => s.type === 'REVERIFY_CAPABILITY').map((s) => s.capability.slug), finalRevisionBindsAll: true } : null,
    blockers, warnings, evidence,
    expectedCapabilities: ordered.filter((g) => g.selected?.status === 'AVAILABLE').map((g) => ({ goalId: g.goalId, label: g.label, capabilityId: g.selected.capabilityId, name: g.selected.name, kind: support.get(g.goalId)?.kind || null, provides: g.selected.provides || [], configurationNames: g.selected.configurationNames || [], origin: g.selected.origin })),
    inputs: { selectedCapabilityIds: ordered.map((g) => g.selected?.capabilityId || g.selected?.projectId || null), hostId: host?.hostId || null, sourceStates: Object.fromEntries(ordered.filter((g) => g.selected).map((g) => [g.goalId, g.selected.status])) },
    readiness, readinessReason, executable: readiness === 'READY_TO_ASSEMBLE', executionAvailable: false, executionNote: 'Assembly Execution (Laboratory 0.3) is not built; this plan performs nothing',
    authority: { deterministic: true, agentDecided: false }, agentAdvice: null, status: 'CURRENT',
  };
  return plan;
}

/** Compare a stored plan with the blueprint as it is now. Any authoritative change makes it STALE. */
export function checkPlanFreshness(plan, blueprint, { analysis = null, index = null, atlasDirectory = null, host = null } = {}) {
  const reasons = [];
  if (!blueprint) return { stale: true, reasons: ['the blueprint no longer exists'] };
  if (blueprint.blueprintId !== plan.blueprintId) reasons.push('the plan belongs to a different blueprint');
  if (blueprintRevision(blueprint) !== plan.blueprintRevision) reasons.push('the blueprint changed (goals, selections or host intent)');
  const a = analysis || analyseBlueprint(blueprint, { index: index || loadIndex(), atlasDirectory });
  if (a.readiness !== plan.blueprintReadiness) reasons.push(`blueprint readiness moved from ${plan.blueprintReadiness} to ${a.readiness}`);
  for (const [goalId, state] of Object.entries(plan.inputs?.sourceStates || {})) { const g = a.goals.find((x) => x.goalId === goalId); const nowState = !g ? 'GOAL_REMOVED' : g.selected?.status || 'UNSELECTED'; if (nowState !== state) reasons.push(`${g?.label || goalId}: source ${state} → ${nowState}`); }
  if (host && plan.host?.hostId && host.hostId !== plan.host.hostId) reasons.push('the host changed');
  return { stale: reasons.length > 0, reasons };
}

/** Agent words about a plan: kept apart, marked advisory, never read by the planner. */
export function recordPlanAdvice(plan, advice) {
  plan.agentAdvice = advice ? { advisory: true, authoritative: false, task: advice.task || null, provider: advice.provider || null, model: advice.model || null, value: advice.value || null, receivedAt: advice.receivedAt || null } : null;
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Persistence: GRAFT_HOME/laboratory/plans/<planId>.json, atomic, no secrets, no local paths.
// ---------------------------------------------------------------------------------------------
export const plansDir = () => path.join(graftHome(), 'laboratory', 'plans');
const ID = /^plan-[a-z0-9][a-z0-9-]{0,80}-[0-9a-f]{6}$/;
const planFile = (id) => { if (!ID.test(id)) throw fail('invalid-plan-id', 'Plan id must be a short lowercase id.'); return path.join(plansDir(), `${id}.json`); };
const SECRET_KEY = /(secret|token|password|api[_-]?key|private[_-]?key)/i;
function assertStorable(value, trail = 'plan') {
  if (Array.isArray(value)) { value.forEach((v, i) => assertStorable(v, `${trail}[${i}]`)); return; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) { if (SECRET_KEY.test(k) && typeof v === 'string' && v.length) throw fail('plan-privacy', `${trail}.${k} looks like a secret value; plans store configuration names only.`); assertStorable(v, `${trail}.${k}`); } return; }
  if (typeof value === 'string' && (value.includes(os.homedir()) || /(^|[\s"'(])\/Users\/[^/\s]+\//.test(value) || /(^|[\s"'(])\/home\/[^/\s]+\//.test(value) || /[A-Za-z]:\\Users\\/.test(value) || value.includes(graftHome()))) throw fail('plan-privacy', `${trail} would store a local path (${value.slice(0, 40)}…); plans reference hosts and capabilities by id.`);
}
export function saveAssemblyPlan(plan) {
  assertStorable(plan);
  const file = planFile(plan.planId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  return plan;
}
export function loadAssemblyPlan(id) {
  const file = planFile(id);
  if (!fs.existsSync(file)) throw fail('unknown-plan', `No assembly plan ${id}.`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (parsed.schemaVersion !== ASSEMBLY_SCHEMA_VERSION) throw fail('unsupported-schema', `Assembly plan schema ${parsed.schemaVersion} is not supported.`);
  return parsed;
}
export function listAssemblyPlans({ blueprintId = null } = {}) {
  const dir = plansDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => { try { const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { planId: p.planId, blueprintId: p.blueprintId, blueprintName: p.blueprintName, readiness: p.readiness, host: p.host?.kind || null, hostLabel: p.host?.label || p.host?.name || null, steps: p.steps?.length || 0, createdAt: p.createdAt }; } catch { return null; } })
    .filter((p) => p && (!blueprintId || p.blueprintId === blueprintId)).sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''));
}
export function deleteAssemblyPlan(id) { fs.rmSync(planFile(id), { force: true }); }
/** A stored plan as the product shows it: stored content plus a fresh staleness check. */
export function viewAssemblyPlan(plan, blueprint, options = {}) {
  const freshness = checkPlanFreshness(plan, blueprint, options);
  return { ...plan, status: freshness.stale ? 'STALE' : 'CURRENT', freshness, executable: plan.executable && !freshness.stale };
}
