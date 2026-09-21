// The adapter alone: contract expectations + raw observations in, the kernel's case verdicts,
// aggregate verdict and proof root out. No runner, no server. The legacy per-case decision that
// the driver used to make is kept here ONLY as an oracle for the differential check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLibrarySuite, evaluateLibraryCase, toObservationCase, toObservationRun, expectationsFor, VERDICT_MAP, CASE_OUTCOME_MAP } from '../src/index.js';
import { decideVerdict } from '../../core/src/verify/index.js';

const step = (name, call, args, expect) => ({ name, call, args, expect });
const obs = (step, returned, branch = null) => ({ step, call: 'op', args: [], returned, branch });
const T = (id, steps, required = true) => ({ id, required, steps });
/** The decision the library driver made before Checkpoint B — the historical oracle, never authority. */
function legacy(test, run) {
  if (run.operationalError !== null && run.observations.length < test.steps.length) return 'inconclusive';
  const seen = [];
  for (const s of test.steps) {
    const o = run.observations.find((x) => x.step === s.name); if (!o) return 'inconclusive'; seen.push(o);
    const e = s.expect || {};
    if ('equals' in e && o.returned !== e.equals) return 'failed';
    if ('branch' in e && o.branch !== e.branch) return 'failed';
    if ('sameAs' in e) { const earlier = seen.find((x) => x.step === e.sameAs); if (!earlier || JSON.stringify(earlier.returned) !== JSON.stringify(o.returned) || earlier.branch !== o.branch) return 'failed'; }
  }
  return run.operationalError !== null ? 'inconclusive' : 'passed';
}

test('contract steps become kernel expectations in the order they were always checked; observations become kernel observations with INVOCATION/RESULT evidence', () => {
  assert.deepEqual(expectationsFor(step('on', 'isEnabled', ['x'], { equals: true })), [{ kind: 'value', observation: 'on', equals: true }]);
  assert.deepEqual(expectationsFor(step('b', 'branch', [], { branch: 'enabled' })), [{ kind: 'selection', observation: 'b', equals: 'enabled' }]);
  assert.deepEqual(expectationsFor(step('again', 'isEnabled', ['x'], { sameAs: 'on' })), [{ kind: 'consistent', observation: 'again', with: 'on' }]);
  const c = toObservationCase(T('t', [step('on', 'isEnabled', ['x'], { equals: true })]));
  assert.deepEqual([...c.requiredEvidenceKinds], ['INVOCATION', 'RESULT']);
  const r = toObservationRun({ observations: [obs('on', true)], operationalError: null });
  assert.deepEqual([...r.observations], [{ id: 'on', value: true, selected: null }]);
  assert.deepEqual(r.evidence.map((e) => e.kind), ['INVOCATION', 'RESULT']);
  assert.ok(r.evidence.every((e) => e.redacted && !('outcome' in e.metadata) && !('verdict' in e.metadata)));
  assert.equal(toObservationRun({ observations: [obs('o', { deep: [1] })], operationalError: null }).observations[0].value, 'json:{"deep":[1]}', 'structured values are canonical JSON, marked');
});

test('the kernel decides each case: satisfied PASS, contradicted FAIL, interrupted / unavailable INCONCLUSIVE; the mapping admits no route to VERIFIED but PASS', () => {
  const t = T('t', [step('on', 'isEnabled', ['x'], { equals: true }), step('b', 'branch', [], { branch: 'enabled' })]);
  assert.equal(evaluateLibraryCase(t, { observations: [obs('on', true), obs('b', null, 'enabled')], operationalError: null }).verdict, 'PASS');
  assert.equal(evaluateLibraryCase(t, { observations: [obs('on', false), obs('b', null, 'enabled')], operationalError: null }).verdict, 'FAIL');
  assert.equal(evaluateLibraryCase(t, { observations: [obs('on', true), obs('b', null, 'disabled')], operationalError: null }).verdict, 'FAIL');
  assert.equal(evaluateLibraryCase(t, { observations: [obs('on', true)], operationalError: 'the capability exposes no branch() operation' }).verdict, 'INCONCLUSIVE');
  assert.equal(evaluateLibraryCase(t, { observations: [], operationalError: null }).verdict, 'INCONCLUSIVE');
  assert.deepEqual(VERDICT_MAP, { PASS: 'VERIFIED', FAIL: 'FAILED', INCONCLUSIVE: 'NEEDS_REVIEW' });
  assert.deepEqual(CASE_OUTCOME_MAP, { PASS: 'passed', FAIL: 'failed', INCONCLUSIVE: 'inconclusive' });
});

