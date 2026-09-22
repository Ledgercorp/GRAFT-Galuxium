// Local-only producer. Publish only packages/web/judge, never this process or its workspace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDemo } from '../../packages/cli/src/demo.js';
import { verifyCapability } from '../../packages/core/src/verify/index.js';
import { sourceRevisionOf } from '../../packages/core/src/verify/proof-envelope.js';
import { discoverCapabilities } from '../../packages/core/src/harvest/index.js';
import { fingerprintProject } from '../../packages/core/src/analyze/fingerprint.js';
import { createTransplantPlan } from '../../packages/core/src/plan/index.js';
import { COMPATIBILITY_STATES } from '../../packages/core/src/plan/preview.js';
import { applyTransplant } from '../../packages/core/src/apply/index.js';
import { toCapabilityContract } from '../../packages/core/src/capability/contract.js';
import { findRememberedCapabilities, rememberCapability, recordCapabilityMemoryObservation } from '../../packages/core/src/capability/memory.js';
import { DATA_CLASSES, createCustodyLedger, loadCustodyEvents, requestEgress } from '../../packages/core/src/agent/data-boundary.js';
import { blueprintAgentsMd, exportBlueprintAgentsMd } from '../../packages/core/src/export/agents-md.js';
import { makeDestination } from '../../packages/core/test/helpers.js';
import { validateEvidence } from '../../packages/web/judge/evidence.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pick = (object, fields) => Object.fromEntries(fields.map((key) => [key, object[key]]));
const evidenceType = (kind) => kind === 'build' ? 'BUILD' : kind === 'unit' ? 'UNIT' : kind === 'integration' ? 'INTEGRATION' : 'BEHAVIORAL_CONTRACT';
const preview = (value) => ({ state: value.state, transplantAllowed: value.transplantAllowed,
  reasons: value.reasons.map((reason) => pick(reason, ['id', 'status', 'title', 'detail'])) });

function report(r) {
  return {
    ...pick(r, ['verdict', 'startedAt', 'finishedAt', 'summary']),
    envelopeDigest: r.proofEnvelope?.digest ?? null,
    tests: r.results.map((t) => ({ ...pick(t, ['id', 'description', 'required', 'outcome']), evidenceType: evidenceType(t.kind),
      steps: t.steps.map((s) => ({ ...pick(s, ['name', 'request', 'status', 'ok']),
        checks: s.checks.map((c) => pick(c, ['name', 'ok'])) })) })),
  };
}

