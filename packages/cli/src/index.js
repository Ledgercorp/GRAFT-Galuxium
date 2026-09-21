#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintProject } from '../../core/src/analyze/fingerprint.js';
import { discoverCapabilities, harvestCapability, harvestPolicy } from '../../core/src/harvest/index.js';
import { writeManifest, readManifest, listOrganBank } from '../../core/src/manifest/io.js';
import { createTransplantPlan } from '../../core/src/plan/index.js';
import { applyTransplant, inspectRepo } from '../../core/src/apply/index.js';
import { verifyCapability } from '../../core/src/verify/index.js';
import { renderSemanticSummary } from '../../core/src/engine/semantic.js';
import { addProject, loadRegistry, resolveProject, bankDir, graftHome, recordTransplant } from '../../core/src/registry/index.js';
import { bold, dim, green, yellow, red, cyan, heading, statusMark, verdictBanner, bullet } from './ui.js';
import { commands, parseArgs } from './args.js';

function fail(message) { console.error(red('error: ') + message); process.exitCode = 1; }

function printCapabilities(caps) {
  console.log(`${bold(String(caps.length))} capabilit${caps.length === 1 ? 'y' : 'ies'} discovered`);
  for (const c of caps) {
    const tag = c.harvestable ? green('harvestable') : dim('discovery only');
    bullet(`${bold(c.displayName)}  ${dim(c.summary)}  [${tag}, confidence ${c.confidence}]`);
    if (!c.harvestable) bullet(dim(`  ${c.notHarvestableReason}`), 2);
  }
}

// ---------------------------------------------------------------- commands

function cmdAdd(positional) {
  const target = positional[0];
  if (!target) return fail('usage: graft add <path-to-project>');
  if (!fs.statSync(target).isDirectory()) return fail(`project must be a directory: ${target}`);
  const fp = fingerprintProject(target);
  const { project, added } = addProject(target);
  console.log(`${added ? green('added') : dim('already known')} ${bold(project.name)}  ${dim(project.root)}`);
  bullet(dim(`${fp.framework.value} / ${fp.moduleSystem.value} / ${fp.handlerContract.value} handlers / ${fp.persistence.value}`));
}

function cmdProjects() {
  const registry = loadRegistry();
  heading('Projects');
  if (!registry.projects.length) return console.log(dim('  none yet. add one with: graft add <path>'));
  for (const p of registry.projects) {
    const exists = fs.existsSync(p.root);
    bullet(`${bold(p.name)}  ${dim(p.root)}${exists ? '' : red('  (missing)')}`);
  }
  console.log(dim(`\n  registry: ${graftHome()}`));
}

async function cmdHarvest(positional, flags) {
  const target = positional[0];
  if (!target) return fail('usage: graft harvest <project> [--capability <id>] [--no-verify-source] [--bank-unverified]');
  const root = resolveProject(target);
  const fp = fingerprintProject(root);

  heading(`Harvest — ${fp.name}`);
  const caps = discoverCapabilities(fp);
  printCapabilities(caps);
  if (!flags.capability) {
    console.log(dim('\n  harvest one with: graft harvest ' + target + ' --capability authentication'));
    return;
  }

  const shouldVerify = !flags['no-verify-source'];
  if (shouldVerify) {
    heading('Verify in source');
    console.log(dim(`  booting ${fp.name} and exercising the capability over HTTP before harvesting it...`));
  }
  const { manifest, verification, policy } = await harvestCapability(fp, String(flags.capability), { verifySource: shouldVerify });
  if (verification) printSourceVerification(verification);
  else bullet(yellow('source verification skipped; the manifest will say the capability is not proven'));

  if (!policy.bankable && !flags['bank-unverified']) {
    heading('Not harvested');
    console.log(`  ${red('x')} ${bold('The capability failed verification in its own source project.')}`);
    bullet(dim('GRAFT does not bank behavior it has watched fail. Fix the source and re-run, or pass --bank-unverified to keep a FAILED manifest for inspection.'), 4);
    process.exitCode = 1;
    return;
  }

  const dir = flags.out ? String(flags.out) : bankDir();
  fs.mkdirSync(dir, { recursive: true });
  const written = writeManifest(dir, manifest);

  heading(`Manifest — ${manifest.identity.name}`);
  bullet(`source status: ${policyLabel(policy)}`);
  bullet(`${manifest.behavior.statements.length} behavior statements, each backed by evidence`);
  for (const s of manifest.behavior.statements) bullet(dim(`- ${s.id}: ${s.text}`), 4);
  bullet(`${manifest.acceptanceTests.tests.length} acceptance tests will prove them after transplant`);
  bullet(`environment variables recorded by name only: ${manifest.environment.variables.map((v) => v.name).join(', ') || 'none'}`);
  console.log(`\n  ${green('written')} ${written}`);
}

function policyLabel(policy) {
  if (policy.status === 'verified') return green(policy.label);
  if (policy.status === 'failed') return red(policy.label);
  return yellow(policy.label);
}

