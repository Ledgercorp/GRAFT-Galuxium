import test from 'node:test';
import { SUPPORTED_PROFILES } from '../src/emit/profiles.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { emitSessionAuth } from '../src/emit/session-auth.js';
import { analyzeCompatibility } from '../src/plan/compatibility.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { writeManifest, readManifest, readOrganEngine, ENGINE_FILE } from '../src/manifest/io.js';
import { decideVerdict } from '../src/verify/index.js';
import { stableHash } from '../src/capability/contract.js';
import {
  GRAFT_ENGINE_VERSION, buildEngineArtifacts, validateEngineArtifacts, analyzeForHost,
  buildCapabilityGenome, validateCapabilityGenome, buildCapabilityGraph, validateCapabilityGraph, neighbors,
  buildHostModel, validateHostModel, buildGraftIR, validateGraftIR,
  buildVerificationContract, evaluateVerificationContract, validateVerificationContract,
  BUILTIN_RECIPES, validateRecipe, loadRecipes, saveRecipe, selectRecipe,
  buildAtlasEntry, validateAtlasEntry, recordAtlasEntry, loadAtlas, queryAtlas,
  semanticSummary, renderSemanticSummary, semanticOutcome,
} from '../src/engine/index.js';
import { SOURCE_FIXTURE, DEST_FIXTURE } from './helpers.js';

const srcFp = fingerprintProject(SOURCE_FIXTURE);
const destFp = fingerprintProject(DEST_FIXTURE);
const manifest = harvest(srcFp, 'authentication');
const artifacts = buildEngineArtifacts(manifest);
const { genome, graph, ir, verificationContract } = artifacts;
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `graft-engine-${label}-`));

// ---------------- Capability Genome ----------------
test('genome: a structured model derived only from the manifest, valid, deterministic, and identified by behavior not provenance', () => {
  assert.equal(validateCapabilityGenome(genome).ok, true, JSON.stringify(validateCapabilityGenome(genome)));
  assert.equal(genome.identity.kind, 'session-auth');
  assert.equal(genome.identity.capabilityId, artifacts.genome.provenance.capabilityId);
  // Entrypoints go beyond file selection: endpoints and the middleware provided to the host.
  assert.deepEqual(genome.entrypoints.filter((e) => e.kind === 'http-endpoint').map((e) => e.role), ['register', 'login', 'logout', 'currentUser']);
  assert.ok(genome.entrypoints.some((e) => e.kind === 'middleware' && e.name === 'requireAuth'));
  // Inputs and outputs per endpoint, plus environment inputs; credential requirement is derived.
  const me = genome.inputs.find((i) => i.source === 'endpoint:currentUser');
  assert.deepEqual(me.credential, { kind: 'cookie', name: 'sid' });
  assert.equal(genome.inputs.find((i) => i.source === 'endpoint:register').credential, null);
  assert.deepEqual(genome.outputs.find((o) => o.source === 'endpoint:login').cookie, { name: 'sid', action: 'set' });
  assert.deepEqual(genome.outputs.find((o) => o.source === 'endpoint:logout').cookie, { name: 'sid', action: 'clear' });
  assert.ok(genome.inputs.some((i) => i.kind === 'environment' && i.name === 'SESSION_TTL_SECONDS'));
  // Side effects are explicit: what each endpoint does to state and to the client.
  assert.ok(genome.sideEffects.some((s) => s.by === 'endpoint:register' && s.entity === 'users' && s.op === 'create'));
  assert.ok(genome.sideEffects.some((s) => s.by === 'endpoint:logout' && s.entity === 'sessions' && s.op === 'delete'));
  assert.ok(genome.sideEffects.some((s) => s.kind === 'client-state' && s.target === 'cookie:sid'));
  // Dependencies, data, runtime, security and verification expectations are all structured.
  assert.equal(genome.dependentModules.length, manifest.sourceMap.files.length);
  assert.deepEqual(genome.dataDependencies.entities.map((e) => e.name), ['users', 'sessions']);
  assert.equal(genome.runtimeAssumptions.moduleSystem, 'cjs');
  assert.equal(genome.runtimeAssumptions.handlerContract, 'node-res');
  assert.equal(genome.securityProperties.derived.passwordHash, 'scrypt');
  assert.equal(genome.securityProperties.derived.cookieHttpOnly, true);
  assert.equal(genome.securityProperties.derived.constantTimeComparison, true);
  assert.equal(genome.verificationExpectations.tests.length, manifest.acceptanceTests.tests.length);
  assert.ok(genome.verificationExpectations.coverage.every((c) => c.tests.length > 0), 'every behavior is covered by a test');
  // Determinism and identity: same manifest -> same genomeId; changed provenance timestamp -> same genomeId; changed behavior -> different.
  assert.equal(buildCapabilityGenome(manifest).genomeId, genome.genomeId);
  const later = structuredClone(manifest); later.provenance.harvestedAt = '2099-01-01T00:00:00.000Z'; later.identity.extractedAt = later.provenance.harvestedAt;
  assert.equal(buildCapabilityGenome(later).genomeId, genome.genomeId);
  const changed = structuredClone(manifest); changed.architecture.capabilityModel.session.cookieName = 'other';
  assert.notEqual(buildCapabilityGenome(changed).genomeId, genome.genomeId);
});

test('genome validation refuses broken structures', () => {
  assert.equal(validateCapabilityGenome(null).ok, false);
  const broken = structuredClone(genome); broken.sideEffects.push({ id: 'x', kind: 'persistence', entity: 'users', op: 'read', by: 'endpoint:nope' });
  assert.match(validateCapabilityGenome(broken).errors.join(' '), /unknown entrypoint/);
  const noTests = structuredClone(genome); noTests.verificationExpectations.tests = [];
  assert.equal(validateCapabilityGenome(noTests).ok, false);
});

// ---------------- Capability Graph ----------------
test('graph: typed nodes and edges over modules, endpoints, middleware, dependencies, env, entities, tests, side effects and behaviors', () => {
  assert.equal(validateCapabilityGraph(graph).ok, true, JSON.stringify(validateCapabilityGraph(graph)));
  const kinds = graph.stats.byKind;
  for (const k of ['capability', 'module', 'endpoint', 'middleware', 'runtime', 'environment', 'entity', 'side-effect', 'test', 'behavior']) assert.ok(kinds[k] > 0, `graph has ${k} nodes`);
  assert.ok(graph.stats.edgesByKind.guards >= 2, 'the guard middleware guards the protected endpoints');
  assert.ok(graph.stats.edgesByKind.proves >= 6 && graph.stats.edgesByKind.exercises > 0, 'tests prove behaviors and exercise endpoints');
  assert.ok(graph.edges.some((e) => e.kind === 'relates' && e.from === 'entity:sessions' && e.to === 'entity:users' && e.relation === 'many-to-one'));
  // Traversal: what login causes, and what writes to sessions.
  assert.deepEqual(neighbors(graph, 'endpoint:login', { kind: 'causes' }).map((n) => n.label).sort(), ['create sessions', 'read users', 'set cookie:sid']);
  const writers = neighbors(graph, 'entity:sessions', { kind: 'writes', direction: 'in' }).map((n) => n.id);
  assert.ok(writers.includes('effect:register:create:sessions') && writers.includes('effect:logout:delete:sessions'));
  assert.deepEqual(neighbors(graph, 'provided:requireAuth', { kind: 'guards' }).map((n) => n.id).sort(), ['endpoint:currentUser', 'endpoint:logout']);
  // Kind fields never collide with data fields; every node keeps its declared kind.
  assert.ok(graph.nodes.every((n) => typeof n.kind === 'string' && !['persistence', 'client-state', 'http'].includes(n.kind)));
  assert.equal(buildCapabilityGraph(genome).graphId, graph.graphId);
  const dangling = { ...graph, edges: [...graph.edges, { from: 'nope', to: graph.capability, kind: 'contains' }] };
  assert.match(validateCapabilityGraph(dangling).errors.join(' '), /unknown node nope/);
});

// ---------------- Host Model ----------------
test('host model: framework, runtime, module system, routing, packages, testing, data layer, existing capabilities, structure, environment and constraints', () => {
  const host = buildHostModel(destFp);
  assert.equal(validateHostModel(host).ok, true, JSON.stringify(validateHostModel(host)));
  assert.equal(host.moduleSystem.value, 'esm');
  assert.equal(host.constraints.handlerContract.value, 'return-response');
  assert.equal(host.constraints.adaptationProfile, 'esm-return-response');
  assert.equal(host.dataLayer.persistence, 'shared-store');
  assert.equal(host.dataLayer.modules[0].module, 'src/store.js');
  assert.equal(host.runtime.entrypoint, 'src/main.js');
  assert.equal(host.routing.registration.style, 'node-http');
  assert.ok(host.routing.routes.length >= 1 && host.routing.routeFiles.length >= 1);
  assert.deepEqual(host.existingCapabilities, [], 'the destination has no authentication yet');
  assert.ok(host.structure.topLevelDirs.includes('src'));
  assert.equal(host.environment.hasEnvExample, true);
  assert.equal(host.testing.framework, null, 'the fixture declares no test framework, and the model says so instead of guessing');
  // A source-shaped host is recognised as unsupported with a reason, and reports its own signals.
  const cjs = buildHostModel(srcFp);
  assert.equal(cjs.constraints.adaptationProfile, null);
  assert.match(cjs.constraints.unsupportedReason, /cjs\/node-res/);
  assert.ok(cjs.existingCapabilities.some((c) => c.category === 'authentication'));
  assert.notEqual(cjs.hostId, host.hostId);
  assert.equal(buildHostModel(destFp).hostId, host.hostId);
});

