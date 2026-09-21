// The "working result" scene of the continuous public-demo recording: a plain Electron browser window
// (the bare `electron` binary from node_modules, no GRAFT code) placed exactly over the recorded region,
// showing the finalized application's real HTTP responses — anonymous session refused, sign-in through
// the deterministic provider stand-in, session established. Nothing is rendered but what the finalized
// application actually answers. Args: <bounds.json> <base URL> <hold ms per page>.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [boundsFile, base, holdArg] = process.argv.slice(2);
// When each page finished loading, for the recorder's cut (next to the bounds file).
const pagesFile = path.join(path.dirname(boundsFile), 'viewer-pages.json');
const pages = [];
const hold = Number(holdArg) || 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light';
  const b = JSON.parse(fs.readFileSync(boundsFile, 'utf8'));
  const win = new BrowserWindow({ x: b.x, y: b.y, width: b.w, height: b.h, title: 'Client portal', backgroundColor: '#ffffff', webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.setMenuBarVisibility(false);
  win.webContents.on('page-title-updated', (e) => e.preventDefault());
  const show = async (route) => {
    win.setTitle(`${base}${route}`);
    await win.loadURL(`${base}${route}`).catch(() => {});
    win.webContents.setZoomFactor(2);
    pages.push({ route, loadedAt: new Date().toISOString(), finalUrl: win.webContents.getURL().replace(/:\d+\//, ':<port>/') });
    fs.writeFileSync(pagesFile, JSON.stringify(pages, null, 2));
    await sleep(hold);
  };
  await show('/api/session');   // before sign-in: refused
  await show('/auth/login');    // sign-in → provider stand-in → back to the application
  await show('/api/session');   // after sign-in: the session
  app.quit();
});