function printSourceVerification(report) {
  console.log('');
  for (const r of report.results) {
    const mark = r.outcome === 'passed' ? green('pass') : r.outcome === 'failed' ? red('fail') : yellow('????');
    bullet(`${mark}  ${r.id}`);
    if (r.reason) bullet(red(r.reason), 8);
  }
  if (report.results.length) {
    console.log('');
    console.log(`  ${bold(`${report.summary.passed}/${report.summary.required}`)} required acceptance tests passed against the running source`);
  }
  console.log(`  ${verdictBanner(report.verdict)}  ${dim(report.rationale)}`);
  if (report.verdict !== 'VERIFIED' && report.diagnostics?.stderr) console.log(dim(`\n  source stderr:\n${report.diagnostics.stderr}`));
}

function cmdBank() {
  heading('Organ Bank');
  const entries = listOrganBank(bankDir());
  if (!entries.length) return console.log(dim('  empty. harvest something first.'));
  for (const entry of entries) {
    if (entry.error) { bullet(red(`${path.basename(entry.dir)} — unreadable: ${entry.error}`)); continue; }
    const m = entry.manifest;
    console.log('');
    bullet(bold(m.identity.name));
    bullet(dim(`source: ${m.identity.sourceProject}`), 4);
    const vis = m.provenance.verifiedInSource;
    const policy = harvestPolicy(vis?.verdict);
    bullet(`status: ${policyLabel(policy)}${vis?.sourceState?.marker ? dim(`  (source ${vis.sourceState.marker})`) : ''}`, 4);
    if (policy.status !== 'verified' && vis?.rationale) bullet(dim(vis.rationale), 6);
    bullet(dim('includes:'), 4);
    for (const s of m.behavior.statements) bullet(dim(`- ${s.text}`), 6);
    if (m.behavior.notFound?.length) bullet(dim(`not included: ${m.behavior.notFound.join(', ')}`), 4);
  }
}

function loadManifestBySlug(slug) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) throw new Error('capability must be a bank name containing only letters, numbers, hyphens, or underscores');
  const dir = path.join(bankDir(), `${slug}.graft`);
  try { return readManifest(dir); }
  catch (err) {
    if (err.code === 'ENOENT' && !fs.existsSync(dir)) throw new Error(`no harvested capability "${slug}" in the organ bank (${bankDir()})`);
    throw err;
  }
}

function buildPlan(slug, destArg, flags) {
  const manifest = loadManifestBySlug(slug);
  const destRoot = resolveProject(destArg);
  const destFp = fingerprintProject(destRoot);
  const plan = createTransplantPlan(manifest, destFp, { atlas: 'local',
    dir: flags.dir ? String(flags.dir) : 'src/auth',
    resolveConflicts: Boolean(flags['resolve-conflicts']),
  });
  return { manifest, destRoot, destFp, plan };
}

function printCompatibility(plan) {
  heading(`Compatibility — ${plan.capability.name} into ${plan.destination.project}`);
  for (const c of plan.compatibility.checks) {
    console.log(`  ${statusMark(c.status)} ${bold(c.title)}`);
    bullet(dim(c.detail), 10);
    if (c.remedy) bullet(dim(`remedy: ${c.remedy}`), 10);
  }
  console.log('');
  bullet(`${dim('adaptation:')} ${plan.adaptation.note}`);
}

function cmdPlan(positional, flags) {
  const [slug, ] = positional;
  const dest = flags.to || positional[1];
  if (!slug || !dest) return fail('usage: graft plan <capability> --to <destination>');
  const { plan } = buildPlan(slug, String(dest), flags);
  printCompatibility(plan);
  if (plan.semantic) {
    heading('What GRAFT understands');
    for (const line of renderSemanticSummary(plan.semantic)) bullet(line.startsWith('Risk') ? yellow(line) : line);
  }
  heading('Transplant plan');
  for (const step of plan.steps) {
    const approval = step.requiresExplicitApproval ? (step.approved ? green(' [approved]') : yellow(' [needs --resolve-conflicts]')) : '';
    bullet(`${step.order}. ${step.description}${approval}`);
  }
  console.log('');
  bullet(`${dim('status:')} ${plan.status === 'ready' ? green(plan.status) : yellow(plan.status)}`);
  if (flags.json) {
    const out = flags.json === true ? 'graft-plan.json' : flags.json;
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
    console.log(dim(`  full plan (including agentBrief) written to ${out}`));
  }
  if (plan.status !== 'ready') process.exitCode = 1;
}

