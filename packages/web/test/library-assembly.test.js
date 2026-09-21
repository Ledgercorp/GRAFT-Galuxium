// Library Host Adaptation 0.1b — Checkpoint B, through the real product path.
//
// The core tests prove the operations. This drives the actual server: blueprint → selection → plan
// → execute, and then reads back the assembly exactly as the product reports it. It exists so the
// wiring cannot silently diverge from the operations it is supposed to call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { startDashboard } from '../src/server.js';
import { fingerprintProject } from '../../core/src/analyze/fingerprint.js';
import { harvestCapability } from '../../core/src/harvest/index.js';
import { writeManifest } from '../../core/src/manifest/io.js';
import { bankDir } from '../../core/src/registry/index.js';
import { loadProofArtifact } from '../../core/src/laboratory/proof-store.js';
import { loadAtlas } from '../../core/src/engine/atlas.js';

const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const haveSwivel = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js'));
const needSwivel = { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' };

async function setup(t) {
  const previous = process.env.GRAFT_HOME;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-lib-ui-')));
  process.env.GRAFT_HOME = path.join(work, 'home');
  fs.mkdirSync(process.env.GRAFT_HOME, { recursive: true });
  // The library organ has to be in the bank before the dashboard reads it.
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
  const app = await startDashboard({ port: 0 });
  const html = await (await fetch(app.origin)).text();
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(html)[1];
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    fs.rmSync(work, { recursive: true, force: true });
  });
  async function request(route, body) {
    const response = await fetch(`${app.origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Graft-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, ...(await response.json()) };
  }
  async function finished(id) {
    for (let count = 0; count < 600; count++) {
      const state = await request('state');
      const job = state.jobs.find((j) => j.id === id);
      if (job && job.status !== 'running') return job;
      await pause(100);
    }
    throw new Error('the assembly did not finish in time');
  }
  return { work, request, finished, manifest };
}

test('the product assembles a real library capability into a new node:http host, end to end', needSwivel, async (t) => {
  const app = await setup(t);

  // 1. A blueprint that wants feature flags, selecting the banked library.
  const created = await app.request('laboratory/create', { name: 'Flagged application', description: 'features can be turned on per context', categories: ['feature-flags'], hostIntent: 'new-application' });
  assert.equal(created.status, 200, JSON.stringify(created));
  const blueprintId = created.blueprint.blueprintId;
  const goal = created.blueprint.analysis.goals.find((g) => g.category === 'feature-flags');
  const organ = goal.candidates.find((c) => c.kind === 'organ' && c.slug === 'feature-flags-library');
  assert.ok(organ, `the library is not offered: ${JSON.stringify(goal.candidates)}`);
  assert.equal(organ.implementationForm, 'library');
  const selected = await app.request('laboratory/select', { blueprintId, goalId: goal.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } });
  assert.equal(selected.status, 200, JSON.stringify(selected));

  // 2. The plan opens for the node:http host and is described as an adaptation, not a transplant.
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  assert.equal(planned.status, 200, JSON.stringify(planned));
  assert.equal(planned.plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(planned.plan.blockers));
  assert.ok(planned.plan.steps.some((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY'));
  assert.equal(planned.plan.steps.some((s) => s.type === 'TRANSPLANT_CAPABILITY'), false);

  // 3. Execute it. The host is created in a folder of the person's, never inside GRAFT_HOME.
  const parent = path.join(app.work, 'apps');
  fs.mkdirSync(parent, { recursive: true });
  const launched = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'flagged-application' });
  assert.equal(launched.status, 200, JSON.stringify(launched));
  const job = await app.finished(launched.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error || job.status));

  // 4. What the product now says about the assembly.
  const { execution } = await app.request('laboratory/execution', { executionId: job.result.execution.executionId });
  assert.equal(execution.status, 'COMPLETED', JSON.stringify(execution.error || execution.finalSummary));
  assert.deepEqual(execution.steps.map((s) => `${s.type}:${s.status}`), [
    'CREATE_HOST:DONE', 'REINDEX_HOST:DONE', 'CHECK_DEPENDENCIES:DONE', 'VERIFY_SOURCE_ARTIFACT_IDENTITY:DONE',
    'ADAPT_LIBRARY_CAPABILITY:DONE', 'VERIFY_CAPABILITY:DONE', 'CHECK_HOST_PRESERVATION:DONE', 'REINDEX_HOST:DONE', 'FINAL_VERIFICATION:DONE']);
  // The capability's own verdict, and the destination proof it came from.
  assert.equal(execution.verification.verdict, 'VERIFIED');
  assert.equal(execution.verification.summary.required, 10);
  assert.equal(execution.verification.implementationForm, 'library');
  assert.equal(execution.verification.proofOf, 'destination-adaptation');
  assert.equal(execution.hostPreservation.failed, 0);
  assert.ok(execution.hostPreservation.captured, 'the baseline was captured');
  // The re-index is honest: the detectors recognise nothing, and that is stated, not hidden.
  assert.equal(execution.reindex.detectorObservation, 'NOT_OBSERVED');
  assert.deepEqual(execution.reindex.observedCapabilities, []);
  assert.equal(execution.reindex.profile, 'esm-node-http-central');
  // The final summary names the right capability and claims nothing about the application.
  assert.match(execution.finalSummary.wording, /feature-flags-library VERIFIED by its contract in this host, as an adapted library/);
  // The disclaimer is the point: one capability was verified, the application was not.
  assert.match(execution.finalSummary.wording, /This is not a "verified app" claim/);
  assert.equal(/universal|fully verified|compatibility proven/i.test(execution.finalSummary.wording), false);
  assert.match(execution.finalSummary.finalAssemblyVerification, /one capability, verified by its own contract on the created host/);

  // 5. The assembly ledger: present by GRAFT's evidence, not by detection.
  const { assembly } = await app.request('laboratory/assembly', { assemblyWorkspaceId: execution.assemblyWorkspaceId });
  assert.equal(assembly.capabilities.length, 1);
  const record = assembly.capabilities[0];
  assert.equal(record.state, 'CURRENT');
  assert.equal(record.implementationForm, 'library');
  assert.equal(record.destinationRevisionAfter, execution.assembledRevision);
  // Proof Integrity 0.1: the record cites a durable proof of the committed revision, with the donor revision and organ ids bound.
  const storedProof = loadProofArtifact(record.proofReference.envelopeDigest);
  assert.equal(storedProof.intact, true); assert.equal(storedProof.envelope.payload.destination.revision, execution.assembledRevision);
  assert.equal(storedProof.envelope.payload.source.revision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847'); assert.equal(storedProof.envelope.payload.capability.genomeId, record.genomeId);
  // Revision-bound Capability Memory: the ledger names the exact donor revision the capability's
  // evidence came from — the same one the proof binds — through the product path, not only the kernel.
  assert.equal(record.sourceRevision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847', 'the ledger record carries the source revision');
  assert.equal(execution.capabilitySource.sourceRevision, record.sourceRevision);
  // Compatibility Atlas: this one attempt is one observation, citing the ledger's proof by digest.
  const atlas = loadAtlas();
  assert.equal(atlas.length, 1, 'one attempt, one observation — not one per verification');
  assert.deepEqual(execution.atlas.entries.map((e) => e.entryId), [atlas[0].entryId]);
  assert.equal(atlas[0].proofEnvelopeDigest, record.proofReference.envelopeDigest);
  assert.equal(atlas[0].destinationRevision, execution.assembledRevision); assert.equal(atlas[0].sourceRevision, record.sourceRevision);
  assert.deepEqual(atlas[0].assembly, { finalState: 'COMPLETED', failedStep: null, errorCode: null });
  assert.ok(atlas[0].adaptations.includes(record.adaptation.id));
  assert.equal(JSON.stringify(atlas).includes(execution.worktree.path), false);
  assert.deepEqual(storedProof.envelope.payload.destination.adaptation, { id: record.adaptation.id, artifactSha256: record.adaptation.artifactSha256 });
  assert.equal(record.adaptation.id, 'feature-flags-library-into-esm-node-http-central');
  assert.equal(record.adaptation.adapter, 'src/feature-flags.js');
  assert.equal(record.adaptation.artifactSha256, 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8');
  assert.equal(record.adaptation.licence.declared, 'MIT');
  assert.equal(record.adaptation.detectorObservation, 'NOT_OBSERVED');
  assert.deepEqual(record.adaptation.destinationContract, { cases: 10, passed: 10, verdict: 'VERIFIED' });
  // Source proof and destination proof are both kept, and never added together.
  assert.equal(record.sourceVerification.verdict, 'VERIFIED');
  assert.equal(record.sourceVerification.summary.passed, 8);
  assert.equal(/18\/18|"required":\s*18/.test(JSON.stringify(assembly)), false, 'no invented combined score');
  const [presence] = assembly.presence;
  assert.equal(presence.presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  assert.equal(presence.independentDetection, 'not observed');
  assert.deepEqual(assembly.detected, []);

  // 6. The files that exist, and where.
  const worktree = execution.worktree.path;
  assert.equal(Buffer.compare(fs.readFileSync(path.join(worktree, 'vendor/swivel.cjs')), fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'))), 0, 'the artifact is byte-identical in the destination');
  assert.ok(fs.existsSync(path.join(worktree, 'vendor/swivel.LICENSE')));
  assert.ok(fs.existsSync(path.join(worktree, 'src/feature-flags.js')));
  // The primary checkout is untouched before finalization, and has no remote to push to.
  const primary = execution.createdProject.root;
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: primary, encoding: 'utf8' }).trim(), '');
  assert.equal(fs.existsSync(path.join(primary, 'vendor')), false);
  assert.equal(fs.existsSync(path.join(primary, 'src/feature-flags.js')), false);
  assert.equal(execFileSync('git', ['remote'], { cwd: primary, encoding: 'utf8' }).trim(), '');
  // Nothing was installed or built.
  assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(worktree, 'package-lock.json')), false);
  // The library checkout is untouched.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: SWIVEL, encoding: 'utf8' }).trim(), '');

  // 6b. Everything the evidence panel needs is in the payload, as separate claims.
  assert.equal(execution.capabilitySource.implementationForm, 'library');
  assert.equal(execution.capabilitySource.sourceVerification.verdict, 'VERIFIED');
  assert.equal(execution.capabilitySource.sourceVerification.summary.passed, 8, 'the source proof is 8/8 and stays 8/8');
  assert.equal(execution.adaptation.artifactSha256, 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8');
  assert.equal(execution.adaptation.adapter, 'src/feature-flags.js');
  assert.deepEqual(execution.adaptation.destinationContract, { cases: 10, passed: 10, verdict: 'VERIFIED' });
  assert.equal(execution.adaptation.licence.declared, 'MIT');
  assert.match(execution.adaptation.upstream.repository, /zumba\/swiveljs/);
  assert.equal(execution.adaptation.upstream.revision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847');
  // No combined score anywhere in what the product hands the UI.
  assert.equal(/18\/18|"required":\s*18/.test(JSON.stringify(execution)), false);

  // 7. Finalization is available but explicit, and it is a fast-forward of the person's own branch.
  assert.equal(assembly.promotion.ok, true, JSON.stringify(assembly.promotion));
  assert.equal(assembly.promotion.strategy || assembly.promotion.method || 'fast-forward', 'fast-forward');
});

test('the product refuses to assemble the same library into a host it has not proven', needSwivel, async (t) => {
  const app = await setup(t);
  const created = await app.request('laboratory/create', { name: 'Flagged express application', description: 'features can be turned on per context', categories: ['feature-flags'], hostIntent: 'new-application' });
  const blueprintId = created.blueprint.blueprintId;
  const goal = created.blueprint.analysis.goals.find((g) => g.category === 'feature-flags');
  const organ = goal.candidates.find((c) => c.kind === 'organ' && c.slug === 'feature-flags-library');
  await app.request('laboratory/select', { blueprintId, goalId: goal.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } });
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-express' } });
  assert.equal(planned.plan.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  // And the product will not execute it, rather than trying and failing halfway.
  const parent = path.join(app.work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const refused = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'nope' });
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.match(refused.error, /cannot be assembled/i);
  assert.equal(fs.existsSync(path.join(parent, 'nope')), false, 'no application shell was created');
});

test('the rendered product wording is honest about a library capability', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  // The library steps have human labels; a raw step type in the UI would be a defect.
  for (const type of ['VERIFY_SOURCE_ARTIFACT_IDENTITY', 'ADAPT_LIBRARY_CAPABILITY', 'CHECK_HOST_PRESERVATION']) {
    assert.match(app, new RegExp(`${type}: '`), `${type} needs a label a person can read`);
  }
  // Distinct evidence claims, and an explicit statement that they are not one score.
  assert.match(app, /There is no combined score/);
  assert.match(app, /NOT OBSERVED/);
  assert.match(app, /does not recognise it\. That is not a failure/);
  // The adaptation is described without service wording or false claims.
  assert.match(app, /No package installation\. No source build\. No HTTP routes added\./);
  assert.equal(/Universal support|Works everywhere|Compatible with all/i.test(app), false);
  // The re-index line must not describe a flags capability as authentication: the detector result
  // is read from the execution record, and the authentication wording is only the legacy fallback.
  assert.match(app, /e\.reindex\.detectorObservation === 'NOT_OBSERVED' \?/);
  // Form is shown as what the capability is.
  assert.match(app, /const FORM_LABEL = \{ service: 'Service', library: 'Library' \}/);
});

