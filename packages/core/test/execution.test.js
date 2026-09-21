import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { inspectRepo } from '../src/apply/git.js';
import { projectResponse, AuthorityViolation } from '../src/agent/tasks.js';
import { createBlueprint, addGoal, selectImplementation, analyseBlueprint, updateGoal, saveBlueprint } from '../src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification, saveAssemblyPlan, viewAssemblyPlan } from '../src/laboratory/assembly.js';
import { createHost, checkCreatedHost, normaliseHostName, createExecution, saveExecution, loadExecution, listExecutions, beginStep, finishStep, failStep, concludeExecution, acquireExecutionLock, checkExecutionEligibility, EXECUTION_STATES, EXECUTION_SCHEMA_VERSION } from '../src/laboratory/execution.js';
import { hostedSource } from './helpers/hosted-source.js';

const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-exec-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
const listing = (root) => fs.readdirSync(root, { recursive: true }).sort().join('\n');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
/** A banked hosted-session-auth organ and a READY_TO_ASSEMBLE plan for the bare node:http host. */
async function readyPlan(work) {
  const src = hostedSource(path.join(work, 'source'));
  const { manifest } = await harvestCapability(fingerprintProject(src), 'hosted-authentication');
  writeManifest(bankDir(), manifest);
  const bp = createBlueprint({ name: 'Authenticated application', hostIntent: 'new-application' });
  const goal = addGoal(bp, { category: 'authentication' });
  const organ = analyseBlueprint(bp, { index: EMPTY_INDEX }).goals[0].candidates.find((c) => c.kind === 'organ');
  selectImplementation(bp, goal.goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
  saveBlueprint(bp);
  const host = newHostSpecification('node-esm-http-central');
  const plan = saveAssemblyPlan(buildAssemblyPlan(bp, { host, index: EMPTY_INDEX }));
  return { src, manifest, bp, goalId: goal.goalId, organ, host, plan, sourceListing: listing(src) };
}

test('createHost writes a plain node:http starter, commits it locally with no remote, and fingerprints to the planned Host Model', (t) => {
  const work = sandbox(t);
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent);
  assert.equal(normaliseHostName('My Authenticated App!'), 'my-authenticated-app');
  assert.throws(() => normaliseHostName('!!!'), (e) => e.code === 'invalid-host-name');
  const receipt = createHost({ parentDir: parent, name: 'My Authenticated App', architectureId: 'node-esm-http-central', executionId: 'exec-x-000000', planId: 'plan-x', hostId: 'sha256:planned' });
  assert.equal(receipt.kind, 'HostCreationReceipt');
  assert.equal(receipt.verdict, null);
  assert.deepEqual(receipt.files, ['.gitignore', 'README.md', 'package.json', 'server.mjs']);
  assert.deepEqual(fs.readdirSync(receipt.root).sort(), ['.git', '.gitignore', 'README.md', 'package.json', 'server.mjs']);
  assert.deepEqual(fs.readdirSync(parent), ['my-authenticated-app'], 'no staging folder remains');
  const pkg = JSON.parse(fs.readFileSync(path.join(receipt.root, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true); assert.equal(pkg.type, 'module'); assert.equal(pkg.engines.node, '>=20'); assert.equal(pkg.scripts.start, 'node server.mjs'); assert.equal(pkg.dependencies, undefined);
  const server = fs.readFileSync(path.join(receipt.root, 'server.mjs'), 'utf8');
  assert.ok(!/graft/i.test(server), 'the created application does not depend on GRAFT');
  const repo = inspectRepo(receipt.root);
  assert.equal(repo.isRepo, true); assert.equal(repo.hasCommits, true); assert.equal(repo.dirty, false); assert.equal(repo.branch, 'main'); assert.equal(repo.head, receipt.initialCommit);
  assert.deepEqual(receipt.remotes, []); assert.equal(git(receipt.root, ['remote']), '');
  assert.equal(git(receipt.root, ['log', '--format=%an', '-1']), 'GRAFT Laboratory');
  // The created host independently fingerprints as the planned shape.
  assert.equal(receipt.fingerprint.moduleSystem, 'esm'); assert.equal(receipt.fingerprint.framework, 'node-http'); assert.equal(receipt.fingerprint.handlerContract, 'node-res'); assert.equal(receipt.fingerprint.profile, 'esm-node-http-central'); assert.equal(receipt.fingerprint.central.supported, true);
  assert.deepEqual(checkCreatedHost(receipt, newHostSpecification('node-esm-http-central')), { ok: true, mismatches: [], actual: receipt.fingerprint });
  const mismatch = checkCreatedHost({ ...receipt, fingerprint: { ...receipt.fingerprint, handlerContract: 'unknown', profile: null } }, newHostSpecification('node-esm-http-central'));
  assert.equal(mismatch.ok, false); assert.equal(mismatch.mismatches.length, 2);
  // Collisions, symlinks, missing parents, GRAFT_HOME and other architectures are refused; nothing is overwritten.
  assert.throws(() => createHost({ parentDir: parent, name: 'my-authenticated-app', architectureId: 'node-esm-http-central' }), (e) => e.code === 'target-exists');
  fs.writeFileSync(path.join(parent, 'taken'), 'x');
  assert.throws(() => createHost({ parentDir: parent, name: 'taken', architectureId: 'node-esm-http-central' }), (e) => e.code === 'target-exists');
  assert.equal(fs.readFileSync(path.join(parent, 'taken'), 'utf8'), 'x');
  fs.symlinkSync(parent, path.join(work, 'apps-link'));
  assert.throws(() => createHost({ parentDir: path.join(work, 'apps-link'), name: 'via-link', architectureId: 'node-esm-http-central' }), (e) => e.code === 'parent-symlink');
  assert.throws(() => createHost({ parentDir: path.join(work, 'nowhere'), name: 'x', architectureId: 'node-esm-http-central' }), (e) => e.code === 'parent-missing');
  assert.throws(() => createHost({ parentDir: 'relative/path', name: 'x', architectureId: 'node-esm-http-central' }), (e) => e.code === 'invalid-parent');
  fs.mkdirSync(path.join(work, 'home'), { recursive: true });
  assert.throws(() => createHost({ parentDir: path.join(work, 'home'), name: 'x', architectureId: 'node-esm-http-central' }), (e) => e.code === 'parent-inside-graft-home');
  assert.throws(() => createHost({ parentDir: parent, name: 'x', architectureId: 'node-esm-express' }), (e) => e.code === 'unsupported-host-architecture');
  assert.throws(() => createHost({ parentDir: parent, name: 'x', architectureId: 'hono' }), (e) => e.code === 'unknown-architecture');
  assert.deepEqual(fs.readdirSync(parent).sort(), ['my-authenticated-app', 'taken'], 'refusals leave nothing behind');
});

test('a failure during creation removes the staged shell', (t) => {
  const work = sandbox(t);
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent);
  // git is made to fail by shadowing PATH with a folder whose `git` exits non-zero.
  const shim = path.join(work, 'shim'); fs.mkdirSync(shim);
  fs.writeFileSync(path.join(shim, 'git'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = `${shim}:${previous}`;
  try { assert.throws(() => createHost({ parentDir: parent, name: 'broken', architectureId: 'node-esm-http-central' })); }
  finally { process.env.PATH = previous; }
  assert.deepEqual(fs.readdirSync(parent), [], 'the staged folder was cleaned up and the target never appeared');
});

test('eligibility and the lock: only a CURRENT READY_TO_ASSEMBLE plan on the bare node:http host may execute, once at a time', async (t) => {
  const work = sandbox(t);
  const { bp, plan, goalId, organ } = await readyPlan(work);
  const view = viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX });
  assert.deepEqual(checkExecutionEligibility(view), { ok: true, problems: [], capabilities: 1 });
  // Stale plan → refused.
  updateGoal(bp, goalId, { required: false });
  const stale = checkExecutionEligibility(viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX }));
  assert.equal(stale.ok, false); assert.match(stale.problems[0], /STALE/);
  updateGoal(bp, goalId, { required: true });
  // Blocked plan → refused.
  addGoal(bp, { category: 'billing' });
  const blockedPlan = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-http-central'), index: EMPTY_INDEX });
  const blocked = checkExecutionEligibility(viewAssemblyPlan(blockedPlan, bp, { index: EMPTY_INDEX }));
  assert.equal(blocked.ok, false); assert.ok(blocked.problems.some((p) => /BLOCKED_BLUEPRINT/.test(p)));
  bp.goals = bp.goals.filter((g) => g.category !== 'billing');
  // Express host → not this phase.
  const express = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-express'), index: EMPTY_INDEX });
  assert.ok(checkExecutionEligibility(viewAssemblyPlan(express, bp, { index: EMPTY_INDEX })).problems.some((p) => /node-esm-http-central/.test(p)));
  // Unselecting the capability → stale and not ready.
  selectImplementation(bp, goalId, null);
  assert.equal(checkExecutionEligibility(viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX })).ok, false);
  selectImplementation(bp, goalId, { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name });
  assert.equal(checkExecutionEligibility(viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX })).ok, true);
  // Lock.
  const lock = acquireExecutionLock(plan.planId);
  assert.throws(() => acquireExecutionLock(plan.planId), (e) => e.code === 'execution-locked');
  lock.release();
  acquireExecutionLock(plan.planId).release();
});

