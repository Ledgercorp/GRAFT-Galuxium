// Host Model — a structured model of the destination repository, built from the
// deterministic project fingerprint plus the same capability detectors used for harvesting,
// so the planner reasons about what the host can support rather than guessing.
import path from 'node:path';
import { stableHash, architectureSignature } from '../capability/contract.js';
import { discoverCapabilities } from '../harvest/index.js';
import { profileFor, profilesByKind, SUPPORTED_PROFILES } from '../emit/profiles.js';

export const HOST_MODEL_VERSION = '1.0.0';

function detectTesting(fp) {
  const pkg = fp.packageJson || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const script = pkg.scripts?.test || null;
  const framework = ['vitest', 'jest', 'mocha', 'ava', 'tap'].find((f) => deps[f]) || (/node\s+--test|node:test/.test(script || '') || fp.files.some((f) => /^test\/|\.test\.(m?js|cjs)$/.test(f) && /node:test/.test(fp.readFile(f) || '')) ? 'node:test' : null);
  const testFiles = fp.files.filter((f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.(test|spec)\.(m?js|cjs|ts)$/.test(f));
  return { framework, script, testFiles: testFiles.length, evidence: framework ? (deps[framework] ? `package.json devDependency ${framework}` : 'node:test usage') : 'no test framework signal' };
}

export function buildHostModel(destFp) {
  const fp = destFp;
  const pkg = fp.packageJson || {};
  const idioms = {};
  for (const r of fp.routes) idioms[r.idiom] = (idioms[r.idiom] || 0) + 1;
  const dirs = new Set(fp.files.map((f) => f.split('/')[0]).filter((d) => !d.includes('.')));
  const routeFiles = [...new Set(fp.routes.map((r) => r.file))];
  const existing = discoverCapabilities(fp).map((c) => ({ id: c.id, category: c.category, confidence: c.confidence, harvestable: c.harvestable, signals: c.signals.length }));
  const profile = profileFor(fp);
  const host = {
    hostModelVersion: HOST_MODEL_VERSION,
    project: { name: fp.name, version: fp.version, root: fp.root },
    runtime: { family: 'node', range: pkg.engines?.node || null, entrypoint: fp.entrypoint, startScript: pkg.scripts?.start || null, executionProfile: 'node-entrypoint' },
    moduleSystem: { value: fp.moduleSystem.value, evidence: fp.moduleSystem.evidence },
    framework: { value: fp.framework.value, version: fp.framework.version || null, evidence: fp.framework.evidence },
    routing: {
      idioms, routes: fp.routes.map((r) => ({ method: r.method, path: r.path, file: r.file, idiom: r.idiom })), routeFiles,
      registration: fp.express ? { style: 'express', supported: fp.express.supported === true, reason: fp.express.reason || null } : { style: fp.framework.value === 'unknown' ? 'unknown' : 'node-http', supported: Boolean(fp.entrypoint), reason: fp.entrypoint ? null : 'no-entrypoint' },
    },
    packages: { declared: fp.dependencies, count: fp.dependencies.length, hasPackageJson: Boolean(fp.packageJson) },
    testing: detectTesting(fp),
    dataLayer: { persistence: fp.persistence.value, modules: (fp.persistence.modules || []).map((m) => ({ kind: m.kind, module: m.module, exportName: m.exportName || null })), sqlFiles: fp.sqlFiles, evidence: fp.persistence.evidence },
    existingCapabilities: existing,
    structure: { topLevelDirs: [...dirs].sort(), sourceFileCount: fp.files.length, routeFiles, entrypointDir: fp.entrypoint ? path.posix.dirname(fp.entrypoint) : null },
    environment: { variables: fp.environmentVariables, hasEnvExample: fp.files.includes('.env.example') },
    constraints: { handlerContract: { value: fp.handlerContract.value, evidence: fp.handlerContract.evidence }, adaptationProfile: profile?.id || null,
      // Which emitter, if any, can write each capability kind into this host. A host can be a fine
      // destination for one kind and an unsupported one for another.
      profilesByKind: profilesByKind(fp), centralHandler: fp.central ? { supported: fp.central.supported === true, reason: fp.central.reason || null } : null,
      unsupportedReason: profile ? null : `no emitter profile for ${fp.moduleSystem.value}/${fp.handlerContract.value}${fp.express?.reason ? ` (${fp.express.reason})` : ''}`,
      supportedProfiles: SUPPORTED_PROFILES.map((p) => p.id) },
    architecture: architectureSignature(fp),
  };
  host.hostId = stableHash({ hostModelVersion: HOST_MODEL_VERSION, architecture: host.architecture, moduleSystem: host.moduleSystem.value, handler: host.constraints.handlerContract.value,
    routing: { idioms, registration: host.routing.registration }, dataLayer: { persistence: host.dataLayer.persistence, modules: host.dataLayer.modules }, structure: host.structure, environment: host.environment.variables });
  return host;
}

export function validateHostModel(host) {
  const errors = [];
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(host) || host.hostModelVersion !== HOST_MODEL_VERSION) return { ok: false, errors: [`hostModelVersion must be ${HOST_MODEL_VERSION}`] };
  for (const key of ['project', 'runtime', 'moduleSystem', 'framework', 'routing', 'packages', 'testing', 'dataLayer', 'structure', 'environment', 'constraints', 'architecture']) if (!object(host[key])) errors.push(`${key} must be an object`);
  if (!Array.isArray(host.existingCapabilities)) errors.push('existingCapabilities must be an array');
  if (!/^sha256:[0-9a-f]{64}$/.test(host.hostId || '')) errors.push('hostId must be a sha256 digest');
  return { ok: errors.length === 0, errors };
}
