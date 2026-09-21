import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Local-first persistence. Projects, harvested capabilities and transplant records all
 * live on the user's machine. There is no GRAFT account, no hosted database and nothing
 * leaves this directory. A JSON document is deliberate: the data is small, and a file the
 * user can open and read is worth more here than a binary they cannot.
 */
export function graftHome() {
  return process.env.GRAFT_HOME || path.join(os.homedir(), '.graft');
}

function registryPath() { return path.join(graftHome(), 'registry.json'); }
export function bankDir() { return path.join(graftHome(), 'organ-bank'); }

const EMPTY = { version: 1, projects: [], transplants: [] };

export function loadRegistry() {
  try {
    const registry = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    if (registry?.version !== 1 || !Array.isArray(registry.projects) || !Array.isArray(registry.transplants)
      || !registry.projects.every((p) => p && typeof p.name === 'string' && typeof p.root === 'string')) throw new Error('invalid registry structure');
    return registry;
  } catch (err) {
    if (err.code === 'ENOENT') return { ...EMPTY, projects: [], transplants: [] };
    throw new Error(`Cannot read registry ${registryPath()}; existing data was preserved. Repair or restore this file before continuing. ${err.message}`);
  }
}

export function saveRegistry(registry) {
  fs.mkdirSync(graftHome(), { recursive: true });
  const temporary = path.join(graftHome(), `.registry-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, registryPath());
  } finally { fs.rmSync(temporary, { force: true }); }
  return registryPath();
}

function updateRegistry(update) {
  fs.mkdirSync(graftHome(), { recursive: true });
  const lock = path.join(graftHome(), 'registry.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Registry is busy (${lock}). Retry after the other GRAFT command finishes; remove a stale lock only after confirming no command is running.`);
    throw err;
  }
  try { fs.writeFileSync(fd, String(process.pid)); return update(loadRegistry()); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

export function addProject(root, { name } = {}) {
  const abs = path.resolve(root);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`project directory not found: ${abs}`);
  return updateRegistry((registry) => {
    const existing = registry.projects.find((p) => p.root === abs);
    if (existing) return { registry, project: existing, added: false };
    const project = { name: name || path.basename(abs), root: abs, addedAt: new Date().toISOString() };
    registry.projects.push(project);
    saveRegistry(registry);
    return { registry, project, added: true };
  });
}

/** Forget a registered project by its exact root. Nothing on disk is touched. */
export function removeProject(root) {
  const abs = path.resolve(root);
  return updateRegistry((registry) => {
    const before = registry.projects.length;
    registry.projects = registry.projects.filter((p) => p.root !== abs);
    if (registry.projects.length !== before) saveRegistry(registry);
    return { registry, removed: registry.projects.length !== before };
  });
}

export function resolveProject(nameOrPath) {
  const registry = loadRegistry();
  const byName = registry.projects.find((p) => p.name === nameOrPath);
  if (byName) return byName.root;
  const abs = path.resolve(nameOrPath);
  if (fs.existsSync(abs)) return abs;
  throw new Error(`unknown project "${nameOrPath}". Add it with: graft add <path>`);
}

export function recordTransplant(record) {
  return updateRegistry((registry) => {
    registry.transplants.push(record);
    saveRegistry(registry);
    return record;
  });
}