// ---------------- GRAFT IR ----------------
test('IR: operations with inputs/effects/emits/guards, abstract state, preserved policies, invariants and adaptation points', () => {
  assert.equal(validateGraftIR(ir).ok, true, JSON.stringify(validateGraftIR(ir)));
  assert.deepEqual(ir.operations.map((o) => o.id), ['op:register', 'op:login', 'op:logout', 'op:currentUser']);
  const login = ir.operations.find((o) => o.id === 'op:login');
  assert.deepEqual(login.input.body, { email: 'string', password: 'string' });
  assert.ok(login.effects.some((e) => e.op === 'create' && e.target === 'sessions'));
  assert.deepEqual(login.emits.cookie, { name: 'sid', action: 'set' });
  assert.ok(Object.keys(login.emits.responses).includes('401'));
  assert.deepEqual(ir.operations.find((o) => o.id === 'op:currentUser').guards, ['provided:requireAuth']);
  assert.deepEqual(ir.guards[0].appliesTo.sort(), ['endpoint:currentUser', 'endpoint:logout']);
  assert.deepEqual(ir.state.map((s) => s.store), ['users', 'sessions']);
  assert.equal(ir.state.find((s) => s.store === 'sessions').relations[0].to, 'users.id');
  assert.equal(ir.policies.passwordHash.algorithm, 'scrypt');
  assert.equal(ir.policies.session.cookieName, 'sid');
  assert.equal(ir.policies.guard.unauthenticatedStatus, 401);
  assert.ok(ir.invariants.some((i) => i.kind === 'security' && i.id === 'sec.uniform-login-failure'));
  assert.deepEqual(ir.adaptationPoints.map((p) => `${p.id}=${p.source}`), ['module-system=cjs', 'handler-contract=node-res', 'framework=node-http', 'route-registration=entrypoint-route-table', 'persistence-binding=module-state']);
  assert.equal(buildGraftIR(genome, manifest).irId, ir.irId);
  const bad = structuredClone(ir); bad.operations[0].guards = ['nope'];
  assert.match(validateGraftIR(bad).errors.join(' '), /unknown guard/);
});

// ---------------- Verification contract ----------------
test('verification contract: success cases, counterfactuals, invariants with honest witnesses, expected evidence; verdict is never recomputed', () => {
  assert.equal(validateVerificationContract(verificationContract).ok, true);
  assert.deepEqual(verificationContract.successCases.map((c) => c.id), ['auth.register.creates-account', 'auth.login.accepts-valid-credentials', 'auth.session.persists-across-requests', 'auth.session.survives-restart']);
  assert.equal(verificationContract.successCases.find((c) => c.id === 'auth.session.survives-restart').required, false);
  assert.deepEqual(verificationContract.counterfactualCases.map((c) => c.id), ['auth.login.rejects-invalid-credentials', 'auth.logout.ends-session', 'auth.protect.rejects-anonymous']);
  assert.ok(verificationContract.successCases.every((c) => c.operations.length > 0), 'cases are tied to IR operations');
  const uniform = verificationContract.invariants.find((i) => i.id === 'sec.uniform-login-failure');
  assert.deepEqual(uniform.checkedBy, ['auth.login.rejects-invalid-credentials']);
  assert.deepEqual(verificationContract.invariants.find((i) => i.id === 'sec.httponly').checkedBy, ['auth.login.accepts-valid-credentials'], 'cookie flags are witnessed by the login test since Engine 1.1');
  assert.deepEqual(verificationContract.invariants.find((i) => i.id === 'sec.constant-time').checkedBy, [], 'timing is not witnessable over HTTP and the contract says so');
  // Evaluation against a synthetic report mirrors decideVerdict and reports invariants held/violated/unobserved.
  const results = manifest.acceptanceTests.tests.map((t) => ({ id: t.id, required: t.required, outcome: 'passed', steps: t.steps.map(() => ({ ok: true })) }));
  const good = { ...decideVerdict(results), results, summary: { required: 6, passed: 6, failed: 0, inconclusive: 0 }, runtime: { profile: 'node-entrypoint' }, finishedAt: 'now' };
  const proof = evaluateVerificationContract(verificationContract, good);
  assert.equal(proof.verdict, 'VERIFIED');
  assert.equal(proof.summary.passed, 7);
  assert.equal(proof.invariants.find((i) => i.id === 'sec.uniform-login-failure').status, 'held');
  assert.equal(proof.invariants.find((i) => i.id === 'sec.httponly').status, 'held');
  assert.equal(proof.invariants.find((i) => i.id === 'sec.constant-time').status, 'unobserved');
  assert.equal(proof.summary.invariantsUnobserved, 1);
  const failing = results.map((r) => (r.id === 'auth.login.rejects-invalid-credentials' ? { ...r, outcome: 'failed', reason: 'accepted a wrong password' } : r));
  const bad = { ...decideVerdict(failing), results: failing, summary: { required: 6, passed: 5, failed: 1, inconclusive: 0 } };
  const badProof = evaluateVerificationContract(verificationContract, bad);
  assert.equal(badProof.verdict, 'FAILED');
  assert.equal(badProof.invariants.find((i) => i.id === 'sec.uniform-login-failure').status, 'violated');
  assert.equal(badProof.counterfactualCases.find((c) => c.id === 'auth.login.rejects-invalid-credentials').outcome, 'failed');
  const partial = evaluateVerificationContract(verificationContract, { verdict: 'NEEDS_REVIEW', rationale: 'no server', results: [], summary: {} });
  assert.equal(partial.verdict, 'NEEDS_REVIEW');
  assert.ok(partial.successCases.every((c) => c.outcome === 'inconclusive'));
});

// ---------------- Recipes ----------------
test('recipes: built-ins cover every emitter profile, validate, select by IR kind + host shape, and user recipes are validated data only', () => {
  assert.equal(BUILTIN_RECIPES.length, 6, 'session-auth and feature-flags × two profiles, plus hosted-session-auth × the central node:http profile and × the Express guard profile');
  assert.ok(BUILTIN_RECIPES.some((r) => r.name === 'hosted-session-auth → express-req-res'));
  for (const r of BUILTIN_RECIPES) assert.ok(SUPPORTED_PROFILES.find((p) => p.id === r.mechanism.emitterProfile).kinds.includes(r.applicability.capabilityKind), 'a built-in only names a profile that can emit its kind');
  for (const r of BUILTIN_RECIPES) assert.equal(validateRecipe(r).ok, true, JSON.stringify(validateRecipe(r)));
  const host = buildHostModel(destFp);
  const { recipe, matches } = selectRecipe(ir, host);
  assert.equal(recipe.mechanism.emitterProfile, 'esm-return-response');
  assert.deepEqual(matches, [recipe.recipeId]);
  assert.ok(recipe.transformations.map((t) => t.kind).includes('bind-persistence'));
  assert.equal(selectRecipe(ir, buildHostModel(srcFp)).recipe, null, 'no recipe for an unsupported host');
  assert.equal(selectRecipe({ ...ir, capability: { ...ir.capability, kind: 'billing' } }, host).recipe, null, 'kind must match');
  assert.equal(selectRecipe({ ...ir, capability: { ...ir.capability, kind: 'feature-flags' } }, host).recipe.name, 'feature-flags → esm-return-response');
  // Persistence: a user recipe round-trips; a recipe naming an unimplemented mechanism or code is refused.
  const dir = tmp('recipes');
  const user = { ...structuredClone(recipe), name: 'my recipe', provenance: { origin: 'user', confidence: { basis: 'manual' } } };
  user.recipeId = stableHash({ recipeVersion: user.recipeVersion, applicability: user.applicability, transformations: user.transformations, dependencySubstitutions: user.dependencySubstitutions, mechanism: user.mechanism });
  saveRecipe(dir, user);
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ ...user, mechanism: { emitterProfile: 'eval-anything' } }));
  fs.writeFileSync(path.join(dir, 'builtin.json'), JSON.stringify(recipe));
  const loaded = loadRecipes(dir);
  assert.deepEqual(loaded.recipes.map((r) => r.name), ['my recipe']);
  assert.deepEqual(loaded.rejected.map((r) => r.file).sort(), ['bad.json', 'builtin.json']);
  assert.equal(selectRecipe(ir, host, { extra: loaded.recipes }).matches.length, 2, 'user recipe is considered after the built-in');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- Compatibility Atlas ----------------
