import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SECTIONS, validateManifest, redactSecrets } from './schema.js';
import { safeProjectPath } from '../util/paths.js';
import { toCapabilityContract, validateCapabilityContract } from '../capability/contract.js';
import { buildEngineArtifacts, validateEngineArtifacts } from '../engine/index.js';

export const SOURCE_EVIDENCE_FILE = 'source-verification.json';
export const CAPABILITY_CONTRACT_FILE = 'capability-contract.json';
export const ENGINE_FILE = 'graft-engine.json';

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function behaviorMarkdown(manifest) {
  const lines = [`# ${manifest.identity.name}`, '', manifest.behavior.summary || '', '', '## Observable behavior', ''];
  for (const s of manifest.behavior.statements) {
    lines.push(`- **${s.id}** — ${s.text}`);
    for (const e of s.evidence) lines.push(`  - evidence: \`${e}\``);
  }
  return lines.join('\n') + '\n';
}

function securityMarkdown(manifest) {
  const lines = [`# Security assumptions — ${manifest.identity.name}`, '', '## Assumptions this capability relies on', ''];
  for (const a of manifest.security.assumptions) lines.push(`- **${a.id}** — ${a.text}`);
  if (manifest.security.boundaries?.length) {
    lines.push('', '## Boundaries', '');
    for (const b of manifest.security.boundaries) lines.push(`- ${b}`);
  }
  if (manifest.security.notes?.length) {
    lines.push('', '## Notes carried from the source project', '');
    for (const n of manifest.security.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n') + '\n';
}

const ARTIFACTS = [...Object.values(SECTIONS), 'behavior.json', 'security.json', SOURCE_EVIDENCE_FILE, CAPABILITY_CONTRACT_FILE, ENGINE_FILE];

function packagePaths(graftDir) {
  const target = path.resolve(graftDir);
  const parent = path.dirname(target);
  const name = path.basename(target);
  return { target, parent, name, lock: path.join(parent, `.${name}.lock`), backup: path.join(parent, `.${name}.previous`) };
}

function assertNotUpdating(paths) {
  try { fs.lstatSync(paths.lock); }
  catch (err) { if (err.code === 'ENOENT') return; throw err; }
  const err = new Error(`Organ-bank package is busy or needs recovery: ${paths.target}. Check ${paths.lock}; after confirming no GRAFT writer is running, follow the organ-bank recovery instructions before removing the lock.`);
  err.code = 'manifest-busy';
  throw err;
}

function inspectExistingPackage(paths) {
  for (const file of ARTIFACTS) safeProjectPath(paths.parent, `${paths.name}/${file}`);
  if (!fs.existsSync(paths.target)) return false;
  const unexpected = fs.readdirSync(paths.target).filter((file) => !ARTIFACTS.includes(file));
  if (unexpected.length) throw new Error(`Refusing to replace package containing unrecognized files: ${unexpected.join(', ')}. Move them aside before re-harvesting.`);
  for (const file of fs.readdirSync(paths.target)) {
    if (!fs.lstatSync(path.join(paths.target, file)).isFile()) throw new Error(`Package section is not an ordinary file: ${file}`);
  }
  return true;
}

/** Stage a complete package and replace it under an exclusive per-package lock. */
export function writeManifest(dir, manifest) {
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    const err = new Error(`refusing to write an invalid manifest:\n  - ${validation.errors.join('\n  - ')}`);
    err.errors = validation.errors;
    throw err;
  }
  fs.mkdirSync(dir, { recursive: true });
  const paths = packagePaths(path.join(fs.realpathSync(dir), `${manifest.identity.slug}.graft`));
  safeProjectPath(paths.parent, path.basename(paths.lock));
  let lockFd;
  try { lockFd = fs.openSync(paths.lock, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') assertNotUpdating(paths); throw err; }
  let stage = null;
  let previousMoved = false;
  let installed = false;
  let releaseLock = true;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, target: paths.target, previous: paths.backup, startedAt: new Date().toISOString() }) + '\n');
    safeProjectPath(paths.parent, path.basename(paths.backup));
    if (fs.existsSync(paths.backup)) {
      releaseLock = false;
      throw new Error(`Previous package remains at ${paths.backup}; recover it before another harvest.`);
    }
    const replacing = inspectExistingPackage(paths);
    stage = fs.mkdtempSync(path.join(paths.parent, `.${paths.name}-stage-`));
    writeJson(path.join(stage, SECTIONS.identity), manifest.identity);
    fs.writeFileSync(path.join(stage, SECTIONS.behavior), behaviorMarkdown(manifest), 'utf8');
    writeJson(path.join(stage, SECTIONS.architecture), manifest.architecture);
    writeJson(path.join(stage, SECTIONS.dependencies), manifest.dependencies);
    writeJson(path.join(stage, SECTIONS.interfaces), manifest.interfaces);
    writeJson(path.join(stage, SECTIONS.dataModel), manifest.dataModel);
    writeJson(path.join(stage, SECTIONS.environment), manifest.environment);
    fs.writeFileSync(path.join(stage, SECTIONS.security), securityMarkdown(manifest), 'utf8');
    writeJson(path.join(stage, SECTIONS.acceptanceTests), manifest.acceptanceTests);
    writeJson(path.join(stage, SECTIONS.sourceMap), manifest.sourceMap);
    writeJson(path.join(stage, SECTIONS.provenance), manifest.provenance);

    // behavior.md and security.md are renderings; the machine-readable originals live alongside
    // so a re-read is lossless rather than a markdown parse.
    writeJson(path.join(stage, 'behavior.json'), manifest.behavior);
    writeJson(path.join(stage, 'security.json'), manifest.security);
    writeJson(path.join(stage, CAPABILITY_CONTRACT_FILE), toCapabilityContract(manifest));
    // Engine 1.0: the organ carries its genome, graph, IR and verification contract, derived from
    // the same manifest and re-checked on read, so they can never drift from the evidence.
    writeJson(path.join(stage, ENGINE_FILE), buildEngineArtifacts(manifest));

    // Full source-verification evidence lives beside the manifest, referenced from
    // provenance, so provenance stays compact and the receipt stays auditable. It is
    // captured output from someone else's application, so it is redacted before writing.
    if (manifest.sourceVerificationReport) {
      writeJson(path.join(stage, SOURCE_EVIDENCE_FILE), redactSecrets(manifest.sourceVerificationReport));
    }

    // Round-trip the complete staged package before replacing the existing one.
    readPackage(stage);
    if (replacing) {
      fs.renameSync(paths.target, paths.backup);
      previousMoved = true;
    }
    fs.renameSync(stage, paths.target);
    stage = null;
    installed = true;
    if (previousMoved) fs.rmSync(paths.backup, { recursive: true });
    return path.join(dir, `${manifest.identity.slug}.graft`);
  } catch (err) {
    const recoveryErrors = [];
    if (previousMoved && !installed) {
      try { fs.renameSync(paths.backup, paths.target); }
      catch (restoreError) { recoveryErrors.push(`previous package preserved at ${paths.backup}: ${restoreError.message}`); }
    }
    if (stage) {
      try { fs.rmSync(stage, { recursive: true }); }
      catch (cleanupError) { recoveryErrors.push(`staged package remains at ${stage}: ${cleanupError.message}`); }
    }
    if (installed || recoveryErrors.length) releaseLock = false;
    err.message = `${installed ? 'New manifest was installed, but cleanup is incomplete' : 'Manifest update failed'}: ${err.message}${recoveryErrors.length ? `. Recovery incomplete: ${recoveryErrors.join('; ')}` : ''}${releaseLock ? '' : `. Lock retained at ${paths.lock}; see organ-bank recovery instructions.`}`;
    throw err;
  } finally {
    fs.closeSync(lockFd);
    if (releaseLock) fs.unlinkSync(paths.lock);
  }
}

