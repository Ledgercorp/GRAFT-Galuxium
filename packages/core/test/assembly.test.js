import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { recordAtlasEntry, buildAtlasEntry } from '../src/engine/atlas.js';
import { projectResponse, AuthorityViolation } from '../src/agent/tasks.js';
import { createBlueprint, addGoal, updateGoal, selectImplementation, setHostIntent, analyseBlueprint, saveBlueprint } from '../src/laboratory/index.js';
import { buildAssemblyPlan, topologicalOrder, newHostSpecification, existingHostSpecification, NEW_HOST_ARCHITECTURES, PLAN_READINESS, STEP_TYPES, saveAssemblyPlan, loadAssemblyPlan, listAssemblyPlans, viewAssemblyPlan, checkPlanFreshness, recordPlanAdvice, ASSEMBLY_SCHEMA_VERSION } from '../src/laboratory/assembly.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-asm-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
const copyFixture = (work, fixture, name) => { const dst = path.join(work, name); fs.cpSync(path.join(repoRoot, 'fixtures', fixture), dst, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) }); return dst; };
const listing = (root) => fs.readdirSync(root, { recursive: true }).sort().join('\n');
const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
/** A bank with the fixture's session-auth capability and a blueprint that selects it. */
async function readyBlueprint(work) {
  const src = copyFixture(work, 'old-saas-project', 'source');
  const { manifest } = await harvestCapability(fingerprintProject(src), 'authentication');
  writeManifest(bankDir(), manifest);
  const bp = createBlueprint({ name: 'Authenticated application', description: 'people sign in', hostIntent: 'new-application' });
  const goal = addGoal(bp, { category: 'authentication' });
  const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const organ = a.goals[0].candidates.find((c) => c.kind === 'organ');
  selectImplementation(bp, goal.goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
  return { bp, src, manifest, organ, goalId: goal.goalId };
}

test('topological order is deterministic and a cycle is reported, never broken', () => {
  assert.deepEqual(topologicalOrder(['billing', 'auth', 'orgs'], [['auth', 'orgs'], ['orgs', 'billing'], ['auth', 'billing']]), { order: ['auth', 'orgs', 'billing'], cycle: null });
  assert.deepEqual(topologicalOrder(['b', 'a', 'c'], []).order, ['b', 'a', 'c'], 'independent goals keep their declared order');
  assert.deepEqual(topologicalOrder(['c', 'b', 'a'], [['a', 'c']]).order, ['b', 'a', 'c'], 'a declared dependency overrides declaration order; the rest keeps it');
  const cyclic = topologicalOrder(['a', 'b', 'c'], [['a', 'b'], ['b', 'a'], ['a', 'c']]);
  assert.equal(cyclic.order, null);
  assert.deepEqual(cyclic.cycle, ['a', 'b', 'a']);
});

test('a ready blueprint on a supported new host becomes a READY_TO_ASSEMBLE plan: ordered, deterministic, described, never executed', async (t) => {
  const work = sandbox(t);
  const { bp, src, organ } = await readyBlueprint(work);
  const before = listing(src);
  const host = newHostSpecification('node-esm-express');
  assert.equal(host.exists, false); assert.equal(host.status, 'SPECIFIED_NOT_CREATED'); assert.equal(host.persistence, 'none'); assert.equal(host.profilesByKind['session-auth'], 'express-req-res');
  const plan = buildAssemblyPlan(bp, { host, index: EMPTY_INDEX, now: () => '2026-09-12T00:00:00.000Z' });
  assert.equal(plan.schemaVersion, ASSEMBLY_SCHEMA_VERSION);
  assert.match(plan.planId, /^plan-authenticated-application-[0-9a-f]{6}-[0-9a-f]{6}$/);
  assert.equal(plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(plan.blockers));
  assert.ok(PLAN_READINESS.includes(plan.readiness));
  assert.deepEqual(plan.steps.map((s) => s.type), ['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY', 'REINDEX_HOST', 'FINAL_VERIFICATION']);
  assert.ok(plan.steps.every((s) => STEP_TYPES.includes(s.type) && s.what && s.why && typeof s.supported === 'boolean' && s.operation));
  assert.ok(plan.steps.every((s) => s.supported), 'every step has a deterministic path');
  // Laboratory 0.3 shipped the shell writer, so the plan must no longer say the operation is absent:
  // claiming a built operation is missing is as dishonest as claiming a missing one is built.
  assert.equal(plan.steps[0].operation.exists, true, 'createHost exists and the plan says so');
  assert.equal(plan.steps[0].operation.function, 'createHost');
  assert.equal(plan.steps.every((s) => s.operation.exists), true, 'every planned operation really exists');
  assert.equal(plan.steps[3].capability.capabilityId, organ.capabilityId);
  assert.equal(plan.steps[3].profile, 'express-req-res');
  assert.ok(plan.steps[3].checks.every((c) => c.ok !== false));
  assert.deepEqual(plan.expectedCapabilities.map((c) => c.capabilityId), [organ.capabilityId]);
  assert.equal(plan.evidence[0].role, 'evidence-only');
  assert.equal(plan.executable, true); assert.equal(plan.executionAvailable, false);
  assert.ok(plan.warnings.some((w) => w.kind === 'no-prior-evidence'), 'no Atlas history is a warning, not a blocker');
  assert.ok(!/VERIFIED/.test(plan.readiness) && !/VERIFIED/.test(plan.readinessReason.split('—')[0]));
  const again = buildAssemblyPlan(bp, { host, index: EMPTY_INDEX, now: () => '2026-09-12T00:00:00.000Z' });
  const strip = (p) => JSON.stringify({ ...p, planId: null });
  assert.equal(strip(again), strip(plan), 'deterministic');
  // Nothing was created: no worktrees, no folders, no destination writes.
  assert.equal(listing(src), before);
  assert.ok(!fs.existsSync(path.join(work, 'home', 'laboratory', 'plans')), 'nothing persisted until asked');
  assert.ok(!fs.existsSync(path.join(work, 'home', 'worktrees')));
  // Persistence: atomic, reopenable, listed, private.
  saveAssemblyPlan(plan);
  assert.deepEqual(fs.readdirSync(path.join(work, 'home', 'laboratory', 'plans')), [`${plan.planId}.json`]);
  const raw = fs.readFileSync(path.join(work, 'home', 'laboratory', 'plans', `${plan.planId}.json`), 'utf8');
  assert.ok(!raw.includes(work) && !raw.includes(os.homedir()));
  assert.equal(loadAssemblyPlan(plan.planId).readiness, 'READY_TO_ASSEMBLE');
  assert.equal(listAssemblyPlans({ blueprintId: bp.blueprintId })[0].planId, plan.planId);
  assert.throws(() => saveAssemblyPlan({ ...plan, planId: `${plan.planId}`, host: { ...plan.host, folder: path.join(os.homedir(), 'Developer', 'x') } }), (e) => e.code === 'plan-privacy');
  assert.throws(() => saveAssemblyPlan({ ...plan, steps: [{ ...plan.steps[0], apiKey: 'sk_live_x' }] }), (e) => e.code === 'plan-privacy');
  assert.throws(() => newHostSpecification('hono'), (e) => e.code === 'unknown-architecture');
  assert.deepEqual(NEW_HOST_ARCHITECTURES.map((a) => a.id), ['node-esm-http-central', 'node-esm-express']);
});

test('the blueprint gate: missing capabilities, unmet dependencies and cycles block, with explicit blockers and a diagnostic plan', async (t) => {
  const work = sandbox(t);
  const { bp } = await readyBlueprint(work);
  addGoal(bp, { category: 'billing' }); addGoal(bp, { category: 'organizations' });
  const host = newHostSpecification('node-esm-express');
  const blocked = buildAssemblyPlan(bp, { host, index: EMPTY_INDEX });
  assert.equal(blocked.readiness, 'BLOCKED_BLUEPRINT');
  assert.equal(blocked.executable, false);
  assert.deepEqual(blocked.blockers.filter((b) => b.kind === 'missing-capability').map((b) => b.label).sort(), ['Billing / payments', 'Organizations / account grouping']);
  assert.ok(blocked.blockers.some((b) => b.kind === 'unmet-dependency' && /Organization/.test(b.detail)), JSON.stringify(blocked.blockers));
  assert.ok(blocked.steps.some((s) => s.type === 'TRANSPLANT_CAPABILITY' && s.supported === false && /no implementation exists/.test(s.supportReason)), 'the diagnostic plan shows what cannot be done');
  assert.deepEqual(blocked.order.map((o) => o.label), ['User authentication', 'Organizations / account grouping', 'Billing / payments'], 'ordered by declared dependencies even while blocked');
  // Unmet dependency alone (crafted analysis): blocked with an unmet-dependency blocker.
  const real = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const unmet = { ...real, readiness: 'NEEDS_SELECTIONS', goals: real.goals.map((g) => ({ ...g, status: g.status === 'missing' ? 'unresolved' : g.status })) };
  const plan2 = buildAssemblyPlan(bp, { host, analysis: unmet });
  assert.equal(plan2.readiness, 'BLOCKED_BLUEPRINT');
  assert.ok(plan2.blockers.some((b) => b.kind === 'unmet-dependency'));
  // A cycle (crafted definitions): BLOCKED_DEPENDENCIES; the order is not invented.
  const ready = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const cyclic = { ...ready, readiness: 'READY_FOR_ASSEMBLY_PLANNING', goals: ready.goals.map((g) => g.category === 'authentication' ? { ...g, definition: { ...g.definition, requires: ['tenant-identity'] } } : g.category === 'organizations' ? { ...g, status: 'matched', selected: ready.goals[0].selected } : g).filter((g) => g.category !== 'billing') };
  const plan3 = buildAssemblyPlan(bp, { host, analysis: cyclic });
  assert.equal(plan3.readiness, 'BLOCKED_DEPENDENCIES');
  assert.ok(plan3.blockers.some((b) => b.kind === 'dependency-cycle' && /User authentication → Organizations/.test(b.detail)), JSON.stringify(plan3.blockers));
});

test('host choice: none → NEEDS_HOST; an existing project uses its Host Model; unsupported shapes block; kinds without an emitter for the profile block', async (t) => {
  const work = sandbox(t);
  const { bp, src } = await readyBlueprint(work);
  setHostIntent(bp, { kind: 'decide-later' });
  const none = buildAssemblyPlan(bp, { host: null, index: EMPTY_INDEX });
  assert.equal(none.readiness, 'NEEDS_HOST');
  assert.equal(none.host.status, 'NOT_CHOSEN');
  // Existing Express project: Host Model reused, profile express-req-res, READY.
  const express = copyFixture(work, 'express-app', 'express');
  const legacy = copyFixture(work, 'old-saas-project', 'legacy');
  const index = { ...EMPTY_INDEX, projects: [{ projectId: 'p:express', name: 'express-app', root: express, capabilities: [] }, { projectId: 'p:legacy', name: 'legacy', root: legacy, capabilities: [] }] };
  const expressBefore = listing(express);
  const host = existingHostSpecification('p:express', { index });
  assert.equal(host.kind, 'existing-project'); assert.equal(host.profile, 'express-req-res'); assert.equal(host.exists, true); assert.ok(host.hostId.startsWith('sha256:'));
  assert.ok(!('root' in host), 'the host is referenced by id, never by path');
  const onExpress = buildAssemblyPlan(bp, { host, index: EMPTY_INDEX });
  assert.equal(onExpress.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(onExpress.blockers));
  assert.deepEqual(onExpress.steps.map((s) => s.type), ['CHECK_HOST_PRESERVATION', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY', 'REINDEX_HOST', 'CHECK_HOST_PRESERVATION', 'FINAL_VERIFICATION']);
  assert.equal(listing(express), expressBefore, 'reading the Host Model wrote nothing');
  // Legacy CJS/node-res project: no emitter profile → UNSUPPORTED_HOST.
  const legacyHost = existingHostSpecification('p:legacy', { index });
  assert.equal(legacyHost.profile, null);
  const onLegacy = buildAssemblyPlan(bp, { host: legacyHost, index: EMPTY_INDEX });
  assert.equal(onLegacy.readiness, 'UNSUPPORTED_HOST');
  assert.ok(onLegacy.blockers.some((b) => b.kind === 'unsupported-host'));
  // New bare node:http host: the profile exists but writes only hosted-session-auth → capability unsupported there.
  const central = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-http-central'), index: EMPTY_INDEX });
  assert.equal(central.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  assert.ok(central.blockers.some((b) => b.kind === 'capability-unsupported' && /no emitter profile for session-auth/.test(b.detail)), JSON.stringify(central.blockers));
  assert.throws(() => existingHostSpecification('p:nope', { index }), (e) => e.code === 'unknown-project');
  assert.equal(listing(src), listing(src));
});

test('plans go STALE when the blueprint, a selection or the source changes; Atlas is evidence; the agent cannot alter readiness', async (t) => {
  const work = sandbox(t);
  const { bp, organ, goalId, manifest } = await readyBlueprint(work);
  saveBlueprint(bp);
  const host = newHostSpecification('node-esm-express');
  const plan = saveAssemblyPlan(buildAssemblyPlan(bp, { host, index: EMPTY_INDEX }));
  assert.equal(viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX }).status, 'CURRENT');
  // Atlas evidence for the Express family: surfaces as evidence and removes the warning; readiness is unchanged either way.
  recordAtlasEntry(buildAtlasEntry({ capabilityId: organ.capabilityId, capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: { framework: 'node-http', moduleSystem: 'cjs', handlerContract: 'node-res' }, destinationArchitecture: { runtime: { family: 'node' }, framework: 'express', moduleSystem: 'esm', handlerContract: 'express-req-res' }, result: 'supported', verification: { verdict: 'VERIFIED', summary: { required: 6, passed: 6 } } }));
  const withAtlas = buildAssemblyPlan(bp, { host, index: EMPTY_INDEX });
  assert.equal(withAtlas.readiness, plan.readiness);
  assert.equal(withAtlas.evidence[0].chosenProfileEvidence, 'verified-evidence');
  assert.ok(!withAtlas.warnings.some((w) => w.kind === 'no-prior-evidence'));
  const central = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-http-central'), index: EMPTY_INDEX });
  assert.equal(central.readiness, 'BLOCKED_CAPABILITY_SUPPORT', 'Atlas evidence elsewhere does not make an unsupported host supported');
  assert.ok(central.warnings.some((w) => w.kind === 'stronger-host-available'));
  // Blueprint change → STALE.
  updateGoal(bp, goalId, { required: false }); saveBlueprint(bp);
  const stale = viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX });
  assert.equal(stale.status, 'STALE'); assert.equal(stale.executable, false);
  assert.ok(stale.freshness.reasons.some((r) => /blueprint changed/.test(r)));
  updateGoal(bp, goalId, { required: true });
  // Selection change → STALE.
  const fresh = saveAssemblyPlan(buildAssemblyPlan(bp, { host, index: EMPTY_INDEX }));
  selectImplementation(bp, goalId, null);
  assert.equal(checkPlanFreshness(fresh, bp, { index: EMPTY_INDEX }).stale, true);
  selectImplementation(bp, goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
  assert.equal(checkPlanFreshness(fresh, bp, { index: EMPTY_INDEX }).stale, false);
  // Host change → STALE.
  assert.equal(checkPlanFreshness(fresh, bp, { index: EMPTY_INDEX, host: newHostSpecification('node-esm-http-central') }).stale, true);
  // Source disappearance → STALE, and a rebuilt plan is blocked with source-unavailable.
  fs.rmSync(path.join(bankDir(), `${manifest.identity.slug}.graft`), { recursive: true, force: true });
  const gone = checkPlanFreshness(fresh, bp, { index: EMPTY_INDEX });
  assert.equal(gone.stale, true);
  assert.ok(gone.reasons.some((r) => /AVAILABLE → SOURCE_UNAVAILABLE/.test(r)), JSON.stringify(gone.reasons));
  const rebuilt = buildAssemblyPlan(bp, { host, index: EMPTY_INDEX });
  assert.equal(rebuilt.readiness, 'BLOCKED_BLUEPRINT');
  assert.ok(rebuilt.blockers.some((b) => b.kind === 'source-unavailable'));
  // Agent: authority names are rejected; accepted advice is advisory and changes nothing.
  assert.throws(() => projectResponse('explainAssemblyPlan', { explanation: 'x', supported: true }), AuthorityViolation);
  assert.throws(() => projectResponse('explainAssemblyPlan', { explanation: 'x', readiness: 'READY_TO_ASSEMBLE', verdict: 'VERIFIED' }), AuthorityViolation);
  const { value } = projectResponse('explainAssemblyPlan', { explanation: 'Auth first because everything needs identity.', hostSuggestion: { architectureId: 'node-esm-express', rationale: 'proven' }, blockers: [], executable: true, tradeoffs: ['none'] });
  assert.equal(value.executable, undefined);
  recordPlanAdvice(rebuilt, { task: 'explainAssemblyPlan', provider: 'test', value: { ...value, readiness: 'READY_TO_ASSEMBLE' } });
  assert.equal(rebuilt.agentAdvice.advisory, true); assert.equal(rebuilt.agentAdvice.authoritative, false);
  assert.equal(rebuilt.readiness, 'BLOCKED_BLUEPRINT');
  assert.equal(buildAssemblyPlan({ ...bp, agentAdvice: { value: { dependencyHints: [{ from: 'a', to: 'b' }] } } }, { host, index: EMPTY_INDEX }).readiness, 'BLOCKED_BLUEPRINT');
});