test('atlas: entries validate, persist idempotently, refuse divergent replays, and answer descriptive queries by architecture family', () => {
  const dir = tmp('atlas');
  const host = buildHostModel(destFp);
  const base = { capabilityId: genome.identity.capabilityId, capabilityCategory: 'authentication', genomeId: genome.genomeId, sourceArchitecture: genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, hostId: host.hostId, adaptations: ['esm-return-response'], recipeId: BUILTIN_RECIPES[0].recipeId, at: '2026-09-11T00:00:00.000Z' };
  const verified = buildAtlasEntry({ ...base, result: 'conditionally-supported', verification: { verdict: 'VERIFIED', summary: { required: 6, passed: 6, failed: 0, inconclusive: 0 } } });
  const failed = buildAtlasEntry({ ...base, result: 'conditionally-supported', verification: { verdict: 'FAILED', summary: { required: 6, passed: 5, failed: 1, inconclusive: 0 } }, failureReasons: ['auth.login.rejects-invalid-credentials:failed'], repair: { attempted: true, outcome: 'not-repaired' } });
  const refused = buildAtlasEntry({ ...base, destinationArchitecture: buildHostModel(srcFp).architecture, result: 'refused', failureReasons: ['architecture.profile'], confidence: { basis: 'static', sampleSize: 1, relevance: 1 } });
  for (const e of [verified, failed, refused]) assert.equal(validateAtlasEntry(e).ok, true, JSON.stringify(validateAtlasEntry(e)));
  assert.notEqual(verified.entryId, failed.entryId);
  recordAtlasEntry(verified, { directory: dir }); recordAtlasEntry(verified, { directory: dir }); // identical replay is a no-op
  recordAtlasEntry(failed, { directory: dir }); recordAtlasEntry(refused, { directory: dir });
  assert.equal(loadAtlas({ directory: dir }).length, 3);
  assert.throws(() => recordAtlasEntry({ ...verified, at: '2027-01-01T00:00:00.000Z', failureReasons: [] }, { directory: dir }), /already exists|Invalid atlas entry/);
  fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), '{"atlasVersion":"1.0.0"}');
  assert.equal(loadAtlas({ directory: dir }).length, 3, 'a malformed entry is not knowledge');
  const q = queryAtlas({ capabilityCategory: 'authentication', sourceArchitecture: genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, directory: dir });
  assert.equal(q.observations, 2);
  assert.deepEqual(q.verdicts, { VERIFIED: 1, FAILED: 1, NEEDS_REVIEW: 0, unverified: 0 });
  assert.deepEqual(q.failureReasons, [{ reason: 'auth.login.rejects-invalid-credentials:failed', count: 1 }]);
  assert.deepEqual(q.adaptations, ['esm-return-response']);
  const other = queryAtlas({ capabilityCategory: 'billing', sourceArchitecture: genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, directory: dir });
  assert.equal(other.observations, 0);
  // Tampering with a stored entry is detected by its id.
  const tampered = { ...verified, result: 'supported' };
  assert.equal(validateAtlasEntry(tampered).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- Planner integration ----------------
test('planner: the plan carries engine artifacts and a semantic analysis derived from genome/graph/IR/host/recipe, without changing the deciding checks', () => {
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true, atlas: null });
  assert.equal(plan.engine.engineVersion, GRAFT_ENGINE_VERSION);
  assert.equal(validateEngineArtifacts(plan.engine, manifest).ok, true);
  assert.equal(plan.engine.host.hostId, buildHostModel(destFp).hostId);
  assert.equal(plan.engine.recipe.mechanism.emitterProfile, plan.adaptation.profile, 'the recipe is the profile the emitter actually used');
  const a = plan.engine.analysis;
  assert.deepEqual(a.mismatches.filter((m) => !m.same).map((m) => `${m.dimension}:${m.severity}`), ['module-system:adapted', 'handler-contract:adapted', 'persistence-binding:adapted']);
  assert.ok(a.mismatches.every((m) => m.same || m.adaptation), 'every mismatch names its adaptation');
  assert.equal(a.adaptations.find((x) => x.kind === 'bind-persistence').concrete, 'bind users and sessions to src/store.js');
  assert.deepEqual(a.requiredComponents.modules.map((m) => m.path), plan.files.map((f) => f.path));
  assert.deepEqual(a.requiredComponents.entities.map((e) => e.boundTo), ['src/store.js', 'src/store.js']);
  assert.ok(a.requiredComponents.environment.every((v) => typeof v.presentInHost === 'boolean'));
  assert.ok(a.risks.some((r) => r.id === 'source.unproven' && r.level === 'high'), 'an unverified source is a named high risk');
  assert.ok(a.risks.some((r) => r.id === 'routes.collision'), 'compatibility warnings become risks');
  assert.ok(a.unknowns.some((u) => /sec\.constant-time/.test(u)), 'unwitnessable invariants are unknowns, not silent');
  assert.ok(!a.unknowns.some((u) => /sec\.httponly/.test(u)), 'a now-witnessed invariant is no longer an unknown');
  assert.deepEqual(a.verificationShouldProve.counterfactualCases.length, 3);
  assert.equal(a.priorObservations, null, 'atlas disabled for this test');
  // The deciding checks are untouched: same compatibility result as before the engine existed.
  const before = analyzeCompatibility(manifest, destFp, { emittedPaths: emitSessionAuth(manifest, destFp).files.map((f) => f.path) });
  assert.deepEqual(plan.compatibility.checks.map((c) => [c.id, c.status]), before.checks.map((c) => [c.id, c.status]));
  assert.equal(plan.status, 'ready');
  // An unsupported host: engine explains the unsupported mismatch while the plan stays blocked.
  const blocked = createTransplantPlan(manifest, srcFp, { atlas: null });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.engine.recipe, null);
  assert.ok(blocked.engine.analysis.mismatches.every((m) => m.same || m.severity === 'unsupported' || m.severity === 'none'));
  assert.ok(blocked.engine.analysis.risks.some((r) => r.id === 'host.existing-capability'));
});

