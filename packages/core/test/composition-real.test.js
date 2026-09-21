// Real Multi-Capability Composition 0.1 — Checkpoint C: the REAL CUF + SwivelJS composition.
//
// No injected verdicts anywhere: the composition kernel runs over the real operations
// (`composition-ops.js`), the real banked CUF hosted-session-auth organ and the real SwivelJS
// feature-flags library, into one new bare node:http application. What this proves is
// coexistence and mutual preservation on ONE final revision — and, in the counterfactuals, that
// a broken capability closes the composition even when the other one still verifies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest, readManifest } from '../src/manifest/io.js';
import { bankDir } from '../src/registry/index.js';
import { inspectRepo } from '../src/apply/git.js';
import { getTransplant, cleanupTransplant } from '../src/apply/worktree.js';
import { withDouble } from '../src/verify/index.js';
import { createBlueprint, addGoal, analyseBlueprint, selectImplementation, saveBlueprint } from '../src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification, viewAssemblyPlan, saveAssemblyPlan } from '../src/laboratory/assembly.js';
import { checkExecutionEligibility, loadExecution } from '../src/laboratory/execution.js';
import { evaluateWorkspace, capabilityPresence, checkPromotion, promoteAssembly, loadAssemblyWorkspace, saveAssemblyWorkspace, assembliesDir } from '../src/laboratory/continuity.js';
import { realCompositionOps, runRealComposition } from '../src/laboratory/composition-ops.js';
import { executeCompositionPlan } from '../src/laboratory/composition.js';
import { loadProofArtifact, proofArtifactPath, exportAssemblyProofs, proofIntegrity } from '../src/laboratory/proof-store.js';
import { verifyProofEnvelope, verifyProofFile } from '../../proof-adapter/src/index.js';
import { createExecution, saveExecution } from '../src/laboratory/execution.js';
import { loadAtlas } from '../src/engine/atlas.js';
import { recordAssemblyOutcomes } from '../src/laboratory/atlas-outcomes.js';