async function cmdTransplant(positional, flags) {
  const slug = positional[0];
  const dest = flags.to || positional[1];
  if (!slug || !dest) return fail('usage: graft transplant <capability> --to <destination> [--resolve-conflicts]');
  const { manifest, destRoot, plan } = buildPlan(slug, String(dest), flags);

  printCompatibility(plan);

  const opts = {
    allowDirty: Boolean(flags['allow-dirty']),
    allowNoGit: Boolean(flags['allow-no-git']),
    allowNestedRepo: Boolean(flags['allow-nested-repo']),
    dryRun: Boolean(flags['dry-run']),
    branch: flags.branch ? String(flags.branch) : null,
  };

  heading('Safety');
  const repo = inspectRepo(destRoot);
  bullet(`git repository: ${repo.isRepo ? green('yes') : red('no')}${repo.isRepo ? dim(`  (${repo.root})`) : ''}`);
  if (repo.isRepo) {
    bullet(`branch: ${bold(repo.branch)}   HEAD: ${dim(repo.head ? repo.head.slice(0, 12) : 'none')}`);
    bullet(`working tree: ${repo.dirty ? yellow(`${repo.dirtyFiles.length} uncommitted change(s)`) : green('clean')}`);
  }

  const result = applyTransplant(plan, destRoot, opts);

  if (result.refused) {
    heading('Refused');
    for (const p of result.problems) {
      console.log(`  ${red('x')} ${bold(p.message)}`);
      bullet(dim(`remedy: ${p.remedy}`), 6);
    }
    process.exitCode = 1;
    return;
  }
  if (result.dryRun) {
    heading('Dry run — nothing was written');
    for (const f of result.wouldWrite) bullet(dim(`would create ${f}`));
    for (const e of result.entrypointEdits) bullet(dim(`would ${e.kind} in ${plan.destination.entrypoint}`));
    return;
  }

  heading('Transplanted');
  if (result.branch) bullet(`isolated on branch ${bold(result.branch)}`);
  for (const f of result.filesWritten) bullet(green(`created  `) + f);
  for (const e of result.entrypointEdits) bullet(green(`edited   `) + `${plan.destination.entrypoint} (${e.kind})`);
  for (const r of result.removedRoutes) bullet(yellow(`disabled `) + `${r.key} (commented out, not deleted, at line ${r.line})`);
  bullet(dim(`receipt: ${path.relative(destRoot, result.receiptPath)}`));
  bullet(dim(`rollback: ${result.recovery.rollback}`));

  recordTransplant({ planId: plan.id, capability: slug, destination: destRoot, branch: result.branch, appliedAt: result.receipt.appliedAt });

  if (flags['no-verify']) return;
  await runVerification(manifest, destRoot, plan.destination.entrypoint, result.receiptPath, { plan, applied: result });
}

async function runVerification(manifest, destRoot, entrypoint, receiptPath, transplant = null) {
  heading('Verify');
  console.log(dim('  booting the destination application and exercising it over HTTP...'));
  const report = await verifyCapability(manifest, destRoot, { entrypoint, atlas: 'local', extraTests: transplant?.plan?.preservation || [] });
  // After a transplant (not a bare `graft verify`), describe what changed in capability terms.
  if (transplant?.plan?.engine) {
    const { buildSemanticChangeset, renderSemanticChangeset } = await import('../../core/src/engine/changeset.js');
    heading('Semantic changeset');
    for (const line of renderSemanticChangeset(buildSemanticChangeset({ plan: transplant.plan, applied: transplant.applied, report, proof: report.proof }))) bullet(line);
  }

  console.log('');
  for (const r of report.results) {
    const mark = r.outcome === 'passed' ? green('pass') : r.outcome === 'failed' ? red('fail') : yellow('????');
    bullet(`${mark}  ${r.id}${r.required ? '' : dim(' (optional)')}`);
    bullet(dim(r.description), 8);
    if (r.reason) bullet(red(r.reason), 8);
  }

  console.log('');
  console.log(`  ${bold(`${report.summary.passed}/${report.summary.required}`)} required acceptance tests passed`);
  console.log('');
  console.log(`  ${verdictBanner(report.verdict)}  ${dim(report.rationale)}`);
  if (report.diagnostics?.stderr) console.log(dim(`\n  server stderr:\n${report.diagnostics.stderr}`));

  if (receiptPath && fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.verification = { verdict: report.verdict, rationale: report.rationale, summary: report.summary, at: report.finishedAt };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  }
  if (report.verdict !== 'VERIFIED') process.exitCode = 1;
  return report;
}

async function cmdVerify(positional, flags) {
  const slug = positional[0];
  const dest = flags.in || positional[1];
  if (!slug || !dest) return fail('usage: graft verify <capability> --in <destination>');
  const manifest = loadManifestBySlug(slug);
  const destRoot = resolveProject(String(dest));
  const destFp = fingerprintProject(destRoot);
  await runVerification(manifest, destRoot, destFp.entrypoint, null);
}