export async function captureEvidence(run) {
  const { sourceRoot, destRoot, plan, manifest } = run;
  const baseRevision = git(destRoot, 'rev-parse', 'HEAD');
  // Commit only the disposable fixture, so destination verification has revision authority.
  fs.appendFileSync(path.join(destRoot, '.git/info/exclude'), '\n/.graft/\n');
  git(destRoot, 'add', '--', plan.destination.entrypoint, ...plan.files.map((f) => f.path));
  const diff = git(destRoot, 'diff', '--cached', '--no-ext-diff', '--no-color');
  git(destRoot, '-c', 'user.name=GRAFT demo', '-c', 'user.email=demo@graft.local', 'commit', '-qm', 'GRAFT fixture transplant');

  const previousHome = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = path.join(run.work, 'graft-home');
  const compatibleFixture = makeDestination();
  const incompatibleFixture = makeDestination();
  try {
    const destinationReport = await verifyCapability(manifest, destRoot, { entrypoint: plan.destination.entrypoint });
    const sourceRevision = sourceRevisionOf(manifest) || git(sourceRoot, 'rev-parse', 'HEAD');
    const sourceFingerprint = manifest.provenance.capabilitySource.fingerprint;
    const capabilityId = toCapabilityContract(manifest).capabilityId;

    const identity = { capabilityId, sourceRevision, sourceFingerprint };
    let remembered = rememberCapability({ ...identity, slug: manifest.identity.slug,
      behavioralContract: manifest.behavior.statements, sourceVerification: manifest.provenance.verifiedInSource,
      rememberedAt: destinationReport.finishedAt });
    remembered = recordCapabilityMemoryObservation({ ...identity,
      observation: { kind: 'compatibility', state: plan.compatibility.preview.state, destination: plan.destination.project, at: destinationReport.finishedAt } });
    remembered = recordCapabilityMemoryObservation({ ...identity,
      observation: { kind: 'transplant', state: destinationReport.verdict, destination: plan.destination.project, at: destinationReport.finishedAt } });

    const compatibleEntrypoint = path.join(compatibleFixture.root, 'src/main.js');
    const occupiedRoute = "app.post('/auth/login', async () => ({ status: 501, body: { error: 'auth_not_implemented' } }));\n";
    const compatibleSource = fs.readFileSync(compatibleEntrypoint, 'utf8');
    if (!compatibleSource.includes(occupiedRoute)) throw new Error('Compatible fixture route marker is missing.');
    fs.writeFileSync(compatibleEntrypoint, compatibleSource.replace(occupiedRoute, occupiedRoute.replace('/auth/login', '/legacy/login')));
    const compatiblePlan = createTransplantPlan(manifest, fingerprintProject(compatibleFixture.root));
    if (compatiblePlan.compatibility.preview.state !== COMPATIBILITY_STATES.COMPATIBLE) throw new Error('Compatible fixture did not classify COMPATIBLE.');

    const collision = path.join(incompatibleFixture.root, 'src/auth/routes.js');
    fs.mkdirSync(path.dirname(collision), { recursive: true });
    const collisionContent = 'export const ownedByDestination = true;\n';
    fs.writeFileSync(collision, collisionContent);
    const incompatiblePlan = createTransplantPlan(manifest, fingerprintProject(incompatibleFixture.root));
    if (incompatiblePlan.compatibility.preview.state !== COMPATIBILITY_STATES.INCOMPATIBLE) throw new Error('Incompatible fixture did not classify INCOMPATIBLE.');
    const beforeRefusal = { content: fs.readFileSync(collision, 'utf8'), head: git(incompatibleFixture.root, 'rev-parse', 'HEAD'), status: git(incompatibleFixture.root, 'status', '--porcelain') };
    const refusal = applyTransplant(incompatiblePlan, incompatibleFixture.root, { allowDirty: true });
    const afterRefusal = { content: fs.readFileSync(collision, 'utf8'), head: git(incompatibleFixture.root, 'rev-parse', 'HEAD'), status: git(incompatibleFixture.root, 'status', '--porcelain') };
    if (!refusal.refused || JSON.stringify(beforeRefusal) !== JSON.stringify(afterRefusal)) throw new Error('Incompatible fixture was not refused before mutation.');
    remembered = recordCapabilityMemoryObservation({ ...identity,
      observation: { kind: 'refusal', state: incompatiblePlan.compatibility.preview.state, destination: 'new-startup-existing-auth', at: destinationReport.finishedAt } });

    const agentsRoot = path.join(run.work, 'agents-export');
    fs.mkdirSync(agentsRoot);
    fs.writeFileSync(path.join(agentsRoot, 'AGENTS.md'), '# Existing destination instructions\n');
    const handoff = exportBlueprintAgentsMd(plan, agentsRoot);
    const handoffContent = blueprintAgentsMd(plan);
    if (handoff.content !== handoffContent) throw new Error('Blueprint handoff is not deterministic.');

    const ledger = createCustodyLedger({ persist: true });
    ledger.record(requestEgress({ provider: 'fixture-provider', operation: 'describe-capability', destination: 'https://fixture.invalid',
      dataClass: DATA_CLASSES.METADATA, input: { capabilityId, sourceRevision }, at: destinationReport.finishedAt }));
    ledger.record(requestEgress({ provider: 'fixture-provider', operation: 'adapt-source', destination: 'https://fixture.invalid',
      dataClass: DATA_CLASSES.SOURCE_EXCERPT, sourceDerived: true,
      policyContext: { allowedDataClasses: [DATA_CLASSES.METADATA] }, input: 'fixture source excerpt', at: destinationReport.finishedAt }));
    const custodyEvents = loadCustodyEvents();
    if (custodyEvents.length !== 2 || custodyEvents[1].decision !== 'DENY') throw new Error('Custody fixture did not persist the expected decisions.');

    const reloaded = findRememberedCapabilities(capabilityId).find((entry) => entry.memoryId === remembered.memoryId);
    const payload = {
      schemaVersion: 2,
      recordedAt: destinationReport.finishedAt,
      generator: { command: 'node scripts/demo/judge-evidence.mjs', graftRevision: process.env.GRAFT_EVIDENCE_REVISION || git(repo, 'rev-parse', 'HEAD') },
      capability: { name: manifest.identity.name, slug: manifest.identity.slug,
        behaviors: manifest.behavior.statements.map((s) => pick(s, ['id', 'text'])) },
      memory: { memoryId: remembered.memoryId, capabilityId, sourceRevision, sourceFingerprint,
        verification: remembered.sourceVerification.verdict, localOnly: true, persisted: Boolean(reloaded),
        observations: remembered.observations.map((item) => pick(item, ['kind', 'state', 'destination', 'at'])) },
      source: { name: plan.source.project, fixture: 'fixtures/old-saas-project', shape: plan.source.shape,
        revision: git(sourceRoot, 'rev-parse', 'HEAD'),
        discovery: discoverCapabilities(fingerprintProject(sourceRoot)).map((c) => pick(c, ['id', 'displayName', 'harvestable', 'summary'])),
        signals: manifest.provenance.detectorSignals.map((s) => pick(s, ['id', 'evidence'])),
        verification: report(manifest.sourceVerificationReport) },
      compatibility: {
        compatible: preview(compatiblePlan.compatibility.preview),
        adaptable: preview(plan.compatibility.preview),
        incompatible: preview(incompatiblePlan.compatibility.preview),
      },
      incompatibleRefusal: { fixture: 'fixtures/new-startup-existing-auth', state: incompatiblePlan.compatibility.preview.state,
        reasons: incompatiblePlan.compatibility.preview.reasons.map((reason) => pick(reason, ['id', 'status', 'title', 'detail'])),
        transplantAttempted: true, refused: refusal.refused, destinationMutated: false, existingFilePreserved: fs.readFileSync(collision, 'utf8') === collisionContent },
      destination: { name: plan.destination.project, fixture: 'fixtures/new-startup', shape: plan.destination.shape,
        baseRevision, revision: git(destRoot, 'rev-parse', 'HEAD'), entrypoint: plan.destination.entrypoint,
        verification: report(destinationReport) },
      blueprint: { filename: path.basename(handoff.path), alternate: handoff.alternate,
        existingAgentsProtected: fs.readFileSync(path.join(agentsRoot, 'AGENTS.md'), 'utf8') === '# Existing destination instructions\n',
        deterministic: handoff.content === handoffContent, content: handoffContent },
      custody: { externalCallPerformed: false, sourceDerivedEgress: false,
        statement: 'No source-derived material left this machine.',
        events: custodyEvents.map((event) => ({ ...pick(event, ['provider', 'operation', 'destination', 'executionLocation', 'sourceDerived', 'dataClass', 'decision', 'reason', 'inputFingerprint', 'timestamp', 'bytesOrItemCount']), policy: event.policy })) },
      plan: { status: plan.status, previewState: plan.compatibility.preview.state, adaptation: plan.adaptation.note,
        checks: plan.compatibility.checks.map((c) => pick(c, ['id', 'status', 'title', 'detail'])),
        conflictResolutionApproved: plan.conflicts.resolutionApproved,
        steps: plan.steps.map((s) => pick(s, ['order', 'kind', 'description'])),
        files: plan.files.map((f) => ({ path: f.path, sha256: hash(fs.readFileSync(path.join(destRoot, f.path))) })) },
      diff,
    };
    // Round-trip drops undefined optional fields; strict public schema rejects everything else.
    const clean = JSON.parse(JSON.stringify(payload));
    validateEvidence(clean);
    const envelope = { sha256: hash(JSON.stringify(clean)), payload: clean };
    fs.writeFileSync(path.join(repo, 'packages/web/judge/evidence.json'), JSON.stringify(envelope, null, 2) + '\n');
    return envelope;
  } finally {
    compatibleFixture.cleanup();
    incompatibleFixture.cleanup();
    if (previousHome === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previousHome;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let run;
  try {
    run = await runDemo();
    const result = await captureEvidence(run);
    console.log(`Public evidence validated: ${result.sha256}`);
  } finally {
    if (run) fs.rmSync(run.work, { recursive: true, force: true });
  }
}