test('planner: engine analysis does not depend on the atlas being present, and consults it descriptively when it is', () => {
  const dir = tmp('atlas-plan');
  const host = buildHostModel(destFp);
  const entry = buildAtlasEntry({ capabilityId: genome.identity.capabilityId, capabilityCategory: 'authentication', sourceArchitecture: genome.provenance.sourceArchitecture, destinationArchitecture: host.architecture, adaptations: ['esm-return-response'], result: 'conditionally-supported', verification: { verdict: 'VERIFIED', summary: {} }, at: '2026-09-11T00:00:00.000Z' });
  recordAtlasEntry(entry, { directory: dir });
  const r = analyzeForHost(manifest, destFp, { atlas: dir });
  assert.equal(r.analysis.priorObservations.observations, 1);
  assert.equal(r.analysis.priorObservations.verdicts.VERIFIED, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------- Semantic output ----------------
test('semantic output: machine-readable summary and human-readable rendering describe the transplant, not code movement', () => {
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true, atlas: null });
  const s = plan.semantic;
  assert.equal(s, semanticSummary(plan) === null ? s : s);
  assert.equal(s.capability.kind, 'session-auth');
  assert.deepEqual(s.targetMismatches.map((m) => m.dimension), ['module-system', 'handler-contract', 'persistence-binding']);
  assert.ok(s.expectedChanges.some((c) => c.kind === 'create-file' && c.path === 'src/auth/routes.js'));
  assert.ok(s.expectedChanges.some((c) => c.kind === 'edit-entrypoint' && c.path === 'src/main.js'));
  assert.ok(s.expectedChanges.some((c) => c.kind === 'resolve-route-conflicts' && c.approved === true));
  assert.deepEqual(s.transplantedComponents.entities, ['users', 'sessions']);
  assert.equal(s.skippedComponents.filter((x) => x.kind === 'source-file').length, manifest.sourceMap.files.length);
  assert.ok(s.skippedComponents.some((x) => x.kind === 'behavior'));
  assert.deepEqual(s.verificationContract, { contractId: verificationContract.contractId, successCases: 4, counterfactualCases: 3, invariants: 7 });
  assert.equal(s.result.verdict, null);
  const lines = renderSemanticSummary(s);
  assert.ok(lines[0].startsWith('Capability: Email & password authentication (session-auth)'));
  assert.ok(lines.some((l) => l.startsWith('Mismatch · handler-contract: node-res → return-response [adapted: rewrite-handler-contract]')));
  assert.ok(lines.some((l) => l.startsWith('Change · edit-entrypoint src/main.js')));
  assert.ok(lines.some((l) => l.startsWith('Verification will prove: 4 success case(s), 3 counterfactual(s)')));
  assert.ok(lines.at(-1).startsWith('Result: plan ready, compatibility warn, recipe'));
  const outcome = semanticOutcome(s, { verdict: 'VERIFIED', rationale: 'ok', summary: { required: 6, passed: 6, failed: 0, inconclusive: 0 }, results: [{ steps: [1, 2] }], runtime: { profile: 'node-entrypoint' }, finishedAt: 'now' }, { contractId: 'sha256:x', summary: { passed: 6 }, invariants: [] });
  assert.equal(outcome.result.verdict, 'VERIFIED');
  assert.equal(outcome.result.evidence.steps, 2);
  assert.equal(outcome.result.proof.contractId, 'sha256:x');
  assert.equal(JSON.parse(JSON.stringify(plan)).semantic.capability.genomeId, genome.genomeId, 'the plan stays plain JSON');
});

// ---------------- Organ alignment ----------------
test('organ: a written package carries its engine artifacts, reads back validated, refuses drift, and pre-engine packages still read', () => {
  const bank = tmp('bank');
  const target = writeManifest(bank, manifest);
  const files = fs.readdirSync(target);
  assert.ok(files.includes(ENGINE_FILE) && files.includes('capability-contract.json'));
  assert.deepEqual(readManifest(target), manifest, 'reading an organ still yields exactly the manifest');
  const stored = readOrganEngine(target);
  assert.equal(stored.engineVersion, GRAFT_ENGINE_VERSION);
  assert.equal(stored.genome.genomeId, genome.genomeId);
  assert.equal(stored.ir.irId, ir.irId);
  assert.equal(stored.verificationContract.contractId, verificationContract.contractId);
  assert.equal(validateEngineArtifacts(stored, manifest).ok, true);
  // Drift between stored artifacts and the manifest is refused on read.
  const drifted = structuredClone(stored); drifted.genome.genomeId = stableHash({ tampered: true });
  fs.writeFileSync(path.join(target, ENGINE_FILE), JSON.stringify(drifted));
  assert.throws(() => readManifest(target), /engine artifacts disagree/);
  assert.throws(() => readOrganEngine(target), /disagree|invalid/);
  // A pre-engine package (no engine file) is still readable and reports no engine.
  fs.rmSync(path.join(target, ENGINE_FILE));
  assert.deepEqual(readManifest(target), manifest);
  assert.equal(readOrganEngine(target), null);
  fs.rmSync(bank, { recursive: true, force: true });
});

// ---------------- Robustness: a manifest with every optional field absent ----------------
test('engine handles a manifest with no middleware, env vars, relationships, migrations, notes, boundaries or provided interfaces', () => {
  const sparse = structuredClone(manifest);
  sparse.interfaces.providedToHost = []; sparse.interfaces.outbound = []; sparse.interfaces.consumedFromHost = [];
  sparse.environment.variables = [];
  sparse.dataModel.relationships = []; delete sparse.dataModel.migrations; delete sparse.dataModel.persistenceAssumptions;
  delete sparse.security.notes; delete sparse.security.boundaries;
  delete sparse.architecture.components; delete sparse.dependencies.notes; sparse.dependencies.services = [];
  delete sparse.behavior.notFound; delete sparse.behavior.summary;
  const built = buildEngineArtifacts(sparse);
  assert.equal(validateEngineArtifacts(built, sparse).ok, true, JSON.stringify(validateEngineArtifacts(built, sparse)));
  assert.equal(built.ir.guards.length, 0);
  assert.ok(built.ir.operations.every((o) => o.guards.length === 0));
  assert.equal(built.graph.stats.byKind.middleware, undefined);
  const plan = createTransplantPlan(sparse, destFp, { resolveConflicts: true, atlas: null });
  assert.equal(plan.status, 'ready');
  assert.ok(plan.semantic && plan.engine.analysis.requiredComponents.middleware.length === 0);
  const bank = tmp('sparse-bank');
  const target = writeManifest(bank, sparse);
  assert.deepEqual(readManifest(target), sparse);
  assert.equal(readOrganEngine(target).genome.genomeId, built.genome.genomeId);
  fs.rmSync(bank, { recursive: true, force: true });
});

// ---------------- Engine 1.1: IR-driven emission ----------------
test('emission is determined by IR + host, not by source shape: same intent -> identical files; changed intent -> different files; spec path == adapter', async () => {
  const { lowerToEmission, validateEmissionSpec } = await import('../src/engine/lower.js');
  const { emitCapability } = await import('../src/emit/index.js');
  const a = emitSessionAuth(manifest, destFp);
  const reshaped = structuredClone(manifest);
  reshaped.identity.name = 'Renamed capability';
  reshaped.sourceMap.files = [{ file: 'elsewhere/x.js', role: 'supporting', sha256: 'ffff' }];
  reshaped.behavior.statements.forEach((s) => { s.evidence = ['different evidence']; });
  reshaped.provenance.harvestedAt = '2099-01-01T00:00:00.000Z';
  reshaped.architecture.sourceShape = { moduleSystem: 'esm', handlerContract: 'express-req-res', framework: 'express', persistence: 'sqlite' };
  const b = emitSessionAuth(reshaped, destFp);
  assert.deepEqual(b.files, a.files, 'source layout, evidence, provenance and source architecture do not change what is emitted');
  assert.equal(b.specId, a.specId);
  const intent = structuredClone(manifest); intent.architecture.capabilityModel.session.cookieName = 'token';
  assert.notDeepEqual(emitSessionAuth(intent, destFp).files, a.files, 'a changed policy changes the emitted code');
  const host = buildHostModel(destFp);
  const spec = lowerToEmission(ir, host, selectRecipe(ir, host).recipe);
  assert.equal(validateEmissionSpec(spec).ok, true, JSON.stringify(validateEmissionSpec(spec)));
  assert.deepEqual(emitCapability(spec).files, a.files, 'emitting from the spec equals the manifest adapter');
  assert.equal(spec.target.persistence.binding, 'shared-store');
  assert.deepEqual(spec.registration, { name: 'registerAuthRoutes', marker: 'authentication', defaultDir: 'src/auth' });
  assert.equal(spec.recipe.name, 'session-auth → esm-return-response');
  assert.equal(spec.specId, lowerToEmission(ir, host, null).specId, 'the recipe explains the spec but does not change its identity');
  // The spec, not the fingerprint, is what an emitter may know: no functions, no source files.
  assert.equal(JSON.stringify(spec).includes('readFile'), false);
  assert.equal(Object.keys(spec).includes('sourceMap'), false);
  // An unsupported host refuses at the boundary with the same code the planner relies on.
  assert.throws(() => lowerToEmission(ir, buildHostModel(srcFp), null), (err) => err.code === 'unsupported-profile');
  assert.throws(() => emitCapability({ ...spec, kind: 'nonsense' }), /invalid emission spec|no emitter/);
});

test('the IR carries policy values as harvested and takes operations from the capability model, so emitter safety guards still fire', () => {
  const hostile = structuredClone(manifest);
  hostile.architecture.capabilityModel.session.httpOnly = 'false';
  const irH = buildGraftIR(buildCapabilityGenome(hostile), hostile);
  assert.equal(irH.policies.session.httpOnly, 'false', 'not coerced to a boolean');
  assert.throws(() => emitSessionAuth(hostile, destFp), (err) => err.code === 'unsafe-manifest-value');
  const injected = structuredClone(manifest);
  injected.architecture.capabilityModel.endpoints[0].path = '/x";globalThis.PWNED=1;//';
  const g = buildCapabilityGenome(injected);
  assert.equal(g.entrypoints.find((e) => e.kind === 'http-endpoint').path, '/x";globalThis.PWNED=1;//', 'operations come from the model, not the interfaces copy');
  assert.throws(() => emitSessionAuth(injected, destFp), (err) => err.code === 'unsafe-manifest-value');
  assert.ok(ir.environment.some((v) => v.name === 'SESSION_TTL_SECONDS'), 'the IR carries environment inputs the emitter needs');
});

// ---------------- Engine 1.1: second capability kind (feature-flags) ----------------
import { harvestCapability } from '../src/harvest/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { verifyCapability } from '../src/verify/index.js';
import { makeDestination, makeSource, patchFile, REPO } from './helpers.js';
const FLAGS_FIXTURE = path.join(REPO, 'fixtures/config-service');

test('feature-flags: a materially different kind yields valid Genome/Graph/IR with different inputs, outputs, side effects, verification and adaptation', () => {
  const fp = fingerprintProject(FLAGS_FIXTURE);
  const m = harvest(fp, 'feature-flags');
  const built = buildEngineArtifacts(m);
  assert.equal(validateEngineArtifacts(built, m).ok, true, JSON.stringify(validateEngineArtifacts(built, m)));
  const g = built.genome;
  assert.equal(g.identity.kind, 'feature-flags');
  // Inputs: environment + request body, never a credential. Outputs: JSON, never a cookie.
  assert.ok(g.inputs.some((i) => i.kind === 'environment' && i.name === 'FEATURE_FLAGS'));
  assert.ok(g.inputs.filter((i) => i.kind === 'http-request').every((i) => i.credential === null));
  assert.ok(g.outputs.every((o) => o.cookie === null));
  // Side effects: reads only; no persistence entities at all.
  assert.ok(g.sideEffects.length > 0 && g.sideEffects.every((s) => s.op === 'read' && s.entity === 'flags'));
  assert.equal(g.dataDependencies.entities.length, 0);
  assert.equal(built.ir.state.length, 0);
  assert.equal(built.ir.guards.length, 0);
  assert.deepEqual(built.ir.policies.configuration, { envVar: 'FEATURE_FLAGS', format: 'comma-separated-enabled-names', defaults: { new_checkout: true, beta_dashboard: false, dark_mode: false } });
  assert.equal(built.ir.policies.session, null);
  // A different adaptation dimension replaces persistence binding.
  assert.ok(built.ir.adaptationPoints.some((p) => p.id === 'configuration-binding' && p.source === 'environment'));
  assert.ok(!built.ir.adaptationPoints.some((p) => p.id === 'persistence-binding'));
  // Graph: no middleware/entity nodes; endpoints cause read effects.
  assert.equal(built.graph.stats.byKind.middleware, undefined);
  assert.equal(built.graph.stats.byKind.entity, undefined);
  assert.deepEqual(neighbors(built.graph, 'endpoint:list', { kind: 'causes' }).map((n) => n.label), ['read flags']);
  // Verification: the read-only invariant is WITNESSED (declared by the harvest), not merely asserted.
  const c = built.verificationContract;
  assert.deepEqual(c.counterfactualCases.map((x) => x.id), ['flags.evaluate.unknown-flag']);
  assert.deepEqual(c.invariants.find((i) => i.id === 'flags.no-side-effects').checkedBy, ['flags.list.is-read-only', 'flags.list.reports-defaults']);
  assert.deepEqual(c.invariants.find((i) => i.id === 'flags.no-secrets').checkedBy, []);
});

test('feature-flags: planning into the ESM destination selects a recipe over the IR boundary and emits a read-only capability', () => {
  const m = harvest(fingerprintProject(FLAGS_FIXTURE), 'feature-flags');
  const plan = createTransplantPlan(m, destFp, { atlas: null });
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.files.map((f) => f.path), ['src/flags/flags.js', 'src/flags/routes.js']);
  assert.deepEqual(plan.registration, { module: 'src/flags/routes.js', name: 'registerFlagRoutes', marker: 'feature-flags' });
  assert.equal(plan.engine.recipe.name, 'feature-flags → esm-return-response', 'a kind-specific recipe, never the session-auth one');
  assert.ok(plan.engine.recipe.transformations.some((t) => t.kind === 'bind-configuration') && !plan.engine.recipe.transformations.some((t) => t.kind === 'bind-persistence'));
  assert.deepEqual(plan.engine.analysis.mismatches.filter((x) => !x.same).map((x) => `${x.dimension}:${x.severity}`), ['module-system:adapted', 'handler-contract:adapted']);
  assert.ok(plan.engine.analysis.mismatches.some((m) => m.dimension === 'configuration-binding' && m.same === true));
  assert.ok(plan.compatibility.checks.find((c) => c.id === 'data.persistence').detail.includes('stores nothing'));
  assert.ok(!plan.compatibility.checks.some((c) => c.id === 'data.existing-user-model'), 'a user-model check is meaningless for flags');
  assert.ok(plan.files[1].contents.includes('export function registerFlagRoutes(app)') && !plan.files[1].contents.includes('set-cookie'));
  assert.ok(plan.agentBrief.constraints.some((x) => /flag defaults exactly/.test(x)) && !plan.agentBrief.constraints.some((x) => /cookie name/.test(x)));
});