async function cmdWorkspace(positional, flags) {
  const w = await import('../../core/src/workspace/index.js');
  const agentConfig = await import('../../core/src/agent/config.js');
  const [action, value] = positional;
  const json = (v) => console.log(JSON.stringify(v, null, 2));
  const stateTone = { TRANSPLANTABLE: green, HARVESTABLE: green, STRONGLY_DETECTED: cyan, OBSERVED: dim, AMBIGUOUS: yellow, UNSUPPORTED: yellow };

  if (action === 'add') {
    if (!value) return fail('usage: graft workspace add <folder>');
    const roots = w.addRoot(path.resolve(value));
    console.log(`${green('authorized')} ${path.resolve(value)}\n  ${dim(`${roots.length} workspace root(s). Run "graft workspace index" to discover capabilities.`)}`);
    return;
  }
  if (action === 'remove') {
    if (!value) return fail('usage: graft workspace remove <folder>');
    w.removeRoot(path.resolve(value));
    return console.log(`${green('removed')} ${path.resolve(value)}`);
  }
  if (action === 'index') {
    const built = w.buildIndex({ force: flags.force === true });
    if (flags.json) return json(built);
    console.log(`\n${bold('Workspace indexed')} ${dim(`${built.elapsedMs} ms`)}`);
    for (const r of built.roots) console.log(`  ${r.root}  ${r.projects} project(s), ${r.scanned} scanned, ${r.reused} reused  ${dim(`${r.elapsedMs} ms`)}`);
    const summary = w.indexSummary();
    console.log(`\n  ${built.projects} projects · ${built.repositories} repositories · ${summary.worktrees} alternate worktree(s) · ${built.capabilities} capabilities`);
    console.log(`  harvestable ${summary.harvestable} · transplantable ${summary.transplantable} · languages ${Object.entries(summary.languages).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  ${dim(`stored locally at ${w.indexPath()} — no telemetry, no upload`)}\n`);
    return;
  }
  if (action === 'list') {
    const index = w.loadIndex();
    if (flags.json) return json(index.projects.map((p) => ({ projectId: p.projectId, name: p.name, root: p.root, language: p.language, runtime: p.runtime, capabilities: (p.capabilities || []).map((c) => ({ capability: c.capability, state: c.state, subtypes: c.subtypes })) })));
    if (!index.projects.length) return console.log('Nothing indexed yet. Add a folder with "graft workspace add <folder>", then "graft workspace index".');
    for (const p of index.projects) {
      if (p.error) { console.log(`${red('error')} ${p.root}: ${p.error}`); continue; }
      console.log(`${bold(p.name)} ${dim(p.relativeRoot === '.' ? '' : p.relativeRoot)}`);
      console.log(`  ${p.language}/${p.runtime} · ${p.moduleSystem} · ${p.framework} · ${p.hasHttpServer ? 'HTTP server' : 'no server'}${p.isCompiled ? ' · compiled' : ''}`);
      console.log(`  ${dim(`entry ${p.entrypoint ? (p.entrypoint.source || p.entrypoint.runtime) + (p.entrypoint.generated ? ' (generated)' : '') : 'none found'}`)}`);
      for (const c of p.capabilities || []) console.log(`  ${(stateTone[c.state] || dim)(c.state.padEnd(18))} ${c.capability} ${dim(`[${c.subtypes.join(', ')}]`)}`);
    }
    return;
  }
  if (action === 'refresh') {
    if (!value) return fail('usage: graft workspace refresh <projectId>');
    const result = w.refreshProject(value);
    return console.log(`${green('refreshed')} ${result.project.name} ${dim(`${result.elapsedMs} ms`)}`);
  }
  if (action === 'search' || action === 'find') {
    const text = positional.slice(1).join(' ');
    const filters = {};
    if (flags.capability) filters.capability = flags.capability;
    if (flags.harvestable) filters.harvestable = true;
    if (flags.unsupported) filters.transplantSupport = 'unsupported';
    const limit = flags.limit ? Number(flags.limit) : 10;
    let result;
    if (action === 'find') {
      const config = agentConfig.loadAgentConfig();
      const key = agentConfig.resolveApiKey(config);
      let agent = null;
      if (config && (key || config.endpoint)) {
        const { createAgentRuntime, createGrant } = await import('../../core/src/agent/runtime.js');
        agent = createAgentRuntime({ provider: config.provider, apiKey: key, model: config.model, endpoint: config.endpoint, grant: createGrant(config.scopes) });
      }
      result = await w.discoverCapabilityCandidates(text, { agent, limit, explain: flags.explain === true });
      if (flags.json) return json(result);
      console.log(`\n${bold(`${result.total} candidate(s)`)} ${dim(`interpreted ${result.interpretation.source}${result.ranking.rankedByAgent ? ', ordered by agent' : ''} · ${result.elapsedMs} ms`)}`);
      if (!result.agentConfigured) console.log(dim('  no agent configured — deterministic search only'));
      for (const c of result.candidates) printCandidate(c, stateTone);
      console.log(`\n${dim(result.authority)}\n`);
      return;
    }
    result = w.searchCapabilities({ text, ...filters }, { limit });
    if (flags.json) return json(result);
    console.log(`\n${bold(`${result.total} result(s)`)} ${dim(result.interpretedBecause.join(' + ') || 'structural filters')}`);
    for (const c of result.results) printCandidate(c, stateTone);
    console.log('');
    return;
  }
  if (action === 'agent') {
    if (flags.clear) { agentConfig.clearAgentConfig(); return console.log(`${green('disconnected')} no agent is configured; discovery still works.`); }
    if (flags.provider) {
      const saved = agentConfig.saveAgentConfig({ provider: flags.provider, model: flags.model || null, endpoint: flags.endpoint || null });
      console.log(`${green('connected')} ${saved.provider} · ${saved.model}`);
      console.log(`  ${dim(`key is read from ${agentConfig.KEY_ENVIRONMENT[saved.provider]} at request time and never written to ${agentConfig.agentConfigPath()}`)}`);
      return;
    }
    const described = agentConfig.describeAgentConfig(agentConfig.loadAgentConfig());
    if (flags.json) return json(described);
    if (!described.configured) {
      console.log('No agent configured. GRAFT discovery is fully functional without one.\n');
      for (const p of described.providers) console.log(`  ${bold(p.id.padEnd(20))} ${p.label} ${dim(`key: ${p.keyEnvironment}`)}`);
      console.log(`\n  ${dim('graft workspace agent --provider anthropic')}`);
      return;
    }
    console.log(`${bold(described.label)} · ${described.model}`);
    console.log(`  scopes: ${described.scopes.join(', ')}`);
    console.log(`  key: ${described.keyAvailable ? green(`available from ${described.keySource}`) : yellow('not available — set the environment variable')}`);
    console.log(`  ${dim('the agent may interpret, rank and explain; GRAFT decides every outcome')}`);
    return;
  }
  return fail('usage: graft workspace <add|remove|index|list|search|find|refresh|agent> [value]');
}

