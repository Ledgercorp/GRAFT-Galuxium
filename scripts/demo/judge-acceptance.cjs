// Reuse installed Electron/Chromium for a real browser flow; no additional E2E dependency.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(async () => {
  const urlIndex = process.argv.indexOf('--url');
  const publicUrl = urlIndex >= 0 ? process.argv[urlIndex + 1]?.replace(/\/$/, '') : null;
  if (urlIndex >= 0 && !/^https:\/\/[^/]+$/.test(publicUrl || '')) throw new Error('--url requires an HTTPS origin');
  const server = publicUrl ? null : (await import('./judge-preview.mjs')).previewServer();
  if (server) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const win = new BrowserWindow({ width: 1280, height: 1000, show: process.argv.includes('--headed'), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const origin = publicUrl || `http://127.0.0.1:${server.address().port}`;
  const evaluate = (s) => win.webContents.executeJavaScript(s);
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error(`Timed out: ${expression}; state=${await evaluate("JSON.stringify({active:document.activeElement.outerHTML,keys:window.testKeys,errors:window.testErrors})")}`);
  };
  let assertions = 0;
  const check = (condition, name) => { assert.ok(condition, name); assertions++; };
  try {
    await win.loadURL(origin);
    win.webContents.setZoomFactor(1);
    if (process.argv.includes('--headed')) { app.focus({ steal: true }); win.focus(); }
    await waitFor("!document.querySelector('#explorer').hidden");
    await evaluate("window.testKeys=[];window.testErrors=[];document.addEventListener('keydown',e=>window.testKeys.push(e.key));window.addEventListener('error',e=>window.testErrors.push(e.message))");
    check((await evaluate('document.body.innerText')).includes('hosted presentation / replay'), 'replay disclosure');
    await evaluate("document.querySelector('a[href=\"#demo\"]').click()");
    check((await evaluate('location.hash')) === '#demo', 'landing to demo');
    check((await evaluate("document.querySelector('#panel').innerText")).includes('Source verification'), 'source discovery and verification');
    // Native key input activates every stage button; focus moves to the panel after activation.
    for (const [view, expected] of [['find', 'Discovered capability'], ['fit', 'Actual destination diff'], ['prove', 'Read the boundary of VERIFIED'], ['evidence', 'Evidence identifiers']]) {
      await evaluate(`document.querySelector('[data-view="${view}"]').focus()`);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await waitFor(`document.querySelector('[data-view="${view}"]').getAttribute('aria-current') === 'step' && document.activeElement.id === 'panel'`);
      check((await evaluate("document.querySelector('#panel').innerText")).includes(expected), `${view} keyboard view`);
      check(await evaluate("document.activeElement.id === 'panel'"), `${view} focus destination`);
    }
    await evaluate("document.querySelector('[data-view=fit]').click()");
    check(await evaluate("document.querySelector('#diff-file').options.length === 6"), 'five generated files and entrypoint');
    await evaluate("const s=document.querySelector('#diff-file');s.selectedIndex=s.options.length-1;s.dispatchEvent(new Event('change'))");
    check((await evaluate("document.querySelector('#panel pre').textContent")).includes('registerAuthRoutes'), 'entrypoint diff');
    await evaluate("document.querySelector('[data-view=prove]').click()");
    check(await evaluate("document.querySelectorAll('.failed > summary').length === 2"), 'both optional failures visible');
    await evaluate("document.querySelector('summary').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor("document.querySelector('details').open");
    check((await evaluate("document.querySelector('details').innerText")).includes('HTTP 201'), 'keyboard assertion inspection');
    // Capture for visual review outside the public bundle.
    if (process.env.GRAFT_JUDGE_SCREENSHOTS) {
      fs.mkdirSync(process.env.GRAFT_JUDGE_SCREENSHOTS, { recursive: true });
      await evaluate('document.activeElement.blur();window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync(path.join(process.env.GRAFT_JUDGE_SCREENSHOTS, 'desktop.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(390, 844);
    for (const view of ['find', 'fit', 'prove', 'evidence']) {
      await evaluate(`document.querySelector('[data-view=${view}]').click()`);
      check(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `${view} mobile overflow`);
    }
    if (process.env.GRAFT_JUDGE_SCREENSHOTS) {
      await evaluate('document.activeElement.blur();window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      fs.writeFileSync(path.join(process.env.GRAFT_JUDGE_SCREENSHOTS, 'mobile.png'), (await win.webContents.capturePage()).toPNG());
    }
    await win.loadURL(origin + '/docs.html');
    check((await evaluate('document.body.innerText')).includes('Your repositories stay local'), 'docs route');
    // Intercept only the in-process preview response; never modify the committed evidence file.
    if (server) {
      const original = server.listeners('request')[0];
      for (const body of [null, '{invalid', JSON.stringify({ sha256: '0'.repeat(64), payload: {} })]) {
        server.removeAllListeners('request');
        server.on('request', (req, res) => {
          if (req.url !== '/evidence.json') return original(req, res);
          res.writeHead(body === null ? 404 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body || '');
        });
        await win.webContents.session.clearCache(); await win.loadURL(origin);
        await waitFor("document.querySelector('#load-status').getAttribute('role') === 'alert'");
        check(await evaluate("document.querySelector('#explorer').hidden"), 'missing/corrupt evidence fails closed');
      }
    }
    console.log(`PASS judge browser acceptance: ${assertions} assertions (${publicUrl ? 'production, ' : ''}desktop, keyboard, mobile${server ? ', missing/corrupt evidence' : ''})`);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { if (server) { server.closeAllConnections(); server.close(); } win.destroy(); }
});