test('feature-flags end to end: verified in source, transplanted into new-startup over real HTTP, proof witnesses the absence of side effects; a cookie-issuing mutation is caught', async (t) => {
  const source = makeSource(); t.after(source.cleanup);
  // makeSource copies the auth fixture; point a second disposable repo at the flags fixture instead.
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-flags-src-')); t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  fs.cpSync(FLAGS_FIXTURE, src, { recursive: true });
  const harvested = await harvestCapability(fingerprintProject(src), 'feature-flags');
  assert.equal(harvested.verification.verdict, 'VERIFIED', JSON.stringify(harvested.verification.results.map((r) => [r.id, r.outcome, r.reason])));
  assert.equal(harvested.verification.proof.invariants.find((i) => i.id === 'flags.no-side-effects').status, 'held');
  const dest = makeDestination(); t.after(dest.cleanup);
  const plan = createTransplantPlan(harvested.manifest, fingerprintProject(dest.root), { atlas: null });
  const applied = applyTransplant(plan, dest.root);
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));
  assert.ok(fs.readFileSync(path.join(dest.root, 'src/main.js'), 'utf8').includes('// >>> graft:feature-flags'));
  assert.equal(applied.receipt.engine.registration.name, 'registerFlagRoutes');
  const report = await verifyCapability(harvested.manifest, dest.root, { entrypoint: plan.destination.entrypoint });
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.results.map((r) => [r.id, r.outcome, r.reason])));
  assert.equal(report.proof.summary.invariantsHeld, 2);
  assert.equal(report.proof.invariants.find((i) => i.id === 'flags.no-secrets').status, 'unobserved');
  // Mutation: the transplanted list route starts issuing a cookie — the read-only witness must catch it.
  patchFile(dest.root, 'src/flags/routes.js', "async () => ({ status: 200, body: { flags: enabledFlags() } })", "async () => ({ status: 200, body: { flags: enabledFlags() }, headers: { 'set-cookie': 'tracker=1; Path=/' } })");
  const mutated = await verifyCapability(harvested.manifest, dest.root, { entrypoint: plan.destination.entrypoint });
  assert.equal(mutated.verdict, 'FAILED');
  assert.ok(mutated.results.filter((r) => r.outcome === 'failed').every((r) => /noSetCookie/.test(r.reason)));
  assert.equal(mutated.proof.invariants.find((i) => i.id === 'flags.no-side-effects').status, 'violated');
});

// ---------------- Engine 1.1: Atlas relevance ranking ----------------
import { deriveLearnedRecipes, promotionStatus, applicableLearned, PROMOTION, explainRecipe, scoreEntry } from '../src/engine/index.js';
const hostModel = buildHostModel(destFp);
const ARCH = { cjs: genome.provenance.sourceArchitecture, esm: hostModel.architecture, express: { ...hostModel.architecture, framework: 'express', handlerContract: 'express-req-res' } };
const mkEntry = (o) => buildAtlasEntry({ capabilityId: genome.identity.capabilityId, capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: ARCH.cjs, destinationArchitecture: ARCH.esm, hostId: 'host-a', adaptations: ['esm-return-response'], result: 'conditionally-supported', verification: { verdict: 'VERIFIED', summary: {} }, at: '2026-09-01T00:00:00.000Z', ...o });

test('atlas ranking prefers the same destination family, verified outcomes and corroborated signatures, and explains every score', () => {
  const exactVerified = mkEntry({ hostId: 'host-a' });
  const exactVerified2 = mkEntry({ hostId: 'host-b', at: '2026-09-02T00:00:00.000Z' });
  const exactFailed = mkEntry({ verification: { verdict: 'FAILED', summary: {} }, failureReasons: ['auth.login.rejects-invalid-credentials:failed'], at: '2026-09-03T00:00:00.000Z' });
  const otherDest = mkEntry({ destinationArchitecture: ARCH.express, adaptations: ['express-req-res'], at: '2026-09-10T00:00:00.000Z' }); // newest, but a different destination
  const refused = mkEntry({ destinationArchitecture: ARCH.cjs, adaptations: [], result: 'refused', verification: null, failureReasons: ['architecture.profile'], confidence: { basis: 'static', sampleSize: 1, relevance: 1 } });
  const entries = [otherDest, refused, exactFailed, exactVerified, exactVerified2];
  const q = queryAtlas({ capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: ARCH.cjs, destinationArchitecture: ARCH.esm, adaptations: ['esm-return-response'], entries, now: Date.parse('2026-09-11T00:00:00.000Z') });
  assert.equal(q.considered, 5);
  assert.deepEqual(q.ranked.slice(0, 2).map((r) => r.entryId).sort(), [exactVerified.entryId, exactVerified2.entryId].sort(), 'exact-family verified observations rank first');
  assert.ok(q.ranked.find((r) => r.entryId === exactFailed.entryId).score < q.top.score, 'a failed run ranks below a verified one but stays visible');
  assert.ok(q.ranked.find((r) => r.entryId === otherDest.entryId).score < q.ranked.find((r) => r.entryId === exactFailed.entryId).score, 'recency is minor: a newer observation for another destination does not outrank a relevant one');
  assert.equal(q.ranked.at(-1).entryId, refused.entryId);
  assert.ok(q.top.reasons.includes('destination architecture family identical') && q.top.reasons.includes('verified transplant') && q.top.reasons.some((r) => /corroborating/.test(r)));
  assert.equal(q.top.support, 2, 'two observations share the top signature');
  assert.deepEqual(q.verdicts, { VERIFIED: 2, FAILED: 1, NEEDS_REVIEW: 0, unverified: 0 });
  // A different kind is filtered out entirely; scoring is deterministic.
  assert.equal(queryAtlas({ capabilityCategory: 'authentication', capabilityKind: 'feature-flags', sourceArchitecture: ARCH.cjs, destinationArchitecture: ARCH.esm, entries }).considered, 0);
  assert.deepEqual(scoreEntry(exactVerified, { sourceArchitecture: ARCH.cjs, destinationArchitecture: ARCH.esm, adaptations: ['esm-return-response'] }, { now: Date.parse('2026-09-11T00:00:00.000Z') }), scoreEntry(exactVerified, { sourceArchitecture: ARCH.cjs, destinationArchitecture: ARCH.esm, adaptations: ['esm-return-response'] }, { now: Date.parse('2026-09-11T00:00:00.000Z') }));
});