test('differential: on a synthetic corpus the kernel agrees with the legacy driver decision case by case, and the suite verdict agrees with the native engine', () => {
  const tests = [
    T('equal', [step('a', 'get', [], { equals: 1 })]), T('branch', [step('b', 'pick', [], { branch: 'left' })]),
    T('repeat', [step('first', 'get', [], { equals: 'x' }), step('second', 'get', [], { sameAs: 'first' })]), T('optional', [step('o', 'get', [], { equals: 0 })], false),
  ];
  const corpus = [
    { equal: { observations: [obs('a', 1)], operationalError: null }, branch: { observations: [obs('b', null, 'left')], operationalError: null }, repeat: { observations: [obs('first', 'x'), obs('second', 'x')], operationalError: null }, optional: { observations: [obs('o', 0)], operationalError: null } },
    { equal: { observations: [obs('a', 2)], operationalError: null }, branch: { observations: [obs('b', null, 'left')], operationalError: null }, repeat: { observations: [obs('first', 'x'), obs('second', 'x')], operationalError: null }, optional: { observations: [obs('o', 0)], operationalError: null } },
    { equal: { observations: [obs('a', 1)], operationalError: null }, branch: { observations: [obs('b', null, 'right')], operationalError: null }, repeat: { observations: [obs('first', 'x'), obs('second', 'y')], operationalError: null }, optional: { observations: [obs('o', 9)], operationalError: null } },
    { equal: { observations: [], operationalError: 'threw' }, branch: { observations: [obs('b', null, 'left')], operationalError: null }, repeat: { observations: [obs('first', 'x')], operationalError: 'threw' }, optional: { observations: [obs('o', 0)], operationalError: null } },
    { equal: { observations: [obs('a', 1)], operationalError: null }, branch: { observations: [obs('b', null, null)], operationalError: null }, repeat: { observations: [obs('first', 'x'), obs('second', 'x')], operationalError: null }, optional: { observations: [], operationalError: 'threw' } },
  ];
  for (const runs of corpus) {
    const list = tests.map((t) => ({ id: t.id, ...runs[t.id] }));
    const proof = decideLibrarySuite({ tests, runs: list });
    for (const c of proof.cases) assert.equal(c.outcome, legacy(tests.find((t) => t.id === c.id), runs[c.id]), `case ${c.id}: kernel ${c.verdict} vs legacy`);
    const native = decideVerdict(proof.cases.map((c) => ({ id: c.id, required: tests.find((t) => t.id === c.id).required, outcome: c.outcome }))).verdict;
    assert.equal(proof.verdict, native);
  }
});

