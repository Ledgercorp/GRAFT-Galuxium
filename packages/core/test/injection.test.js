import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { emitSessionAuth, planEntrypointEdit } from '../src/emit/session-auth.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { SOURCE_FIXTURE, DEST_FIXTURE, makeDestination } from './helpers.js';

const destFp = fingerprintProject(DEST_FIXTURE);
const base = harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');
const clone = () => JSON.parse(JSON.stringify(base));

/**
 * A manifest is a portable file. GRAFT reads manifests it did not write, and the values
 * inside them are interpolated into code that is then executed during verification.
 * Every one of these cases must be refused before a single file is generated.
 */
const HOSTILE = [
  ['session.cookieName', (m) => { m.architecture.capabilityModel.session.cookieName = "sid\"; globalThis.PWNED = 1; const x = \""; }],
  ['session.path', (m) => { m.architecture.capabilityModel.session.path = '/${globalThis.PWNED = 1}'; }],
  ['session.sameSite', (m) => { m.architecture.capabilityModel.session.sameSite = '${globalThis.PWNED = 1}'; }],
  ['session.idBytes', (m) => { m.architecture.capabilityModel.session.idBytes = '24; globalThis.PWNED = 1'; }],
  ['session.ttlSeconds', (m) => { m.architecture.capabilityModel.session.ttlSeconds = '1); globalThis.PWNED = (1'; }],
  ['passwordHash.keyLength', (m) => { m.architecture.capabilityModel.passwordHash.keyLength = '64; globalThis.PWNED = 1'; }],
  ['guard.name', (m) => { m.architecture.capabilityModel.guard.name = 'x(){}; globalThis.PWNED = 1; function y'; }],
  ['guard.unauthenticatedStatus', (m) => { m.architecture.capabilityModel.guard.unauthenticatedStatus = '401 }; globalThis.PWNED = 1; const z = {'; }],
  ['endpoint path', (m) => { m.architecture.capabilityModel.endpoints.find((e) => e.role === 'login').path = '/auth/login"; globalThis.PWNED = 1; const q = "'; }],
  ['passwordPolicy.minLength', (m) => { m.architecture.capabilityModel.passwordPolicy.minLength = '8) { globalThis.PWNED = 1; } if (false'; }],
];

for (const [field, mutate] of HOSTILE) {
  test(`a manifest with a hostile ${field} is refused before any code is generated`, () => {
    const m = clone();
    mutate(m);
    assert.throws(() => emitSessionAuth(m, destFp), (err) => {
      assert.equal(err.code, 'unsafe-manifest-value', `expected a safety refusal, got: ${err.message}`);
      return true;
    });
  });
}

test('a hostile manifest cannot reach the filesystem through a plan', () => {
  const m = clone();
  m.architecture.capabilityModel.session.cookieName = 'sid"; globalThis.PWNED = 1; const x = "';
  const dest = makeDestination();
  try {
    const plan = createTransplantPlan(m, fingerprintProject(dest.root), { resolveConflicts: true });
    assert.equal(plan.status, 'blocked');
    assert.equal(plan.files.length, 0, 'no files may be emitted from an unsafe manifest');
    const result = applyTransplant(plan, dest.root);
    assert.equal(result.applied, false);
    assert.equal(fs.existsSync(path.join(dest.root, 'src/auth')), false);
  } finally { dest.cleanup(); }
});

test('a hostile module specifier cannot be written into an import statement', () => {
  const source = "import http from 'node:http';\nregisterHealthRoutes(app);\n";
  assert.throws(
    () => planEntrypointEdit(source, { routesModule: './auth/routes.js\'; globalThis.PWNED = 1; import x from \'./y.js' }),
    (err) => err.code === 'unsafe-manifest-value',
  );
});

test('legitimate values still emit, so the guards are not simply refusing everything', () => {
  const emission = emitSessionAuth(clone(), destFp);
  assert.equal(emission.files.length, 5);
  const sessions = emission.files.find((f) => f.path.endsWith('sessions.js')).contents;
  assert.match(sessions, /COOKIE_NAME = "sid"/);
});