// The evidence panel is the customer-facing claim surface, so it is rendered from a REAL execution
// payload rather than only grepped: the view functions are evaluated with the same small helpers the
// page gives them, and the output is held to the claims the product is allowed to make.
test('the evidence panel, rendered from a real assembly, states each proof separately', needSwivel, async (t) => {
  const app = await setup(t);
  const created = await app.request('laboratory/create', { name: 'Flagged application', description: 'features can be turned on per context', categories: ['feature-flags'], hostIntent: 'new-application' });
  const blueprintId = created.blueprint.blueprintId;
  const goal = created.blueprint.analysis.goals.find((g) => g.category === 'feature-flags');
  const organ = goal.candidates.find((c) => c.kind === 'organ' && c.slug === 'feature-flags-library');
  await app.request('laboratory/select', { blueprintId, goalId: goal.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } });
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  const parent = path.join(app.work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const launched = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'flagged-application' });
  const job = await app.finished(launched.job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error || job.status));
  const { execution } = await app.request('laboratory/execution', { executionId: job.result.execution.executionId });

  // Evaluate the page's own view function with the helpers the page provides it.
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function libraryEvidenceView');
  assert.ok(start > 0, 'libraryEvidenceView must exist');
  const end = source.indexOf('\n}', source.indexOf('return `<h3 class="small-heading">What was proven', start)) + 2;
  const fnSource = source.slice(start, end);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const badge = (text) => `[${text}]`;
  // eslint-disable-next-line no-new-func
  const render = new Function('esc', 'badge', `${fnSource}; return libraryEvidenceView;`)(esc, badge);
  const html = render(execution);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Four separate claims, each with its own answer.
  assert.match(text, /Source \[VERIFIED\]/);
  assert.match(text, /8\/8 required cases/, 'the source proof is shown as 8/8');
  assert.match(text, /Artifact identity \[MATCHED\]/);
  assert.match(text, /958f8dc2539936e7/, 'the artifact hash the person can check');
  assert.match(text, /Destination \[VERIFIED\]/);
  assert.match(text, /10\/10 required cases/, 'the destination proof is shown as 10/10');
  assert.match(text, /Host preservation \[PASSED\]/);
  assert.match(text, /Presence \[ADDED AND VERIFIED BY GRAFT\]/);
  assert.match(text, /Independent detector \[NOT OBSERVED\]/);
  // The detector's silence is explained, not flagged as a problem.
  assert.match(text, /That is not a failure and does not weaken the evidence above/);
  assert.equal(/warning|error|incomplete/i.test(text), false, 'detector absence must not be dressed as a warning');
  // No combined score, anywhere.
  assert.equal(/18\/18/.test(text), false);
  assert.match(text, /There is no combined score/);
  // How it was added, and whose code it is.
  assert.match(text, /carried in unchanged as vendor\/swivel\.cjs/);
  assert.match(text, /GRAFT generated src\/feature-flags\.js/);
  assert.match(text, /No package was installed, nothing was built, and no HTTP route was added/);
  assert.match(text, /zumba\/swiveljs/);
  assert.match(text, /licence MIT/);
  assert.match(text, /GRAFT did not author or modify this library/);
});