function printCandidate(c, stateTone) {
  const tone = stateTone[c.state] || dim;
  console.log(`\n  ${bold(c.project.name)}${c.project.relativeRoot !== '.' ? dim(` ${c.project.relativeRoot}`) : ''}  ${tone(c.state)}`);
  console.log(`    ${c.capability}${c.subtypes.length ? ` · ${c.subtypes.join(', ')}` : ''}`);
  console.log(`    ${dim(`${c.project.language}/${c.project.runtime} · ${c.project.framework}${c.project.entrypoint ? ` · ${c.project.entrypoint.source || c.project.entrypoint.runtime}` : ''}`)}`);
  if (c.auth) console.log(`    ${dim(`credentials ${c.auth.credentialAuthority.kind} · session ${c.auth.sessionTransport}/${c.auth.sessionCustody}/${c.auth.sessionStore}`)}`);
  console.log(`    ${c.harvestable ? green('harvestable') : yellow('not harvestable')} · ${c.transplantSupport === 'supported' ? green('transplantable') : yellow('not yet transplantable')} · ${c.localVerification.feasible ? 'locally verifiable' : dim('needs external setup')}`);
  if (c.matchedBecause?.length) console.log(`    ${dim(`matched: ${c.matchedBecause.map((w) => w.detail).join('; ')}`)}`);
  if (c.blockers?.length) console.log(`    ${dim(`blocked: ${c.blockers.map((b) => b.detail).join('; ')}`)}`);
  if (c.agentReason) console.log(`    ${cyan('agent')}: ${c.agentReason} ${dim('(advisory)')}`);
}