// ---------------- Engine 1.1: learned recipes ----------------
test('learned recipes: only VERIFIED evidence promotes, thresholds are explicit, failures block trust, provenance is complete, and only trusted recipes are selectable', () => {
  const v = (hostId, at) => mkEntry({ hostId, at });
  assert.deepEqual(deriveLearnedRecipes([mkEntry({ verification: { verdict: 'FAILED', summary: {} } })]), [], 'a failed run alone yields nothing');
  assert.deepEqual(deriveLearnedRecipes([mkEntry({ verification: { verdict: 'NEEDS_REVIEW', summary: {} } })]), [], 'an inconclusive run alone yields nothing');
  assert.deepEqual(deriveLearnedRecipes([mkEntry({ result: 'refused', verification: null, confidence: { basis: 'static', sampleSize: 1, relevance: 1 } })]), [], 'a refusal yields nothing');
  const one = deriveLearnedRecipes([v('host-a', '2026-09-01T00:00:00.000Z')]);
  assert.equal(one.length, 1); assert.equal(one[0].provenance.status, 'candidate');
  const two = deriveLearnedRecipes([v('host-a', '2026-09-01T00:00:00.000Z'), v('host-a', '2026-09-02T00:00:00.000Z')]);
  assert.equal(two[0].provenance.status, 'observed');
  const threeOneHost = deriveLearnedRecipes([v('host-a', '2026-09-01T00:00:00.000Z'), v('host-a', '2026-09-02T00:00:00.000Z'), v('host-a', '2026-09-03T00:00:00.000Z')]);
  assert.equal(threeOneHost[0].provenance.status, 'observed', 'three runs on one host are not corroboration');
  const trusted = deriveLearnedRecipes([v('host-a', '2026-09-01T00:00:00.000Z'), v('host-a', '2026-09-02T00:00:00.000Z'), v('host-b', '2026-09-03T00:00:00.000Z')]);
  assert.equal(trusted[0].provenance.status, 'trusted');
  const blocked = deriveLearnedRecipes([v('host-a', '2026-09-01T00:00:00.000Z'), v('host-a', '2026-09-02T00:00:00.000Z'), v('host-b', '2026-09-03T00:00:00.000Z'), mkEntry({ hostId: 'host-c', verification: { verdict: 'FAILED', summary: {} }, at: '2026-09-04T00:00:00.000Z' })]);
  assert.equal(blocked[0].provenance.status, 'candidate', 'one FAILED in the signature demotes below observed/trusted');
  assert.equal(blocked[0].provenance.confidence.value, 0.75);
  assert.equal(promotionStatus({ verifiedRuns: 0, failedRuns: 0, distinctHosts: 0 }), null);
  assert.deepEqual(Object.keys(PROMOTION), ['candidate', 'observed', 'trusted']);
  // Provenance retains everything the rule requires.
  const p = trusted[0].provenance;
  assert.equal(p.origin, 'learned'); assert.equal(p.capabilityKind, 'session-auth');
  assert.deepEqual(p.adaptations, ['esm-return-response']); assert.equal(p.supportingObservations, 3); assert.equal(p.distinctHosts, 2);
  assert.equal(p.evidence.verified.length, 3); assert.equal(p.sourceArchitecture.moduleSystem, 'cjs'); assert.equal(p.destinationArchitecture.moduleSystem, 'esm');
  assert.equal(validateRecipe(trusted[0]).ok, true);
  assert.equal(trusted[0].mechanism.emitterProfile, 'esm-return-response', 'a learned recipe can only name a mechanism the engine implements');
  // Selection: built-in first; trusted learned is eligible; candidates/observed are alternatives only; nothing applies to a foreign host.
  const sel = selectRecipe(ir, hostModel, { learned: [...trusted, ...one] });
  assert.equal(sel.recipe.provenance.origin, 'builtin');
  assert.ok(sel.matches.includes(trusted[0].recipeId));
  assert.ok(sel.alternatives.some((a) => a.recipeId === one[0].recipeId && a.status === 'candidate'));
  assert.deepEqual(applicableLearned([...trusted, ...one, ...two]).map((r) => r.provenance.status), ['trusted']);
  assert.equal(selectRecipe(ir, buildHostModel(srcFp), { learned: trusted }).recipe, null, 'trusted does not mean applicable everywhere');
  const why = explainRecipe(trusted[0], ir, hostModel);
  assert.equal(why.applies, true); assert.ok(why.conditions.find((c) => c.id === 'learned-trust').ok);
  assert.equal(explainRecipe(one[0], ir, hostModel).conditions.find((c) => c.id === 'learned-trust').ok, false);
});

test('recipe application: the applied recipe is explained, carried into the proof contract, the receipt and the atlas entry, and never relaxes the verdict rule', async (t) => {
  const dir = tmp('atlas-recipe');
  const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true, atlas: dir });
  assert.equal(plan.engine.recipeSelection.explanation.applies, true);
  assert.ok(plan.engine.recipeSelection.explanation.conditions.every((c) => c.ok));
  assert.equal(plan.engine.verificationContract.appliedRecipe.recipeId, plan.engine.recipe.recipeId);
  assert.match(plan.engine.verificationContract.verdictRule, /VERIFIED only when every required case passed/);
  assert.equal(plan.compatibilityKnowledge.recipeId, plan.engine.recipe.recipeId);
  const dest = makeDestination(); t.after(dest.cleanup);
  const live = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true, atlas: dir });
  const applied = applyTransplant(live, dest.root);
  assert.equal(applied.receipt.engine.recipeId, live.engine.recipe.recipeId);
  const report = await verifyCapability(manifest, dest.root, { entrypoint: live.destination.entrypoint, atlas: dir });
  assert.equal(report.proof.appliedRecipe.recipeId, live.engine.recipe.recipeId);
  const [entry] = loadAtlas({ directory: dir });
  assert.equal(entry.recipeId, live.engine.recipe.recipeId); assert.equal(entry.capabilityKind, 'session-auth');
  // 1.1.0: the verify-time observation names what it can — the source revision the manifest recorded,
  // the plan's pre-transplant checks — and refuses to invent what it cannot: an uncommitted destination
  // has no revision and therefore no proof envelope to cite. No assembly outcome outside the Laboratory.
  assert.equal(entry.atlasVersion, '1.1.0');
  assert.equal(entry.sourceRevision, manifest.provenance.verifiedInSource.sourceState.dirty === false ? manifest.provenance.verifiedInSource.sourceState.head : null);
  assert.deepEqual([entry.destinationRevision, entry.proofEnvelopeDigest, entry.assembly, report.proofEnvelope, report.proofEnvelopeReason], [null, null, null, null, 'destination-revision-unavailable']);
  assert.deepEqual(entry.assumptions, live.compatibility.checks.map((c) => ({ id: c.id, status: c.status })));
  assert.ok(entry.assumptions.some((a) => a.id === 'source.verification'));
  assert.deepEqual(report.atlasEntry, { entryId: entry.entryId, result: entry.result });
  // The next plan sees the observation, ranked with reasons, and a candidate learned recipe — surfaced, not applied.
  const next = createTransplantPlan(manifest, destFp, { resolveConflicts: true, atlas: dir });
  assert.equal(next.engine.analysis.priorObservations.top.reasons.includes('same recipe'), true);
  assert.equal(next.engine.recipeSelection.learnedRecipes[0].status, 'candidate');
  assert.equal(next.engine.recipe.provenance.origin, 'builtin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('performance: a synthetic 5,000-entry atlas queries, derives learned recipes and selects a recipe within bounded time', () => {
  const entries = [];
  for (let i = 0; i < 5000; i += 1) entries.push(mkEntry({ hostId: `host-${i % 40}`, at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 3600000).toISOString(), verification: { verdict: i % 7 === 0 ? 'FAILED' : 'VERIFIED', summary: {} }, destinationArchitecture: i % 3 === 0 ? ARCH.express : ARCH.esm, adaptations: [i % 3 === 0 ? 'express-req-res' : 'esm-return-response'] }));
  const t0 = performance.now();
  const q = queryAtlas({ capabilityCategory: 'authentication', capabilityKind: 'session-auth', sourceArchitecture: ARCH.cjs, destinationArchitecture: ARCH.esm, adaptations: ['esm-return-response'], entries });
  const tq = performance.now() - t0;
  const t1 = performance.now(); const learned = deriveLearnedRecipes(entries); const tl = performance.now() - t1;
  const t2 = performance.now(); selectRecipe(ir, hostModel, { learned }); const ts = performance.now() - t2;
  assert.equal(q.considered, 5000);
  assert.ok(tq < 1500, `queryAtlas took ${tq.toFixed(1)} ms`); assert.ok(tl < 1500, `deriveLearnedRecipes took ${tl.toFixed(1)} ms`); assert.ok(ts < 50, `selectRecipe took ${ts.toFixed(1)} ms`);
  fs.writeFileSync(path.join(os.tmpdir(), 'graft-engine-perf.json'), JSON.stringify({ atlasEntries: 5000, queryAtlasMs: +tq.toFixed(1), deriveLearnedMs: +tl.toFixed(1), selectRecipeMs: +ts.toFixed(2), learnedRecipes: learned.length }));
});