const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const CUF_ORGAN = path.join(os.homedir(), '.graft/organ-bank/hosted-authentication.graft');
const CUF_REPO = path.join(os.homedir(), 'Developer/CUF');
const SWIVEL_REVISION = 'f4d6efd1486c277544f78a08ed74296f5a1e7847';
const SWIVEL_SHA256 = '958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8';
const haveReal = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js')) && fs.existsSync(CUF_ORGAN);
const needReal = { skip: haveReal ? false : 'the SwivelJS checkout or the harvested CUF organ is not present' };
const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-creal-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
/** The donors as they are: read here before and after, never written. */
const donorState = () => ({
  cuf: fs.existsSync(CUF_REPO) ? { dirty: git(CUF_REPO, ['status', '--porcelain']), head: git(CUF_REPO, ['rev-parse', 'HEAD']), graftBranches: git(CUF_REPO, ['branch', '--list', 'graft/*']) } : null,
  swivel: { dirty: git(SWIVEL, ['status', '--porcelain']), head: git(SWIVEL, ['rev-parse', 'HEAD']), graftBranches: git(SWIVEL, ['branch', '--list', 'graft/*']), artifact: sha256(path.join(SWIVEL, 'dist/swivel.js')) },
});
/** CUF is copied from the bank (never re-harvested, never booted); SwivelJS is harvested from its checkout (read-only). */
async function bankBoth() {
  fs.mkdirSync(bankDir(), { recursive: true });
  fs.cpSync(CUF_ORGAN, path.join(bankDir(), 'hosted-authentication.graft'), { recursive: true });
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
}
function realPlan() {
  const bp = createBlueprint({ name: 'Flagged portal', description: 'people sign in, and features can be turned on for some of them', hostIntent: 'new-application' });
  addGoal(bp, { category: 'authentication' }); addGoal(bp, { category: 'feature-flags' });
  for (const g of analyseBlueprint(bp, { index: EMPTY_INDEX }).goals) { const c = g.candidates.find((x) => x.kind === 'organ'); selectImplementation(bp, g.goalId, { kind: 'organ', slug: c.slug, capabilityId: c.capabilityId, name: c.name }); }
  saveBlueprint(bp);
  const plan = saveAssemblyPlan(buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-http-central'), index: EMPTY_INDEX }));
  return { bp, plan, view: viewAssemblyPlan(plan, bp, { index: EMPTY_INDEX }) };
}
/**
 * Boot the application on its own (plain `node server.mjs`, the provider double standing in for
 * the hosted provider) and probe it with fetch — no GRAFT verifier, no decideVerdict.
 */
async function independentRun(root, authManifest, check) {
  return withDouble(authManifest, async (double, env) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, ...env, PORT: String(port), AUTH_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
    try {
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 60 && !ready; i += 1) { try { ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      assert.equal(ready, true, `the application did not start on its own: ${stderr.slice(0, 500)}`);
      return await check(base);
    } finally { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
  });
}
const flagsProbe = (root) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  import F from ${JSON.stringify(path.join(root, 'src/feature-flags.js'))};
  const map = { 'Graft': [1, 2], 'Graft.enabled': [1], 'Graft.off': [] };
  const on = new F({ map, bucketIndex: 1 }), off = new F({ map, bucketIndex: 2 });
  console.log(JSON.stringify({ enabled: on.isEnabled('Graft.enabled'), disabled: off.isEnabled('Graft.enabled'), off: on.isEnabled('Graft.off'), unknown: on.isEnabled('Graft.not-configured'),
    chooseOn: on.choose('Graft.enabled', 'on', 'off'), chooseOff: off.choose('Graft.enabled', 'on', 'off'), branchOn: on.branch('Graft.enabled', () => 'enabled', () => 'disabled'), branchOff: off.branch('Graft.enabled', () => 'enabled', () => 'disabled') }));
`], { encoding: 'utf8' }));
const EXPECTED_FLAGS = { enabled: true, disabled: false, off: false, unknown: false, chooseOn: 'on', chooseOff: 'off', branchOn: 'enabled', branchOff: 'disabled' };

test('REAL: CUF hosted auth + SwivelJS feature flags compose into one application; both verified on the same final revision; finalized and run independently; donors untouched', needReal, async (t) => {
  const work = sandbox(t);
  const donorsBefore = donorState();
  await bankBoth();
  const auth = readManifest(path.join(bankDir(), 'hosted-authentication.graft'));
  const flags = readManifest(path.join(bankDir(), 'feature-flags-library.graft'));
  assert.equal(auth.provenance.sourceProject.name, '@leftsock/cuf'); assert.equal(auth.provenance.sourceProject.version, '1.0.0-bootstrap.1');
  assert.deepEqual(auth.provenance.verifiedInSource.summary, { required: 13, passed: 13, failed: 0, inconclusive: 0 });
  assert.equal(fs.realpathSync(flags.provenance.sourceProject.root), fs.realpathSync(SWIVEL)); assert.equal(flags.provenance.verifiedInSource.verdict, 'VERIFIED'); assert.deepEqual(flags.provenance.verifiedInSource.summary, { required: 8, passed: 8, failed: 0, inconclusive: 0 });
  const { bp, plan, view } = realPlan();
  assert.equal(plan.readiness, 'READY_TO_ASSEMBLE');
  assert.deepEqual(plan.order.map((o) => o.label), ['User authentication', 'Feature flags']);
  assert.deepEqual(checkExecutionEligibility(view), { ok: true, problems: [], capabilities: 2 });
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent);

  const phases = [];
  const result = await runRealComposition({ plan, destinationParent: parent, projectName: 'flagged-portal', onPhase: (p) => phases.push(p) });
  const { execution, workspace, candidate, host } = result;
  assert.equal(result.promotable, true, JSON.stringify(execution.error));
  assert.equal(execution.status, 'COMPLETED');
  assert.ok(execution.steps.every((s) => s.status === 'DONE'));
  // One candidate for both capabilities, cut from the created host's initial commit.
  const worktrees = git(host.root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
  assert.equal(worktrees, 2);
  assert.equal(execution.composition.baseRevision, host.initialCommit);
  const transplant = getTransplant(candidate.transplantId);
  assert.deepEqual([transplant.capabilitySlug, transplant.capabilities, transplant.state], ['composition', ['hosted-authentication', 'feature-flags-library'], 'VERIFIED']);
  // The original host baseline: captured before A, with real probes, and used for every check.
  assert.deepEqual(execution.composition.baseline, { captured: true, reason: null, tests: 2 });
  const outcome = (type, n = 0) => execution.steps.filter((s) => s.type === type)[n].outcome;
  assert.deepEqual(outcome('TRANSPLANT_CAPABILITY').filesWritten, ['src/auth/provider.js', 'src/auth/identity.js', 'src/auth/session.js', 'src/auth/routes.js']);
  // A verified before B (13/13), preserved (2/2) — then B's artifact identity, adaptation, verification (10/10).
  const [ca, cb] = execution.composition.capabilities;
  assert.deepEqual([ca.capability, ca.initialVerdict, ca.finalSummary], ['hosted-authentication', 'VERIFIED', { required: 13, passed: 13, failed: 0, inconclusive: 0 }]);
  assert.deepEqual([outcome('CHECK_HOST_PRESERVATION', 0).tests, outcome('CHECK_HOST_PRESERVATION', 0).passed, outcome('CHECK_HOST_PRESERVATION', 0).failed], [2, 2, 0]);
  assert.deepEqual(outcome('VERIFY_SOURCE_ARTIFACT_IDENTITY'), { entry: 'dist/swivel.js', expected: SWIVEL_SHA256.slice(0, 16), actual: SWIVEL_SHA256.slice(0, 16), byteIdentical: true });
  assert.deepEqual(outcome('ADAPT_LIBRARY_CAPABILITY').filesWritten, ['vendor/swivel.cjs', 'vendor/swivel.LICENSE', 'vendor/swivel.provenance.json', 'src/feature-flags.js']);
  assert.deepEqual([cb.capability, cb.initialVerdict, cb.reverifiedVerdict, cb.finalVerdict, cb.finalSummary], ['feature-flags-library', 'VERIFIED', null, 'VERIFIED', { required: 10, passed: 10, failed: 0, inconclusive: 0 }]);
  // A genuinely re-verified after B: 13/13 again, on B's revision, with the observation computed but not written into the committed tree.
  const rv = execution.composition.reverifications[0];
  assert.deepEqual([rv.capability, rv.alongside, rv.verdict, rv.summary.passed, rv.observation?.recorded], ['hosted-authentication', ['feature-flags-library'], 'VERIFIED', 13, false]);
  assert.equal(ca.reverifiedVerdict, 'VERIFIED');
  assert.ok(phases.some((p) => /^Re-running Hosted sign-in .* verification \(12\/12\)$/.test(p)), 'the auth suite ran a second time, to its last case');
  // SAME REVISION: every record, the composition and the candidate's real HEAD agree.
  const R = inspectRepo(candidate.worktreePath).head;
  const [ra, rb] = workspace.capabilities;
  assert.equal(execution.composition.finalRevision, R);
  for (const r of [ra, rb]) { assert.equal(r.destinationRevisionAfter, R); assert.equal(r.currentVerifiedRevision, R); assert.equal(r.destinationRevisionBefore, host.initialCommit); assert.equal(r.verificationVerdict, 'VERIFIED'); assert.equal(r.state, 'CURRENT'); }
  assert.equal(rb.appliedRevision, R); assert.notEqual(ra.appliedRevision, R); assert.equal(git(candidate.worktreePath, ['rev-parse', `${R}^`]), ra.appliedRevision);
  assert.equal(inspectRepo(candidate.worktreePath).dirty, false);
  assert.deepEqual(git(candidate.worktreePath, ['log', '--format=%s']).split('\n').length, 3, 'blank host, then A, then B');
  // Final preservation on R against the pre-A baseline; re-index; detector truth.
  assert.deepEqual([execution.composition.finalPreservation.tests, execution.composition.finalPreservation.failed, execution.composition.finalPreservation.revision], [2, 0, R]);
  assert.equal(execution.reindex.profile, 'esm-node-http-central');
  assert.equal(execution.reindex.detectorObservation['feature-flags-library'], 'NOT_OBSERVED');
  const loaded = evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId));
  assert.deepEqual(loaded.capabilities.map((c) => [c.capability, c.state, c.implementationForm]), [['hosted-authentication', 'CURRENT', 'service'], ['feature-flags-library', 'CURRENT', 'library']]);
  assert.equal(loaded.currentRevision, R);
  const presence = capabilityPresence(loaded, { detected: execution.reindex.observedCapabilities });
  assert.deepEqual(presence.map((p) => [p.capability, p.presence]), [['hosted-authentication', 'PRESENT_BY_ASSEMBLY_EVIDENCE'], ['feature-flags-library', 'PRESENT_BY_ASSEMBLY_EVIDENCE']]);
  assert.equal(presence[1].independentDetection, 'not observed');
  assert.equal(fs.readdirSync(assembliesDir()).length, 1, 'one ledger, written once');
  // The Swivel artifact, provenance and licence inside the candidate.
  assert.equal(sha256(path.join(candidate.worktreePath, 'vendor/swivel.cjs')), SWIVEL_SHA256);
  assert.equal(sha256(path.join(candidate.worktreePath, 'vendor/swivel.cjs')), sha256(path.join(SWIVEL, 'dist/swivel.js')), 'byte-identical to the upstream artifact');
  const provenance = JSON.parse(fs.readFileSync(path.join(candidate.worktreePath, 'vendor/swivel.provenance.json'), 'utf8'));
  assert.equal(provenance.source.revision, SWIVEL_REVISION); assert.equal(provenance.licence.declared, 'MIT'); assert.equal(rb.adaptation.artifactSha256, `sha256:${SWIVEL_SHA256}`);
  assert.match(fs.readFileSync(path.join(candidate.worktreePath, 'vendor/swivel.LICENSE'), 'utf8'), /MIT/);
  // Primary untouched; finalization explicit and eligible.
  assert.equal(inspectRepo(host.root).head, host.initialCommit); assert.equal(inspectRepo(host.root).dirty, false);
  assert.equal(checkPromotion(workspace, { execution }).ok, true);
  assert.equal(loadExecution(execution.executionId).finalSummary.capabilities.length, 2);

  // PROOF INTEGRITY 0.1: each CURRENT record cites its OWN durable, content-addressed proof of a
  // verification AT R. Auth's proof is its re-verification after B; flags' proof is one more
  // verification of the committed final revision (its initial verification preceded its commit).
  const proofs = execution.composition.proofs;
  assert.deepEqual(proofs.map((p) => [p.capability, p.revision, p.envelopeSchema, p.verdict]), [['hosted-authentication', R, 'graft-proof-envelope/1', { graft: 'VERIFIED', kernel: 'PASS' }], ['feature-flags-library', R, 'graft-proof-envelope/1', { graft: 'VERIFIED', kernel: 'PASS' }]]);
  assert.notEqual(ra.proofReference.envelopeDigest, rb.proofReference.envelopeDigest, 'two capabilities, two proofs — no combined proof');
  const storedA = loadProofArtifact(ra.proofReference.envelopeDigest), storedB = loadProofArtifact(rb.proofReference.envelopeDigest);
  for (const [record, stored, slug] of [[ra, storedA, 'hosted-authentication'], [rb, storedB, 'feature-flags-library']]) {
    assert.equal(record.proofReference.envelopeSchema, 'graft-proof-envelope/1'); assert.match(record.proofReference.envelopeDigest, /^[0-9a-f]{64}$/);
    assert.equal(stored.intact, true, `${slug}: stored proof reloads intact`); assert.deepEqual(verifyProofEnvelope(stored.envelope), { intact: true, reasons: [] });
    assert.equal(stored.envelope.payload.destination.revision, R, `${slug}: the proof binds R`);
    assert.equal(stored.envelope.payload.destination.hostProfile, 'esm-node-http-central');
    assert.equal(stored.envelope.payload.capability.slug, slug); assert.equal(stored.envelope.payload.capability.id, record.capabilityId, `${slug}: the same capability id the ledger carries`);
    assert.equal(stored.envelope.payload.capability.genomeId, record.genomeId); assert.equal(stored.envelope.payload.capability.irId, record.irId);
    assert.deepEqual(stored.envelope.payload.verdict, { graft: 'VERIFIED', kernel: 'PASS' });
    const text = fs.readFileSync(proofArtifactPath(record.proofReference.envelopeDigest), 'utf8');
    assert.doesNotMatch(text, /AUTH_CLIENT_SECRET|graft-verification-not-a-secret|Bearer |sk-[A-Za-z0-9_-]{16,}/); assert.equal(text.includes(candidate.worktreePath), false); assert.equal(text.includes(os.homedir()), false);
  }
  assert.equal(storedB.envelope.payload.source.revision, SWIVEL_REVISION, 'flags: the donor checkout revision the manifest recorded at source verification is bound');
  assert.equal(rb.sourceRevision, SWIVEL_REVISION, 'and the ledger carries the same source revision');
  assert.deepEqual(storedB.envelope.payload.destination.adaptation, { id: rb.adaptation.id, artifactSha256: `sha256:${SWIVEL_SHA256}` });
  assert.equal(storedA.envelope.payload.source.revision, ra.sourceRevision, 'auth: bound iff the manifest recorded a clean source head (null otherwise)');
  assert.equal(storedA.envelope.payload.cases.length, 13); assert.equal(storedB.envelope.payload.cases.length, 10);
  assert.deepEqual(proofs.map((p) => [p.capability, p.provenBy, p.verification.verdict, p.verification.summary.passed]), [['hosted-authentication', 're-verification-after-later-capabilities', 'VERIFIED', 13], ['feature-flags-library', 'verification-of-committed-revision', 'VERIFIED', 10]]);
  assert.equal(execution.composition.reverifications.length, 1, 'the proof verification of flags is not a re-verification alongside later capabilities');
  assert.deepEqual(rb.verificationHistory.map((h) => h.event), ['applied-and-verified', 'proven-at-revision']);

  // COMPATIBILITY ATLAS: one real attempt, ONE observation per capability (not one per verification:
  // auth was verified three times here — initially, after B, and none for the proof; flags twice),
  // each bound to the evidence the ledger cites — the same proof digest, the same revisions.
  const atlas = loadAtlas();
  assert.equal(atlas.length, 2, 'one attempt, one observation per capability');
  const ea = atlas.find((e) => e.capabilityId === ra.capabilityId), eb = atlas.find((e) => e.capabilityId === rb.capabilityId);
  assert.deepEqual(execution.atlas.entries.map((e) => e.entryId).sort(), atlas.map((e) => e.entryId).sort(), 'the execution names the knowledge it produced');
  assert.deepEqual(execution.atlas.errors, []); assert.deepEqual(execution.atlas.skipped, []);
  for (const [entry, record, slug] of [[ea, ra, 'hosted-authentication'], [eb, rb, 'feature-flags-library']]) {
    assert.equal(entry.atlasVersion, '1.1.0');
    assert.equal(entry.proofEnvelopeDigest, record.proofReference.envelopeDigest, `${slug}: the Atlas cites the ledger's proof by the same digest`);
    assert.equal(entry.destinationRevision, R, `${slug}: bound to the final revision`);
    assert.equal(entry.sourceRevision, record.sourceRevision, `${slug}: the same source revision the ledger carries`);
    assert.deepEqual(entry.verification.verdict, 'VERIFIED'); assert.deepEqual(entry.failureReasons, []);
    assert.deepEqual(entry.assembly, { finalState: 'COMPLETED', failedStep: null, errorCode: null });
    assert.equal(entry.hostId, execution.reindex.hostId);
    assert.ok(Array.isArray(entry.assumptions) && entry.assumptions.length > 0 && entry.assumptions.every((a) => ['ok', 'warn'].includes(a.status)), `${slug}: the plan's pre-transplant checks are recorded`);
    assert.equal(entry.result, entry.assumptions.some((a) => a.status === 'warn') ? 'conditionally-supported' : 'supported', `${slug}: the result follows the recorded assumptions`);
  }
  assert.equal(eb.sourceRevision, SWIVEL_REVISION); assert.equal(eb.capabilityKind, 'feature-flags');
  assert.ok(eb.adaptations.includes(rb.adaptation.id), 'the library adaptation is the recorded adaptation');
  assert.ok(eb.assumptions.some((a) => a.id === 'artifact-identity-recorded'));
  assert.ok(ea.adaptations.includes('esm-node-http-central') && ea.adaptations.includes('registration:central-handler') && ea.adaptations.includes('verification:provider-double/endpoint-configuration'));
  assert.ok(ea.assumptions.some((a) => a.id === 'source.verification'));
  const atlasText = JSON.stringify(atlas);
  for (const forbidden of [candidate.worktreePath, host.root, os.homedir(), 'zumba', 'swiveljs', 'flagged-portal', 'leftsock']) assert.equal(atlasText.includes(forbidden), false, `the Atlas must not carry ${forbidden}`);

  // REAL COEXISTENCE in the candidate, independently of the verifier: host, auth, flags.
  await independentRun(candidate.worktreePath, auth, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200); assert.equal((await fetch(`${base}/health`)).status, 200); assert.equal((await fetch(`${base}/no-such-route`)).status, 404);
    assert.equal((await fetch(`${base}/api/session`)).status, 401, 'anonymous session is rejected by the hosted auth');
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    assert.ok([302, 303].includes(login.status) && /authorize|oauth|\/auth/.test(login.headers.get('location') || ''), `login redirects to the provider (${login.status} ${login.headers.get('location')})`);
  });
  assert.deepEqual(flagsProbe(candidate.worktreePath), EXPECTED_FLAGS);

  // FINALIZATION: explicit, fast-forward only, no remote; then the finalized application on its own.
  const promoted = promoteAssembly(loadAssemblyWorkspace(workspace.assemblyWorkspaceId), { execution });
  saveAssemblyWorkspace(promoted.workspace);
  assert.deepEqual([promoted.promotion.kind, promoted.promotion.forced, promoted.promotion.remotesContacted, promoted.promotion.fromRevision, promoted.promotion.toRevision], ['fast-forward', false, [], host.initialCommit, R]);
  assert.equal(inspectRepo(host.root).head, R); assert.equal(inspectRepo(host.root).branch, 'main'); assert.equal(git(host.root, ['remote']), '');
  assert.equal(evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId)).status, 'FINALIZED');
  await independentRun(host.root, auth, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200); assert.equal((await fetch(`${base}/health`)).status, 200); assert.equal((await fetch(`${base}/nowhere`)).status, 404);
    assert.equal((await fetch(`${base}/api/session`)).status, 401);
    assert.ok([302, 303].includes((await fetch(`${base}/auth/login`, { redirect: 'manual' })).status));
  });
  assert.deepEqual(flagsProbe(host.root), EXPECTED_FLAGS);
  assert.equal(sha256(path.join(host.root, 'vendor/swivel.cjs')), SWIVEL_SHA256);

  // Donors: exactly as they were.
  assert.deepEqual(donorState(), donorsBefore);
  assert.equal(donorsBefore.swivel.head, SWIVEL_REVISION); assert.equal(donorsBefore.swivel.dirty, ''); assert.equal(donorsBefore.swivel.graftBranches, '');
  if (donorsBefore.cuf) { assert.equal(donorsBefore.cuf.dirty, ''); assert.equal(donorsBefore.cuf.graftBranches, ''); }
  // PORTABILITY (Checkpoint C): both CURRENT proofs leave as exact copies of the stored artifacts.
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-portable-comp-'));
  t.after(() => fs.rmSync(exportDir, { recursive: true, force: true }));
  const exportedProofs = exportAssemblyProofs(loadAssemblyWorkspace(workspace.assemblyWorkspaceId), exportDir);
  assert.deepEqual(exportedProofs.map((p) => [p.capability, p.revision, p.digest]), [['hosted-authentication', R, ra.proofReference.envelopeDigest], ['feature-flags-library', R, rb.proofReference.envelopeDigest]]);
  for (const p of exportedProofs) assert.equal(Buffer.compare(fs.readFileSync(p.file), fs.readFileSync(proofArtifactPath(p.digest))), 0, `${p.capability}: byte-identical copy`);

  // REVISION DRIFT after finalization: R → R+1 with no Laboratory step. Both records go STALE by
  // the existing continuity rule; both proof artifacts stay intact and still describe R.
  fs.writeFileSync(path.join(host.root, 'later.js'), 'export const later = true;\n');
  git(host.root, ['add', '-A']); git(host.root, ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a later change']);
  const R1 = inspectRepo(host.root).head; assert.notEqual(R1, R);
  const drifted = evaluateWorkspace(loadAssemblyWorkspace(workspace.assemblyWorkspaceId));
  assert.deepEqual(drifted.capabilities.map((c) => c.state), ['STALE', 'STALE']);
  for (const record of drifted.capabilities) {
    const stored = loadProofArtifact(record.proofReference.envelopeDigest);
    assert.equal(stored.intact, true); assert.equal(stored.envelope.payload.destination.revision, R, `${record.capability}: the R proof is untouched by drift to ${R1.slice(0, 12)}`);
    assert.deepEqual(proofIntegrity(record), { status: 'INTACT', digest: record.proofReference.envelopeDigest, reasons: [] }, `${record.capability}: STALE record, INTACT proof — two different facts`);
  }
  // The exported copies verify on their own after drift, with GRAFT_HOME unavailable: still intact, still claiming R.
  const homeBefore = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(exportDir, 'no-such-home');
  try {
    for (const p of exportedProofs) {
      const v = verifyProofFile(p.file);
      assert.equal(v.intact, true, `${p.capability}: ${v.reasons.join('; ')}`); assert.equal(v.claim.destinationRevision, R); assert.equal(v.claim.capability.slug, p.capability); assert.equal(v.claim.graftVerdict, 'VERIFIED');
    }
    assert.notEqual(exportedProofs[0].digest, exportedProofs[1].digest);
  } finally { process.env.GRAFT_HOME = homeBefore; }
  t.diagnostic(`R=${R} auth applied at ${ra.appliedRevision.slice(0, 12)}, both CURRENT at ${R.slice(0, 12)}; proofs ${ra.proofReference.envelopeDigest.slice(0, 12)} / ${rb.proofReference.envelopeDigest.slice(0, 12)}; finalized ${host.root}; drifted to ${R1.slice(0, 12)} → STALE`);
});

