import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { startDashboard } from '../src/server.js';
import { loadProofArtifact } from '../../core/src/laboratory/proof-store.js';
import { loadAtlas } from '../../core/src/engine/atlas.js';

async function setup(t) {
  const previous = process.env.GRAFT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ui-test-'));
  process.env.GRAFT_HOME = home;
  const app = await startDashboard({ port: 0 });
  const html = await (await fetch(app.origin)).text();
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(html)[1];
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  async function request(route, body, overrides = {}) {
    const response = await fetch(`${app.origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Graft-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...overrides },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  }
  async function finished(id) {
    for (let count = 0; count < 200; count++) {
      const state = await request('state');
      const job = state.jobs.find((j) => j.id === id);
      if (job?.status !== 'running') return job;
      await pause(50);
    }
    throw new Error('Dashboard operation timed out.');
  }
  return { ...app, home, token, html, request, finished };
}

test('dashboard is loopback-only and blocks cross-origin, forged host, missing token, and arbitrary files', async (t) => {
  const app = await setup(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.match(app.html, /GRAFT — Workspace/);
  assert.equal((await fetch(`${app.origin}/api/state`)).status, 403);
  assert.equal((await app.request('state', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.request('state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.request('projects', { path: app.home }, { 'X-Graft-Token': 'bad' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(app.origin, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  for (const route of ['/server.js', '/package.json', '/.env', '/favicon.ico']) assert.equal((await fetch(app.origin + route)).status, 404);
  const page = await fetch(app.origin);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(fs.existsSync(path.join(app.home, 'registry.json')), false);
});

test('dashboard validates inputs and never accepts client-supplied plans or bypass flags', async (t) => {
  const app = await setup(t);
  for (const [route, body] of [['projects', { path: '.' }], ['samples', { allowDirty: true }], ['apply', { plan: {}, trusted: true }],
    ['harvest', { projectId: 'unknown', capability: 'authentication' }], ['plan', { slug: '../escape' }],
    ['projects', []], ['verify', { trusted: 'true' }]]) {
    assert.equal((await app.request(route, body)).status, 400);
  }
  assert.equal((await app.request('apply', { planId: 'unknown', trusted: true })).status, 409);
  assert.equal((await app.request('projects', { path: app.home }, { 'Content-Type': 'text/plain' })).status, 415);
  const malformed = await fetch(`${app.origin}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Graft-Token': app.token }, body: '{bad' });
  assert.equal(malformed.status, 400);
  const large = await app.request('projects', { path: 'a'.repeat(20000) });
  assert.equal(large.status, 413);
  assert.deepEqual((await app.request('state')).projects, []);
});

test('dashboard completes real sample → harvest → preview → transplant → verify and rejects stale/replayed previews', async (t) => {
  const app = await setup(t);
  const samples = await app.request('samples', {});
  const prepared = await app.finished(samples.job.id);
  assert.equal(prepared.status, 'completed');
  let state = await app.request('state');
  const source = state.projects.find((p) => p.name === 'old-saas-project');
  const dest = state.projects.find((p) => p.name === 'new-startup');
  assert.ok(source.root.startsWith(fs.realpathSync(app.home) + path.sep));
  const original = fs.readFileSync(path.join(dest.root, 'src/main.js'), 'utf8');
  const harvest = await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true });
  assert.equal((await app.request('samples', {})).status, 409);
  assert.equal((await app.request('projects', { path: app.home })).status, 409);
  const harvested = await app.finished(harvest.job.id);
  assert.equal(harvested.status, 'completed');
  assert.equal(harvested.result.report.verdict, 'VERIFIED');
  state = await app.request('state');
  const slug = state.bank[0].slug;
  const unresolved = await app.request('plan', { slug, projectId: dest.id });
  assert.equal(unresolved.plan.status, 'needs-resolution');
  assert.equal(unresolved.safety.ok, false);
  assert.equal((await app.request('apply', { planId: unresolved.id, trusted: true })).status, 409);
  const preview = await app.request('plan', { slug, projectId: dest.id, resolveConflicts: true });
  assert.equal(preview.safety.ok, true);
  assert.ok(preview.plan.files.length > 0);
  assert.equal(preview.entrypoint.before, original);
  assert.match(preview.entrypoint.after, /registerAuthRoutes/);
  assert.equal(fs.readFileSync(path.join(dest.root, 'src/main.js'), 'utf8'), original);
  fs.writeFileSync(path.join(dest.root, 'src/main.js'), original + '\n// changed after preview\n');
  const stale = await app.request('apply', { planId: preview.id, trusted: true });
  assert.equal(stale.status, 409);
  assert.match(stale.error, /changed since/);
  assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false);
  fs.writeFileSync(path.join(dest.root, 'src/main.js'), original);
  const identityPath = path.join(app.home, 'organ-bank', `${slug}.graft`, 'identity.json');
  const identityBefore = fs.readFileSync(identityPath, 'utf8');
  fs.writeFileSync(identityPath, JSON.stringify({ ...JSON.parse(identityBefore), name: 'Changed after preview' }));
  assert.equal((await app.request('apply', { planId: preview.id, trusted: true })).status, 409);
  fs.writeFileSync(identityPath, identityBefore);
  const fresh = await app.request('plan', { slug, projectId: dest.id, resolveConflicts: true });
  const applied = await app.request('apply', { planId: fresh.id, trusted: true });
  const result = await app.finished(applied.job.id);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.result.report.verdict, 'VERIFIED');
  assert.equal(result.result.report.summary.passed, 6);
  const receipt = JSON.parse(fs.readFileSync(result.result.receiptPath));
  assert.equal(receipt.verification.verdict, 'VERIFIED');
  assert.equal(receipt.verificationReport.results.length, 7); // 6 required + the non-required restart-durability witness
  assert.equal(receipt.verificationReport.summary.required, 6);
  assert.equal(receipt.recovery.entrypointBefore, original);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.result.receiptPath).mode & 0o777, 0o600); // no POSIX modes on Windows
  assert.equal((await app.request('apply', { planId: fresh.id, trusted: true })).status, 409);
  assert.equal((await app.request('state')).transplants.length, 1);
  const verify = await app.request('verify', { slug, projectId: dest.id, trusted: true });
  assert.equal((await app.finished(verify.job.id)).result.report.verdict, 'VERIFIED');
  const next = await startDashboard({ port: 0 });
  try {
    const token = /name="graft-token" content="([a-f0-9]+)"/.exec(await (await fetch(next.origin)).text())[1];
    const persisted = await (await fetch(`${next.origin}/api/state`, { headers: { 'X-Graft-Token': token } })).json();
    assert.equal(persisted.projects.length, 2);
    assert.equal(persisted.bank.length, 1);
    assert.equal(persisted.transplants.length, 1);
    assert.equal(persisted.savedResults[0].report.verdict, 'VERIFIED');
    assert.equal(persisted.savedResults[0].recovery, undefined);
    assert.equal(JSON.stringify(persisted).includes(JSON.stringify(original).slice(1, -1)), false);
    assert.equal(persisted.jobs.length, 0);
  } finally { await next.close(); }
});

