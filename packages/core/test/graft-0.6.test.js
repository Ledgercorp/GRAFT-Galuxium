import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COMPATIBILITY_STATES, compatibilityPreview } from '../src/plan/preview.js';
import { DATA_CLASSES, EGRESS_DECISIONS, createCustodyLedger, loadCustodyEvents, requestEgress } from '../src/agent/data-boundary.js';
import { findRememberedCapabilities, rememberCapability, recordCapabilityMemoryObservation } from '../src/capability/memory.js';
import { blueprintAgentsMd, exportBlueprintAgentsMd } from '../src/export/agents-md.js';
import { createAgentRuntime } from '../src/agent/runtime.js';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { createTransplantPlan } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { makeDestination, SOURCE_FIXTURE } from './helpers.js';

test('compatibility preview makes correct refusal explicit', () => {
  assert.equal(compatibilityPreview({ status: 'ok', checks: [] }).state, COMPATIBILITY_STATES.COMPATIBLE);
  assert.equal(compatibilityPreview({ status: 'warn', checks: [{ id: 'dependency', status: 'warn' }] }).state, COMPATIBILITY_STATES.ADAPTABLE);
  const preview = compatibilityPreview({ status: 'block', checks: [{ id: 'route', status: 'block', title: 'Route occupied' }] });
  assert.equal(preview.state, COMPATIBILITY_STATES.INCOMPATIBLE);
  assert.equal(preview.transplantAllowed, false);
});

test('an incompatible real host is refused before any adaptation can mutate it', async () => {
  const destination = makeDestination();
  try {
    fs.mkdirSync(path.join(destination.root, 'src/auth'), { recursive: true });
    const existing = path.join(destination.root, 'src/auth/routes.js');
    fs.writeFileSync(existing, 'export const ownedByDestination = true;\n');
    const before = fs.readFileSync(existing, 'utf8');
    const { manifest } = await harvestCapability(fingerprintProject(SOURCE_FIXTURE), 'authentication', { verify: true });
    const plan = createTransplantPlan(manifest, fingerprintProject(destination.root));
    assert.equal(plan.compatibility.preview.state, COMPATIBILITY_STATES.INCOMPATIBLE);
    assert.ok(plan.compatibility.preview.reasons.some((reason) => reason.id === 'files.collision'));
    const result = applyTransplant(plan, destination.root, { allowDirty: true });
    assert.equal(result.refused, true);
    assert.equal(fs.readFileSync(existing, 'utf8'), before);
  } finally { destination.cleanup(); }
});

test('data boundary denies source excerpts before an adapter can receive them and records only metadata', () => {
  const ledger = createCustodyLedger();
  const denied = requestEgress({ provider: 'test', operation: 'adapt', destination: 'https://example.test', dataClass: DATA_CLASSES.SOURCE_EXCERPT, sourceDerived: true, input: 'const secret = "nope";' });
  assert.equal(denied.decision, EGRESS_DECISIONS.DENY);
  ledger.record(denied);
  const event = ledger.list()[0];
  assert.equal(event.dataClass, DATA_CLASSES.SOURCE_EXCERPT);
  assert.ok(event.inputFingerprint.startsWith('sha256:'));
  assert.equal(JSON.stringify(event).includes('const secret'), false);
  assert.equal(JSON.stringify(event).includes('nope'), false);
});

test('allowed metadata egress produces an auditable custody event', () => {
  const allowed = requestEgress({ provider: 'test', operation: 'explain', destination: 'https://example.test', dataClass: DATA_CLASSES.METADATA, input: { capability: 'auth', revision: 'abc' } });
  assert.equal(allowed.decision, EGRESS_DECISIONS.ALLOW);
  assert.equal(allowed.event.executionLocation, 'local');
  assert.equal(allowed.event.sourceDerived, false);
});

