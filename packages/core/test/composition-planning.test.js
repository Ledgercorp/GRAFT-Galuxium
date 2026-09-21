// Real Multi-Capability Composition 0.1 — Checkpoint A: planning only.
//
// Two REAL capabilities, one host: the CUF hosted-session-auth organ GRAFT already harvested
// (copied from the bank, never re-harvested, CUF itself untouched) and the SwivelJS feature-flags
// library. This checkpoint proves the planner can answer "can both go into this host?" honestly,
// before any composition machinery exists. Nothing here writes to a destination or executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest, readManifest } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { createBlueprint, addGoal, analyseBlueprint, selectImplementation } from '../src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification, saveAssemblyPlan, viewAssemblyPlan, topologicalOrder } from '../src/laboratory/assembly.js';
import { checkExecutionEligibility } from '../src/laboratory/execution.js';
import { recheckLibraryAdaptationSupport } from '../src/laboratory/library-assembly.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const CUF_ORGAN = path.join(os.homedir(), '.graft/organ-bank/hosted-authentication.graft');
const have = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js')) && fs.existsSync(CUF_ORGAN);
const needBoth = { skip: have ? false : 'the SwivelJS checkout or the harvested CUF organ is not present' };
const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
const HTTP = () => newHostSpecification('node-esm-http-central');

function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-comp-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
/** The real CUF organ is copied, never re-harvested: CUF is read-only and must not be booted here. */
async function bankBoth() {
  fs.mkdirSync(bankDir(), { recursive: true });
  fs.cpSync(CUF_ORGAN, path.join(bankDir(), 'hosted-authentication.graft'), { recursive: true });
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
}
/** A blueprint wanting both capabilities, with the organ candidate chosen for each goal. */
function twoCapabilityBlueprint({ name = 'Flagged portal', pick = () => true } = {}) {
  const bp = createBlueprint({ name, description: 'people sign in, and features can be turned on for some of them', hostIntent: 'new-application' });
  addGoal(bp, { category: 'authentication' });
  addGoal(bp, { category: 'feature-flags' });
  const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  for (const g of a.goals) {
    const candidate = g.candidates.filter((c) => c.kind === 'organ').find((c) => pick(g, c));
    if (candidate) selectImplementation(bp, g.goalId, { kind: 'organ', slug: candidate.slug, capabilityId: candidate.capabilityId, name: candidate.name });
  }
  return bp;
}
const stepsFor = (plan, slug) => plan.steps.filter((s) => s.capability?.slug === slug).map((s) => s.type);

test('both real capabilities resolve, and one host can take both', needBoth, async (t) => {
  sandbox(t); await bankBoth();
  const bp = twoCapabilityBlueprint();
  const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  // The real CUF capability: a service-shaped hosted-session-auth, verified in its own source.
  const auth = a.goals.find((g) => g.category === 'authentication').selected;
  assert.equal(auth.slug, 'hosted-authentication');
  assert.equal(auth.capabilityKind, 'hosted-session-auth');
  assert.equal(auth.verification.source, 'VERIFIED');
  // The real SwivelJS capability: feature-flags in library form, verified in its own source.
  const flags = a.goals.find((g) => g.category === 'feature-flags').selected;
  assert.equal(flags.slug, 'feature-flags-library');
  assert.equal(flags.implementationForm, 'library');
  assert.equal(flags.verification.source, 'VERIFIED');
  assert.equal(a.readiness, 'READY_FOR_ASSEMBLY_PLANNING');

  const plan = buildAssemblyPlan(bp, { host: HTTP(), index: EMPTY_INDEX });
  assert.equal(plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(plan.blockers));
  assert.ok(plan.steps.every((s) => s.supported), 'every planned step has a deterministic path');
  // Neither capability was dropped: both are named as expected, and both have their own steps.
  assert.deepEqual(plan.expectedCapabilities.map((c) => c.kind).sort(), ['feature-flags', 'hosted-session-auth']);
  assert.equal(plan.order.length, 2);
});

