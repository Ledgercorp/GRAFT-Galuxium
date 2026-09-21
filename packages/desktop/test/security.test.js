import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { allowedPage, trustedSender, safeExternalUrl } from '../src/security.js';
import { encryptedLicenseStore } from '../src/license-store.js';
import { startDashboard } from '../../web/src/server.js';

test('navigation and IPC accept only the exact application main frame', () => {
  const origin = 'http://127.0.0.1:45678', license = 'file:///app/license.html';
  for (const url of [origin, origin + '/#projects', license]) assert.equal(allowedPage(url, origin, license), true);
  for (const url of ['https://evil.test/', 'file:///etc/passwd', origin + '/app.js', origin + '/?x=1', 'javascript:alert(1)', license + '?x']) assert.equal(allowedPage(url, origin, license), false);
  const contents = { mainFrame: { url: origin + '/' } };
  assert.equal(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents, origin, license), true);
  assert.equal(trustedSender({ sender: contents, senderFrame: { url: origin } }, contents, origin, license), false);
  for (const url of ['http://example.com', 'file:///etc/passwd', 'https://user:pass@example.com', 'javascript:1']) assert.equal(safeExternalUrl(url), null);
  assert.equal(safeExternalUrl('https://example.com/buy'), 'https://example.com/buy');
});
test('encrypted license storage uses private files, rejects links, and never changes project files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-license-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project.js'); fs.writeFileSync(project, 'original project');
  const crypto = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s) => Buffer.from(s).reverse(), decryptStringAsync: async (b) => ({ result: Buffer.from(b).reverse().toString() }) };
  const dir = path.join(root, 'licensing'), store = encryptedLicenseStore(dir, crypto);
  await store.write({ key: 'private-key' }); assert.deepEqual(await store.read(), { key: 'private-key' });
  if (process.platform !== 'win32') { assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.equal(fs.statSync(path.join(dir, 'activation.bin')).mode & 0o777, 0o600); } // no POSIX modes on Windows
  await store.clear(); fs.symlinkSync(project, path.join(dir, 'activation.bin')); await assert.rejects(store.read()); await store.clear();
  assert.equal(fs.readFileSync(project, 'utf8'), 'original project');
});
test('desktop server authorization is enforced below the renderer', async (t) => {
  const app = await startDashboard({ port: 0, authorize: () => false }); t.after(() => app.close());
  const html = await (await fetch(app.origin)).text(), token = /name="graft-token" content="([a-f0-9]+)"/.exec(html)[1];
  for (const route of ['state', 'projects', 'samples', 'harvest', 'plan', 'apply', 'verify']) {
    const response = await fetch(`${app.origin}/api/${route}`, { headers: { 'X-Graft-Token': token } }); assert.equal(response.status, 402);
  }
});
test('a stuck keychain times out and late encryption cannot write an activation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-keychain-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unavailable = encryptedLicenseStore(path.join(root, 'unavailable'), {
    isAsyncEncryptionAvailable: () => new Promise(() => {}),
  }, { timeoutMs: 5 });
  await assert.rejects(unavailable.write({ key: 'fixture' }), /timed out/);
  let finish;
  const delayed = encryptedLicenseStore(path.join(root, 'delayed'), {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: () => new Promise((resolve) => { finish = resolve; }),
  }, { timeoutMs: 5 });
  await assert.rejects(delayed.write({ key: 'fixture' }), /timed out/);
  finish(Buffer.from('late encrypted data'));
  await new Promise(setImmediate);
  assert.deepEqual(fs.readdirSync(path.join(root, 'delayed')), []);
});
test('runtime abstraction preserves -- and rejects resources that escape through symlinks', () => {
  const script = `import assert from 'node:assert/strict'; import {nodeCommand} from './packages/core/src/verify/runtime.js'; import {configureNodeExecutable} from './packages/core/src/verify/executable.js'; assert.deepEqual(nodeCommand('-file'),[process.execPath,'--','-file']); assert.throws(()=>configureNodeExecutable(process.execPath,'/tmp'));`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', script]);
});

test('runtime directory symlink cannot escape packaged resources', async (t) => {
  const { initializeNodeRuntime } = await import('../src/node-runtime.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-runtime-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources'), elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(resources); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, path.join(resources, 'runtime'));
  assert.throws(() => initializeNodeRuntime(resources), /escapes packaged resources/);
  fs.unlinkSync(path.join(resources, 'runtime')); assert.throws(() => initializeNodeRuntime(resources), /ENOENT/);
});
