// Copied only into the explicitly named unsigned GRAFT Fixture artifact.
import fs from 'node:fs';
import path from 'node:path';
import { LicenseUnavailable } from './license-provider.js';
let home;
let chosenCount = 0;
export function configure(app) {
  if (!process.env.GRAFT_FIXTURE_HOME || !path.isAbsolute(process.env.GRAFT_FIXTURE_HOME)) throw new Error('The test candidate needs an explicit isolated fixture home.');
  home = process.env.GRAFT_FIXTURE_HOME;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(home, 'app-data'));
  process.env.GRAFT_HOME = path.join(home, 'graft-state');
}
/**
 * The fixture's licence store. A fixture build is disposable and its key is not a secret, so
 * the record is a plain JSON file inside the fixture home, stamped with the build it belongs to;
 * a record written by another fixture build is treated as absent (a fresh activation follows).
 * Production builds never import this module: they use Electron safeStorage and the real
 * licence service.
 */
export function store(directory, { build }) {
  const file = path.join(directory, 'fixture-activation.json');
  const installationFile = path.join(directory, 'fixture-installation.json');
  const draftFile = path.join(directory, 'fixture-feedback-draft.json');
  const read = (f) => { try { const value = JSON.parse(fs.readFileSync(f, 'utf8')); return value.build === build ? value.record : null; } catch { return null; } };
  const write = (f, record) => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify({ build, record }), { mode: 0o600 }); };
  return { read: async () => read(file), write: async (record) => write(file, record), clear: async () => fs.rmSync(file, { force: true }),
    readInstallation: async () => read(installationFile), writeInstallation: async (id) => write(installationFile, id),
    readDraft: async () => read(draftFile), writeDraft: async (draft) => write(draftFile, draft), clearDraft: async () => fs.rmSync(draftFile, { force: true }) };
}

/**
 * Keys: GRAFT-FIXTURE-VALID (perpetual purchase) and GRAFT-FIXTURE-BETA (a private-beta licence:
 * one seat, expiring 30 days after the fixture's fixed issue date). Deterministic expiry: a file
 * `beta-expired` in the fixture home makes the service answer 'expired' for the beta key, exactly
 * as the real service does once expiresAt has passed. Feedback: a file `feedback-fail` makes the
 * submission fail; otherwise every accepted submission is appended to `feedback.json`.
 */
export function provider() {
  const BETA_ISSUED = '2026-09-01T00:00:00.000Z', BETA_EXPIRES = '2026-10-01T00:00:00.000Z';
  const meta = { store_id: 101, product_id: 202, variant_id: 303 };
  function response(key, flag, instanceId) {
    if (key === 'GRAFT-FIXTURE-BETA') {
      const expired = fs.existsSync(path.join(home, 'beta-expired'));
      return { [flag]: !expired, error: expired ? 'This private beta license has expired.' : null,
        license_key: { key, status: expired ? 'expired' : 'active', expires_at: expired ? '2026-09-10T00:00:00.000Z' : BETA_EXPIRES, license_type: 'private_beta', issued_at: BETA_ISSUED },
        instance: { id: instanceId || 'graft-fixture-beta-instance' }, meta };
    }
    const invalid = key !== 'GRAFT-FIXTURE-VALID';
    return { [flag]: !invalid, error: invalid ? 'Invalid fixture key' : null,
      license_key: { key, status: invalid ? 'disabled' : 'active', expires_at: null, license_type: 'purchase', issued_at: null },
      instance: { id: instanceId || 'graft-fixture-instance' }, meta };
  }
  const online = () => { if (fs.existsSync(path.join(home, 'offline'))) throw new LicenseUnavailable('Fixture network outage.'); };
  return {
    activate: async (key) => { online(); return response(key, 'activated'); },
    validate: async (key, id) => { online(); return response(key, 'valid', id); },
    deactivate: async () => { online(); return { deactivated: true, error: null }; },
    feedback: async (key, payload) => {
      online();
      if (key !== 'GRAFT-FIXTURE-BETA') return { sent: false };
      if (fs.existsSync(path.join(home, 'feedback-fail'))) throw new LicenseUnavailable('Fixture feedback outage.');
      const file = path.join(home, 'feedback.json');
      const list = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } })();
      list.push({ at: new Date().toISOString(), key, ...payload });
      fs.writeFileSync(file, JSON.stringify(list, null, 2));
      return { sent: true };
    },
  };
}
/** The fixture answers the native save dialog from GRAFT_FIXTURE_SAVE (a folder: the suggested name is used there; a .zip path: used as is). */
export async function chooseSavePath(dialog, win, suggestion) {
  const chosen = process.env.GRAFT_FIXTURE_SAVE;
  if (chosen && path.isAbsolute(chosen)) return { canceled: false, filePath: chosen.toLowerCase().endsWith('.zip') ? chosen : path.join(chosen, suggestion) };
  return dialog.showSaveDialog(win, { title: 'Save capability package', defaultPath: suggestion, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
}

export async function chooseProject(dialog, win, title = 'Choose a local repository') {
  // Native dialogs cannot be scripted. The fixture artifact alone may answer "Choose a folder"
  // from GRAFT_FIXTURE_CHOOSE, exactly as a person picking that folder would; the product
  // still validates the path like any other. Unset, the real dialog opens.
  // Several folders may be listed (path.delimiter-separated); each call answers with the next one.
  const queue = (process.env.GRAFT_FIXTURE_CHOOSE || '').split(path.delimiter).filter((p) => p && path.isAbsolute(p));
  if (queue.length) { const chosen = queue[chosenCount % queue.length]; chosenCount += 1; return { canceled: false, filePaths: [chosen] }; }
  return dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
}
export async function run({ app, win, dashboard, runtime, licensing }) {
  const rendererBoundary = await win.webContents.executeJavaScript('({ require: typeof require, process: typeof process, Buffer: typeof Buffer, bridge: Object.keys(window.graftDesktop || {}).sort() })');
  // Exercise the installed navigation listener without fetching remote content.
  let navigationRefused = false;
  win.webContents.emit('will-navigate', { preventDefault() { navigationRefused = true; } }, 'https://example.invalid/');
  const { Menu } = await import('electron');
  const menu = (Menu.getApplicationMenu()?.items || []).map((item) => ({ label: item.label,
    submenu: (item.submenu?.items || []).map((entry) => ({ label: entry.label, role: entry.role || null, enabled: entry.enabled })) }));
  const report = { packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath(), runtime,
    rendererBoundary, navigationRefused, menu,
    pid: process.pid, origin: dashboard.origin, license: licensing.status(), renderer: win.webContents.getLastWebPreferences() };
  fs.writeFileSync(path.join(home, 'startup.json'), JSON.stringify(report, null, 2));
  app.on('will-quit', () => fs.writeFileSync(path.join(home, 'quit.json'), JSON.stringify({ clean: true, at: new Date().toISOString() })));
}
export function fail(err) {
  if (home) fs.writeFileSync(path.join(home, 'error.txt'), err.stack);
}
