import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSource, makeDestination, SOURCE_FIXTURE } from './helpers.js';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { projectFingerprint, inheritedLineage, recordCompatibilityObservation, inspectLocalCapability } from '../src/capability/knowledge.js';
import { harvestCapability } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { verifyCapability } from '../src/verify/index.js';
import { AGENT_INTERFACE, inspectAgentOperation } from '../src/capability/agent-interface.js';

test('project fingerprint ignores comments/formatting and local history but detects changed code', (t) => {
  const source = makeSource(); t.after(source.cleanup);
  const digest = () => projectFingerprint(fingerprintProject(source.root));
  const before = digest(), entry = path.join(source.root, 'server.js'), original = fs.readFileSync(entry, 'utf8');
  fs.writeFileSync(entry, '// an irrelevant comment\n\n' + original);
  assert.equal(digest(), before);
  fs.mkdirSync(path.join(source.root, '.graft'));
  fs.writeFileSync(path.join(source.root, '.graft', 'notes.js'), 'throw new Error("not application code");');
  assert.equal(digest(), before);
  fs.writeFileSync(entry, original + '\nthrow new Error("changed behavior");\n');
  assert.notEqual(digest(), before);
  fs.writeFileSync(entry, original);
  const packageFile = path.join(source.root, 'package.json'), pkg = JSON.parse(fs.readFileSync(packageFile));
  pkg.scripts = { ...pkg.scripts, start: 'node different-entrypoint.js' };
  fs.writeFileSync(packageFile, JSON.stringify(pkg));
  assert.notEqual(digest(), before, 'runtime package metadata must be bound to the source fingerprint');
});

test('history symlinks are ignored and never followed into an unrelated directory', (t) => {
  const source = makeSource(), outside = makeSource(); t.after(source.cleanup); t.after(outside.cleanup);
  fs.mkdirSync(path.join(source.root, '.graft'));
  fs.symlinkSync(outside.root, path.join(source.root, '.graft', 'compatibility'));
  assert.deepEqual(inheritedLineage(fingerprintProject(source.root), 'authentication').parents, []);
});

test('source fingerprint binds content to each file location', (t) => {
  const source = makeSource(); t.after(source.cleanup);
  const before = projectFingerprint(fingerprintProject(source.root));
  const a = path.join(source.root, 'server.js'), b = path.join(source.root, 'lib/users.js');
  const first = fs.readFileSync(a), second = fs.readFileSync(b);
  fs.writeFileSync(a, second); fs.writeFileSync(b, first);
  assert.notEqual(projectFingerprint(fingerprintProject(source.root)), before);
});

test('agent interface has only scoped operations and cannot accept submitted verdicts', () => {
  assert.deepEqual(Object.keys(AGENT_INTERFACE.operations).sort(), ['harvest', 'inspect', 'plan', 'search', 'transplant', 'verify']);
  assert.throws(() => inspectAgentOperation('submitVerdict'), /cannot submit verdicts/);
  assert.throws(() => inspectAgentOperation('__proto__'), /Unsupported/);
  assert.equal(inspectAgentOperation('verify').effect, 'execute-project');
  const copy = inspectAgentOperation('verify'); copy.input.push('VERIFIED');
  assert.ok(!inspectAgentOperation('verify').input.includes('VERIFIED'));
});

test('observed knowledge persists locally, deduplicates, and refuses an altered existing record', async (t) => {
  const dest = makeDestination(); t.after(dest.cleanup);
  const { manifest } = await harvestCapability(fingerprintProject(SOURCE_FIXTURE), 'authentication');
  const plan = createTransplantPlan(manifest, fingerprintProject(dest.root), { resolveConflicts: true });
  assert.equal(applyTransplant(plan, dest.root).applied, true);
  const fp = fingerprintProject(dest.root), report = await verifyCapability(manifest, dest.root);
  assert.equal(report.verdict, 'VERIFIED');
  assert.ok(report.compatibilityObservation);
  const event = recordCompatibilityObservation(manifest, fp, report);
  assert.equal(event.eventId, report.compatibilityObservation.eventId);
  const inspected = inspectLocalCapability(manifest, [dest.root, dest.root]);
  assert.equal(inspected.lineage.transplants.length, 1);
  assert.equal(inspected.lineage.transplants[0].verification.verdict, 'VERIFIED');
  const file = path.join(dest.root, '.graft/compatibility', event.eventId.slice(7) + '.json');
  const serialized = fs.readFileSync(file, 'utf8');
  assert.ok(!serialized.includes(dest.root) && !serialized.includes(SOURCE_FIXTURE));
  assert.ok(!serialized.includes('entrypointBefore') && !serialized.includes('fileContents'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // no POSIX modes on Windows
  fs.writeFileSync(file, JSON.stringify({ ...event, sourceFingerprint: 'altered' }));
  assert.throws(() => recordCompatibilityObservation(manifest, fp, report), /differs/);
  assert.equal(inspectLocalCapability(manifest, [dest.root]).lineage.transplants.length, 0);
});
