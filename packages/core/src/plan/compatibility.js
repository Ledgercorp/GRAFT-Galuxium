import fs from 'node:fs';
import path from 'node:path';
import { profileFor, SUPPORTED_PROFILES } from '../emit/profiles.js';
import { compatibilityPreview } from './preview.js';

const OK = 'ok', WARN = 'warn', BLOCK = 'block';

function check(id, status, title, detail, remedy = null) {
  return { id, status, title, detail, remedy };
}

/**
 * Compares a harvested capability against a destination project.
 *
 * Every check is decided from the fingerprint, not from a model's opinion. A check
 * that cannot be decided returns `warn` with what is missing, never a cheerful `ok`.
 */
export function analyzeCompatibility(manifest, destFp, { emittedPaths = [], emissionRefusal = null, entrypointRefusal = null } = {}) {
  const checks = [];
  const model = manifest.architecture.capabilityModel;

  if (emissionRefusal) {
    checks.push(check('manifest.unsafe', BLOCK, 'Manifest cannot be safely transplanted', emissionRefusal,
      'This manifest contains a value that cannot be written into generated code. Re-harvest it from a source you trust.'));
  }

  // What is known about whether this capability worked where it came from. A transplant
  // of something never seen working is allowed to proceed only with that stated plainly.
  const vis = manifest.provenance?.verifiedInSource;
  if (!vis || typeof vis !== 'object') {
    checks.push(check('source.verification', WARN, 'Source behavior not proven', 'This manifest carries no source verification record.',
      'Re-harvest with source verification to establish that the capability worked in its source project.'));
  } else if (vis.verdict === 'VERIFIED') {
    checks.push(check('source.verification', OK, 'Verified in source',
      `${vis.tests.filter((t) => t.outcome === 'passed').length} acceptance test(s) passed against the running source project (${vis.runtime.profile}, ${vis.sourceState?.marker || 'state unknown'}).`));
  } else if (vis.verdict === 'FAILED') {
    checks.push(check('source.verification', BLOCK, 'Capability failed verification in its own source',
      vis.rationale, 'Fix the source project and re-harvest. GRAFT will not transplant behavior it has observed to be broken.'));
  } else {
    checks.push(check('source.verification', WARN, 'Source behavior not proven', vis.rationale,
      'The capability was discovered but never observed working. Treat the transplant as unproven until verify passes in the destination.'));
  }

  const profile = profileFor(destFp, model.kind);
  const anyProfile = profileFor(destFp);
  checks.push(profile
    ? check('architecture.profile', OK, 'Destination architecture supported',
        `Destination is ${destFp.moduleSystem.value} with ${destFp.handlerContract.value} handlers; GRAFT can write a ${model.kind} capability in that idiom (${profile.id}).`)
    : check('architecture.profile', BLOCK, anyProfile ? `Destination architecture is not supported for ${model.kind}` : 'Destination architecture not supported',
        `Destination is ${destFp.moduleSystem.value} / ${destFp.handlerContract.value}${destFp.framework.value !== 'unknown' ? ` (${destFp.framework.value})` : ''}. ${anyProfile ? `GRAFT can write ${anyProfile.kinds.join(', ')} here, but has no ${model.kind} emitter for this shape.` : `Supported: ${SUPPORTED_PROFILES.filter((p) => p.kinds.includes(model.kind)).map((p) => `${p.moduleSystem}/${p.handlerContract}${p.framework ? ` (${p.framework})` : ''}`).join(', ') || 'none for this kind'}.`}${destFp.express?.reason ? ` Express wiring: ${destFp.express.reason}.` : ''}${destFp.central && !destFp.central.supported ? ` Central handler: ${destFp.central.reason}.` : ''}`,
        'Add an emitter profile for this kind and shape before transplanting.'));

  checks.push(destFp.framework.value !== 'unknown'
    ? check('architecture.framework', OK, 'HTTP layer identified', `${destFp.framework.value} (${destFp.framework.evidence})`)
    : check('architecture.framework', WARN, 'HTTP layer not identified',
        'No known framework or node:http server was found, so route registration may not land where expected.'));

  checks.push(destFp.entrypoint
    ? check('architecture.entrypoint', OK, 'Entrypoint located', `${destFp.entrypoint} will be edited to register the new routes.`)
    : check('architecture.entrypoint', BLOCK, 'No entrypoint found',
        'GRAFT could not find the file that starts the application, so it cannot register routes.',
        'Set "main" or a "start" script in package.json.'));
  if (entrypointRefusal) checks.push(check('architecture.entrypoint-edit', BLOCK, 'Entrypoint cannot be safely edited', entrypointRefusal,
    'Use direct top-level route registrations in a supported entrypoint, or integrate the capability manually.'));

  const needsPersistence = (manifest.dataModel?.entities || []).length > 0;
  if (model.kind === 'hosted-session-auth') {
    checks.push(check('data.persistence', OK, 'Sessions are held in process memory by design',
      'The source keeps sessions in memory and declares them non-durable (fail closed on restart); the transplant preserves that semantic rather than silently adding durability.'));
  } else if (!needsPersistence) {
    checks.push(check('data.persistence', OK, 'No persistence required', 'This capability stores nothing; it reads configuration only.'));
  } else if (destFp.persistence.value === 'shared-store') {
    checks.push(check('data.persistence', OK, 'Persistence layer available',
      `Capability will store users and sessions through ${destFp.persistence.modules[0].module} rather than standing up its own.`));
  } else {
    checks.push(check('data.persistence', WARN, 'No shared persistence layer',
      'The destination has no store to hook into, so the capability will keep users and sessions in process memory.',
      'They will not survive a restart. Point store-adapter.js at a real database before production.'));
  }

  // Route collisions.
  const wanted = model.endpoints.map((e) => `${e.method} ${e.path}`);
  const existing = new Set(destFp.routes.map((r) => `${r.method} ${r.path}`));
  const collisions = wanted.filter((w) => existing.has(w));
  checks.push(collisions.length
    ? check('routes.collision', WARN, 'Route collision detected',
        `The destination already answers: ${collisions.join(', ')}.`,
        'GRAFT will not silently overwrite these. Re-run with --resolve-conflicts to comment them out in place, or change the transplanted paths.')
    : check('routes.collision', OK, 'No route collisions', `All ${wanted.length} routes are unclaimed in the destination.`));

  // File collisions.
  const fileCollisions = emittedPaths.filter((p) => fs.existsSync(path.join(destFp.root, p)));
  checks.push(fileCollisions.length
    ? check('files.collision', BLOCK, 'Files already exist',
        `Would overwrite: ${fileCollisions.join(', ')}.`,
        'Move or delete these files, or transplant into a different directory with --dir.')
    : check('files.collision', OK, 'No file collisions', `${emittedPaths.length} new files will be created.`));

  // Existing conflicting data model (only meaningful for capabilities that own a user model).
  const destEntityHits = model.kind === 'session-auth' ? destFp.files.filter((f) => /\b(users|accounts)\b/i.test(destFp.readFile(f) || '') && f !== destFp.entrypoint) : [];
  const destSqlUsers = model.kind === 'session-auth' ? destFp.sqlFiles.filter((f) => /CREATE TABLE\s+users/i.test(destFp.readFile(f) || '')) : [];
  if (model.kind === 'session-auth') checks.push(destSqlUsers.length || destEntityHits.length
    ? check('data.existing-user-model', WARN, 'Existing user model detected',
        `The destination already refers to users in: ${[...destSqlUsers, ...destEntityHits].join(', ')}.`,
        'The transplant adds its own user records. Reconcile the two before you rely on either.')
    : check('data.existing-user-model', OK, 'No conflicting user model', 'The destination has no existing user or account model to reconcile.'));

  // Dependencies.
  const destDeps = new Set(destFp.dependencies.map((d) => d.name));
  const missing = manifest.dependencies.packages.filter((p) => !destDeps.has(p.name));
  checks.push(missing.length
    ? check('dependencies.missing', WARN, 'Packages must be installed',
        `Not present in the destination: ${missing.map((m) => m.name).join(', ')}.`,
        `Run: npm install ${missing.map((m) => m.name).join(' ')}`)
    : check('dependencies.missing', OK, 'No new packages required',
        manifest.dependencies.packages.length ? 'All required packages are already installed.' : 'This capability uses only the Node standard library.'));

  // Environment.
  const destEnv = new Set(destFp.environmentVariables);
  const requiredEnv = manifest.environment.variables.filter((v) => v.required && !v.introduced && !destEnv.has(v.name));
  const optionalEnv = manifest.environment.variables.filter((v) => !v.required && !v.introduced && !destEnv.has(v.name));
  const introduced = manifest.environment.variables.filter((v) => v.introduced);
  if (introduced.length) checks.push(check('environment.introduced', WARN, 'New configuration the capability reads',
    `${introduced.map((v) => v.name).join(', ')} are read by the transplanted modules. Verification supplies them for a deterministic provider double; production needs real values.`,
    'Configure these in the destination environment before deploying. Never commit the client secret.'));
  checks.push(requiredEnv.length
    ? check('environment.missing', BLOCK, 'Required environment variables missing',
        `${requiredEnv.map((v) => v.name).join(', ')} must be set in the destination.`,
        'Add them to the destination .env before transplanting.')
    : check('environment.missing', OK, 'Environment satisfied',
        optionalEnv.length ? `Optional, will fall back to defaults: ${optionalEnv.map((v) => `${v.name}=${v.default}`).join(', ')}.` : 'No environment variables required.'));

  const worst = checks.some((c) => c.status === BLOCK) ? BLOCK : checks.some((c) => c.status === WARN) ? WARN : OK;
  const result = {
    checks,
    status: worst,
    blocking: checks.filter((c) => c.status === BLOCK),
    warnings: checks.filter((c) => c.status === WARN),
    collisions,
  };
  return { ...result, preview: compatibilityPreview(result) };
}
