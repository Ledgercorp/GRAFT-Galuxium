// Persistence for the Workspace Capability Index.
//
// The index is a derived artifact: it can always be rebuilt by rescanning, so the storage
// job is to be small, atomic, legible and safe to delete. A single versioned JSON document
// matches the measured scale (a handful of projects, a few hundred files) — a database here
// would be complexity without evidence.
//
// Never stored: environment variable VALUES, secrets, credentials, source text, or remote
// URLs with credentials in them. Only names, shapes, counts and digests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { graftHome } from '../registry/index.js';

export const INDEX_VERSION = '1.0.0';
export const indexPath = () => path.join(graftHome(), 'workspace-index.json');

const EMPTY = { indexVersion: INDEX_VERSION, roots: [], projects: [], updatedAt: null, local: true, telemetry: false, uploads: 'never' };

/** Load the index, or an empty one. A corrupt file is reported, never silently replaced. */
export function loadIndex({ file = indexPath() } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return { ...EMPTY, roots: [], projects: [] }; throw err; }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw new Error(`The workspace index at ${file} is unreadable (${err.message}). Delete it to rebuild from source; nothing else depends on it.`); }
  if (parsed?.indexVersion !== INDEX_VERSION) {
    // A different version is not corruption: rebuild rather than misread it.
    return { ...EMPTY, roots: Array.isArray(parsed?.roots) ? parsed.roots.filter((r) => typeof r?.path === 'string') : [], projects: [], supersededVersion: parsed?.indexVersion || null };
  }
  if (!Array.isArray(parsed.roots) || !Array.isArray(parsed.projects)) throw new Error(`The workspace index at ${file} has an invalid structure. Delete it to rebuild.`);
  return parsed;
}

/** Atomic replace: a crash mid-write leaves the previous index intact. */
export function saveIndex(index, { file = indexPath() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.workspace-index-${crypto.randomUUID()}.tmp`);
  const payload = { ...index, indexVersion: INDEX_VERSION, updatedAt: new Date().toISOString(), local: true, telemetry: false, uploads: 'never' };
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { file, projects: payload.projects.length };
}

/** Authorized workspace roots. Only these are ever scanned; the filesystem at large is not. */
export function addRoot(root, { file = indexPath() } = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Workspace root not found: ${abs}`);
  const real = fs.realpathSync(abs);
  if (real === path.parse(real).root || real === os.homedir()) throw new Error('Choose a specific development folder rather than the filesystem or home root.');
  const index = loadIndex({ file });
  if (!index.roots.some((r) => r.path === real)) index.roots.push({ path: real, addedAt: new Date().toISOString() });
  saveIndex(index, { file });
  return index.roots;
}

export function removeRoot(root, { file = indexPath() } = {}) {
  // addRoot stores the real path, so removal must resolve symlinks the same way — otherwise a
  // root added through a symlink could never be removed. A path that no longer exists (the
  // folder was deleted or unmounted) still has to be removable, hence the fallback.
  const abs = path.resolve(root);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* gone from disk; match on the literal path */ }
  const matches = (value) => value === real || value === abs;
  const index = loadIndex({ file });
  index.roots = index.roots.filter((r) => !matches(r.path));
  index.projects = index.projects.filter((p) => !matches(p.workspaceRoot));
  saveIndex(index, { file });
  return index.roots;
}