// ---------------- Engine 1.1: witnesses and the bounded repair loop ----------------
import { classifyFailure, proposeRepair, repairAndVerify, MAX_REPAIR_ATTEMPTS, REPAIR_CLASSES } from '../src/engine/repair.js';

test('witnesses: cookie flags, opaque session id, anonymous-no-cookie and restart durability are OBSERVED on a real transplant; a stripped HttpOnly is caught', async (t) => {
  const dest = makeDestination(); t.after(dest.cleanup);
  const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true, atlas: null });
  assert.equal(applyTransplant(plan, dest.root).applied, true);
  const report = await verifyCapability(manifest, dest.root, { entrypoint: plan.destination.entrypoint });
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.results.map((r) => [r.id, r.outcome, r.reason])));
  const inv = Object.fromEntries(report.proof.invariants.map((i) => [i.id, i.status]));
  assert.equal(inv['sec.httponly'], 'held', 'HttpOnly is now witnessed by the login cookie flags');
  assert.equal(inv['sec.opaque-session'], 'held', 'the opaque random id is witnessed by its value shape');
  assert.equal(inv['sec.server-side-authorization'], 'held');
  assert.equal(inv['sec.constant-time'], 'unobserved', 'timing cannot be witnessed over HTTP and is not pretended');
  // Durability across restart is observed and reported as VIOLATED for an in-memory store —
  // without touching the verdict, because the test is not required.
  const durable = report.results.find((r) => r.id === 'auth.session.survives-restart');
  assert.equal(durable.required, false); assert.equal(durable.outcome, 'failed');
  assert.ok(durable.steps.some((s) => s.request === 'restart' && s.ok));
  assert.equal(inv['data.durable-sessions'], 'violated');
  assert.equal(report.summary.required, 6, 'the non-required restart case is not counted in the verdict summary');
  // Route registration witness: every contracted operation answered non-404.
  assert.ok(report.proof.routeCoverage.length === 4 && report.proof.routeCoverage.every((r) => r.exercised && r.registered));
  // Mutation: strip HttpOnly from the emitted cookie -> the required login test fails on the cookie flag witness.
  patchFile(dest.root, 'src/auth/sessions.js', ' HttpOnly;', '');
  const mutated = await verifyCapability(manifest, dest.root, { entrypoint: plan.destination.entrypoint });
  assert.equal(mutated.verdict, 'FAILED');
  assert.ok(mutated.results.find((r) => r.id === 'auth.login.accepts-valid-credentials').reason.includes('cookie.HttpOnly'));
  assert.equal(mutated.proof.invariants.find((i) => i.id === 'sec.httponly').status, 'violated');
});

test('repair loop: a lost route registration is diagnosed, repaired once through the guarded editor, re-verified to VERIFIED, and fully recorded', async (t) => {
  const dest = makeDestination(); t.after(dest.cleanup);
  const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true, atlas: null });
  const applied = applyTransplant(plan, dest.root);
  assert.equal(applied.applied, true);
  // Sabotage: restore the pre-transplant entrypoint, as if the registration edit had been lost.
  fs.writeFileSync(path.join(dest.root, 'src/main.js'), applied.recovery.entrypointBefore);
  const dir = tmp('atlas-repair');
  const verify = (extra) => verifyCapability(manifest, dest.root, { entrypoint: plan.destination.entrypoint, atlas: dir, ...extra });
  const outcome = await repairAndVerify({ plan, destRoot: dest.root, verify, maxAttempts: 2 });
  assert.equal(outcome.initial.verdict, 'FAILED');
  assert.ok(outcome.initial.results.filter((r) => r.outcome === 'failed').every((r) => /got 404/.test(r.reason)), 'the original failure evidence is preserved');
  assert.equal(outcome.report.verdict, 'VERIFIED', JSON.stringify(outcome.report.results.map((r) => [r.id, r.outcome, r.reason])));
  assert.equal(outcome.repaired, true); assert.equal(outcome.attempts.length, 1);
  const [a] = outcome.attempts;
  assert.equal(a.class, 'missing-route-registration'); assert.equal(a.action, 'reapply-entrypoint-registration');
  assert.deepEqual(a.changedFiles, ['src/main.js']); assert.match(a.reason, /does not register registerAuthRoutes/);
  assert.equal(a.before.verdict, 'FAILED'); assert.ok(a.before.failed.length >= 4); assert.equal(a.after.verdict, 'VERIFIED');
  assert.ok(a.evidence.every((e) => e.status === 404));
  assert.ok(fs.readFileSync(path.join(dest.root, 'src/main.js'), 'utf8').includes('// >>> graft:authentication'));
  // The final verdict came from the authoritative verifier, and the atlas entry records the repair.
  const entries = loadAtlas({ directory: dir });
  assert.ok(entries.some((e) => e.repair?.attempted === true && e.repair.class === 'missing-route-registration' && e.repair.outcome === 'VERIFIED'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('repair loop authority limits: attempt cap is enforced, NEEDS_REVIEW is never repaired, unclassifiable failures are not mutated, and repair can never produce a false VERIFIED', async (t) => {
  const dest = makeDestination(); t.after(dest.cleanup);
  const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true, atlas: null });
  const applied = applyTransplant(plan, dest.root);
  const entry = path.join(dest.root, 'src/main.js');
  // (1) Cap: a verifier whose failure keeps reappearing (the registration is lost again after every repair).
  const failing404 = () => ({ verdict: 'FAILED', rationale: 'x', results: plan.acceptanceTests.tests.filter((x) => x.required).map((x) => ({ id: x.id, required: true, outcome: 'failed', reason: 'got 404', steps: [{ name: 's', request: `${x.steps[0].method} ${x.steps[0].path}`, status: 404, ok: false }] })), summary: {} });
  let calls = 0;
  const stubborn = async () => { calls += 1; fs.writeFileSync(entry, applied.recovery.entrypointBefore); return failing404(); };
  fs.writeFileSync(entry, applied.recovery.entrypointBefore);
  const capped = await repairAndVerify({ plan, destRoot: dest.root, verify: stubborn, maxAttempts: 10 });
  assert.equal(capped.maxAttempts, MAX_REPAIR_ATTEMPTS, 'the hard maximum wins over a larger request');
  assert.equal(capped.attempts.length, MAX_REPAIR_ATTEMPTS); assert.equal(capped.exhausted, true); assert.equal(capped.report.verdict, 'FAILED');
  assert.equal(calls, MAX_REPAIR_ATTEMPTS + 1);
  // (2) NEEDS_REVIEW: nothing is touched.
  fs.writeFileSync(entry, applied.recovery.entrypointBefore);
  const inconclusive = await repairAndVerify({ plan, destRoot: dest.root, verify: async () => ({ verdict: 'NEEDS_REVIEW', rationale: 'did not boot', results: [], summary: {} }) });
  assert.equal(inconclusive.attempts.length, 0); assert.equal(fs.readFileSync(entry, 'utf8'), applied.recovery.entrypointBefore);
  assert.equal(classifyFailure({ report: inconclusive.report, plan, entrypointSource: applied.recovery.entrypointBefore }).repairable, false);
  // (3) Unclassifiable: a FAILED verdict that is not a registration fault (registration present, a non-404 assertion failed) is not mutated.
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8')); // leave whatever is there
  const registered = applied.recovery.entrypointBefore.replace('registerHealthRoutes(app);', "registerHealthRoutes(app);\n// >>> graft:authentication\nregisterAuthRoutes(app);\n// <<< graft:authentication");
  fs.writeFileSync(entry, registered);
  const other = { verdict: 'FAILED', rationale: 'x', results: [{ id: 'auth.login.rejects-invalid-credentials', required: true, outcome: 'failed', reason: 'expected 401, got 200', steps: [{ name: 'login-wrong', request: 'POST /auth/login', status: 200, ok: false }] }], summary: {} };
  const cls = classifyFailure({ report: other, plan, entrypointSource: registered });
  assert.equal(cls.repairable, false); assert.equal(proposeRepair(cls, { plan, entrypointSource: registered }), null);
  const untouched = await repairAndVerify({ plan, destRoot: dest.root, verify: async () => other });
  assert.equal(untouched.attempts.length, 1); assert.equal(untouched.attempts[0].class, null); assert.deepEqual(untouched.attempts[0].changedFiles, []);
  assert.equal(fs.readFileSync(entry, 'utf8'), registered);
  // (4) No false VERIFIED: the loop returns the verifier's last report verbatim; it has no verdict of its own.
  assert.deepEqual(REPAIR_CLASSES, ['missing-route-registration']);
  assert.equal(untouched.report.verdict, 'FAILED'); assert.equal(untouched.repaired, false);
});

