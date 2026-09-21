// Detects a feature-flags capability: a flag listing route, an evaluation route, defaults
// declared in code and, optionally, an environment variable that enables names. Every claim
// carries the file that produced it.
export function detect(fp) {
  const routes = fp.routes.filter((r) => /^\/flags(\/|$)/i.test(r.path) || /^\/(features?|feature-flags)(\/|$)/i.test(r.path));
  const list = routes.find((r) => r.method === 'GET' && /^\/(flags|features?|feature-flags)$/i.test(r.path));
  const evaluate = routes.find((r) => r.method === 'POST' && /\/(evaluate|check|enabled)$/i.test(r.path));
  let defaults = null, defaultsFile = null;
  for (const f of fp.files) {
    const src = fp.readFile(f) || '';
    const m = /DEFAULT_FLAGS\s*=\s*(?:Object\.freeze\()?\{([^}]*)\}/.exec(src);
    if (!m) continue;
    defaults = {};
    for (const pair of m[1].split(',')) { const kv = /^\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*:\s*(true|false)\s*$/.exec(pair); if (kv) defaults[kv[1]] = kv[2] === 'true'; }
    defaultsFile = f;
    break;
  }
  const envVar = fp.environmentVariables.find((v) => /^(FEATURE_FLAGS|FLAGS|ENABLED_FLAGS)$/.test(v)) || null;
  const signals = [];
  if (list) signals.push({ id: 'flag-list-route', evidence: `${list.method} ${list.path} in ${list.file}` });
  if (evaluate) signals.push({ id: 'flag-evaluate-route', evidence: `${evaluate.method} ${evaluate.path} in ${evaluate.file}` });
  if (defaults) signals.push({ id: 'flag-defaults', evidence: `${defaultsFile}: ${Object.keys(defaults).length} default flag(s)` });
  if (envVar) signals.push({ id: 'flag-environment', evidence: `${envVar} read from the environment` });
  if (!list || !defaults || !Object.keys(defaults).length) return { category: 'feature-flags', found: false, signals };
  return {
    category: 'feature-flags', found: true, confidence: signals.length >= 3 ? 'high' : 'medium', signals,
    routes: [{ ...list, role: 'list' }, ...(evaluate ? [{ ...evaluate, role: 'evaluate' }] : [])],
    defaults, defaultsFile, envVar,
    contributingFiles: [...new Set([list.file, ...(evaluate ? [evaluate.file] : []), defaultsFile])],
    absent: [...(evaluate ? [] : ['flag evaluation endpoint']), ...(envVar ? [] : ['environment overrides']), 'per-user targeting', 'remote flag provider'],
  };
}

export const meta = {
  category: 'feature-flags',
  // These detectors require HTTP routes, so what they find is a service by construction.
  implementationForm: 'service',
  displayName: 'Feature flags',
  harvestable: true,
  describe(result) { return `${Object.keys(result.defaults).length} flags (${result.routes.map((r) => r.role).join(', ')})${result.envVar ? `, ${result.envVar} overrides` : ''}`; },
};
