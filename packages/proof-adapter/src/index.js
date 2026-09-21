// GRAFT ↔ proof-kernel adapter (CUF Kernel Integration 0.1, Checkpoint B).
//
// The only module in GRAFT that knows both vocabularies. Dependency direction: a GRAFT runner →
// this adapter → the vendored proof kernel (packages/cuf-kernel). Nothing here imports the runner,
// the Laboratory, the Ledger or any UI, and the kernel never imports GRAFT.
//
// What the kernel is authoritative for: each case's PASS / FAIL / INCONCLUSIVE — decided by
// `evaluateObservationCase` from the declared expectations and the raw observations the driver
// produced — the run verdict (`aggregateVerdict`: FAIL outranks INCONCLUSIVE outranks PASS; an
// empty run is INCONCLUSIVE), the normalisation of evidence into redacted, content-addressed items
// (`captureEvidence`) and the proof root over them (`evidenceRoot`). What GRAFT still owns: running
// the library's own driver, the capability contract that declares the expectations, and the
// mapping of the kernel's vocabulary onto VERIFIED / FAILED / NEEDS_REVIEW. This adapter decides
// nothing: it translates a contract step into a kernel expectation and a driver observation into a
// kernel observation, and carries the kernel's answer back. The kernel's authorization evaluator
// (`evaluateCase`) is not used and none of its REQUEST/RESPONSE/cleanup evidence is fabricated.
import { aggregateVerdict, evidenceRoot, captureEvidence, evaluateObservationCase, canonicalJson } from '../../cuf-kernel/src/index.js';
import { evidenceManifest } from './envelope.js';

// Proof Integrity 0.1: the content-addressed proof envelope over a decided report (no keys, no verdict).
export { PROOF_ENVELOPE_SCHEMA, buildProofEnvelope, verifyProofEnvelope, evidenceManifest, manifestDigest, proofRootOfManifest, proofKernelIdentity, proofAdapterVersion } from './envelope.js';
// Portable verification of a proof file: integrity and the recorded claim, separately (Checkpoint C).
export { verifyProofFile, verifyProofArtifact, proofClaim } from './proof-file.js';

/** Kernel → GRAFT. PASS is the only route to VERIFIED; FAIL and INCONCLUSIVE never become it. */
export const VERDICT_MAP = Object.freeze({ PASS: 'VERIFIED', FAIL: 'FAILED', INCONCLUSIVE: 'NEEDS_REVIEW' });
/** Kernel case verdict → the per-test outcome word GRAFT reports have always carried. */
export const CASE_OUTCOME_MAP = Object.freeze({ PASS: 'passed', FAIL: 'failed', INCONCLUSIVE: 'inconclusive' });
/** The evidence a library observation case must carry: what was invoked, and what it produced. */
export const LIBRARY_EVIDENCE_KINDS = Object.freeze(['INVOCATION', 'RESULT']);
const EPOCH = '1970-01-01T00:00:00.000Z';
const fail = (code, message) => Object.assign(new Error(message), { code });
const isScalar = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** A driver value as the kernel's scalar: scalars as they are, anything structured as its canonical JSON, marked. */
export const observedValue = (v) => (v === undefined ? null : isScalar(v) ? v : `json:${canonicalJson(v)}`);

/** A contract step's declared expectations, in the order they have always been checked (equals, branch, sameAs). */
export function expectationsFor(step) {
  const expect = step.expect || {};
  const out = [];
  if ('equals' in expect) out.push({ kind: 'value', observation: step.name, equals: observedValue(expect.equals) });
  if ('branch' in expect) out.push({ kind: 'selection', observation: step.name, equals: String(expect.branch) });
  if ('sameAs' in expect) out.push({ kind: 'consistent', observation: step.name, with: String(expect.sameAs) });
  return out;
}

