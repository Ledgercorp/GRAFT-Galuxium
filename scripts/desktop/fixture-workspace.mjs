// Disposable repositories for native packaged-app acceptance, never user state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describePlatform } from '../../packages/desktop/src/platform.js';
const host = describePlatform();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-desktop-final-'));
const trace = path.join(home, 'runtime-execution.jsonl');
for (const [name, fixture, entry, esm] of [
  ['source', 'old-saas-project', 'server.js', false],
  ['destination', 'new-startup', 'src/main.js', true],
]) {
  const root = path.join(home, 'repos', name);
  fs.cpSync(path.resolve('fixtures', fixture), root, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
  const file = path.join(root, entry);
  const instrumentation = `${esm ? "(await import('node:fs'))" : "require('node:fs')"}.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({project:${JSON.stringify(name)}, pid:process.pid, execPath:process.execPath, node:process.versions.node, electron:!!process.versions.electron, at:Date.now()})+'\\n');\n`;
  fs.writeFileSync(file, instrumentation + fs.readFileSync(file, 'utf8'));
  for (const args of [['init', '-qb', 'main'], ['add', '-A'], ['-c', 'user.name=GRAFT Desktop Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Disposable desktop acceptance baseline']]) {
    execFileSync(host.git, args, { cwd: root, stdio: 'pipe' });
  }
}
console.log(home);
