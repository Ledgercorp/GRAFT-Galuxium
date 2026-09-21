// The generic CUF proof kernel, as GRAFT may use it. Everything exported here is CUF's own code
// (see PROVENANCE.json — the vendored modules are CUF's compiled output at the recorded commit,
// with one documented specifier rewrite); this facade only chooses the surface.
//
// Deliberately NOT exported: `evaluateCase` and the cleanup-verification machinery. They encode
// CUF's authorization-attack run (verified setup, REQUEST/RESPONSE evidence, an independently
// verified cleanup); feeding GRAFT cases to them would require fabricating that evidence. The
// domain-neutral `evaluateObservationCase` (declared expectations over observed values, with
// INVOCATION / RESULT evidence) is the per-case authority GRAFT uses. CUF is authoritative here for
// the per-case verdict of an observation case, the verdict vocabulary, the aggregation of case
// verdicts into a run verdict, evidence normalisation and the proof root.
export { VERDICTS, canonicalJson, sha256 } from './contracts.js';
export { aggregateVerdict, evidenceRoot } from './evidence.js';
export { captureEvidence } from './capture.js';
export { evaluateObservationCase } from './observation.js';