test('the plan keeps the two implementation forms apart instead of flattening them', needBoth, async (t) => {
  sandbox(t); await bankBoth();
  const plan = buildAssemblyPlan(twoCapabilityBlueprint(), { host: HTTP(), index: EMPTY_INDEX });
  // A service is transplanted; a library is carried across and adapted. Each names its real operation.
  assert.deepEqual(stepsFor(plan, 'hosted-authentication'), ['TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY', 'REVERIFY_CAPABILITY']);
  assert.deepEqual(stepsFor(plan, 'feature-flags-library'), ['VERIFY_SOURCE_ARTIFACT_IDENTITY', 'ADAPT_LIBRARY_CAPABILITY', 'VERIFY_CAPABILITY']);
  // The whole shape (Checkpoint B): A applied, verified and preserved; the host re-indexed so B
  // sees it as it is; B checked and applied and verified; then the composition's own checks —
  // A re-verified after B, preservation against the pre-composition baseline, re-index, binding.
  assert.deepEqual(plan.steps.map((s) => s.type), ['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES',
    'TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY', 'CHECK_HOST_PRESERVATION', 'REINDEX_HOST',
    'VERIFY_SOURCE_ARTIFACT_IDENTITY', 'ADAPT_LIBRARY_CAPABILITY', 'VERIFY_CAPABILITY',
    'REVERIFY_CAPABILITY', 'CHECK_HOST_PRESERVATION', 'REINDEX_HOST', 'FINAL_VERIFICATION']);
  const reverify = plan.steps.find((s) => s.type === 'REVERIFY_CAPABILITY');
  assert.deepEqual(reverify.alongside, [plan.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY').capability.name], 'names the later capability it is re-verified after');
  assert.deepEqual(plan.composition, { capabilities: 2, reverified: ['hosted-authentication'], finalRevisionBindsAll: true });
  const adapt = plan.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY');
  assert.equal(adapt.operation.module, 'adapt/library-host');
  assert.equal(adapt.integration.installsPackage, false);
  assert.equal(adapt.integration.registersRoutes, false);
  const transplant = plan.steps.find((s) => s.type === 'TRANSPLANT_CAPABILITY');
  assert.equal(transplant.operation.module, 'plan + apply');
  // The library is never described as a transplant, and the service is never described as an adaptation.
  assert.equal(/transplant/i.test(adapt.what), false);
  assert.equal(/carry the verified library artifact/i.test(transplant.what), false);
});

test('an unsupported host blocks the pair, and no partial READY is possible', needBoth, async (t) => {
  sandbox(t); await bankBoth();
  // Express can take the service, but no proven adaptation writes the library into it.
  const express = buildAssemblyPlan(twoCapabilityBlueprint(), { host: newHostSpecification('node-esm-express'), index: EMPTY_INDEX });
  assert.equal(express.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  assert.match(express.blockers.map((b) => b.detail).join(' '), /no proven adaptation writes feature-flags in library form into the express-req-res host/);
  // The capability that IS supported there does not rescue the plan.
  assert.equal(express.steps.find((s) => s.type === 'TRANSPLANT_CAPABILITY' && s.capability?.slug === 'hosted-authentication').supported, true);
  assert.equal(express.executable, false);

  // A capability left unselected is not silently dropped: the plan still names it and stays blocked.
  const partial = twoCapabilityBlueprint({ name: 'Partial', pick: (g) => g.category === 'authentication' });
  const plan = buildAssemblyPlan(partial, { host: HTTP(), index: EMPTY_INDEX });
  assert.notEqual(plan.readiness, 'READY_TO_ASSEMBLE');
  assert.equal(plan.executable, false);
  const unselected = plan.steps.find((s) => s.capability === null);
  assert.ok(unselected, 'the unselected capability still appears as a step');
  assert.equal(unselected.supported, false);
});

test('the library capability must still carry its own evidence to be planned into the pair', needBoth, async (t) => {
  sandbox(t); await bankBoth();
  const organ = path.join(bankDir(), 'feature-flags-library.graft');
  const good = readManifest(organ);
  // Harvest recorded no identity for the artifact: it cannot be proven unchanged, so it cannot be planned.
  const stripped = structuredClone(good);
  stripped.sourceMap.files = stripped.sourceMap.files.filter((f) => f.role !== 'library-artifact');
  writeManifest(bankDir(), stripped);
  const blocked = buildAssemblyPlan(twoCapabilityBlueprint(), { host: HTTP(), index: EMPTY_INDEX });
  assert.equal(blocked.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  assert.match(blocked.blockers.map((b) => b.detail).join(' '), /recorded no identity for the artifact/);
  // Restoring the evidence restores the plan.
  writeManifest(bankDir(), good);
  assert.equal(buildAssemblyPlan(twoCapabilityBlueprint(), { host: HTTP(), index: EMPTY_INDEX }).readiness, 'READY_TO_ASSEMBLE');
});

test('service-form feature flags stay on the service path even beside the library form', needBoth, async (t) => {
  const work = sandbox(t); await bankBoth();
  // A second, service-shaped feature-flags capability from the fixture.
  const src = path.join(work, 'config-service');
  fs.cpSync(path.join(repoRoot, 'fixtures/config-service'), src, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
  const { manifest } = await harvestCapability(fingerprintProject(src), 'feature-flags');
  writeManifest(bankDir(), manifest);
  assert.equal(readManifest(path.join(bankDir(), 'feature-flags.graft')).identity.implementationForm, 'service');

  // Choosing the service implementation for the same goal puts it on the transplant path.
  const bp = twoCapabilityBlueprint({ name: 'Service flags', pick: (g, c) => (g.category === 'feature-flags' ? c.slug === 'feature-flags' : true) });
  const plan = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-express'), index: EMPTY_INDEX });
  assert.deepEqual(stepsFor(plan, 'feature-flags'), ['TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY']);
  assert.equal(plan.steps.some((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY'), false, 'a service is never adapted as a library');
});

test('planning writes nothing to any destination; the execution gate now admits the pair, but only whole', needBoth, async (t) => {
  const work = sandbox(t); await bankBoth();
  const bp = twoCapabilityBlueprint();
  const plan = saveAssemblyPlan(buildAssemblyPlan(bp, { host: HTTP(), index: EMPTY_INDEX }));
  // Planning creates no worktree, no transplant registry and no application anywhere.
  const home = process.env.GRAFT_HOME;
  assert.deepEqual(fs.readdirSync(home).sort(), ['laboratory', 'organ-bank'], 'planning touched nothing else in GRAFT_HOME');
  assert.equal(fs.existsSync(path.join(home, 'worktrees')), false);
  assert.equal(fs.existsSync(path.join(home, 'transplants.json')), false);
  assert.deepEqual(fs.readdirSync(work), ['home'], 'no application folder was created');
  assert.equal(plan.executionAvailable, false);
  // The execution gate (Checkpoint B) admits the two-capability plan as a whole …
  const view = viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX });
  const eligibility = checkExecutionEligibility(view);
  assert.deepEqual(eligibility, { ok: true, problems: [], capabilities: 2 });
  // … and refuses it the moment one capability would not be executed the way the plan says.
  const dropped = { ...view, steps: view.steps.filter((s) => s.capability?.slug !== 'feature-flags-library') };
  assert.match(checkExecutionEligibility(dropped).problems.join(' '), /silently disappear/);
  const noReverify = { ...view, steps: view.steps.filter((s) => s.type !== 'REVERIFY_CAPABILITY') };
  assert.match(checkExecutionEligibility(noReverify).problems.join(' '), /not re-verified after the later capabilities/);
  const unsupported = { ...view, steps: view.steps.map((s) => (s.type === 'ADAPT_LIBRARY_CAPABILITY' ? { ...s, supported: false } : s)) };
  assert.match(checkExecutionEligibility(unsupported).problems.join(' '), /not supported/);
});

test('apply order is the blueprint\'s declared order: deterministic across blueprints, visible in the plan, overridden only by a declared dependency', needBoth, async (t) => {
  sandbox(t); await bankBoth();
  // Deterministic for one blueprint: the same plan is produced every time.
  const bp = twoCapabilityBlueprint();
  const once = buildAssemblyPlan(bp, { host: HTTP(), index: EMPTY_INDEX }).order.map((o) => o.label);
  for (let i = 0; i < 3; i += 1) assert.deepEqual(buildAssemblyPlan(bp, { host: HTTP(), index: EMPTY_INDEX }).order.map((o) => o.label), once);
  // These two capabilities declare no dependency on each other, so (Checkpoint B) the order is the
  // one the blueprint declares: authentication first, feature flags second — not the goal id.
  const analysis = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.deepEqual(analysis.dependencies.filter((d) => d.needs && d.blocking), [], 'neither capability requires the other');
  assert.deepEqual(topologicalOrder(['b', 'a'], []).order, ['b', 'a'], 'no edges: declared order, whatever the ids');
  assert.deepEqual(topologicalOrder(['goal-ff', 'goal-aa'], []).order, ['goal-ff', 'goal-aa']);
  assert.deepEqual(topologicalOrder(['goal-ff', 'goal-aa'], [['goal-aa', 'goal-ff']]).order, ['goal-aa', 'goal-ff'], 'a declared dependency edge overrides the declared order');
  // Across blueprints with random goal ids, the first capability is always the first declared.
  const first = new Set();
  for (let i = 0; i < 12; i += 1) first.add(buildAssemblyPlan(twoCapabilityBlueprint({ name: `Portal ${i}` }), { host: HTTP(), index: EMPTY_INDEX }).order[0].label);
  assert.deepEqual([...first], ['User authentication']);
  // The plan says so itself, and the execution can cite the same rule.
  const plan = buildAssemblyPlan(bp, { host: HTTP(), index: EMPTY_INDEX });
  assert.equal(plan.ordering.rule, 'blueprint-declared-order');
  assert.deepEqual(plan.order.map((o) => [o.position, o.declaredPosition, o.decidedBy]), [[1, 1, 'blueprint-declared-order'], [2, 2, 'blueprint-declared-order']]);
  // Declaring them the other way round changes the order, and makes an earlier plan STALE.
  const reversed = createBlueprint({ name: 'Flags first', description: 'features can be turned on for some people, who sign in', hostIntent: 'new-application' });
  addGoal(reversed, { category: 'feature-flags' }); addGoal(reversed, { category: 'authentication' });
  for (const g of analyseBlueprint(reversed, { index: EMPTY_INDEX }).goals) { const c = g.candidates.find((x) => x.kind === 'organ'); selectImplementation(reversed, g.goalId, { kind: 'organ', slug: c.slug, capabilityId: c.capabilityId, name: c.name }); }
  assert.deepEqual(buildAssemblyPlan(reversed, { host: HTTP(), index: EMPTY_INDEX }).order.map((o) => o.label), ['Feature flags', 'User authentication']);
  const before = buildAssemblyPlan(bp, { host: HTTP(), index: EMPTY_INDEX });
  bp.goals.reverse();
  assert.equal(viewAssemblyPlan(before, bp, { index: EMPTY_INDEX }).status, 'STALE', 'reordering the goals is a blueprint change');
});

test('planning judges structure; the source verdict is an execution precondition, and stays one', needBoth, async (t) => {
  sandbox(t); await bankBoth();
  const organ = path.join(bankDir(), 'feature-flags-library.graft');
  const good = readManifest(organ);
  assert.equal(good.provenance.verifiedInSource.verdict, 'VERIFIED');

  // A library whose own source verification is no longer VERIFIED.
  const unverified = structuredClone(good);
  unverified.provenance.verifiedInSource.verdict = 'NEEDS_REVIEW';
  writeManifest(bankDir(), unverified);
  const plan = buildAssemblyPlan(twoCapabilityBlueprint(), { host: HTTP(), index: EMPTY_INDEX });

  // Whatever the planner says about structure, the execution recheck refuses to adapt it. That
  // split is deliberate: structural support and "this capability was proven" are different claims,
  // and only the second is allowed to gate the writes.
  const recheck = recheckLibraryAdaptationSupport({
    plan: { host: { profile: 'esm-node-http-central', moduleSystem: 'esm' } },
    manifest: readManifest(organ),
    engine: { genome: { identity: { capabilityId: 'cap:x' } } },
    hostFingerprint: { profile: 'esm-node-http-central', moduleSystem: 'esm' },
  });
  assert.equal(recheck.ok, false);
  assert.match(recheck.blocked.join(' '), /only a VERIFIED capability is adapted/);
  // And planning never carries a destination result: no step holds a verdict, and the plan holds
  // no verification. It says what WOULD be run, which is a different thing from what was proven.
  assert.ok(plan.steps.every((s) => s.verdict === undefined && s.verification === undefined && s.outcome === undefined));
  assert.equal(plan.verification, undefined);
  assert.equal(plan.executionAvailable, false);

  writeManifest(bankDir(), good);
  assert.equal(buildAssemblyPlan(twoCapabilityBlueprint(), { host: HTTP(), index: EMPTY_INDEX }).readiness, 'READY_TO_ASSEMBLE');
});
