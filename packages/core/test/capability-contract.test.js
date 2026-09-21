import test from 'node:test';
import assert from 'node:assert/strict';
import { harvest } from '../src/harvest/index.js';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { SOURCE_FIXTURE } from './helpers.js';
import { canonicalSerialize, stableHash, architectureSignature, toCapabilityContract, validateCapabilityContract } from '../src/capability/contract.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest, readManifest, CAPABILITY_CONTRACT_FILE } from '../src/manifest/io.js';

const manifest = () => harvest(fingerprintProject(SOURCE_FIXTURE), 'authentication');

test('contract identity ignores file/section/set ordering, evidence and collection formatting', () => {
  const first = manifest(), second = structuredClone(first);
  second.identity.extractedAt = '2099-01-01T00:00:00Z';
  second.identity.sourceProject = 'renamed';
  second.sourceMap.files.reverse();
  second.sourceMap.files[0].sha256 = 'irrelevant-source-formatting';
  second.behavior.statements.reverse();
  second.behavior.statements[0].text = '  ' + second.behavior.statements[0].text.replaceAll(' ', '\n  ') + ' ';
  second.acceptanceTests.tests.reverse();
  second.interfaces.inbound.reverse();
  second.architecture.capabilityModel.endpoints.reverse();
  second.dataModel.entities.reverse();
  second.dataModel.entities.forEach((e) => e.fields.reverse());
  assert.equal(toCapabilityContract(first).capabilityId, toCapabilityContract(second).capabilityId);
  assert.equal(canonicalSerialize({ z: 2, a: { b: 1, a: 2 } }), canonicalSerialize({ a: { a: 2, b: 1 }, z: 2 }));
});

test('contract identity changes for behavior, cookie, data requirements and ordered HTTP steps', () => {
  const first = manifest();
  for (const mutate of [
    (m) => { m.behavior.statements[0].text = 'Different behavior'; },
    (m) => { m.architecture.capabilityModel.session.cookieName = 'other'; },
    (m) => { m.dataModel.entities[0].fields[0].type = 'INTEGER'; },
    (m) => { m.acceptanceTests.tests[1].steps.reverse(); },
  ]) {
    const second = structuredClone(first); mutate(second);
    assert.notEqual(toCapabilityContract(first).capabilityId, toCapabilityContract(second).capabilityId);
  }
});

test('contract versions and hash/evidence disagreements fail closed', () => {
  const m = manifest(), c = toCapabilityContract(m);
  assert.equal(validateCapabilityContract(c, m), c);
  assert.throws(() => validateCapabilityContract({ ...c, contractVersion: '2.0.0' }), /migration/);
  assert.throws(() => validateCapabilityContract({ ...c, capabilityId: 'fake' }), /hash mismatch/);
  assert.throws(() => validateCapabilityContract({ ...c, sourceFingerprint: 'sha256:' + '0'.repeat(64) }, m), /disagrees/);
  const empty = { ...c, requirements: {} };
  empty.capabilityId = stableHash({ contractVersion: empty.contractVersion, requirements: empty.requirements });
  assert.throws(() => validateCapabilityContract(empty), /structure/);
  assert.throws(() => canonicalSerialize({ value: undefined }), /finite JSON/);
  assert.throws(() => canonicalSerialize(NaN), /finite JSON/);
});

test('legacy organs load without mutation; explicit writes add a validated contract atomically', (t) => {
  const bank = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-contract-'));
  t.after(() => fs.rmSync(bank, { recursive: true, force: true }));
  const m = manifest(), organ = writeManifest(bank, m), file = path.join(organ, CAPABILITY_CONTRACT_FILE);
  assert.equal(JSON.parse(fs.readFileSync(file)).capabilityId, toCapabilityContract(m).capabilityId);
  fs.unlinkSync(file); // Model a legacy 0.4 package without the new section.
  assert.deepEqual(readManifest(organ), m);
  assert.equal(fs.existsSync(file), false);
  writeManifest(bank, m);
  const c = JSON.parse(fs.readFileSync(file)); c.contractVersion = '99.0.0';
  fs.writeFileSync(file, JSON.stringify(c));
  assert.throws(() => readManifest(organ), /migration/);
});

test('architecture knowledge does not retain dependency credentials or local paths', () => {
  const signature = architectureSignature({ dependencies: [
    { name: 'remote', range: 'git+https://user:private-token@host/repo.git' },
    { name: 'local', range: 'file:/Users/private-person/private-repo' },
    { name: 'express', range: '^5.2.1' },
  ] });
  const serialized = JSON.stringify(signature);
  for (const sensitive of ['private-token', '/Users/', 'private-person', 'repo.git', 'https:']) assert.ok(!serialized.includes(sensitive));
  assert.equal(signature.dependencies.find((d) => d.name === 'express').range, '^5.2.1');
  assert.ok(signature.dependencies.find((d) => d.name === 'remote').range.startsWith('opaque:sha256:'));
});
