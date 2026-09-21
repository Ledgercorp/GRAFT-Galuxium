import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describePlatform, applicationMenu, SUPPORTED } from '../src/platform.js';
import { handleSquirrelStartup, squirrelEvent, updateExecutable } from '../src/squirrel-startup.js';
import { initializeNodeRuntime, RUNTIME_NODE_VERSION } from '../src/node-runtime.js';
import { createLicenseService } from '../src/license-service.js';

test('exactly two commercial targets are supported and everything else is refused up front', () => {
  assert.deepEqual(Object.keys(SUPPORTED).sort(), ['darwin-arm64', 'win32-x64']);
  const mac = describePlatform('darwin', 'arm64'), win = describePlatform('win32', 'x64');
  assert.equal(mac.macos, true); assert.equal(mac.windows, false); assert.equal(win.windows, true);
  assert.deepEqual(mac.nodeExecutable, ['bin', 'node']); assert.deepEqual(win.nodeExecutable, ['node.exe']);
  assert.equal(mac.git, '/usr/bin/git'); assert.equal(win.git, 'git');
  assert.match(win.gitHint, /Git for Windows/); assert.match(mac.gitHint, /Command Line Tools/);
  assert.equal(mac.installationName, 'GRAFT desktop (macOS)'); assert.equal(win.installationName, 'GRAFT desktop (Windows)');
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['win32', 'ia32'], ['linux', 'x64']]) assert.throws(() => describePlatform(platform, arch), /supports Apple Silicon macOS and 64-bit Windows/);
});

test('the native menu keeps About, License and Quit on both platforms and uses only roles the platform has', () => {
  const opts = { license: () => {}, download: () => {}, downloadEnabled: false };
  for (const host of [describePlatform('darwin', 'arm64'), describePlatform('win32', 'x64')]) {
    const menu = applicationMenu(host, opts);
    const app = menu.find((m) => m.label === 'GRAFT').submenu;
    assert.ok(app.some((i) => i.role === 'about') && app.some((i) => i.label === 'License…') && app.some((i) => i.role === 'quit'));
    const roles = menu.flatMap((m) => m.submenu.map((i) => i.role)).filter(Boolean);
    if (host.windows) for (const macOnly of ['hide', 'hideOthers', 'unhide', 'zoom']) assert.equal(roles.includes(macOnly), false, macOnly);
    else assert.ok(roles.includes('hide') && roles.includes('zoom'));
    assert.deepEqual(menu.map((m) => m.label), ['GRAFT', 'Edit', 'Window', 'Help']);
  }
});

test('Squirrel.Windows lifecycle launches do shortcut housekeeping through Update.exe and exit; normal launches proceed', async () => {
  const exec = 'C:\\Users\\u\\AppData\\Local\\GRAFT\\app-0.5.0\\GRAFT.exe';
  assert.equal(path.win32.basename(updateExecutable(exec)), 'Update.exe');
  const calls = [];
  const spawnImpl = (file, args) => { calls.push({ file, args }); return { on: (event, cb) => { if (event === 'close') setImmediate(cb); } }; };
  for (const [event, expected] of [['--squirrel-install', '--createShortcut'], ['--squirrel-updated', '--createShortcut'], ['--squirrel-uninstall', '--removeShortcut']]) {
    calls.length = 0; let quit = 0;
    const handled = handleSquirrelStartup({ argv: ['GRAFT.exe', event], platform: 'win32', execPath: exec, spawnImpl, quit: () => { quit += 1; } });
    assert.equal(handled, true, event);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, [expected, 'GRAFT.exe']); assert.ok(calls[0].file.endsWith('Update.exe'));
    assert.equal(quit, 1, `${event} must quit`);
  }
  let quit = 0; calls.length = 0;
  assert.equal(handleSquirrelStartup({ argv: ['GRAFT.exe', '--squirrel-obsolete'], platform: 'win32', execPath: exec, spawnImpl, quit: () => { quit += 1; } }), true);
  assert.equal(quit, 1); assert.equal(calls.length, 0);
  // First run after install and ordinary launches are NOT intercepted; nothing on macOS ever is.
  assert.equal(handleSquirrelStartup({ argv: ['GRAFT.exe', '--squirrel-firstrun'], platform: 'win32', execPath: exec, spawnImpl, quit: () => { throw new Error('must not quit'); } }), false);
  assert.equal(handleSquirrelStartup({ argv: ['GRAFT.exe'], platform: 'win32', execPath: exec, spawnImpl, quit: () => { throw new Error('must not quit'); } }), false);
  assert.equal(handleSquirrelStartup({ argv: ['GRAFT', '--squirrel-install'], platform: 'darwin', spawnImpl, quit: () => { throw new Error('must not quit'); } }), false);
  assert.equal(squirrelEvent(['x', '--squirrel-updated'], 'win32'), '--squirrel-updated');
  // A missing Update.exe (spawn throws) still exits rather than hanging the installer.
  let quit2 = 0;
  handleSquirrelStartup({ argv: ['GRAFT.exe', '--squirrel-install'], platform: 'win32', execPath: exec, spawnImpl: () => { throw new Error('ENOENT'); }, quit: () => { quit2 += 1; } });
  await new Promise((r) => setTimeout(r, 10)); assert.equal(quit2, 1);
});

