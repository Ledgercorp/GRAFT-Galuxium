// Verification contracts — the Proof Kernel direction. A capability carries, explicitly,
// the success cases it must pass, the counterfactual cases it must reject, the invariants
// that must hold and the evidence a run must produce. The verdict itself is unchanged:
// decideVerdict() in verify/index.js remains the only thing that says VERIFIED, and test
// outcomes remain passed / failed / inconclusive. The contract makes what was proven —
// and what was NOT observed — explicit instead of implied by a generic report.
import { stableHash } from '../capability/contract.js';

export const VERIFICATION_CONTRACT_VERSION = '1.0.0';

const statuses = (expect) => (expect?.status === undefined ? [] : Array.isArray(expect.status) ? expect.status : [expect.status]);
// A case is counterfactual when its decisive (last) step must be refused, must not issue a
// credential, or deliberately withholds one.
function classify(test) {
  const last = test.steps[test.steps.length - 1];
  const refused = statuses(last.expect).length > 0 && statuses(last.expect).every((s) => s >= 400);
  return refused || last.expect?.notSetsCookie || last.useCookies === false || last.useCookieSnapshot ? 'counterfactual' : 'success';
}

// Which acceptance tests observe which invariant. Only mappings the HTTP verifier can
// actually witness are declared; everything else is reported as unobserved, honestly.
const hasExpect = (t, key) => t.steps.some((s) => s.expect && key in s.expect);
const INVARIANT_WITNESSES = Object.freeze({
  'sec.uniform-login-failure': (t) => /rejects-invalid/.test(t.id),
  'sec.server-side-authorization': (t) => /rejects-anonymous|ends-session/.test(t.id),
  'sec.password-at-rest': (t) => /rejects-invalid/.test(t.id),
  'sec.constant-time': () => false,
  // Witnessed only when the harvested test actually checks the cookie's value shape / flags.
  'sec.opaque-session': (t) => hasExpect(t, 'cookieValuePattern'),
  'sec.httponly': (t) => t.steps.some((s) => s.expect?.cookieFlags && 'HttpOnly' in s.expect.cookieFlags),
});

