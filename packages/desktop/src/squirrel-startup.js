// Squirrel.Windows launches the freshly installed, updated or uninstalled application once
// with a --squirrel-* argument and expects it to do its shortcut housekeeping and exit. This is
// the well-known electron-squirrel-startup behaviour, inlined so the client bundle carries no
// extra dependency. It is a no-op everywhere but a Squirrel-installed Windows build.

import path from 'node:path';
import { spawn } from 'node:child_process';

export function squirrelEvent(argv = process.argv, platform = process.platform) {
  if (platform !== 'win32') return null;
  const event = argv.find((arg) => arg.startsWith('--squirrel-'));
  return event || null;
}

// Update.exe lives one directory above the versioned app directory Squirrel runs us from.
// Windows path semantics are used explicitly: this code only ever acts on Windows paths.
export function updateExecutable(execPath = process.execPath) {
  return path.win32.resolve(path.win32.dirname(execPath), '..', 'Update.exe');
}

export function handleSquirrelStartup({ argv = process.argv, platform = process.platform, execPath = process.execPath, spawnImpl = spawn, quit } = {}) {
  const event = squirrelEvent(argv, platform);
  if (!event) return false;
  const exe = path.win32.basename(execPath);
  const run = (args) => new Promise((resolve) => {
    let child;
    try { child = spawnImpl(updateExecutable(execPath), args, { detached: true, stdio: 'ignore' }); }
    catch { return resolve(); }
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
  const finish = (work) => work.then(() => quit(), () => quit());
  switch (event) {
    case '--squirrel-install':
    case '--squirrel-updated':
      finish(run(['--createShortcut', exe])); return true;
    case '--squirrel-uninstall':
      finish(run(['--removeShortcut', exe])); return true;
    case '--squirrel-obsolete':
    case '--squirrel-firstrun':
    default:
      // firstrun is a normal launch; other events just need us to get out of the way.
      if (event === '--squirrel-firstrun') return false;
      quit(); return true;
  }
}