test('the bundled runtime must match the host platform and CPU exactly, on both platforms', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-runtime-platform-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'resources'); fs.mkdirSync(path.join(resources, 'runtime', 'bin'), { recursive: true });
  const manifest = (m) => fs.writeFileSync(path.join(resources, 'runtime', 'runtime.json'), JSON.stringify(m));
  manifest({ version: RUNTIME_NODE_VERSION, platform: 'darwin', arch: 'arm64' });
  assert.throws(() => initializeNodeRuntime(resources, 'x64', 'win32'), /does not match this desktop build/, 'a macOS runtime in a Windows build');
  manifest({ version: RUNTIME_NODE_VERSION, platform: 'win32', arch: 'x64' });
  assert.throws(() => initializeNodeRuntime(resources, 'arm64', 'darwin'), /does not match this desktop build/, 'a Windows runtime in a macOS build');
  manifest({ version: '22.0.0', platform: 'win32', arch: 'x64' });
  assert.throws(() => initializeNodeRuntime(resources, 'x64', 'win32'), /does not match this desktop build/, 'wrong pinned version');
  assert.throws(() => initializeNodeRuntime(resources, 'x64', 'linux'), /supports Apple Silicon macOS and 64-bit Windows/);
  // A matching Windows manifest proceeds to look for node.exe (absent here), never bin/node.
  manifest({ version: RUNTIME_NODE_VERSION, platform: 'win32', arch: 'x64' });
  assert.throws(() => initializeNodeRuntime(resources, 'x64', 'win32'), /ENOENT|escapes|absolute/);
});

test('the activation sent by a Windows installation is labelled Windows, while identity stays the installation id', async () => {
  let record = null, installation = null; const sent = [];
  const store = { read: async () => record, write: async (v) => { record = v; }, clear: async () => { record = null; }, readInstallation: async () => installation, writeInstallation: async (id) => { installation = id; } };
  const valid = (flag) => ({ [flag]: true, error: null, license_key: { key: 'GRAFT-TEST-KEY-1', status: 'active', expires_at: null }, instance: { id: 'i' }, meta: { store_id: 1, product_id: 1, variant_id: 1 } });
  const provider = { validate: async () => valid('valid'), activate: async (_k, installation) => { sent.push(installation); return valid('activated'); }, deactivate: async () => ({ deactivated: true, error: null }) };
  const config = { storeId: 1, productId: 1, variantIds: [1], offlineDays: 30 };
  await createLicenseService({ provider, store, config, installationName: describePlatform('win32', 'x64').installationName }).activate('GRAFT-TEST-KEY-1');
  assert.equal(sent[0].name, 'GRAFT desktop (Windows)'); assert.match(sent[0].installationId, /^[0-9a-f-]{36}$/);
  assert.equal(installation, sent[0].installationId);
});