async function cmdDogfood(positional, flags) {
  const { listDogfoodSessions, readEvents, annotate, scorecard, dogfoodDir, sessionDir } = await import('../../core/src/dogfood/index.js');
  const [action, session, text] = positional;
  if (session !== undefined) sessionDir(session); // validates the name before it can become a path
  const json = (value) => console.log(JSON.stringify(value, null, 2));
  if (action === 'list') {
    const sessions = listDogfoodSessions();
    if (flags.json) return json(sessions);
    if (!sessions.length) return console.log(`No dogfood sessions under ${dogfoodDir()}. Start one with GRAFT_DOGFOOD=<name> graft ui (or the desktop app).`);
    for (const s of sessions) console.log(`${bold(s.session)}  ${s.events} event(s)  ${dim(`${s.startedAt} → ${s.lastEventAt || '—'}`)}
  ${dim(s.directory)}`);
    return;
  }
  if (!session) return fail(`usage: graft dogfood ${action || '<list|show|note|score>'} <session>`);
  if (action === 'show') {
    const events = readEvents(sessionDir(session));
    if (flags.json) return json(events);
    for (const e of events) {
      const head = `${String(e.seq).padStart(4)}  ${e.at}  ${cyan(e.type.padEnd(16))} ${dim((e.stage || '').padEnd(8))}${e.elapsedMs !== undefined ? dim(`${e.elapsedMs.toFixed(1)} ms`) : ''}${e.intervention ? '  [intervention]' : ''}`;
      const detail = e.type === 'observation' ? `${e.data.tag}${e.data.terminal ? ' [terminal]' : ''}${e.data.ref ? ` (re #${e.data.ref})` : ''}: ${e.data.text}`
        : e.type === 'error' ? `${e.data.status || ''} ${e.data.message}`.trim()
        : e.type === 'plan' ? `${e.data.capability} → ${e.data.destination?.name}: plan ${e.data.plan?.status}, compatibility ${e.data.plan?.compatibility?.status}, recipe ${e.data.plan?.recipe?.name || 'none'}, atlas ${e.data.plan?.atlasUsed?.observations || 0} prior`
        : e.type === 'harvest' ? `${e.data.capability} from ${e.data.source?.name}: ${e.data.report?.verdict || 'not run'}, banked ${e.data.banked}`
        : e.type === 'apply' ? `${e.data.branch || 'no branch'}: initial ${e.data.repair?.initialVerdict}, final ${e.data.report?.verdict}, repairs ${e.data.repair?.attempts?.length || 0}`
        : e.type === 'verify' ? `${e.data.capability} in ${e.data.destination?.name}: ${e.data.report?.verdict}`
        : e.type === 'project.register' ? `${e.data.project?.name} (${e.data.project?.architecture?.framework}/${e.data.project?.architecture?.moduleSystem}, git ${e.data.project?.git?.head ? e.data.project.git.head.slice(0, 12) : 'none'}${e.data.project?.git?.dirty ? ', dirty' : ''})`
        : '';
      console.log(head + (detail ? `
      ${detail}` : ''));
    }
    return;
  }
  if (action === 'note') {
    if (!text) return fail('usage: graft dogfood note <session> "<what you observed>" --tag <TAG> [--stage <stage>] [--ref <seq>] [--intervention] [--terminal]');
    if (!flags.tag) return fail('--tag is required (ENGINE_DEFECT, MISSING_ENGINE_CAPABILITY, VERIFICATION_GAP, UX_FRICTION, PERFORMANCE, EXPECTED_REFUSAL, SUCCESS)');
    const ref = flags.ref === undefined ? null : Number(flags.ref);
    const event = annotate(session, { tag: flags.tag, stage: flags.stage || 'other', text, ref, intervention: flags.intervention === true, terminal: flags.terminal === true });
    if (flags.json) return json(event);
    return console.log(`${green('recorded')} #${event.seq} ${event.data.tag} (${event.stage}) in ${dim(path.join(sessionDir(session), 'events.jsonl'))}`);
  }
  if (action === 'score') {
    const card = scorecard(session);
    if (flags.json) return json(card);
    console.log(`
${bold(`Dogfood scorecard — ${card.session}`)}  ${dim(`${card.events} events, ${(card.totalElapsedMs / 1000).toFixed(1)} s wall clock`)}
`);
    console.log(`  final state                ${card.transplant.finalState}${card.transplant.finalVerdict ? ` (verdict ${card.transplant.finalVerdict})` : ''}`);
    console.log(`                             ${dim(card.transplant.finalStateReason)}`);
    console.log(`  capability recognition     ${card.capabilityRecognition.recognized}/${card.capabilityRecognition.harvests} harvest(s) recognized, ${card.capabilityRecognition.verifiedInSource} verified in source, kinds ${card.capabilityRecognition.kinds.join(', ') || 'none'}`);
    console.log(`  host model                 ${card.hostModel ? `profile ${card.hostModel.profile || 'none'}, unknown dimensions ${card.hostModel.unknownDimensions.join(', ') || 'none'}, ${card.hostModel.unknowns} unknown(s)` : 'no plan recorded'}`);
    console.log(`  compatibility prediction   ${card.compatibilityPrediction.plans} plan(s); predicted ${card.compatibilityPrediction.predicted.map((p) => `${p.planStatus}/${p.compatibility}`).join(', ') || '—'}; observed ${card.compatibilityPrediction.observed || '—'}; agreement ${card.compatibilityPrediction.agreement ?? 'n/a'}`);
    console.log(`  manual intervention        ${card.manualIntervention.count} (events ${card.manualIntervention.events.join(', ') || '—'})`);
    console.log(`  terminal use               ${card.terminalUse.count} (events ${card.terminalUse.events.join(', ') || '—'})`);
    console.log(`  transplant                 ${card.transplant.applied} applied; branches ${card.transplant.branches.join(', ') || '—'}`);
    console.log(`  repair                     ${card.repair.attempts} attempt(s), ${card.repair.classified} classified, ${card.repair.repaired} repaired`);
    console.log(`  verification coverage      ${card.verificationCoverage ? `${card.verificationCoverage.passed} passed / ${card.verificationCoverage.failed} failed / ${card.verificationCoverage.inconclusive} inconclusive of ${card.verificationCoverage.results} (${card.verificationCoverage.required} required); routes ${card.verificationCoverage.routeCoverage.length}` : 'no verification recorded'}`);
    console.log(`  evidence quality           ${card.evidenceQuality ? `${card.evidenceQuality.verdict} — ${card.evidenceQuality.rationale}; proof ${card.evidenceQuality.proofContract ? 'recorded' : 'none'}; atlas entry ${card.evidenceQuality.atlasEntry ? 'recorded' : 'none'}${card.evidenceQuality.recordingErrors.length ? `; recording errors: ${card.evidenceQuality.recordingErrors.join('; ')}` : ''}` : '—'}`);
    console.log(`  atlas                      used ${card.atlas.used.join(', ') || '0'} prior observation(s); generated ${card.atlas.generated.length}`);
    console.log(`  elapsed by stage           ${Object.entries(card.elapsedByStage).map(([k, v]) => `${k} ${(v / 1000).toFixed(2)} s`).join(', ') || '—'}`);
    console.log(`  engine defects             ${card.counts.engineDefects}`);
    console.log(`  missing capabilities       ${card.counts.missingCapabilities}`);
    console.log(`  verification gaps          ${card.counts.verificationGaps}`);
    console.log(`  UX friction points         ${card.counts.uxFriction}`);
    console.log(`  performance notes          ${card.counts.performance}`);
    console.log(`  expected refusals          ${card.counts.expectedRefusals}   errors ${card.counts.errors}   inconclusive verdicts ${card.counts.inconclusive}`);
    console.log(`  false VERIFIED             ${card.falseVerified}`);
    console.log(`  missed mutations/errors    ${card.missedMutations}
`);
    for (const o of card.observations) console.log(`  #${o.seq} ${o.tag} (${o.stage})${o.ref ? ` re #${o.ref}` : ''}: ${o.text}`);
    return;
  }
  return fail('usage: graft dogfood <list|show|note|score> [session] [text]');
}

function usage(command) {
  if (command) {
    if (!Object.hasOwn(commands, command)) throw new Error(`unknown command "${command}". Run graft --help for available commands.`);
    const definition = commands[command];
    console.log(`\n${bold(`graft ${command}`)} ${definition.args}\n\n  ${definition.description}\n`);
    for (const [name, spec] of Object.entries(definition.options)) {
      const suffix = spec.kind === 'value' ? ' <value>' : spec.kind === 'optional-value' ? ' [file]' : '';
      console.log(`  ${(`--${name}${suffix}`).padEnd(31)} ${spec.description}`);
    }
    console.log(`  ${'-h, --help'.padEnd(31)} Show this help\n`);
    return;
  }
  console.log(`
${bold('GRAFT')} ${dim('— harvest working capabilities from old projects, transplant them into new ones')}

  ${cyan('graft add')} <path>                                register a local project
  ${cyan('graft projects')}                                  list known projects
  ${cyan('graft harvest')} <project> [--capability <id>]     discover capabilities, harvest one
  ${cyan('graft bank')}                                      show the organ bank
  ${cyan('graft plan')} <capability> --to <project>          compatibility analysis + transplant plan
  ${cyan('graft transplant')} <capability> --to <project>    apply the transplant, then verify
  ${cyan('graft verify')} <capability> --in <project>        re-run acceptance verification
  ${cyan('graft demo')}                                      full vertical slice on the bundled fixtures
  ${cyan('graft ui')}                                        start the local browser workspace
  ${cyan('graft workspace')} <add|index|find|agent>            index your folders, search what you have already built
  ${cyan('graft proof')} <verify|export> <file-or-digest>     verify a portable proof file or stored digest offline; export an exact copy
  ${cyan('graft dogfood')} <list|show|note|score>             local dogfood records (GRAFT_DOGFOOD=<name> records a session)

  ${cyan('graft <command> --help')}                          show command options and safety flags
  ${cyan('graft --version')}                                 show the installed version

${dim('GRAFT_HOME')} sets the local registry and bank directory (default: ~/.graft).
${dim('everything is local. no account, no hosted database, no telemetry.')}
`);
}

// ---------------------------------------------------------------------------------------------
// graft proof verify <file-or-digest> | graft proof export <digest> [--out <path>]
//
// Integrity and the recorded claim are printed as two different things and never merged: an
// intact proof that records FAILED is an intact proof of a failure. The exit status is about
// INTEGRITY only — 0 when the artifact is intact, 1 when it is missing, malformed or altered — and
// never about the recorded verdict. Verification reads the file (or the local proof store) and
// nothing else: no repository, no git, no network, no model. Model A is tamper-evident content
// addressing, not a signature: it does not authenticate who produced the artifact.
// ---------------------------------------------------------------------------------------------
const DIGEST_ARG = /^(?:sha256:)?([0-9a-f]{64})$/i;
async function cmdProof(positional, flags) {
  const { verifyProofFile, verifyProofArtifact } = await import('../../proof-adapter/src/index.js');
  const { loadProofArtifact, exportProofArtifact, proofFileName } = await import('../../core/src/laboratory/proof-store.js');
  const [action, target] = positional;
  if (!['verify', 'export'].includes(action) || !target) return fail('usage: graft proof <verify|export> <file-or-digest> [--out <path>] [--json]');
  const digest = DIGEST_ARG.exec(target)?.[1]?.toLowerCase() || null;
  const json = (value) => console.log(JSON.stringify(value, null, 2));
  if (action === 'export') {
    if (!digest) return fail('graft proof export takes a stored proof digest (sha256:<64 hex>); to move a file, copy it.');
    const exported = exportProofArtifact(digest, flags.out === undefined ? process.cwd() : String(flags.out));
    if (flags.json) return json({ digest: exported.digest, file: path.basename(exported.file), bytes: exported.bytes, claim: exported.claim });
    console.log(`${green('exported')} ${bold(path.basename(exported.file))}  ${dim(`${exported.bytes} bytes, byte-identical to the stored proof`)}`);
    return console.log(dim(`verify anywhere with: graft proof verify ./${path.basename(exported.file)}`));
  }
  // verify: a stored digest resolves through the local proof store; anything else is a file path.
  const stored = digest ? loadProofArtifact(digest) : null;
  const result = digest
    ? (stored.found ? { ...verifyProofArtifact(stored.envelope), reasons: stored.intact ? [] : stored.reasons, intact: stored.intact } : { found: false, intact: false, reasons: stored.reasons, schema: null, digest, claim: null })
    : verifyProofFile(target);
  const integrity = { status: !result.found ? 'MISSING' : result.intact ? 'INTACT' : 'NOT INTACT', intact: result.intact === true, found: result.found === true, reasons: result.reasons, schema: result.schema, digest: result.digest, source: digest ? 'proof-store' : 'file' };
  if (!integrity.intact) process.exitCode = 1;
  if (flags.json) return json({ integrity, claim: result.claim });
  const c = result.claim;
  const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
  heading(`Proof ${digest ? `sha256:${digest.slice(0, 12)}…` : path.basename(target)}`);
  line('Integrity', integrity.intact ? green(bold('INTACT')) : red(bold(integrity.status)));
  for (const r of integrity.reasons) bullet(red(`- ${r}`), 4);
  if (c) {
    console.log(dim('  What the artifact records (its claim; integrity above says whether it can be relied on):'));
    line('Capability', `${c.capability.slug || '?'}${c.capability.kind ? ` (${c.capability.kind}, ${c.capability.form || '?'})` : ''}`);
    if (c.capability.id) line('Capability id', c.capability.id);
    line('Recorded GRAFT verdict', c.graftVerdict === 'VERIFIED' ? green(c.graftVerdict) : c.graftVerdict === 'FAILED' ? red(c.graftVerdict) : yellow(String(c.graftVerdict)));
    line('Recorded kernel verdict', String(c.kernelVerdict));
    line('Destination revision', c.destinationRevision || dim('none (source verification)'));
    if (c.hostProfile) line('Host profile', c.hostProfile);
    line('Source revision', c.sourceRevision || dim('not recorded'));
    if (c.adaptation) line('Adaptation', `${c.adaptation.id} · artifact ${c.adaptation.artifactSha256 || '?'}`);
    line('Contract', c.contract.id ? `${c.contract.id}${c.contract.version ? ` v${c.contract.version}` : ''}` : dim(`no engine contract id · cases digest ${String(c.contract.casesDigest || '').slice(0, 12)}`));
    line('Verifier', `graft core ${c.verifier.core} · proof adapter ${c.verifier.proofAdapter} · kernel ${String(c.verifier.kernel.sourceCommit || '').slice(0, 12)}`);
    line('Proof root', String(c.proofRoot));
    line('Evidence', `${c.evidence.count} item(s), ${c.cases.length} case(s): ${c.cases.filter((x) => x.outcome === 'passed').length} passed, ${c.cases.filter((x) => x.outcome === 'failed').length} failed, ${c.cases.filter((x) => x.outcome === 'inconclusive').length} inconclusive`);
    if (c.createdAt) line('Created (informational)', `${c.createdAt} ${dim('— not covered by the digest')}`);
  }
  console.log(dim('  Tamper-evident content addressing (Model A): intact means unmodified, not signed, and never VERIFIED by itself.'));
}

async function main() {
  const [, , command, ...rest] = process.argv;
  try {
    if (!command) return usage();
    if (command === '--version' || command === '-v') {
      if (rest.length) throw new Error('--version does not accept arguments');
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      return console.log(pkg.version);
    }
    if (command === '--help' || command === '-h' || command === 'help') {
      if (rest.length > 1) throw new Error('usage: graft help [command]');
      return usage(rest[0]);
    }
    const { flags, positional } = parseArgs(command, rest);
    if (flags.help) return usage(command);
    switch (command) {
      case 'ui': {
        const { startDashboard, keepDashboard } = await import('../../web/src/server.js');
        keepDashboard(await startDashboard({ port: flags.port === undefined ? 4317 : Number(flags.port) }));
        return;
      }
      case 'add': return cmdAdd(positional);
      case 'projects': return cmdProjects();
      case 'harvest': return await cmdHarvest(positional, flags);
      case 'bank': return cmdBank();
      case 'plan': return cmdPlan(positional, flags);
      case 'transplant': return await cmdTransplant(positional, flags);
      case 'verify': return await cmdVerify(positional, flags);
      case 'demo': return await (await import('./demo.js')).runDemo(flags);
      case 'workspace': return await cmdWorkspace(positional, flags);
      case 'proof': return await cmdProof(positional, flags);
      case 'dogfood': return await cmdDogfood(positional, flags);
    }
  } catch (err) {
    fail(err.message);
    if (process.env.GRAFT_DEBUG) console.error(err.stack);
  }
}

main();
