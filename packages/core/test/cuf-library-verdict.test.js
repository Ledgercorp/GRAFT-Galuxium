// CUF Kernel Integration 0.1 — Checkpoint B: for library verification GRAFT executes the driver and
// supplies the declared expectations plus raw observations; the proof kernel decides each case,
// aggregates, normalises the evidence and produces the proof root; GRAFT maps the result onto
// VERIFIED / FAILED / NEEDS_REVIEW. The real SwivelJS artifact is the oracle. The legacy driver
// decision is reproduced here ONLY to check agreement over the real corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { runLibrarySuite, decideLibraryVerdict } from '../src/verify/library-runner.js';
import { decideVerdict } from '../src/verify/index.js';

const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const haveSwivel = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js'));
const needSwivel = { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' };
const HEX = /^[0-9a-f]{64}$/;
/** What the driver decided before Checkpoint B, from the same raw observations — the historical oracle. */
function legacy(test, observations, operationalError) {
  const seen = [];
  for (const s of test.steps) {
    const o = observations.find((x) => x.step === s.name); if (!o) return 'inconclusive'; seen.push(o);
    const e = s.expect || {};
    if ('equals' in e && o.returned !== e.equals) return 'failed';
    if ('branch' in e && o.branch !== e.branch) return 'failed';
    if ('sameAs' in e) { const earlier = seen.find((x) => x.step === e.sameAs); if (!earlier || JSON.stringify(earlier.returned) !== JSON.stringify(o.returned) || earlier.branch !== o.branch) return 'failed'; }
  }
  return operationalError ? 'inconclusive' : 'passed';
}
const agree = (report, tests) => { for (const r of report.results) { const t = tests.find((x) => x.id === r.id); assert.equal(r.outcome, legacy(t, r.observations, r.detail && /Operational error/.test(r.detail) ? r.detail : null), `${r.id}: kernel said ${r.outcome} (${r.detail}), the legacy decision differs`); } };

test('the real SwivelJS source suite: VERIFIED 8/8 as before; every case PASS is the kernel\'s; the proof root is deterministic', needSwivel, async () => {
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  const tests = manifest.acceptanceTests.tests;
  const suite = () => runLibrarySuite({ sourceRoot: SWIVEL, artifact: manifest.architecture.capabilityModel.artifact, tests, behavior: manifest.behavior.statements });
  const report = await suite();
  assert.equal(report.verdict, 'VERIFIED');
  assert.deepEqual(report.summary, { required: 8, passed: 8, failed: 0, inconclusive: 0 });
  assert.equal(report.rationale, 'All 8 required acceptance test(s) passed against the library artifact dist/swivel.js.');
  assert.match(report.proofRoot, HEX);
  assert.deepEqual(report.proofAuthority, { perCase: 'cuf-kernel', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel', execution: 'graft-library-driver', contract: 'graft-capability-contract', cufVerdict: 'PASS', cases: 8, evidenceItems: report.proofAuthority.evidenceItems });
  assert.ok(report.proofAuthority.evidenceItems >= 16, 'an INVOCATION and a RESULT per observed step');
  assert.ok(report.results.every((r) => r.outcome === 'passed' && r.detail === 'Every declared expectation was satisfied by the observed values'), 'each case carries the kernel\'s reason');
  agree(report, tests);
  assert.equal(decideVerdict(report.results, { serverReady: true, subject: 'the library artifact dist/swivel.js' }).verdict, 'VERIFIED');
  assert.equal((await suite()).proofRoot, report.proofRoot);
});

test('a semantically broken artifact copy: the kernel FAILs the contradicted cases, the suite is FAILED, the proof root differs; a missing artifact is NEEDS_REVIEW (kernel INCONCLUSIVE)', needSwivel, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-cuf-lib-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  const artifact = manifest.architecture.capabilityModel.artifact;
  const tests = manifest.acceptanceTests.tests;
  const good = await runLibrarySuite({ sourceRoot: SWIVEL, artifact, tests });
  const broken = path.join(work, 'broken'); fs.mkdirSync(path.join(broken, 'dist'), { recursive: true });
  const original = fs.readFileSync(path.join(SWIVEL, artifact.entry), 'utf8');
  const seam = '.addValue(parts.join(DELIMITER), a)\n            .defaultValue(b)';
  assert.ok(original.includes(seam));
  fs.writeFileSync(path.join(broken, artifact.entry), original.replace(seam, '.addValue(parts.join(DELIMITER), b)\n            .defaultValue(a)'));
  const bad = await runLibrarySuite({ sourceRoot: broken, artifact, tests });
  assert.equal(bad.verdict, 'FAILED');
  assert.equal(bad.proofAuthority.cufVerdict, 'FAIL');
  assert.ok(bad.summary.failed > 0);
  const failing = bad.results.filter((r) => r.outcome === 'failed');
  assert.ok(failing.every((r) => /produced .* expected /.test(r.detail)), 'a failing case carries the kernel\'s contradiction, e.g. ' + failing[0].detail);
  agree(bad, tests);
  assert.match(bad.rationale, /required acceptance test\(s\) failed/);
  assert.notEqual(bad.proofRoot, good.proofRoot);
  assert.equal(decideVerdict(bad.results, { serverReady: true }).verdict, 'FAILED');
  const missing = await runLibrarySuite({ sourceRoot: work, artifact, tests });
  assert.equal(missing.verdict, 'NEEDS_REVIEW');
  assert.equal(missing.proofAuthority.cufVerdict, 'INCONCLUSIVE');
  assert.ok(missing.results.every((r) => r.outcome === 'inconclusive'));
  assert.match(missing.rationale, /could not be exercised, so no behavior could be observed \(the declared artifact dist\/swivel\.js is not present\)/);
  assert.equal(fs.readFileSync(path.join(SWIVEL, artifact.entry), 'utf8'), original, 'the checkout was not written');
});

test('an interrupted execution and a malformed observation are NEEDS_REVIEW; a failure to decide is NEEDS_REVIEW with no proof root — never a native verdict', () => {
  const artifact = { entry: 'dist/x.js' };
  const tests = [{ id: 'a', required: true, steps: [{ name: 'on', call: 'isEnabled', args: ['x'], expect: { equals: true } }, { name: 'b', call: 'branch', args: [], expect: { branch: 'enabled' } }] }];
  const interrupted = decideLibraryVerdict(tests, [{ id: 'a', observations: [{ step: 'on', call: 'isEnabled', args: ['x'], returned: true, branch: null }], operationalError: 'the capability exposes no branch() operation' }], { loaded: true, artifact });
  assert.equal(interrupted.verdict, 'NEEDS_REVIEW');
  assert.equal(interrupted.results[0].outcome, 'inconclusive');
  assert.match(interrupted.results[0].detail, /Operational error before b was observed: the capability exposes no branch\(\) operation/);
  assert.equal(interrupted.rationale, '1 required acceptance test(s) produced no usable evidence: a.');
  const malformed = decideLibraryVerdict(tests, [{ id: 'a', observations: 'nonsense', operationalError: null }], { loaded: true, artifact });
  assert.equal(malformed.verdict, 'NEEDS_REVIEW');
  const undecidable = decideLibraryVerdict(tests, [{ id: 'a', observations: [{ step: 'on', call: 'isEnabled', args: ['sbp_' + 'a'.repeat(40)], returned: true, branch: null }], operationalError: null }], { loaded: true, artifact });
  assert.equal(undecidable.verdict, 'NEEDS_REVIEW');
  assert.equal(undecidable.proofRoot, null);
  assert.match(undecidable.rationale, /The proof could not be decided, so no verdict could be established \(Credential material detected/);
  assert.equal(undecidable.proofAuthority.perCase, 'proof-kernel');
});
