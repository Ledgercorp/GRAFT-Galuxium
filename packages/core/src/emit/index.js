// Kind-generic emission over the IR -> emitter boundary.
import { emitSessionAuthFromSpec } from './session-auth.js';
import { emitFeatureFlagsFromSpec } from './feature-flags.js';
import { emitHostedSessionAuthFromSpec } from './hosted-session-auth.js';
import { validateEmissionSpec } from '../engine/lower.js';

const EMITTERS = Object.freeze({ 'session-auth': emitSessionAuthFromSpec, 'feature-flags': emitFeatureFlagsFromSpec, 'hosted-session-auth': emitHostedSessionAuthFromSpec });

export function emitCapability(spec) {
  const validation = validateEmissionSpec(spec);
  if (!validation.ok) throw new Error(`invalid emission spec: ${validation.errors.join('; ')}`);
  const emitter = EMITTERS[spec.kind];
  if (!emitter) { const err = new Error(`no emitter for capability kind ${spec.kind}`); err.code = 'unsupported-kind'; throw err; }
  return emitter(spec);
}
export const EMITTABLE_KINDS = Object.freeze(Object.keys(EMITTERS));
