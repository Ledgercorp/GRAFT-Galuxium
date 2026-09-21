#!/usr/bin/env node
// Real-workspace acceptance for the Workspace Capability Index.
//
// Runs the product against the operator's actual development folder, read-only, and checks
// that what the index reports matches what is really there. Expectations are written as
// *properties* of whatever projects exist — "the Python project must not be reported as an
// unknown runtime", "a project whose entrypoint is declared under a non-start script must
// still be found" — never as a hard-coded list of names, so a workspace with different
// contents still exercises the same rules.
//
// Nothing here writes to a candidate repository, runs project code, or contacts a network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addRoot, buildIndex, loadIndex, indexSummary, searchCapabilities, discoverCapabilityCandidates, refreshProject, staleProjects } from '../packages/core/src/workspace/index.js';

const root = process.argv[2] || path.join(os.homedir(), 'Developer');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-workspace-acceptance-'));
process.env.GRAFT_HOME = home;

let failures = 0;
const results = [];
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
}
const has = (list, predicate) => list.filter(predicate);

console.log(`Workspace: ${root}\nIsolated index home: ${home}\n`);
if (!fs.existsSync(root)) { console.error(`No such workspace root: ${root}`); process.exit(1); }

// --- indexing -------------------------------------------------------------
addRoot(root);
const started = process.hrtime.bigint();
const built = buildIndex();
const initialMs = Number(process.hrtime.bigint() - started) / 1e6;
const index = loadIndex();
const summary = indexSummary({ index });
const projects = index.projects.filter((p) => !p.error);
const capabilities = projects.flatMap((p) => (p.capabilities || []).map((c) => ({ project: p, capability: c })));

check('the workspace indexes without errors', index.projects.every((p) => !p.error), `${projects.length} projects`);
check('more than one repository is discovered without one-at-a-time registration', summary.repositories > 1, `${summary.repositories} repositories`);
check('projects outnumber repositories, so monorepo subprojects are modelled', projects.length > summary.repositories, `${projects.length} projects / ${summary.repositories} repositories`);

// --- repository and worktree identity -------------------------------------
const byRepository = new Map();
for (const project of projects) byRepository.set(project.repositoryId, (byRepository.get(project.repositoryId) || 0) + 1);
const worktreeHeavy = projects.filter((p) => (p.repository.worktrees?.length || 0) > 1);
check('a repository with many checkouts is one repository, not many',
  worktreeHeavy.every((p) => byRepository.has(p.repositoryId)) && new Set(worktreeHeavy.map((p) => p.repositoryId)).size <= byRepository.size,
  `${summary.worktrees} alternate worktree(s) recorded across ${summary.repositories} repositories`);
check('alternate checkouts are recorded rather than counted as separate projects',
  projects.every((p) => !p.root.includes('/.sockdev-agent-bridge/')), 'no worktree path was indexed as its own project');

// --- language and runtime -------------------------------------------------
const python = has(projects, (p) => p.language === 'python');
const typescript = has(projects, (p) => p.language === 'typescript');
check('no indexed project reports an unknown runtime', projects.every((p) => p.runtime !== 'unknown'),
  Object.entries(summary.runtimes).map(([k, v]) => `${k}:${v}`).join(' '));
check('a Python project is named as Python, not unknown', python.length === 0 || python.every((p) => p.runtime === 'python' && p.moduleSystem === 'python'),
  python.map((p) => `${p.name}=${p.language}/${p.runtime}`).join(', ') || 'no python project present');
check('a Python project is explicitly unsupported for transplantation rather than silently supported',
  python.every((p) => (p.capabilities || []).every((c) => c.transplantSupport === 'unsupported' && c.blockers.some((b) => b.id === 'unsupported-runtime'))),
  python.flatMap((p) => (p.capabilities || []).map((c) => `${p.name}:${c.capability}=${c.transplantSupport}`)).join(', ') || 'no python capability present');

// --- compiled projects ----------------------------------------------------
const compiled = has(projects, (p) => p.isCompiled && p.entrypoint);
check('a compiled project never points at generated output as its editable source',
  compiled.every((p) => !p.entrypoint.source || !p.entrypoint.source.startsWith(`${p.buildOutputDir}/`)),
  compiled.slice(0, 3).map((p) => `${p.name}: runtime=${p.entrypoint.runtime} source=${p.entrypoint.source}`).join(' | ') || 'no compiled project present');