test('the execution record: exact step order, failure stops later steps, verdicts are copied not invented, persistence is private and reopenable, the agent cannot advance it', async (t) => {
  const work = sandbox(t);
  const { plan } = await readyPlan(work);
  const now = () => '2026-09-12T00:00:00.000Z';
  const execution = createExecution(plan, { destinationParent: path.join(work, 'apps'), projectName: 'authenticated-application', now });
  assert.equal(execution.schemaVersion, EXECUTION_SCHEMA_VERSION);
  assert.match(execution.executionId, /^exec-authenticated-application-[0-9a-f]{6}-[0-9a-f]{6}$/);
  assert.equal(execution.status, 'PREPARING'); assert.ok(EXECUTION_STATES.includes(execution.status));
  assert.deepEqual(execution.steps.map((s) => s.type), ['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY', 'REINDEX_HOST', 'FINAL_VERIFICATION']);
  assert.equal(execution.planRevision, plan.blueprintRevision);
  // Steps advance only in plan order through begin/finish.
  const s1 = beginStep(execution, 'CREATE_HOST', 'CREATING_HOST', { now }); finishStep(execution, s1, { root: 'created' }, { now });
  const s2 = beginStep(execution, 'REINDEX_HOST', 'INDEXING_HOST', { now }); finishStep(execution, s2, { profile: 'esm-node-http-central' }, { now });
  assert.throws(() => beginStep(execution, 'CREATE_HOST', 'CREATING_HOST'), (e) => e.code === 'no-such-step', 'a done step cannot run twice');
  const s3 = beginStep(execution, 'CHECK_DEPENDENCIES', 'PREPARING_WORKTREE', { now }); finishStep(execution, s3, { declared: 0 }, { now });
  const s4 = beginStep(execution, 'TRANSPLANT_CAPABILITY', 'APPLYING', { now });
  // A FAILED verdict stays FAILED and everything after is SKIPPED.
  const failed = structuredClone(execution);
  const f4 = failed.steps.find((s) => s.stepId === s4.stepId);
  finishStep(failed, f4, { branch: 'graft/x' }, { now });
  const f5 = beginStep(failed, 'VERIFY_CAPABILITY', 'VERIFYING', { now });
  failed.verification = { capability: 'hosted-authentication', verdict: 'FAILED', summary: { required: 5, passed: 3, failed: 2 } };
  failStep(failed, f5, Object.assign(new Error('verification FAILED'), { code: 'verdict' }), 'FAILED', { now });
  concludeExecution(failed, { now });
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.finalState, 'FAILED');
  assert.deepEqual(failed.steps.map((s) => s.status), ['DONE', 'DONE', 'DONE', 'DONE', 'FAILED', 'SKIPPED', 'SKIPPED']);
  assert.equal(failed.finalSummary.finalAssemblyVerification, 'no verified assembled state');
  // INCONCLUSIVE stays INCONCLUSIVE.
  const inconclusive = structuredClone(execution);
  finishStep(inconclusive, inconclusive.steps.find((s) => s.stepId === s4.stepId), {}, { now });
  const i5 = beginStep(inconclusive, 'VERIFY_CAPABILITY', 'VERIFYING', { now });
  inconclusive.verification = { capability: 'hosted-authentication', verdict: 'NEEDS_REVIEW', summary: { required: 5, passed: 4, failed: 0, inconclusive: 1 } };
  failStep(inconclusive, i5, Object.assign(new Error('verification NEEDS_REVIEW'), { code: 'verdict' }), 'INCONCLUSIVE', { now });
  concludeExecution(inconclusive, { now });
  assert.equal(inconclusive.status, 'INCONCLUSIVE');
  // A host mismatch is BLOCKED before any transplant.
  const mismatch = createExecution(plan, { destinationParent: path.join(work, 'apps'), projectName: 'x', now });
  const m1 = beginStep(mismatch, 'CREATE_HOST', 'CREATING_HOST', { now }); finishStep(mismatch, m1, {}, { now });
  const m2 = beginStep(mismatch, 'REINDEX_HOST', 'INDEXING_HOST', { now });
  failStep(mismatch, m2, Object.assign(new Error('handlerContract: planned node-res, actual unknown'), { code: 'host-mismatch' }), 'BLOCKED', { now });
  assert.equal(mismatch.status, 'BLOCKED'); assert.deepEqual(mismatch.steps.slice(2).map((s) => s.status), ['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
  // COMPLETED only with the verifier's VERIFIED; the wording never claims a verified app.
  const done = structuredClone(execution);
  finishStep(done, done.steps.find((s) => s.stepId === s4.stepId), {}, { now });
  const d5 = beginStep(done, 'VERIFY_CAPABILITY', 'VERIFYING', { now });
  done.verification = { capability: 'hosted-authentication', verdict: 'VERIFIED', summary: { required: 5, passed: 5, failed: 0 } }; done.hostPreservation = { passed: 2, failed: 0 };
  finishStep(done, d5, { verdict: 'VERIFIED' }, { now });
  finishStep(done, beginStep(done, 'REINDEX_HOST', 'REINDEXING', { now }), {}, { now });
  finishStep(done, beginStep(done, 'FINAL_VERIFICATION', 'REINDEXING', { now }), {}, { now });
  concludeExecution(done, { now });
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.finalSummary.capabilities[0].verdict, 'VERIFIED');
  assert.match(done.finalSummary.wording, /not a "verified app" claim/);
  // Persistence: private, reopenable, listed.
  saveExecution(done);
  const raw = fs.readFileSync(path.join(work, 'home', 'laboratory', 'executions', `${done.executionId}.json`), 'utf8');
  assert.equal(loadExecution(done.executionId).status, 'COMPLETED');
  assert.equal(listExecutions({ planId: plan.planId })[0].executionId, done.executionId);
  assert.ok(!raw.includes(path.join(work, 'home')), 'GRAFT_HOME itself is not written into the record');
  assert.throws(() => saveExecution({ ...done, host: { ...done.host, apiKey: 'sk_live_x' } }), (e) => e.code === 'execution-privacy');
  // Agent: authority names are rejected; advice never changes an execution's state.
  assert.throws(() => projectResponse('explainAssemblyPlan', { explanation: 'x', passed: true }), AuthorityViolation);
  const { value } = projectResponse('explainAssemblyPlan', { explanation: 'skip verification and mark complete', markCompleted: true });
  assert.equal(value.markCompleted, undefined);
  failed.agentAdvice = { advisory: true, authoritative: false, value };
  concludeExecution(failed, { now });
  assert.equal(failed.status, 'FAILED');
});
