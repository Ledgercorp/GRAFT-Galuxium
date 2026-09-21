// Capability Forms 0.1a — implementation form.
//
// Capability KIND answers "what does this software do?" (feature-flags, session-auth, …).
// Implementation FORM answers "how is that capability packaged?" — and nothing else. The two are
// orthogonal: `feature-flags` stays `feature-flags` whether it is served over HTTP or exposed as a
// reusable library. Form is never part of capability identity.
//
// This phase supports exactly two forms, because exactly two have evidence behind them:
//
//   service   the capability is an application surface: it registers routes and answers requests
//   library   the capability is a reusable module: it exports an API a program calls directly
export const IMPLEMENTATION_FORMS = Object.freeze(['service', 'library']);
export const isImplementationForm = (value) => IMPLEMENTATION_FORMS.includes(value);

/**
 * The form of an existing manifest, for artifacts written before this field existed.
 *
 * Derivation is only allowed where the structure already proves the answer: a capability model
 * carrying HTTP endpoints, or acceptance tests made of HTTP steps, IS a service — that is what
 * those fields mean. Anything else returns null rather than guessing, because "unknown" is honest
 * and "service" would be a claim about history nobody recorded.
 */
export function deriveImplementationForm(manifest) {
  if (isImplementationForm(manifest?.identity?.implementationForm)) return { form: manifest.identity.implementationForm, derived: false, evidence: 'recorded in the manifest' };
  const endpoints = manifest?.architecture?.capabilityModel?.endpoints;
  if (Array.isArray(endpoints) && endpoints.length) return { form: 'service', derived: true, evidence: `capability model declares ${endpoints.length} HTTP endpoint(s)` };
  const tests = manifest?.acceptanceTests?.tests;
  if (Array.isArray(tests) && tests.length && tests.every((t) => t?.kind === 'http')) return { form: 'service', derived: true, evidence: 'every acceptance test is an HTTP exchange' };
  return { form: null, derived: false, evidence: 'no structural evidence of an implementation form' };
}

/** How the product says it, without jargon. */
export const FORM_LABELS = Object.freeze({ service: 'Service', library: 'Library' });
export const FORM_DESCRIPTIONS = Object.freeze({
  service: 'An application surface: GRAFT can write its routes into a host it supports.',
  library: 'A reusable module: a program calls its API directly. Integrating it into a host needs the library present as a dependency.',
});