/** Rewrite one file in the candidate; reports whether anything changed, so a mutation that missed is never a silent pass. */
const rewrite = (file, edit) => { const before = fs.readFileSync(file, 'utf8'); const after = edit(before); fs.writeFileSync(file, after); return after !== before; };
/** The real operations, with one candidate-only mutation applied right after a named capability's real apply. */
function mutatedRun({ plan, parent, after, mutate }) {
  const ops = realCompositionOps({ plan, destinationParent: parent, projectName: 'flagged-portal' });
  const applyCapability = ops.applyCapability;
  ops.applyCapability = async (args) => { const r = await applyCapability(args); if (args.capability.slug === after) { const changed = mutate(args.candidate.worktreePath); assert.equal(changed, true, `the candidate-only mutation after ${after} must actually change a file`); } return r; };
  const execution = createExecution(plan, { destinationParent: parent, projectName: 'flagged-portal' });
  return executeCompositionPlan(execution, plan, { ...ops, persistExecution: saveExecution }).then((result) => { recordAssemblyOutcomes({ execution: result.execution, plan, organ: ops.organ }); return { ...result, transplant: ops.conclude({ execution: result.execution, promotable: result.promotable }), candidate: ops.state.candidate, host: ops.state.host }; });
}

test('REAL COUNTERFACTUAL: the SwivelJS adaptation is broken in the candidate only → feature flags not VERIFIED, composition NOT promotable, nothing CURRENT, primary unchanged, candidate discarded safely', needReal, async (t) => {
  const work = sandbox(t);
  const donorsBefore = donorState();
  await bankBoth();
  const { plan } = realPlan();
  const parent = path.join(work, 'apps'); fs.mkdirSync(parent);
  // The generated adapter is inverted after the real adaptation wrote it: `isEnabled` now answers
  // the opposite. The vendored artifact, provenance and licence are untouched, and so is upstream.
  const r = await mutatedRun({ plan, parent, after: 'feature-flags-library', mutate: (root) => rewrite(path.join(root, 'src/feature-flags.js'), (s) => s.replace('return this.#library.returnValue(featureName, true, false) === true;', 'return this.#library.returnValue(featureName, true, false) !== true;')) });
  assert.equal(r.promotable, false); assert.equal(r.workspace, null);
  assert.equal(r.execution.status, 'FAILED'); assert.equal(r.execution.composition.finalState, 'NOT_PROMOTABLE');
  const [ca, cb] = r.execution.composition.capabilities;
  assert.deepEqual([ca.initialVerdict, ca.reverifiedVerdict], ['VERIFIED', null], 'A verified before B; the composition stopped before re-verifying it');
  assert.equal(cb.finalVerdict, 'FAILED'); assert.ok(cb.finalSummary.failed > 0);
  assert.match(r.execution.error.message, /feature-flags-library reported FAILED/);
  assert.deepEqual(r.execution.steps.map((s) => `${s.type}:${s.status}`).slice(-5), ['VERIFY_CAPABILITY:FAILED', 'REVERIFY_CAPABILITY:SKIPPED', 'CHECK_HOST_PRESERVATION:SKIPPED', 'REINDEX_HOST:SKIPPED', 'FINAL_VERIFICATION:SKIPPED']);
  assert.equal(r.execution.composition.finalRevision, null);
  assert.equal(fs.existsSync(assembliesDir()) ? fs.readdirSync(assembliesDir()).length : 0, 0, 'no ledger record of any kind');
  // The failure is compatibility evidence and does not disappear: one Atlas observation per
  // capability, each honest about what it was — A verified on its own, B failed its contract,
  // the attempt FAILED at VERIFY_CAPABILITY, no revision and no proof for either.
  const failedAtlas = loadAtlas();
  assert.equal(failedAtlas.length, 2);
  const fa = failedAtlas.find((e) => e.capabilityId === ca.capabilityId), fb = failedAtlas.find((e) => e.capabilityId === cb.capabilityId);
  assert.deepEqual([fa.verification.verdict, fa.failureReasons, fa.destinationRevision, fa.proofEnvelopeDigest], ['VERIFIED', [], null, null]);
  assert.equal(fb.verification.verdict, 'FAILED'); assert.ok(fb.failureReasons.length > 0 && fb.failureReasons.every((r) => /:failed$/.test(r)), JSON.stringify(fb.failureReasons));
  assert.deepEqual(fb.destinationRevision, null); assert.deepEqual(fb.proofEnvelopeDigest, null);
  for (const e of [fa, fb]) assert.deepEqual(e.assembly, { finalState: 'FAILED', failedStep: 'VERIFY_CAPABILITY', errorCode: 'verdict' });
  assert.equal(r.execution.atlas.entries.length, 2);
  assert.equal(inspectRepo(r.host.root).head, r.host.initialCommit); assert.equal(inspectRepo(r.host.root).dirty, false);
  assert.equal(r.transplant.state, 'FAILED');
  assert.equal(sha256(path.join(r.candidate.worktreePath, 'vendor/swivel.cjs')), SWIVEL_SHA256, 'the artifact itself was never touched');
  // Discard the failed candidate through the existing safe path: the primary keeps its one commit.
  const cleaned = cleanupTransplant(r.candidate.transplantId, { confirmDiscard: true });
  assert.equal(cleaned.state, 'CLEANED'); assert.equal(fs.existsSync(r.candidate.worktreePath), false);
  assert.equal(git(r.host.root, ['branch', '--list', 'graft/*']), ''); assert.equal(inspectRepo(r.host.root).head, r.host.initialCommit);
  assert.deepEqual(donorState(), donorsBefore);

  // OPTIONAL SECOND COUNTERFACTUAL (cheap: one more run): with B present, A is broken in the
  // candidate → A fails its re-verification while B stays VERIFIED; still NOT promotable.
  const r2 = await mutatedRun({ plan, parent: (fs.mkdirSync(path.join(work, 'apps2')), path.join(work, 'apps2')), after: 'feature-flags-library', mutate: (root) => rewrite(path.join(root, 'src/auth/session.js'), (s) => s.replace("json(res, 401, { error: 'unauthenticated' })", "json(res, 200, { error: 'unauthenticated' })")) });
  assert.equal(r2.promotable, false); assert.equal(r2.execution.status, 'FAILED');
  const [a2, b2] = r2.execution.composition.capabilities;
  assert.deepEqual([a2.initialVerdict, a2.reverifiedVerdict, a2.finalVerdict], ['VERIFIED', 'FAILED', 'FAILED']);
  assert.deepEqual([b2.initialVerdict, b2.finalVerdict], ['VERIFIED', 'VERIFIED'], 'B still verifies on its own; that does not rescue the composition');
  // Atlas: the second attempt adds two more observations; A's records the interaction failure
  // (FAILED on re-verification, its own failed cases), B's stays VERIFIED — and neither is promoted.
  const secondAtlas = loadAtlas();
  assert.equal(secondAtlas.length, 4);
  const fa2 = secondAtlas.filter((e) => e.capabilityId === a2.capabilityId).find((e) => e.verification?.verdict === 'FAILED');
  assert.ok(fa2 && fa2.failureReasons.length > 0 && fa2.assembly.failedStep === 'REVERIFY_CAPABILITY' && fa2.destinationRevision === null, JSON.stringify(fa2));
  assert.match(r2.execution.error.message, /hosted-authentication reported FAILED on the combined application after feature-flags-library/);
  assert.equal(fs.existsSync(assembliesDir()) ? fs.readdirSync(assembliesDir()).length : 0, 0);
  assert.equal(inspectRepo(r2.host.root).head, r2.host.initialCommit);
  cleanupTransplant(r2.candidate.transplantId, { confirmDiscard: true });
  assert.deepEqual(donorState(), donorsBefore);
});
