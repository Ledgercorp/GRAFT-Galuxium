import { app, BrowserWindow, Menu, dialog, ipcMain, shell, safeStorage, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startDashboard } from '../../web/src/server.js';
import { initializeNodeRuntime } from './node-runtime.js';
import { createLicenseService } from './license-service.js';
import { graftLicenseProvider } from './license-provider.js';
import { encryptedLicenseStore } from './license-store.js';
import { allowedPage, trustedSender, safeExternalUrl } from './security.js';
import { describePlatform, applicationMenu } from './platform.js';
import { handleSquirrelStartup } from './squirrel-startup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, '../config/product.json'), 'utf8'));
const licenseUrl = pathToFileURL(path.join(here, '../license-ui/index.html')).href;
let win, dashboard, licensing, fixture, quitting = false, quitTask;
const host = describePlatform();
// A production app never accepts an environment override for its state or license provider.
process.env.GRAFT_HOME = path.join(os.homedir(), '.graft');
if (config.testBuild) {
  fixture = await import('./test-fixture.js');
  fixture.configure(app);
}
app.enableSandbox();
// A Squirrel.Windows install/update/uninstall launch only does shortcut housekeeping and exits.
if (handleSquirrelStartup({ quit: () => app.quit() })) { /* exiting */ }
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitTask ||= (async () => {
      if (win && !win.isDestroyed()) win.setTitle('GRAFT — Finishing the current operation…');
      try { if (dashboard) await dashboard.close(); }
      catch { dialog.showErrorBox('GRAFT could not finish closing', 'Check your project recovery receipt before restarting.'); }
      quitting = true; app.quit();
    })();
  });
  app.on('window-all-closed', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  process.on('SIGINT', () => app.quit());
  app.whenReady().then(async () => {
  try {
    const runtime = initializeNodeRuntime(app.isPackaged ? process.resourcesPath : path.resolve(here, '../../../.desktop-build'));
    // Git remains the system's repository tool; diagnose it before any project mutation.
    try { execFileSync(host.git, ['--version'], { timeout: 10000, stdio: 'pipe' }); }
    catch { throw new Error(host.gitHint); }
    // Plain-HTTP loopback is tolerated only in a test build; the signing gate refuses test builds, so a shipped app is HTTPS-only.
    licensing = createLicenseService({ provider: fixture ? fixture.provider() : graftLicenseProvider({ baseUrl: config.licenseApiBase, allowInsecureLoopback: Boolean(config.testBuild) }),
      // A fixture build keeps its (non-secret) licence in a build-stamped file so rebuilding
      // the fixture never strands a keychain-encrypted record; production is unchanged.
      store: fixture ? fixture.store(path.join(app.getPath('userData'), 'licensing'), { build: `fixture:${config.fixtureBuildId || app.getVersion()}` })
        : encryptedLicenseStore(path.join(app.getPath('userData'), 'licensing'), safeStorage), config, installationName: host.installationName });
    await licensing.initialize();
    dashboard = await startDashboard({ port: 0, authorize: () => licensing.canUse() });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({ width: 1180, height: 820, minWidth: 850, minHeight: 620, title: 'GRAFT', show: false,
      webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, devTools: Boolean(config.testBuild) } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) win.webContents.on(event, (e, url) => {
      if (!allowedPage(url, dashboard.origin, licenseUrl)) e.preventDefault();
    });
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    const licensePage = () => win.loadURL(licenseUrl);
    const workspace = () => win.loadURL(dashboard.origin);
    const handle = (channel, callback) => ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event, win.webContents, dashboard.origin, licenseUrl)) return { ok: false, error: 'Unauthorized desktop request.' };
      try { return { ok: true, value: await callback(...args) }; } catch (err) { if (fixture && err.cause) console.error('License persistence:', err.cause.message); return { ok: false, error: err.message }; }
    });
    handle('graft:version', () => ({ version: app.getVersion(), testBuild: config.testBuild, purchaseEnabled: Boolean(safeExternalUrl(config.purchaseUrl)), inviteOnly: config.inviteOnly === true, supportEnabled: Boolean(supportAddress()) }));
    handle('graft:license-status', () => licensing.status());
    handle('graft:activate', async (key) => { const value = await licensing.activate(key); scheduleBetaEnd(value); setImmediate(workspace); return value; });
    handle('graft:validate', async () => { const value = await licensing.validate(); scheduleBetaEnd(value); setImmediate(value.allowed ? workspace : licensePage); return value; });
    handle('graft:deactivate', async () => { const value = await licensing.deactivate(); setImmediate(licensePage); return value; });
    // Private Beta Program (end of beta). The renderer supplies answers only; the main process adds
    // the three client facts and the service adds the licence identity. Nothing else leaves the machine.
    const supportAddress = () => (typeof config.supportEmail === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.supportEmail) ? config.supportEmail : null);
    const feedbackShape = (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Feedback answers are required.');
      const out = {};
      for (const [name, raw] of Object.entries(value)) {
        if (!['rating', 'wouldUseAgain', 'usedFor', 'workedWell', 'frustrated', 'worthPaying', 'missingFeature', 'anythingElse'].includes(name)) continue;
        if (name === 'rating') { if (!Number.isInteger(raw) || raw < 1 || raw > 5) throw new Error('Choose a rating from 1 to 5.'); out.rating = raw; continue; }
        if (typeof raw !== 'string') continue;
        if (raw.length > 2000) throw new Error('Keep each answer under 2000 characters.');
        out[name] = raw;
      }
      return out;
    };
    const client = () => ({ version: app.getVersion(), os: `${process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()}`, arch: process.arch });
    handle('graft:feedback', async (answers) => licensing.feedback(feedbackShape(answers), client()));
    handle('graft:feedback-dismiss', async () => licensing.dismissFeedback());
    handle('graft:feedback-draft', async () => { try { return (await licensing.readDraft()) || null; } catch { return null; } });
    handle('graft:feedback-draft-save', async (answers) => { await licensing.writeDraft(feedbackShape(answers)); return true; });
    handle('graft:feedback-draft-clear', async () => { await licensing.clearDraft(); return true; });
    handle('graft:contact-support', async () => { const address = supportAddress(); if (!address) throw new Error('Support contact is not configured in this build.'); await shell.openExternal(`mailto:${address}?subject=${encodeURIComponent('GRAFT private beta')}`); });
    handle('graft:quit', async () => { quitting = true; app.quit(); });
    handle('graft:buy', async () => { const url = safeExternalUrl(config.purchaseUrl); if (!url) throw new Error('Purchasing is not available in this build.'); await shell.openExternal(url); });
    // Opening or revealing a transplant worktree: only paths beneath GRAFT's own worktrees
    // directory are ever handed to the shell, resolved through realpath first.
    const worktreeRoot = () => { const dir = path.join(process.env.GRAFT_HOME, 'worktrees'); try { return fs.realpathSync(dir); } catch { return null; } };
    const managedPath = (value) => {
      if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('A worktree path is required.');
      const root = worktreeRoot();
      let real; try { real = fs.realpathSync(value); } catch { throw new Error('That worktree no longer exists.'); }
      if (!root || (real !== root && !real.startsWith(root + path.sep))) throw new Error('GRAFT opens only the transplant worktrees it created.');
      return real;
    };
    handle('graft:open-path', async (value) => { if (!licensing.canUse()) throw new Error('Activate GRAFT first.'); const real = managedPath(value); const error = await shell.openPath(real); if (error) throw new Error(error); return real; });
    // Paths the person chose in this app's own save dialog may be revealed afterwards; nothing else.
    const savedPaths = new Set();
    handle('graft:reveal-path', async (value) => {
      if (!licensing.canUse()) throw new Error('Activate GRAFT first.');
      let real = null;
      if (typeof value === 'string' && path.isAbsolute(value)) { try { real = fs.realpathSync(value); } catch { real = null; } }
      if (real && savedPaths.has(real)) { shell.showItemInFolder(real); return real; }
      const managed = managedPath(value); shell.showItemInFolder(managed); return managed;
    });
    handle('graft:choose-save-path', async (suggestion) => {
      if (!licensing.canUse()) throw new Error('Activate GRAFT first.');
      const name = typeof suggestion === 'string' && /^[a-z0-9][a-z0-9-]{0,60}\.zip$/.test(suggestion) ? suggestion : 'capability.zip';
      const result = fixture ? await fixture.chooseSavePath(dialog, win, name) : await dialog.showSaveDialog(win, { title: 'Save capability package', defaultPath: path.join(app.getPath('downloads'), name), filters: [{ name: 'ZIP archive', extensions: ['zip'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (result.canceled || !result.filePath) return null;
      const chosen = path.resolve(result.filePath);
      const target = chosen.toLowerCase().endsWith('.zip') ? chosen : `${chosen}.zip`;
      // Remember the file's would-be real path so Reveal works once it exists.
      try { savedPaths.add(path.join(fs.realpathSync(path.dirname(target)), path.basename(target))); } catch { /* the export validates the folder itself */ }
      return target;
    });
    handle('graft:choose-project', async () => {
      if (!licensing.canUse()) throw new Error('Activate GRAFT first.');
      const result = fixture ? await fixture.chooseProject(dialog, win) : await dialog.showOpenDialog(win, { title: 'Choose a local repository', properties: ['openDirectory'] });
      return result.canceled ? null : fs.realpathSync(result.filePaths[0]);
    });
    // Commercial Beta 0.1: a plain folder choice for exports (proofs, diagnostics) — the same native
    // dialog, a purpose-specific title, and a path the product still validates like any other.
    handle('graft:choose-folder', async (purpose) => {
      if (!licensing.canUse()) throw new Error('Activate GRAFT first.');
      const title = purpose === 'proofs' ? 'Choose a folder for the proof files' : purpose === 'diagnostics' ? 'Choose a folder for the diagnostic bundle' : 'Choose a folder';
      const result = fixture ? await fixture.chooseProject(dialog, win, title) : await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled || !result.filePaths?.[0]) return null;
      const real = fs.realpathSync(result.filePaths[0]);
      savedPaths.add(real);
      return real;
    });
    app.setAboutPanelOptions({ applicationName: 'GRAFT', applicationVersion: app.getVersion(), version: config.testBuild ? 'Deterministic test candidate' : 'Desktop distribution candidate', copyright: 'GRAFT' });
    Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenu(host, {
      license: licensePage, downloadEnabled: Boolean(safeExternalUrl(config.downloadUrl)), download: () => shell.openExternal(safeExternalUrl(config.downloadUrl)) })));
    await (licensing.canUse() ? workspace() : licensePage());
    win.show();
    // A background revalidation must never leave an unhandled rejection or a window that
    // silently keeps working; any failure here closes the workspace back to the licence page.
    const revalidate = () => licensing.validate().catch(() => ({ allowed: false }))
      .then((status) => { scheduleBetaEnd(status); return status.allowed || quitting || !win || win.isDestroyed() ? null : licensePage(); })
      .catch((err) => console.error('License revalidation:', err.message));
    const timer = setInterval(revalidate, 24 * 60 * 60 * 1000);
    timer.unref();
    // A private-beta term that ends while GRAFT is open: the workspace API already refuses new
    // licensed operations the moment expiresAt passes (licensing.canUse()); at that same moment a
    // revalidation confirms the verdict with the service and the window returns to the licence
    // page, where the end-of-beta experience is. Running server-side work (an assembly, a
    // verification) is not interrupted and nothing on disk is touched.
    let betaTimer = null;
    function scheduleBetaEnd(status) {
      if (betaTimer) { clearTimeout(betaTimer); betaTimer = null; }
      if (status?.licenseType !== 'private_beta' || !Number.isFinite(status.expiresAt)) return;
      const delay = Math.min(Math.max(status.expiresAt - Date.now() + 1500, 1000), 2147483647);
      betaTimer = setTimeout(revalidate, delay); betaTimer.unref();
    }
    scheduleBetaEnd(licensing.status());
    if (fixture) await fixture.run({ app, win, dashboard, runtime, licensing });
  } catch (err) {
    if (fixture) fixture.fail(err);
    else dialog.showErrorBox('GRAFT could not start', err.message);
    app.quit();
  }
  });
}