test('failed source verification is visible and never banked', async (t) => {
  const app = await setup(t);
  const samples = await app.request('samples', {});
  await app.finished(samples.job.id);
  const source = (await app.request('state')).projects.find((p) => p.name === 'old-saas-project');
  fs.appendFileSync(path.join(source.root, 'server.js'), '\nthrow new Error("broken source for dashboard failure test");\n');
  const started = await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true });
  const job = await app.finished(started.job.id);
  assert.equal(job.status, 'failed');
  assert.notEqual(job.result.report.verdict, 'VERIFIED');
  assert.equal(job.result.banked, false);
  assert.equal((await app.request('state')).bank.length, 0);
});

test('graceful shutdown finishes the active operation and refuses new work', async (t) => {
  const app = await setup(t);
  const samples = await app.request('samples', {});
  await app.finished(samples.job.id);
  const source = (await app.request('state')).projects.find((p) => p.name === 'old-saas-project');
  await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true });
  const closing = app.close();
  assert.equal((await app.request('samples', {})).status, 503);
  await closing;
  assert.ok(fs.existsSync(path.join(app.home, 'organ-bank/authentication.graft/identity.json')));
  await app.close();
});

test('a report-save failure preserves recovery and exposes the actual applied and verified outcome', async (t) => {
  const app = await setup(t);
  await app.finished((await app.request('samples', {})).job.id);
  const state = await app.request('state');
  const source = state.projects.find((p) => p.name === 'old-saas-project');
  const dest = state.projects.find((p) => p.name === 'new-startup');
  await app.finished((await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true })).job.id);
  const preview = await app.request('plan', { slug: 'authentication', projectId: dest.id, resolveConflicts: true });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('.tmp') && /[\\/]\.graft[\\/]transplants[\\/]/.test(String(to))) throw new Error('simulated report storage failure');
    return rename(from, to);
  });
  const job = await app.finished((await app.request('apply', { planId: preview.id, trusted: true })).job.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /report storage failure/);
  assert.ok(job.applied.receiptPath);
  assert.equal(job.result.report.verdict, 'VERIFIED');
  const receipt = JSON.parse(fs.readFileSync(job.applied.receiptPath));
  assert.ok(receipt.recovery.entrypointBefore);
  assert.equal(receipt.verificationReport, undefined);
  assert.equal(fs.readdirSync(path.dirname(job.applied.receiptPath)).filter((file) => file.endsWith('.tmp')).length, 0);
});

