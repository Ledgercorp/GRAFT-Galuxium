import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../../core/src/analyze/fingerprint.js';
import { discoverCapabilities, harvestCapability } from '../../core/src/harvest/index.js';
import { writeManifest } from '../../core/src/manifest/io.js';
import { validateManifest } from '../../core/src/manifest/schema.js';
import { createTransplantPlan } from '../../core/src/plan/index.js';
import { applyTransplant } from '../../core/src/apply/index.js';
import { verifyCapability } from '../../core/src/verify/index.js';
import { bold, dim, green, yellow, red, cyan, heading, statusMark, verdictBanner, bullet } from './ui.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The whole vertical slice, end to end, on disposable copies of the fixtures.
 *
 * The destination is copied to a temp directory and given its own git repository, so
 * the demo can exercise the real safety path (branch, recovery point, receipt) without
 * touching anything the user owns.
 */
export async function runDemo(flags = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-demo-'));
  const sourceRoot = path.join(work, 'old-saas-project');
  const destRoot = path.join(work, 'new-startup');
  const previousHome = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = path.join(work, 'graft-home');
  try {
    copyDir(path.join(REPO, 'fixtures/old-saas-project'), sourceRoot);
    git(sourceRoot, ['init', '-q', '-b', 'main']);
    git(sourceRoot, ['add', '-A']);
    git(sourceRoot, ['-c', 'user.email=demo@graft.local', '-c', 'user.name=GRAFT demo', 'commit', '-q', '-m', 'source before verification']);

    copyDir(path.join(REPO, 'fixtures/new-startup'), destRoot);
    git(destRoot, ['init', '-q', '-b', 'main']);
    git(destRoot, ['add', '-A']);
    git(destRoot, ['-c', 'user.email=demo@graft.local', '-c', 'user.name=GRAFT demo', 'commit', '-q', '-m', 'destination project before transplant']);

    console.log(dim(`\n  workspace: ${work}`));

    // ---- 1. Projects -------------------------------------------------------
    heading('1. Projects');
    const srcFp = fingerprintProject(sourceRoot);
    const destFp0 = fingerprintProject(destRoot);
    bullet(`${bold(srcFp.name)}  ${dim(`${srcFp.moduleSystem.value} / ${srcFp.handlerContract.value} handlers / ${srcFp.persistence.value}`)}   ${dim('(source)')}`);
    bullet(`${bold(destFp0.name)}  ${dim(`${destFp0.moduleSystem.value} / ${destFp0.handlerContract.value} handlers / ${destFp0.persistence.value}`)}   ${dim('(destination)')}`);
    bullet(dim('the two projects are written in different idioms on purpose: a copy would not work.'));

    // ---- 2. Harvest --------------------------------------------------------
    heading('2. Harvest');
    const caps = discoverCapabilities(srcFp);
    console.log(`  ${bold(String(caps.length))} capabilities discovered in ${srcFp.name}`);
    for (const c of caps) {
      bullet(`${c.harvestable ? green('harvestable   ') : dim('discovery only')}  ${bold(c.displayName)}  ${dim(c.summary)}`);
    }

    // ---- 2b. Verify in source ---------------------------------------------
    heading('2b. Verify in source');
    console.log(dim(`  booting ${srcFp.name} (${srcFp.moduleSystem.value}/${srcFp.handlerContract.value}) and exercising the capability over HTTP before harvesting it...`));
    const { manifest, verification, policy } = await harvestCapability(srcFp, 'authentication');
    console.log('');
    for (const r of verification.results) {
      const mark = r.outcome === 'passed' ? green('pass') : r.outcome === 'failed' ? red('fail') : yellow('????');
      bullet(`${mark}  ${r.id}`);
      if (r.reason) bullet(red(r.reason), 8);
    }
    console.log('');
    console.log(`  ${bold(`${verification.summary.passed}/${verification.summary.required}`)} required acceptance tests passed against the running source`);
    console.log(`  ${verdictBanner(verification.verdict)}  ${dim(verification.rationale)}`);
    if (!policy.bankable) throw new Error('the source capability failed verification; GRAFT does not bank behavior it has watched fail');

    const validation = validateManifest(manifest);
    if (!validation.ok) throw new Error(`harvested manifest is invalid: ${validation.errors.join('; ')}`);
    const bank = path.join(process.env.GRAFT_HOME, 'organ-bank');
    const manifestDir = writeManifest(bank, manifest);

    // ---- 3. Feature manifest ----------------------------------------------
    heading('3. Feature manifest');
    bullet(`${bold(manifest.identity.name)}  ${dim(`v${manifest.identity.manifestVersion}`)}`);
    bullet(dim(path.relative(work, manifestDir)));
    const vis = manifest.provenance.verifiedInSource;
    bullet(`provenance: ${green(policy.label)} ${dim(`— ${vis.summary.passed}/${vis.summary.required} tests, runtime ${vis.runtime.profile}, source ${vis.sourceState.marker}, evidence in ${vis.evidence}`)}`);
    bullet(`behavior the manifest claims, each with evidence:`);
    for (const s of manifest.behavior.statements) bullet(dim(`- ${s.text}`), 6);
    bullet(`acceptance tests that will have to prove it: ${bold(String(manifest.acceptanceTests.tests.length))}`);
    bullet(`secrets recorded: ${green('none')} ${dim(`(env var names only: ${manifest.environment.variables.map((v) => v.name).join(', ') || 'none'})`)}`);

    // ---- 4. Destination analysis ------------------------------------------
    const destFp = fingerprintProject(destRoot);
    const plan = createTransplantPlan(manifest, destFp, { resolveConflicts: true });
    heading('4. Destination analysis');
    for (const c of plan.compatibility.checks) {
      console.log(`  ${statusMark(c.status)} ${bold(c.title)}`);
      bullet(dim(c.detail), 10);
    }

    // ---- 5. Transplant -----------------------------------------------------
    heading('5. Transplant');
    bullet(dim(plan.adaptation.note));
    const result = applyTransplant(plan, destRoot);
    if (result.refused) {
      for (const p of result.problems) console.log(`  ${red('refused')} ${p.message}`);
      throw new Error('demo transplant was refused');
    }
    bullet(`isolated on branch ${bold(result.branch)}  ${dim(`(recovery point ${result.recovery.headBefore.slice(0, 12)} on ${result.recovery.branchBefore})`)}`);
    for (const f of result.filesWritten) bullet(green('created  ') + f);
    for (const e of result.entrypointEdits) bullet(green('edited   ') + `${plan.destination.entrypoint} (${e.kind})`);
    for (const r of result.removedRoutes) bullet(yellow('disabled ') + `${r.key} ${dim('commented out in place, not deleted')}`);

    // ---- 6. Verify ---------------------------------------------------------
    heading('6. Verify');
    console.log(dim('  booting the destination application and exercising it over HTTP...'));
    const report = await verifyCapability(manifest, destRoot, { entrypoint: plan.destination.entrypoint });
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    receipt.verification = { verdict: report.verdict, rationale: report.rationale, summary: report.summary, at: report.finishedAt };
    fs.writeFileSync(result.receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    console.log('');
    for (const r of report.results) {
      const mark = r.outcome === 'passed' ? green('pass') : r.outcome === 'failed' ? red('fail') : yellow('????');
      bullet(`${mark}  ${r.id}`);
      if (r.reason) bullet(red(r.reason), 8);
    }
    console.log('');
    console.log(`  ${bold(`${report.summary.passed}/${report.summary.required}`)} required acceptance tests passed`);
    console.log(`  ${verdictBanner(report.verdict)}  ${dim(report.rationale)}`);
    if (report.verdict !== 'VERIFIED' && report.diagnostics?.stderr) {
      console.log(dim(`\n  server stderr:\n${report.diagnostics.stderr}`));
    }

    console.log('');
    console.log(dim(`  the transplanted project is at ${destRoot} (branch ${result.branch}); inspect it with: git -C ${destRoot} diff`));
    console.log(dim('  nothing outside that temporary workspace was touched.'));

    if (report.verdict !== 'VERIFIED') process.exitCode = 1;
    return { work, sourceRoot, destRoot, report, plan, manifest };
  } finally {
    if (previousHome === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previousHome;
  }
}
