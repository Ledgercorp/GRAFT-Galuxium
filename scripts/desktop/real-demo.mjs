// Real Product Demo 0.1 — the packaged GRAFT desktop app, the real workspace, the real UI.
//
// Everything a customer would do is done through the renderer over the DevTools protocol:
// clicks, typing, reading what the page shows, bounded polling. Nothing here calls the
// workspace API, creates a worktree, chooses a branch, runs a harvest or a verification: the
// product does all of that because a control in its own page was activated. After the run
// the script reads what the product wrote (registry, dogfood events, git state) as evidence.
//
// Usage: npm run desktop:demo -- [--workspace ~/Developer] [--destination <name>] [--keep-app]
//   GRAFT_DEMO_HOME   isolated app home (default ~/.graft-demo/real-product-demo-0.1)
//   GRAFT_DEMO_QUERY  the Capability Memory query
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { describePlatform } from '../../packages/desktop/src/platform.js';

const host = describePlatform();
const JUDGE = process.argv.includes('--judge');
const PRODUCT_NAME = JUDGE ? 'GRAFT Galuxium' : 'GRAFT Fixture';
const APP_DIR = path.resolve(`out/${JUDGE ? 'judge' : 'fixture'}/${PRODUCT_NAME}-${host.platform}-${host.arch}`);
const EXE = host.windows ? path.join(APP_DIR, `${PRODUCT_NAME}.exe`) : path.join(APP_DIR, `${PRODUCT_NAME}.app`, `Contents/MacOS/${PRODUCT_NAME}`);
const BUNDLE_ID = JUDGE ? 'com.leftsock.graft.galuxium' : 'com.leftsock.graft.fixture';
const KEY = 'GRAFT-FIXTURE-VALID';
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const PORT = Number(arg('--port', 9336));
// One or more workspace folders the customer authorizes (comma-separated); the first is the default parent.
const WORKSPACES = arg('--workspace', path.join(os.homedir(), 'Developer')).split(',').map((w) => path.resolve(w.trim())).filter(Boolean);
const WORKSPACE = WORKSPACES[0];
const DESTINATION_NAME = arg('--destination', 'cuf-webmcp-challenge');
// Used only to prove the source checkout is untouched afterwards; selection happens in the page.
const SOURCE_NAME = arg('--source', 'CUF');
const under = (name) => (path.isAbsolute(name) ? name : path.join(WORKSPACE, name));
const QUERY = process.env.GRAFT_DEMO_QUERY || 'find user-facing authentication I have already built';
const SESSION = arg('--session', 'real-product-demo-0.1');
const HOME = path.resolve(process.env.GRAFT_DEMO_HOME || path.join(os.homedir(), '.graft-demo', SESSION));
const KEEP_APP = process.argv.includes('--keep-app');
const CLEANUP_ONLY = process.argv.includes('--cleanup-only');
// --export <folder>: after the harvest, click "Download capability" and save the package there
// (the fixture answers the native save dialog with that folder), then stop before any transplant.
const EXPORT_DIR = arg('--export', null);
// --blueprint: after the harvest, design a blueprint in the Laboratory from the page (no transplant, no destination writes)
const BLUEPRINT = process.argv.includes('--blueprint');
// --plan: after the blueprint, build assembly plans from the page — Case A: the blocked blueprint; Case B: a new
// blueprint holding only the harvested capability on a proven new host. Nothing is executed.
const PLAN = process.argv.includes('--plan');
const PLAN_ARCH = process.env.GRAFT_DEMO_PLAN_ARCH || 'node-esm-express';
// A host GRAFT has NOT proven for this capability, to show the blocked state in the packaged UI.
const UNSUPPORTED_ARCH = process.env.GRAFT_DEMO_UNSUPPORTED_ARCH || null;
// --assemble <parent>: after Case B, click Assemble application, choose <parent> in the folder dialog, and let the
// product create the host, transplant, verify and re-index. Requires --plan with GRAFT_DEMO_PLAN_ARCH=node-esm-http-central.
const ASSEMBLE_PARENT = arg('--assemble', null);
const ASSEMBLE_NAME = process.env.GRAFT_DEMO_ASSEMBLE_NAME || 'Authenticated application';
// --finalize: after a completed assembly, inspect the ledger and explicitly promote the verified
// revision into the created project, then check what the person's own checkout holds.
const FINALIZE = process.argv.includes('--finalize');
// --compose: Real Multi-Capability Composition 0.1. After the first harvest, harvest a SECOND capability
// (GRAFT_DEMO_SECOND_QUERY), design a blueprint that wants both, select both, plan on the proven
// node:http host, Assemble (the composition kernel over the real operations), read the per-capability
// evidence and the two ledger records the page shows, Finalize, and run the result on its own.
const COMPOSE = process.argv.includes('--compose');
// --beta: Commercial Beta Readiness 0.1 Checkpoint A. After the composition is finalized: export the
// proofs through the page (folder dialog), then a controlled customer failure (assemble the same
// plan again under the same name → "already taken"), Retry from the recovery panel under the
// suggested name, Discard the failed run, and save a diagnostic bundle — all through the renderer.
const BETA = process.argv.includes('--beta');
const BETA_EXPORT = BETA ? path.join(HOME, 'beta-export') : null;
const BETA_DIAG = BETA ? path.join(HOME, 'beta-diagnostics') : null;
const SECOND_QUERY = process.env.GRAFT_DEMO_SECOND_QUERY || 'feature flags';
const COMPOSE_NAME = process.env.GRAFT_DEMO_COMPOSE_NAME || 'Flagged portal';
const COMPOSE_TEXT = process.env.GRAFT_DEMO_COMPOSE_TEXT || 'People sign in, and features can be turned on for some of them.';
const COMPOSE_CHECKS = (process.env.GRAFT_DEMO_COMPOSE_CHECKS || 'authentication,feature-flags').split(',').map((c) => c.trim()).filter(Boolean);
// The second donor checkout, proven untouched afterwards (selection still happens in the page).
const SECOND_SOURCE = arg('--second-source', path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs'));
const BLUEPRINT_NAME = process.env.GRAFT_DEMO_BLUEPRINT_NAME || 'Client portal';
const BLUEPRINT_TEXT = process.env.GRAFT_DEMO_BLUEPRINT_TEXT || 'A client portal: customers sign in, belong to an organization, upload files, pay invoices, and get notifications; staff use admin controls.';
const BLUEPRINT_CHECKS = (process.env.GRAFT_DEMO_BLUEPRINT_CHECKS || 'authentication,organizations,file-uploads,billing,admin,notifications').split(',').map((c) => c.trim()).filter(Boolean);

const evidence = { session: SESSION, startedAt: new Date().toISOString(), steps: [], screenshots: [], terminalStepsByProductUser: 0, manualInterventions: [] };
const git = (cwd, args) => execFileSync(host.git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repoState = (root) => ({ root, branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), head: git(root, ['rev-parse', 'HEAD']), dirty: git(root, ['status', '--porcelain']).split('\n').filter(Boolean).length, graftBranches: git(root, ['branch', '--list', 'graft/*']).split('\n').map((b) => b.replace(/^[*+ ]+/, '').trim()).filter(Boolean) });
function step(name, data) { evidence.steps.push({ at: new Date().toISOString(), name, ...data }); console.log(`${name}${data ? ' :: ' + JSON.stringify(data).slice(0, 400) : ''}`); }
// Public demo pacing (GRAFT_DEMO_PACE_MS): a viewer-length pause at scene boundaries while a screen
// recording runs. Off by default; the product is never slowed, only the harness waits.
const PACE_MS = Number(process.env.GRAFT_DEMO_PACE_MS || 0);
const scene = async (name, ms = PACE_MS, selector = null) => { if (PACE_MS) await screenshot(`scene-${name}`, selector); step(`scene-${name}`, { holdMs: ms }); if (ms > 0) await new Promise((r) => setTimeout(r, ms)); };

function fail(message) { throw new Error(message); }
async function waitFor(fn, { timeout = 60000, interval = 250, what = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Continuous-recording mode: the finalized application in a plain Electron browser window placed over the
 * recorded region (scripts/demo/result-viewer.cjs), then GRAFT is brought back to the front. */
async function showResultInViewer(base) {
  const electron = path.resolve('node_modules/.bin/electron');
  const boundsFile = process.env.GRAFT_DEMO_BOUNDS_FILE;
  if (!fs.existsSync(electron) || !boundsFile || !fs.existsSync(boundsFile)) { step('scene-result-skipped', { reason: 'no viewer' }); return; }
  step('scene-result-viewer', { base: base.replace(/\d+$/, '<port>') });
  await new Promise((resolve) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [process.env.GRAFT_DEMO_RESULT_VIEWER, boundsFile, base, String(PACE_MS || 3000)], { stdio: 'ignore', env });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 60000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  step('scene-result-viewer-done', {});
  try { execFileSync('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to activate`]); } catch { /* best effort */ }
  await new Promise((r) => setTimeout(r, 800));
}
/** Scene 8 of the public demo: the finalized application in a real browser engine (chrome-headless-shell,
 * GRAFT_DEMO_BROWSER), one persistent profile so the session cookie survives: anonymous session refused,
 * sign-in through the deterministic provider stand-in, session established. Page images only. */
async function showResultInBrowser(base) {
  const browser = process.env.GRAFT_DEMO_BROWSER;
  if (!browser || !fs.existsSync(browser)) { step('scene-result-skipped', { reason: 'no GRAFT_DEMO_BROWSER' }); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-demo-browser-'));
  const shots = [['result-anonymous', '/api/session'], ['result-sign-in', '/auth/login'], ['result-session', '/api/session']];
  for (const [name, route] of shots) {
    const file = path.join(HOME, 'screenshots', `${String(evidence.screenshots.length + 1).padStart(2, '0')}-scene-${name}.png`);
    try {
      // Asynchronous on purpose: the provider stand-in the sign-in talks to lives in THIS process, so a
      // synchronous child would block the event loop and the browser would wait forever.
      await new Promise((resolve, reject) => {
        const child = spawn(browser, ['--headless', `--user-data-dir=${profile}`, '--window-size=1440,810', '--hide-scrollbars', '--force-device-scale-factor=2', '--virtual-time-budget=4000', `--screenshot=${file}`, `${base}${route}`], { stdio: 'ignore' });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('browser timeout')); }, 30000);
        child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`browser exited ${code}`)); });
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      if (process.env.GRAFT_DEMO_EVIDENCE_DIR) fs.copyFileSync(file, path.join(process.env.GRAFT_DEMO_EVIDENCE_DIR, path.basename(file)));
      evidence.screenshots.push(file);
      step(`scene-${name}`, { route, holdMs: PACE_MS / 2 });
    } catch (err) { step(`scene-${name}-skipped`, { route, error: err.message.slice(0, 120) }); }
  }
  fs.rmSync(profile, { recursive: true, force: true });
}
/** Continuous-recording mode: a fixed-length screen recording cannot be stopped early, so the app stays
 * on its last scene until the recorder says the capture has ended (GRAFT_DEMO_HOLD_FILE appears). */
async function holdForRecorder() {
  const file = process.env.GRAFT_DEMO_HOLD_FILE; if (!file) return;
  const t0 = Date.now();
  while (!fs.existsSync(file) && Date.now() - t0 < 600000) await new Promise((r) => setTimeout(r, 250));
  step('recorder-released', { waitedMs: Date.now() - t0 });
}
const quitNatively = () => execFileSync('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { timeout: 60000 });

async function cdp(urlMatch, method, params, { commandTimeout = 45000 } = {}) {
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
    return list.find((t) => t.type === 'page' && t.url.includes(urlMatch) && t.webSocketDebuggerUrl) || null;
  }, { what: `the ${urlMatch} renderer` });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer call timed out')), commandTimeout);
      ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.id !== 1) return; clearTimeout(timer); if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally { ws.close(); }
}
/** Run an expression in the page. Keep each one short; poll from here instead. */
async function ui(expression, urlMatch = '127.0.0.1', { commandTimeout } = {}) {
  const result = await cdp(urlMatch, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, commandTimeout ? { commandTimeout } : {});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed');
  return result.result.value;
}
async function screenshot(name, selector = null) {
  try {
    if (selector) { await ui(`(document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' }), null)`); await new Promise((r) => setTimeout(r, 400)); }
    const shot = await cdp('127.0.0.1', 'Page.captureScreenshot', { format: 'png' });
    const file = path.join(HOME, 'screenshots', `${String(evidence.screenshots.length + 1).padStart(2, '0')}-${name}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    // Copied out at once: the session home is wiped on the next run, the evidence folder is not.
    if (process.env.GRAFT_DEMO_EVIDENCE_DIR) { fs.mkdirSync(process.env.GRAFT_DEMO_EVIDENCE_DIR, { recursive: true }); fs.copyFileSync(file, path.join(process.env.GRAFT_DEMO_EVIDENCE_DIR, path.basename(file))); }
    evidence.screenshots.push(file);
    console.log(`screenshot ${file}`);
  } catch (err) { console.log(`screenshot ${name} skipped: ${err.message}`); }
}
const WAIT = `const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };`;
const click = (selector, tries = 100) => ui(`(async () => { ${WAIT} const el = await wait(() => document.querySelector(${JSON.stringify(selector)}), ${tries}); if (!el) return { error: 'missing control ' + ${JSON.stringify(selector)}, body: document.body.innerText.slice(0, 300) }; el.click(); return { clicked: true, text: el.innerText }; })()`);
const confirmTrust = () => ui(`(async () => { ${WAIT} const form = await wait(() => document.querySelector('dialog[open] #confirm-form')); if (!form) return { error: 'no confirmation dialog', body: document.body.innerText.slice(0, 300) }; const text = document.querySelector('dialog[open]').innerText; form.querySelector('[name="trusted"]').checked = true; form.requestSubmit(); return { confirmed: true, text }; })()`);
/** The page's own view of the operation it started; polled from here, never one long evaluation. */
const idle = async (what, timeout = 300000, phases = null, expectedLabel = null) => {
  const done = await waitFor(() => ui(`(() => { const strip = document.querySelector('.active-strip'); if (strip) return { running: true, phase: strip.querySelector('small')?.innerText || '' }; const d = document.querySelector('dialog[open] .job-phase'); if (!d) return null; return { running: false, status: d.querySelector('.badge')?.innerText || null, phase: d.querySelector('strong')?.innerText || null, title: document.querySelector('dialog[open] h2')?.innerText || '', dialog: document.querySelector('dialog[open]')?.innerText || null }; })()`).then((v) => { if (!v) return null; if (v.running) { if (phases && phases.at(-1) !== v.phase) phases.push(v.phase); return null; } if (expectedLabel && !v.dialog.includes(expectedLabel)) return null; return v; }), { timeout, interval: 1000, what });
  // Paced (recorded) runs leave the finished job's own result on screen for a moment before closing it.
  if (PACE_MS) { step('job-result-shown', { title: done.title, status: done.status, holdMs: PACE_MS }); await new Promise((r) => setTimeout(r, PACE_MS)); }
  // Dismiss it the way a person does: the dialog's own close control.
  await ui(`(document.querySelector('dialog[open] [data-action="close"]')?.click(), null)`);
  return done;
};
const text = (selector) => ui(`document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);

async function main() {
  if (!fs.existsSync(EXE)) fail(`Build the packaged ${JUDGE ? 'judge candidate' : 'fixture'} first: npm run desktop:package -- --${JUDGE ? 'judge' : 'fixture'}`);
  for (const dir of [...WORKSPACES, ...(COMPOSE ? [] : [under(DESTINATION_NAME)])]) if (!fs.existsSync(dir)) fail(`${dir} does not exist`);
  const destinationRoot = COMPOSE ? null : fs.realpathSync(under(DESTINATION_NAME));
  const sourceRoot = fs.existsSync(under(SOURCE_NAME)) ? fs.realpathSync(under(SOURCE_NAME)) : null;
  const registryFile = path.join(HOME, 'graft-state', 'transplants.json');
  const live = fs.existsSync(registryFile) ? JSON.parse(fs.readFileSync(registryFile, 'utf8')).transplants.filter((t) => t.state !== 'CLEANED' && fs.existsSync(t.worktree.path)) : [];
  if (CLEANUP_ONLY) return cleanupOnly(destinationRoot, live);
  if (live.length) fail(`${HOME} still owns ${live.length} worktree(s). Clean them up in the app first: npm run desktop:demo -- --cleanup-only`);
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const secondSource = COMPOSE && fs.existsSync(SECOND_SOURCE) ? fs.realpathSync(SECOND_SOURCE) : null;
  const before = { destination: destinationRoot ? repoState(destinationRoot) : null, source: sourceRoot ? repoState(sourceRoot) : null, secondSource: secondSource ? repoState(secondSource) : null };
  evidence.graftCommit = git(process.cwd(), ['rev-parse', 'HEAD']);
  evidence.app = { exe: EXE, home: HOME };
  evidence.query = QUERY;
  evidence.before = before;
  step('baseline', { graft: evidence.graftCommit.slice(0, 12), destination: before.destination ? { head: before.destination.head.slice(0, 12), branch: before.destination.branch, dirty: before.destination.dirty, graftBranches: before.destination.graftBranches } : null, secondSource: before.secondSource ? { head: before.secondSource.head.slice(0, 12), dirty: before.secondSource.dirty } : null });

  // The packaged app, an isolated home, the dogfood recorder, and the folder the customer picks.
  if (EXPORT_DIR) fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const app = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env: { ...process.env, GRAFT_FIXTURE_HOME: HOME, GRAFT_DOGFOOD: SESSION, GRAFT_FIXTURE_CHOOSE: [...WORKSPACES, ...(ASSEMBLE_PARENT ? [path.resolve(ASSEMBLE_PARENT)] : []), ...(BETA ? [BETA_EXPORT, path.resolve(ASSEMBLE_PARENT || '.'), BETA_DIAG, path.resolve(ASSEMBLE_PARENT || '.')] : [])].join(path.delimiter), ...(EXPORT_DIR ? { GRAFT_FIXTURE_SAVE: path.resolve(EXPORT_DIR) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; for (const s of [app.stdout, app.stderr]) s.on('data', (d) => log.push(d.toString()));
  try {
    await waitFor(() => fs.existsSync(path.join(HOME, 'startup.json')), { what: 'the packaged startup report' });
    const startup = JSON.parse(fs.readFileSync(path.join(HOME, 'startup.json'), 'utf8'));
    evidence.app.version = startup.version; evidence.app.packaged = startup.packaged; evidence.app.runtime = startup.runtime;
    step('launched', { version: startup.version, packaged: startup.packaged, node: startup.runtime?.version });

    // 1. Access: the Galuxium judge build starts with its bounded demo entitlement. The fixture
    // follows the customer activation flow through the page's own bridge and licence service.
    let activated;
    if (JUDGE) {
      activated = await waitFor(
        () => ui('window.graftDesktop.licenseStatus()', '127.0.0.1').then((status) => status?.allowed ? status : null).catch(() => null),
        { timeout: 120000, interval: 1000, what: 'the judge demo entitlement' },
      );
    } else {
      activated = await ui(`(async () => { ${WAIT} const input = await wait(() => document.querySelector('#license-key')); if (!input) return { error: 'no licence form' }; input.value = ${JSON.stringify(KEY)}; return window.graftDesktop.activate(${JSON.stringify(KEY)}).then((v) => ({ submitted: true, allowed: v.allowed, message: v.message }), (e) => ({ error: String(e && e.message || e) })); })()`, 'license-ui').catch((err) => (/navigated or closed/.test(err.message) ? { submitted: true, navigated: true } : { error: err.message }));
      if (activated.error) fail(`licence: ${activated.error}`);
      if (/invalid|error|could not/i.test(activated.status)) fail(`licence: ${activated.status}`);
      evidence.manualInterventions.push('typed the licence key into the licence page');
    }
    step('licence', activated);

    // 2. Discover: authorize the real workspace folder (native chooser answered by the fixture seam) and index it.
    // Harness only: the packaged renderer occasionally does not answer the first DevTools evaluations
    // after the licence page navigates (the product itself is up — its own HTTP state proves it). Poll
    // gently, and if the first window does not answer, reload the renderer once before giving up.
    // Measured on this machine: the workspace renderer answered nothing for ~105 s after activation
    // and was fully painted by ~120 s, while the product's own HTTP server was serving correctly the
    // whole time. That is the machine, not the product, so the harness waits in short polls (a long
    // per-call timeout would burn the whole budget on one unanswered call) over a bounded budget.
    const sidebarReady = async (timeout) => waitFor(() => ui(`Boolean(document.querySelector('.sidebar'))`, '127.0.0.1', { commandTimeout: 8000 }).catch(() => false), { timeout, interval: 2000, what: 'the workspace page after activation' });
    const FIRST_PAINT_MS = Number(process.env.GRAFT_DEMO_FIRST_PAINT_MS || 300000);
    const paintClock = Date.now();
    try { await sidebarReady(FIRST_PAINT_MS); step('workspace-first-paint', { msAfterActivation: Date.now() - paintClock }); evidence.firstPaintMs = Date.now() - paintClock; }
    catch {
      evidence.manualInterventions.push('harness: reloaded the packaged renderer once after a stalled DevTools attachment');
      step('harness-renderer-reload', { reason: `no DevTools answer within ${Math.round(FIRST_PAINT_MS / 1000)} s of activation` });
      await ui('location.reload(), null').catch(() => null);
      try { await sidebarReady(FIRST_PAINT_MS); }
      catch (err) { const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []); fail(`${err.message}; renderer targets: ${JSON.stringify(targets.map((t) => ({ type: t.type, url: t.url.slice(0, 120), ws: Boolean(t.webSocketDebuggerUrl) })))}`); }
    }
    if (process.env.GRAFT_DEMO_BOUNDS_FILE) {
      // Continuous-recording mode: bring the app to the front and publish its real window bounds (points)
      // so the recorder captures exactly this window's region. No window is moved or resized.
      try { execFileSync('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to activate`]); } catch { /* best effort */ }
      await new Promise((r) => setTimeout(r, 600));
      const bounds = await ui(`({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, dpr: window.devicePixelRatio })`);
      fs.writeFileSync(process.env.GRAFT_DEMO_BOUNDS_FILE, JSON.stringify({ ...bounds, at: new Date().toISOString() }));
      step('window-bounds', bounds);
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (PACE_MS) { await ui(`(location.hash = 'workspace', null)`); await scene('opening'); }
    await ui(`(location.hash = 'discover', null)`);
    let roots = [];
    for (const [i, workspace] of WORKSPACES.entries()) {
      const added = await click('[data-action="add-root"]');
      if (added.error) fail(`add-root: ${added.error}`);
      evidence.manualInterventions.push(`chose ${workspace} in the folder dialog`);
      roots = await waitFor(() => ui(`(() => { const rows = [...document.querySelectorAll('.root-list .history-row strong')].map((e) => e.innerText); return rows.length > ${i} ? rows : null; })()`), { what: 'the authorized folder to appear' });
      if (!roots.some((r) => fs.realpathSync(r) === fs.realpathSync(workspace))) fail(`the workspace was not authorized: ${roots.join(', ')}`);
    }
    step('workspace-authorized', { roots });
    const indexed = await click('[data-action="index-workspace"]');
    if (indexed.error) fail(`index: ${indexed.error}`);
    const indexJob = await idle('indexing to finish', 600000, null, 'Index workspace');
    const summary = (await text('main')).split('\n').filter((l) => /project|capabilit|indexed|root/i.test(l)).slice(0, 8);
    await scene('memory-indexed', PACE_MS / 2); step('workspace-indexed', { job: { status: indexJob.status, phase: indexJob.phase }, dialog: (indexJob.dialog || '').split('\n').slice(0, 8), page: summary });
    if (indexJob.status !== 'completed') fail(`indexing ${indexJob.status}: ${(indexJob.dialog || '').slice(0, 300)}`);

    // 3. Search Capability Memory with the real question, and harvest the top harvestable result.
    const harvestFromMemory = async (query) => {
    const searched = await ui(`(async () => { ${WAIT} const input = await wait(() => document.querySelector('#discover-text')); if (!input) return { error: 'no discover form' }; input.value = ${JSON.stringify(query)}; const stale = [...document.querySelectorAll('.discovery-card')].map((c) => c.innerText).join('|'); document.querySelector('#discover-form').requestSubmit(); const cards = await wait(() => { const c = document.querySelectorAll('.discovery-card'); if (!c.length) return null; return stale && [...c].map((x) => x.innerText).join('|') === stale ? null : c; }, 300); if (!cards) return { error: 'no results', body: document.querySelector('main')?.innerText.slice(0, 400) }; return { results: [...cards].map((c) => ({ name: c.querySelector('.discovery-head strong')?.innerText, state: c.querySelector('.discovery-head .badge')?.innerText || null, subtypes: c.querySelector('.discovery-subtypes')?.innerText, axes: c.querySelector('.discovery-axes')?.innerText || null, matched: [...c.querySelectorAll('p.fine')].map((p) => p.innerText).find((t) => t.startsWith('Matched because')) || null, harvestable: Boolean(c.querySelector('[data-action="harvest-candidate"]')), status: c.querySelector('.discovery-status')?.innerText, projectId: c.querySelector('[data-action="harvest-candidate"]')?.dataset.id || c.querySelector('[data-action="capability-detail"]')?.dataset.id || null })) }; })()`);
    if (searched.error) fail(`search: ${searched.error}`);
    step('search', { query, count: searched.results.length, ranking: searched.results.map((r, i) => `${i + 1}. ${r.name} [${r.harvestable ? 'harvestable' : 'not harvestable'}]`) });
    await screenshot('search-results', '.discovery-card');
    if (PACE_MS) await scene('found', PACE_MS);
    // The customer picks the top harvestable result. Its identity is recorded, not assumed.
    const chosen = searched.results.find((r) => r.harvestable);
    if (!chosen) fail('no harvestable result to pick');
    evidence.source = chosen;
    step('source-picked', { name: chosen.name, projectId: chosen.projectId, axes: chosen.axes, subtypes: chosen.subtypes, rank: searched.results.indexOf(chosen) + 1 });
    const detail = await ui(`(async () => { ${WAIT} const b = [...document.querySelectorAll('[data-action="capability-detail"]')].find((x) => x.dataset.id === ${JSON.stringify(chosen.projectId)}); if (!b) return { error: 'no detail control' }; b.click(); const d = await wait(() => document.querySelector('dialog[open]')); if (!d) return { error: 'detail did not open' }; const t = d.innerText; d.close(); return { text: t }; })()`);
    evidence.sourceDetail = detail.text || null;

    // 4. Harvest as source (trust confirmation, then the product verifies the real source through its seam).
    const harvest = await ui(`(async () => { ${WAIT} const b = [...document.querySelectorAll('[data-action="harvest-candidate"]')].find((x) => x.dataset.id === ${JSON.stringify(chosen.projectId)}); if (!b) return { error: 'no harvest control' }; b.click(); return { clicked: true, slug: b.dataset.slug }; })()`);
    if (harvest.error) fail(`harvest: ${harvest.error}`);
    const confirmedHarvest = await confirmTrust();
    if (confirmedHarvest.error) fail(`harvest confirmation: ${confirmedHarvest.error}`);
    evidence.manualInterventions.push('confirmed "Harvest this capability" (trust checkbox)');
    const harvestJob = await idle('the harvest to finish', 600000, null, 'Harvest ');
    const harvestDialog = harvestJob.dialog || '';
    const harvestResult = { status: harvestJob.status, verdict: (/\b(VERIFIED|FAILED|NEEDS_REVIEW)\b/.exec(harvestDialog) || [])[1] || null, required: (/(\d+) \/ (\d+) required tests passed/.exec(harvestDialog) || []).slice(1, 3), dialog: harvestDialog.split('\n').slice(0, 10) };
    step('harvested', harvestResult); await scene('harvested', PACE_MS / 2);
    if (harvestJob.status !== 'completed') fail(`harvest ${harvestJob.status}: ${harvestDialog.slice(0, 300)}`);
    if (harvestResult.verdict !== 'VERIFIED') fail(`the source was not VERIFIED: ${harvestResult.verdict}`);
    return { chosen, harvestResult, detail };
    };
    const first = await harvestFromMemory(QUERY);
    const chosen = first.chosen;
    evidence.harvest = first.harvestResult;

    if (COMPOSE) { await composeFlow({ harvestFromMemory, sourceRoot, secondSource, before }); return; }
    if (EXPORT_DIR) {
      // Download capability from the harvest result: the page's own exits, the fixture-answered save dialog.
      await ui(`(location.hash = 'bank', null)`);
      const exported = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('dialog[open] [data-action="export-capability"], .capability-exits [data-action="export-capability"]')); if (!b) return { error: 'no Download capability control', body: document.body.innerText.slice(0, 300) }; b.click(); const d = await wait(() => { const x = document.querySelector('dialog[open]'); return x && /Capability downloaded|already exists/.test(x.innerText) ? x.innerText : null; }, 300); return { dialog: d, reveal: Boolean(document.querySelector('dialog[open] [data-action="wf-reveal"]')) }; })()`);
      if (exported.error || !/Capability downloaded/.test(exported.dialog || '')) fail(`export: ${exported.error || exported.dialog}`);
      evidence.manualInterventions.push(`chose ${EXPORT_DIR} in the save dialog`);
      step('exported', { dialog: exported.dialog.split('\n').slice(0, 12), reveal: exported.reveal });
      await screenshot('download-capability', 'dialog[open]');
      evidence.export = { dialog: exported.dialog };
      await ui(`(document.querySelector('dialog[open] [data-action="close"]')?.click(), null)`);
      evidence.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(HOME, 'evidence.json'), JSON.stringify(evidence, null, 2));
      step('export-done', { file: path.join(HOME, 'evidence.json') });
      return;
    }
    if (BLUEPRINT) {
      // Laboratory: "What are you building?" from the page. GRAFT answers from Capability Memory only;
      // the driver records what the page shows and never fabricates a match.
      await ui(`(location.hash = 'laboratory', null)`);
      const labText = (sel = 'main') => text(sel);
      const created = await ui(`(async () => { ${WAIT} const form = await wait(() => document.querySelector('#lab-create-form')); if (!form) return { error: 'no Laboratory form' }; form.name.value = ${JSON.stringify(BLUEPRINT_NAME)}; form.description.value = ${JSON.stringify(BLUEPRINT_TEXT)}; const wanted = ${JSON.stringify(BLUEPRINT_CHECKS)}; const boxes = [...form.querySelectorAll('input[name="categories"]')]; for (const b of boxes) b.checked = wanted.includes(b.value); form.requestSubmit(); const head = await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)), 200); if (!head) return { error: 'the blueprint did not open', main: document.querySelector('main').innerText.slice(0, 600) }; return { checked: boxes.filter((b) => b.checked).map((b) => b.value), overview: document.querySelector('main').innerText }; })()`);
      if (created.error) fail(`blueprint: ${created.error} ${created.main || ''}`);
      evidence.manualInterventions.push('described the application and ticked the checklist');
      step('blueprint-created', { checked: created.checked, overview: created.overview.split('\n').filter(Boolean).slice(0, 24) });
      await screenshot('blueprint-overview', '.bp-tree');
      // Capabilities: every goal, its candidates, and NOT FOUND where Capability Memory has nothing.
      await click('[data-action="lab-tab"][data-id="capabilities"]');
      const goals = await ui(`(() => [...document.querySelectorAll('.bp-goal')].map((g) => ({ goal: g.querySelector('h2')?.innerText, required: /required/.test(g.querySelector('.section-heading')?.innerText || ''), notFound: /NOT FOUND/.test(g.innerText), candidates: [...g.querySelectorAll('[data-action="lab-select"]')].map((c) => c.innerText.replace(/\\n/g, ' | ')) })))()`);
      step('blueprint-goals', { goals: goals.map((g) => ({ goal: g.goal, notFound: g.notFound, candidates: g.candidates.length, top: g.candidates[0] || null })) });
      await screenshot('blueprint-capabilities', '.bp-goal');
      // The person picks the implementation the product just harvested (its source verdict is on the card).
      const picked = await ui(`(async () => { ${WAIT} const cards = [...document.querySelectorAll('.bp-goal [data-action="lab-select"]')]; const card = cards.find((c) => /source VERIFIED/.test(c.innerText)) || null; if (!card) return { error: 'no harvested candidate offered', cards: cards.map((c) => c.innerText.slice(0, 80)) }; const label = card.closest('.bp-goal').querySelector('h2').innerText; card.click(); const ok = await wait(() => [...document.querySelectorAll('.bp-goal .wf-choice.selected')].length, 100); return ok ? { goal: label, card: card.innerText.replace(/\\n/g, ' | ') } : { error: 'selection did not register' }; })()`);
      if (picked.error) fail(`blueprint selection: ${picked.error} ${JSON.stringify(picked.cards || [])}`);
      evidence.manualInterventions.push(`selected "${picked.card.slice(0, 60)}" for ${picked.goal}`);
      step('blueprint-selected', picked);
      const sections = {};
      for (const tab of ['dependencies', 'conflicts', 'evidence', 'overview']) { await click(`[data-action="lab-tab"][data-id="${tab}"]`); await new Promise((r) => setTimeout(r, 400)); sections[tab] = await labText(); await screenshot(`blueprint-${tab}`, tab === 'dependencies' ? '.bp-table' : tab === 'overview' ? '.bp-tree' : '.panel'); }
      const readiness = (/(Draft|Needs selections|Missing capabilities|Has conflicts|Ready for assembly planning)/.exec(sections.overview) || [])[1] || null;
      step('blueprint-readiness', { readiness, reason: sections.overview.split('\n').find((l) => /goal\(s\)|every required goal|no capability goals/.test(l)) || null });
      evidence.blueprint = { name: BLUEPRINT_NAME, checks: BLUEPRINT_CHECKS, goals, picked, readiness, sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.split('\n').filter(Boolean)])) };
      const blueprintsDir = path.join(HOME, 'graft-state', 'laboratory', 'blueprints');
      const files = fs.existsSync(blueprintsDir) ? fs.readdirSync(blueprintsDir).filter((f) => f.endsWith('.json')) : [];
      const stored = files.map((f) => JSON.parse(fs.readFileSync(path.join(blueprintsDir, f), 'utf8')));
      const bp = stored.find((b) => b.name === BLUEPRINT_NAME) || stored[0];
      if (!bp) fail('no blueprint was saved');
      const raw = fs.readFileSync(path.join(blueprintsDir, `${bp.blueprintId}.json`), 'utf8');
      const leaks = [os.homedir(), HOME, WORKSPACE, sourceRoot].filter(Boolean).filter((p) => raw.includes(p));
      evidence.blueprint.stored = { blueprintId: bp.blueprintId, schemaVersion: bp.schemaVersion, goals: bp.goals.map((g) => ({ category: g.category, required: g.required, source: g.source, selected: g.selection ? `${g.selection.kind}:${g.selection.slug || g.selection.projectId}` : null })), hostIntent: bp.hostIntent, agentAdvice: bp.agentAdvice, pathLeaks: leaks.length, hasAnalysis: raw.includes('"analysis"') };
      if (leaks.length || raw.includes('"analysis"')) fail(`the stored blueprint leaks: paths=${leaks.length} analysis=${raw.includes('"analysis"')}`);
      step('blueprint-stored', evidence.blueprint.stored);
      await ui(`(location.hash = 'bank', null)`);
      const useExit = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('.capability-exits [data-action="lab-use"]')); return b ? { enabled: !b.disabled, text: b.innerText } : { error: 'no Use in Laboratory control' }; })()`);
      step('use-in-laboratory-exit', useExit);
      if (PLAN) {
        const BUILD = `const build = async (arch) => { const sel = await wait(() => document.querySelector('#lab-arch')); if (!sel) return { error: 'no host chooser' }; const wanted = sel.querySelector('option[value="' + arch + '"]')?.textContent?.split(' — ')[0] || arch; sel.value = arch; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true; document.querySelector('[data-action="lab-plan-build"]').click(); const ok = await wait(() => { const spec = document.querySelector('.asm-spec'); return spec && spec.innerText.includes(wanted) ? spec : null; }, 300); if (!ok) return { error: 'the plan for ' + arch + ' did not render', main: document.querySelector('main').innerText.slice(0, 400) }; const main = document.querySelector('main').innerText; const rows = [...document.querySelectorAll('.asm-steps tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.split('\\n')[0]).join(' | ')); const assemble = [...document.querySelectorAll('button')].find((b) => /Assemble application/.test(b.innerText)); return { main, rows, assembleDisabled: assemble ? assemble.disabled : null }; };`;
        // Case A: the blocked Client Portal blueprint.
        await ui(`(location.hash = 'laboratory', null)`);
        await ui(`(async () => { ${WAIT} const back = document.querySelector('[data-action="lab-back"]'); if (back) { back.click(); await wait(() => document.querySelector('[data-action="lab-open"]')); } return null; })()`);
        const reopened = await click(`[data-action="lab-open"][data-id="${bp.blueprintId}"]`);
        if (reopened.error) fail(`reopen blueprint: ${reopened.error}`);
        await click('[data-action="lab-tab"][data-id="plan"]');
        const caseA = await ui(`(async () => { ${WAIT} ${BUILD} return build(${JSON.stringify(PLAN_ARCH)}); })()`);
        if (caseA.error) fail(`plan A: ${caseA.error} ${caseA.main || ''}`);
        evidence.manualInterventions.push(`chose the new-application host ${PLAN_ARCH} and clicked Build assembly plan (Client portal)`);
        const readinessOf = (main) => (/(Ready to assemble|Blocked by the blueprint|Needs a host|Unsupported host|Blocked: dependency cycle|Blocked: capability support|Draft)/.exec(main) || [])[1] || null;
        const blockersOf = (main) => main.split('\n').filter((l) => /^(MISSING CAPABILITY|UNSELECTED GOAL|SOURCE UNAVAILABLE|CONFLICT|UNMET DEPENDENCY|HOST UNDECIDED|UNSUPPORTED HOST|DEPENDENCY CYCLE|CAPABILITY UNSUPPORTED|EMPTY BLUEPRINT)/.test(l));
        step('plan-case-a', { readiness: readinessOf(caseA.main), blockers: blockersOf(caseA.main), steps: caseA.rows, assembleDisabled: caseA.assembleDisabled });
        await screenshot('plan-blocked', '.asm-steps');
        evidence.planA = { readiness: readinessOf(caseA.main), blockers: blockersOf(caseA.main), steps: caseA.rows, assembleDisabled: caseA.assembleDisabled, text: caseA.main.split('\n').filter(Boolean) };
        // Case B: a new blueprint from the capability page (Use in Laboratory → New blueprint), planned onto the proven new host.
        await ui(`(location.hash = 'bank', null)`);
        const fresh = await ui(`(async () => { ${WAIT} const use = await wait(() => document.querySelector('.capability-exits [data-action="lab-use"]')); if (!use) return { error: 'no Use in Laboratory control' }; use.click(); const choice = await wait(() => document.querySelector('dialog[open] [data-action="lab-use-into"][data-id=""]')); if (!choice) return { error: 'no new-blueprint choice' }; choice.click(); const ok = await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)) && /Ready for assembly planning/.test(document.querySelector('main').innerText), 200); return ok ? { overview: document.querySelector('main').innerText } : { error: 'the new blueprint did not reach READY_FOR_ASSEMBLY_PLANNING', main: document.querySelector('main').innerText.slice(0, 400) }; })()`);
        if (fresh.error) fail(`use in laboratory: ${fresh.error} ${fresh.main || ''}`);
        evidence.manualInterventions.push('clicked Use in Laboratory → New blueprint on the harvested capability');
        step('blueprint-b-created', { overview: fresh.overview.split('\n').filter(Boolean).slice(0, 12) });
        await click('[data-action="lab-tab"][data-id="plan"]');
        const caseB = await ui(`(async () => { ${WAIT} ${BUILD} return build(${JSON.stringify(PLAN_ARCH)}); })()`);
        if (caseB.error) fail(`plan B: ${caseB.error} ${caseB.main || ''}`);
        evidence.manualInterventions.push(`chose the new-application host ${PLAN_ARCH} and clicked Build assembly plan (Authenticated application)`);
        step('plan-case-b', { readiness: readinessOf(caseB.main), blockers: blockersOf(caseB.main), steps: caseB.rows, assembleDisabled: caseB.assembleDisabled });
        await screenshot('plan-ready', '.asm-steps');
        evidence.planB = { readiness: readinessOf(caseB.main), blockers: blockersOf(caseB.main), steps: caseB.rows, assembleDisabled: caseB.assembleDisabled, text: caseB.main.split('\n').filter(Boolean) };
        // Case C: the same library capability on a host with no proven adaptation. The packaged UI
        // must say so and must not offer Assemble. Then the supported plan is rebuilt for the run.
        if (UNSUPPORTED_ARCH) {
          const caseC = await ui(`(async () => { ${WAIT} ${BUILD} return build(${JSON.stringify(UNSUPPORTED_ARCH)}); })()`);
          if (caseC.error) fail(`plan C: ${caseC.error} ${caseC.main || ''}`);
          evidence.planUnsupported = { arch: UNSUPPORTED_ARCH, readiness: readinessOf(caseC.main), blockers: blockersOf(caseC.main), assembleDisabled: caseC.assembleDisabled, text: caseC.main.split('\n').filter(Boolean) };
          step('plan-case-c-unsupported', evidence.planUnsupported);
          await screenshot('plan-unsupported', '.asm-steps');
          if (evidence.planUnsupported.readiness !== 'Blocked: capability support') fail(`the unsupported host was not blocked (${evidence.planUnsupported.readiness})`);
          if (caseC.assembleDisabled !== true) fail('Assemble application was offered for an unsupported host');
          if (!/no proven adaptation/.test(caseC.main)) fail('the blocked plan does not say why the host is unsupported');
          const again = await ui(`(async () => { ${WAIT} ${BUILD} return build(${JSON.stringify(PLAN_ARCH)}); })()`);
          if (again.error) fail(`rebuild supported plan: ${again.error}`);
          if (readinessOf(again.main) !== 'Ready to assemble') fail(`the supported plan did not come back READY (${readinessOf(again.main)})`);
          step('plan-supported-rebuilt', { readiness: readinessOf(again.main), assembleDisabled: again.assembleDisabled });
        }
        const plansDir = path.join(HOME, 'graft-state', 'laboratory', 'plans');
        const planFiles = fs.existsSync(plansDir) ? fs.readdirSync(plansDir).filter((f) => f.endsWith('.json')) : [];
        const plans = planFiles.map((f) => JSON.parse(fs.readFileSync(path.join(plansDir, f), 'utf8')));
        const planText = planFiles.map((f) => fs.readFileSync(path.join(plansDir, f), 'utf8')).join('\n');
        const planLeaks = [os.homedir(), HOME, WORKSPACE, sourceRoot].filter(Boolean).filter((p) => planText.includes(p));
        evidence.plans = plans.map((p) => ({ planId: p.planId, blueprintId: p.blueprintId, readiness: p.readiness, host: p.host?.label || p.host?.name || p.host?.kind, hostId: p.host?.hostId || null, steps: p.steps.map((s) => `${s.type}${s.supported ? '' : ' (unsupported)'}`), blockers: p.blockers.map((b) => b.kind), warnings: p.warnings.map((w) => w.kind), capabilities: p.expectedCapabilities.map((c) => c.capabilityId), executable: p.executable, executionAvailable: p.executionAvailable, agentAdvice: p.agentAdvice }));
        evidence.planPrivacy = { files: planFiles.length, pathLeaks: planLeaks.length, worktreesDir: fs.existsSync(path.join(HOME, 'graft-state', 'worktrees')), registryTransplants: (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'graft-state', 'transplants.json'), 'utf8')).transplants.length; } catch { return 0; } })() };
        if (planLeaks.length) fail(`stored plans leak ${planLeaks.length} local path(s)`);
        step('plans-stored', evidence.planPrivacy);
        if (ASSEMBLE_PARENT) {
          // Assemble application: the confirmation dialog, the folder dialog (answered by the fixture seam), then the product's own progress.
          fs.mkdirSync(path.resolve(ASSEMBLE_PARENT), { recursive: true });
          const parentBefore = fs.readdirSync(path.resolve(ASSEMBLE_PARENT));
          const opened = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="lab-assemble"]')); if (!b) return { error: 'Assemble application is not enabled', main: document.querySelector('main').innerText.slice(-600) }; b.click(); const d = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!d) return { error: 'no confirmation dialog' }; return { dialog: document.querySelector('dialog[open]').innerText }; })()`);
          if (opened.error) fail(`assemble: ${opened.error} ${opened.main || ''}`);
          step('assemble-confirmation', { dialog: opened.dialog.split('\n').filter(Boolean).slice(0, 14) });
          await screenshot('assemble-confirmation', 'dialog[open]');
          const chosen = await ui(`(async () => { ${WAIT} document.querySelector('#asm-name').value = ${JSON.stringify(ASSEMBLE_NAME)}; document.querySelector('[data-action="lab-assemble-choose"]').click(); const v = await wait(() => document.querySelector('#asm-parent').value || null, 100); if (!v) return { error: 'the folder dialog returned nothing' }; document.querySelector('[data-action="lab-assemble-run"]').click(); return { parent: v }; })()`);
          if (chosen.error) fail(`assemble folder: ${chosen.error}`);
          evidence.manualInterventions.push(`chose ${ASSEMBLE_PARENT} in the folder dialog and clicked Assemble`);
          // The Laboratory renders execution progress inline (no job dialog), so watch the page's own
          // state: collect the step labels as they run, then wait for the terminal assembly line.
          const phases = [];
          const seen = await waitFor(async () => {
            const snapshot = await ui(`(() => { const t = document.querySelector('main').innerText; return { steps: [...t.matchAll(/(Creating application|Creating host|Indexing host|Checking dependencies|Checking the verified artifact|Adding the library capability|Applying capability|Verifying the capability|Verifying|Checking host preservation|Final check)/g)].map((m) => m[1]), done: /Assembly (COMPLETED|FAILED|INCONCLUSIVE|BLOCKED)/.test(t) }; })()`).catch(() => null);
            for (const step of snapshot?.steps || []) if (!phases.includes(step)) phases.push(step);
            return snapshot?.done ? phases : null;
          }, { timeout: 1200000, interval: 400, what: 'the assembly to finish' });
          const execText = await ui(`document.querySelector('main').innerText`);
          const execLines = execText.split('\n').filter(Boolean);
          const from = execLines.findIndex((l) => /^Assembly execution/.test(l));
          step('assembled', { phasesSeen: seen, lines: execLines.slice(from, from + 40) });
          await screenshot('assembly-result', '.report-banner');
          const execDir = path.join(HOME, 'graft-state', 'laboratory', 'executions');
          const execFiles = fs.existsSync(execDir) ? fs.readdirSync(execDir).filter((f) => f.endsWith('.json')) : [];
          const execution = execFiles.length ? JSON.parse(fs.readFileSync(path.join(execDir, execFiles.at(-1)), 'utf8')) : null;
          if (!execution) fail('no execution record was written');
          const created = execution.createdProject?.root || null;
          const createdRepo = created && fs.existsSync(created) ? { files: fs.readdirSync(created).sort(), head: git(created, ['rev-parse', 'HEAD']), branch: git(created, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(created, ['status', '--porcelain']).split('\n').filter(Boolean).length, remotes: git(created, ['remote']) } : null;
          const wt = execution.worktree?.path && fs.existsSync(execution.worktree.path) ? { branch: git(execution.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']), head: git(execution.worktree.path, ['rev-parse', 'HEAD']), files: fs.readdirSync(execution.worktree.path, { recursive: true }).filter((f) => !f.startsWith('.git')).sort() } : null;
          const registry = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'graft-state', 'transplants.json'), 'utf8')).transplants; } catch { return []; } })();
          const record = registry.find((t) => t.id === execution.transplantId) || null;
          evidence.execution = { executionId: execution.executionId, planId: execution.planId, status: execution.status, finalState: execution.finalState, steps: execution.steps.map((s) => `${s.type}:${s.status}`), receipt: execution.receipts[0] ? { files: execution.receipts[0].files, initialCommit: execution.receipts[0].initialCommit, remotes: execution.receipts[0].remotes, fingerprint: execution.receipts[0].fingerprint } : null, createdProject: execution.createdProject, createdRepo, worktree: execution.worktree, worktreeState: wt, transplantPlan: execution.transplantPlan, verification: execution.verification, hostPreservation: execution.hostPreservation, reindex: execution.reindex, proofReferences: execution.proofReferences, finalSummary: execution.finalSummary, transplantRecord: record ? { id: record.id, state: record.state, verdict: record.verdict?.verdict || null, receipt: record.receipt ? { filesWritten: record.receipt.filesWritten, entrypoint: record.receipt.entrypoint } : null, history: record.history.map((h) => h.state) } : null, parentAfter: fs.readdirSync(path.resolve(ASSEMBLE_PARENT)).filter((f) => !parentBefore.includes(f)), agentAdvice: execution.agentAdvice };
          step('execution-record', { status: execution.status, verdict: execution.verification?.verdict || null, steps: evidence.execution.steps, created: createdRepo, worktree: wt ? { branch: wt.branch, files: wt.files.length } : null, transplant: evidence.execution.transplantRecord });
          // What the PERSON is shown about the proof, read from the page. Four separate claims, plus
          // the detector's own result — never one combined score.
          if (execution.adaptation) {
            const proven = await ui(`(async () => { ${WAIT} const t = await wait(() => /What was proven/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300); if (!t) return { error: 'the evidence panel never appeared' }; const from = t.indexOf('What was proven'); return { panel: t.slice(from, from + 2600) }; })()`);
            if (proven.error) fail(`evidence panel: ${proven.error}`);
            const panel = proven.panel;
            // Match the exact claim words the panel is allowed to show, so the read cannot run on
            // into the sentence that follows the badge.
            const CLAIMS = 'ADDED AND VERIFIED BY GRAFT|NOT OBSERVED|OBSERVED|NOT CAPTURED|VERIFIED|MATCHED|PASSED|FAILED|not recorded';
            const claim = (label) => (new RegExp(`${label}\\s*\\n?\\s*(${CLAIMS})`).exec(panel) || [])[1]?.trim() || null;
            evidence.evidencePanel = {
              text: panel.split('\n').filter(Boolean),
              source: claim('Source'), artifactIdentity: claim('Artifact identity'), destination: claim('Destination'),
              hostPreservation: claim('Host preservation'), presence: claim('Presence'), detector: claim('Independent detector'),
              separatesProofs: /There is no combined score/.test(panel),
              noCombinedScore: !/18\s*\/\s*18/.test(panel),
              explainsDetector: /does not recognise it\. That is not a failure/.test(panel),
              showsSourceCases: /8\s*\/\s*8/.test(panel), showsDestinationCases: /10\s*\/\s*10/.test(panel),
            };
            step('evidence-panel', evidence.evidencePanel);
            await screenshot('evidence-panel');
            const e2 = evidence.evidencePanel;
            if (e2.source !== 'VERIFIED') fail(`the panel does not show source VERIFIED (${e2.source})`);
            if (e2.artifactIdentity !== 'MATCHED') fail(`the panel does not show artifact MATCHED (${e2.artifactIdentity})`);
            if (e2.destination !== 'VERIFIED') fail(`the panel does not show destination VERIFIED (${e2.destination})`);
            if (e2.hostPreservation !== 'PASSED') fail(`the panel does not show host preservation PASSED (${e2.hostPreservation})`);
            if (!/NOT OBSERVED/.test(e2.detector || '')) fail(`the panel does not show the detector result honestly (${e2.detector})`);
            if (!e2.separatesProofs || !e2.noCombinedScore) fail('the panel must keep source and destination proof separate with no combined score');
            if (!e2.explainsDetector) fail('the panel must explain why the detector observes nothing');
            if (!e2.showsSourceCases || !e2.showsDestinationCases) fail('the panel must show 8/8 source and 10/10 destination separately');
          }
          if (FINALIZE) {
            const ledgerText = await ui(`(async () => { ${WAIT} const t = await wait(() => /Assembled application/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300); return t ? t.slice(t.indexOf('Assembled application')) : null; })()`);
            if (!ledgerText) fail('the assembled application panel never appeared');
            step('assembly-ledger', { lines: ledgerText.split('\n').filter(Boolean).slice(0, 16) });
            await screenshot('assembly-ledger', '.export-facts');
            const preRevision = git(created, ['rev-parse', 'HEAD']);
            const finalize = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="lab-finalize"]')); if (!b) return { error: 'Finalize is not offered' }; b.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-finalize-run"]')); if (!run) return { error: 'no confirmation dialog' }; const dialog = document.querySelector('dialog[open]').innerText; document.querySelector('#finalize-confirm').checked = true; run.click(); const done = await wait(() => /Finalized/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300); return done ? { dialog, done: done.slice(done.indexOf('Assembled application')) } : { error: 'finalization did not complete', main: document.querySelector('main').innerText.slice(-400) }; })()`);
            if (finalize.error) fail(`finalize: ${finalize.error} ${finalize.main || ''}`);
            evidence.manualInterventions.push('confirmed "Finalize assembled project" (explicit promotion)');
            step('finalized', { dialog: finalize.dialog.split('\n').filter(Boolean).slice(0, 10), result: finalize.done.split('\n').filter(Boolean).slice(0, 12) });
            await screenshot('finalized', '.notice');
            const workspaceDir = path.join(HOME, 'graft-state', 'laboratory', 'assemblies');
            const workspaceFiles = fs.existsSync(workspaceDir) ? fs.readdirSync(workspaceDir).filter((f) => f.endsWith('.json')) : [];
            const workspace = workspaceFiles.length ? JSON.parse(fs.readFileSync(path.join(workspaceDir, workspaceFiles[0]), 'utf8')) : null;
            if (!workspace) fail('no assembly workspace was written');
            const postRevision = git(created, ['rev-parse', 'HEAD']);
            const history = git(created, ['log', '--format=%H', '-3']).split('\n');
            evidence.continuity = { assemblyWorkspaceId: workspace.assemblyWorkspaceId, status: workspace.status, capabilities: workspace.capabilities.map((c) => ({ capability: c.capability, state: c.state, verdict: c.verificationVerdict, summary: c.verificationSummary, revisionAfter: c.destinationRevisionAfter, contractId: c.verificationContractId, genomeId: c.genomeId, irId: c.irId, proof: c.proofReference })), finalization: workspace.finalization, preRevision, postRevision, history, primaryAfter: { branch: git(created, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(created, ['status', '--porcelain']).split('\n').filter(Boolean).length, remotes: git(created, ['remote']), files: fs.readdirSync(created).sort(), hasAuth: fs.existsSync(path.join(created, 'src', 'auth', 'routes.js')) }, ledger: ledgerText.split('\n').filter(Boolean) };
            if (postRevision === preRevision) fail('the created project did not move to the assembled revision');
            if (history[1] !== preRevision) fail('the blank host commit is not the parent of the assembled revision');
            if (evidence.continuity.primaryAfter.remotes) fail('a remote was configured');
            step('continuity', { workspace: workspace.assemblyWorkspaceId, status: workspace.status, capability: evidence.continuity.capabilities[0], promotion: workspace.finalization, primary: evidence.continuity.primaryAfter });
            // The finalized application, run the way its owner would — from their own checkout, with
            // its own code. Not GRAFT's verification harness: the application itself has to work.
            const port = String(3960 + (PORT % 30));
            const adapted = Boolean(execution.adaptation);
            const started = spawn(process.execPath, ['server.mjs'], { cwd: created, env: adapted
              ? { ...process.env, PORT: port }
              : { ...process.env, PORT: port, AUTH_PROVIDER_ORIGIN: 'https://provider.invalid', AUTH_CLIENT_ID: 'x', AUTH_CLIENT_SECRET: 'y', AUTH_JWKS_URL: 'https://provider.invalid/jwks', AUTH_ISSUER: 'https://provider.invalid', AUTH_AUDIENCE: 'a', AUTH_PUBLIC_ORIGIN: `http://localhost:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
            try {
              await waitFor(async () => fetch(`http://localhost:${port}/health`).then((r) => r.ok).catch(() => false), { timeout: 20000, interval: 250, what: 'the finalized application to answer' });
              const health = await (await fetch(`http://localhost:${port}/health`)).json();
              if (adapted) {
                // The host's own behaviour, and a deterministic 404 for something it does not serve.
                const root = await fetch(`http://localhost:${port}/`);
                const unknown = await fetch(`http://localhost:${port}/no-such-route`);
                evidence.continuity.standaloneHost = { healthStatus: 200, health, rootStatus: root.status, rootBody: await root.json().catch(() => null), unknownStatus: unknown.status };
                step('finalized-host-runs', evidence.continuity.standaloneHost);
                if (!health.ok) fail('the finalized application does not answer /health');
                if (root.status !== 200) fail(`the finalized application does not answer / (${root.status})`);
                if (unknown.status !== 404) fail(`the finalized application does not answer 404 for an unknown route (${unknown.status})`);
              } else {
                const login = await fetch(`http://localhost:${port}/auth/login`, { redirect: 'manual' });
                evidence.continuity.standalone = { health, loginStatus: login.status, loginLocation: (login.headers.get('location') || '').split('?')[0] };
                step('finalized-app-runs', evidence.continuity.standalone);
                if (!health.ok) fail('the finalized application does not answer /health');
                if (![301, 302, 303, 307].includes(login.status)) fail(`/auth/login did not redirect (${login.status})`);
              }
            } finally { started.kill('SIGKILL'); }
            if (adapted) {
              // The capability itself, used the way the application's own code would use it: a plain
              // import of the generated adapter. GRAFT's harness takes no part in this.
              const adapterPath = execution.adaptation.adapter;
              const probe = path.join(created, '.graft-standalone-check.mjs');
              fs.writeFileSync(probe, `import Flags from './${adapterPath}';
const map = { Graft: [1, 2], 'Graft.enabled': [1], 'Graft.off': [], Parent: [1], 'Parent.child': [1] };
const on = new Flags({ map, bucketIndex: 1 }), other = new Flags({ map, bucketIndex: 2 });
let branch = null; on.branch('Graft.enabled', () => { branch = 'enabled'; }, () => { branch = 'disabled'; });
let offBranch = null; other.branch('Graft.enabled', () => { offBranch = 'enabled'; }, () => { offBranch = 'disabled'; });
console.log(JSON.stringify({ enabled: on.isEnabled('Graft.enabled'), disabledForOtherContext: other.isEnabled('Graft.enabled'),
  emptyMask: on.isEnabled('Graft.off'), unknown: on.isEnabled('Graft.not-configured'), parentGatesChild: other.isEnabled('Parent.child'),
  chooseEnabled: on.choose('Graft.enabled', 'on', 'off'), chooseDisabled: other.choose('Graft.enabled', 'on', 'off'),
  branch, offBranch, repeated: [on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled')] }));
`);
              let flags;
              try { flags = JSON.parse(execFileSync(process.execPath, [probe], { cwd: created, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })); }
              finally { fs.rmSync(probe, { force: true }); }
              evidence.continuity.standaloneCapability = flags;
              step('finalized-capability-runs', flags);
              const expected = { enabled: true, disabledForOtherContext: false, emptyMask: false, unknown: false, parentGatesChild: false, chooseEnabled: 'on', chooseDisabled: 'off', branch: 'enabled', offBranch: 'disabled' };
              for (const [key, want] of Object.entries(expected)) if (flags[key] !== want) fail(`the finalized application's feature flags are wrong: ${key} was ${JSON.stringify(flags[key])}, expected ${JSON.stringify(want)}`);
              if (new Set(flags.repeated).size !== 1) fail('the finalized application answered the same question differently each time');
              // The third-party artifact is still exactly what GRAFT verified, and still says whose it is.
              const artifactFile = path.join(created, execution.adaptation.artifact);
              const artifactSha = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(artifactFile)).digest('hex')}`;
              const provenanceFile = path.join(path.dirname(artifactFile), `${path.basename(artifactFile).replace(/\.cjs$/, '')}.provenance.json`);
              const provenance = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile, 'utf8')) : null;
              const licenceFile = path.join(path.dirname(artifactFile), `${path.basename(artifactFile).replace(/\.cjs$/, '')}.LICENSE`);
              evidence.continuity.finalArtifact = { file: execution.adaptation.artifact, sha256: artifactSha, matchesVerified: artifactSha === execution.adaptation.artifactSha256,
                provenance: provenance ? { upstream: provenance.source?.repository, revision: provenance.source?.revision, licence: provenance.licence?.declared, copiedVerbatim: provenance.artifact?.copiedVerbatim, adapterAuthoredBy: provenance.adaptation?.adapterAuthoredBy, note: provenance.note } : null,
                licencePresent: fs.existsSync(licenceFile), adapterPresent: fs.existsSync(path.join(created, adapterPath)) };
              step('finalized-artifact', evidence.continuity.finalArtifact);
              const fa = evidence.continuity.finalArtifact;
              if (!fa.matchesVerified) fail(`the finalized artifact is not the verified one (${artifactSha})`);
              if (!fa.provenance) fail('the finalized application carries no provenance record for the third-party artifact');
              if (!/zumba\/swiveljs/.test(fa.provenance.upstream || '')) fail(`provenance does not name the upstream repository (${fa.provenance.upstream})`);
              if (fa.provenance.licence !== 'MIT') fail(`provenance does not preserve the MIT licence (${fa.provenance.licence})`);
              if (!fa.licencePresent) fail('the upstream licence text is not present in the finalized application');
              if (fa.provenance.adapterAuthoredBy !== 'GRAFT' || fa.provenance.copiedVerbatim !== true) fail('provenance does not distinguish what GRAFT wrote from what it carried');
            }
            // Reopening GRAFT: the ledger is still CURRENT for the promoted revision.
            await ui(`(location.reload(), null)`);
            await new Promise((r) => setTimeout(r, 2500));
            const reopened = await ui(`(async () => { ${WAIT} location.hash = 'laboratory'; const back = await wait(() => document.querySelector('[data-action="lab-back"]') || document.querySelector('[data-action="lab-open"]')); if (back && back.dataset.action === 'lab-back') back.click(); const open = await wait(() => [...document.querySelectorAll('[data-action="lab-open"]')].find((b) => b.dataset.id === ${JSON.stringify(execution.blueprintId)})); if (!open) return { error: 'no assembled blueprint to reopen' }; open.click(); await wait(() => document.querySelector('[data-action="lab-tab"][data-id="plan"]')); document.querySelector('[data-action="lab-tab"][data-id="plan"]').click(); const t = await wait(() => /Assembled application/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300); return t ? { text: t.slice(t.indexOf('Assembled application')) } : { error: 'the assembled panel did not reappear' }; })()`);
            if (reopened.error) fail(`reopen: ${reopened.error}`);
            evidence.continuity.afterReopen = reopened.text.split('\n').filter(Boolean).slice(0, 12);
            step('reopened', { lines: evidence.continuity.afterReopen });
            if (!/present by assembly evidence/.test(reopened.text)) fail('the ledger is no longer CURRENT after reopening');
          }
        }
      }
      evidence.finishedAt = new Date().toISOString();
      fs.writeFileSync(path.join(HOME, 'evidence.json'), JSON.stringify(evidence, null, 2));
      step('blueprint-done', { file: path.join(HOME, 'evidence.json'), blueprintId: bp.blueprintId, readiness });
      return;
    }
    // 5. Transplant: source (the banked capability the page lists), then the destination from Capability Memory.
    await ui(`(location.hash = 'transplant', null)`);
    const bank = await waitFor(() => ui(`(() => { const b = [...document.querySelectorAll('[data-action="wf-source"]')]; return b.length ? b.map((x) => ({ slug: x.dataset.slug, text: x.innerText.replace(/\\n/g, ' | ') })) : null; })()`), { what: 'banked capabilities' });
    step('bank', { entries: bank });
    const slug = (bank.find((b) => /verified in source/.test(b.text)) || bank[0]).slug;
    const pickedSource = await click(`[data-action="wf-source"][data-slug="${slug}"]`);
    if (pickedSource.error) fail(`source choice: ${pickedSource.error}`);
    const destinations = await waitFor(() => ui(`(() => { const cards = [...document.querySelectorAll('[data-action="wf-destination"]')]; return cards.length ? cards.map((c) => ({ name: c.querySelector('strong')?.innerText, root: c.dataset.root, supported: !c.disabled, text: c.innerText.replace(/\\n/g, ' | ') })) : null; })()`), { what: 'destination candidates' });
    step('destinations', { count: destinations.length, supported: destinations.filter((d) => d.supported).map((d) => d.name), candidates: destinations.map((d) => d.text) });
    const destination = destinations.find((d) => d.root && fs.existsSync(d.root) && fs.realpathSync(d.root) === destinationRoot);
    if (!destination) fail(`${DESTINATION_NAME} was not offered as a destination`);
    if (!destination.supported) fail(`${DESTINATION_NAME} is offered but not supported: ${destination.text}`);
    evidence.destination = destination;
    const pickedDestination = await ui(`(() => { const c = [...document.querySelectorAll('[data-action="wf-destination"]')].find((x) => x.dataset.root === ${JSON.stringify(destination.root)}); if (!c) return { error: 'card vanished' }; c.click(); return { clicked: true }; })()`);
    if (pickedDestination.error) fail(pickedDestination.error);
    await new Promise((r) => setTimeout(r, 500));
    evidence.compatibilityPanel = await text('main');
    step('destination-picked', { name: destination.name, root: destination.root, card: destination.text });
    await screenshot('source-and-destination', '[data-action="wf-destination"]');

    // 6. Prepare the isolated worktree (confirmation), then build and review the plan.
    const prepare = await click('[data-action="wf-prepare"]');
    if (prepare.error) fail(`prepare: ${prepare.error}`);
    const confirmedPrepare = await confirmTrust();
    if (confirmedPrepare.error) fail(`prepare confirmation: ${confirmedPrepare.error}`);
    evidence.manualInterventions.push('confirmed "Prepare isolated transplant"');
    const prepareJob = await idle('the worktree to be prepared', 300000, null, 'Prepare isolated transplant');
    const worktree = await waitFor(() => ui(`(() => { const c = document.querySelector('[data-action="wf-copy"]'); return c ? { path: c.dataset.root, panel: c.closest('.panel')?.innerText || '' } : null; })()`), { what: 'the worktree panel' });
    step('worktree-prepared', { job: { status: prepareJob.status, phase: prepareJob.phase }, path: worktree.path, panel: worktree.panel.split('\n').slice(0, 6) });
    if (prepareJob.status !== 'completed') fail(`prepare ${prepareJob.status}: ${(prepareJob.dialog || '').slice(0, 300)}`);
    evidence.worktree = { path: worktree.path, state: repoState(worktree.path) };
    const plan = await click('[data-action="wf-plan"]');
    if (plan.error) fail(`plan: ${plan.error}`);
    let applyControl = await waitFor(() => ui(`(() => { const b = document.querySelector('[data-action="confirm-apply"]'); return b ? { disabled: b.disabled, resolve: Boolean(document.querySelector('[data-action="wf-plan-resolve"]')) } : null; })()`), { what: 'the plan panel' });
    if (applyControl.disabled && applyControl.resolve) {
      evidence.manualInterventions.push('approved replacing conflicting routes');
      await click('[data-action="wf-plan-resolve"]');
      applyControl = await waitFor(() => ui(`(() => { const b = document.querySelector('[data-action="confirm-apply"]'); return b && !b.disabled ? { disabled: false } : null; })()`), { what: 'apply to become available' });
    }
    if (applyControl.disabled) fail('the plan cannot be applied: ' + (await text('.plan-panel')).slice(0, 600));
    evidence.planPanel = await text('.plan-panel');
    step('plan-reviewed', { lines: evidence.planPanel.split('\n').filter((l) => /Will be|Ready|Needs|Verification|Security|Configuration|AUTH_|Recipe|Risk/.test(l)).slice(0, 14) });
    await screenshot('plan-review', '.plan-panel');

    // 7. Apply & verify, then the proof. The product runs the verifier; the page is only polled.
    const apply = await click('[data-action="confirm-apply"]');
    if (apply.error) fail(`apply: ${apply.error}`);
    const confirmedApply = await confirmTrust();
    if (confirmedApply.error) fail(`apply confirmation: ${confirmedApply.error}`);
    evidence.manualInterventions.push('confirmed "Apply this transplant" (trust checkbox)');
    const phases = [];
    const applyJob = await idle('apply & verify to finish', 600000, phases, 'Transplant into');
    const applyVerdict = (/\b(VERIFIED|FAILED|NEEDS_REVIEW)\b/.exec(applyJob.dialog || '') || [])[1] || null;
    step('applied-and-verified', { status: applyJob.status, verdict: applyVerdict, phase: applyJob.phase, phases, dialog: (applyJob.dialog || '').split('\n').slice(0, 8) });
    if (applyJob.status !== 'completed' || applyVerdict !== 'VERIFIED') fail(`the transplant was not VERIFIED: ${applyJob.status} ${applyVerdict}`);
    const proof = await waitFor(() => ui(`(() => { const h = [...document.querySelectorAll('.panel-title h2')].find((x) => x.textContent === 'Proof'); if (!h) return null; const p = h.closest('.panel'); return { text: p.innerText, stats: [...p.querySelectorAll('.proof-grid > div')].map((d) => d.innerText.replace(/\\n/g, ' ')), invariants: [...p.querySelectorAll('details li')].map((li) => li.innerText) }; })()`), { timeout: 60000, what: 'the proof panel' });
    evidence.proof = proof;
    step('proof', { stats: proof.stats });
    await screenshot('proof', '.proof-grid');
    const managed = await ui(`(() => { const rows = [...document.querySelectorAll('.history-row')].filter((r) => r.innerText.includes(${JSON.stringify(worktree.path)})); return rows.map((r) => r.innerText.replace(/\\n/g, ' | ')); })()`);
    step('managed-transplant', { rows: managed });

    // 8. Changed files, from the page.
    const changes = await ui(`(async () => { ${WAIT} const b = [...document.querySelectorAll('.history-row [data-action="wf-changes"]')].at(-1); if (!b) return { error: 'no changed-files control' }; b.click(); const d = await wait(() => document.querySelector('dialog[open]')); if (!d) return { error: 'dialog did not open' }; await new Promise((r) => setTimeout(r, 300)); return { text: document.querySelector('dialog[open]').innerText }; })()`);
    if (changes.error) fail(`changed files: ${changes.error}`);
    evidence.changedFiles = changes.text;
    step('changed-files', { lines: changes.text.split('\n').slice(0, 12) });
    await screenshot('changed-files', 'dialog[open]');
    await ui(`(document.querySelector('dialog[open] [data-action="close"]')?.click(), null)`);
  } finally {
    if (!KEEP_APP && running(app.pid)) { try { quitNatively(); } catch { /* fall through */ } await waitFor(() => !running(app.pid), { timeout: 60000, what: 'the app to quit' }).catch(() => { try { process.kill(app.pid, 9); } catch { /* gone */ } }); }
    fs.writeFileSync(path.join(HOME, 'app.log'), log.join(''));
  }

  // 9. Evidence the product wrote, and the repositories it must not have touched.
  const registry = JSON.parse(fs.readFileSync(path.join(HOME, 'graft-state', 'transplants.json'), 'utf8'));
  const record = registry.transplants.find((t) => t.worktree.path === evidence.worktree.path) || registry.transplants.at(-1);
  evidence.transplantRecord = { id: record.id, state: record.state, baseHead: record.baseHead, branch: record.worktree.branch, history: record.history.map((h) => h.state), verdict: record.verdict?.verdict || null, receipt: record.receipt ? { filesWritten: record.receipt.filesWritten, entrypoint: record.receipt.entrypoint } : null, plan: record.plan };
  const events = fs.readFileSync(path.join(HOME, 'graft-state', 'dogfood', SESSION, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const applyEvent = events.filter((e) => e.type === 'apply').at(-1);
  evidence.verification = applyEvent ? { verdict: applyEvent.data.report?.verdict, summary: applyEvent.data.report?.summary, proof: applyEvent.data.report?.proof || null, repair: applyEvent.data.repair, branch: applyEvent.data.branch } : null;
  const atlasDir = path.join(HOME, 'graft-state', 'atlas');
  evidence.atlas = fs.existsSync(atlasDir) ? fs.readdirSync(atlasDir, { recursive: true }).filter((f) => f.endsWith('.json')) : [];
  evidence.after = { destination: repoState(destinationRoot), source: sourceRoot ? repoState(sourceRoot) : null, worktree: fs.existsSync(evidence.worktree.path) ? repoState(evidence.worktree.path) : null };
  // The verdict is the verifier's, read from what the product recorded; the page said the same.
  if (evidence.verification?.verdict !== 'VERIFIED') fail(`the product recorded ${evidence.verification?.verdict || 'no verdict'}, not VERIFIED`);
  if (evidence.transplantRecord.state !== 'VERIFIED' || evidence.transplantRecord.verdict !== 'VERIFIED') fail(`the transplant record is ${evidence.transplantRecord.state}`);
  const same = (a, b) => a && b && a.branch === b.branch && a.head === b.head && a.dirty === b.dirty;
  if (!same(before.destination, evidence.after.destination)) fail(`the destination checkout changed: ${JSON.stringify(before.destination)} -> ${JSON.stringify(evidence.after.destination)}`);
  if (sourceRoot && !same(before.source, evidence.after.source)) fail(`the source checkout changed: ${JSON.stringify(before.source)} -> ${JSON.stringify(evidence.after.source)}`);
  if (sourceRoot && fs.existsSync(path.join(sourceRoot, '.graft'))) fail('the source checkout gained a .graft folder');
  evidence.immutability = { source: sourceRoot ? 'unchanged' : 'not checked', destinationMain: 'unchanged' };
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(HOME, 'evidence.json'), JSON.stringify(evidence, null, 2));
  step('evidence-written', { file: path.join(HOME, 'evidence.json'), transplant: evidence.transplantRecord, destinationAfter: { head: evidence.after.destination.head.slice(0, 12), branch: evidence.after.destination.branch, dirty: evidence.after.destination.dirty }, atlasEntries: evidence.atlas.length });
}

/**
 * Real Multi-Capability Composition 0.1 — the packaged customer flow for two real capabilities.
 * Everything is done in the page; the driver reads what the page shows and what the product wrote.
 */
async function composeFlow({ harvestFromMemory, sourceRoot, secondSource, before }) {
  if (!ASSEMBLE_PARENT) fail('--compose needs --assemble <parent>');
  // 1. The second capability, from Capability Memory, harvested the same way.
  await ui(`(location.hash = 'discover', null)`);
  const second = await harvestFromMemory(SECOND_QUERY);
  evidence.secondHarvest = { name: second.chosen.name, ...second.harvestResult };
  // 2. A blueprint that wants both, from the Laboratory form.
  await ui(`(location.hash = 'laboratory', null)`);
  const created = await ui(`(async () => { ${WAIT} const form = await wait(() => document.querySelector('#lab-create-form')); if (!form) return { error: 'no Laboratory form' }; form.name.value = ${JSON.stringify(COMPOSE_NAME)}; form.description.value = ${JSON.stringify(COMPOSE_TEXT)}; const wanted = ${JSON.stringify(COMPOSE_CHECKS)}; const boxes = [...form.querySelectorAll('input[name="categories"]')]; for (const b of boxes) b.checked = wanted.includes(b.value); form.hostIntent.value = 'new-application'; form.requestSubmit(); const head = await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)), 200); if (!head) return { error: 'the blueprint did not open', main: document.querySelector('main').innerText.slice(0, 600) }; return { checked: boxes.filter((b) => b.checked).map((b) => b.value), overview: document.querySelector('main').innerText }; })()`);
  if (created.error) fail(`blueprint: ${created.error} ${created.main || ''}`);
  evidence.manualInterventions.push('described the application and ticked User authentication and Feature flags');
  step('compose-blueprint-created', { checked: created.checked, overview: created.overview.split('\n').filter(Boolean).slice(0, 16) });
  // 3. Both goals, each with the capability the product just harvested; nothing dropped.
  await click('[data-action="lab-tab"][data-id="capabilities"]');
  const selected = await ui(`(async () => { ${WAIT} const out = []; for (let i = 0; i < 2; i += 1) { const goals = [...document.querySelectorAll('.bp-goal')]; const goal = goals[i]; if (!goal) return { error: 'goal ' + i + ' missing', count: goals.length }; const card = [...goal.querySelectorAll('[data-action="lab-select"]')].find((c) => /source VERIFIED/.test(c.innerText)); if (!card) return { error: 'no verified candidate for ' + goal.querySelector('h2')?.innerText, cards: [...goal.querySelectorAll('[data-action="lab-select"]')].map((c) => c.innerText.slice(0, 80)) }; const label = goal.querySelector('h2').innerText; const name = card.innerText.split('\\n')[0]; card.click(); await wait(() => [...document.querySelectorAll('.bp-goal')][i]?.querySelector('.wf-choice.selected'), 100); out.push({ goal: label, card: name }); } await new Promise((r) => setTimeout(r, 300)); return { picked: out, goals: [...document.querySelectorAll('.bp-goal')].map((g) => ({ goal: g.querySelector('h2')?.innerText, selected: g.querySelector('.wf-choice.selected')?.innerText.split('\\n')[0] || null })) }; })()`);
  if (selected.error) fail(`selection: ${selected.error} ${JSON.stringify(selected.cards || selected.count || '')}`);
  for (const pick of selected.picked) evidence.manualInterventions.push(`selected "${pick.card}" for ${pick.goal}`);
  step('compose-selected', selected);
  if (selected.goals.length !== 2 || selected.goals.some((g) => !g.selected)) fail(`both goals must be selected: ${JSON.stringify(selected.goals)}`);
  await click('[data-action="lab-tab"][data-id="overview"]');
  await new Promise((r) => setTimeout(r, 400));
  const overview = await text('main');
  const readiness = (/(Draft|Needs selections|Missing capabilities|Has conflicts|Ready for assembly planning)/.exec(overview) || [])[1] || null;
  step('compose-blueprint-readiness', { readiness, tree: overview.split('\n').filter((l) => /User authentication|Feature flags|selected|└──/.test(l)).slice(0, 8) });
  await screenshot('compose-blueprint', '.bp-tree');
  if (readiness !== 'Ready for assembly planning') fail(`the blueprint is ${readiness}`);
  evidence.composeBlueprint = { name: COMPOSE_NAME, checks: COMPOSE_CHECKS, selected: selected.goals, readiness };
  // 4. The plan on the proven node:http host: order, both forms, the re-verification, READY.
  await click('[data-action="lab-tab"][data-id="plan"]');
  const BUILD = `const build = async (arch) => { const sel = await wait(() => document.querySelector('#lab-arch')); if (!sel) return { error: 'no host chooser' }; const wanted = sel.querySelector('option[value="' + arch + '"]')?.textContent?.split(' — ')[0] || arch; sel.value = arch; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true; document.querySelector('[data-action="lab-plan-build"]').click(); const ok = await wait(() => { const spec = document.querySelector('.asm-spec'); return spec && spec.innerText.includes(wanted) ? spec : null; }, 300); if (!ok) return { error: 'the plan for ' + arch + ' did not render', main: document.querySelector('main').innerText.slice(0, 400) }; const main = document.querySelector('main').innerText; const rows = [...document.querySelectorAll('.asm-steps tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.split('\\n')[0]).join(' | ')); const order = [...document.querySelectorAll('.asm-order li')].map((l) => l.innerText); const assemble = [...document.querySelectorAll('button')].find((b) => /Assemble application/.test(b.innerText)); return { main, rows, order, assembleDisabled: assemble ? assemble.disabled : null }; };`;
  const planned = await ui(`(async () => { ${WAIT} ${BUILD} return build('node-esm-http-central'); })()`);
  if (planned.error) fail(`plan: ${planned.error} ${planned.main || ''}`);
  evidence.manualInterventions.push('chose the new-application host node-esm-http-central and clicked Build assembly plan');
  const planReadiness = (/(Ready to assemble|Blocked by the blueprint|Needs a host|Unsupported host|Blocked: dependency cycle|Blocked: capability support|Draft)/.exec(planned.main) || [])[1] || null;
  const stepNames = planned.rows.map((r) => r.split(' | ')[1]);
  evidence.composePlan = { readiness: planReadiness, order: planned.order, steps: stepNames, assembleDisabled: planned.assembleDisabled };
  step('compose-plan', evidence.composePlan); await scene('fit', PACE_MS, '.asm-steps');
  await screenshot('compose-plan', '.asm-order');
  if (planReadiness !== 'Ready to assemble') fail(`the plan is ${planReadiness}`);
  if (!/^1?\.?\s*User authentication/.test(planned.order[0] || '') || !/Feature flags/.test(planned.order[1] || '')) fail(`the execution order is not authentication then feature flags: ${JSON.stringify(planned.order)}`);
  const expectSteps = ['Create application', 'Re-index host', 'Check capability requirements', 'Transplant capability — User authentication', 'Verify capability — User authentication', 'Check host preservation — User authentication', 'Re-index host', 'Verify source artifact identity — Feature flags', 'Adapt library capability — Feature flags', 'Verify capability — Feature flags', 'Re-verify capability — User authentication', 'Check final host preservation', 'Re-index the composed application', 'Final verification'];
  if (JSON.stringify(stepNames) !== JSON.stringify(expectSteps)) fail(`the plan steps are not the composition plan: ${JSON.stringify(stepNames)}`);
  if (planned.assembleDisabled !== false) fail('Assemble application is not offered');
  // 5. Assemble: the confirmation names both capabilities and the re-verification; the folder dialog is answered by the fixture seam.
  fs.mkdirSync(path.resolve(ASSEMBLE_PARENT), { recursive: true });
  const opened = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="lab-assemble"]')); if (!b) return { error: 'Assemble application is not enabled' }; b.click(); const d = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!d) return { error: 'no confirmation dialog' }; return { dialog: document.querySelector('dialog[open]').innerText }; })()`);
  if (opened.error) fail(`assemble: ${opened.error}`);
  step('compose-assemble-confirmation', { dialog: opened.dialog.split('\n').filter(Boolean).slice(0, 18) });
  if (!/Add User authentication/.test(opened.dialog) || !/Add Feature flags/.test(opened.dialog) || !/Verify User authentication .*again/.test(opened.dialog)) fail('the confirmation does not describe both capabilities and the re-verification');
  await screenshot('compose-assemble-confirmation', 'dialog[open]');
  if (PACE_MS) await scene('assemble-confirmation', PACE_MS);
  const chosenFolder = await ui(`(async () => { ${WAIT} document.querySelector('#asm-name').value = ${JSON.stringify(ASSEMBLE_NAME)}; document.querySelector('[data-action="lab-assemble-choose"]').click(); const v = await wait(() => document.querySelector('#asm-parent').value || null, 100); if (!v) return { error: 'the folder dialog gave no folder' }; document.querySelector('[data-action="lab-assemble-run"]').click(); return { parent: v }; })()`);
  if (chosenFolder.error) fail(`assemble folder: ${chosenFolder.error}`);
  evidence.manualInterventions.push(`chose ${ASSEMBLE_PARENT} in the folder dialog and clicked Assemble`);
  // Paced (recorded) runs bring the page's own progress list into view as it starts, the way a person scrolls to it.
  if (PACE_MS) { await waitFor(() => ui(`(() => { const c = document.querySelector('.checks'); if (!c) return null; c.scrollIntoView({ block: 'start' }); return true; })()`), { timeout: 30000, interval: 500, what: 'the progress list' }).catch(() => null); step('scene-progress', {}); }
  // 6. Real progress, read from the page's own execution record as it advances.
  const STAGES = 'Creating application|Indexing host|Checking capability requirements|Adding User authentication|Verifying User authentication|Checking host preservation|Re-indexing host|Verifying Feature flags artifact|Adapting Feature flags|Verifying Feature flags|Re-verifying User authentication|Checking final host preservation|Re-indexing application|Final verification';
  // Harness note: no screenshot is taken while a verification is running. On this machine a
  // DevTools Page.captureScreenshot during the composition stalled the Electron main thread for
  // long enough that the provider double stopped answering, and the CUF re-verification timed out
  // (8 callback steps, "aborted due to timeout") while the same run through the product's API
  // passed 13/13. The progress list is captured the moment the execution ends; it still shows
  // every stage with its state.
  const phases = [];
  const seen = await waitFor(async () => {
    const snapshot = await ui(`(() => { const t = document.querySelector('main').innerText; return { running: [...t.matchAll(/(${STAGES})/g)].map((m) => m[1]), finished: /Assembly (COMPLETED|FAILED|INCONCLUSIVE|BLOCKED|STALE)/.test(t) ? t : null }; })()`);
    for (const stage of snapshot?.running || []) if (!phases.includes(stage)) phases.push(stage);
    return snapshot?.finished ? phases : null;
  }, { timeout: 1200000, interval: 1000, what: 'the composition to finish' });
  await screenshot('compose-progress', '.checks');
  const main = await text('main');
  const lines = main.split('\n').filter(Boolean);
  const from = lines.findIndex((l) => /^Assembly execution/.test(l));
  step('compose-assembled', { stagesSeen: seen, lines: lines.slice(from, from + 22) }); await scene('assembled', PACE_MS);
  await screenshot('compose-result', '.report-banner');
  const execDir = path.join(HOME, 'graft-state', 'laboratory', 'executions');
  const execution = (fs.readdirSync(execDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(execDir, f), 'utf8'))).find((e) => e.composition)) || null;
  if (!execution) fail('no composition execution record was written');
  const c = execution.composition;
  evidence.composeExecution = { executionId: execution.executionId, status: execution.status, steps: execution.steps.map((s) => `${s.type}:${s.status}`), finalState: c.finalState, finalRevision: c.finalRevision, baseline: c.baseline, finalPreservation: c.finalPreservation,
    capabilities: c.capabilities.map((x) => ({ capability: x.capability, form: x.form, initial: x.initialVerdict, initialSummary: x.initialSummary, reverified: x.reverifiedVerdict, reverifiedSummary: x.reverifiedSummary, final: x.finalVerdict, appliedRevision: x.appliedRevision, sourceVerification: x.sourceVerification?.summary || null, artifactIdentity: x.artifactIdentity, adaptation: x.adaptation })),
    reverifications: c.reverifications.map((r) => ({ capability: r.capability, alongside: r.alongside, verdict: r.verdict, revision: r.revision, observationRecorded: r.observation?.recorded ?? null })), detector: execution.reindex?.detectorObservation || null };
  step('compose-execution-record', { status: execution.status, finalState: c.finalState, R: (c.finalRevision || '').slice(0, 12), capabilities: evidence.composeExecution.capabilities.map((x) => `${x.capability}: ${x.initial}${x.reverified ? ` → re-verified ${x.reverified}` : ''}`), stages: seen });
  if (execution.status !== 'COMPLETED' || c.finalState !== 'ALL_SELECTED_CAPABILITIES_VERIFIED') fail(`the composition ended ${execution.status} / ${c.finalState}: ${execution.error?.message || ''}`);
  if (!/COMPOSITION VERIFIED/.test(main)) fail('the page does not show COMPOSITION VERIFIED');
  // 7. What the person is shown: separate evidence per capability, the one revision, no combined score.
  const shown = main.slice(main.indexOf('COMPOSITION VERIFIED'));
  const CLAIMS = 'VERIFIED AT THIS REVISION|ADDED AND VERIFIED BY GRAFT|NOT OBSERVED|OBSERVED|VERIFIED|MATCHED|PASSED|FAILED|not recorded|not run';
  const claim = (label, from = shown) => (new RegExp(`${label}\\s*\\n?\\s*(${CLAIMS})`).exec(from) || [])[1] || null;
  const proven = shown.slice(shown.indexOf('What was proven, capability by capability'));
  const split = proven.indexOf('\nFeature flags\n');
  const auth = split > 0 ? proven.slice(0, split) : proven, flags = split > 0 ? proven.slice(split) : '';
  evidence.composePage = {
    revision: (/Final application revision\s*\n\s*Revision\s*\n?\s*([0-9a-f]{12})/.exec(shown) || [])[1] || null,
    atRevision: (shown.match(/VERIFIED AT THIS REVISION/g) || []).length,
    auth: { source: claim('Source', auth), initial: claim('Destination, when added', auth), afterComposition: claim('Destination, after the later capabilities', auth), presence: claim('Presence', auth), detector: claim('Independent detector', auth), cases13: (auth.match(/13\/13 required cases/g) || []).length, cuf: /@leftsock\/cuf/.test(auth), noLiveProvider: /no external provider was contacted/.test(auth) },
    flags: { source: claim('Source', flags), identity: claim('Artifact identity', flags), destination: claim('Destination', flags), presence: claim('Presence', flags), detector: claim('Independent detector', flags), cases8: /8\/8 required cases/.test(flags), cases10: /10\/10 required cases/.test(flags), swivel: /zumba\/swiveljs/.test(flags) && /f4d6efd1486c/.test(flags) && /licence MIT/.test(flags), explains: /did not identify this capability/.test(flags) && /GRAFT knows it is present from the verified assembly evidence/.test(flags) },
    hostPreservation: claim('Host preservation', shown), noCombinedScore: !/\b(18|21|23|31|33)\/(18|21|23|31|33)\b/.test(shown) && /There is no combined score/.test(shown),
  };
  step('compose-evidence-page', evidence.composePage); await scene('prove', PACE_MS);
  await screenshot('compose-auth-evidence', '.panel .section-heading');
  const pg = evidence.composePage;
  if (pg.revision !== (c.finalRevision || '').slice(0, 12)) fail(`the page shows revision ${pg.revision}, the record says ${(c.finalRevision || '').slice(0, 12)}`);
  if (pg.atRevision !== 2) fail(`expected both capabilities VERIFIED AT THIS REVISION, saw ${pg.atRevision}`);
  if (pg.auth.source !== 'VERIFIED' || pg.auth.initial !== 'VERIFIED' || pg.auth.afterComposition !== 'VERIFIED' || pg.auth.cases13 < 3 || !pg.auth.cuf || !pg.auth.noLiveProvider) fail(`authentication evidence incomplete: ${JSON.stringify(pg.auth)}`);
  if (pg.flags.source !== 'VERIFIED' || pg.flags.identity !== 'MATCHED' || pg.flags.destination !== 'VERIFIED' || !pg.flags.cases8 || !pg.flags.cases10 || !pg.flags.swivel || pg.flags.detector !== 'NOT OBSERVED' || !pg.flags.explains) fail(`feature-flags evidence incomplete: ${JSON.stringify(pg.flags)}`);
  if (pg.auth.presence !== 'ADDED AND VERIFIED BY GRAFT' || pg.flags.presence !== 'ADDED AND VERIFIED BY GRAFT') fail('presence is not shown as assembly evidence for both');
  if (pg.hostPreservation !== 'PASSED' || !pg.noCombinedScore) fail('host preservation / combined-score presentation is wrong');
  await ui(`(async () => { ${WAIT} const h = [...document.querySelectorAll('h2')].find((x) => x.innerText === 'Feature flags'); h?.scrollIntoView({ block: 'start' }); return null; })()`);
  await screenshot('compose-flags-evidence');
  // 8. Two ledger records, both CURRENT, the same revision on each.
  const ledgerText = await ui(`(async () => { ${WAIT} const t = await wait(() => /Assembled application/.test(document.querySelector('main').innerText) && /record 2 of 2/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300); return t ? t.slice(t.indexOf('Assembled application')) : null; })()`);
  if (!ledgerText) fail('the assembled application panel with two records never appeared');
  evidence.composeLedgerPage = { lines: ledgerText.split('\n').filter(Boolean).slice(0, 40), current: (ledgerText.match(/\nCURRENT\n/g) || []).length, sameRevision: (ledgerText.match(/same revision as the whole application/g) || []).length, records: (ledgerText.match(/record \d of 2/g) || []).length };
  await scene('ledger', PACE_MS, '#assembled-application'); step('compose-ledger-page', { current: evidence.composeLedgerPage.current, sameRevision: evidence.composeLedgerPage.sameRevision, records: evidence.composeLedgerPage.records });
  await screenshot('compose-ledger', '.export-facts');
  if (evidence.composeLedgerPage.records !== 2 || evidence.composeLedgerPage.sameRevision !== 2 || !/2 capabilities, 2 current/.test(ledgerText)) fail(`the ledger page does not show two CURRENT records at one revision: ${JSON.stringify(evidence.composeLedgerPage)}`);
  // 9. Finalize: explicit, confirmed, fast-forward only.
  const created2 = execution.createdProject.root;
  const preRevision = git(created2, ['rev-parse', 'HEAD']);
  const finalize = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="lab-finalize"]')); if (!b) return { error: 'Finalize is not offered' }; b.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-finalize-run"]')); if (!run) return { error: 'no finalize confirmation' }; const dialog = document.querySelector('dialog[open]').innerText; document.querySelector('#finalize-confirm').checked = true; run.click(); const done = await wait(() => /Finalized/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300); if (!done) return { error: 'finalization did not complete', main: document.querySelector('main').innerText.slice(-600) }; return { dialog, done: done.slice(done.indexOf('Assembled application')) }; })()`);
  if (finalize.error) fail(`finalize: ${finalize.error} ${finalize.main || ''}`);
  evidence.manualInterventions.push('confirmed "Finalize assembled project" (explicit promotion)');
  step('compose-finalized', { dialog: finalize.dialog.split('\n').filter(Boolean).slice(0, 10), result: finalize.done.split('\n').filter((l) => /Finalized|fast-forward|revision/.test(l)).slice(0, 6) });
  if (BETA) {
    // Where the page landed after Finalize, measured before the harness scrolls anything for screenshots.
    const landing = await ui(`(async () => { ${WAIT} const h = await wait(() => document.querySelector('#assembled-application'), 100); if (!h) return { error: 'no assembled application heading' }; const r = h.getBoundingClientRect(); return { headingTop: Math.round(r.top), viewport: window.innerHeight, scrollY: Math.round(window.scrollY), visible: r.top >= -8 && r.top < window.innerHeight }; })()`);
    step('beta-finalize-landing-position', landing);
    if (landing.error || !landing.visible) fail(`Finalize did not land on the assembled application: ${JSON.stringify(landing)}`);
    await screenshot('beta-finalize-landing', '#assembled-application');
  }
  await screenshot('compose-finalized', '.notice');
  const workspaceDir = path.join(HOME, 'graft-state', 'laboratory', 'assemblies');
  const workspace = fs.readdirSync(workspaceDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(workspaceDir, f), 'utf8'))).find((w) => w.executionIds?.includes(execution.executionId));
  if (!workspace) fail('no assembly workspace for the composition');
  const postRevision = git(created2, ['rev-parse', 'HEAD']);
  const history = git(created2, ['log', '--format=%H', '-3']).split('\n');
  evidence.composeContinuity = { assemblyWorkspaceId: workspace.assemblyWorkspaceId, status: workspace.status, finalization: workspace.finalization, ledger: workspace.capabilities.map((r) => ({ capability: r.capability, state: r.state, form: r.implementationForm, verdict: r.verificationVerdict, summary: r.verificationSummary, appliedRevision: r.appliedRevision, currentVerifiedRevision: r.currentVerifiedRevision, destinationRevisionAfter: r.destinationRevisionAfter, history: (r.verificationHistory || []).map((h) => `${h.event}@${(h.revision || '').slice(0, 12)}:${h.verdict}`) })), primary: { before: preRevision, after: postRevision, history, branch: git(created2, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(created2, ['status', '--porcelain']).split('\n').filter(Boolean).length, remotes: git(created2, ['remote']) } };
  step('compose-continuity', { status: workspace.status, R: (c.finalRevision || '').slice(0, 12), ledger: evidence.composeContinuity.ledger.map((r) => `${r.capability} ${r.state} @${(r.currentVerifiedRevision || '').slice(0, 12)}`), finalization: workspace.finalization ? `${workspace.finalization.kind} forced=${workspace.finalization.forced}` : null });
  if (workspace.status !== 'FINALIZED' || workspace.finalization?.kind !== 'fast-forward' || workspace.finalization.forced !== false || workspace.finalization.remotesContacted?.length) fail('finalization is not a plain fast-forward');
  if (postRevision !== c.finalRevision || history[2] !== preRevision) fail(`the created project is at ${postRevision.slice(0, 12)}, expected ${(c.finalRevision || '').slice(0, 12)} with the blank host two commits back`);
  if (workspace.capabilities.length !== 2 || workspace.capabilities.some((r) => r.currentVerifiedRevision !== c.finalRevision || r.destinationRevisionAfter !== c.finalRevision || r.verificationVerdict !== 'VERIFIED')) fail('the ledger does not hold two VERIFIED records at the final revision');
  if (evidence.composeContinuity.primary.remotes || evidence.composeContinuity.primary.dirty) fail('the finalized project has a remote or uncommitted changes');
  // 10. The finalized application on its own: host, hosted auth (its verification environment), the adapter, the artifact.
  const port = String(3960 + (PORT % 30));
  const { withDouble } = await import('../../packages/core/src/verify/index.js');
  const { readManifest } = await import('../../packages/core/src/manifest/io.js');
  const authManifest = readManifest(path.join(HOME, 'graft-state', 'organ-bank', `${c.capabilities[0].capability}.graft`));
  evidence.composeStandalone = await withDouble(authManifest, async (double, env) => {
    const started = spawn(process.execPath, ['server.mjs'], { cwd: created2, env: { ...process.env, ...env, PORT: port, AUTH_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitFor(async () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false), { timeout: 20000, interval: 250, what: 'the finalized application to answer' });
      const status = async (route, init) => (await fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual', ...init })).status;
      const login = await fetch(`http://127.0.0.1:${port}/auth/login`, { redirect: 'manual' });
      if (process.env.GRAFT_DEMO_RESULT_VIEWER) await showResultInViewer(`http://127.0.0.1:${port}`);
      else if (process.env.GRAFT_DEMO_SHOW_RESULT === '1') await showResultInBrowser(`http://127.0.0.1:${port}`);
      return { root: await status('/'), health: await status('/health'), unknown: await status('/no-such-route'), anonymousSession: await status('/api/session'), login: login.status, loginLocation: (login.headers.get('location') || '').split('?')[0] };
    } finally { started.kill('SIGTERM'); await new Promise((r) => started.once('exit', r)); }
  });
  step('compose-finalized-host-runs', evidence.composeStandalone);
  const st = evidence.composeStandalone;
  if (st.root !== 200 || st.health !== 200 || st.unknown !== 404 || st.anonymousSession !== 401 || ![301, 302, 303, 307].includes(st.login)) fail(`the finalized application does not behave: ${JSON.stringify(st)}`);
  const adapterPath = c.capabilities.find((x) => x.form === 'library')?.adaptation?.adapter;
  const probe = path.join(created2, '.graft-standalone-check.mjs');
  fs.writeFileSync(probe, `import Flags from './${adapterPath}';
const map = { Graft: [1, 2], 'Graft.enabled': [1], 'Graft.off': [] };
const on = new Flags({ map, bucketIndex: 1 }), other = new Flags({ map, bucketIndex: 2 });
console.log(JSON.stringify({ enabled: on.isEnabled('Graft.enabled'), disabled: other.isEnabled('Graft.enabled'), unknown: on.isEnabled('Graft.not-configured'), chooseOn: on.choose('Graft.enabled', 'on', 'off'), chooseOff: other.choose('Graft.enabled', 'on', 'off'), branchOn: on.branch('Graft.enabled', () => 'enabled', () => 'disabled'), branchOff: other.branch('Graft.enabled', () => 'enabled', () => 'disabled'), repeated: [on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled')] }));
`);
  let flagsOut;
  try { flagsOut = JSON.parse(execFileSync(process.execPath, [probe], { cwd: created2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 })); }
  finally { fs.rmSync(probe, { force: true }); }
  evidence.composeStandaloneFlags = flagsOut;
  step('compose-finalized-flags-run', flagsOut);
  const expectedFlags = { enabled: true, disabled: false, unknown: false, chooseOn: 'on', chooseOff: 'off', branchOn: 'enabled', branchOff: 'disabled' };
  for (const [key, want] of Object.entries(expectedFlags)) if (flagsOut[key] !== want) fail(`feature flags wrong in the finalized application: ${key} = ${JSON.stringify(flagsOut[key])}`);
  if (new Set(flagsOut.repeated).size !== 1) fail('the adapter answered differently on repeat');
  const artifact = c.capabilities.find((x) => x.form === 'library')?.adaptation?.artifact;
  const sha = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(created2, artifact))).digest('hex')}`;
  evidence.composeArtifact = { file: artifact, sha256: sha };
  step('compose-finalized-artifact', evidence.composeArtifact);
  if (PACE_MS) { await ui(`(document.querySelector('[data-action="about"]')?.click(), null)`); await new Promise((r) => setTimeout(r, 600)); await scene('ending', PACE_MS); await holdForRecorder(); await ui(`(document.querySelector('dialog[open] [data-action="close"]')?.click(), null)`); }
  if (sha !== 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8') fail(`the vendored artifact is ${sha}`);
  // 11. Donors, exactly as before.
  evidence.after = { source: sourceRoot ? repoState(sourceRoot) : null, secondSource: secondSource ? repoState(secondSource) : null };
  const same = (a, b) => a && b && a.branch === b.branch && a.head === b.head && a.dirty === b.dirty && JSON.stringify(a.graftBranches) === JSON.stringify(b.graftBranches);
  if (sourceRoot && !same(before.source, evidence.after.source)) fail(`the first donor changed: ${JSON.stringify(evidence.after.source)}`);
  if (secondSource && !same(before.secondSource, evidence.after.secondSource)) fail(`the second donor changed: ${JSON.stringify(evidence.after.secondSource)}`);
  if (sourceRoot && fs.existsSync(path.join(sourceRoot, '.graft'))) fail('the first donor gained a .graft folder');
  if (secondSource && fs.existsSync(path.join(secondSource, '.graft'))) fail('the second donor gained a .graft folder');
  evidence.immutability = { source: sourceRoot ? 'unchanged' : 'not checked', secondSource: secondSource ? 'unchanged' : 'not checked' };
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(HOME, 'evidence.json'), JSON.stringify(evidence, null, 2));
  if (BETA) {
    fs.mkdirSync(BETA_EXPORT, { recursive: true }); fs.mkdirSync(BETA_DIAG, { recursive: true });
    const { verifyProofFile } = await import('../../packages/proof-adapter/src/index.js');
    // A. Finalize landed on the result: the assembled application panel with state, verdict and proof integrity, and Export proofs.
    const landed = await ui(`(async () => { ${WAIT} const h = await wait(() => document.querySelector('#assembled-application')); if (!h) return { error: 'no assembled application panel' }; const r = h.getBoundingClientRect(); const main = document.querySelector('main'); const t = main.innerText; const i = t.indexOf('Assembled application'); const scroller = [main, main.parentElement, document.scrollingElement].find((el) => el && el.scrollHeight > el.clientHeight) || document.scrollingElement; return { visible: r.top >= 0 && r.top < window.innerHeight, headingTop: Math.round(r.top), scrollTop: Math.round(scroller.scrollTop), scroller: scroller === main ? 'main' : scroller === document.scrollingElement ? 'document' : 'main-parent', text: t.slice(i, i + 6000) }; })()`);
    if (landed.error) fail(`beta landing: ${landed.error}`);
    step('beta-finalize-landing', { visibleWithoutScrolling: landed.visible, headingTop: landed.headingTop, scrollTop: landed.scrollTop, scroller: landed.scroller, lines: landed.text.split('\n').filter(Boolean).slice(0, 14) });
    if (!/Proof integrity\s+Intact/.test(landed.text.replace(/\n/g, ' '))) fail('the assembled application panel does not show Proof integrity Intact');
    if ((landed.text.match(/CURRENT/g) || []).length < 2 || (landed.text.match(/VERIFIED/g) || []).length < 2) fail('the panel does not show CURRENT and VERIFIED for both capabilities');
    await screenshot('beta-assembled-application', '#assembled-application');
    // B. Export proofs through the page (the fixture answers the folder dialog with BETA_EXPORT).
    const exported = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="export-proofs"]')); if (!b) return { error: 'Export proofs is not offered' }; b.click(); const toastEl = await wait(() => { const t = document.querySelector('#toast'); return t && /proof file/.test(t.textContent) ? t : null; }, 300); return { toast: toastEl ? toastEl.textContent : null, main: document.querySelector('main').innerText.split(String.fromCharCode(10)).filter((l) => /exported/.test(l)).slice(0, 3) }; })()`);
    if (exported.error) fail(`export proofs: ${exported.error}`);
    evidence.manualInterventions.push(`chose ${BETA_EXPORT} in the folder dialog for the proofs`);
    const exportedFiles = fs.readdirSync(BETA_EXPORT).filter((f) => /^graft-proof-[0-9a-f]{64}\.json$/.test(f));
    const storedDir = path.join(HOME, 'graft-state', 'proofs');
    const exportChecks = exportedFiles.map((f) => { const digest = f.slice('graft-proof-'.length, -'.json'.length); const stored = path.join(storedDir, `${digest}.json`); const same = fs.existsSync(stored) && Buffer.compare(fs.readFileSync(path.join(BETA_EXPORT, f)), fs.readFileSync(stored)) === 0; const v = verifyProofFile(path.join(BETA_EXPORT, f)); return { file: f.slice(0, 24) + '…', byteIdentical: same, intact: v.intact, capability: v.claim?.capability?.slug, revision: v.claim?.destinationRevision?.slice(0, 12), verdict: v.claim?.graftVerdict }; });
    step('beta-proofs-exported', { toast: exported.toast, files: exportChecks });
    if (exportedFiles.length !== 2 || exportChecks.some((x) => !x.byteIdentical || !x.intact || x.revision !== (c.finalRevision || '').slice(0, 12) || x.verdict !== 'VERIFIED')) fail(`the exported proofs are not the two intact stored proofs at R: ${JSON.stringify(exportChecks)}`);
    if (!/2 proof files exported/.test(exported.toast || '')) fail(`no clear confirmation: ${exported.toast}`);
    await screenshot('beta-proofs-exported', 'main');
    // C. A controlled customer failure: assemble the same plan again under the same name (the folder now exists).
    const again = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="lab-assemble"]')); if (!b) return { error: 'Assemble application is not offered again' }; b.click(); const d = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!d) return { error: 'no confirmation dialog' }; document.querySelector('#asm-name').value = ${JSON.stringify(ASSEMBLE_NAME)}; document.querySelector('[data-action="lab-assemble-choose"]').click(); const v = await wait(() => document.querySelector('#asm-parent').value || null, 100); if (!v) return { error: 'the folder dialog gave no folder' }; document.querySelector('[data-action="lab-assemble-run"]').click(); return { parent: v }; })()`);
    if (again.error) fail(`beta failure setup: ${again.error}`);
    evidence.manualInterventions.push('assembled the same plan again under the same name (the controlled failure)');
    const failedPanel = await ui(`(async () => { ${WAIT} const p = await wait(() => document.querySelector('.recovery'), 600); if (!p) return { error: 'no recovery panel appeared', main: document.querySelector('main').innerText.slice(0, 600) }; return { text: p.innerText, executionId: p.dataset.execution, retryName: p.querySelector('[data-action="lab-retry"]')?.dataset.root || null, hasDiscard: Boolean(p.querySelector('[data-action="lab-discard"]')), hasDiagnostics: Boolean(p.querySelector('[data-action="diagnostics"]')), detailsOpen: p.querySelector('details.tech')?.open ?? null }; })()`, '127.0.0.1', { commandTimeout: 90000 });
    if (failedPanel.error) fail(`beta failure: ${failedPanel.error} ${failedPanel.main || ''}`);
    step('beta-failure-recovery-panel', { lines: failedPanel.text.split('\n').filter(Boolean).slice(0, 8), retryName: failedPanel.retryName, hasDiscard: failedPanel.hasDiscard, hasDiagnostics: failedPanel.hasDiagnostics, technicalDetailsCollapsed: failedPanel.detailsOpen === false });
    if (!/already taken/.test(failedPanel.text) || !failedPanel.retryName || !failedPanel.hasDiscard || !failedPanel.hasDiagnostics) fail('the recovery panel does not offer Retry (with a free name), Discard and Save diagnostic bundle');
    if (/target-exists/.test(failedPanel.text.split('Technical details')[0])) fail('the raw error code is visible outside Technical details');
    await screenshot('beta-failure-recovery', '.recovery');
    const failedExecutionId = failedPanel.executionId;
    // D. Save a diagnostic bundle for the failed run (folder dialog → BETA_DIAG).
    const diag = await ui(`(async () => { ${WAIT} const b = document.querySelector('.recovery [data-action="diagnostics"]'); b.click(); const d = await wait(() => { const x = document.querySelector('dialog[open]'); return x && /Diagnostic bundle saved/.test(x.innerText) ? x : null; }, 300); if (!d) return { error: 'no saved confirmation' }; const text = d.innerText; d.querySelector('[data-action="close"]')?.click(); return { text }; })()`);
    if (diag.error) fail(`diagnostics: ${diag.error}`);
    evidence.manualInterventions.push(`chose ${BETA_DIAG} in the folder dialog for the diagnostic bundle`);
    const diagFiles = fs.readdirSync(BETA_DIAG).filter((f) => f.endsWith('.zip'));
    const { readZip } = await import('../../packages/core/src/export/index.js');
    const zip = diagFiles.length ? readZip(fs.readFileSync(path.join(BETA_DIAG, diagFiles[0]))) : {};
    const zipText = Object.values(zip).map((b) => b.toString('utf8')).join('\n');
    const facts = zip['diagnostics.json'] ? JSON.parse(zip['diagnostics.json'].toString('utf8')) : null;
    const diagChecks = { file: diagFiles[0] || null, entries: Object.keys(zip).length, version: facts?.graft?.version || null, failureKind: facts?.execution?.failure?.kind || null, status: facts?.execution?.status || null, homePath: zipText.includes(HOME), userHome: zipText.includes(os.homedir()), licenceKey: /GRAFT-(?:[A-Z0-9]{4,5}-){3,4}[A-Z0-9]{4,5}/.test(zipText) || zipText.includes(KEY), providerSecret: /graft-verification-not-a-secret|AUTH_CLIENT_SECRET=|Bearer /.test(zipText), sourceCode: /createServer\(|import http from/.test(zipText) };
    step('beta-diagnostic-bundle', diagChecks);
    if (!diagChecks.file || diagChecks.failureKind !== 'name-taken' || diagChecks.status !== 'FAILED' || !diagChecks.version || diagChecks.homePath || diagChecks.userHome || diagChecks.licenceKey || diagChecks.providerSecret || diagChecks.sourceCode) fail(`the diagnostic bundle is not right: ${JSON.stringify(diagChecks)}`);
    // E. Discard the failed run from the panel: GRAFT's own working copy only; the record keeps its status.
    const discarded = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('.recovery [data-action="lab-discard"]')); if (!b) return { error: 'Discard is not offered' }; b.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-discard-run"]')); if (!run) return { error: 'no discard dialog' }; const dialogText = document.querySelector('dialog[open]').innerText; run.click(); const after = await wait(() => { const p = document.querySelector('.recovery'); return p && !p.querySelector('[data-action="lab-discard"]') ? p.innerText : null; }, 300); return { dialogText, after }; })()`);
    if (discarded.error) fail(`discard: ${discarded.error}`);
    evidence.manualInterventions.push('confirmed Discard for the failed run');
    const execDir2 = path.join(HOME, 'graft-state', 'laboratory', 'executions');
    const loadExecutions = () => fs.readdirSync(execDir2).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(execDir2, f), 'utf8'))).filter((e) => e.composition).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const failedExecution = loadExecutions().find((e) => e.executionId === failedExecutionId);
    step('beta-discarded', { dialog: discarded.dialogText.split('\n').filter(Boolean).slice(0, 3), statusKept: failedExecution?.status, history: (failedExecution?.recovery || []).map((r) => r.action), panelAfter: (discarded.after || '').split('\n').filter(Boolean).slice(0, 3) });
    if (failedExecution?.status !== 'FAILED' || !(failedExecution.recovery || []).some((r) => r.action === 'discard') || !/discarded/.test(discarded.after || '')) fail('Discard did not close the failed run while keeping its record');
    if (!/Your repositories, the donor projects, everything already recorded and every proof stay exactly as they are/.test(discarded.dialogText)) fail('the discard dialog does not state what is and is not touched');
    // F. The same failure once more, then Retry from the panel: a fresh assembly under the suggested name.
    const again2 = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('[data-action="lab-assemble"]')); if (!b) return { error: 'Assemble application is not offered again' }; b.click(); const d = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!d) return { error: 'no confirmation dialog' }; document.querySelector('#asm-name').value = ${JSON.stringify(ASSEMBLE_NAME)}; document.querySelector('[data-action="lab-assemble-choose"]').click(); const v = await wait(() => document.querySelector('#asm-parent').value || null, 100); if (!v) return { error: 'the folder dialog gave no folder' }; document.querySelector('[data-action="lab-assemble-run"]').click(); const p = await wait(() => { const x = document.querySelector('.recovery'); return x && x.dataset.execution !== ${JSON.stringify(failedExecutionId)} ? x : null; }, 600); if (!p) return { error: 'no recovery panel for the second failure' }; return { executionId: p.dataset.execution, retryName: p.querySelector('[data-action="lab-retry"]')?.dataset.root || null }; })()`, '127.0.0.1', { commandTimeout: 90000 });
    if (again2.error) fail(`beta second failure: ${again2.error}`);
    evidence.manualInterventions.push('assembled the same plan again under the same name (second controlled failure)');
    const retry = await ui(`(async () => { ${WAIT} const b = await wait(() => document.querySelector('.recovery [data-action="lab-retry"]')); if (!b) return { error: 'Retry is not offered' }; b.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-retry-run"]')); if (!run) return { error: 'no retry dialog' }; const name = document.querySelector('#retry-name').value; run.click(); return { name }; })()`);
    if (retry.error) fail(`retry: ${retry.error}`);
    evidence.manualInterventions.push(`confirmed Retry as ${retry.name}`);
    // The same page wait the first composition used: the execution shown reaches a terminal state and is not the failed one.
    const retried = await waitFor(async () => {
      const snapshot = await ui(`(() => { const t = document.querySelector('main').innerText; const tail = t.split('Assembly execution')[1] || ''; return /Assembly (COMPLETED|FAILED|INCONCLUSIVE|BLOCKED|STALE)/.test(tail) && !/already taken/.test(tail) ? t : null; })()`);
      return snapshot || null;
    }, { timeout: 600000, interval: 1000, what: 'the retried assembly to finish' });
    if (!/Assembly execution\s+COMPLETED/.test(retried) || !/COMPOSITION VERIFIED/.test(retried)) fail(`retry result: the page does not show the retried assembly COMPLETED and verified: ${retried.slice(0, 600)}`);
    const executions = loadExecutions();
    const retriedExecution = executions.at(-1); const failed2 = executions.find((e) => e.executionId === again2.executionId);
    step('beta-retried', { name: retry.name, suggested: again2.retryName, executions: executions.map((e) => `${e.executionId.slice(-6)}:${e.status}`), retriedStatus: retriedExecution?.status, retriedProject: retriedExecution?.createdProject?.root ? path.basename(retriedExecution.createdProject.root) : null, failedStatusKept: failed2?.status, failedHistory: (failed2?.recovery || []).map((r) => r.action) });
    if (retriedExecution?.status !== 'COMPLETED' || failed2?.status !== 'FAILED' || !(failed2.recovery || []).some((r) => r.action === 'retry') || retriedExecution.executionId === failed2.executionId) fail('Retry did not produce a completed fresh execution while keeping the failed one as history');
    await screenshot('beta-retried', 'main');
    const donorAfter = repoState(SECOND_SOURCE);
    if (donorAfter.dirty !== 0) fail('the donor changed during recovery');
    if (!fs.existsSync(created2) || git(created2, ['rev-parse', 'HEAD']) !== c.finalRevision) fail('the finalized project moved during recovery');
    evidence.beta = { exported: exportChecks, diagnostics: diagChecks, retriedProject: path.basename(retriedExecution.createdProject.root), firstPaintMs: evidence.firstPaintMs ?? null };
  }
  step('compose-done', { file: path.join(HOME, 'evidence.json'), R: (c.finalRevision || '').slice(0, 12), terminalStepsByProductUser: evidence.terminalStepsByProductUser, screenshots: evidence.screenshots.length });
}

