import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../packages/core/src/analyze/fingerprint.js';
import { harvestCapability } from '../packages/core/src/harvest/index.js';
import { createTransplantPlan } from '../packages/core/src/plan/index.js';
import { applyTransplant } from '../packages/core/src/apply/index.js';
import { verifyCapability } from '../packages/core/src/verify/index.js';
import { toCapabilityContract } from '../packages/core/src/capability/contract.js';
import { safeProjectPath } from '../packages/core/src/util/paths.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(fs.readFileSync(path.join(repo, 'bench/graftbench.json')));
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graftbench-'));
const rows = [], donors = new Map();
const check = (condition, message) => { if (!condition) throw new Error(message); };
const git = (root, args) => execFileSync('/usr/bin/git', args, { cwd: root, stdio: 'pipe' });
function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=GRAFTBench', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message]);
}
function copyFixture(fixture, name) {
  const root = path.join(work, name);
  fs.cpSync(safeProjectPath(repo, fixture), root, { recursive: true, filter: (f) => !['.git', 'node_modules'].includes(path.basename(f)) });
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (pkg.dependencies?.express) {
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  }
  git(root, ['init', '-qb', 'main']); commit(root, 'GRAFTBench recipient baseline');
  return root;
}
async function donor(id) {
  if (donors.has(id)) return donors.get(id);
  const definition = spec.donors[id]; check(definition, `Unknown donor: ${id}`);
  const root = copyFixture(definition.fixture, `donor-${id}`);
  if (definition.deriveFrom) {
    const parent = await donor(definition.deriveFrom);
    const plan = createTransplantPlan(parent.manifest, fingerprintProject(root), { resolveConflicts: true });
    const applied = applyTransplant(plan, root);
    check(applied.applied, `Donor setup refused: ${id}`);
    const observed = await verifyCapability(parent.manifest, root);
    check(observed.verdict === 'VERIFIED' && observed.compatibilityObservation, `Donor setup failed: ${id}: ${observed.rationale}`);
    commit(root, 'GRAFTBench derived donor verified');
  }
  const result = await harvestCapability(fingerprintProject(root), spec.capability);
  check(result.verification.verdict === 'VERIFIED', `Donor source failed: ${id}: ${result.verification.rationale}`);
  donors.set(id, { ...result, root }); return donors.get(id);
}
async function scenario(definition, mutation) {
  const row = { id: mutation ? `${definition.id}/${mutation.id}` : definition.id, donor: definition.donor,
    recipient: definition.recipient, mutation: mutation?.id || null, expectedCompatibility: definition.expectedCompatibility,
    expectedTransplant: mutation?.expectedVerdict || definition.expectedTransplant };
  try {
    const source = await donor(definition.donor);
    const root = copyFixture(spec.recipients[definition.recipient].fixture, `recipient-${rows.length}`);
    const before = git(root, ['rev-parse', 'HEAD']).toString().trim();
    const plan = createTransplantPlan(source.manifest, fingerprintProject(root), { resolveConflicts: definition.resolveConflicts === true });
    row.compatibility = plan.compatibilityKnowledge.result;
    row.reasons = plan.compatibilityKnowledge.reasons;
    const applied = applyTransplant(plan, root);
    if (!applied.applied) {
      row.verdict = 'REFUSED';
      check(git(root, ['status', '--porcelain']).toString() === '', 'Refusal modified a project');
      check(definition.expectedTransplant === 'REFUSED', `Unexpected refusal: ${JSON.stringify(applied.problems)}`);
      check(!definition.reason || row.reasons.some((r) => r.code === definition.reason && r.status !== 'ok'), 'Expected refusal reason absent');
    } else {
      check(applied.recovery.headBefore === before && applied.branch.startsWith('graft/'), 'Git recovery baseline lost');
      check(fs.existsSync(applied.receiptPath), 'Recovery receipt missing');
      if (mutation) {
        const file = safeProjectPath(root, mutation.file), contents = fs.readFileSync(file, 'utf8');
        check(contents.includes(mutation.from), `Mutation target missing: ${mutation.id}`);
        fs.writeFileSync(file, contents.replace(mutation.from, mutation.to));
      }
      const result = await verifyCapability(source.manifest, root, { timeoutMs: 3000, stepTimeoutMs: 2000 });
      row.verdict = result.verdict; row.summary = result.summary;
      row.processCleaned = true;
      if (result.process?.pid) {
        try { process.kill(result.process.pid, 0); row.processCleaned = false; }
        catch (err) { if (err.code !== 'ESRCH') throw err; }
      }
      row.evidence = result.results.map((r) => ({ id: r.id, outcome: r.outcome }));
      row.knowledgeRecorded = Boolean(result.compatibilityObservation) && !result.knowledgeRecordingError;
      if (mutation) row.mutationDetected = result.verdict === mutation.expectedVerdict
        && (!mutation.acceptanceTest || result.results.some((r) => r.id === mutation.acceptanceTest && r.outcome === 'failed'));
      check(row.knowledgeRecorded, result.knowledgeRecordingError || 'Compatibility observation missing');
      check(row.processCleaned, 'Owned child still alive');
      if (!mutation && result.verdict === 'VERIFIED') {
        // Re-harvest the new generation using independently observed behavior.
        const next = await harvestCapability(fingerprintProject(root), spec.capability);
        check(next.verification.verdict === 'VERIFIED', 'Re-harvested generation failed');
        const lineage = toCapabilityContract(next.manifest).lineage;
        row.lineageDepth = lineage.parents.length;
        check(row.lineageDepth === toCapabilityContract(source.manifest).lineage.parents.length + 1, 'Lineage generation lost');
      }
    }
    check(row.compatibility === row.expectedCompatibility, `Compatibility mismatch: ${row.compatibility}`);
    check(row.verdict === row.expectedTransplant, `Verdict mismatch: ${row.verdict}`);
    check(!mutation || row.mutationDetected, 'Required behavioral mutation detection missing');
    row.passed = true;
  } catch (err) { row.passed = false; row.error = err.message; }
  rows.push(row);
  console.log(`${row.passed ? 'PASS' : 'FAIL'} ${row.id}: ${row.verdict || 'ERROR'}${row.error ? ` — ${row.error}` : ''}`);
}
try {
  check(spec.schemaVersion === '1.0.0' && spec.capability === 'authentication', 'Unsupported benchmark specification');
  for (const definition of spec.scenarios) if (!only || only === definition.id) await scenario(definition);
  const baseline = spec.scenarios.find((s) => s.id === spec.mutationScenario);
  for (const mutation of spec.mutations) if (!only || only === `${baseline.id}/${mutation.id}`) await scenario(baseline, mutation);
  check(rows.length > 0, 'No benchmark scenario matched');
  const report = {
    schemaVersion: '1.0.0', benchmark: spec.name, engineVersion: '0.5.0', at: new Date().toISOString(), partial: Boolean(only),
    scenarioCount: rows.length, supportedScenarios: rows.filter((r) => !r.mutation && r.compatibility && r.compatibility !== 'refused' && r.expectedTransplant !== 'REFUSED').length,
    mutationScenarioCount: rows.filter((r) => r.mutation).length,
    verifiedSuccessfulTransplants: rows.filter((r) => !r.mutation && r.verdict === 'VERIFIED' && r.passed).length,
    correctlyRefusedScenarios: rows.filter((r) => r.verdict === 'REFUSED' && r.passed).length,
    falseSuccessCount: rows.filter((r) => r.verdict === 'VERIFIED' && (r.mutation || r.expectedTransplant !== 'VERIFIED')).length,
    failedMutationDetections: rows.filter((r) => r.mutation && !r.mutationDetected).length,
    failures: rows.filter((r) => !r.passed).length, rows,
  };
  const output = path.join(repo, only ? 'dist/graftbench-focused.json' : 'dist/graftbench-report.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, rows: undefined }));
  if (report.failures || report.falseSuccessCount || report.failedMutationDetections) process.exitCode = 1;
} finally { fs.rmSync(work, { recursive: true, force: true }); }