/** A library test as a kernel observation case: its steps' expectations, and the evidence it must carry. */
export function toObservationCase(test) {
  const steps = Array.isArray(test.steps) ? test.steps : [];
  return Object.freeze({ id: String(test.id), expectationId: String(test.provesBehavior || test.id), expectations: Object.freeze(steps.flatMap(expectationsFor)), requiredEvidenceKinds: LIBRARY_EVIDENCE_KINDS });
}

/**
 * A driver run as a kernel observation run: each step's produced value and selected branch, with
 * one INVOCATION and one RESULT evidence item per observation (a library call is what was invoked,
 * its return value or branch what it produced). No outcome, no path, no timestamp enters a digest.
 */
export function toObservationRun(run, { capturedAt = EPOCH } = {}) {
  const observations = Array.isArray(run?.observations) ? run.observations : [];
  return Object.freeze({
    observations: Object.freeze(observations.map((o) => ({ id: String(o.step), value: observedValue(o.returned), selected: o.branch == null ? null : String(o.branch) }))),
    operationalError: run?.operationalError == null ? null : String(run.operationalError),
    evidence: Object.freeze(observations.flatMap((o) => [
      captureEvidence({ kind: 'INVOCATION', capturedAt, metadata: { observation: String(o.step), operation: o.call == null ? null : String(o.call), arguments: canonicalJson(o.args ?? []) } }),
      captureEvidence({ kind: 'RESULT', capturedAt, metadata: { observation: String(o.step), value: observedValue(o.returned), selected: o.branch == null ? null : String(o.branch) } }),
    ])),
  });
}

/** The kernel decides one library case from the contract's expectations and the driver's raw observations. */
export function evaluateLibraryCase(test, run, options) {
  return evaluateObservationCase(toObservationCase(test), toObservationRun(run, options));
}

/**
 * Decide a whole library suite through the kernel: every case evaluated, the required ones
 * aggregated, the proof root over every case's evidence. `loaded === false` is the kernel's
 * "the plan could not be executed": no case is evaluated and the run is INCONCLUSIVE. Returns the
 * kernel verdict, its GRAFT mapping, the per-case results and the proof root.
 */