/** Read-only snapshot: directory identity prevents mixing generations during rename. */
export function readManifest(graftDir) {
  const paths = packagePaths(graftDir);
  assertNotUpdating(paths);
  let directory;
  try {
    directory = fs.openSync(paths.target, 'r');
    const before = fs.fstatSync(directory);
    for (const file of ARTIFACTS) safeProjectPath(paths.parent, `${paths.name}/${file}`);
    const manifest = readPackage(paths.target);
    assertNotUpdating(paths);
    const after = fs.statSync(paths.target);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`Organ-bank package changed while being read: ${paths.target}. Retry the command.`);
    }
    assertEngineAgrees(paths.target, manifest);
    return manifest;
  } catch (err) {
    // If the package moved during the read, report the writer/recovery boundary.
    assertNotUpdating(paths);
    throw err;
  } finally { if (directory !== undefined) fs.closeSync(directory); }
}

function readPackage(graftDir) {
  const evidence = path.join(graftDir, SOURCE_EVIDENCE_FILE);
  const manifest = {
    ...(fs.existsSync(evidence) ? { sourceVerificationReport: readJson(evidence) } : {}),
    identity: readJson(path.join(graftDir, SECTIONS.identity)),
    behavior: readJson(path.join(graftDir, 'behavior.json')),
    architecture: readJson(path.join(graftDir, SECTIONS.architecture)),
    dependencies: readJson(path.join(graftDir, SECTIONS.dependencies)),
    interfaces: readJson(path.join(graftDir, SECTIONS.interfaces)),
    dataModel: readJson(path.join(graftDir, SECTIONS.dataModel)),
    environment: readJson(path.join(graftDir, SECTIONS.environment)),
    security: readJson(path.join(graftDir, 'security.json')),
    acceptanceTests: readJson(path.join(graftDir, SECTIONS.acceptanceTests)),
    sourceMap: readJson(path.join(graftDir, SECTIONS.sourceMap)),
    provenance: readJson(path.join(graftDir, SECTIONS.provenance)),
  };
  const validation = validateManifest(manifest);
  if (!validation.ok) throw new Error(`invalid manifest: ${validation.errors.join('; ')}`);
  const contractFile = path.join(graftDir, CAPABILITY_CONTRACT_FILE);
  if (fs.existsSync(contractFile)) validateCapabilityContract(readJson(contractFile), manifest);
  return manifest;
}