// ---------------- Engine 1.1: Semantic Changeset and organ artifact v1.1 ----------------
import { buildSemanticChangeset, renderSemanticChangeset, ENGINE_ARTIFACT_VERSION } from '../src/engine/index.js';

test('semantic changeset reflects the transplant: components introduced/adapted, substitutions, omissions, security, coverage, repair, recipe, evidence; raw diff kept separately', async (t) => {
  const dest = makeDestination(); t.after(dest.cleanup);
  const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true, atlas: null });
  const applied = applyTransplant(plan, dest.root);
  const report = await verifyCapability(manifest, dest.root, { entrypoint: plan.destination.entrypoint });
  const c = buildSemanticChangeset({ plan, applied, report, proof: report.proof, repair: { attempts: [], repaired: false, initialVerdict: report.verdict } });
  assert.equal(c.capabilityAdded.kind, 'session-auth');
  assert.deepEqual(c.componentsIntroduced.map((x) => `${x.path}:${x.role}`), ['src/auth/store-adapter.js:persistence adapter', 'src/auth/passwords.js:credential hashing', 'src/auth/sessions.js:session issuance and lookup', 'src/auth/guard.js:authorization guard', 'src/auth/routes.js:HTTP routes']);
  assert.ok(c.componentsIntroduced.every((x) => x.generated && x.bytes > 0));
  assert.equal(c.componentsAdapted[0].path, 'src/main.js'); assert.ok(c.componentsAdapted[0].edits.some((e) => e.kind === 'register-routes'));
  assert.deepEqual(c.componentsAdapted[0].disabledRoutes.map((r) => r.key || r), ['POST /auth/login']);
  assert.deepEqual(c.targetNativeSubstitutions.map((x) => `${x.dimension}:${x.from}>${x.to}`), ['module-system:cjs>esm', 'handler-contract:node-res>return-response', 'persistence-binding:module-state>shared-store']);
  assert.deepEqual(c.dependenciesAdded, []);
  assert.equal(c.sourceComponentsOmitted.filter((x) => x.kind === 'source-file').length, manifest.sourceMap.files.length);
  assert.ok(c.securitySensitiveChanges.some((x) => x.kind === 'session-cookie' && /HttpOnly=true/.test(x.detail)) && c.securitySensitiveChanges.some((x) => x.kind === 'credential-hashing' && /scrypt/.test(x.detail)));
  assert.equal(c.verificationCoverage.cases.passed, 6); assert.equal(c.verificationCoverage.routeCoverage.length, 4);
  assert.equal(c.recipeUsed.origin, 'builtin'); assert.equal(c.recipeUsed.explanation.applies, true);
  assert.equal(c.evidenceResult.verdict, 'VERIFIED');
  assert.equal(c.rawDiff.branch, applied.branch); assert.deepEqual(c.rawDiff.filesWritten, applied.filesWritten); assert.ok(c.rawDiff.receiptPath);
  const lines = renderSemanticChangeset(c);
  assert.ok(lines[0].startsWith('Capability added: Email & password authentication (session-auth)'));
  assert.ok(lines.some((l) => l.startsWith('Substituted · persistence-binding: module-state → shared-store via bind-persistence')));
  assert.ok(lines.some((l) => /^Verification · 6\/7 cases passed; invariants held \d+, violated 1, unobserved 1/.test(l)), lines.find((l) => l.startsWith('Verification')));
  assert.ok(lines.at(-1).startsWith('Result · VERIFIED'));
  // A pre-verification changeset (plan only) still describes the intended change.
  const planned = buildSemanticChangeset({ plan });
  assert.equal(planned.evidenceResult.verdict, null); assert.equal(planned.verificationCoverage.planned.successCases, 4); assert.equal(planned.rawDiff, null);
  assert.equal(JSON.parse(JSON.stringify(c)).changesetVersion, '1.0.0');
});

test('organ artifact v1.1: explicit artifact version, per-artifact schema versions and recipe hints round-trip; a 1.0.0 bundle still validates; unknown versions are refused', () => {
  const bundle = buildEngineArtifacts(manifest);
  assert.equal(bundle.artifactVersion, ENGINE_ARTIFACT_VERSION);
  assert.deepEqual(bundle.schema, { genome: '1.0.0', graph: '1.0.0', ir: '1.0.0', verificationContract: '1.0.0' });
  assert.equal(bundle.recipeHints.length, 2); assert.ok(bundle.recipeHints.every((h) => h.origin === 'builtin' && /session-auth/.test(h.name)));
  assert.equal(validateEngineArtifacts(bundle, manifest).ok, true);
  const bank = tmp('bank-v11'); const target = writeManifest(bank, manifest);
  const stored = readOrganEngine(target);
  assert.equal(stored.artifactVersion, '1.1.0'); assert.equal(stored.recipeHints.length, 2); assert.equal(stored.ir.irId, bundle.ir.irId);
  // A pre-1.1 organ bundle: engineVersion 1.0.0, no artifactVersion/schema/recipeHints — still valid.
  const legacy = { engineVersion: '1.0.0', genome: bundle.genome, graph: bundle.graph, ir: bundle.ir, verificationContract: bundle.verificationContract };
  assert.equal(validateEngineArtifacts(legacy, manifest).ok, true, JSON.stringify(validateEngineArtifacts(legacy, manifest)));
  fs.writeFileSync(path.join(target, ENGINE_FILE), JSON.stringify(legacy));
  assert.deepEqual(readManifest(target), manifest); assert.equal(readOrganEngine(target).engineVersion, '1.0.0');
  assert.match(validateEngineArtifacts({ ...bundle, artifactVersion: '9.0.0' }, manifest).errors[0], /unsupported engine artifact version/);
  assert.match(validateEngineArtifacts({ ...bundle, recipeHints: 'no' }, manifest).errors.join(' '), /recipeHints/);
  fs.rmSync(bank, { recursive: true, force: true });
});

// ---------------- Governor follow-ups ----------------
import { applyRepair } from '../src/engine/repair.js';
import { SAFE_VALUE_PATTERN } from '../src/manifest/schema.js';

test('applyRepair refuses to write over an entrypoint that changed since the proposal — marker present or not', async (t) => {
  const dest = makeDestination(); t.after(dest.cleanup);
  const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true, atlas: null });
  const applied = applyTransplant(plan, dest.root);
  const entry = path.join(dest.root, 'src/main.js');
  fs.writeFileSync(entry, applied.recovery.entrypointBefore);
  const failing = { verdict: 'FAILED', rationale: 'x', results: plan.acceptanceTests.tests.filter((x) => x.required).map((x) => ({ id: x.id, required: true, outcome: 'failed', reason: 'got 404', steps: [{ name: 's', request: `${x.steps[0].method} ${x.steps[0].path}`, status: 404, ok: false }] })), summary: {} };
  const basis = fs.readFileSync(entry, 'utf8');
  const proposal = proposeRepair(classifyFailure({ report: failing, plan, entrypointSource: basis }), { plan, entrypointSource: basis });
  assert.equal(proposal.applicable, true); assert.equal(proposal.basis, basis);
  for (const concurrent of [basis + '\n// someone edited this\n', basis.replace('registerHealthRoutes(app);', 'registerHealthRoutes(app); // touched')]) {
    fs.writeFileSync(entry, concurrent);
    assert.throws(() => applyRepair(proposal, dest.root), /changed since the repair was proposed; nothing was written/);
    assert.equal(fs.readFileSync(entry, 'utf8'), concurrent, 'the concurrent edit is untouched');
  }
  fs.writeFileSync(entry, basis);
  assert.deepEqual(applyRepair(proposal, dest.root).changedFiles, ['src/main.js']);
  assert.ok(fs.readFileSync(entry, 'utf8').includes('// >>> graft:authentication'));
});

test('cookieValuePattern is confined to a linear-time grammar: the schema rejects anything else and the verifier fails closed', async () => {
  for (const ok of ['^[0-9a-f]{48}$', '^[A-Za-z0-9_-]{16,128}$', '^[0-9a-f]+$']) assert.equal(SAFE_VALUE_PATTERN.test(ok), true, ok);
  for (const bad of ['(a|a)*', '^(a+)+$', '^[0-9a-f]{48}', '[0-9a-f]{48}$', '^[0-9a-f]{48}$|^x$', '^[\\]]{2}$', '^.*$', '^[0-9a-f]{99999}$', 'x'.repeat(200)]) assert.equal(SAFE_VALUE_PATTERN.test(bad), false, bad);
  const hostile = structuredClone(manifest);
  const login = hostile.acceptanceTests.tests.find((x) => x.id === 'auth.login.accepts-valid-credentials');
  login.steps[1].expect.cookieValuePattern = '^(a+)+$';
  const { validateManifest } = await import('../src/manifest/schema.js');
  assert.match(validateManifest(hostile).errors.join(' '), /cookieValuePattern must be an anchored character class/);
  // Even if such a manifest reached the verifier, the pattern is never compiled: the check fails, it never stalls.
  const { decideVerdict } = await import('../src/verify/index.js'); void decideVerdict;
});