export function decideLibrarySuite({ tests, runs, loaded = true, capturedAt } = {}) {
  if (!Array.isArray(tests)) throw fail('adapter-input', 'tests must be an array');
  if (!Array.isArray(runs)) throw fail('adapter-input', 'runs must be an array');
  const byId = new Map(runs.map((r) => [String(r.id), r]));
  const cases = tests.map((t) => ({ test: t, result: loaded === false ? null : evaluateLibraryCase(t, byId.get(String(t.id)) || { observations: [], operationalError: 'the case was not executed' }, { capturedAt }) }));
  const evaluated = cases.filter((c) => c.result).map((c) => c.result);
  const decided = cases.filter((c) => c.result && c.test.required === true).map((c) => c.result);
  const cufVerdict = aggregateVerdict(decided);
  if (!(cufVerdict in VERDICT_MAP)) throw fail('adapter-verdict', `the kernel returned an unknown verdict ${cufVerdict}`);
  return Object.freeze({
    cufVerdict, verdict: VERDICT_MAP[cufVerdict],
    proofRoot: evidenceRoot(evaluated),
    // The evidence-set identity the proof root is computed over (Proof Integrity 0.1): kind + digest only.
    evidence: evidenceManifest(evaluated.flatMap((c) => c.evidence)),
    cases: Object.freeze(cases.map((c) => Object.freeze({ id: String(c.test.id), verdict: c.result?.verdict || 'INCONCLUSIVE', outcome: CASE_OUTCOME_MAP[c.result?.verdict] || 'inconclusive', reason: c.result?.reason || null, evidence: c.result?.evidence.length || 0 }))),
    evidenceItems: evaluated.reduce((n, c) => n + c.evidence.length, 0),
    authority: Object.freeze({ perCase: 'cuf-kernel', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel', execution: 'graft-library-driver', contract: 'graft-capability-contract' }),
  });
}

// ---------------------------------------------------------------------------------------------
// The HTTP acceptance family (Checkpoint C): aggregation and proof root only.
//
// Here GRAFT still decides every case — HTTP execution, the provider double, retries and the
// HTTP-domain expectations (status, headers, cookies, bodies) all stay in the runner, and the
// per-case outcome it established is carried across unchanged as the kernel case verdict. The
// kernel is authoritative for the aggregate verdict, the normalisation of the HTTP evidence and the
// proof root. REQUEST / RESPONSE are used only for what they mean in the kernel: one real HTTP
// exchange. A restart of the subject is an INVOCATION; the process-output witness is STATE_AFTER.
// ---------------------------------------------------------------------------------------------
const HTTP_REQUEST = /^[A-Z]+ \//;
/** The deterministic facts of one HTTP step: what was asked (method + contract path), what came back (status, which checks held). Never a header value, cookie, body or URL. */
export function httpEvidenceFor(result, { capturedAt = EPOCH } = {}) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  return steps.flatMap((step, index) => {
    const base = { test: String(result.id), step: String(step.name ?? index) };
    const checks = canonicalJson((step.checks || []).map((c) => ({ name: String(c.name), ok: c.ok === true })));
    if (typeof step.request === 'string' && HTTP_REQUEST.test(step.request)) {
      return [
        captureEvidence({ kind: 'REQUEST', capturedAt, metadata: { ...base, request: step.request } }),
        captureEvidence({ kind: 'RESPONSE', capturedAt, metadata: { ...base, status: step.status == null ? null : Number(step.status), checks } }),
      ];
    }
    if (step.request === 'restart') return [captureEvidence({ kind: 'INVOCATION', capturedAt, metadata: { ...base, operation: 'restart', checks } })];
    return [captureEvidence({ kind: 'STATE_AFTER', capturedAt, metadata: { ...base, witness: String(step.request ?? 'observation'), checks } })];
  });
}

/** An HTTP result as the kernel case it aggregates: the runner's outcome as the case verdict, its evidence digested. */
export function toHttpCase(result, options) {
  return Object.freeze({ testCaseId: String(result.id), expectationId: String(result.provesBehavior || result.id), verdict: OUTCOME_TO_VERDICT[result.outcome] || 'INCONCLUSIVE', reason: result.reason == null ? '' : String(result.reason), evidence: Object.freeze(httpEvidenceFor(result, options)) });
}
const OUTCOME_TO_VERDICT = Object.freeze({ passed: 'PASS', failed: 'FAIL', inconclusive: 'INCONCLUSIVE' });

/**
 * Aggregate an HTTP acceptance suite through the kernel. `serverReady === false` is the kernel's
 * non-executable run (no case, INCONCLUSIVE); otherwise the required results decide, every result's
 * evidence enters the proof root. The per-case verdicts are GRAFT's; the aggregate and the root are the kernel's.
 */
export function decideHttpSuite({ results, serverReady = true, capturedAt } = {}) {
  if (!Array.isArray(results)) throw fail('adapter-input', 'results must be an array');
  const cases = results.map((r) => toHttpCase(r, { capturedAt }));
  const decided = serverReady === false ? [] : cases.filter((c, i) => results[i].required === true);
  const cufVerdict = aggregateVerdict(decided);
  if (!(cufVerdict in VERDICT_MAP)) throw fail('adapter-verdict', `the kernel returned an unknown verdict ${cufVerdict}`);
  return Object.freeze({
    cufVerdict, verdict: VERDICT_MAP[cufVerdict], proofRoot: evidenceRoot(cases), cases: Object.freeze(decided), evidenceItems: cases.reduce((n, c) => n + c.evidence.length, 0),
    evidence: evidenceManifest(cases.flatMap((c) => c.evidence)),
    authority: Object.freeze({ perCase: 'graft-http-runner', aggregation: 'cuf-kernel', proofRoot: 'cuf-kernel', execution: 'graft-http-runner', providerDouble: 'graft-http-runner', retries: 'graft-http-runner' }),
  });
}