// Engine artifacts are checked only after the reader has confirmed the package did not change
// underneath it, so a concurrent replacement is reported as such and never as "drift".
function assertEngineAgrees(graftDir, manifest) {
  const engineFile = path.join(graftDir, ENGINE_FILE);
  if (!fs.existsSync(engineFile)) return;
  const validation = validateEngineArtifacts(readJson(engineFile), manifest);
  if (!validation.ok) throw new Error(`Organ engine artifacts disagree with the manifest: ${validation.errors.join('; ')}. This happens when a capability was harvested by an earlier engine; harvest it again with this version of GRAFT.`);
}

export function listOrganBank(bankDir) {
  if (!fs.existsSync(bankDir)) return [];
  const names = new Set();
  for (const entry of fs.readdirSync(bankDir)) {
    if (entry.endsWith('.graft') && !entry.startsWith('.')) names.add(entry);
    const pending = /^\.(.+\.graft)\.lock$/.exec(entry);
    if (pending) names.add(pending[1]);
  }
  return [...names].sort().map((entry) => {
    const dir = path.join(bankDir, entry);
    try { return { dir, manifest: readManifest(dir) }; }
    catch (err) { return { dir, error: String(err.message) }; }
  });
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/** The engine artifacts stored with an organ (genome, graph, IR, verification contract), or null for a pre-engine package. */
export function readOrganEngine(graftDir) {
  const paths = packagePaths(graftDir);
  assertNotUpdating(paths);
  safeProjectPath(paths.parent, `${paths.name}/${ENGINE_FILE}`);
  const file = path.join(paths.target, ENGINE_FILE);
  if (!fs.existsSync(file)) return null;
  const bundle = readJson(file);
  const validation = validateEngineArtifacts(bundle, readManifest(graftDir));
  if (!validation.ok) throw new Error(`Organ engine artifacts are invalid: ${validation.errors.join('; ')}`);
  return bundle;
}