test('generated derivatives follow the configured policy rather than bypassing the boundary', () => {
  const denied = requestEgress({ provider: 'test', operation: 'adapt', destination: 'https://example.test', dataClass: DATA_CLASSES.GENERATED_DERIVATIVE, sourceDerived: true, input: 'generated from local context' });
  assert.equal(denied.decision, EGRESS_DECISIONS.DENY);
  const allowed = requestEgress({ provider: 'test', operation: 'adapt', destination: 'https://example.test', dataClass: DATA_CLASSES.GENERATED_DERIVATIVE, sourceDerived: true, policyContext: { allowedDataClasses: [DATA_CLASSES.GENERATED_DERIVATIVE] }, input: 'generated from local context' });
  assert.equal(allowed.decision, EGRESS_DECISIONS.ALLOW);
});

test('persistent custody contains policy metadata but no source or credentials', () => {
  const previous = process.env.GRAFT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-custody-'));
  process.env.GRAFT_HOME = home;
  try {
    const ledger = createCustodyLedger({ persist: true });
    ledger.record(requestEgress({ provider: 'test', operation: 'adapt', destination: 'https://example.test', dataClass: DATA_CLASSES.METADATA, input: { token: 'not-persisted', source: 'const hidden = true;' } }));
    const stored = JSON.stringify(loadCustodyEvents());
    assert.equal(stored.includes('not-persisted'), false);
    assert.equal(stored.includes('const hidden'), false);
    assert.equal(loadCustodyEvents()[0].dataClass, DATA_CLASSES.METADATA);
  } finally {
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a denied egress never calls the external provider', async () => {
  let calls = 0;
  const agent = createAgentRuntime({ provider: 'anthropic', apiKey: 'test-key', fetchImpl: async () => { calls += 1; throw new Error('should not run'); } });
  await assert.rejects(
    agent.run('interpretCapabilityRequest', { request: 'find login', workspace: [{ language: 'javascript', runtime: 'node' }] }, { egress: { dataClass: DATA_CLASSES.SOURCE_EXCERPT, sourceDerived: true } }),
    (error) => error.code === 'egress-denied',
  );
  assert.equal(calls, 0);
  assert.equal(agent.custodyEvents()[0].decision, EGRESS_DECISIONS.DENY);
});

test('Capability Memory is local, revision-bound, and remains readable offline', () => {
  const previous = process.env.GRAFT_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-memory-'));
  process.env.GRAFT_HOME = home;
  try {
    const entry = rememberCapability({ capabilityId: 'sha256:capability', sourceRevision: 'abc123', sourceFingerprint: 'sha256:source', behavioralContract: { verdict: 'VERIFIED' } });
    assert.equal(findRememberedCapabilities('sha256:capability').length, 1);
    assert.equal(entry.sourceRevision, 'abc123');
    const observed = recordCapabilityMemoryObservation({ capabilityId: 'sha256:capability', sourceRevision: 'abc123', sourceFingerprint: 'sha256:source', observation: { kind: 'refusal', outcome: 'refused' } });
    assert.equal(observed.observations[0].kind, 'refusal');
    assert.equal(fs.existsSync(path.join(home, 'capability-memory.json')), true);
  } finally {
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('AGENTS.md export is deterministic and excludes source material', () => {
  const blueprint = { id: 'blueprint-1', capability: { slug: 'session-auth' }, source: { project: 'source' }, destination: { project: 'destination' }, compatibility: { checks: [{ status: 'warn', title: 'Dependency required', detail: 'Install express.' }] }, steps: [{ type: 'verify', title: 'Run contract tests' }] };
  const first = blueprintAgentsMd(blueprint);
  assert.equal(first, blueprintAgentsMd(blueprint));
  assert.ok(first.includes('Run contract tests'));
  assert.equal(first.includes('raw source'), false);
});

test('AGENTS.md export uses a safe alternate file when a destination already has one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-agents-'));
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Existing\n');
    const result = exportBlueprintAgentsMd({ id: 'blueprint-1', capability: { slug: 'session-auth' }, compatibility: { checks: [] } }, root);
    assert.equal(result.alternate, true);
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Existing\n');
    assert.ok(fs.readFileSync(result.path, 'utf8').includes('session-auth'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
