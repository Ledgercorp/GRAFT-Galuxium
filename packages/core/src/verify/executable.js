import fs from 'node:fs';
import path from 'node:path';

let configured;

/** Called by the trusted desktop main process before any project execution. */
export function configureNodeExecutable(executable, resourceRoot) {
  if (!path.isAbsolute(executable) || !path.isAbsolute(resourceRoot)) throw new Error('Node runtime paths must be absolute.');
  const root = fs.realpathSync(resourceRoot);
  const real = fs.realpathSync(executable);
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) throw new Error('Node runtime escapes its resource directory.');
  fs.accessSync(real, fs.constants.X_OK);
  if (configured && configured !== real) throw new Error('Node runtime is already configured.');
  configured = real;
  return real;
}

export function nodeExecutable() {
  if (configured) return configured;
  if (process.versions.electron) throw new Error('Desktop Node runtime was not configured. Project execution is unavailable.');
  return process.execPath;
}