export function buildVerificationContract(manifest, ir, { recipe = null } = {}) {
  const tests = manifest.acceptanceTests.tests;
  const cases = tests.map((t) => ({ id: t.id, kind: classify(t), required: t.required === true, proves: t.provesBehavior, description: t.description || null, steps: t.steps.length,
    operations: (ir?.operations || []).filter((op) => (op.kind === 'library-operation'
      ? t.steps.some((s) => s.call === op.name)
      : t.steps.some((s) => s.method === op.method && s.path === op.path))).map((op) => op.id) }));
  // A harvest may declare which tests witness an assumption (witnessedBy); otherwise the
  // engine's table applies; otherwise the invariant is honestly unobserved.
  const declared = Object.fromEntries(manifest.security.assumptions.filter((a) => Array.isArray(a.witnessedBy)).map((a) => [a.id, a.witnessedBy]));
  const invariants = (ir?.invariants || []).filter((i) => i.kind === 'security').map((i) => ({ id: i.id, text: i.text,
    // Runner witnesses (`output.*`) are results the verifier synthesises for the whole run; they
    // count as witnesses too, and an invariant that names one is unobserved when it is absent.
    checkedBy: declared[i.id] ? declared[i.id].filter((id) => tests.some((t) => t.id === id) || /^output\.[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(id)) : tests.filter((t) => (INVARIANT_WITNESSES[i.id] || (() => false))(t)).map((t) => t.id) }));
  const contract = {
    contractVersion: VERIFICATION_CONTRACT_VERSION,
    capabilityId: ir?.capability?.capabilityId || null, irId: ir?.irId || null,
    successCases: cases.filter((c) => c.kind === 'success'),
    counterfactualCases: cases.filter((c) => c.kind === 'counterfactual'),
    invariants,
    // A library operation has a name, not a method and a path. Recording it as `undefined undefined`
    // would be a fabricated HTTP fact, so each form records what it actually has.
    operations: (ir?.operations || []).map((op) => (op.kind === 'library-operation'
      ? { id: op.id, kind: 'library-operation', name: op.name, role: op.role }
      : { id: op.id, method: op.method, path: op.path })),
    expectedEvidence: { perStep: ['http-status', 'set-cookie-names', 'cookie-attributes', 'json-body-fields', 'restart'], artifacts: ['verification-report', 'compatibility-observation', 'transplant-receipt'], runtime: 'node-entrypoint' },
    verdictRule: 'VERIFIED only when every required case passed against the running application; any required failure is FAILED; missing or inconclusive evidence is NEEDS_REVIEW.',
    outcomes: ['passed', 'failed', 'inconclusive'],
    // The recipe's expectations ride along for the record; they never relax the rule above.
    appliedRecipe: recipe ? { recipeId: recipe.recipeId, name: recipe.name, origin: recipe.provenance.origin, status: recipe.provenance.status || 'builtin', expectations: recipe.verificationExpectations } : null,
  };
  contract.contractId = stableHash({ contractVersion: contract.contractVersion, cases: cases.map((c) => [c.id, c.kind, c.required]), invariants: invariants.map((i) => [i.id, i.checkedBy]) });
  return contract;
}

/** Project a verification report onto its contract. Never changes the verdict. */
export function evaluateVerificationContract(contract, report) {
  const byId = new Map((report.results || []).map((r) => [r.id, r]));
  const outcome = (c) => ({ id: c.id, required: c.required, outcome: byId.get(c.id)?.outcome || 'inconclusive', reason: byId.get(c.id)?.reason || null });
  const successCases = contract.successCases.map(outcome);
  const counterfactualCases = contract.counterfactualCases.map(outcome);
  const invariants = contract.invariants.map((i) => {
    const witnessed = i.checkedBy.map((id) => byId.get(id)).filter(Boolean);
    const status = !i.checkedBy.length ? 'unobserved' : witnessed.some((r) => r.outcome === 'failed') ? 'violated' : witnessed.length === i.checkedBy.length && witnessed.every((r) => r.outcome === 'passed') ? 'held' : 'unobserved';
    return { id: i.id, status, checkedBy: i.checkedBy };
  });
  const all = [...successCases, ...counterfactualCases];
  // Route registration witness: each contracted operation must have answered something other
  // than 404 at least once — the observable proof that the transplant was wired in.
  const observed = new Map();
  for (const r of report.results || []) for (const s of r.steps || []) if (s.request && s.status !== null) observed.set(s.request, Math.min(observed.get(s.request) ?? 999, s.status));
  // Coverage means "was this operation exercised": over the wire for a service, through a call for
  // a library. Neither form borrows the other's vocabulary.
  const calls = new Set();
  for (const r of report.results || []) for (const o of r.observations || []) if (o.step) calls.add(o.step);
  const calledNames = new Set((contract.successCases || []).flatMap((c) => c.operations || []));
  const routeCoverage = (contract.operations || []).map((op) => (op.kind === 'library-operation'
    ? { operation: op.id, kind: 'library-operation', call: op.name, exercised: calledNames.has(op.id), registered: null }
    : { operation: op.id, request: `${op.method} ${op.path}`, exercised: observed.has(`${op.method} ${op.path}`), registered: observed.has(`${op.method} ${op.path}`) && observed.get(`${op.method} ${op.path}`) !== 404 }));
  return {
    contractVersion: contract.contractVersion, contractId: contract.contractId, appliedRecipe: contract.appliedRecipe || null,
    verdict: report.verdict, rationale: report.rationale,
    successCases, counterfactualCases, invariants, routeCoverage,
    evidence: { observedSteps: (report.results || []).reduce((n, r) => n + (r.steps?.length || 0), 0), runtime: report.runtime?.profile || null, finishedAt: report.finishedAt || null },
    summary: { cases: all.length, passed: all.filter((c) => c.outcome === 'passed').length, failed: all.filter((c) => c.outcome === 'failed').length, inconclusive: all.filter((c) => c.outcome === 'inconclusive').length,
      invariantsHeld: invariants.filter((i) => i.status === 'held').length, invariantsViolated: invariants.filter((i) => i.status === 'violated').length, invariantsUnobserved: invariants.filter((i) => i.status === 'unobserved').length },
  };
}

export function validateVerificationContract(contract) {
  const errors = [];
  if (!contract || contract.contractVersion !== VERIFICATION_CONTRACT_VERSION) return { ok: false, errors: [`contractVersion must be ${VERIFICATION_CONTRACT_VERSION}`] };
  if (!Array.isArray(contract.successCases) || !Array.isArray(contract.counterfactualCases) || !Array.isArray(contract.invariants)) errors.push('cases and invariants must be arrays');
  if (!(contract.successCases?.length + contract.counterfactualCases?.length)) errors.push('a contract must carry at least one case');
  if (!/^sha256:[0-9a-f]{64}$/.test(contract.contractId || '')) errors.push('contractId must be a sha256 digest');
  return { ok: errors.length === 0, errors };
}
