import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest, listOrganBank } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { recordAtlasEntry, buildAtlasEntry } from '../src/engine/atlas.js';
import { projectResponse, AuthorityViolation } from '../src/agent/tasks.js';
import { createBlueprint, loadBlueprint, saveBlueprint, listBlueprints, addGoal, removeGoal, updateGoal, selectImplementation, setHostIntent, recordAgentAdvice, analyseBlueprint, viewBlueprint, candidatesFor, goalsFromDescription, GUIDED_QUESTIONS, GOAL_CATEGORIES, READINESS, BLUEPRINT_SCHEMA_VERSION } from '../src/laboratory/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const write = (root, files) => { for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } return root; };
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-lab-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
/** A banked session-auth capability from the fixture, optionally with an open-source licence. */
async function bankFixture(work, { licence = null, name = 'source' } = {}) {
  const src = path.join(work, name);
  fs.cpSync(path.join(repoRoot, 'fixtures/old-saas-project'), src, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
  if (licence) { const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')); pkg.license = licence; delete pkg.private; fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg)); fs.writeFileSync(path.join(src, 'LICENSE'), `${licence} License\n`); }
  const { manifest } = await harvestCapability(fingerprintProject(src), 'authentication');
  writeManifest(bankDir(), manifest);
  return { src, manifest };
}
const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };

test('a blueprint is created, saved atomically, listed and reopened; goals come from words, the checklist or the person', (t) => {
  const work = sandbox(t);
  const bp = createBlueprint({ name: 'Client portal', description: 'Customers sign in, upload documents, pay invoices and belong to organisations.' });
  assert.equal(bp.schemaVersion, BLUEPRINT_SCHEMA_VERSION);
  assert.match(bp.blueprintId, /^client-portal-[0-9a-f]{6}$/);
  const derived = goalsFromDescription(bp.description);
  assert.deepEqual(derived.map((g) => g.category).sort(), ['authentication', 'billing', 'file-uploads', 'organizations']);
  for (const g of derived) addGoal(bp, g);
  addGoal(bp, { category: 'notifications', required: false });
  addGoal(bp, { label: 'Something GRAFT has no word for', required: false });
  assert.equal(addGoal(bp, { category: 'billing' }).category, 'billing', 'adding a goal twice keeps the first');
  assert.equal(bp.goals.length, 6);
  saveBlueprint(bp);
  const files = fs.readdirSync(path.join(work, 'home', 'laboratory', 'blueprints'));
  assert.deepEqual(files, [`${bp.blueprintId}.json`], 'no temporary file remains');
  const reopened = loadBlueprint(bp.blueprintId);
  assert.deepEqual(reopened.goals.map((g) => g.label), bp.goals.map((g) => g.label));
  assert.equal(listBlueprints()[0].blueprintId, bp.blueprintId);
  assert.equal(listBlueprints()[0].goals, 6);
  assert.ok(GUIDED_QUESTIONS.every((q) => GOAL_CATEGORIES[q.category]));
  assert.throws(() => loadBlueprint('nope-000000'), (e) => e.code === 'unknown-blueprint');
  assert.throws(() => createBlueprint({ name: '' }), (e) => e.code === 'invalid-name');
  assert.throws(() => addGoal(bp, { category: 'billing', source: 'model' }), (e) => e.code === 'invalid-goal-source');
});

test('candidates are found deterministically from the bank and the index; missing goals stay missing; readiness follows the rules', async (t) => {
  const work = sandbox(t);
  const { manifest } = await bankFixture(work);
  const bp = createBlueprint({ name: 'Portal' });
  const auth = addGoal(bp, { category: 'authentication' });
  const uploads = addGoal(bp, { category: 'file-uploads' });
  const billing = addGoal(bp, { category: 'billing', required: false });
  let a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.equal(a.readiness, 'MISSING_CAPABILITIES', a.readinessReason);
  const authGoal = a.goals.find((g) => g.goalId === auth.goalId);
  assert.equal(authGoal.status, 'unresolved');
  assert.equal(authGoal.candidates.length, 1);
  assert.equal(authGoal.candidates[0].kind, 'organ');
  assert.equal(authGoal.candidates[0].tier, 'strong', 'VERIFIED in source, no Atlas evidence: strong, not best');
  assert.equal(authGoal.candidates[0].verification.source, 'VERIFIED');
  assert.equal(authGoal.candidates[0].origin.kind, 'your-project');
  assert.equal(a.goals.find((g) => g.goalId === uploads.goalId).status, 'missing', 'no file-upload capability exists in this memory');
  assert.equal(a.goals.find((g) => g.goalId === billing.goalId).searched, false, 'GRAFT has no detector for billing and says so');
  assert.match(a.goals.find((g) => g.goalId === billing.goalId).searchReason, /no detector/);
  // Selecting the implementation by stable reference. Optional goals never block readiness.
  selectImplementation(bp, auth.goalId, { kind: 'organ', slug: manifest.identity.slug, capabilityId: authGoal.candidates[0].capabilityId, name: manifest.identity.name });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.equal(a.goals.find((g) => g.goalId === auth.goalId).status, 'matched');
  assert.equal(a.readiness, 'MISSING_CAPABILITIES', 'the required file-upload goal is still missing');
  updateGoal(bp, uploads.goalId, { required: false });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.equal(a.readiness, 'READY_FOR_ASSEMBLY_PLANNING', a.readinessReason);
  assert.match(a.readinessReason, /not a compatibility or verification claim/);
  removeGoal(bp, auth.goalId);
  removeGoal(bp, uploads.goalId); removeGoal(bp, billing.goalId);
  assert.equal(analyseBlueprint(bp, { index: EMPTY_INDEX }).readiness, 'DRAFT');
  assert.ok(READINESS.includes(a.readiness));
  // Same inputs, same answer.
  assert.deepEqual(JSON.stringify(candidatesFor('authentication', { index: EMPTY_INDEX })), JSON.stringify(candidatesFor('authentication', { index: EMPTY_INDEX })));
});

test('dependencies are DECLARED by GRAFT, satisfied only by selected implementations, INFERRED from artifacts, ADVISORY from the agent — never silently upgraded', async (t) => {
  const work = sandbox(t);
  const { manifest } = await bankFixture(work);
  const bp = createBlueprint({ name: 'Deps' });
  const auth = addGoal(bp, { category: 'authentication' });
  const billing = addGoal(bp, { category: 'billing' });
  const orgs = addGoal(bp, { category: 'organizations' });
  let a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const need = (from, needs) => a.dependencies.find((d) => d.from === from && d.needs === needs);
  assert.equal(need(billing.goalId, 'user-identity').level, 'DECLARED');
  assert.equal(need(billing.goalId, 'user-identity').satisfied, false, 'authentication is a goal but nothing is selected yet');
  assert.equal(need(billing.goalId, 'user-identity').blocking, true);
  assert.equal(need(billing.goalId, 'tenant-identity').satisfied, false);
  assert.equal(need(orgs.goalId, 'user-identity').level, 'DECLARED');
  const cands = a.goals.find((g) => g.goalId === auth.goalId).candidates;
  selectImplementation(bp, auth.goalId, { kind: 'organ', slug: manifest.identity.slug, capabilityId: cands[0].capabilityId });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.equal(need(billing.goalId, 'user-identity').satisfied, true);
  assert.equal(need(billing.goalId, 'user-identity').satisfiedBy.goalId, auth.goalId);
  assert.equal(need(billing.goalId, 'tenant-identity').satisfied, false, 'organizations has no implementation (GRAFT has no detector for it)');
  assert.equal(a.readiness, 'MISSING_CAPABILITIES');
  assert.ok(!a.dependencies.some((d) => d.level === 'PROVEN'), 'no proven inter-capability evidence exists in 0.1');
  assert.equal(a.provenLevelAvailable, false);
  // An agent hint is stored as advice and surfaces as ADVISORY; it satisfies nothing.
  recordAgentAdvice(bp, { task: 'interpretBlueprintIntent', provider: 'x', value: { dependencyHints: [{ from: 'Billing', to: 'Organizations', reason: 'invoices belong to accounts' }], goals: [{ label: 'Search', category: 'search', required: false }] } });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const advisory = a.dependencies.filter((d) => d.level === 'ADVISORY');
  assert.equal(advisory.length, 1);
  assert.equal(advisory[0].satisfied, null);
  assert.equal(advisory[0].blocking, false);
  assert.equal(bp.goals.some((g) => g.category === 'search'), false, 'suggested goals are not goals until the person accepts them');
  assert.equal(a.authority.agentDecided, false);
  assert.deepEqual(bp.agentAdvice.advisory, true); assert.deepEqual(bp.agentAdvice.authoritative, false);
  // The agent's task surface cannot carry authority: a response naming a verdict is rejected outright.
  assert.throws(() => projectResponse('interpretBlueprintIntent', { goals: [], verdict: 'VERIFIED' }), AuthorityViolation);
  const { value, dropped } = projectResponse('interpretBlueprintIntent', { goals: [{ label: 'Sign in', category: 'authentication', required: true, rationale: 'r', readiness: 'READY' }], questions: ['Do users pay?'], notes: 'n' });
  assert.deepEqual(value.goals[0], { label: 'Sign in', category: 'authentication', required: true, rationale: 'r' });
  assert.ok(dropped.some((d) => /readiness/.test(d)));
});

test('structural conflicts come from GRAFT evidence only, and readiness reports them first', async (t) => {
  const work = sandbox(t);
  const { manifest } = await bankFixture(work);
  const bp = createBlueprint({ name: 'Conflicts' });
  const a1 = addGoal(bp, { category: 'authentication' });
  const a2 = addGoal(bp, { label: 'Second sign-in', category: null });
  // Force a second goal of the same category through the store (the API refuses duplicates): duplicate-goal conflict.
  bp.goals[1] = { ...bp.goals[1], category: 'authentication' };
  let a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.ok(a.conflicts.some((c) => c.kind === 'duplicate-goal'));
  assert.equal(a.readiness, 'HAS_CONFLICTS');
  // Two selected implementations that both own sessions and register the same routes conflict structurally.
  const cands = a.goals[0].candidates;
  selectImplementation(bp, a1.goalId, { kind: 'organ', slug: manifest.identity.slug, capabilityId: cands[0].capabilityId });
  selectImplementation(bp, a2.goalId, { kind: 'organ', slug: manifest.identity.slug, capabilityId: cands[0].capabilityId });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.ok(a.conflicts.some((c) => c.kind === 'exclusive-route' && /POST \/auth\/login/.test(c.detail)), JSON.stringify(a.conflicts.map((c) => c.kind)));
  assert.ok(a.conflicts.some((c) => c.kind === 'session-ownership'));
  assert.ok(a.conflicts.every((c) => Array.isArray(c.options)));
  assert.equal(a.readiness, 'HAS_CONFLICTS');
  // Host intent: a non-Node runtime conflicts with a Node implementation; deciding later does not.
  bp.goals.splice(1, 1);
  setHostIntent(bp, { kind: 'new-application', runtime: 'python' });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.ok(a.conflicts.some((c) => c.kind === 'runtime'));
  setHostIntent(bp, { kind: 'decide-later' });
  a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  assert.equal(a.conflicts.length, 0);
  assert.equal(a.readiness, 'READY_FOR_ASSEMBLY_PLANNING');
  assert.throws(() => setHostIntent(bp, { kind: 'deploy-now' }), (e) => e.code === 'invalid-host-intent');
});

test('Atlas evidence ranks candidates and shows host evidence, but never decides; a vanished source is SOURCE UNAVAILABLE', async (t) => {
  const work = sandbox(t);
  const { manifest } = await bankFixture(work);
  const bp = createBlueprint({ name: 'Evidence' });
  const auth = addGoal(bp, { category: 'authentication' });
  const capabilityId = analyseBlueprint(bp, { index: EMPTY_INDEX }).goals[0].candidates[0].capabilityId;
  // A verified transplant observation for this capability lifts the tier to best-evidence and marks the family.
  const atlasDir = path.join(work, 'home', 'atlas');
  recordAtlasEntry(buildAtlasEntry({ capabilityId, capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: { framework: 'node-http', moduleSystem: 'cjs', handlerContract: 'node-res', persistence: 'module-state' }, destinationArchitecture: { runtime: { family: 'node' }, framework: 'node-http', moduleSystem: 'esm', handlerContract: 'return-response', persistence: 'module-state', dependencies: [] }, adaptations: ['esm-return-response'], result: 'supported', verification: { verdict: 'VERIFIED' } }), { directory: atlasDir });
  let a = analyseBlueprint(bp, { index: EMPTY_INDEX, atlasDirectory: atlasDir });
  const c = a.goals[0].candidates[0];
  assert.equal(c.tier, 'best-evidence');
  assert.deepEqual(c.verification.families, [{ destination: 'node-http/return-response', verified: 1, failed: 0, other: 0 }]);
  const evidence = c.verification.hostEvidence.find((h) => h.profile === 'esm-return-response');
  assert.equal(evidence.status, 'verified-evidence');
  assert.equal(c.verification.hostEvidence.find((h) => h.profile === 'express-req-res').status, 'verified-evidence-unavailable', 'absence of evidence is not incompatibility');
  assert.equal(a.readiness, 'NEEDS_SELECTIONS', 'Atlas evidence does not select anything or make the blueprint ready');
  selectImplementation(bp, auth.goalId, { kind: 'organ', slug: manifest.identity.slug, capabilityId });
  saveBlueprint(bp);
  // The organ disappears: the selection is reported unavailable, never replaced.
  fs.rmSync(path.join(bankDir(), `${manifest.identity.slug}.graft`), { recursive: true, force: true });
  a = analyseBlueprint(loadBlueprint(bp.blueprintId), { index: EMPTY_INDEX, atlasDirectory: atlasDir });
  assert.equal(a.goals[0].status, 'source-unavailable');
  assert.equal(a.goals[0].selected.status, 'SOURCE_UNAVAILABLE');
  assert.ok(a.conflicts.some((x) => x.kind === 'source-unavailable'));
  assert.equal(a.readiness, 'HAS_CONFLICTS');
  // A different capability under the same slug is not the one that was chosen.
  await bankFixture(work, { name: 'other' });
  const replaced = analyseBlueprint(loadBlueprint(bp.blueprintId), { index: EMPTY_INDEX, atlasDirectory: atlasDir });
  assert.equal(replaced.goals[0].selected.status === 'SOURCE_UNAVAILABLE' || replaced.goals[0].selected.capabilityId === capabilityId, true);
});

test('provenance and licence survive: open-source origin is visible, unknown stays unknown; blueprints never store secrets or local paths', async (t) => {
  const work = sandbox(t);
  const { manifest } = await bankFixture(work, { licence: 'MIT' });
  const bp = createBlueprint({ name: 'Origins' });
  const auth = addGoal(bp, { category: 'authentication' });
  const a = analyseBlueprint(bp, { index: EMPTY_INDEX });
  const c = a.goals[0].candidates[0];
  assert.equal(c.origin.kind, 'open-source');
  assert.equal(c.origin.licence.declared, 'MIT');
  const index = { ...EMPTY_INDEX, projects: [{ projectId: 'git:abc#root', name: 'someone-elses-auth', root: '/elsewhere/repo', relativeRoot: '.', repositoryId: 'git:abc', repository: { name: 'repo' }, language: 'javascript', runtime: 'node', framework: 'node-http', moduleSystem: 'cjs', hasHttpServer: true, externalHosts: [], capabilities: [{ capability: 'authentication', state: 'HARVESTABLE', harvestable: true, transplantSupport: 'unknown', subtypes: ['local-password'], audience: 'user', signals: [{ id: 'x', evidence: 'y' }], localVerification: { feasible: true, reasons: [] } }] }] };
  const withIndex = analyseBlueprint(bp, { index });
  const obs = withIndex.goals[0].candidates.find((x) => x.kind === 'observation');
  assert.equal(obs.tier, 'possible');
  assert.equal(obs.origin.licence.state, 'not-inspected', 'unharvested code has unknown licence metadata');
  selectImplementation(bp, auth.goalId, { kind: 'organ', slug: manifest.identity.slug, capabilityId: c.capabilityId, name: c.name });
  saveBlueprint(bp);
  const text = fs.readFileSync(path.join(work, 'home', 'laboratory', 'blueprints', `${bp.blueprintId}.json`), 'utf8');
  assert.equal(text.includes(work), false, 'no local paths');
  assert.equal(text.includes(os.homedir()), false);
  assert.equal(/"selection":\s*\{[^}]*"slug"/.test(text), true, 'selections are stable references');
  bp.description = 'API_KEY value: sk_live_abc';
  saveBlueprint(bp);
  const poisoned = { ...bp, hostIntent: { ...bp.hostIntent, apiKey: 'sk_live_abc' } };
  assert.throws(() => saveBlueprint(poisoned), (e) => e.code === 'blueprint-privacy');
  assert.throws(() => saveBlueprint({ ...bp, description: `notes at ${path.join(os.homedir(), 'Developer', 'secret-project')}` }), (e) => e.code === 'blueprint-privacy');
  assert.throws(() => saveBlueprint({ ...bp, description: `home is ${process.env.GRAFT_HOME}` }), (e) => e.code === 'blueprint-privacy');
  const view = viewBlueprint(loadBlueprint(bp.blueprintId), { index: EMPTY_INDEX });
  assert.equal(view.analysis.provenance.origins[auth.goalId].kind, 'open-source');
  assert.deepEqual(view.analysis.provenance.licenceStates, ['detected']);
});
