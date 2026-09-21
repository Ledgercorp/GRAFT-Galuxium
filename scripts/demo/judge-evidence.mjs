// Local-only producer. Publish only packages/web/judge, never this process or its workspace.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDemo } from '../../packages/cli/src/demo.js';
import { verifyCapability } from '../../packages/core/src/verify/index.js';
import { discoverCapabilities } from '../../packages/core/src/harvest/index.js';
import { fingerprintProject } from '../../packages/core/src/analyze/fingerprint.js';
import { validateEvidence } from '../../packages/web/judge/evidence.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pick = (object, fields) => Object.fromEntries(fields.map((key) => [key, object[key]]));
function report(r) {
  return {
    ...pick(r, ['verdict', 'startedAt', 'finishedAt', 'summary']),
    envelopeDigest: r.proofEnvelope?.digest ?? null,
    tests: r.results.map((t) => ({ ...pick(t, ['id', 'description', 'required', 'outcome']),
      steps: t.steps.map((s) => ({ ...pick(s, ['name', 'request', 'status', 'ok']),
        checks: s.checks.map((c) => pick(c, ['name', 'ok'])) })) })),
  };
}

export async function captureEvidence(run) {
  const { sourceRoot, destRoot, plan, manifest } = run;
  const baseRevision = git(destRoot, 'rev-parse', 'HEAD');
  // Commit ONLY the disposable fixture, so destination verification has revision authority.
  fs.appendFileSync(path.join(destRoot, '.git/info/exclude'), '\n/.graft/\n');
  git(destRoot, 'add', '--', plan.destination.entrypoint, ...plan.files.map((f) => f.path));
  const diff = git(destRoot, 'diff', '--cached', '--no-ext-diff', '--no-color');
  git(destRoot, '-c', 'user.name=GRAFT demo', '-c', 'user.email=demo@graft.local', 'commit', '-qm', 'GRAFT fixture transplant');
  const previousHome = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = path.join(run.work, 'graft-home');
  let destinationReport;
  try { destinationReport = await verifyCapability(manifest, destRoot, { entrypoint: plan.destination.entrypoint }); }
  finally { if (previousHome === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previousHome; }
  const payload = {
    schemaVersion: 1,
    recordedAt: destinationReport.finishedAt,
    generator: { command: 'node scripts/demo/judge-evidence.mjs', graftRevision: git(repo, 'rev-parse', 'HEAD') },
    capability: { name: manifest.identity.name, slug: manifest.identity.slug,
      behaviors: manifest.behavior.statements.map((s) => pick(s, ['id', 'text'])) },
    source: { name: plan.source.project, fixture: 'fixtures/old-saas-project', shape: plan.source.shape,
      revision: git(sourceRoot, 'rev-parse', 'HEAD'),
      discovery: discoverCapabilities(fingerprintProject(sourceRoot)).map((c) => pick(c, ['id', 'displayName', 'harvestable', 'summary'])),
      signals: manifest.provenance.detectorSignals.map((s) => pick(s, ['id', 'evidence'])),
      verification: report(manifest.sourceVerificationReport) },
    destination: { name: plan.destination.project, fixture: 'fixtures/new-startup', shape: plan.destination.shape,
      baseRevision, revision: git(destRoot, 'rev-parse', 'HEAD'), entrypoint: plan.destination.entrypoint,
      verification: report(destinationReport) },
    plan: { status: plan.status, adaptation: plan.adaptation.note,
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
