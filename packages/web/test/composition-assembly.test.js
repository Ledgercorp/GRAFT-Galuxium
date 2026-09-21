// Real Multi-Capability Composition 0.1 — Checkpoint C, through the real product path.
//
// The core test proves the real operations. This drives the actual server for the real pair:
// blueprint (authentication, feature-flags) → selections → plan → execute → readback → finalize,
// so the product's wiring of the composition kernel cannot diverge from the operations it calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { startDashboard } from '../src/server.js';
import { fingerprintProject } from '../../core/src/analyze/fingerprint.js';
import { harvestCapability } from '../../core/src/harvest/index.js';
import { writeManifest } from '../../core/src/manifest/io.js';
import { bankDir } from '../../core/src/registry/index.js';

const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const CUF_ORGAN = path.join(os.homedir(), '.graft/organ-bank/hosted-authentication.graft');
const haveReal = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js')) && fs.existsSync(CUF_ORGAN);
const needReal = { skip: haveReal ? false : 'the SwivelJS checkout or the harvested CUF organ is not present' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The page's own view functions, evaluated with the helpers the page provides them. */
function pageViews({ lab }) {
  const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const slice = (from, to) => { const i = source.indexOf(from); assert.ok(i >= 0, from); const j = source.indexOf(to, i); assert.ok(j > i, to); return source.slice(i, j); };
  const helpers = slice('const STEP_WORDS =', '// Assembly Plan tab:');
  const composition = slice('function compositionResultView(', '// Evidence for an adapted library capability');
  const assembled = slice('function assembledApplicationView(', 'async function loadAssembly(');
  const tones = source.split('\n').filter((l) => l.startsWith('const ledgerTone = ')).join('\n') + '\nlet lastProofExport = null;';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const badge = (text) => `[${text}]`;
  const FORM_LABEL = { service: 'Service', library: 'Library' };
  // eslint-disable-next-line no-new-func
  const built = new Function('esc', 'badge', 'lab', 'FORM_LABEL', 'icon', 'disabled', 'window', 'loadAssembly', `${helpers}\n${tones}\n${composition}\n${assembled}\nreturn { compositionResultView, assembledApplicationView, executionStageLabel, planStepLabel };`)(esc, badge, lab, FORM_LABEL, () => '', () => '', {}, () => {});
  return { ...built, text: (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
}
async function setup(t) {
  const previous = process.env.GRAFT_HOME;
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-comp-ui-')));
  process.env.GRAFT_HOME = path.join(work, 'home');
  fs.mkdirSync(bankDir(), { recursive: true });
  fs.cpSync(CUF_ORGAN, path.join(bankDir(), 'hosted-authentication.graft'), { recursive: true });
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
  const app = await startDashboard({ port: 0 });
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(await (await fetch(app.origin)).text())[1];
  t.after(async () => { await app.close(); if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  const request = async (route, body) => { const r = await fetch(`${app.origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Graft-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, ...(await r.json()) }; };
  const finished = async (id) => { for (let n = 0; n < 900; n += 1) { const job = (await request('state')).jobs.find((j) => j.id === id); if (job && job.status !== 'running') return job; await pause(100); } throw new Error('the assembly did not finish in time'); };
  return { work, request, finished };
}

test('the product composes the real CUF auth and SwivelJS flags into one application, reports both CURRENT at one revision, and finalizes explicitly', needReal, async (t) => {
  const app = await setup(t);
  const created = await app.request('laboratory/create', { name: 'Flagged portal', description: 'people sign in, and features can be turned on for some of them', categories: ['authentication', 'feature-flags'], hostIntent: 'new-application' });
  assert.equal(created.status, 200, JSON.stringify(created));
  const blueprintId = created.blueprint.blueprintId;
  for (const g of created.blueprint.analysis.goals) {
    const organ = g.candidates.find((c) => c.kind === 'organ');
    assert.ok(organ, `${g.category}: no organ offered`);
    assert.equal((await app.request('laboratory/select', { blueprintId, goalId: g.goalId, selection: { kind: 'organ', slug: organ.slug, capabilityId: organ.capabilityId, name: organ.name } })).status, 200);
  }
  const planned = await app.request('laboratory/plan', { blueprintId, host: { kind: 'new-application', architectureId: 'node-esm-http-central' } });
  assert.equal(planned.plan.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(planned.plan.blockers));
  assert.deepEqual(planned.plan.order.map((o) => o.label), ['User authentication', 'Feature flags']);
  assert.equal(planned.plan.ordering.rule, 'blueprint-declared-order');
  assert.ok(planned.plan.steps.some((s) => s.type === 'REVERIFY_CAPABILITY'));

  const parent = path.join(app.work, 'apps'); fs.mkdirSync(parent, { recursive: true });
  const launched = await app.request('laboratory/execute', { planId: planned.plan.planId, destinationParent: parent, projectName: 'flagged-portal' });
  assert.equal(launched.status, 200, JSON.stringify(launched));
  const job = await app.finished(launched.job.id);
  const observedAt = Date.now();
  assert.equal(job.status, 'completed', JSON.stringify(job.error || job.status));
  assert.equal(job.result.promotable, true);
  // The state poll exposes the finished composition promptly: nothing (including the memoized
  // stale-project count) may hold back an execution-state transition.
  const finishedAt = Date.parse(job.result.execution.finishedAt);
  assert.ok(observedAt - finishedAt < 5000, `state showed the completed composition ${observedAt - finishedAt} ms after it finished`);
  const state = await app.request('state');
  assert.equal(state.activeJob, null); assert.equal(state.jobs.find((j) => j.id === launched.job.id).status, 'completed');
  assert.equal(typeof state.workspace.stale, 'number');

  const { execution } = await app.request('laboratory/execution', { executionId: job.result.execution.executionId });
  assert.equal(execution.status, 'COMPLETED', JSON.stringify(execution.error || execution.finalSummary));
  assert.deepEqual(execution.steps.map((s) => `${s.type}:${s.status}`), ['CREATE_HOST:DONE', 'REINDEX_HOST:DONE', 'CHECK_DEPENDENCIES:DONE', 'TRANSPLANT_CAPABILITY:DONE', 'VERIFY_CAPABILITY:DONE', 'CHECK_HOST_PRESERVATION:DONE', 'REINDEX_HOST:DONE',
    'VERIFY_SOURCE_ARTIFACT_IDENTITY:DONE', 'ADAPT_LIBRARY_CAPABILITY:DONE', 'VERIFY_CAPABILITY:DONE', 'REVERIFY_CAPABILITY:DONE', 'CHECK_HOST_PRESERVATION:DONE', 'REINDEX_HOST:DONE', 'FINAL_VERIFICATION:DONE']);
  assert.equal(execution.composition.finalState, 'ALL_SELECTED_CAPABILITIES_VERIFIED');
  assert.deepEqual(execution.composition.capabilities.map((c) => [c.capability, c.initialVerdict, c.reverifiedVerdict, c.finalVerdict, c.finalSummary.passed]), [['hosted-authentication', 'VERIFIED', 'VERIFIED', 'VERIFIED', 13], ['feature-flags-library', 'VERIFIED', null, 'VERIFIED', 10]]);
  assert.equal(execution.composition.finalRevision, execution.assembledRevision);
  assert.equal(execution.hostPreservation.failed, 0); assert.equal(execution.hostPreservation.tests, 2);
  assert.equal(execution.reindex.detectorObservation['feature-flags-library'], 'NOT_OBSERVED');
  assert.match(execution.finalSummary.wording, /hosted-authentication and feature-flags-library each VERIFIED by their own contracts on the same final revision/);
  assert.match(execution.finalSummary.wording, /This is not a "verified app" claim/);

  const { assembly } = await app.request('laboratory/assembly', { assemblyWorkspaceId: execution.assemblyWorkspaceId });

  // What the PAGE shows, rendered by its own view functions from these exact records.
  const views = pageViews({ lab: { plan: planned.plan, assembly } });
  const result = views.text(views.compositionResultView(execution, planned.plan));
  assert.match(result, /^COMPOSITION VERIFIED User authentication and Feature flags were each verified by their own contracts on the same final application revision/);
  assert.match(result, /Final application revision Revision \w{12}/);
  assert.match(result, new RegExp(execution.assembledRevision.slice(0, 12)), 'the real revision, not a constant');
  assert.equal((result.match(/\[VERIFIED AT THIS REVISION\]/g) || []).length, 2, 'both capabilities verified at the one revision');
  assert.match(result, /User authentication .*Destination, when added \[VERIFIED\] .*13\/13 required cases/);
  assert.match(result, /Destination, after the later capabilities \[VERIFIED\] .*after Feature flags were added 13\/13 required cases/);
  assert.match(result, /deterministic stand-in for the identity provider — no external provider was contacted/);
  assert.match(result, /Feature flags .*Source \[VERIFIED\] .*8\/8 required cases/);
  assert.match(result, /Artifact identity \[MATCHED\] .*958f8dc2539936e7/);
  assert.match(result, /Destination \[VERIFIED\] .*10\/10 required cases/);
  assert.match(result, /zumba\/swiveljs\.git @ f4d6efd1486c · licence MIT/);
  assert.match(result, /@leftsock\/cuf/);
  assert.equal((result.match(/Presence \[ADDED AND VERIFIED BY GRAFT\]/g) || []).length, 2);
  assert.match(result, /Feature flags .*Independent detector \[NOT OBSERVED\] .*The independent detector did not identify this capability .*GRAFT knows it is present from the verified assembly evidence/);
  assert.match(result, /Host preservation \[PASSED\] .*2\/2 checks/);
  assert.match(result, /There is no combined score/);
  for (const bogus of ['21/21', '23/23', '31/31', '18/18', '33/33']) assert.equal(result.includes(bogus), false, `no combined score ${bogus}`);
  assert.equal(/warning|error/i.test(result.split('Independent detector')[1] || ''), false);
  const ledger = views.text(views.assembledApplicationView(execution));
  assert.match(ledger, /2 capabilities, 2 current — one application revision, one ledger record each/);
  assert.match(ledger, /User authentication \[VERIFIED\] \[present by assembly evidence\]/);
  assert.match(ledger, /Feature flags \[VERIFIED\] \[present by assembly evidence\]/);
  assert.match(ledger, /Capability User authentication \[CURRENT\] record 1 of 2 .*Source form Service · hosted-session-auth .*Source @leftsock\/cuf/);
  assert.match(ledger, /Capability Feature flags \[CURRENT\] record 2 of 2 .*Source form Library .*Source https:\/\/github.com\/zumba\/swiveljs.* Licence MIT/);
  assert.equal((ledger.match(/\[same revision as the whole application\]/g) || []).length, 2);
  // Proof Integrity 0.1: one integrity line per record — a third fact beside CURRENT and VERIFIED, not styled as either.
  assert.deepEqual(assembly.capabilities.map((c) => [c.capability, c.state, c.verificationVerdict, c.proofIntegrity.status]), [['hosted-authentication', 'CURRENT', 'VERIFIED', 'INTACT'], ['feature-flags-library', 'CURRENT', 'VERIFIED', 'INTACT']]);
  assert.equal((ledger.match(/Proof integrity \[Intact\] [0-9a-f]{12} Whether the stored proof artifact is unmodified — separate from the capability's state above and from its recorded verdict\./g) || []).length, 2);
  assert.notEqual(assembly.capabilities[0].proofIntegrity.digest, assembly.capabilities[1].proofIntegrity.digest);
  assert.doesNotMatch(views.assembledApplicationView(execution), /badge good">Intact/, 'intact is not rendered with the VERIFIED tone');
  assert.match(ledger, /Verified when added at \w{12} , then verified again at \w{12} after feature-flags-library/);
  assert.match(ledger, /Finalize assembled project/);
  // Progress and plan wording, from the same records.
  assert.deepEqual(execution.steps.map((st) => views.executionStageLabel(execution, planned.plan, st)), ['Creating application', 'Indexing host', 'Checking capability requirements', 'Adding User authentication', 'Verifying User authentication', 'Checking host preservation', 'Re-indexing host',
    'Verifying Feature flags artifact', 'Adapting Feature flags', 'Verifying Feature flags', 'Re-verifying User authentication', 'Checking final host preservation', 'Re-indexing application', 'Final verification']);
  assert.deepEqual(planned.plan.steps.map((st) => views.planStepLabel(planned.plan, st)), ['Create application', 'Re-index host', 'Check capability requirements', 'Transplant capability — User authentication', 'Verify capability — User authentication', 'Check host preservation — User authentication', 'Re-index host',
    'Verify source artifact identity — Feature flags', 'Adapt library capability — Feature flags', 'Verify capability — Feature flags', 'Re-verify capability — User authentication', 'Check final host preservation', 'Re-index the composed application', 'Final verification']);
  assert.deepEqual(assembly.capabilities.map((c) => [c.capability, c.state, c.implementationForm, c.currentVerifiedRevision === execution.assembledRevision, c.destinationRevisionAfter === execution.assembledRevision]), [['hosted-authentication', 'CURRENT', 'service', true, true], ['feature-flags-library', 'CURRENT', 'library', true, true]]);
  assert.deepEqual(assembly.presence.map((p) => [p.capability, p.presence]), [['hosted-authentication', 'PRESENT_BY_ASSEMBLY_EVIDENCE'], ['feature-flags-library', 'PRESENT_BY_ASSEMBLY_EVIDENCE']]);
  assert.equal(assembly.promotion.ok, true, JSON.stringify(assembly.promotion.problems));
  const primary = execution.createdProject.root;
  assert.equal(git(primary, ['rev-parse', 'HEAD']), execution.createdProject.initialCommit, 'the primary checkout has not moved');

  const finalized = await app.request('laboratory/assembly/finalize', { assemblyWorkspaceId: execution.assemblyWorkspaceId, confirmed: true });
  assert.equal(finalized.status, 200, JSON.stringify(finalized));
  assert.deepEqual([finalized.promotion.kind, finalized.promotion.forced, finalized.promotion.toRevision], ['fast-forward', false, execution.assembledRevision]);
  assert.equal(finalized.assembly.status, 'FINALIZED');
  assert.deepEqual(finalized.assembly.capabilities.map((c) => c.proofIntegrity.status), ['INTACT', 'INTACT'], 'the finalize response carries proof integrity, so the page lands on a complete result');
  assert.equal(git(primary, ['rev-parse', 'HEAD']), execution.assembledRevision);
  assert.equal(git(primary, ['remote']), '');
  // Revision drift after finalization: the records go STALE by the existing rule; each original proof
  // stays INTACT and the page says so, as two different facts.
  fs.writeFileSync(path.join(primary, 'later.js'), 'export const later = true;\n');
  git(primary, ['add', '-A']); git(primary, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a later change']);
  const { assembly: drifted } = await app.request('laboratory/assembly', { assemblyWorkspaceId: execution.assemblyWorkspaceId });
  assert.deepEqual(drifted.capabilities.map((c) => [c.state, c.proofIntegrity.status, c.proofIntegrity.digest === assembly.capabilities.find((x) => x.capability === c.capability).proofIntegrity.digest]), [['STALE', 'INTACT', true], ['STALE', 'INTACT', true]]);
  const driftedPage = pageViews({ lab: { plan: planned.plan, assembly: drifted } });
  const driftedLedger = driftedPage.text(driftedPage.assembledApplicationView(execution));
  assert.equal((driftedLedger.match(/\[STALE\]/g) || []).length, 2);
  assert.equal((driftedLedger.match(/Proof integrity \[Intact\] [0-9a-f]{12} .*?The original proof stays intact after drift; it describes the earlier revision\./g) || []).length, 2);
});
