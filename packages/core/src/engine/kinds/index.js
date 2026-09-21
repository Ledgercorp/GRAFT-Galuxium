// Capability kinds the engine understands. Each kind contributes role semantics (what an
// operation does to state and to the client), the adaptation dimensions it varies along, and
// how its routes are registered in a destination. Structures elsewhere are kind-agnostic.
import * as sessionAuth from './session-auth.js';
import * as featureFlags from './feature-flags.js';
import * as hostedSessionAuth from './hosted-session-auth.js';

const KINDS = Object.freeze({ [sessionAuth.KIND]: sessionAuth, [featureFlags.KIND]: featureFlags, [hostedSessionAuth.KIND]: hostedSessionAuth });

export function kindSemantics(kind) {
  const found = KINDS[kind];
  if (!found) throw new Error(`GRAFT Engine has no semantics for capability kind "${kind}"; supported: ${Object.keys(KINDS).join(', ')}.`);
  return found;
}
export const SUPPORTED_KINDS = Object.freeze(Object.keys(KINDS));
