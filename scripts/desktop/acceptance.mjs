// Packaged-artifact acceptance for the GRAFT Fixture desktop build, on macOS and Windows.
// Drives the real bundle: native launch, the preload/IPC licence path, the loopback workspace API,
// a native OS quit during live verification, and reopen with and without the licence service.
// Build the artifact first: npm run desktop:package -- --fixture
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { describePlatform } from '../../packages/desktop/src/platform.js';

const host = describePlatform();
const judge = process.argv.includes('--judge');
const productName = judge ? 'GRAFT Galuxium' : 'GRAFT Fixture';
const APP_DIR = path.resolve(`out/${judge ? 'judge' : 'fixture'}/${productName}-${host.platform}-${host.arch}`);
const APP = host.windows ? APP_DIR : path.join(APP_DIR, `${productName}.app`);
const EXE = host.windows ? path.join(APP_DIR, `${productName}.exe`) : path.join(APP, `Contents/MacOS/${productName}`);
const RESOURCES = host.windows ? path.join(APP_DIR, 'resources') : path.join(APP, 'Contents/Resources');
const RUNTIME_NODE = path.join(RESOURCES, 'runtime', ...host.nodeExecutable);
const BUNDLE_ID = judge ? 'com.leftsock.graft.galuxium' : 'com.leftsock.graft.fixture';
const KEY = 'GRAFT-FIXTURE-VALID';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  return ok;
}
function skip(name, reason) { console.log(`SKIP  ${name} :: ${reason}`); }
// Windows paths compare case-insensitively and may differ in drive-letter case between tools.
const normal = (p) => { try { p = fs.realpathSync(p); } catch { /* keep as given */ } return host.windows ? p.toLowerCase() : p; };
const underPath = (candidate, prefix) => normal(candidate).startsWith(normal(prefix));
const powershell = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
async function waitFor(fn, { timeout = 60000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { const value = await fn(); if (value) return value; } catch { /* retry until the deadline */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}
function launch(home, port) {
  const child = spawn(EXE, [`--remote-debugging-port=${port}`],
    { env: { ...process.env, GRAFT_FIXTURE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => child.log.push(d.toString()));
  return child;
}
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The OS-native quit. macOS: an Apple Events quit. Windows: taskkill WITHOUT /F, which posts
// WM_CLOSE to every top-level window the process owns (the graceful close the title-bar button
// and Alt+F4 send), driving Electron's close -> before-quit path. Unlike Process.CloseMainWindow
// it does not depend on the MainWindowHandle heuristic, which a just-shown Electron window on a
// CI desktop can still report as 0.
const quitNatively = (pid) => (host.windows
  ? execFileSync('taskkill', ['/PID', String(pid)], { timeout: 60000, stdio: 'pipe' })
  : execFileSync('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { timeout: 60000 }));
const readStartup = (home) => JSON.parse(fs.readFileSync(path.join(home, 'startup.json'), 'utf8'));
const git = (cwd, args) => execFileSync(host.git, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const snapshotRepo = (root) => ({ branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
  head: git(root, ['rev-parse', 'HEAD']), status: git(root, ['status', '--porcelain']), tracked: git(root, ['ls-files', '-s']) });
const digest = (root) => Object.fromEntries(fs.readdirSync(root, { recursive: true })
  .filter((f) => !f.startsWith('.git' + path.sep) && fs.statSync(path.join(root, f)).isFile())
  .map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const orphanVerifiers = () => (host.windows
  ? powershell("Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }")
  : execFileSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf8' }))
  .split('\n').filter((line) => normal(line).includes(normal(RUNTIME_NODE)));

// Evaluate an expression in the packaged renderer over the DevTools protocol, so the licence
// activation really travels through the sandboxed page, the preload bridge and main-process IPC.
async function cdpEvaluate(port, urlMatch, expression, { commandTimeout = 60000 } = {}) {
  const target = await waitFor(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    return list.find((t) => t.type === 'page' && t.url.includes(urlMatch) && t.webSocketDebuggerUrl) || null;
  }, { what: `the ${urlMatch} renderer` });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer evaluation timed out')), commandTimeout);
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Renderer evaluation failed');
    return result.result.value;
  } finally { ws.close(); }
}
async function token(origin) {
  const html = await fetch(`${origin}/`).then((r) => r.text());
  const match = html.match(/name="graft-token" content="([0-9a-f]{64})"/);
  if (!match) throw new Error('The packaged workspace page carried no session token.');
  return match[1];
}
function client(origin, sessionToken) {
  const call = async (route, body, method = 'POST') => {
    const res = await fetch(origin + route, { method,
      headers: { 'x-graft-token': sessionToken, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let value; try { value = JSON.parse(text); } catch { value = { raw: text }; }
    return { status: res.status, body: value };
  };
  return { call, state: () => call('/api/state', undefined, 'GET'),
    async job(route, body) {
      const started = await call(route, body);
      if (started.status !== 200) throw new Error(`${route} refused with ${started.status}: ${JSON.stringify(started.body)}`);
      const id = started.body.job.id;
      return waitFor(async () => {
        const state = await call('/api/state', undefined, 'GET');
        const job = state.body.jobs.find((j) => j.id === id);
        return job && job.status !== 'running' ? job : null;
      }, { timeout: 180000, interval: 250, what: `the ${route} job` });
    } };
}
// The verdict rule: every REQUIRED case passed. Non-required witnesses (e.g. restart durability on an
// in-memory store) are reported but do not decide, exactly as in decideVerdict().
const passing = (report_) => report_?.verdict === 'VERIFIED' && report_.results?.filter((r) => r.required).length > 0 && report_.results.filter((r) => r.required).every((r) => r.outcome === 'passed');
const count = (report_) => `${report_?.results?.filter((r) => r.required && r.outcome === 'passed').length}/${report_?.results?.filter((r) => r.required).length} required (${report_?.results?.filter((r) => !r.required && r.outcome !== 'passed').length || 0} non-required witness(es) not held)`;

// Disposable instrumented repositories. User projects are never used.
// Repositories live under a directory with spaces and non-ASCII characters, so path handling
// through the dashboard, core, git and the bundled runtime is exercised on both platforms.
const REPOS = 'repos ü (spaces)';
function workspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-desktop-acceptance-'));
  const trace = path.join(home, 'runtime-execution.jsonl');
  for (const [name, fixture, entry, esm] of [['source', 'old-saas-project', 'server.js', false],
    ['destination', 'new-startup', 'src/main.js', true]]) {
    const root = path.join(home, REPOS, name);
    fs.cpSync(path.resolve('fixtures', fixture), root, { recursive: true,
      filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
    const file = path.join(root, entry);
    const probe = `${esm ? "(await import('node:fs'))" : "require('node:fs')"}.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({project:${JSON.stringify(name)}, pid:process.pid, execPath:process.execPath, node:process.versions.node, electron:!!process.versions.electron, at:Date.now()})+'\\n');\n`;
    fs.writeFileSync(file, probe + fs.readFileSync(file, 'utf8'));
    for (const args of [['init', '-qb', 'main'], ['add', '-A'],
      ['-c', 'user.name=GRAFT Desktop Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Disposable desktop acceptance baseline']]) {
      execFileSync(host.git, args, { cwd: root, stdio: 'pipe' });
    }
  }
  return { home, trace };
}

async function reopen(home, label, { offline = false, port } = {}) {
  if (offline) fs.writeFileSync(path.join(home, 'offline'), '');
  const previous = fs.statSync(path.join(home, 'startup.json')).mtimeMs;
  const app = launch(home, port);
  try {
    await waitFor(() => fs.statSync(path.join(home, 'startup.json')).mtimeMs > previous, { what: 'a new startup report' });
    const startup = readStartup(home);
    report(`${label}: reopens without asking for the licence again`,
      startup.license.allowed === true && startup.license.activated === true, startup.license.message);
    if (offline) report(`${label}: continues only inside the bounded cached grace window`,
      typeof startup.license.offlineUntil === 'number' && startup.license.offlineUntil > Date.now(),
      `grace until ${new Date(startup.license.offlineUntil).toISOString()}`);
    const api = client(startup.origin, await token(startup.origin));
    const { status, body } = await api.state();
    const organs = body.bank.organs || body.bank;
    // Survival is about identity, not totals: this session also registers the application the
    // Laboratory assembled and banks its hosted capability, so the counts grow legitimately.
    const names = body.projects.map((p) => p.name);
    report(`${label}: projects, banked capability and saved results all survived`,
      status === 200 && ['source', 'destination'].every((n) => names.includes(n)) && organs.some((o) => (o.slug || o.identity?.slug) === 'authentication')
      && body.transplants.length >= 1 && body.savedResults.length >= 1,
      `${body.projects.length} projects [${names.join(', ')}], ${organs.length} organ, ${body.transplants.length} transplant, ${body.savedResults.length} saved result`);
    const destination = snapshotRepo(path.join(home, REPOS, 'destination'));
    report(`${label}: the destination is still on its recovery branch with its receipt`,
      destination.branch.startsWith('graft/') && fs.existsSync(path.join(home, REPOS, 'destination', '.graft', 'transplants')),
      destination.branch);
    if (!offline) {
      // After a verified transplant the atlas holds an observation; the panel must surface it.
      const atlasText = await cdpEvaluate(port, '127.0.0.1', `(async () => {
        location.hash = 'transplant'; await new Promise((r) => setTimeout(r, 400));
        const cap = document.querySelector('#capability'), dest = document.querySelector('#destination');
        if (!cap || !dest) return '';
        cap.value = 'authentication'; dest.value = ${JSON.stringify(body.projects.find((p) => p.root.endsWith('destination'))?.id || '')};
        document.querySelector('#plan-form').requestSubmit();
        for (let i = 0; i < 100; i += 1) { await new Promise((r) => setTimeout(r, 100)); const el = document.querySelector('.engine-summary'); if (el) return el.innerText; }
        return '';
      })()`).catch(() => '');
      report(`${label}: prior-observation (Atlas) information appears in the review panel once it exists`, /Atlas: \d+ prior observation/.test(atlasText), atlasText.split('\n').find((l) => l.startsWith('Atlas')) || 'no Atlas line');
    }
    const quitAt = Date.now();
    // Close the reopened window through its own DevTools session (window.close -> Electron
    // 'close' -> the before-quit shutdown). This does not depend on the OS reporting a
    // main-window handle, which a backgrounded, never-foregrounded CI window can leave at 0 —
    // the reason a bare WM_CLOSE (taskkill/CloseMainWindow) is unreliable here. The native
    // OS-level quit stays proven by the main flow; taskkill remains a periodic fallback.
    await cdpEvaluate(port, '127.0.0.1', 'window.close(), null').catch(() => {});
    let exited = false, lastQuit = quitAt;
    try {
      exited = await waitFor(() => {
        if (running(app.pid) && Date.now() - lastQuit > 3000) { lastQuit = Date.now(); try { quitNatively(app.pid); } catch { /* gone between check and signal */ } }
        return !running(app.pid);
      }, { timeout: 60000, what: 'exit' });
    }
    catch (err) {
      // Keep everything a post-mortem needs: whether the OS still sees the process and its
      // main window, and whether the app recorded a clean quit after the native close.
      const quit = (() => { try { return fs.statSync(path.join(home, 'quit.json')).mtimeMs; } catch { return null; } })();
      fs.writeFileSync(path.join(home, `reopen-${label.replace(/\W+/g, '-')}-timeout.json`), JSON.stringify({
        error: err.message, quitAt, quitJsonWrittenAfterClose: quit !== null && quit > quitAt, stillRunning: running(app.pid),
        window: host.windows ? powershell(`Get-Process -Id ${app.pid} -ErrorAction SilentlyContinue | Select-Object Id,MainWindowHandle,MainWindowTitle,Responding | ConvertTo-Json -Compress`).trim() : null,
      }, null, 2));
    }
    report(`${label}: the reopened session shuts down cleanly`, exited && (label.includes('after quit') ? fs.existsSync(path.join(home, 'quit.json')) : true), `${Date.now() - quitAt} ms`);
  } finally {
    if (running(app.pid)) try { process.kill(app.pid, 9); } catch { /* already gone */ }
    if (app.log.length) fs.writeFileSync(path.join(home, `reopen-${label.replace(/\W+/g, '-')}.log`), app.log.join(''));
  }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`Build the ${judge ? 'judge candidate' : 'fixture'} first: npm run desktop:package -- --${judge ? 'judge' : 'fixture'}`);
  const { home, trace } = workspace();
  const source = path.join(home, REPOS, 'source');
  const destination = path.join(home, REPOS, 'destination');
  console.log(`Platform: ${host.key}\nPackaged app: ${APP}\nIsolated fixture home: ${home}\n`);
  // The native save dialog cannot be scripted; the fixture answers it with this folder.
  const exportDir = path.join(home, 'exports'); fs.mkdirSync(exportDir, { recursive: true });
  process.env.GRAFT_FIXTURE_SAVE = exportDir;
  const app = launch(home, 9333);
  try {
    await waitFor(() => fs.existsSync(path.join(home, 'startup.json')), { what: 'the packaged startup report' });
    const startup = readStartup(home);
    report('the packaged bundle launches and reports its own version', startup.packaged === true, `v${startup.version}`);
    report('verification uses the standalone Node bundled in application resources',
      underPath(startup.runtime.executable, RUNTIME_NODE) && startup.runtime.electron === false,
      `Node ${startup.runtime.version} ${startup.runtime.arch} at ${startup.runtime.executable}`);
    report('the renderer has no Node primitives and only the explicit bridge',
      startup.rendererBoundary.require === 'undefined' && startup.rendererBoundary.process === 'undefined'
      && startup.rendererBoundary.Buffer === 'undefined', startup.rendererBoundary.bridge.join(','));
    report('the renderer window is sandboxed and context isolated',
      startup.renderer.sandbox === true && startup.renderer.contextIsolation === true && startup.renderer.nodeIntegration !== true);
    report('remote navigation is refused', startup.navigationRefused === true);
    const graftMenu = startup.menu.find((m) => m.label === 'GRAFT');
    const quit = graftMenu?.submenu.find((e) => e.role === 'quit');
    report('the native application menu offers About, License and Quit',
      Boolean(graftMenu?.submenu.some((e) => e.role === 'about')) && Boolean(graftMenu?.submenu.some((e) => e.label === 'License…'))
      && quit?.enabled === true, startup.menu.map((m) => m.label).join(' | '));

    const origin = startup.origin;
    const initial = await fetch(`${origin}/api/state`, { headers: { 'x-graft-token': await token(origin) } });
    report(judge ? 'the judge build grants local demo access without activation' : 'the workspace API refuses every operation before activation',
      initial.status === (judge ? 200 : 402), `HTTP ${initial.status}`);

    // The purchase call-to-action follows the build's configuration only: the fixture carries no
    // purchase URL, so Buy is disabled and its copy hidden, and the IPC refuses rather than opening anything.
    const purchase = judge ? null : await cdpEvaluate(9333, 'license-ui',
      `window.graftDesktop.version().then((v) => window.graftDesktop.buy().then(() => ({ opened: true }), (e) => ({ version: v, buyDisabled: document.querySelector('#buy').disabled, buyHidden: document.querySelector('#buy').hidden, copyHidden: document.querySelector('#purchase').hidden, invite: document.querySelector('#invite').hidden ? null : document.querySelector('#invite').textContent, introHidden: document.querySelector('#intro').hidden, status: document.querySelector('#status').textContent, refused: e.message })))`);
    if (!judge) {
      report('Buy GRAFT is enabled only when the build carries a trusted purchase URL (none in the fixture)',
        purchase?.version?.purchaseEnabled === false && purchase?.buyDisabled === true && purchase?.copyHidden === true && purchase?.refused === 'Purchasing is not available in this build.', JSON.stringify(purchase));
      report('an invite-only build shows the invitation copy, hides Buy GRAFT and the purchase paragraph, and never mentions payment',
        purchase?.version?.inviteOnly === true && purchase?.buyHidden === true && purchase?.introHidden === true && purchase?.invite === 'Private beta access is invite-only. Enter the license key from your invitation email.' && purchase?.status === 'Enter the license key from your invitation email.', JSON.stringify(purchase));
    }

    const activation = judge ? await cdpEvaluate(9333, '127.0.0.1', 'window.graftDesktop.licenseStatus()') : await cdpEvaluate(9333, 'license-ui',
      `window.graftDesktop.activate(${JSON.stringify(KEY)}).then((v) => JSON.parse(JSON.stringify(v)), (e) => ({ error: e.message }))`);
    if (activation?.error?.includes('could not be saved')) throw new Error(
      `Activation storage was denied: ${activation.error}\nThe fixture build keeps its licence in a build-stamped file under the fixture home, so this should not happen after a rebuild; inspect ${home}.`);
    report(judge ? 'the judge build starts with its bounded local demo entitlement' : 'activation succeeds through the real renderer, preload and IPC path', activation?.allowed === true, activation?.message);
    // Harness only: on this machine the packaged workspace renderer sometimes answers no DevTools
    // evaluation for a while after the licence page navigates (measured 8 s to well over 200 s,
    // with the product's own HTTP server serving the whole time). Wait for it in short bounded
    // polls before the first page-driven check, as the demo driver does; the product is not
    // judged on this stall, and a renderer that never answers still fails the run.
    const firstPaint = await waitFor(() => cdpEvaluate(9333, '127.0.0.1', "Boolean(document.querySelector('.sidebar'))", { commandTimeout: 4000 }).catch(() => false), { timeout: Number(process.env.GRAFT_ACCEPT_FIRST_PAINT_MS || 300000), interval: 2000, what: 'the workspace renderer after activation' }).catch(() => false);
    report('the workspace renderer answers after activation (harness wait, bounded)', firstPaint === true);

    const api = client(origin, await token(origin));
    const src = await api.call('/api/projects', { path: source });
    const dst = await api.call('/api/projects', { path: destination });
    report('both disposable repositories register', src.status === 200 && dst.status === 200);
    // Engine review panel, driven through the real renderer: after the harvest below banks the
    // capability, the plan form is submitted in the page and the engine block must render.
    const reviewPanel = async (port, projectId, label) => {
      const text = await cdpEvaluate(port, '127.0.0.1', `(async () => {
        location.hash = 'transplant';
        await new Promise((r) => setTimeout(r, 400));
        const cap = document.querySelector('#capability'), dest = document.querySelector('#destination');
        if (!cap || !dest) return { error: 'plan form not rendered' };
        cap.value = 'authentication'; dest.value = ${JSON.stringify(projectId)};
        document.querySelector('#plan-form [name="resolveConflicts"]').checked = true;
        document.querySelector('#plan-form').requestSubmit();
        for (let i = 0; i < 100; i += 1) { await new Promise((r) => setTimeout(r, 100)); const el = document.querySelector('.engine-summary'); if (el) return { text: el.innerText, checks: document.querySelectorAll('.checks > div').length, files: document.querySelectorAll('.file-list button').length, apply: Boolean(document.querySelector('[data-action="confirm-apply"]')) }; }
        return { error: 'engine summary did not render', body: document.body.innerText.slice(0, 500) };
      })()`);
      report(`${label}: the engine analysis renders in the review panel`, !text.error && /Email & password authentication/.test(text.text) && /session-auth/.test(text.text), text.error || `${text.text.split('\n').length} lines`);
      report(`${label}: Genome/Host/IR-derived mismatches and the verification contract appear`, /node-res → return-response/.test(text.text || '') && /Verification will prove/.test(text.text || ''));
      report(`${label}: risks and unknowns appear`, /Risk \(/.test(text.text || '') && /unknown\(s\)/.test(text.text || ''));
      report(`${label}: the recipe appears`, /Recipe: session-auth/.test(text.text || ''));
      report(`${label}: the existing review workflow is intact (checks, files, apply control)`, text.checks >= 6 && text.files >= 5 && text.apply === true, `${text.checks} checks, ${text.files} planned changes`);
      return text;
    };

    // Workspace discovery, driven through the real renderer: authorize the disposable
    // workspace folder, index it in the packaged app, and search it in the page itself.
    const workspaceRoot = path.join(home, REPOS);
    // Capability Forms 0.1a: a real third-party library, placed in the workspace exactly as a person
    // would have it on disk — its published artifact, its package manifest and its licence, nothing
    // else. Skipped when the read-only checkout is not on this machine.
    const librarySource = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
    const haveLibrary = fs.existsSync(path.join(librarySource, 'dist/swivel.js'));
    if (haveLibrary) {
      const libraryRoot = path.join(workspaceRoot, 'swiveljs');
      fs.mkdirSync(path.join(libraryRoot, 'dist'), { recursive: true });
      for (const [from, to] of [['dist/swivel.js', 'dist/swivel.js'], ['package.json', 'package.json'], ['LICENSE', 'LICENSE']]) fs.copyFileSync(path.join(librarySource, from), path.join(libraryRoot, to));
    }
    const authorized = await api.call('/api/workspace/roots', { path: workspaceRoot });
    report('a workspace folder can be authorized for indexing', authorized.status === 200 && authorized.body.roots.length === 1);
    const indexed = await api.job('/api/workspace/index', {});
    report('the packaged app indexes the authorized workspace',
      indexed.status === 'completed' && indexed.result.index.projects >= 2 && indexed.result.summary.capabilities >= 1,
      `${indexed.result?.index?.projects} projects, ${indexed.result?.summary?.capabilities} capabilities in ${indexed.result?.index?.elapsedMs} ms`);
    report('indexing found authentication without registering projects one at a time',
      (indexed.result?.summary?.byCapability?.authentication || 0) >= 1,
      JSON.stringify(indexed.result?.summary?.byCapability || {}));
    const discovered = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      location.hash = 'discover';
      await new Promise((r) => setTimeout(r, 500));
      const input = document.querySelector('#discover-text');
      if (!input) return { error: 'discover form not rendered', body: document.body.innerText.slice(0, 400) };
      input.value = 'find something that keeps users logged in';
      document.querySelector('#discover-form').requestSubmit();
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const cards = document.querySelectorAll('.discovery-card');
        if (cards.length) return { text: document.querySelector('main').innerText, cards: cards.length,
          detail: Boolean(document.querySelector('[data-action="capability-detail"]')) };
      }
      return { error: 'no candidates rendered', body: document.querySelector('main').innerText.slice(0, 400) };
    })()`);
    report('the Discover panel returns real candidates in the packaged renderer',
      !discovered.error && discovered.cards >= 1, discovered.error || `${discovered.cards} candidate card(s)`);
    report('candidates state harvestability and transplant support in the page',
      /Harvestable|Not harvestable/.test(discovered.text || '') && /transplantable/i.test(discovered.text || ''));
    report('the page states that GRAFT determines the outcome, not an agent',
      /determined by GRAFT/.test(discovered.text || ''));
    report('discovery works with no agent configured', /No agent/.test(discovered.text || ''), 'agentless fallback visible in the UI');
    report('a harvestable candidate offers "Harvest as source" from the Discover panel', /Harvest as source/.test(discovered.text || ''), 'Capability Memory feeds Transplant');
    const detail = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const button = document.querySelector('[data-action="capability-detail"]');
      if (!button) return { error: 'no capability detail control' };
      button.click();
      for (let i = 0; i < 60; i += 1) { await new Promise((r) => setTimeout(r, 100)); const d = document.querySelector('dialog[open]'); if (d) { const text = d.innerText; d.close(); return { text }; } }
      return { error: 'capability dialog did not open' };
    })()`);
    report('a candidate explains why GRAFT detected it, with evidence',
      !detail.error && /Why GRAFT detected this/.test(detail.text || '') && /Credential authority/.test(detail.text || ''),
      detail.error || `${(detail.text || '').split('\n').length} lines`);

    const harvest = await api.job('/api/harvest', { projectId: src.body.project.id, capability: 'authentication', trusted: true });
    report('the packaged app verifies the source and banks the capability',
      harvest.status === 'completed' && harvest.result.banked === true && passing(harvest.result.report),
      `${harvest.result?.report?.verdict} ${count(harvest.result?.report)}`);
    // Capability Export 0.1: Download capability from the organ bank page, saved where the (fixture)
    // save dialog points, then inspected from outside the app.
    // The harvest above ran through the API, so the page reloads to see the banked capability.
    await cdpEvaluate(9333, '127.0.0.1', "(location.hash = 'bank', location.reload(), null)").catch(() => null);
    await sleep(1500);
    const exported = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      location.hash = 'bank'; await new Promise((r) => setTimeout(r, 500));
      const exits = await wait(() => document.querySelector('.capability-exits'));
      if (!exits) return { error: 'no capability exits', body: document.body.innerText.slice(0, 300) };
      const labels = [...exits.querySelectorAll('button')].map((b) => ({ text: b.innerText.trim(), disabled: b.disabled }));
      const download = exits.querySelector('[data-action="export-capability"]');
      download.click();
      const done = await wait(() => { const d = document.querySelector('dialog[open]'); return d && /Capability downloaded|already exists/.test(d.innerText) ? d.innerText : null; }, 300);
      const reveal = Boolean(document.querySelector('dialog[open] [data-action="wf-reveal"]'));
      return { labels, dialog: done, reveal };
    })()`);
    report('a harvested capability offers Download capability, Add to a project, and Use in Laboratory',
      !exported.error && exported.labels?.some((l) => /Download capability/.test(l.text) && !l.disabled) && exported.labels?.some((l) => /Add to a project/.test(l.text) && !l.disabled) && exported.labels?.some((l) => /Use in Laboratory/.test(l.text) && !l.disabled),
      exported.error || exported.labels?.map((l) => `${l.text}${l.disabled ? ' (disabled)' : ''}`).join(' | '));
    const zipPath = path.join(exportDir, `${harvest.result.slug}.zip`);
    report('Download capability saves a package where the save dialog pointed and shows the receipt with Reveal',
      /Capability downloaded/.test(exported.dialog || '') && /universal compatibility not claimed/.test(exported.dialog || '') && exported.reveal === true && fs.existsSync(zipPath),
      exported.dialog ? exported.dialog.split('\n').slice(0, 4).join(' | ') : 'no dialog');
    const { readZip } = await import('../../packages/core/src/export/index.js');
    const zipEntries = fs.existsSync(zipPath) ? readZip(fs.readFileSync(zipPath)) : {};
    const zipText = Object.values(zipEntries).map((b) => b.toString('utf8')).join('\n');
    report('the package holds GRAFT.md, the manifest, the contract and the regenerated src/, and none of the home, source or GRAFT paths',
      ['GRAFT.md', 'graft-capability.json', 'verification-contract.json', 'provenance.json', 'dependencies.json', 'configuration.example'].every((f) => Object.keys(zipEntries).includes(`${harvest.result.slug}/${f}`))
      && Object.keys(zipEntries).some((f) => f.includes('/src/')) && ![home, source, os.homedir(), REPOS].some((p) => zipText.includes(p)),
      `${Object.keys(zipEntries).length} entries`);
    const receipts = await api.call('/api/exports', {});
    report('the export receipt records the package hash and file count and is not a verdict',
      receipts.body.receipts?.[0]?.kind === 'CapabilityExportReceipt' && receipts.body.receipts[0].exportedFileCount === Object.keys(zipEntries).length && receipts.body.receipts[0].verification?.universalCompatibility === 'not-claimed' && !('verdict' in receipts.body.receipts[0]),
      receipts.body.receipts?.[0]?.packageHash);
    await cdpEvaluate(9333, '127.0.0.1', "(document.querySelector('dialog[open] [data-action=\"close\"]')?.click(), null)").catch(() => null);

    // Laboratory 0.1: a blueprint from the page. Goals come from the person's words and checklist;
    // candidates come from Capability Memory only; goals with nothing behind them say NOT FOUND.
    const blueprint = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      location.hash = 'laboratory';
      const form = await wait(() => document.querySelector('#lab-create-form'));
      if (!form) return { error: 'no Laboratory form', body: document.body.innerText.slice(0, 300) };
      form.name.value = 'Acceptance portal'; form.description.value = 'Customers sign in and pay invoices.';
      for (const b of form.querySelectorAll('input[name="categories"]')) b.checked = b.value === 'notifications';
      form.requestSubmit();
      const opened = await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)), 200);
      if (!opened) return { error: 'the blueprint did not open', body: document.querySelector('main').innerText.slice(0, 400) };
      const overview = document.querySelector('main').innerText;
      document.querySelector('[data-action="lab-tab"][data-id="capabilities"]').click(); await new Promise((r) => setTimeout(r, 300));
      const goals = [...document.querySelectorAll('.bp-goal')].map((g) => ({ goal: g.querySelector('h2').innerText, notFound: /NOT FOUND/.test(g.innerText), candidates: [...g.querySelectorAll('[data-action="lab-select"]')].map((c) => c.innerText.replace(/\\n/g, ' | ')) }));
      const card = [...document.querySelectorAll('.bp-goal [data-action="lab-select"]')].find((c) => /source VERIFIED/.test(c.innerText));
      if (!card) return { error: 'the harvested capability is not offered', goals };
      card.click(); await wait(() => document.querySelector('.bp-goal .wf-choice.selected'), 100);
      document.querySelector('[data-action="lab-tab"][data-id="evidence"]').click(); await new Promise((r) => setTimeout(r, 300));
      const evidence = document.querySelector('main').innerText;
      document.querySelector('[data-action="lab-tab"][data-id="overview"]').click(); await new Promise((r) => setTimeout(r, 300));
      const after = document.querySelector('main').innerText;
      return { overview, goals, evidence, after };
    })()`);
    report('the Laboratory turns words and a checklist into goals, offers the harvested capability with its evidence, and says NOT FOUND elsewhere',
      !blueprint.error && /Missing capabilities/.test(blueprint.overview || '') && blueprint.goals?.some((g) => /authentication/i.test(g.goal) && g.candidates.length > 0) && blueprint.goals?.some((g) => /Billing/.test(g.goal) && g.notFound) && blueprint.goals?.some((g) => /Notifications/.test(g.goal) && g.notFound),
      blueprint.error ? `${blueprint.error} ${JSON.stringify(blueprint.goals || blueprint.body || '').slice(0, 200)}` : blueprint.goals.map((g) => `${g.goal}: ${g.notFound ? 'NOT FOUND' : g.candidates.length + ' candidate(s)'}`).join(' | '));
    report('a selected implementation shows its origin, source verdict and host evidence without claiming compatibility, and readiness never says VERIFIED',
      /VERIFIED \(\d+\/\d+ required\)/.test(blueprint.evidence || '') && /verified evidence unavailable/.test(blueprint.evidence || '') && /selected/.test(blueprint.after || '') && !/Ready for assembly planning/.test(blueprint.after || '') && !/readiness.*VERIFIED/i.test(blueprint.after || ''),
      (blueprint.after || '').split('\n').find((l) => /goal\(s\)/.test(l)) || 'no readiness line');
    const blueprintFiles = fs.existsSync(path.join(home, 'graft-state', 'laboratory', 'blueprints')) ? fs.readdirSync(path.join(home, 'graft-state', 'laboratory', 'blueprints')).filter((f) => f.endsWith('.json')) : [];
    const blueprintText = blueprintFiles.map((f) => fs.readFileSync(path.join(home, 'graft-state', 'laboratory', 'blueprints', f), 'utf8')).join('\n');
    report('the blueprint is saved under GRAFT_HOME/laboratory/blueprints by id, without local paths or analysis',
      blueprintFiles.length === 1 && /^acceptance-portal-[a-f0-9]{6}\.json$/.test(blueprintFiles[0]) && ![home, source, os.homedir(), REPOS].some((p) => blueprintText.includes(p)) && !blueprintText.includes('"analysis"'),
      blueprintFiles.join(', '));
    // Laboratory 0.2: an assembly plan from the page. The blueprint above is blocked (missing goals), so
    // its plan must be BLOCKED_BLUEPRINT with explicit blockers; a blueprint holding only the harvested
    // capability, planned onto a proven new host, reaches READY_TO_ASSEMBLE; nothing is executed.
    const planned = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      const build = async (arch) => { const sel = await wait(() => document.querySelector('#lab-arch')); if (!sel) return null; sel.value = arch; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true; document.querySelector('[data-action="lab-plan-build"]').click(); await wait(() => /READY_TO_ASSEMBLE|Ready to assemble|Blocked|Needs a host|Unsupported/.test(document.querySelector('main').innerText) && document.querySelector('.asm-steps'), 150); document.querySelectorAll('details.tech').forEach((d) => { d.open = true; }); return document.querySelector('main').innerText; };
      document.querySelector('[data-action="lab-tab"][data-id="plan"]').click(); await wait(() => document.querySelector('#lab-arch'));
      const blocked = await build('node-esm-express');
      location.hash = 'bank'; await new Promise((r) => setTimeout(r, 600));
      const use = await wait(() => document.querySelector('.capability-exits [data-action="lab-use"]')); if (!use) return { error: 'no Use in Laboratory control' };
      use.click(); const fresh = await wait(() => document.querySelector('dialog[open] [data-action="lab-use-into"][data-id=""]')); if (!fresh) return { error: 'no new-blueprint choice' };
      fresh.click(); await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)) && /Ready for assembly planning/.test(document.querySelector('main').innerText), 200);
      document.querySelector('[data-action="lab-tab"][data-id="plan"]').click(); await wait(() => document.querySelector('#lab-arch'));
      const ready = await build('node-esm-express');
      const assemble = [...document.querySelectorAll('button')].find((b) => /Assemble application/.test(b.innerText));
      return { blocked, ready, assembleDisabled: assemble ? assemble.disabled : null };
    })()`);
    report('a blocked blueprint yields a diagnostic assembly plan with explicit blockers and no execution path',
      !planned.error && /Blocked by the blueprint/.test(planned.blocked || '') && /MISSING CAPABILITY/.test(planned.blocked || '') && /CREATE_HOST/.test(planned.blocked || ''),
      planned.error || (planned.blocked || '').split('\n').find((l) => /required goal|BLOCKED/.test(l)) || 'no readiness line');
    report('a blueprint holding only the harvested capability plans READY_TO_ASSEMBLE onto the new Express host, in order, with Assemble disabled',
      !planned.error && /Ready to assemble/.test(planned.ready || '') && /CREATE_HOST[\s\S]*REINDEX_HOST[\s\S]*CHECK_DEPENDENCIES[\s\S]*TRANSPLANT_CAPABILITY[\s\S]*VERIFY_CAPABILITY[\s\S]*REINDEX_HOST[\s\S]*FINAL_VERIFICATION/.test(planned.ready || '') && /specified, not created/.test(planned.ready || '') && planned.assembleDisabled === true,
      planned.error || (planned.ready || '').split('\n').find((l) => /deterministic execution path/.test(l)) || 'no readiness line');
    const planDir = path.join(home, 'graft-state', 'laboratory', 'plans');
    const planFiles = fs.existsSync(planDir) ? fs.readdirSync(planDir) : [];
    const planText = planFiles.map((f) => fs.readFileSync(path.join(planDir, f), 'utf8')).join('\n');
    report('assembly plans are stored under GRAFT_HOME by id without local paths, and planning created no worktree or folder',
      planFiles.length === 2 && ![home, source, os.homedir(), REPOS].some((p) => planText.includes(p)) && !fs.existsSync(path.join(home, 'graft-state', 'worktrees')) && !/"readiness": "VERIFIED"/.test(planText),
      `${planFiles.length} plan file(s)`);
    // Laboratory 0.3: assembly execution from the page. A hosted-provider authentication organ is
    // banked from a generated source (the packaged app reads its bank lazily); a blueprint holding
    // only that capability, planned onto the bare node:http host, is assembled: create host →
    // index → transplant in a managed worktree → verify → re-index. The blocked blueprint and the
    // Express plan keep Assemble disabled.
    const { hostedSource } = await import('../../packages/core/test/helpers/hosted-source.js');
    const { fingerprintProject: fingerprintForBank } = await import('../../packages/core/src/analyze/fingerprint.js');
    const { harvestCapability: harvestForBank } = await import('../../packages/core/src/harvest/index.js');
    const { writeManifest: writeBankManifest } = await import('../../packages/core/src/manifest/io.js');
    const hostedSrc = hostedSource(path.join(home, REPOS, 'hosted-source'));
    const hostedManifest = (await harvestForBank(fingerprintForBank(hostedSrc), 'hosted-authentication')).manifest;
    writeBankManifest(path.join(home, 'graft-state', 'organ-bank'), hostedManifest);
    const hostedListing = fs.readdirSync(hostedSrc, { recursive: true }).sort().join('\n');
    const appsParent = path.join(home, REPOS, 'apps'); fs.mkdirSync(appsParent, { recursive: true });
    await cdpEvaluate(9333, '127.0.0.1', "(location.hash = 'bank', location.reload(), null)").catch(() => null);
    await sleep(1500);
    const assembled = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      location.hash = 'bank'; await new Promise((r) => setTimeout(r, 500));
      const use = await wait(() => document.querySelector('.capability-exits [data-action="lab-use"][data-slug="${hostedManifest.identity.slug}"]')); if (!use) return { error: 'no Use in Laboratory for the hosted capability' };
      use.click(); const fresh = await wait(() => document.querySelector('dialog[open] [data-action="lab-use-into"][data-id=""]')); if (!fresh) return { error: 'no new-blueprint choice' };
      fresh.click(); await wait(() => /Ready for assembly planning/.test(document.querySelector('main').innerText), 200);
      document.querySelector('[data-action="lab-tab"][data-id="plan"]').click(); await wait(() => document.querySelector('#lab-arch'));
      document.querySelector('#lab-arch').value = 'node-esm-http-central'; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true; document.querySelector('[data-action="lab-plan-build"]').click();
      const ready = await wait(() => document.querySelector('.asm-steps') && /Ready to assemble/.test(document.querySelector('main').innerText), 150); if (!ready) return { error: 'the plan is not READY_TO_ASSEMBLE', main: document.querySelector('main').innerText.slice(-500) };
      const assemble = await wait(() => document.querySelector('[data-action="lab-assemble"]')); if (!assemble) return { error: 'Assemble application is not enabled' };
      assemble.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!run) return { error: 'no confirmation dialog' };
      const dialog = document.querySelector('dialog[open]').innerText;
      document.querySelector('#asm-name').value = 'Acceptance app'; document.querySelector('#asm-parent').value = ${JSON.stringify(appsParent)};
      run.click();
      await wait(() => /Assembly execution/.test(document.querySelector('main').innerText), 100);
      const seen = new Set();
      const finished = await wait(() => { const t = document.querySelector('main').innerText; for (const m of t.matchAll(/(Creating host|Indexing host|Checking dependencies|Applying capability|Verifying|Final check)/g)) seen.add(m[1]); return /Assembly (COMPLETED|FAILED|INCONCLUSIVE|BLOCKED)/.test(t) ? t : null; }, 3000);
      if (!finished) return { error: 'the assembly did not finish', main: document.querySelector('main').innerText.slice(-600) };
      // Open/Reveal live in the assembled-application panel, which loads its ledger first.
      await wait(() => document.querySelectorAll('button').length && [...document.querySelectorAll('button')].some((b) => /Open assembled project/.test(b.innerText)), 200);
      const buttons = [...document.querySelectorAll('button')].filter((b) => /Open assembled project|Reveal in Finder/.test(b.innerText)).map((b) => b.innerText.trim());
      return { dialog, result: finished.slice(finished.indexOf('Assembly execution')), seen: [...seen], buttons };
    })()`);
    report('Assemble application confirms what GRAFT will do, then the execution runs through its own states to a COMPLETED assembly with the capability VERIFIED',
      !assembled.error && /Create a new Node application/.test(assembled.dialog || '') && /No deployment will occur/.test(assembled.dialog || '') && /Assembly COMPLETED/.test(assembled.result || '') && /VERIFIED/.test(assembled.result || '') && /not a "verified app" claim/.test(assembled.result || '') && assembled.buttons?.length === 2,
      assembled.error ? `${assembled.error} ${(assembled.main || '').slice(-300)}` : `${(assembled.result || '').split('\n').find((l) => /Assembly COMPLETED/.test(l))} · progress seen: ${(assembled.seen || []).join(', ')}`);
    const executionsDir = path.join(home, 'graft-state', 'laboratory', 'executions');
    const executionFiles = fs.existsSync(executionsDir) ? fs.readdirSync(executionsDir).filter((f) => f.endsWith('.json')) : [];
    const executionRecord = executionFiles.length ? JSON.parse(fs.readFileSync(path.join(executionsDir, executionFiles[0]), 'utf8')) : null;
    const createdApp = path.join(appsParent, 'acceptance-app');
    const createdClean = fs.existsSync(createdApp) && execFileSync('git', ['status', '--porcelain'], { cwd: createdApp, encoding: 'utf8' }).trim() === '' && execFileSync('git', ['remote'], { cwd: createdApp, encoding: 'utf8' }).trim() === '';
    report('the created application is a clean local repository with no remote, the result lives in a managed worktree, the source is untouched, and the record is honest',
      executionRecord?.status === 'COMPLETED' && executionRecord.verification?.verdict === 'VERIFIED' && executionRecord.steps.every((s) => s.status === 'DONE') && createdClean && fs.existsSync(path.join(createdApp, 'server.mjs')) && executionRecord.worktree?.path && fs.existsSync(executionRecord.worktree.path) && fs.readdirSync(hostedSrc, { recursive: true }).sort().join('\n') === hostedListing && executionRecord.receipts?.[0]?.verdict === null,
      executionRecord ? `${executionRecord.status} · ${executionRecord.verification?.verdict} ${executionRecord.verification?.summary?.passed}/${executionRecord.verification?.summary?.required} · ${path.basename(executionRecord.worktree?.path || '')}` : 'no execution record');
    // Laboratory 0.3.5: the assembled application's ledger, the two evidence sources kept apart, and
    // explicit finalization promoting the verified revision into the person's own checkout.
    const primaryBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: createdApp, encoding: 'utf8' }).trim();
    const finalized = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      const ledger = await wait(() => /Assembled application/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 200);
      if (!ledger) return { error: 'no assembled application panel', main: document.querySelector('main').innerText.slice(-400) };
      const button = await wait(() => document.querySelector('[data-action="lab-finalize"]'));
      if (!button) return { error: 'Finalize is not offered', ledger: ledger.slice(ledger.indexOf('Assembled application')) };
      button.click();
      const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-finalize-run"]'));
      if (!run) return { error: 'no finalize confirmation' };
      const dialog = document.querySelector('dialog[open]').innerText;
      run.click();
      const refused = await wait(() => document.querySelector('#toast')?.classList.contains('show') ? document.querySelector('#toast').innerText : null, 30);
      document.querySelector('#finalize-confirm').checked = true;
      document.querySelector('[data-action="lab-finalize-run"]').click();
      const done = await wait(() => /Finalized/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300);
      return { ledger: ledger.slice(ledger.indexOf('Assembled application')), dialog, refusedWithoutConfirmation: refused, done: done ? done.slice(done.indexOf('Assembled application')) : null };
    })()`);
    report('the assembled application shows the capability as present by assembly evidence, VERIFIED, with the detector reported separately and honestly',
      !finalized.error && /present by assembly evidence/.test(finalized.ledger || '') && /VERIFIED/.test(finalized.ledger || '') && /Independent detector: not observed/.test(finalized.ledger || '') && /Added and verified by GRAFT/.test(finalized.ledger || ''),
      finalized.error ? `${finalized.error} ${(finalized.ledger || finalized.main || '').slice(0, 200)}` : (finalized.ledger || '').split('\n').find((l) => /Independent detector/.test(l)));
    report('finalization is explicit: it asks first, refuses without confirmation, and promises no force, reset or push',
      !finalized.error && /fast-forward/.test(finalized.dialog || '') && /No force, no reset, nothing pushed anywhere/.test(finalized.dialog || '') && /Confirm the move first/.test(finalized.refusedWithoutConfirmation || ''),
      finalized.error || finalized.refusedWithoutConfirmation || 'no refusal toast');
    const primaryAfter = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: createdApp, encoding: 'utf8' }).trim();
    const primaryLog = execFileSync('git', ['log', '--format=%H', '-2'], { cwd: createdApp, encoding: 'utf8' }).trim().split('\n');
    const workspaceFiles = fs.existsSync(path.join(home, 'graft-state', 'laboratory', 'assemblies')) ? fs.readdirSync(path.join(home, 'graft-state', 'laboratory', 'assemblies')) : [];
    const workspaceRecord = workspaceFiles.length ? JSON.parse(fs.readFileSync(path.join(home, 'graft-state', 'laboratory', 'assemblies', workspaceFiles[0]), 'utf8')) : null;
    report('after finalization the created project holds the assembled application, the blank host commit remains in history, and no remote exists',
      !finalized.error && /Finalized/.test(finalized.done || '') && primaryAfter !== primaryBefore && primaryLog[1] === primaryBefore
      && fs.existsSync(path.join(createdApp, 'src', 'auth', 'routes.js')) && execFileSync('git', ['status', '--porcelain'], { cwd: createdApp, encoding: 'utf8' }).trim() === ''
      && execFileSync('git', ['remote'], { cwd: createdApp, encoding: 'utf8' }).trim() === ''
      && workspaceRecord?.status === 'FINALIZED' && workspaceRecord.finalization?.kind === 'fast-forward' && workspaceRecord.finalization.forced === false
      && workspaceRecord.capabilities?.[0]?.verificationVerdict === 'VERIFIED',
      `${primaryBefore.slice(0, 8)} → ${primaryAfter.slice(0, 8)}`);
    // Capability Forms 0.1a: the library-form capability, end to end through the product.
    if (haveLibrary) {
      const found = (await api.call('/api/workspace/discover', { text: 'feature flags' })).body.candidates?.find((r) => r.implementationForm === 'library');
      report('a real third-party library is discovered as feature-flags in library form, on structural evidence',
        Boolean(found) && found.capability === 'feature-flags' && found.harvestable === true && (found.evidence || found.signals || []).length >= 4,
        found ? `${found.project?.name} · ${found.implementationForm} · ${(found.evidence || found.signals || []).map((e) => e.id).join(', ')}` : 'not discovered');
      // Harvested the way the page does it: the workspace route registers the project and picks
      // the form the observation actually recorded.
      const libraryHarvest = await api.job('/api/workspace/harvest', { projectId: found.projectId, capability: 'feature-flags', trusted: true });
      report('harvesting the library runs its own verification against the published artifact and reaches VERIFIED',
        libraryHarvest.status === 'completed' && libraryHarvest.result?.report?.verdict === 'VERIFIED' && libraryHarvest.result.report.method === 'library-artifact' && libraryHarvest.result.report.summary.failed === 0,
        `${libraryHarvest.result?.report?.verdict} ${libraryHarvest.result?.report?.summary?.passed}/${libraryHarvest.result?.report?.summary?.required} via ${libraryHarvest.result?.report?.method}`);
      const banked = (await api.state()).body.bank.find((b) => b.implementationForm === 'library');
      // 0.1b Checkpoint B: a destination integration now exists, and Capability Memory names exactly
      // the host shape that was proven instead of claiming general support.
      report('Capability Memory shows the form, the source verdict and only the destination integration that was proven',
        Boolean(banked) && banked.implementationForm === 'library' && banked.verification?.verdict === 'VERIFIED'
        && banked.integration?.supported === true
        && (banked.integration.targets || []).map((t) => t.profile).join() === 'esm-node-http-central'
        && /other destination shapes are not proven yet/.test(banked.integration?.reason || ''),
        banked ? `${banked.name} · ${banked.implementationForm} · ${banked.verification?.verdict} · integration ${(banked.integration?.targets || []).map((t) => t.profile).join()}` : 'not banked');
      // Reloading inside an evaluation would close the inspected target, so the refresh and the
      // read are two separate calls, as elsewhere in this script.
      await cdpEvaluate(9333, '127.0.0.1', "(location.hash = 'bank', location.reload(), null)").catch(() => null);
      await sleep(1800);
      const shown = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 150) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        location.hash = 'bank';
        const card = await wait(() => [...document.querySelectorAll('.bank-card')].find((c) => /Library/.test(c.innerText)));
        return card ? { text: card.innerText } : { error: 'no library card', body: document.querySelector('main')?.innerText.slice(0, 300) };
      })()`);
      report('the organ bank names the form in plain words and states only the destination integration that was proven',
        !shown.error && /Form: *Library/.test(shown.text || '') && /Source verification: *VERIFIED/.test(shown.text || '')
        && /Destination integration: *node \/ esm esm-node-http-central/.test(shown.text || '')
        && !/Universal|Works everywhere|all Node/i.test(shown.text || ''),
        shown.error || (shown.text || '').split('\n').filter((l) => /Form|integration|verification/i.test(l)).join(' · '));
      const libraryZipPath = path.join(exportDir, 'feature-flags-library.zip');
      const libraryExport = await api.call('/api/capabilities/export', { slug: 'feature-flags-library', destination: libraryZipPath });
      const libraryZip = libraryExport.body?.receipt?.destination || libraryZipPath;
      const libraryEntries = libraryZip && fs.existsSync(libraryZip) ? readZip(fs.readFileSync(libraryZip)) : {};
      const exportedManifest = libraryEntries['feature-flags-library/graft-capability.json'] ? JSON.parse(libraryEntries['feature-flags-library/graft-capability.json'].toString('utf8')) : null;
      report('the library exports as the library itself, with MIT provenance, and claims no destination integration',
        libraryExport.status === 200 && Object.keys(libraryEntries).includes('feature-flags-library/library/swivel.js') && Object.keys(libraryEntries).includes('feature-flags-library/LICENSES/LICENSE')
        && exportedManifest?.implementationForm === 'library' && exportedManifest.verification.source.verdict === 'VERIFIED'
        && exportedManifest.verification.destinationIntegration === 'not-yet-proven' && exportedManifest.verification.universalCompatibility === 'not-claimed'
        && exportedManifest.licence.declared === 'MIT' && !Object.keys(libraryEntries).some((f) => /src\/Swivel|test\/spec|\.git/.test(f)),
        `${libraryExport.status} · ${Object.keys(libraryEntries).length} entries · ${exportedManifest?.licence?.declared || libraryExport.body?.error || ''}`);
      const inLaboratory = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 150) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        location.hash = 'bank'; await new Promise((r) => setTimeout(r, 800));
        const card = await wait(() => [...document.querySelectorAll('.bank-card')].find((c) => /Library/.test(c.innerText)));
        const use = card?.querySelector('[data-action="lab-use"]') || [...document.querySelectorAll('[data-action="lab-use"]')].at(-1);
        if (!use) return { error: 'no Use in Laboratory control' };
        use.click();
        const fresh = await wait(() => document.querySelector('dialog[open] [data-action="lab-use-into"][data-id=""]'));
        if (!fresh) return { error: 'no new-blueprint choice' };
        fresh.click();
        await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)), 200);
        document.querySelector('[data-action="lab-tab"][data-id="plan"]').click();
        const chooser = await wait(() => document.querySelector('#lab-arch'));
        if (!chooser) return { error: 'no host chooser' };
        chooser.value = 'node-esm-express'; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true;
        document.querySelector('[data-action="lab-plan-build"]').click();
        await wait(() => document.querySelector('.asm-steps'), 200);
        const main = document.querySelector('main').innerText;
        const assemble = [...document.querySelectorAll('button')].find((b) => /Assemble application/.test(b.innerText));
        return { main, assembleEnabled: assemble ? !assemble.disabled : null, hasAssembleAction: Boolean(document.querySelector('[data-action="lab-assemble"]')) };
      })()`);
      report('the library can be selected in a Laboratory blueprint even though it cannot be assembled',
        !inLaboratory.error && /Blocked: capability support/.test(inLaboratory.main || ''),
        inLaboratory.error || (inLaboratory.main || '').split('\n').find((l) => /Blocked|Ready to assemble/.test(l)));
      report('assembly stays closed for a host with no proven adaptation, and offers no Assemble action',
        !inLaboratory.error && inLaboratory.hasAssembleAction === false && inLaboratory.assembleEnabled === false
        && /no proven adaptation writes feature-flags in library form into the express-req-res host/.test(inLaboratory.main || '')
        && !/npm install/.test(inLaboratory.main || ''),
        inLaboratory.error || (inLaboratory.main || '').split('\n').find((l) => /no proven adaptation/.test(l)) || 'no blocker line');

      // ---------------------------------------------------------------------------------------
      // Library Host Adaptation 0.1b Checkpoint C: the same capability, on the host GRAFT HAS
      // proven, assembled and finalized through the product's own controls.
      // ---------------------------------------------------------------------------------------
      const supportedPlan = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 200) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        const chooser = await wait(() => document.querySelector('#lab-arch'));
        if (!chooser) return { error: 'no host chooser' };
        chooser.value = 'node-esm-http-central'; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true;
        document.querySelector('[data-action="lab-plan-build"]').click();
        await wait(() => document.querySelector('.asm-steps') && /Ready to assemble/.test(document.querySelector('main').innerText), 200);
        const assemble = await wait(() => { const b = document.querySelector('[data-action="lab-assemble"]'); return b && !b.disabled ? b : null; }, 300) || [...document.querySelectorAll('button')].find((b) => /Assemble application/.test(b.innerText));
        // Step ids and engine operations sit behind collapsed Technical details (Commercial Beta 0.1); open them to read the record.
        document.querySelectorAll('details.tech').forEach((d) => { d.open = true; });
        const main = document.querySelector('main').innerText;
        return { main, steps: [...document.querySelectorAll('.asm-steps tbody tr td:nth-child(2)')].map((c) => c.innerText), assembleEnabled: assemble ? !assemble.disabled : null, hasAssembleAction: Boolean(document.querySelector('[data-action="lab-assemble"]')) };
      })()`);
      const wantedSteps = ['CREATE_HOST', 'REINDEX_HOST', 'CHECK_DEPENDENCIES', 'VERIFY_SOURCE_ARTIFACT_IDENTITY', 'ADAPT_LIBRARY_CAPABILITY', 'VERIFY_CAPABILITY', 'CHECK_HOST_PRESERVATION', 'REINDEX_HOST', 'FINAL_VERIFICATION'];
      report('the proven host opens the plan, shows the adaptation steps and enables Assemble',
        !supportedPlan.error && /Ready to assemble/.test(supportedPlan.main || '')
        && wantedSteps.every((t) => (supportedPlan.steps || []).some((x) => x.includes(t)))
        && !(supportedPlan.steps || []).includes('TRANSPLANT_CAPABILITY')
        && supportedPlan.hasAssembleAction === true && supportedPlan.assembleEnabled === true
        && /No package installation\. No source build\. No HTTP routes added\./.test(supportedPlan.main || ''),
        supportedPlan.error || `${(supportedPlan.steps || []).join(' → ')} · assemble=${supportedPlan.assembleEnabled}`);

      // Assemble through the product's own controls, into a folder inside the acceptance workspace.
      const libraryApps = path.join(home, 'library-apps');
      fs.mkdirSync(libraryApps, { recursive: true });
      // Through the product's own controls: Assemble, the folder, Run — then the page shows the execution it ran.
      const libraryRun = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        const assemble = await wait(() => { const b = document.querySelector('[data-action="lab-assemble"]'); return b && !b.disabled ? b : null; }, 300); if (!assemble) return { error: 'Assemble application is not enabled' };
        assemble.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!run) return { error: 'no confirmation dialog' };
        document.querySelector('#asm-name').value = 'Feature-flagged application'; document.querySelector('#asm-parent').value = ${JSON.stringify(libraryApps)};
        run.click();
        const finished = await wait(() => /Assembly (COMPLETED|FAILED|INCONCLUSIVE|BLOCKED|STALE)/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 3000);
        return finished ? { status: 'completed' } : { error: 'the assembly did not finish', main: document.querySelector('main').innerText.slice(-400) };
      })()`, { commandTimeout: 600000 });
      const libraryExec = fs.readdirSync(executionsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(executionsDir, f), 'utf8'))).find((e) => e.adaptation && !e.composition) || null;
      report('the packaged product assembles the library capability: identity checked, adapted, verified, host preserved',
        libraryRun.status === 'completed' && libraryExec?.status === 'COMPLETED'
        && libraryExec.steps.every((x) => x.status === 'DONE')
        && libraryExec.verification?.verdict === 'VERIFIED' && libraryExec.verification.proofOf === 'destination-adaptation'
        && libraryExec.hostPreservation?.captured === true && libraryExec.hostPreservation.failed === 0
        && libraryExec.adaptation?.artifactSha256 === 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8'
        && libraryExec.reindex?.detectorObservation === 'NOT_OBSERVED',
        libraryExec ? `${libraryExec.status} · ${libraryExec.verification?.verdict} ${libraryExec.verification?.summary?.passed}/${libraryExec.verification?.summary?.required} · preservation ${libraryExec.hostPreservation?.passed}/${libraryExec.hostPreservation?.tests} · detector ${libraryExec.reindex?.detectorObservation}` : String(libraryRun.error || libraryRun.status));

      // The evidence panel: four separate claims, the detector's silence explained, no combined score.
      const evidencePanel = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 200) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        const t = await wait(() => /What was proven/.test(document.querySelector('main')?.innerText || '') ? document.querySelector('main').innerText : null);
        return t ? { panel: t.slice(t.indexOf('What was proven'), t.indexOf('What was proven') + 2600) } : { error: 'no evidence panel' };
      })()`);
      report('the evidence panel states source, artifact, destination, host and detector as separate claims',
        !evidencePanel.error
        && /Source\s*\n?\s*VERIFIED/.test(evidencePanel.panel) && /8\s*\/\s*8/.test(evidencePanel.panel)
        && /Artifact identity\s*\n?\s*MATCHED/.test(evidencePanel.panel)
        && /Destination\s*\n?\s*VERIFIED/.test(evidencePanel.panel) && /10\s*\/\s*10/.test(evidencePanel.panel)
        && /Host preservation\s*\n?\s*PASSED/.test(evidencePanel.panel)
        && /NOT OBSERVED/.test(evidencePanel.panel) && /There is no combined score/.test(evidencePanel.panel)
        && !/18\s*\/\s*18/.test(evidencePanel.panel),
        evidencePanel.error || evidencePanel.panel.split('\n').filter(Boolean).slice(0, 8).join(' · '));

      // Presence: GRAFT's own evidence, beside an honest detector result.
      const libraryAssembly = (await api.call('/api/laboratory/assembly', { assemblyWorkspaceId: libraryExec.assemblyWorkspaceId })).body.assembly;
      report('presence is GRAFT’s own assembly evidence, and the detector’s silence does not weaken it',
        libraryAssembly?.presence?.[0]?.presence === 'PRESENT_BY_ASSEMBLY_EVIDENCE'
        && libraryAssembly.presence[0].independentDetection === 'not observed'
        && libraryAssembly.capabilities[0].state === 'CURRENT'
        && libraryAssembly.capabilities[0].implementationForm === 'library'
        && libraryAssembly.capabilities[0].adaptation?.licence?.declared === 'MIT'
        && libraryAssembly.capabilities[0].sourceVerification?.summary?.passed === 8
        && libraryAssembly.capabilities[0].adaptation.destinationContract?.passed === 10,
        `${libraryAssembly?.presence?.[0]?.presence} · detector ${libraryAssembly?.presence?.[0]?.independentDetection} · ${libraryAssembly?.capabilities?.[0]?.state}`);

      // Finalize explicitly, then the person's own checkout holds the verified revision.
      const createdLibraryApp = libraryExec.createdProject.root;
      const beforeFinalize = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: createdLibraryApp, encoding: 'utf8' }).trim();
      const finalized = await api.call('/api/laboratory/assembly/finalize', { assemblyWorkspaceId: libraryExec.assemblyWorkspaceId, confirmed: true });
      const afterFinalize = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: createdLibraryApp, encoding: 'utf8' }).trim();
      const vendored = path.join(createdLibraryApp, 'vendor', 'swivel.cjs');
      const vendoredSha = fs.existsSync(vendored) ? `sha256:${crypto.createHash('sha256').update(fs.readFileSync(vendored)).digest('hex')}` : null;
      const finalProvenance = fs.existsSync(path.join(createdLibraryApp, 'vendor', 'swivel.provenance.json')) ? JSON.parse(fs.readFileSync(path.join(createdLibraryApp, 'vendor', 'swivel.provenance.json'), 'utf8')) : null;
      report('finalizing fast-forwards the person’s own project to the verified revision, artifact and provenance intact',
        finalized.status === 200 && afterFinalize !== beforeFinalize
        && afterFinalize === libraryExec.assembledRevision
        && finalized.body?.assembly?.finalization?.kind === 'fast-forward' && finalized.body.assembly.finalization.forced === false
        && vendoredSha === 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8'
        && fs.existsSync(path.join(createdLibraryApp, 'src', 'feature-flags.js'))
        && fs.existsSync(path.join(createdLibraryApp, 'vendor', 'swivel.LICENSE'))
        // The acceptance workspace holds a plain copy of the published artifact, not a git checkout, so
        // provenance names the folder; a real checkout records the upstream URL (proven by the dogfood run).
        && /swiveljs/.test(finalProvenance?.source?.repository || '') && finalProvenance?.licence?.declared === 'MIT'
        && finalProvenance?.adaptation?.adapterAuthoredBy === 'GRAFT' && finalProvenance?.artifact?.copiedVerbatim === true
        && execFileSync('git', ['status', '--porcelain'], { cwd: createdLibraryApp, encoding: 'utf8' }).trim() === ''
        && execFileSync('git', ['remote'], { cwd: createdLibraryApp, encoding: 'utf8' }).trim() === '',
        `${beforeFinalize.slice(0, 8)} → ${afterFinalize.slice(0, 8)} (assembled ${String(libraryExec?.assembledRevision).slice(0, 8)}) · HTTP ${finalized.status} ${finalized.body?.assembly?.finalization?.kind || finalized.body?.error || ''} · artifact ${vendoredSha === 'sha256:958f8dc2539936e700d24b184082f1befdae6974f5097f48ba66cf15231fefa8' ? 'identical' : vendoredSha} · licence ${finalProvenance?.licence?.declared} · authored ${finalProvenance?.adaptation?.adapterAuthoredBy}/${finalProvenance?.artifact?.copiedVerbatim} · clean ${execFileSync('git', ['status', '--porcelain'], { cwd: createdLibraryApp, encoding: 'utf8' }).trim() === ''}`);

      // The finalized application runs on its own, and its capability answers correctly.
      const standalonePort = 3971;
      const standalone = spawn(process.execPath, ['server.mjs'], { cwd: createdLibraryApp, env: { ...process.env, PORT: String(standalonePort) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let hostChecks = null;
      try {
        await waitFor(async () => fetch(`http://127.0.0.1:${standalonePort}/health`).then((r) => r.ok).catch(() => false), { timeout: 20000, interval: 250, what: 'the finalized application' });
        const rootRes = await fetch(`http://127.0.0.1:${standalonePort}/`);
        const unknownRes = await fetch(`http://127.0.0.1:${standalonePort}/nothing-here`);
        hostChecks = { health: (await fetch(`http://127.0.0.1:${standalonePort}/health`)).status, root: rootRes.status, unknown: unknownRes.status };
      } catch (err) { hostChecks = { error: err.message }; }
      finally { standalone.kill('SIGKILL'); }
      report('the finalized application serves its own routes and a deterministic 404, standing alone',
        hostChecks?.health === 200 && hostChecks.root === 200 && hostChecks.unknown === 404,
        JSON.stringify(hostChecks));
      const probeFile = path.join(createdLibraryApp, '.acceptance-flags.mjs');
      fs.writeFileSync(probeFile, `import Flags from './src/feature-flags.js';
const map = { Graft: [1, 2], 'Graft.enabled': [1], 'Graft.off': [] };
const on = new Flags({ map, bucketIndex: 1 }), off = new Flags({ map, bucketIndex: 2 });
let took = null; on.branch('Graft.enabled', () => { took = 'enabled'; }, () => { took = 'disabled'; });
console.log(JSON.stringify({ enabled: on.isEnabled('Graft.enabled'), disabled: off.isEnabled('Graft.enabled'), empty: on.isEnabled('Graft.off'), unknown: on.isEnabled('nope'), chose: on.choose('Graft.enabled', 'on', 'off'), took, repeated: [on.isEnabled('Graft.enabled'), on.isEnabled('Graft.enabled')] }));
`);
      let flagChecks = null;
      try { flagChecks = JSON.parse(execFileSync(process.execPath, [probeFile], { cwd: createdLibraryApp, encoding: 'utf8', timeout: 30000 })); }
      catch (err) { flagChecks = { error: String(err.message).slice(0, 200) }; }
      finally { fs.rmSync(probeFile, { force: true }); }
      report('the finalized application’s own feature-flag adapter answers correctly and deterministically',
        flagChecks?.enabled === true && flagChecks.disabled === false && flagChecks.empty === false && flagChecks.unknown === false
        && flagChecks.chose === 'on' && flagChecks.took === 'enabled' && new Set(flagChecks.repeated).size === 1,
        JSON.stringify(flagChecks));

      // ---------------------------------------------------------------------------------------
      // Real Multi-Capability Composition 0.1 Checkpoint D: two goals in one blueprint (the banked
      // hosted authentication and the library), planned in declared order, assembled as ONE
      // composition through the product's own controls, both verified on one final revision, two
      // ledger records, explicit finalization.
      // ---------------------------------------------------------------------------------------
      const composeParent = path.join(home, REPOS, 'apps-compose'); fs.mkdirSync(composeParent, { recursive: true });
      const composed = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        location.hash = 'laboratory'; await new Promise((r) => setTimeout(r, 400));
        document.querySelector('[data-action="lab-back"]')?.click();
        const form = await wait(() => document.querySelector('#lab-create-form')); if (!form) return { error: 'no Laboratory form' };
        form.name.value = 'Acceptance composition'; form.description.value = 'People sign in, and features can be turned on for some of them.';
        for (const b of form.querySelectorAll('input[name="categories"]')) b.checked = ['authentication', 'feature-flags'].includes(b.value);
        form.hostIntent.value = 'new-application'; form.requestSubmit();
        if (!await wait(() => [...document.querySelectorAll('.eyebrow')].find((e) => /BLUEPRINT/.test(e.innerText)), 200)) return { error: 'the blueprint did not open' };
        document.querySelector('[data-action="lab-tab"][data-id="capabilities"]').click();
        const picked = [];
        for (let i = 0; i < 2; i += 1) {
          const goal = (await wait(() => document.querySelectorAll('.bp-goal').length === 2 ? document.querySelectorAll('.bp-goal')[i] : null)); if (!goal) return { error: 'goal ' + i + ' missing' };
          const cards = [...goal.querySelectorAll('[data-action="lab-select"]')].filter((c) => /source VERIFIED/.test(c.innerText));
          // The bank holds two verified authentication organs here; the hosted one is the proven pair.
          const card = cards.find((c) => /hosted/i.test(c.innerText)) || cards[0]; if (!card) return { error: 'no verified candidate for ' + goal.querySelector('h2')?.innerText };
          picked.push(goal.querySelector('h2').innerText + ': ' + card.innerText.split('\\n')[0]); card.click();
          await wait(() => document.querySelectorAll('.bp-goal')[i]?.querySelector('.wf-choice.selected'), 100);
        }
        document.querySelector('[data-action="lab-tab"][data-id="plan"]').click(); await wait(() => document.querySelector('#lab-arch'));
        document.querySelector('#lab-arch').value = 'node-esm-http-central'; document.querySelectorAll('input[name="lab-host-kind"]')[0].checked = true; document.querySelector('[data-action="lab-plan-build"]').click();
        const ready = await wait(() => document.querySelector('.asm-order') && /Ready to assemble/.test(document.querySelector('main').innerText), 200); if (!ready) return { error: 'the plan is not READY_TO_ASSEMBLE', picked, main: document.querySelector('main').innerText.slice(0, 500) };
        const order = [...document.querySelectorAll('.asm-order li')].map((l) => l.innerText);
        const steps = [...document.querySelectorAll('.asm-steps tbody tr')].map((r) => r.querySelectorAll('td')[1].innerText.split('\\n')[0]);
        const assemble = await wait(() => document.querySelector('[data-action="lab-assemble"]')); if (!assemble) return { error: 'Assemble application is not enabled', picked, order, steps };
        assemble.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-assemble-run"]')); if (!run) return { error: 'no confirmation dialog' };
        const dialog = document.querySelector('dialog[open]').innerText;
        document.querySelector('#asm-name').value = 'Acceptance composition'; document.querySelector('#asm-parent').value = ${JSON.stringify(composeParent)};
        run.click();
        const stages = new Set();
        const finished = await wait(() => { const t = document.querySelector('main').innerText; for (const m of t.matchAll(/(Adding User authentication|Verifying User authentication|Verifying Feature flags artifact|Adapting Feature flags|Verifying Feature flags|Re-verifying User authentication|Checking final host preservation|Re-indexing application|Final verification)/g)) stages.add(m[1]); return /Assembly (COMPLETED|FAILED|INCONCLUSIVE|BLOCKED|STALE)/.test(t) ? t : null; }, 3000);
        if (!finished) return { error: 'the composition did not finish', picked, diagnostics: { page: window.graftPage || null, visibility: document.visibilityState, hidden: document.hidden, hash: location.hash, now: Date.now() }, main: document.querySelector('main').innerText.slice(-600) };
        // The evidence view completes once the ledger has loaded (the same-revision marks come from it).
        const ledger = await wait(() => /record 2 of 2/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 200);
        const full = ledger || finished;
        return { picked, order, steps, dialog, stages: [...stages], result: full.slice(full.indexOf('Assembly execution')), ledger: ledger ? ledger.slice(ledger.indexOf('Assembled application')) : null };
      })()`, { commandTimeout: 600000 });
      if (composed.error) console.log(`   composition page diagnostics :: ${JSON.stringify(composed.diagnostics || null)} :: server jobs: ${JSON.stringify((await api.state()).body.jobs.filter((j) => j.kind === 'assembly').map((j) => ({ id: j.id, status: j.status, phase: j.phase, exec: j.execution?.status || j.result?.execution?.status || null })))}`);
      report('a two-goal blueprint selects both real capabilities and plans READY in declared order, authentication first, with the re-verification in the plan',
        !composed.error && composed.picked?.length === 2 && /^1?\.?\s*User authentication/.test(composed.order?.[0] || '') && /Feature flags/.test(composed.order?.[1] || '') && composed.steps?.includes('Re-verify capability — User authentication') && composed.steps?.includes('Adapt library capability — Feature flags') && composed.steps?.includes('Transplant capability — User authentication'),
        composed.error ? `${composed.error} ${JSON.stringify(composed.picked || composed.main || '').slice(0, 300)}` : `${composed.picked.join(' · ')} → ${composed.order.join(' → ')}`);
      report('Assemble names both capabilities and the re-verification, then the real composition runs through its own stages to COMPOSITION VERIFIED',
        !composed.error && /Add User authentication/.test(composed.dialog || '') && /Add Feature flags/.test(composed.dialog || '') && /Verify User authentication .*again/.test(composed.dialog || '') && /Assembly COMPLETED/.test(composed.result || '') && /COMPOSITION VERIFIED/.test(composed.result || '') && ['Adding User authentication', 'Re-verifying User authentication', 'Final verification'].every((x) => composed.stages?.includes(x)),
        composed.error || `stages: ${(composed.stages || []).join(', ')}`);
      const composeExec = (fs.readdirSync(executionsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(executionsDir, f), 'utf8'))).find((e) => e.composition)) || null;
      const cc = composeExec?.composition || null;
      report('the composition record is the product\'s real execution: auth verified, re-verified after the library, library identity matched and verified, one final revision',
        composeExec?.status === 'COMPLETED' && cc?.finalState === 'ALL_SELECTED_CAPABILITIES_VERIFIED' && cc.capabilities?.length === 2 && cc.capabilities[0].reverifiedVerdict === 'VERIFIED' && cc.capabilities[1].artifactIdentity?.matched === true && cc.capabilities.every((x) => x.finalVerdict === 'VERIFIED') && Boolean(cc.finalRevision) && cc.finalPreservation?.tests > 0 && cc.finalPreservation.failed === 0,
        cc ? `${cc.finalState} @ ${String(cc.finalRevision).slice(0, 12)} · ${cc.capabilities.map((x) => `${x.capability}:${x.initialVerdict}${x.reverifiedVerdict ? '/' + x.reverifiedVerdict : ''}`).join(' ')}` : 'no composition execution');
      const page = composed.result || '';
      report('the page renders each capability\'s evidence separately with the one final revision, both presences by assembly evidence, the detector reported honestly and no combined score',
        (page.match(/VERIFIED AT THIS REVISION/g) || []).length === 2 && new RegExp(String(cc?.finalRevision || 'x').slice(0, 12)).test(page) && /Destination, when added\s*\n?\s*VERIFIED/.test(page) && /Destination, after the later capabilities\s*\n?\s*VERIFIED/.test(page) && /Artifact identity\s*\n?\s*MATCHED/.test(page) && (page.match(/ADDED AND VERIFIED BY GRAFT/g) || []).length === 2 && /Independent detector\s*\n?\s*NOT OBSERVED/.test(page) && /GRAFT knows it is present from the verified assembly evidence/.test(page) && /There is no combined score/.test(page) && !/\b(18|21|23|31|33)\/(18|21|23|31|33)\b/.test(page),
        page ? page.split('\n').filter((l) => /AT THIS REVISION|combined score/.test(l)).join(' | ').slice(0, 200) : 'no page');
      report('the ledger shows two CURRENT records, each at the same application revision, and offers Finalize',
        (composed.ledger?.match(/record \d of 2/g) || []).length === 2 && (composed.ledger?.match(/same revision as the whole application/g) || []).length === 2 && /2 capabilities, 2 current/.test(composed.ledger || '') && /Finalize assembled project/.test(composed.ledger || ''),
        (composed.ledger || 'no ledger').split('\n').find((l) => /2 capabilities/.test(l)) || 'no ledger line');
      const composeApp = composeExec?.createdProject?.root || null;
      const composeBefore = composeApp ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: composeApp, encoding: 'utf8' }).trim() : null;
      const composeFinal = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
        const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
        const button = await wait(() => document.querySelector('[data-action="lab-finalize"]')); if (!button) return { error: 'Finalize is not offered' };
        button.click(); const run = await wait(() => document.querySelector('dialog[open] [data-action="lab-finalize-run"]')); if (!run) return { error: 'no finalize confirmation' };
        document.querySelector('#finalize-confirm').checked = true; run.click();
        const done = await wait(() => /Finalized/.test(document.querySelector('main').innerText) ? document.querySelector('main').innerText : null, 300);
        return { done: done ? done.slice(done.indexOf('Finalized')).slice(0, 300) : null };
      })()`);
      const composeWorkspace = fs.readdirSync(path.join(home, 'graft-state', 'laboratory', 'assemblies')).map((f) => JSON.parse(fs.readFileSync(path.join(home, 'graft-state', 'laboratory', 'assemblies', f), 'utf8'))).find((w) => w.executionIds?.includes(composeExec?.executionId)) || null;
      const composeAfter = composeApp ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: composeApp, encoding: 'utf8' }).trim() : null;
      report('finalizing the composition is explicit and fast-forwards the created project to the one final revision holding both capabilities',
        !composeFinal.error && composeWorkspace?.status === 'FINALIZED' && composeWorkspace.finalization?.kind === 'fast-forward' && composeWorkspace.finalization.forced === false && composeAfter === cc?.finalRevision && composeBefore !== composeAfter && composeWorkspace.capabilities?.length === 2 && composeWorkspace.capabilities.every((r) => r.currentVerifiedRevision === cc.finalRevision && r.verificationVerdict === 'VERIFIED') && fs.existsSync(path.join(composeApp, 'src', 'auth', 'routes.js')) && fs.existsSync(path.join(composeApp, 'src', 'feature-flags.js')) && fs.existsSync(path.join(composeApp, 'vendor', 'swivel.cjs')),
        composeFinal.error || `${String(composeBefore).slice(0, 8)} → ${String(composeAfter).slice(0, 8)} · ${composeWorkspace?.capabilities?.map((r) => `${r.capability}:${r.state}`).join(' ')}`);
    }

    const blockedAssemble = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      location.hash = 'laboratory'; await new Promise((r) => setTimeout(r, 400));
      document.querySelector('[data-action="lab-back"]')?.click(); const open = await wait(() => [...document.querySelectorAll('[data-action="lab-open"]')].find((b) => /Acceptance portal/.test(b.closest('.history-row')?.innerText || ''))); if (!open) return { error: 'no Acceptance portal blueprint' };
      open.click(); await wait(() => /BLUEPRINT/.test(document.querySelector('.eyebrow')?.innerText || ''));
      document.querySelector('[data-action="lab-tab"][data-id="plan"]').click(); await wait(() => document.querySelector('.asm-steps') || document.querySelector('#lab-arch'));
      await new Promise((r) => setTimeout(r, 500));
      const assemble = [...document.querySelectorAll('button')].find((b) => /Assemble application/.test(b.innerText));
      return { readiness: (/Blocked by the blueprint|Ready to assemble/.exec(document.querySelector('main').innerText) || [])[0] || null, disabled: assemble ? assemble.disabled : null, enabledControl: Boolean(document.querySelector('[data-action="lab-assemble"]')) };
    })()`);
    report('a BLOCKED_BLUEPRINT plan keeps Assemble application disabled and exposes no execution control',
      !blockedAssemble.error && blockedAssemble.readiness === 'Blocked by the blueprint' && blockedAssemble.disabled === true && blockedAssemble.enabledControl === false,
      blockedAssemble.error || `${blockedAssemble.readiness} · disabled=${blockedAssemble.disabled}`);
    const blockedExecute = await api.call('/api/laboratory/execute', { planId: (await api.call('/api/laboratory/plans', {})).body.plans.find((p) => p.readiness === 'BLOCKED_BLUEPRINT').planId, destinationParent: appsParent });
    report('the product refuses to execute a blocked plan through its API as well', blockedExecute.status === 409 && /BLOCKED_BLUEPRINT/.test(blockedExecute.body.error || ''), `${blockedExecute.status} ${blockedExecute.body.error || ''}`);
    await cdpEvaluate(9333, '127.0.0.1', 'location.reload(), null').catch(() => null);
    await sleep(1200);
    const panel = await reviewPanel(9333, dst.body.project.id, 'review panel');
    report('no prior observation is claimed before any transplant has been verified', !/Atlas:/.test(panel.text || ''));

    // The guided Transplant flow in the packaged renderer: source -> destination -> isolated
    // worktree -> plan review -> apply & verify -> proof -> explicit cleanup. Every step is a
    // click in the page; nothing here touches git or the file system on the user's behalf.
    const destinationBefore = snapshotRepo(destination);
    const WAIT = `const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };`;
    // Stage 1: capability -> destination -> prepare (a few seconds).
    let guided = await cdpEvaluate(9333, '127.0.0.1', `(async () => { ${WAIT}
      location.hash = 'transplant';
      await new Promise((r) => setTimeout(r, 500));
      const source = await wait(() => document.querySelector('[data-action="wf-source"][data-slug="${harvest.result.slug}"]'));
      if (!source) return { error: 'no banked source choice', body: document.body.innerText.slice(0, 400) };
      source.click();
      const card = await wait(() => [...document.querySelectorAll('[data-action="wf-destination"]')].find((c) => c.dataset.root === ${JSON.stringify(fs.realpathSync(destination))} && !c.disabled));
      if (!card) return { error: 'the destination was not offered as supported', body: [...document.querySelectorAll('[data-action="wf-destination"]')].map((c) => c.innerText.replace(/\\n/g, ' | ')).join('\\n') };
      card.click();
      const prepare = await wait(() => document.querySelector('[data-action="wf-prepare"]'));
      if (!prepare) return { error: 'no prepare control' };
      prepare.click();
      // Preparing runs nothing, but it creates a worktree, so the page asks for confirmation first.
      const confirm = await wait(() => document.querySelector('dialog[open] #confirm-form'));
      if (!confirm) return { error: 'prepare confirmation did not open', body: document.body.innerText.slice(0, 600) };
      confirm.querySelector('[name="trusted"]').checked = true;
      confirm.requestSubmit();
      const copy = await wait(() => document.querySelector('[data-action="wf-copy"]'), 400);
      if (!copy) return { error: 'worktree panel did not render: ' + (document.querySelector('#toast')?.textContent || 'no message') + ' | ' + document.body.innerText.slice(0, 300).replace(/\\n/g, ' ') };
      return { worktree: copy.dataset.root, controls: ['wf-open', 'wf-reveal', 'wf-copy', 'wf-cleanup'].filter((a) => document.querySelector('[data-action="' + a + '"]')) };
    })()`);
    // Stage 2: build the plan, approve conflicting routes if the page asks, confirm apply.
    if (!guided.error) guided = { ...guided, ...(await cdpEvaluate(9333, '127.0.0.1', `(async () => { ${WAIT}
      const build = await wait(() => document.querySelector('[data-action="wf-plan"]'));
      if (!build) return { error: 'no build-plan control' };
      build.click();
      let apply = await wait(() => document.querySelector('[data-action="confirm-apply"]'), 300);
      if (!apply) return { error: 'plan panel did not render', body: document.body.innerText.slice(0, 800) };
      let resolved = false;
      if (apply.disabled) {
        const resolve = document.querySelector('[data-action="wf-plan-resolve"]');
        if (!resolve) return { error: 'apply disabled with no way to approve conflicting routes', body: document.body.innerText.slice(0, 800) };
        resolve.click(); resolved = true;
        apply = await wait(() => { const b = document.querySelector('[data-action="confirm-apply"]'); return b && !b.disabled ? b : null; }, 300);
        if (!apply) return { error: 'apply stayed disabled after approving conflicts' };
      }
      const planText = document.querySelector('.plan-panel').innerText;
      apply.click();
      const form = await wait(() => document.querySelector('dialog[open] #confirm-form'));
      if (!form) return { error: 'apply confirmation did not open' };
      form.querySelector('[name="trusted"]').checked = true;
      form.requestSubmit();
      return { resolved, planText };
    })()`)) };
    // Stage 3: verification runs on the bundled Node; poll the page for the proof panel.
    if (!guided.error) {
      const proof = await waitFor(() => cdpEvaluate(9333, '127.0.0.1', `(() => {
        const h = [...document.querySelectorAll('.panel-title h2')].find((x) => x.textContent === 'Proof');
        if (!h) return null;
        const row = [...document.querySelectorAll('.history-row')].find((r) => r.innerText.includes(${JSON.stringify(guided.worktree)}));
        return { proofText: h.closest('.panel').innerText, managedRow: row ? row.innerText : null };
      })()`), { timeout: 180000, interval: 1000, what: 'the proof panel' }).catch(async (err) => ({ error: err.message, diagnostics: await cdpEvaluate(9333, '127.0.0.1', `(() => ({ hash: location.hash, titles: [...document.querySelectorAll('.panel-title h2')].map((h) => h.textContent), jobs: (data.jobs || []).map((j) => [j.kind, j.status, Boolean(j.result?.proof), j.result?.transplantId || null]), proof: Boolean(wf.proof) }))()`).catch((e) => e.message) }));
      guided = { ...guided, ...proof };
    }
    report('the guided Transplant flow prepares an isolated worktree beneath GRAFT\'s own folder from the page',
      !guided.error && underPath(fs.realpathSync(guided.worktree), fs.realpathSync(path.join(home, 'graft-state', 'worktrees'))),
      guided.error ? `${guided.error} ${JSON.stringify(guided.diagnostics || '')}` : guided.worktree);
    report('the worktree panel offers Open, Reveal, Copy path and Clean up in the desktop app',
      !guided.error && ['wf-open', 'wf-reveal', 'wf-copy', 'wf-cleanup'].every((a) => (guided.controls || []).includes(a)), (guided.controls || []).join(','));
    report('the plan review lists what will be created and edited, and the security-sensitive changes',
      /Will be created/.test(guided.planText || '') && /Will be edited/.test(guided.planText || '') && /Security-sensitive changes/.test(guided.planText || ''),
      guided.resolved ? 'conflicting routes were approved from the page' : 'no route conflicts');
    report('the proof panel shows the verifier\'s VERIFIED with invariants, counterfactuals and host preservation',
      /VERIFIED/.test(guided.proofText || '') && /held/.test(guided.proofText || '') && /Counterfactuals/.test(guided.proofText || '') && /Host preservation/.test(guided.proofText || '') && /Changed files/.test(guided.proofText || ''),
      (guided.proofText || '').split('\n').slice(0, 3).join(' | '));
    report('the managed transplant is listed as VERIFIED with its branch and base', /VERIFIED/.test(guided.managedRow || '') && /graft\//.test(guided.managedRow || ''));
    const worktreeRepo = guided.worktree ? snapshotRepo(guided.worktree) : null;
    report('the transplant was applied on the prepared branch, with no second branch',
      Boolean(worktreeRepo) && /^graft\/[a-z0-9-]+-[0-9a-f]{8}$/.test(worktreeRepo.branch) && git(destination, ['branch', '--list', 'graft/*']).split('\n').filter(Boolean).length === 1,
      worktreeRepo?.branch);
    report('the user\'s own destination checkout was not touched by the guided flow',
      JSON.stringify(snapshotRepo(destination)) === JSON.stringify(destinationBefore), `${destinationBefore.branch} @ ${destinationBefore.head?.slice(0, 12)}`);
    const cleanedUp = await cdpEvaluate(9333, '127.0.0.1', `(async () => {
      const wait = async (test, tries = 100) => { for (let i = 0; i < tries; i += 1) { const v = test(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };
      // This session may hold more than one managed worktree (the Laboratory assembled one too):
      // clean up the guided flow's own worktree, named explicitly.
      const rows = [...document.querySelectorAll('.history-row')].filter((r) => r.innerText.includes('${guided.worktree || ''}'));
      const button = (rows.at(-1) || document).querySelector('[data-action="wf-cleanup"]');
      if (!button) return { error: 'no clean-up control' };
      button.click();
      const confirm = await wait(() => document.querySelector('dialog[open] [data-action="wf-cleanup-confirm"]'));
      if (!confirm) return { error: 'clean-up confirmation did not open' };
      const warned = /contains changes/.test(document.querySelector('dialog[open]').innerText);
      confirm.click();
      const gone = await wait(() => !document.querySelector('dialog[open]') && ![...document.querySelectorAll('.history-row')].some((r) => r.innerText.includes('${guided.worktree || ''}')) ? true : null, 200);
      return { warned, gone: Boolean(gone) };
    })()`);
    report('cleaning up a verified worktree warns that changes will be discarded and waits for confirmation', !cleanedUp.error && cleanedUp.warned === true, cleanedUp.error);
    report('after confirmation the worktree and its branch are gone and the destination is unchanged',
      cleanedUp.gone === true && !fs.existsSync(guided.worktree || '/nonexistent') && git(destination, ['branch', '--list', 'graft/*']).trim() === '' && JSON.stringify(snapshotRepo(destination)) === JSON.stringify(destinationBefore),
      `${guided.worktree}`);

    const plan = await api.call('/api/plan', { slug: harvest.result.slug, projectId: dst.body.project.id, resolveConflicts: true });
    report('the packaged app produces a reviewable preview including the entrypoint edit',
      plan.status === 200 && plan.body.plan.files.length > 0 && Boolean(plan.body.entrypoint) && plan.body.safety.ok === true,
      `${plan.body.plan?.files?.length} files`);

    const before = snapshotRepo(destination);
    const apply = await api.job('/api/apply', { planId: plan.body.id, trusted: true });
    report('the packaged transplant applies and the destination verifies',
      apply.status === 'completed' && passing(apply.result.report),
      `${apply.result?.report?.verdict} ${count(apply.result?.report)} on ${apply.result?.branch}`);
    report('the transplant landed on a new recovery branch and left a receipt',
      snapshotRepo(destination).branch !== before.branch && fs.existsSync(apply.result.receiptPath),
      `${before.branch} -> ${apply.result.branch}`);
    // The packaged renderer must actually paint the workspace, not just answer the API.
    await cdpEvaluate(9333, '127.0.0.1', 'location.reload(), null').catch(() => null);
    await sleep(1500);
    const ui = await cdpEvaluate(9333, '127.0.0.1', `(() => ({
      navigation: document.querySelectorAll('.nav-item').length,
      version: document.querySelector('.version')?.textContent || '',
      disconnected: Boolean(document.querySelector('.connection.offline')),
      alert: document.querySelector('[role="alert"]')?.textContent || '',
      body: document.body.innerText.slice(0, 4000),
    }))()`);
    report('the packaged renderer paints the workspace with the shipped version',
      ui.navigation >= 5 && ui.version.includes('0.5.0') && ui.disconnected === false && ui.alert === '',
      `${ui.navigation} navigation items, version "${ui.version.trim()}"`);
    await cdpEvaluate(9333, '127.0.0.1', "location.hash = '#projects', null");
    await sleep(750);
    const projectsView = await cdpEvaluate(9333, '127.0.0.1', 'document.querySelector("#main").innerText');
    report('the packaged workspace lists both registered repositories by their real paths (spaces and non-ASCII intact)',
      projectsView.includes(fs.realpathSync(source)) && projectsView.includes(fs.realpathSync(destination)) && projectsView.includes(REPOS),
      `${projectsView.split('\n').filter(Boolean).length} lines in the projects view`);

    const runs = fs.readFileSync(trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    report('verified projects really ran on the bundled Node, never on Electron',
      runs.length > 0 && runs.every((r) => r.electron === false && underPath(r.execPath, RUNTIME_NODE)),
      `${runs.length} instrumented executions`);
    report('no verifier child process was left behind', orphanVerifiers().length === 0);

    // Quit the app natively while a real verification is still running.
    const applied = snapshotRepo(destination);
    const filesBefore = digest(destination);
    const registryBefore = fs.readFileSync(path.join(home, 'graft-state/registry.json'), 'utf8');
    const tracedBefore = runs.length;
    await api.call('/api/verify', { slug: harvest.result.slug, projectId: dst.body.project.id, trusted: true });
    const quitAt = Date.now();
    quitNatively(app.pid);
    report('native Quit during a running verification still exits cleanly',
      await waitFor(() => !running(app.pid), { timeout: 120000, interval: 50, what: 'exit' }), `${Date.now() - quitAt} ms`);
    const afterRuns = fs.readFileSync(trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    report('quit waited for the verifier child that had already started',
      afterRuns.length > tracedBefore && afterRuns.at(-1).at >= quitAt - 2000, `${afterRuns.length - tracedBefore} further run(s)`);
    report('the shutdown lifecycle recorded a clean quit', fs.existsSync(path.join(home, 'quit.json')));
    report('no verifier child outlived the packaged app', orphanVerifiers().length === 0);
    report('the destination repository is exactly as the transplant left it',
      JSON.stringify(snapshotRepo(destination)) === JSON.stringify(applied));
    const filesAfter = digest(destination);
    const rewritten = Object.keys(filesBefore).filter((f) => filesAfter[f] !== filesBefore[f]);
    const added = Object.keys(filesAfter).filter((f) => !(f in filesBefore));
    report('no existing destination file was rewritten or truncated', rewritten.length === 0, rewritten.join(',') || 'none');
    report('any new file is a complete compatibility record from the finished run',
      added.every((f) => {
        if (!f.startsWith(path.join('.graft', 'compatibility') + path.sep) || !f.endsWith('.json')) return false;
        try { JSON.parse(fs.readFileSync(path.join(destination, f), 'utf8')); } catch { return false; }
        return true;
      }), added.join(',') || 'none');
    if (host.windows) skip('new compatibility records are owner-only (POSIX 0600)', 'POSIX modes do not exist on Windows; the record inherits the per-user profile ACL');
    else report('new compatibility records are owner-only (POSIX 0600)', added.every((f) => (fs.statSync(path.join(destination, f)).mode & 0o777) === 0o600));
    report('the local registry survived the interrupted quit intact',
      fs.readFileSync(path.join(home, 'graft-state/registry.json'), 'utf8') === registryBefore);

    await reopen(home, 'reopen after quit', { port: 9334 });
    await reopen(home, 'reopen with the licence service unreachable', { offline: true, port: 9335 });
    if (!judge) await privateBetaLifecycle();
  } finally {
    if (running(app.pid)) try { process.kill(app.pid, 9); } catch { /* already gone */ }
    if (app.log.length) fs.writeFileSync(path.join(home, 'app.log'), app.log.join(''));
    console.log(`\nEvidence kept in ${home}`);
  }
}

// Private Beta Program, deterministically: a fresh fixture home, the fixture's private-beta key, the
// fixture's `beta-expired` switch standing in for the service's authoritative expiry, and the
// fixture's feedback recorder standing in for the support relay. Three launches: end + Not now;
// ask again + failed send keeps the draft + retry succeeds; the simpler completed state afterwards.
async function privateBetaLifecycle() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-desktop-beta-'));
  const licence = (port, expression) => cdpEvaluate(port, 'license-ui', expression, { commandTimeout: 30000 });
  const quit = async (app, port) => {
    await cdpEvaluate(port, 'license-ui', 'window.graftDesktop.quit().catch(() => null), null').catch(() => cdpEvaluate(port, '127.0.0.1', 'window.graftDesktop.quit().catch(() => null), null').catch(() => {}));
    const exited = await waitFor(() => !running(app.pid), { timeout: 60000, what: 'exit' }).catch(() => false);
    if (!exited) try { process.kill(app.pid, 9); } catch { /* gone */ }
    return exited;
  };
  const start = async (port) => {
    const previous = (() => { try { return fs.statSync(path.join(home, 'startup.json')).mtimeMs; } catch { return 0; } })();
    const app = launch(home, port);
    await waitFor(() => { try { return fs.statSync(path.join(home, 'startup.json')).mtimeMs > previous; } catch { return false; } }, { timeout: 120000, what: 'a startup report' });
    await waitFor(() => licence(port, 'Boolean(document.querySelector("#license-view"))').catch(() => false), { timeout: 120000, what: 'the licence page' });
    return app;
  };
  const answers = { rating: 4, wouldUseAgain: 'maybe', usedFor: 'Carrying sign-in into a new portal', workedWell: 'Verification and the proof files', frustrated: 'Indexing a large workspace took a while' };
  const fill = (port) => licence(port, `(() => { const a = ${JSON.stringify(answers)}; for (const n of ['usedFor', 'workedWell', 'frustrated']) document.querySelector('#' + n).value = a[n]; document.querySelector('input[name="rating"][value="' + a.rating + '"]').checked = true; document.querySelector('input[name="wouldUseAgain"][value="' + a.wouldUseAgain + '"]').checked = true; return true; })()`);
  const view = (port) => licence(port, `({ betaVisible: !document.querySelector('#beta-view').hidden, licenceVisible: !document.querySelector('#license-view').hidden, title: document.querySelector('#beta-title').textContent, lead: document.querySelector('#beta-lead').textContent, formVisible: !document.querySelector('#feedback').hidden, doneVisible: !document.querySelector('#beta-done').hidden, doneMessage: document.querySelector('#beta-done-message').textContent, feedbackStatus: document.querySelector('#feedback-status').textContent, retryVisible: !document.querySelector('#retry-feedback').hidden, moreLabel: document.querySelector('#more-feedback').textContent, privacy: [...document.querySelectorAll('#feedback p.fine')].map((p) => p.textContent).join(' | ') })`);
  let app = null;
  try {
    // 1. Activate the private-beta key through the real form; the workspace opens.
    app = await start(9336);
    await licence(9336, `(() => { document.querySelector('#license-key').value = 'GRAFT-FIXTURE-BETA'; document.querySelector('#activation').requestSubmit(); return true; })()`);
    const activated = await waitFor(() => cdpEvaluate(9336, '127.0.0.1', 'window.graftDesktop.licenseStatus()', { commandTimeout: 5000 }).catch(() => null), { timeout: 120000, what: 'the workspace after beta activation' });
    report('private beta: a valid private-beta key activates and opens the workspace', activated?.allowed === true && activated?.licenseType === 'private_beta' && typeof activated?.expiresAt === 'number' && activated?.betaEnded === null, JSON.stringify({ allowed: activated?.allowed, type: activated?.licenseType }));
    report('private beta: before expiry the workspace never shows the end-of-beta experience', activated?.betaEnded === null);
    // 2. The term ends (authoritative 'expired' from the service double). The next validation ends the beta.
    fs.writeFileSync(path.join(home, 'beta-expired'), '');
    const ended = await cdpEvaluate(9336, '127.0.0.1', 'window.graftDesktop.validate()', { commandTimeout: 30000 }).catch((e) => ({ error: e.message }));
    report('private beta: the authoritative expired verdict ends the beta — not allowed, not activated, feedback requested', ended?.allowed === false && ended?.activated === false && ended?.betaEnded?.askForFeedback === true && ended?.betaEnded?.feedbackSubmitted === false, JSON.stringify(ended).slice(0, 300));
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'app-data/licensing/fixture-activation.json'), 'utf8')).record;
    report('private beta: the stored record is the ended state, not an activation record', stored?.betaEnded === true && stored?.verifiedAt === undefined && stored?.key === 'GRAFT-FIXTURE-BETA' && stored?.feedbackSubmittedAt === null);
    await waitFor(() => licence(9336, "!document.querySelector('#beta-view').hidden").catch(() => false), { timeout: 60000, what: 'the end-of-beta page' });
    const first = await view(9336);
    report('private beta: the licence page shows "GRAFT Private Beta Complete" with the feedback form, not a generic error', first.betaVisible && !first.licenceVisible && first.title === 'GRAFT Private Beta Complete' && first.lead === 'Your GRAFT private beta access has ended. Thanks for putting it through its paces.' && first.formVisible && !first.doneVisible, JSON.stringify(first).slice(0, 300));
    report('private beta: the privacy copy is visible on the form', first.privacy.includes('We’ll only send the responses you enter here plus basic GRAFT version and beta-license metadata. Your projects and source code are not included.'), first.privacy.slice(0, 200));
    const origin = readStartup(home).origin;
    const refused = await fetch(`${origin}/api/state`, { headers: { 'x-graft-token': await token(origin) } }).then((r) => r.status).catch((e) => e.message);
    report('private beta: after the end, licensed operations are refused by the workspace API', refused === 402, `HTTP ${refused}`);
    // Required fields: an empty form does not submit (reportValidity), so nothing is recorded.
    await licence(9336, "(document.querySelector('#send-feedback').click(), null)");
    await new Promise((r) => setTimeout(r, 800));
    report('private beta: the form enforces its required answers and the 1–5 rating before anything is sent', !fs.existsSync(path.join(home, 'feedback.json')) && (await licence(9336, "document.querySelector('#feedback').checkValidity()")) === false);
    // "Not now": the simpler view for this session; the draft of whatever was typed is kept.
    await licence(9336, "(document.querySelector('#usedFor').value = 'draft text', document.querySelector('#not-now').click(), null)");
    await new Promise((r) => setTimeout(r, 800));
    const dismissed = await view(9336);
    report('private beta: "Not now" leaves the ended state in place without nagging again this session', dismissed.betaVisible && !dismissed.formVisible && dismissed.doneVisible && dismissed.moreLabel === 'Send feedback' && dismissed.lead === 'Your GRAFT private beta access has ended.', JSON.stringify(dismissed).slice(0, 200));
    report('private beta: "Close GRAFT" quits cleanly from the end-of-beta page', await quit(app, 9336));
    // 3. Next launch: asked again (the service is asked once whether the term was extended; it still says expired).
    app = await start(9337);
    const relaunch = readStartup(home);
    report('private beta: the next launch restores the ended state and asks for feedback again', relaunch.license?.allowed === false && relaunch.license?.betaEnded?.askForFeedback === true, JSON.stringify(relaunch.license).slice(0, 200));
    await waitFor(() => licence(9337, "!document.querySelector('#feedback').hidden").catch(() => false), { timeout: 60000, what: 'the feedback form' });
    const kept = await licence(9337, "document.querySelector('#usedFor').value");
    report('private beta: the unsent draft was kept (encrypted store in production, fixture file here) and restored into the form', kept === 'draft text', JSON.stringify(kept));
    await fill(9337);
    fs.writeFileSync(path.join(home, 'feedback-fail'), '');
    await licence(9337, "(document.querySelector('#send-feedback').click(), null)");
    await waitFor(() => licence(9337, "!document.querySelector('#retry-feedback').hidden").catch(() => false), { timeout: 30000, what: 'the Retry control' });
    const failed = await view(9337);
    const draftFile = path.join(home, 'app-data/licensing/fixture-feedback-draft.json');
    report('private beta: a failed submission keeps the answers (draft saved), shows Retry, and does not pretend success', failed.formVisible && failed.retryVisible && /kept/.test(failed.feedbackStatus) && fs.existsSync(draftFile) && JSON.parse(fs.readFileSync(draftFile, 'utf8')).record.usedFor === answers.usedFor && !fs.existsSync(path.join(home, 'feedback.json')), failed.feedbackStatus);
    fs.rmSync(path.join(home, 'feedback-fail'));
    await licence(9337, "(document.querySelector('#retry-feedback').click(), null)");
    await waitFor(() => licence(9337, "!document.querySelector('#beta-done').hidden").catch(() => false), { timeout: 30000, what: 'the thank-you state' });
    const sent = await view(9337);
    const recorded = JSON.parse(fs.readFileSync(path.join(home, 'feedback.json'), 'utf8'));
    const payload = recorded[0] || {};
    report('private beta: Retry sends the feedback once; the page thanks the tester and offers Close GRAFT', recorded.length === 1 && sent.doneVisible && !sent.formVisible && sent.doneMessage === 'Thanks. Your feedback was sent.' && sent.moreLabel === 'Send more feedback', JSON.stringify(sent).slice(0, 200));
    report('private beta: only the answers and three client facts leave the app — no paths, projects, logs or environment', JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['at', 'client', 'key', 'responses']) && JSON.stringify(Object.keys(payload.client).sort()) === JSON.stringify(['arch', 'os', 'version']) && payload.responses.rating === 4 && payload.responses.usedFor === answers.usedFor && !JSON.stringify(payload).includes(home) && !JSON.stringify(payload).includes('GRAFT_'), JSON.stringify(payload).slice(0, 300));
    const afterSend = await licence(9337, 'window.graftDesktop.licenseStatus()');
    report('private beta: submitting feedback does not reactivate GRAFT and the draft is removed', afterSend?.allowed === false && afterSend?.betaEnded?.feedbackSubmitted === true && afterSend?.betaEnded?.askForFeedback === false && !fs.existsSync(draftFile), JSON.stringify(afterSend?.betaEnded));
    await quit(app, 9337);
    // 4. Later launches: the simpler completed state, no survey reopening.
    app = await start(9338);
    await waitFor(() => licence(9338, "!document.querySelector('#beta-view').hidden").catch(() => false), { timeout: 60000, what: 'the completed page' });
    const later = await view(9338);
    report('private beta: after a successful submission later launches show the simpler completed state, not the survey', later.betaVisible && later.doneVisible && !later.formVisible && later.lead === 'Your GRAFT private beta access has ended.' && later.moreLabel === 'Send more feedback' && readStartup(home).license?.betaEnded?.feedbackSubmitted === true, JSON.stringify(later).slice(0, 200));
    const reactivate = await licence(9338, "window.graftDesktop.activate('GRAFT-FIXTURE-BETA').then((v) => ({ allowed: v.allowed }), (e) => ({ error: e.message }))");
    report('private beta: the expired key cannot be activated again; the ended state stays', reactivate?.error === 'Your GRAFT private beta access has ended.' && (await licence(9338, 'window.graftDesktop.licenseStatus()'))?.betaEnded?.feedbackSubmitted === true, JSON.stringify(reactivate));
    // 5. The operator extends the term (the service double answers active again): Validate resumes on the same seat.
    fs.rmSync(path.join(home, 'beta-expired'));
    const resumed = await licence(9338, 'window.graftDesktop.validate()');
    report('private beta: an operator extension is picked up by Validate — same key, same seat, workspace back', resumed?.allowed === true && resumed?.betaEnded === null && resumed?.licenseType === 'private_beta', JSON.stringify({ allowed: resumed?.allowed, betaEnded: resumed?.betaEnded }));
    await waitFor(() => cdpEvaluate(9338, '127.0.0.1', "Boolean(document.querySelector('.sidebar'))", { commandTimeout: 4000 }).catch(() => false), { timeout: 120000, what: 'the workspace after the extension' }).catch(() => false);
    await quit(app, 9338);
  } finally {
    if (app && running(app.pid)) try { process.kill(app.pid, 9); } catch { /* gone */ }
    console.log(`Private-beta evidence kept in ${home}`);
  }
}

await main();
if (failures) { console.error(`\n${failures} packaged acceptance check(s) failed.`); process.exit(1); }
console.log('\nAll packaged acceptance checks passed.');