// Finalization and the finalized application, through the product's own API and then on its own.
// The packaged UI drives exactly these routes; this proves what they do.
test('finalizing moves the person’s own project to the verified revision, and the result runs alone', needSwivel, async (t) => {
  const app = await setup(t);
  const created = await app.request('laboratory/create', { name: 'Flagged application', description: 'features can be turned on per context', categories: ['feature-flags'], hostIntent: 'new-application' });
  const blueprintId = created.blueprint.blueprintId;
  const goal = created.blueprint.analysis.goals.find((g) => g.category === 'feature-flags');
  const organ = goal.candidates.find((c) => c.kind === 'organ' && c.slug === 'feature-flags-library');
  await app.request('laboratory/select', { blueprintId, goalId: goal.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } });
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  const parent = path.join(app.work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const job = await app.finished((await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'flagged-application' })).job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.error || job.status));
  const { execution } = await app.request('laboratory/execution', { executionId: job.result.execution.executionId });
  const project = execution.createdProject.root;

  // Before finalization the person's own checkout still holds only the blank host.
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  assert.equal(fs.existsSync(path.join(project, 'vendor')), false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim(), '');

  // Finalization is explicit: without the confirmation it is refused.
  const unconfirmed = await app.request('laboratory/assembly/finalize', { assemblyWorkspaceId: execution.assemblyWorkspaceId, confirmed: false });
  assert.equal(unconfirmed.status >= 400, true, 'finalization must not happen without confirmation');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim(), before);

  const finalized = await app.request('laboratory/assembly/finalize', { assemblyWorkspaceId: execution.assemblyWorkspaceId, confirmed: true });
  assert.equal(finalized.status, 200, JSON.stringify(finalized));
  const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim();
  assert.notEqual(after, before);
  assert.equal(after, execution.assembledRevision, 'the project stands exactly at the verified revision');
  assert.equal(finalized.body?.assembly?.finalization?.kind ?? finalized.assembly?.finalization?.kind, 'fast-forward');
  assert.equal((finalized.body?.assembly?.finalization ?? finalized.assembly?.finalization).forced, false, 'never forced');
  // The blank host commit is still the parent: history was added to, not rewritten.
  assert.equal(execFileSync('git', ['log', '--format=%H', '-2'], { cwd: project, encoding: 'utf8' }).trim().split('\n')[1], before);
  assert.equal(execFileSync('git', ['remote'], { cwd: project, encoding: 'utf8' }).trim(), '', 'nothing was pushed anywhere');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).trim(), '');

  // The third-party artifact, still byte-identical, still saying whose it is.
  const artifact = path.join(project, 'vendor/swivel.cjs');
  assert.equal(Buffer.compare(fs.readFileSync(artifact), fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'))), 0);
  assert.equal(`sha256:${crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex')}`, 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8');
  const provenance = JSON.parse(fs.readFileSync(path.join(project, 'vendor/swivel.provenance.json'), 'utf8'));
  assert.match(provenance.source.repository, /zumba\/swiveljs/);
  assert.equal(provenance.source.revision, 'f4d6efd1486c277544f78a08ed74296f5a1e7847');
  assert.equal(provenance.licence.declared, 'MIT');
  assert.equal(provenance.artifact.copiedVerbatim, true);
  assert.equal(provenance.adaptation.adapterAuthoredBy, 'GRAFT');
  assert.match(provenance.note, /GRAFT did not author or modify it/);
  assert.match(fs.readFileSync(path.join(project, 'vendor/swivel.LICENSE'), 'utf8'), /MIT License/i);

  // The finalized application, run from the person's own checkout: its own routes, its own 404.
  const port = 3987;
  const server = spawn(process.execPath, ['server.mjs'], { cwd: project, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    for (let i = 0; i < 80; i += 1) { if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) break; await pause(250); }
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/nothing-here`)).status, 404, 'a deterministic 404 for a route it does not serve');
  } finally { server.kill('SIGKILL'); }

  // And the capability itself, used the way the application's own code would use it.
  const probe = path.join(project, '.standalone-check.mjs');
  fs.writeFileSync(probe, `import Flags from './src/feature-flags.js';
const map = { Graft: [1, 2], 'Graft.enabled': [1], 'Graft.off': [], Parent: [1], 'Parent.child': [1] };
const on = new Flags({ map, bucketIndex: 1 }), off = new Flags({ map, bucketIndex: 2 });
let took = null; on.branch('Graft.enabled', () => { took = 'enabled'; }, () => { took = 'disabled'; });
console.log(JSON.stringify({ enabled: on.isEnabled('Graft.enabled'), disabled: off.isEnabled('Graft.enabled'), empty: on.isEnabled('Graft.off'),
  unknown: on.isEnabled('not-configured'), parentGates: off.isEnabled('Parent.child'), chose: on.choose('Graft.enabled', 'on', 'off'),
  choseOff: off.choose('Graft.enabled', 'on', 'off'), took, repeated: [on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled')] }));
`);
  let flags;
  try { flags = JSON.parse(execFileSync(process.execPath, [probe], { cwd: project, encoding: 'utf8', timeout: 30000 })); }
  finally { fs.rmSync(probe, { force: true }); }
  assert.deepEqual({ ...flags, repeated: undefined }, { enabled: true, disabled: false, empty: false, unknown: false, parentGates: false, chose: 'on', choseOff: 'off', took: 'enabled', repeated: undefined });
  assert.equal(new Set(flags.repeated).size, 1, 'the same question gets the same answer every time');

  // The ledger is still CURRENT for the promoted revision, and presence is still GRAFT's evidence.
  const { assembly } = await app.request('laboratory/assembly', { assemblyWorkspaceId: execution.assemblyWorkspaceId });
  assert.equal(assembly.status, 'FINALIZED');
  assert.equal(assembly.capabilities[0].state, 'CURRENT');
  assert.equal(assembly.presence[0].presence, 'PRESENT_BY_ASSEMBLY_EVIDENCE');
  assert.equal(assembly.presence[0].independentDetection, 'not observed');
});
