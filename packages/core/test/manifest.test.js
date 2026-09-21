import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, findSecretLeaks, MANIFEST_VERSION } from '../src/manifest/schema.js';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { SOURCE_FIXTURE } from './helpers.js';

const manifest = () => harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');

test('a harvested manifest is structurally valid', () => {
  const result = validateManifest(manifest());
  assert.equal(result.ok, true, result.errors.join('; '));
});

test('a behavior claim without evidence is rejected', () => {
  const m = manifest();
  m.behavior.statements[0].evidence = [];
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /must cite evidence/);
});

test('a behavior with no acceptance test is rejected as unverifiable', () => {
  const m = manifest();
  m.acceptanceTests.tests = m.acceptanceTests.tests.filter((t) => t.provesBehavior !== 'auth.login');
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /has no acceptance test/);
});

test('environment variables may carry a name but never a value', () => {
  const m = manifest();
  m.environment.variables.push({ name: 'STRIPE_SECRET_KEY', value: 'sk-live-abc' });
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /manifests record names only/);
});

test('a manifest carrying a secret-shaped string is refused', () => {
  const m = manifest();
  m.security.notes.push('use sk-live-0123456789abcdefghij for the webhook');
  const result = validateManifest(m);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /possible secret value/);
});

test('secret detection walks nested structures', () => {
  const leaks = findSecretLeaks({ a: { b: ['AKIA0123456789ABCDEF'] } });
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].at, '$.a.b[0]');
});

test('the manifest version is pinned', () => {
  assert.equal(manifest().identity.manifestVersion, MANIFEST_VERSION);
});