test('the proof root derives from the evidence the kernel decided on: deterministic, order-independent, fact-sensitive; not-loaded is INCONCLUSIVE; bad input is refused', () => {
  const tests = [T('a', [step('s', 'get', [], { equals: 1 })]), T('b', [step('s', 'get', [], { equals: 2 })])];
  const runs = [{ id: 'a', observations: [obs('s', 1)], operationalError: null }, { id: 'b', observations: [obs('s', 2)], operationalError: null }];
  const one = decideLibrarySuite({ tests, runs });
  assert.match(one.proofRoot, /^[0-9a-f]{64}$/);
  assert.equal(one.proofRoot, decideLibrarySuite({ tests: [tests[1], tests[0]], runs: [runs[1], runs[0]], capturedAt: '2031-01-01T00:00:00.000Z' }).proofRoot);
  assert.notEqual(one.proofRoot, decideLibrarySuite({ tests, runs: [runs[0], { id: 'b', observations: [obs('s', 3)], operationalError: null }] }).proofRoot);
  assert.equal(decideLibrarySuite({ tests, runs, loaded: false }).verdict, 'NEEDS_REVIEW');
  assert.equal(decideLibrarySuite({ tests, runs, loaded: false }).cufVerdict, 'INCONCLUSIVE');
  assert.equal(decideLibrarySuite({ tests: [], runs: [] }).verdict, 'NEEDS_REVIEW');
  assert.deepEqual(one.authority, { perCase: 'cuf-kernel', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel', execution: 'graft-library-driver', contract: 'graft-capability-contract' });
  assert.throws(() => decideLibrarySuite({ tests: null, runs }), (e) => e.code === 'adapter-input');
  assert.throws(() => decideLibrarySuite({ tests, runs: [{ id: 'a', observations: [{ step: 's', call: 'get', args: ['sbp_' + 'a'.repeat(40)], returned: 1 }], operationalError: null }] }), /Credential material/);
});

// ---------------------------------------------------------------------------------------------
// The HTTP family: GRAFT's per-case outcomes in, the kernel's aggregate and proof root out.
// ---------------------------------------------------------------------------------------------
import { decideHttpSuite, httpEvidenceFor, toHttpCase } from '../src/index.js';
const http = (id, outcome, { required = true, steps = [{ name: 'login', request: 'GET /auth/login', status: 302, checks: [{ name: 'status', ok: outcome !== 'failed' }], ok: outcome !== 'failed' }], reason = null } = {}) => ({ id, required, outcome, reason, steps });

test('HTTP differential matrix: the kernel\'s aggregate mapped back agrees with native decideVerdict, including a server that never became ready', () => {
  const matrix = [
    [[http('a', 'passed'), http('b', 'passed')], true], [[http('a', 'passed'), http('b', 'failed')], true], [[http('a', 'failed'), http('b', 'inconclusive')], true],
    [[http('a', 'passed'), http('b', 'inconclusive')], true], [[http('a', 'inconclusive'), http('b', 'inconclusive')], true], [[], true], [[http('a', 'passed')], false],
    [[http('a', 'passed', { required: false })], true], [[http('a', 'passed'), http('b', 'failed', { required: false })], true],
  ];
  for (const [results, serverReady] of matrix) {
    const native = decideVerdict(results, { serverReady, reason: 'x' }).verdict;
    const proof = decideHttpSuite({ results, serverReady });
    assert.equal(proof.verdict, native, `${JSON.stringify(results.map((r) => [r.id, r.outcome, r.required]))} ready=${serverReady}`);
  }
  assert.equal(decideHttpSuite({ results: [http('a', 'passed'), http('b', 'inconclusive', { reason: 'transport error on step "callback": timeout' })] }).cufVerdict, 'INCONCLUSIVE', 'a retry that ended without an authoritative observation stays uncertain');
  assert.deepEqual(decideHttpSuite({ results: [http('a', 'passed')] }).authority, { perCase: 'graft-http-runner', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel', execution: 'graft-http-runner', providerDouble: 'graft-http-runner', retries: 'graft-http-runner' });
});

test('HTTP evidence is honest: REQUEST/RESPONSE only for real exchanges, INVOCATION for a restart, STATE_AFTER for the output witness; facts only, no values that could carry a secret', () => {
  const r = http('t', 'passed', { steps: [
    { name: 'login', request: 'GET /auth/login', status: 302, checks: [{ name: 'status', ok: true, detail: 'location http://127.0.0.1:54321/authorize?state=abc' }], ok: true },
    { name: 'again', request: 'restart', status: null, checks: [{ name: 'restart', ok: true }], ok: true },
    { name: 'process-output', request: 'stdout+stderr', status: null, checks: [{ name: 'noSecretsInProcessOutput', ok: true }], ok: true },
  ] });
  const items = httpEvidenceFor(r);
  assert.deepEqual(items.map((i) => i.kind), ['REQUEST', 'RESPONSE', 'INVOCATION', 'STATE_AFTER']);
  assert.deepEqual(items[0].metadata, { test: 't', step: 'login', request: 'GET /auth/login' });
  assert.deepEqual(items[1].metadata, { test: 't', step: 'login', status: 302, checks: '[{"name":"status","ok":true}]' });
  assert.ok(!JSON.stringify(items).includes('54321') && !JSON.stringify(items).includes('state=abc'), 'check details (ports, state values) never enter the evidence');
  assert.ok(items.every((i) => i.redacted && !('outcome' in i.metadata) && !('verdict' in i.metadata)));
  assert.equal(toHttpCase(http('t', 'failed', { reason: 'expected 302, got 200' })).verdict, 'FAIL');
  assert.equal(toHttpCase(http('t', 'skipped')).verdict, 'INCONCLUSIVE');
  assert.throws(() => decideHttpSuite({ results: [http('t', 'passed', { steps: [{ name: 's', request: 'GET /x?token=sbp_' + 'a'.repeat(40), status: 200, checks: [], ok: true }] })] }), /Credential material/, 'credential-looking material is refused, not digested');
  assert.throws(() => decideHttpSuite({ results: null }), (e) => e.code === 'adapter-input');
});

test('the HTTP proof root: same facts same root, order-independent, capture-time-independent; a changed status is a different proof', () => {
  const a = http('a', 'passed'), b = http('b', 'passed', { steps: [{ name: 'session', request: 'GET /api/session', status: 401, checks: [{ name: 'status', ok: true }], ok: true }] });
  const one = decideHttpSuite({ results: [a, b] });
  assert.match(one.proofRoot, /^[0-9a-f]{64}$/);
  assert.equal(one.proofRoot, decideHttpSuite({ results: [b, a], capturedAt: '2031-01-01T00:00:00.000Z' }).proofRoot);
  const changed = http('b', 'passed', { steps: [{ name: 'session', request: 'GET /api/session', status: 200, checks: [{ name: 'status', ok: true }], ok: true }] });
  assert.notEqual(one.proofRoot, decideHttpSuite({ results: [a, changed] }).proofRoot);
  assert.equal(one.evidenceItems, 4);
});

test('Proof Integrity 0.1: both decisions expose the evidence-set identity the proof root is computed over, and an envelope binds it', async () => {
  const { decideHttpSuite, buildProofEnvelope, verifyProofEnvelope, proofRootOfManifest } = await import('../src/index.js');
  const lib = decideLibrarySuite({ tests: [T('a', [step('on', 'op', ['x'], { equals: true })])], runs: [{ id: 'a', observations: [obs('on', true)], operationalError: null }] });
  assert.deepEqual(lib.evidence.map((e) => Object.keys(e)), [['kind', 'digest'], ['kind', 'digest']]);
  assert.equal(proofRootOfManifest(lib.evidence), lib.proofRoot, 'the manifest re-derives the root');
  const http = decideHttpSuite({ results: [{ id: 'h', required: true, outcome: 'passed', steps: [{ name: 'login', request: 'GET /auth/login', status: 302, checks: [{ name: 'status', ok: true }] }] }] });
  assert.deepEqual([...http.evidence.map((e) => e.kind)].sort(), ['REQUEST', 'RESPONSE'], 'one real exchange: one REQUEST, one RESPONSE');
  assert.equal(proofRootOfManifest(http.evidence), http.proofRoot);
  const report = { verdict: http.verdict, proofRoot: http.proofRoot, proofEvidence: http.evidence, proofAuthority: { ...http.authority, cufVerdict: http.cufVerdict }, results: [{ id: 'h', kind: 'http', required: true, outcome: 'passed' }] };
  const identity = { capability: { id: null, slug: 's', kind: 'k', form: 'service' }, contract: { id: null, version: null }, source: { revision: null }, destination: null, verifier: { core: '0.0.0' } };
  const { envelope } = buildProofEnvelope({ report, ...identity });
  assert.equal(verifyProofEnvelope(envelope).intact, true);
  assert.deepEqual(envelope.payload.proofAuthority, { perCase: 'graft-http-runner', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel' });
  // Fail-closed reports (no root) get no envelope, with the reason stated.
  assert.deepEqual(buildProofEnvelope({ report: { ...report, proofRoot: null, proofEvidence: null, verdict: 'NEEDS_REVIEW' }, ...identity }).reason, 'proof-unavailable');
});