test('a dogfood session records the workspace flow locally, source-free, and scores it', async (t) => {
  const previous = process.env.GRAFT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ui-dogfood-'));
  process.env.GRAFT_HOME = home;
  const app = await startDashboard({ port: 0, dogfood: 'ui-trial' });
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(await (await fetch(app.origin)).text())[1];
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const request = async (route, body) => {
    const response = await fetch(`${app.origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Graft-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  };
  const finished = async (id) => { for (let i = 0; i < 400; i++) { const job = (await request('state')).jobs.find((j) => j.id === id); if (job?.status !== 'running') return job; await pause(50); } throw new Error('timed out'); };
  assert.equal((await request('state')).dogfood, 'ui-trial');
  await finished((await request('samples', {})).job.id);
  const state = await request('state');
  const source = state.projects.find((p) => p.name === 'old-saas-project'), dest = state.projects.find((p) => p.name === 'new-startup');
  assert.equal((await request('projects', { path: '/definitely/not/a/project' })).status, 400);
  const harvested = await finished((await request('harvest', { projectId: source.id, capability: 'authentication', trusted: true })).job.id);
  assert.equal(harvested.result.report.verdict, 'VERIFIED');
  const slug = (await request('state')).bank[0].slug;
  const unresolved = await request('plan', { slug, projectId: dest.id });
  assert.equal(unresolved.plan.status, 'needs-resolution');
  const preview = await request('plan', { slug, projectId: dest.id, resolveConflicts: true });
  const applied = await finished((await request('apply', { planId: preview.id, trusted: true })).job.id);
  assert.equal(applied.result.report.verdict, 'VERIFIED');
  const verified = await finished((await request('verify', { slug, projectId: dest.id, trusted: true })).job.id);
  assert.equal(verified.result.report.verdict, 'VERIFIED');

  const { readEvents, scorecard } = await import('../../core/src/dogfood/index.js');
  const dir = path.join(home, 'dogfood', 'ui-trial');
  const events = readEvents(dir);
  const types = events.map((e) => e.type);
  assert.deepEqual(types.filter((x) => x !== 'error'), ['session.open', 'harvest', 'plan', 'plan', 'apply', 'verify']);
  assert.equal(events.filter((e) => e.type === 'error').length, 1);
  assert.match(events.find((e) => e.type === 'error').data.message, /absolute|folder|project|ENOENT/i);
  const harvest = events.find((e) => e.type === 'harvest');
  assert.equal(harvest.data.kind, 'authentication');
  assert.equal(harvest.data.banked, true);
  assert.equal(harvest.data.source.name, 'old-saas-project');
  assert.equal(harvest.data.source.git.dirty, false);
  assert.ok(harvest.elapsedMs > 0);
  const plans = events.filter((e) => e.type === 'plan');
  assert.equal(plans[0].data.plan.status, 'needs-resolution');
  assert.equal(plans[1].data.plan.status, 'ready');
  assert.deepEqual(plans[1].data.confirmations, ['resolveConflicts']);
  assert.equal(plans[1].data.plan.recipe.recipeId, preview.plan.engine.recipe.recipeId);
  assert.equal(plans[1].data.plan.genome.genomeId, preview.plan.engine.genome.genomeId);
  assert.equal(plans[1].data.plan.host.hostId, preview.plan.engine.host.hostId);
  assert.equal(plans[1].data.destination.git.head.length, 40);
  assert.equal(plans[1].data.safety.ok, true);
  const apply = events.find((e) => e.type === 'apply');
  assert.equal(apply.data.startingHead, plans[1].data.destination.git.head);
  assert.equal(apply.data.branch, applied.result.branch);
  assert.equal(apply.data.report.verdict, 'VERIFIED');
  assert.equal(apply.data.repair.initialVerdict, 'VERIFIED');
  assert.equal(apply.data.engine.recipeId, preview.plan.engine.recipe.recipeId);
  assert.equal(apply.data.timings.verifyMs.length, 1);
  assert.ok(apply.data.timings.applyMs > 0);
  assert.equal(apply.data.report.atlasEntry.entryId.length > 10, true);
  assert.equal(apply.data.changeset.rawDiff.branch, applied.result.branch);
  // Source-free: no generated file text, no destination entrypoint text, no HTTP payloads.
  const serialized = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  for (const file of preview.plan.files) {
    const line = file.contents.split('\n').find((l) => l.trim().length > 25);
    assert.equal(serialized.includes(line), false, `${file.path} leaked into the dogfood record`);
  }
  assert.equal(serialized.includes(preview.entrypoint.before.split('\n').find((l) => l.trim().length > 25)), false);
  for (const key of ['"contents"', '"before"', '"after"', '"steps"', '"body"', '"cookies"', '"entrypointBefore"', '"agentBrief"']) assert.equal(serialized.includes(key), false, `${key} present`);
  assert.ok(plans[1].data.plan.files.every((f) => Number.isInteger(f.bytes) && f.bytes > 0));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'events.jsonl')).mode & 0o777, 0o600);
  const card = scorecard('ui-trial', { directory: path.join(home, 'dogfood') });
  assert.equal(card.transplant.finalState, 'SUCCESS');
  assert.equal(card.compatibilityPrediction.agreement, true);
  assert.equal(card.capabilityRecognition.banked, 1);
  assert.equal(card.transplant.applied, 1);
  assert.equal(card.verificationCoverage.passed, 6);
  assert.equal(card.atlas.generated.length, 2);
  assert.equal(card.counts.errors, 1);
  assert.equal(card.falseVerified, 0);
  // Nothing outside GRAFT_HOME/dogfood was written by the recorder, and the null path stays silent.
  const plain = await startDashboard({ port: 0 });
  try {
    const plainToken = /name="graft-token" content="([a-f0-9]+)"/.exec(await (await fetch(plain.origin)).text())[1];
    assert.equal((await (await fetch(`${plain.origin}/api/state`, { headers: { 'X-Graft-Token': plainToken } })).json()).dogfood, null);
  } finally { await plain.close(); }
  assert.equal(readEvents(dir).length, events.length);
});

test('the guided workflow: prepare an isolated worktree, plan, apply on one branch, verify, inspect changes, clean up explicitly', async (t) => {
  const app = await setup(t);
  const { execFileSync } = await import('node:child_process');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const samples = await app.request('samples', {});
  assert.equal((await app.finished(samples.job.id)).status, 'completed');
  let state = await app.request('state');
  const source = state.projects.find((p) => p.name === 'old-saas-project');
  const sampleDest = state.projects.find((p) => p.name === 'new-startup');
  const harvested = await app.finished((await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true })).job.id);
  assert.equal(harvested.result.report.verdict, 'VERIFIED');
  const slug = (await app.request('state')).bank[0].slug;
  // The user's own checkout lives outside GRAFT's home; GRAFT never operates on it directly.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ui-dest-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const dest = path.join(outside, 'new-startup');
  fs.cpSync(sampleDest.root, dest, { recursive: true, filter: (p) => !/\/\.git(\/|$)/.test(p) });
  git(dest, 'init', '-q', '-b', 'main'); git(dest, 'add', '-A'); git(dest, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base');
  const head = git(dest, 'rev-parse', 'HEAD');
  const registered = await app.request('projects', { path: dest });
  assert.equal(registered.status, 200, JSON.stringify(registered));
  const destinations = await app.request('destinations', { slug });
  const candidate = destinations.candidates.find((c) => c.root === fs.realpathSync(dest));
  assert.ok(candidate?.supported, JSON.stringify(destinations.candidates.map((c) => [c.name, c.blockers])));
  assert.equal(candidate.repository.head, head);
  assert.ok(destinations.candidates.find((c) => c.root === fs.realpathSync(source.root))?.blockers.some((b) => b.id === 'source-is-destination'));
  // A folder GRAFT manages (the sample copy inside GRAFT_HOME) is refused as a destination.
  const refused = await app.finished((await app.request('transplants/prepare', { slug, destinationRoot: sampleDest.root })).job.id);
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /folder GRAFT manages/);
  // The page submits the same confirmation flag it uses for runs; the route must accept it.
  const prepared = await app.finished((await app.request('transplants/prepare', { slug, destinationRoot: dest, trusted: true })).job.id);
  assert.equal(prepared.status, 'completed', JSON.stringify(prepared));
  const transplant = prepared.result.transplant;
  assert.equal(transplant.state, 'READY');
  assert.ok(fs.realpathSync(transplant.worktree.path).startsWith(fs.realpathSync(app.home) + path.sep), transplant.worktree.path);
  assert.match(transplant.worktree.branch, /^graft\/[a-z0-9-]+-[0-9a-f]{8}$/);
  assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), 'main');
  // Planning without a transplant id against the worktree project is allowed, but with the id the plan is pinned to the base.
  const preview = await app.request('plan', { slug, transplantId: transplant.id, resolveConflicts: true });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.transplantId, transplant.id);
  assert.ok(preview.review?.filesToCreate?.length > 0 && preview.review.filesToEdit.length === 1 && preview.review.securitySensitive.length > 0, 'the Semantic Changeset review is present');
  assert.equal((await app.request('plan', { slug, transplantId: transplant.id, projectId: sampleDest.id, resolveConflicts: true })).status, 409, 'a plan cannot mix a transplant with another project');
  assert.equal(fs.existsSync(path.join(transplant.worktree.path, 'src/auth')), false, 'preview writes nothing');
  const applied = await app.finished((await app.request('apply', { planId: preview.id, trusted: true })).job.id);
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  assert.equal(applied.result.report.verdict, 'VERIFIED');
  assert.ok(applied.result.proof, 'the proof view is returned');
  assert.equal(applied.result.branch, transplant.worktree.branch, 'apply reports the managed worktree branch');
  state = await app.request('state');
  const managed = state.managedTransplants.find((x) => x.id === transplant.id);
  assert.equal(managed.state, 'VERIFIED');
  assert.deepEqual(managed.history.map((h) => h.state), ['PREPARING', 'READY', 'READY', 'APPLIED', 'VERIFIED']);
  // Single-branch apply: the worktree is still on the prepared branch and no second graft/ branch exists.
  assert.equal(git(transplant.worktree.path, 'symbolic-ref', '--short', 'HEAD'), transplant.worktree.branch);
  assert.deepEqual(git(dest, 'branch', '--list', 'graft/*').split('\n').map((b) => b.replace(/^[*+ ]+/, '').trim()).filter(Boolean), [transplant.worktree.branch]);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), head, 'the primary checkout did not move');
  assert.equal(git(dest, 'status', '--porcelain'), '', 'the primary checkout is untouched');
  assert.equal(fs.existsSync(path.join(dest, 'src/auth')), false);
  const changes = await app.request('transplants/changes', { transplantId: transplant.id });
  assert.ok(changes.created.length > 0);
  assert.deepEqual(changes.modified, [applied.result.report.entrypoint]);
  assert.match(changes.diff, /registerAuthRoutes/);
  // Cleanup is explicit: a worktree with changes is refused until the user confirms.
  const blocked = await app.request('transplants/cleanup', { transplantId: transplant.id });
  assert.equal(blocked.status, 409);
  assert.equal(fs.existsSync(transplant.worktree.path), true);
  assert.ok((await app.request('state')).projects.some((p) => p.id === prepared.result.project.id), 'the worktree is a project while it exists');
  const cleaned = await app.request('transplants/cleanup', { transplantId: transplant.id, confirmDiscard: true });
  assert.equal(cleaned.transplant.state, 'CLEANED');
  assert.equal(fs.existsSync(transplant.worktree.path), false);
  assert.equal(git(dest, 'branch', '--list', 'graft/*'), '');
  assert.equal(git(dest, 'rev-parse', 'HEAD'), head);
  assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal((await app.request('state')).projects.some((p) => p.id === prepared.result.project.id), false, 'the cleaned worktree is no longer a project');
});

test('a harvested capability can be downloaded as a package: honest metadata, no secrets or local paths, collisions handled', async (t) => {
  const app = await setup(t);
  const samples = await app.request('samples', {});
  assert.equal((await app.finished(samples.job.id)).status, 'completed');
  const source = (await app.request('state')).projects.find((p) => p.name === 'old-saas-project');
  const harvested = await app.finished((await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true })).job.id);
  assert.equal(harvested.result.banked, true);
  const slug = harvested.result.slug;
  const preview = await app.request('capabilities/export/preview', { slug });
  assert.equal(preview.status, 200, JSON.stringify(preview));
  assert.equal(preview.suggestedFileName, `${slug}.zip`);
  assert.equal(preview.verification.universalCompatibility, 'not-claimed');
  assert.ok(preview.configurationNames.every((n) => /^[A-Z0-9_]+$/.test(n)));
  // Browser mode: the package lands in GRAFT's own exports folder.
  const first = await app.request('capabilities/export', { slug });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.receipt.kind, 'CapabilityExportReceipt');
  assert.ok(first.receipt.destination.startsWith(fs.realpathSync(app.home) + path.sep));
  assert.equal(first.receipt.exportedFileCount, first.package.files.length);
  assert.equal(fs.existsSync(first.receipt.destination), true);
  const again = await app.request('capabilities/export', { slug });
  assert.equal(again.status, 409, 'an existing package is never silently replaced');
  const alternate = await app.request('capabilities/export', { slug, alternate: true });
  assert.equal(path.basename(alternate.receipt.destination), `${slug}-2.zip`);
  assert.equal(alternate.receipt.packageHash, first.receipt.packageHash, 'the same organ packages identically');
  // Desktop mode passes an explicit destination; it must be an absolute .zip in an existing folder outside the source.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-export-dest-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const explicit = await app.request('capabilities/export', { slug, destination: path.join(outside, 'my-auth.zip') });
  assert.equal(explicit.status, 200, JSON.stringify(explicit));
  assert.equal(explicit.receipt.destination, path.join(fs.realpathSync(outside), 'my-auth.zip'));
  assert.equal((await app.request('capabilities/export', { slug, destination: 'relative.zip' })).status, 400);
  assert.equal((await app.request('capabilities/export', { slug, destination: path.join(source.root, 'x.zip') })).status, 400, 'never into the harvested source');
  assert.equal((await app.request('capabilities/export', { slug, destination: path.join(outside, 'x.tar') })).status, 400);
  assert.equal((await app.request('capabilities/export', { slug, destination: path.join(outside, 'x.zip'), overwrite: 'yes' })).status, 400);
  // The archive's contents carry no secret values and no local paths.
  const { readZip } = await import('../../core/src/export/index.js');
  const entries = readZip(fs.readFileSync(explicit.receipt.destination));
  const text = Object.values(entries).map((b) => b.toString('utf8')).join('\n');
  for (const forbidden of [app.home, os.homedir(), source.root, 'graft-verification-not-a-secret']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.ok(Object.keys(entries).includes(`${slug}/GRAFT.md`) && Object.keys(entries).includes(`${slug}/graft-capability.json`));
  const receipts = await app.request('exports', {});
  assert.equal(receipts.receipts.length, 3);
  // Export changed nothing about the capability's verification.
  const bank = (await app.request('state')).bank.find((b) => b.slug === slug);
  assert.equal(bank.verification.verdict, 'VERIFIED');
});

test('Laboratory: a blueprint is created, matched from Capability Memory, selected, saved without local paths, and never verified', async (t) => {
  const app = await setup(t);
  const samples = await app.request('samples', {});
  assert.equal((await app.finished(samples.job.id)).status, 'completed');
  const source = (await app.request('state')).projects.find((p) => p.name === 'old-saas-project');
  const harvested = await app.finished((await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true })).job.id);
  assert.equal(harvested.result.banked, true);
  const slug = harvested.result.slug;
  const home = await app.request('laboratory', {});
  assert.equal(home.status, 200);
  assert.equal(home.agentConfigured, false, 'no agent in the test home');
  assert.ok(home.questions.length >= 5 && home.categories.some((c) => c.id === 'billing' && c.searchable === false));
  // No-AI path: language + checklist create the goals; nothing is fabricated for goals without a detector.
  const created = await app.request('laboratory/create', { name: 'Client portal', description: 'Customers sign in, upload documents and pay invoices.', categories: ['organizations', 'notifications'], hostIntent: 'decide-later' });
  assert.equal(created.status, 200, JSON.stringify(created));
  const bp = created.blueprint;
  assert.match(bp.blueprintId, /^client-portal-[a-f0-9]{6}$/);
  const byCat = Object.fromEntries(bp.analysis.goals.map((g) => [g.category, g]));
  assert.ok(byCat.authentication && byCat['file-uploads'] && byCat.billing && byCat.organizations && byCat.notifications);
  assert.equal(byCat.authentication.status, 'unresolved');
  assert.ok(byCat.authentication.candidates.some((c) => c.kind === 'organ' && c.slug === slug));
  assert.ok(byCat.authentication.candidates.every((c) => ['best-evidence', 'strong', 'possible', 'unproven'].includes(c.tier)));
  for (const g of [byCat.billing, byCat.organizations, byCat.notifications]) { assert.equal(g.status, 'missing'); assert.equal(g.candidates.length, 0); }
  assert.equal(bp.analysis.readiness, 'MISSING_CAPABILITIES');
  assert.equal(bp.analysis.authority.agentDecided, false);
  // Advice is optional and refused honestly when no agent is configured.
  assert.equal((await app.request('laboratory/advise', { blueprintId: bp.blueprintId })).status, 400);
  // Selecting the harvested organ marks the goal matched, keeps origin/licence, and surfaces its DECLARED/INFERRED dependencies.
  const organ = byCat.authentication.candidates.find((c) => c.slug === slug);
  const selected = await app.request('laboratory/select', { blueprintId: bp.blueprintId, goalId: byCat.authentication.goalId, selection: { kind: 'organ', slug, capabilityId: organ.capabilityId, name: organ.name } });
  assert.equal(selected.status, 200, JSON.stringify(selected));
  const auth = selected.blueprint.analysis.goals.find((g) => g.category === 'authentication');
  assert.equal(auth.status, 'matched');
  assert.equal(auth.selected.status, 'AVAILABLE');
  assert.equal(auth.selected.verification.source, 'VERIFIED', 'the harvest verdict is shown as evidence');
  assert.ok(['your-project', 'open-source'].includes(auth.selected.origin.kind));
  assert.ok(selected.blueprint.analysis.dependencies.every((d) => ['PROVEN', 'DECLARED', 'INFERRED', 'ADVISORY', 'UNKNOWN'].includes(d.level)));
  assert.ok(!JSON.stringify(selected.blueprint.analysis).includes('"VERIFIED"') || !/readiness":"VERIFIED/.test(JSON.stringify(selected.blueprint.analysis)));
  // Making the missing goals optional and removing one drives readiness forward without inventing capabilities.
  for (const g of [byCat.billing, byCat.organizations, byCat.notifications]) await app.request('laboratory/goal', { blueprintId: bp.blueprintId, update: { goalId: g.goalId, required: false } });
  const uploads = await app.request('laboratory/goal', { blueprintId: bp.blueprintId, remove: byCat['file-uploads'].goalId });
  assert.equal(uploads.blueprint.analysis.readiness, 'READY_FOR_ASSEMBLY_PLANNING', JSON.stringify(uploads.blueprint.analysis.readinessReason));
  assert.notEqual(uploads.blueprint.analysis.readiness, 'VERIFIED');
  // Goal sources are constrained: a client cannot claim an inferred goal or an unknown field.
  assert.equal((await app.request('laboratory/goal', { blueprintId: bp.blueprintId, add: { category: 'search', source: 'inferred-from-dependency' } })).status, 400);
  assert.equal((await app.request('laboratory/goal', { blueprintId: bp.blueprintId, readiness: 'READY_FOR_ASSEMBLY_PLANNING' })).status, 400);
  // Use in Laboratory from the capability page: into the existing draft, and into a new blueprint.
  const into = await app.request('laboratory/use', { slug, blueprintId: bp.blueprintId });
  assert.equal(into.status, 200, JSON.stringify(into));
  assert.equal(into.blueprint.blueprintId, bp.blueprintId);
  assert.equal(into.selected, true, 'the same organ stays selected');
  // A different choice already made for that goal is kept, not swapped: the capability is offered as a candidate instead.
  const other = byCat.authentication.candidates.find((c) => c.kind === 'observation');
  if (other) {
    await app.request('laboratory/select', { blueprintId: bp.blueprintId, goalId: byCat.authentication.goalId, selection: { kind: 'observation', projectId: other.projectId, capability: other.capability, name: other.name } });
    const kept = await app.request('laboratory/use', { slug, blueprintId: bp.blueprintId });
    assert.equal(kept.selected, false);
    assert.match(kept.note, /already has a selected implementation/);
    assert.equal(kept.blueprint.goals.find((g) => g.category === 'authentication').selection.kind, 'observation');
    await app.request('laboratory/select', { blueprintId: bp.blueprintId, goalId: byCat.authentication.goalId, selection: { kind: 'organ', slug, capabilityId: organ.capabilityId, name: organ.name } });
  }
  const fresh = await app.request('laboratory/use', { slug });
  assert.equal(fresh.status, 200, JSON.stringify(fresh));
  assert.notEqual(fresh.blueprint.blueprintId, bp.blueprintId);
  assert.ok(fresh.blueprint.analysis.goals.some((g) => g.status === 'matched' && g.selected.slug === slug));
  // Persistence: reopenable, listed, and free of local paths or the home.
  const list = await app.request('laboratory', {});
  assert.equal(list.blueprints.length, 2);
  const reopened = await app.request('laboratory/blueprint', { blueprintId: bp.blueprintId });
  assert.equal(reopened.blueprint.name, 'Client portal');
  const file = fs.readFileSync(path.join(app.home, 'laboratory', 'blueprints', `${bp.blueprintId}.json`), 'utf8');
  assert.ok(!file.includes(os.homedir()) && !file.includes(app.home) && !file.includes(source.root), 'blueprints reference capabilities by id, never by path');
  assert.ok(!file.includes('"analysis"'), 'analysis is recomputed, never persisted');
  // A vanished capability becomes SOURCE UNAVAILABLE; nothing is substituted.
  fs.rmSync(path.join(app.home, 'organ-bank', `${slug}.graft`), { recursive: true, force: true });
  const gone = await app.request('laboratory/blueprint', { blueprintId: bp.blueprintId });
  const goneAuth = gone.blueprint.analysis.goals.find((g) => g.category === 'authentication');
  assert.equal(goneAuth.status, 'source-unavailable');
  assert.equal(gone.blueprint.analysis.readiness, 'HAS_CONFLICTS');
  assert.ok(gone.blueprint.analysis.conflicts.some((c) => c.kind === 'source-unavailable'));
  // Blueprints are never sent to the dogfood/session records with source; only ids and counts.
  await app.request('laboratory/delete', { blueprintId: fresh.blueprint.blueprintId });
  assert.equal((await app.request('laboratory', {})).blueprints.length, 1);
});

test('Laboratory dogfood: a blueprint session scores BLUEPRINTED, records ids and counts only, and is never SUCCESS', async (t) => {
  const previous = process.env.GRAFT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ui-lab-dogfood-'));
  process.env.GRAFT_HOME = home;
  const app = await startDashboard({ port: 0, dogfood: 'lab-trial' });
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(await (await fetch(app.origin)).text())[1];
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const request = async (route, body) => { const r = await fetch(`${app.origin}/api/${route}`, { method: 'POST', headers: { 'X-Graft-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const { readEvents, scorecard } = await import('../../core/src/dogfood/index.js');
  const created = await request('laboratory/create', { name: 'Portal', description: 'people sign in and pay', categories: [], hostIntent: 'new-application' });
  assert.equal(created.status, 200);
  const card = scorecard('lab-trial', { directory: path.join(home, 'dogfood') });
  assert.equal(card.transplant.finalState, 'BLUEPRINTED');
  assert.equal(card.falseVerified, 0);
  const events = readEvents(path.join(home, 'dogfood', 'lab-trial'));
  const create = events.find((e) => e.type === 'laboratory.create');
  assert.deepEqual(create.data.goals.sort(), ['authentication', 'billing']);
  assert.ok(!JSON.stringify(events).includes('people sign in'), 'the description is the person\'s text and is not recorded');
});

test('Laboratory assembly planning: ready blueprint → READY_TO_ASSEMBLE on a proven host, blocked blueprint → blockers, hosts by Host Model, STALE on change, nothing created', async (t) => {
  const app = await setup(t);
  assert.equal((await app.finished((await app.request('samples', {})).job.id)).status, 'completed');
  const state = await app.request('state');
  const source = state.projects.find((p) => p.name === 'old-saas-project'), startup = state.projects.find((p) => p.name === 'new-startup');
  const harvested = await app.finished((await app.request('harvest', { projectId: source.id, capability: 'authentication', trusted: true })).job.id);
  const slug = harvested.result.slug;
  const before = { startup: fs.readdirSync(startup.root, { recursive: true }).sort().join('\n'), source: fs.readdirSync(source.root, { recursive: true }).sort().join('\n') };
  const home = await app.request('laboratory', {});
  assert.deepEqual(home.hosts.architectures.map((a) => a.id), ['node-esm-http-central', 'node-esm-express']);
  assert.ok(home.hosts.projects.some((p) => p.projectId === startup.id));
  // Ready blueprint: Use in Laboratory creates it with the organ selected.
  const fresh = await app.request('laboratory/use', { slug, name: 'Authenticated application' });
  const bp = fresh.blueprint;
  assert.equal(bp.analysis.readiness, 'READY_FOR_ASSEMBLY_PLANNING');
  const noHost = await app.request('laboratory/plan', { blueprintId: bp.blueprintId });
  assert.equal(noHost.status, 200, JSON.stringify(noHost));
  assert.equal(noHost.plan.readiness, 'NEEDS_HOST');
  const express = await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-express' } });
  assert.equal(express.status, 200, JSON.stringify(express));
  assert.equal(express.plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(express.plan.blockers));
  assert.equal(express.plan.status, 'CURRENT');
  assert.equal(express.plan.executionAvailable, false);
  assert.deepEqual(express.plan.steps.map((s) => s.type), ['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'TRANSPLANT_CAPABILITY', 'VERIFY_CAPABILITY', 'REINDEX_HOST', 'FINAL_VERIFICATION']);
  assert.equal(express.plan.host.status, 'SPECIFIED_NOT_CREATED');
  const central = await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  assert.equal(central.plan.readiness, 'BLOCKED_CAPABILITY_SUPPORT', 'a session-auth organ has no emitter for the bare node:http profile');
  // Existing project: the sample startup (ESM, return-response) has a profile for session-auth.
  const onStartup = await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'existing-project', projectId: startup.id } });
  assert.equal(onStartup.status, 200, JSON.stringify(onStartup));
  assert.equal(onStartup.plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(onStartup.plan.blockers));
  assert.equal(onStartup.plan.host.kind, 'existing-project');
  assert.equal(onStartup.plan.host.profile, 'esm-return-response');
  assert.ok(!JSON.stringify(onStartup.plan.host).includes(startup.root), 'the host is kept by id, not by path');
  const onLegacy = await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'existing-project', projectId: source.id } });
  assert.equal(onLegacy.plan.readiness, 'UNSUPPORTED_HOST');
  assert.equal((await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'new-application', architectureId: 'hono' } })).status, 400);
  assert.equal((await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-express', executable: true } })).status, 400);
  assert.equal((await app.request('laboratory/plan/explain', { planId: express.plan.planId })).status, 400, 'no agent: refused plainly');
  // Listing, reopening, and STALE after the blueprint changes.
  const plans = await app.request('laboratory/plans', { blueprintId: bp.blueprintId });
  assert.equal(plans.plans.length, 5);
  const reopened = await app.request('laboratory/plan/view', { planId: express.plan.planId });
  assert.equal(reopened.plan.status, 'CURRENT');
  const goalId = bp.goals[0].goalId;
  await app.request('laboratory/select', { blueprintId: bp.blueprintId, goalId, selection: null });
  const stale = await app.request('laboratory/plan/view', { planId: express.plan.planId });
  assert.equal(stale.plan.status, 'STALE');
  assert.equal(stale.plan.executable, false);
  assert.ok(stale.plan.freshness.reasons.some((r) => /blueprint changed/.test(r)));
  // Blocked blueprint (missing capabilities): a diagnostic plan with explicit blockers, never executable.
  const portal = await app.request('laboratory/create', { name: 'Client portal', description: 'Customers sign in and pay invoices.', categories: ['organizations'], hostIntent: 'new-application' });
  const auth = portal.blueprint.analysis.goals.find((g) => g.category === 'authentication');
  const organ = auth.candidates.find((c) => c.slug === slug);
  await app.request('laboratory/select', { blueprintId: portal.blueprint.blueprintId, goalId: auth.goalId, selection: { kind: 'organ', slug, capabilityId: organ.capabilityId, name: organ.name } });
  const blocked = await app.request('laboratory/plan', { blueprintId: portal.blueprint.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-express' } });
  assert.equal(blocked.plan.readiness, 'BLOCKED_BLUEPRINT');
  assert.equal(blocked.plan.executable, false);
  assert.deepEqual(blocked.plan.blockers.filter((b) => b.kind === 'missing-capability').map((b) => b.label).sort(), ['Billing / payments', 'Organizations / account grouping']);
  assert.ok(blocked.plan.blockers.some((b) => b.kind === 'unmet-dependency'));
  assert.deepEqual(blocked.plan.order.map((o) => o.label), ['User authentication', 'Organizations / account grouping', 'Billing / payments']);
  // Nothing was created anywhere: no worktrees, no folders, no destination writes; plans live under GRAFT_HOME.
  assert.ok(!fs.existsSync(path.join(app.home, 'worktrees')));
  assert.equal(fs.readdirSync(startup.root, { recursive: true }).sort().join('\n'), before.startup);
  assert.equal(fs.readdirSync(source.root, { recursive: true }).sort().join('\n'), before.source);
  const files = fs.readdirSync(path.join(app.home, 'laboratory', 'plans'));
  assert.equal(files.length, 6);
  const text = files.map((f) => fs.readFileSync(path.join(app.home, 'laboratory', 'plans', f), 'utf8')).join('\n');
  assert.ok(!text.includes(app.home) && !text.includes(os.homedir()) && !text.includes(startup.root), 'no local paths in stored plans');
  assert.ok(!/"readiness": "VERIFIED"/.test(text));
});

test('Laboratory dogfood: a planning session scores PLANNED and records ids, readiness and counts only', async (t) => {
  const previous = process.env.GRAFT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ui-plan-dogfood-'));
  process.env.GRAFT_HOME = home;
  const app = await startDashboard({ port: 0, dogfood: 'plan-trial' });
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(await (await fetch(app.origin)).text())[1];
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const request = async (route, body) => { const r = await fetch(`${app.origin}/api/${route}`, { method: 'POST', headers: { 'X-Graft-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const { readEvents, scorecard } = await import('../../core/src/dogfood/index.js');
  const created = await request('laboratory/create', { name: 'Portal', description: 'people sign in and pay', categories: [], hostIntent: 'new-application' });
  const planned = await request('laboratory/plan', { blueprintId: created.blueprint.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-express' } });
  assert.equal(planned.plan.readiness, 'BLOCKED_BLUEPRINT');
  const card = scorecard('plan-trial', { directory: path.join(home, 'dogfood') });
  assert.equal(card.transplant.finalState, 'PLANNED');
  assert.equal(card.falseVerified, 0);
  const event = readEvents(path.join(home, 'dogfood', 'plan-trial')).find((e) => e.type === 'laboratory.plan');
  assert.equal(event.data.readiness, 'BLOCKED_BLUEPRINT');
  assert.ok(event.data.blockers.includes('missing-capability'));
  assert.ok(!JSON.stringify(event).includes('people sign in'));
});

test('Laboratory assembly execution: a READY plan on the bare node:http host creates a real blank app, transplants hosted auth in a managed worktree, verifies it, and re-indexes; blocked, stale and busy plans are refused', async (t) => {
  const app = await setup(t);
  const { fingerprintProject } = await import('../../core/src/analyze/fingerprint.js');
  const { harvestCapability } = await import('../../core/src/harvest/index.js');
  const { writeManifest } = await import('../../core/src/manifest/io.js');
  const { bankDir } = await import('../../core/src/registry/index.js');
  const { inspectRepo } = await import('../../core/src/apply/git.js');
  const { hostedSource } = await import('../../core/test/helpers/hosted-source.js');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ui-assembly-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const source = hostedSource(path.join(work, 'cuf-like-source'));
  // A committed, clean source: the harvest then records the exact revision the evidence came from.
  const { execFileSync } = await import('node:child_process');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'source']]) execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const { manifest } = await harvestCapability(fingerprintProject(source), 'hosted-authentication');
  assert.equal(manifest.provenance.verifiedInSource.sourceState.head, sourceHead);
  writeManifest(bankDir(), manifest);
  const sourceListing = fs.readdirSync(source, { recursive: true }).sort().join('\n');
  const bankListing = fs.readdirSync(bankDir(), { recursive: true }).sort().join('\n');
  // Blueprint and plan from the product.
  const fresh = await app.request('laboratory/use', { slug: manifest.identity.slug, name: 'Authenticated application' });
  const bp = fresh.blueprint;
  assert.equal(bp.analysis.readiness, 'READY_FOR_ASSEMBLY_PLANNING');
  const planned = await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  assert.equal(planned.plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(planned.plan.blockers));
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent);
  // Refusals first: a blocked plan, an Express plan, a stale plan, a bad folder.
  const express = await app.request('laboratory/plan', { blueprintId: bp.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-express' } });
  assert.equal((await app.request('laboratory/execute', { planId: express.plan.planId, destinationParent: parent })).status, 409, 'Express hosts are not assembled in this phase');
  const portal = await app.request('laboratory/create', { name: 'Client portal', description: 'Customers sign in and pay invoices.', categories: [], hostIntent: 'new-application' });
  const blockedPlan = await app.request('laboratory/plan', { blueprintId: portal.blueprint.blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  assert.equal(blockedPlan.plan.readiness, 'BLOCKED_BLUEPRINT');
  const refused = await app.request('laboratory/execute', { planId: blockedPlan.plan.planId, destinationParent: parent });
  assert.equal(refused.status, 409); assert.match(refused.error, /BLOCKED_BLUEPRINT/);
  assert.equal((await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: 'relative' })).status, 400);
  assert.equal((await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, force: true })).status, 400);
  const goalId = bp.goals[0].goalId; const organ = bp.goals[0].selection;
  await app.request('laboratory/select', { blueprintId: bp.blueprintId, goalId, selection: null });
  const stale = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent });
  assert.equal(stale.status, 409); assert.match(stale.error, /STALE/);
  await app.request('laboratory/select', { blueprintId: bp.blueprintId, goalId, selection: organ });
  assert.deepEqual(fs.readdirSync(parent), [], 'refusals create nothing');
  // The real execution.
  const started = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'Authenticated App' });
  assert.equal(started.status, 200, JSON.stringify(started));
  const busy = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent });
  assert.ok([409, 400].includes(busy.status), 'a running plan cannot be executed twice');
  const job = await app.finished(started.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error || job.execution?.error || job.result?.execution?.finalSummary));
  const e = job.result.execution;
  assert.equal(e.status, 'COMPLETED');
  assert.deepEqual(e.steps.map((s) => `${s.type}:${s.status}`), ['CREATE_HOST:DONE', 'REINDEX_HOST:DONE', 'CHECK_DEPENDENCIES:DONE', 'TRANSPLANT_CAPABILITY:DONE', 'VERIFY_CAPABILITY:DONE', 'REINDEX_HOST:DONE', 'FINAL_VERIFICATION:DONE']);
  assert.equal(e.verification.verdict, 'VERIFIED');
  assert.equal(e.verification.capability, manifest.identity.slug);
  assert.ok(e.verification.summary.passed >= 5 && e.verification.summary.failed === 0, JSON.stringify(e.verification.summary));
  assert.equal(e.hostPreservation.failed, 0);
  // Invariants and counterfactuals are the evaluated contract's, not inferred: the proof summary agrees with them.
  assert.ok(e.verification.invariants.length > 0 && e.verification.invariants.every((i) => i.status === 'held'), JSON.stringify(e.verification.invariants));
  assert.ok(e.verification.counterfactuals.length > 0 && e.verification.counterfactuals.every((c) => c.outcome === 'passed'));
  assert.equal(e.verification.proofSummary.invariantsHeld, e.verification.invariants.length);
  assert.equal(e.verification.proofSummary.failed, 0);
  assert.ok(e.proofReferences.some((r) => r.kind === 'proof' && r.contractId) && e.proofReferences.some((r) => r.kind === 'transplant-record'));
  assert.equal(e.finalSummary.assembly, 'COMPLETED');
  assert.match(e.finalSummary.wording, /not a "verified app" claim/);
  assert.equal(e.reindex.profile, 'esm-node-http-central');
  // Created host: real, clean, on main at its initial commit, untouched by the transplant; no remote.
  const created = path.join(parent, 'authenticated-app');
  assert.equal(e.createdProject.root, created);
  assert.deepEqual(fs.readdirSync(created).sort(), ['.git', '.gitignore', 'README.md', 'package.json', 'server.mjs']);
  const repo = inspectRepo(created);
  assert.equal(repo.branch, 'main'); assert.equal(repo.head, e.createdProject.initialCommit); assert.equal(repo.dirty, false);
  assert.equal(e.receipts[0].kind, 'HostCreationReceipt'); assert.equal(e.receipts[0].fingerprint.profile, 'esm-node-http-central');
  // Worktree isolation: the assembled result lives in the managed worktree on the graft branch.
  assert.ok(fs.realpathSync(e.worktree.path).startsWith(fs.realpathSync(app.home) + path.sep), 'the assembled result lives in a GRAFT-managed worktree');
  assert.match(e.worktree.branch, /^graft\/hosted-authentication-[0-9a-f]{8}$/);
  const wt = inspectRepo(e.worktree.path);
  assert.equal(wt.branch, e.worktree.branch);
  assert.ok(fs.existsSync(path.join(e.worktree.path, e.transplantPlan.entrypoint)));
  assert.ok(e.transplantPlan.files.length >= 3);
  const transplants = await app.request('state');
  assert.ok(transplants.managedTransplants.some((x) => x.id === e.transplantId && x.state === 'VERIFIED'), 'the managed transplant record carries the verifier\'s verdict');
  // Immutability: the source and the bank are exactly as before.
  assert.equal(fs.readdirSync(source, { recursive: true }).sort().join('\n'), sourceListing);
  assert.equal(fs.readdirSync(bankDir(), { recursive: true }).sort().join('\n'), bankListing);
  // Persistence: reopenable, private.
  const reopened = await app.request('laboratory/execution', { executionId: e.executionId });
  assert.equal(reopened.execution.status, 'COMPLETED');
  assert.equal((await app.request('laboratory/executions', { planId: planned.plan.planId })).executions.length, 1);
  const raw = fs.readFileSync(path.join(app.home, 'laboratory', 'executions', `${e.executionId}.json`), 'utf8');
  // Names and ids may mention credentials (AUTH_CLIENT_SECRET, sec.no-provider-secret-in-output);
  // values may not. Nothing under a secret-looking key, and no credential-shaped literal anywhere.
  const walk = (value, key = '') => { if (Array.isArray(value)) return value.forEach((v) => walk(v, key));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => walk(v, k));
    if (typeof value === 'string') { assert.ok(!/(secret|token|password|api[_-]?key|private[_-]?key)/i.test(key) || !value, `${key} carries a value`); assert.ok(!/\bsk_[A-Za-z0-9]{8,}/.test(value) && !(/^[A-Za-z0-9+/=]{40,}$/.test(value) && !/^[0-9a-f]+$/.test(value)) && !/^ey[A-Za-z0-9_-]{20,}\./.test(value), `${key} looks like a credential: ${value.slice(0, 20)}`); } };
  walk(JSON.parse(raw));
  assert.match(raw, /sec\.no-provider-secret-in-output/, 'contract invariant names are kept');
  assert.ok(!fs.existsSync(path.join(app.home, 'laboratory', 'executions', `.lock-${planned.plan.planId}`)), 'the lock is released');
  // The dogfood scorecard for a session that assembled: ASSEMBLED, never SUCCESS, never VERIFIED.
  {
    const { scorecard } = await import('../../core/src/dogfood/index.js');
    const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = app.home;
    const dogfoodHome = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-assembly-dogfood-'));
    t.after(() => { fs.rmSync(dogfoodHome, { recursive: true, force: true }); if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; });
    const { openDogfoodSession } = await import('../../core/src/dogfood/index.js');
    const session = openDogfoodSession('assembly-trial', { directory: path.join(dogfoodHome, 'dogfood') });
    session.event('laboratory.execute', { executionId: e.executionId, finalState: 'COMPLETED', verdict: 'VERIFIED', steps: e.steps.map((s) => `${s.type}:${s.status}`) }, { stage: 'verify' });
    const card = scorecard('assembly-trial', { directory: path.join(dogfoodHome, 'dogfood') });
    assert.equal(card.transplant.finalState, 'ASSEMBLED');
    assert.equal(card.falseVerified, 0);
    const failedSession = openDogfoodSession('assembly-failed', { directory: path.join(dogfoodHome, 'dogfood') });
    failedSession.event('laboratory.execute', { executionId: 'x', finalState: 'INCONCLUSIVE', verdict: 'NEEDS_REVIEW' }, { stage: 'verify' });
    assert.equal(scorecard('assembly-failed', { directory: path.join(dogfoodHome, 'dogfood') }).transplant.finalState, 'INCONCLUSIVE', 'an unverified assembly is never ASSEMBLED');
    session.event('laboratory.finalize', { assemblyWorkspaceId: e.assemblyWorkspaceId, kind: 'fast-forward', fromRevision: 'a'.repeat(40), toRevision: 'b'.repeat(40), forced: false, remotesContacted: [] }, { stage: 'review' });
    const finalCard = scorecard('assembly-trial', { directory: path.join(dogfoodHome, 'dogfood') });
    assert.equal(finalCard.transplant.finalState, 'FINALIZED');
    assert.match(finalCard.transplant.finalStateReason, /fast-forward/);
    assert.equal(finalCard.falseVerified, 0);
  }
  // Continuity: the execution opened an assembly workspace whose ledger carries the capability.
  assert.ok(e.assemblyWorkspaceId, 'the execution opened an assembly workspace');
  assert.ok(e.assembledRevision && e.assembledRevision !== e.createdProject.initialCommit, 'the verified state was committed');
  const view = await app.request('laboratory/assembly', { assemblyWorkspaceId: e.assemblyWorkspaceId });
  assert.equal(view.status, 200, JSON.stringify(view));
  const a = view.assembly;
  assert.equal(a.status, 'ACTIVE');
  assert.equal(a.capabilities.length, 1);
  assert.equal(a.capabilities[0].state, 'CURRENT');
  // Proof Integrity 0.1: the packaged flow's CURRENT record cites a durable proof of the COMMITTED revision.
  assert.equal(a.capabilities[0].proofReference.envelopeSchema, 'graft-proof-envelope/1');
  const storedProof = loadProofArtifact(a.capabilities[0].proofReference.envelopeDigest);
  assert.equal(storedProof.intact, true); assert.equal(storedProof.envelope.payload.destination.revision, e.assembledRevision); assert.equal(storedProof.envelope.payload.capability.slug, 'hosted-authentication');
  assert.deepEqual(storedProof.envelope.payload.verdict, { graft: 'VERIFIED', kernel: 'PASS' });
  assert.doesNotMatch(JSON.stringify(storedProof.envelope), /AUTH_CLIENT_SECRET|graft-verification-not-a-secret|Bearer /);
  assert.equal(a.capabilities[0].verificationVerdict, 'VERIFIED');
  assert.equal(a.capabilities[0].destinationRevisionAfter, e.assembledRevision);
  assert.ok(a.capabilities[0].proofReference?.contractId && a.capabilities[0].genomeId && a.capabilities[0].irId);
  // Revision-bound Capability Memory through the product's single-capability path: the ledger and
  // the proof name the same donor revision — the head the harvest verified, never a guess.
  assert.equal(a.capabilities[0].sourceRevision, sourceHead, 'the ledger carries the source revision');
  assert.equal(storedProof.envelope.payload.source.revision, sourceHead);
  assert.equal(e.capabilitySource.sourceRevision, sourceHead);
  // Compatibility Atlas: one attempt, one observation, citing the ledger's proof by digest and the
  // plan's pre-transplant checks; the Laboratory's three verifications did not become three entries.
  const atlas = loadAtlas();
  assert.equal(atlas.length, 1, JSON.stringify(atlas.map((x) => [x.verification?.verdict, x.destinationRevision])));
  assert.equal(atlas[0].proofEnvelopeDigest, a.capabilities[0].proofReference.envelopeDigest);
  assert.equal(atlas[0].destinationRevision, e.assembledRevision); assert.equal(atlas[0].sourceRevision, sourceHead);
  assert.deepEqual(atlas[0].assembly, { finalState: 'COMPLETED', failedStep: null, errorCode: null });
  assert.ok(atlas[0].assumptions.some((c) => c.id === 'source.verification' && c.status === 'ok'));
  assert.ok(atlas[0].adaptations.includes('esm-node-http-central') && atlas[0].adaptations.includes('verification:provider-double/endpoint-configuration'));
  assert.deepEqual(e.atlas.entries.map((x) => x.entryId), [atlas[0].entryId]);
  assert.equal(a.presence[0].presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  assert.equal(a.presence[0].independentDetection, 'not observed', 'the detector does not recognise the transplanted implementation, and nothing is fabricated');
  assert.match(a.presence[0].explanation, /Added and verified by GRAFT/);
  assert.equal(a.promotion.ok, true, JSON.stringify(a.promotion.problems));
  // Finalization is explicit: unconfirmed is refused, and the created checkout has not moved.
  assert.equal((await app.request('laboratory/assembly/finalize', { assemblyWorkspaceId: e.assemblyWorkspaceId })).status, 400);
  assert.equal(inspectRepo(created).head, e.createdProject.initialCommit);
  const finalized = await app.request('laboratory/assembly/finalize', { assemblyWorkspaceId: e.assemblyWorkspaceId, confirmed: true });
  assert.equal(finalized.status, 200, JSON.stringify(finalized));
  assert.equal(finalized.promotion.kind, 'fast-forward');
  assert.equal(finalized.promotion.forced, false);
  assert.deepEqual(finalized.promotion.remotesContacted, []);
  const promoted = inspectRepo(created);
  assert.equal(promoted.head, e.assembledRevision, 'the created project now holds the assembled application');
  assert.equal(promoted.branch, 'main');
  assert.equal(promoted.dirty, false);
  assert.ok(fs.existsSync(path.join(created, 'src', 'auth', 'routes.js')));
  assert.equal(finalized.assembly.status, 'FINALIZED');
  assert.equal(finalized.assembly.capabilities[0].state, 'CURRENT');
  // Finalizing twice is refused; the ledger survives cleaning the managed worktree up.
  assert.equal((await app.request('laboratory/assembly/finalize', { assemblyWorkspaceId: e.assemblyWorkspaceId, confirmed: true })).status, 409);
  const cleaned = await app.request('transplants/cleanup', { transplantId: e.transplantId, confirmDiscard: true });
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned));
  const afterCleanup = await app.request('laboratory/assembly', { assemblyWorkspaceId: e.assemblyWorkspaceId });
  assert.equal(afterCleanup.assembly.capabilities[0].state, 'CURRENT', 'cleanup does not invalidate the ledger');
  assert.equal(afterCleanup.assembly.observed.location, 'primary');
  assert.ok(afterCleanup.assembly.capabilities[0].proofReference.contractId);
  // The plan can be executed again only into a new folder; the same name collides and creates nothing more.
  const again = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'Authenticated App' });
  const againJob = await app.finished(again.job.id);
  assert.equal(againJob.status, 'failed');
  assert.match(againJob.error, /already exists/);
  assert.deepEqual(fs.readdirSync(parent), ['authenticated-app']);
});