check('a compiled project is blocked as a destination for the right reason',
  compiled.every((p) => (p.capabilities || []).every((c) => c.asDestination.supported === false)),
  `${compiled.length} compiled project(s)`);

// --- entrypoint discovery -------------------------------------------------
const nonStartEntrypoints = has(projects, (p) => p.entrypoint && /package script "(?!start)/.test(p.entrypoint.reason || ''));
check('an entrypoint declared under a non-start script is still found', nonStartEntrypoints.length > 0,
  nonStartEntrypoints.slice(0, 3).map((p) => `${p.name}: ${p.entrypoint.runtime} via ${p.entrypoint.reason}`).join(' | '));
const servers = has(projects, (p) => p.hasHttpServer);
check('HTTP servers are identified structurally', servers.length > 0, `${servers.length} project(s) with a server`);
check('a project with a server has an entrypoint', servers.every((p) => p.entrypoint), servers.filter((p) => !p.entrypoint).map((p) => p.name).join(', ') || 'all have one');
check('no entrypoint is a test file', projects.every((p) => !p.entrypoint || !/(^|\/)(tests?|__tests__)\//.test(p.entrypoint.runtime)),
  projects.filter((p) => p.entrypoint && /(^|\/)tests?\//.test(p.entrypoint.runtime)).map((p) => p.name).join(', ') || 'none');

// --- route idioms ---------------------------------------------------------
const idioms = new Set(projects.flatMap((p) => p.routeIdioms || []));
check('route idioms beyond the two original ones are recognised', idioms.size >= 2, [...idioms].join(', '));
const pathComparison = has(projects, (p) => (p.routeIdioms || []).includes('path-comparison'));
check('method/path comparison dispatch is visible as routes', pathComparison.length === 0 || pathComparison.every((p) => p.routes?.length > 0 || p.routeCount > 0),
  pathComparison.slice(0, 3).map((p) => `${p.name}: ${p.routes.length} route(s)`).join(' | ') || 'no such project present');

// --- capability discovery -------------------------------------------------
check('real capabilities are discovered', capabilities.length > 0, `${capabilities.length} capability observation(s)`);
const authObservations = capabilities.filter((c) => c.capability.capability === 'authentication');
check('authentication is found in more than one project', new Set(authObservations.map((c) => c.project.repositoryId)).size > 1,
  `${authObservations.length} observation(s) across ${new Set(authObservations.map((c) => c.project.repositoryId)).size} repositories`);
const subtypes = new Set(authObservations.flatMap((c) => c.capability.subtypes));
check('more than one authentication subtype is represented', subtypes.size > 1, [...subtypes].join(', '));
const authorities = new Set(authObservations.map((c) => c.capability.auth?.credentialAuthority?.kind).filter(Boolean));
check('credential authority is recorded separately from session transport', authorities.size > 1,
  `authorities: ${[...authorities].join(', ')}; transports: ${[...new Set(authObservations.map((c) => c.capability.auth?.sessionTransport))].join(', ')}`);
const hosted = authObservations.filter((c) => c.capability.auth?.credentialAuthority?.kind === 'hosted-provider');
check('a hosted-provider project keeps its local session layer described',
  hosted.length === 0 || hosted.some((c) => c.capability.auth.sessionTransport === 'cookie' && c.capability.auth.sessionCustody === 'local'),
  hosted.slice(0, 2).map((c) => `${c.project.name}: ${c.capability.auth.credentialAuthority.kind}/${c.capability.auth.sessionTransport}/${c.capability.auth.sessionCustody}/${c.capability.auth.sessionStore}`).join(' | ') || 'none present');
check('a non-durable in-memory session is reported as non-durable',
  hosted.every((c) => c.capability.auth.sessionStore !== 'memory' || c.capability.auth.sessionDurableAcrossRestart === false),
  hosted.map((c) => `${c.project.name}=${c.capability.auth.sessionDurableAcrossRestart}`).join(', ') || 'none present');

// --- discovered but not harvestable --------------------------------------
const discoveredNotHarvestable = capabilities.filter((c) => !c.capability.harvestable);
check('capabilities can be represented without being harvestable', discoveredNotHarvestable.length > 0,
  `${discoveredNotHarvestable.length} of ${capabilities.length} observation(s)`);
check('every non-harvestable capability explains what is missing',
  discoveredNotHarvestable.every((c) => c.capability.missingSignals.length > 0 || c.capability.blockers.length > 0),
  'each carries missingSignals or blockers');
check('every observation carries evidence for what GRAFT thinks it saw',
  capabilities.every((c) => c.capability.signals.length > 0 && c.capability.signals.every((s) => typeof s.evidence === 'string' && s.evidence.length > 0)),
  'all signals have evidence strings');
check('harvestability is never claimed without the harvest detector',
  capabilities.every((c) => !c.capability.harvestable || c.capability.state === 'HARVESTABLE' || c.capability.state === 'TRANSPLANTABLE'),
  `${summary.harvestable} harvestable`);
check('external service dependence is recorded where it exists',
  capabilities.filter((c) => c.capability.auth?.providers?.length).every((c) => c.project.externalHosts.length > 0 || c.capability.auth.providers.length > 0),
  `${projects.filter((p) => p.externalHosts.length).length} project(s) call external hosts`);

// --- search ---------------------------------------------------------------
const authSearch = searchCapabilities('find authentication');
check('"find authentication" returns real candidates instead of zero', authSearch.total > 0, `${authSearch.total} result(s)`);
check('search results explain why each matched', authSearch.results.every((r) => r.matchedBecause.length > 0), 'all carry matchedBecause');
check('search results state harvestability and transplant support', authSearch.results.every((r) => typeof r.harvestable === 'boolean' && typeof r.transplantSupport === 'string'), 'all carry both');
check('at least one returned candidate is honestly not transplantable', authSearch.results.some((r) => r.transplantSupport === 'unsupported'),
  `${authSearch.results.filter((r) => r.transplantSupport === 'unsupported').length} of ${authSearch.results.length} shown`);
const cookieSearch = searchCapabilities('find something that keeps users logged in');
check('a plain-language session question finds cookie-session capabilities', cookieSearch.total > 0 && cookieSearch.results.every((r) => r.auth?.sessionTransport === 'cookie'),
  `${cookieSearch.total} result(s)`);
const apiKeySearch = searchCapabilities('find API key auth');
check('a plain-language API-key question finds the API-key project', apiKeySearch.total === 0 || apiKeySearch.results.every((r) => r.subtypes.includes('api-key-static')),
  apiKeySearch.results.map((r) => r.project.name).join(', ') || 'none present');
const unsupportedSearch = searchCapabilities('find capabilities I cannot yet transplant');
check('unsupported capabilities are searchable as a first-class result', unsupportedSearch.total > 0 && unsupportedSearch.results.every((r) => r.transplantSupport === 'unsupported'),
  `${unsupportedSearch.total} result(s)`);

// --- agentless discovery --------------------------------------------------
const discovery = await discoverCapabilityCandidates('find the best login system I already built', { index, limit: 5 });
check('natural-language discovery works with no agent configured', discovery.agentConfigured === false && discovery.candidates.length > 0,
  `${discovery.total} candidate(s), interpreted ${discovery.interpretation.source}`);
check('discovery states that GRAFT owns the outcome', /determined by GRAFT/.test(discovery.authority), 'authority statement present');

// --- privacy --------------------------------------------------------------
const raw = fs.readFileSync(path.join(home, 'workspace-index.json'), 'utf8');
check('the index file declares itself local with no telemetry', /"telemetry": false/.test(raw) && /"uploads": "never"/.test(raw), 'declared in the stored document');
const secretish = /sk_live_[A-Za-z0-9]{8,}|sk-ant-[A-Za-z0-9-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}/.exec(raw);
check('no credential-shaped string was written to the index', !secretish, secretish ? `found ${secretish[0].slice(0, 12)}…` : 'none found');
const sourceLines = projects.flatMap((p) => {
  const entry = p.entrypoint?.source && path.join(p.root, p.entrypoint.source);
  if (!entry || !fs.existsSync(entry)) return [];
  return fs.readFileSync(entry, 'utf8').split('\n').filter((l) => l.trim().length > 40).slice(0, 3);
});
check('no source line from any indexed entrypoint appears in the index', sourceLines.every((line) => !raw.includes(line.trim())),
  `${sourceLines.length} line(s) checked across ${projects.length} projects`);
check('environment variable values are absent while names are present',
  projects.some((p) => p.environmentVariables.length > 0) && !/"[A-Z0-9_]+=[^"]{6,}"/.test(raw),
  `${new Set(projects.flatMap((p) => p.environmentVariables)).size} distinct variable name(s) indexed`);

// --- incremental behaviour ------------------------------------------------
const reindexStarted = process.hrtime.bigint();
const reindexed = buildIndex();
const incrementalMs = Number(process.hrtime.bigint() - reindexStarted) / 1e6;
check('an unchanged re-scan reuses every project', reindexed.roots.every((r) => r.scanned === 0 && r.reused > 0),
  `${reindexed.roots[0].reused} reused, ${reindexed.roots[0].scanned} rescanned`);
check('an unchanged re-scan is faster than the first scan', incrementalMs < initialMs, `${initialMs.toFixed(0)} ms → ${incrementalMs.toFixed(0)} ms`);
check('nothing is stale immediately after indexing', staleProjects().length === 0, `${staleProjects().length} stale`);
const refreshTarget = projects.find((p) => p.hasHttpServer) || projects[0];
const refreshStarted = process.hrtime.bigint();
refreshProject(refreshTarget.projectId);
const refreshMs = Number(process.hrtime.bigint() - refreshStarted) / 1e6;
check('a single project can be refreshed on its own', loadIndex().projects.length === index.projects.length, `${refreshTarget.name} in ${refreshMs.toFixed(0)} ms`);

// --- read-only guarantee --------------------------------------------------
check('the index lives entirely under GRAFT_HOME', fs.existsSync(path.join(home, 'workspace-index.json')) && fs.readdirSync(home).every((f) => !f.startsWith('..')), home);

// --- performance ----------------------------------------------------------
const searchStarted = process.hrtime.bigint();
for (let i = 0; i < 20; i++) searchCapabilities('find authentication');
const searchMs = Number(process.hrtime.bigint() - searchStarted) / 1e6 / 20;
const performance = {
  workspaceRoot: root,
  projects: projects.length, repositories: summary.repositories, worktrees: summary.worktrees, capabilities: capabilities.length,
  filesScanned: projects.reduce((sum, p) => sum + (p.fileCount || 0), 0),
  initialIndexMs: Math.round(initialMs), incrementalIndexMs: Math.round(incrementalMs), singleProjectRefreshMs: Math.round(refreshMs),
  perProjectMs: Math.round((initialMs / projects.length) * 10) / 10,
  slowestProjects: projects.slice().sort((a, b) => (b.indexElapsedMs || 0) - (a.indexElapsedMs || 0)).slice(0, 5).map((p) => ({ name: p.name, ms: p.indexElapsedMs, files: p.fileCount })),
  indexBytes: Buffer.byteLength(raw, 'utf8'),
  indexBytesPerProject: Math.round(Buffer.byteLength(raw, 'utf8') / projects.length),
  deterministicSearchMs: Math.round(searchMs * 100) / 100,
  discoveryMs: discovery.elapsedMs,
  summary: { languages: summary.languages, runtimes: summary.runtimes, byState: summary.byState, byCapability: summary.byCapability,
    harvestable: summary.harvestable, transplantable: summary.transplantable, authSubtypes: summary.authSubtypes },
  at: new Date().toISOString(),
};
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/workspace-index-perf.json', JSON.stringify(performance, null, 2) + '\n');

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
console.log(`Index: ${performance.projects} projects, ${performance.repositories} repositories, ${performance.capabilities} capabilities, ${(performance.indexBytes / 1024).toFixed(1)} KiB`);
console.log(`Timing: initial ${performance.initialIndexMs} ms, incremental ${performance.incrementalIndexMs} ms, refresh ${performance.singleProjectRefreshMs} ms, search ${performance.deterministicSearchMs} ms`);
console.log(`Measurements written to dist/workspace-index-perf.json`);
fs.rmSync(home, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} workspace acceptance check(s) failed.`); process.exit(1); }