/** Reopen the app on an existing home and clean up its worktree from the page: refused first, then confirmed. */
async function cleanupOnly(destinationRoot, live) {
  if (!live.length) { console.log('Nothing to clean up.'); return; }
  const app = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env: { ...process.env, GRAFT_FIXTURE_HOME: HOME, GRAFT_DOGFOOD: SESSION }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { at: new Date().toISOString(), worktrees: live.map((t) => t.worktree.path), before: repoState(destinationRoot) };
  try {
    // The licence is normally remembered; when the keychain entry is gone the page asks again.
    const pages = async () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
    await waitFor(async () => {
      const list = await pages();
      if (list.some((t) => t.type === 'page' && t.url.includes('127.0.0.1')) && await ui(`Boolean(document.querySelector('.sidebar'))`).catch(() => false)) return true;
      if (list.some((t) => t.type === 'page' && t.url.includes('license-ui'))) await ui(`(async () => { const input = document.querySelector('#license-key'); if (!input) return false; input.value = ${JSON.stringify(KEY)}; document.querySelector('#activation').requestSubmit(); return true; })()`, 'license-ui').catch(() => false);
      return false;
    }, { timeout: 120000, interval: 1500, what: 'the workspace page' });
    await ui(`(location.hash = 'transplant', null)`);
    for (const t of live) {
      const opened = await ui(`(async () => { ${WAIT} const row = await wait(() => [...document.querySelectorAll('.history-row')].find((r) => r.innerText.includes(${JSON.stringify(t.worktree.path)}))); if (!row) return { error: 'no managed row' }; row.querySelector('[data-action="wf-cleanup"]').click(); const d = await wait(() => document.querySelector('dialog[open] [data-action="wf-cleanup-confirm"]')); if (!d) return { error: 'no cleanup dialog' }; const text = document.querySelector('dialog[open]').innerText; d.click(); return { warned: /contains changes/.test(text), text }; })()`);
      if (opened.error) fail(`cleanup: ${opened.error}`);
      const gone = await waitFor(() => ui(`(() => ![...document.querySelectorAll('.history-row')].some((r) => r.innerText.includes(${JSON.stringify(t.worktree.path)})) || null)()`), { timeout: 60000, what: 'the row to disappear' });
      result[t.id] = { warned: opened.warned, rowGone: gone, folderGone: !fs.existsSync(t.worktree.path) };
      step('cleaned-up', { id: t.id, ...result[t.id] });
    }
  } finally {
    if (running(app.pid)) { try { quitNatively(); } catch { /* fall through */ } await waitFor(() => !running(app.pid), { timeout: 60000, what: 'the app to quit' }).catch(() => { try { process.kill(app.pid, 9); } catch { /* gone */ } }); }
  }
  result.after = repoState(destinationRoot);
  result.registry = JSON.parse(fs.readFileSync(path.join(HOME, 'graft-state', 'transplants.json'), 'utf8')).transplants.map((t) => ({ id: t.id, state: t.state, branch: t.worktree.branch }));
  fs.writeFileSync(path.join(HOME, 'cleanup.json'), JSON.stringify(result, null, 2));
  step('cleanup-evidence', { after: { branch: result.after.branch, head: result.after.head.slice(0, 12), dirty: result.after.dirty, graftBranches: result.after.graftBranches }, registry: result.registry });
}

await main().catch((err) => { console.error(`\nDEMO FAILED: ${err.message}`); evidence.error = err.message; fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(path.join(HOME, 'evidence.json'), JSON.stringify(evidence, null, 2)); process.exit(1); });
console.log('\nReal product demo completed.');
