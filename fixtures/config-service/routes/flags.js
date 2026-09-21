'use strict';
const { json } = require('../lib/router');

// Feature flags: defaults in code, names enabled through the environment. Read-only by
// design — nothing here stores state or identifies a caller.
const DEFAULT_FLAGS = { new_checkout: true, beta_dashboard: false, dark_mode: false };

function enabledFlags() {
  const flags = Object.assign({}, DEFAULT_FLAGS);
  const configured = process.env.FEATURE_FLAGS;
  if (configured) for (const name of configured.split(',').map((s) => s.trim()).filter(Boolean)) flags[name] = true;
  return flags;
}

function register(router) {
  router.add('GET', '/flags', (req, res) => json(res, 200, { flags: enabledFlags() }));
  router.add('POST', '/flags/evaluate', (req, res) => {
    const name = req.body && req.body.name;
    const flags = enabledFlags();
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(flags, name)) return json(res, 404, { error: 'unknown_flag' });
    return json(res, 200, { name, enabled: flags[name] });
  });
}

module.exports = register;
