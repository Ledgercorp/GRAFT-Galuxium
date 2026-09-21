import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configureNodeExecutable } from '../../core/src/verify/executable.js';
import { controlledEnv } from '../../core/src/verify/http-runner.js';
import { describePlatform } from './platform.js';

export const RUNTIME_NODE_VERSION = '24.21.0';

export function initializeNodeRuntime(resources, arch = process.arch, platform = process.platform) {
  // Containment is checked first and on every platform: a runtime directory that escapes the
  // packaged resources is refused before anything about the host is even considered.
  const realResources = fs.realpathSync(resources);
  const root = fs.realpathSync(path.join(realResources, 'runtime'));
  if (!root.startsWith(realResources + path.sep)) throw new Error('Node runtime escapes packaged resources.');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json'), 'utf8'));
  const host = describePlatform(platform, arch);
  // The runtime must be the pinned version built for exactly this OS and CPU.
  if (manifest.version !== RUNTIME_NODE_VERSION || manifest.platform !== host.platform || manifest.arch !== host.arch) throw new Error('The bundled Node runtime does not match this desktop build.');
  const executable = configureNodeExecutable(path.join(root, ...host.nodeExecutable), root);
  const actual = JSON.parse(execFileSync(executable, ['--eval', 'console.log(JSON.stringify({version:process.versions.node,arch:process.arch,electron:!!process.versions.electron}))'], {
    env: controlledEnv(), timeout: 10000, encoding: 'utf8', maxBuffer: 4096,
  }));
  if (actual.version !== manifest.version || actual.arch !== manifest.arch || actual.electron) throw new Error('The bundled executable is not the expected standalone Node runtime.');
  return { executable, ...actual };
}
