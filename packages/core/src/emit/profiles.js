// Destination shapes the emitters can write for. A leaf module: the engine (host model,
// recipes) and the emitters both import it, so neither has to import the other.
// `kinds` names the capability kinds an emitter can actually write for this shape. A profile is
// never "supported" in the abstract: it is supported for a kind, or it is not.
export const SUPPORTED_PROFILES = [
  { id: 'esm-return-response', moduleSystem: 'esm', handlerContract: 'return-response', kinds: ['session-auth', 'feature-flags'] },
  { id: 'express-req-res', moduleSystem: 'esm', handlerContract: 'express-req-res', framework: 'express', kinds: ['session-auth', 'feature-flags', 'hosted-session-auth'] },
  // Engine 1.2: a bare node:http server with one central async request handler.
  { id: 'esm-node-http-central', moduleSystem: 'esm', handlerContract: 'node-res', framework: 'node-http', kinds: ['hosted-session-auth'] },
];

// Registration strategies differ by kind: session-auth and feature-flags register their own
// routes on the Express app (the entrypoint must expose direct route registrations), while a
// hosted-session-auth capability takes first refusal through one guard middleware (mounted
// routers are fine). So an Express entrypoint can be a valid host for one kind and not another.
const GUARD_KINDS = new Set(['hosted-session-auth']);
function shapeMatches(p, destFp, kind = null) {
  if (p.moduleSystem !== destFp.moduleSystem.value || p.handlerContract !== destFp.handlerContract.value) return false;
  if (p.framework === 'express') {
    if (destFp.framework.value !== 'express') return false;
    return kind && GUARD_KINDS.has(kind) ? destFp.expressGuard?.supported === true : destFp.express?.supported === true;
  }
  if (p.framework === 'node-http') return destFp.framework.value === 'node-http' && destFp.central?.supported === true;
  return destFp.framework.value !== 'express';
}

/** The emitter profile for a destination — for a specific kind when one is given, else any kind. */
export function profileFor(destFp, kind = null) {
  return SUPPORTED_PROFILES.find((p) => shapeMatches(p, destFp, kind) && (!kind || p.kinds.includes(kind))) || null;
}

export function profilesByKind(destFp) {
  const out = {};
  for (const p of SUPPORTED_PROFILES) for (const kind of p.kinds) if (!out[kind] && shapeMatches(p, destFp, kind)) out[kind] = p.id;
  return out;
}
