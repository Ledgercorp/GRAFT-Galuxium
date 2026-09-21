import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { safeProjectPath } from '../util/paths.js';
import { architectureSignature, canonicalSerialize, ENGINE_VERSION, stableHash, toCapabilityContract } from './contract.js';

const digestOrder = (values) => values.sort();

/** Hashes structure without storing code, filenames, repository names or credentials. */
export function projectFingerprint(fp) {
  const cleanAst = (v) => {
    if (typeof v === 'bigint') return { bigint: String(v) };
    if (v instanceof RegExp) return { regex: v.source, flags: v.flags };
    if (Array.isArray(v)) return v.map(cleanAst);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
      .filter(([k]) => !['start', 'end', 'raw', 'loc'].includes(k)).map(([k, value]) => [k, cleanAst(value)]));
    return v;
  };
  const files = fp.files.filter((f) => !f.startsWith('.graft/') && f !== 'package.json').map((f) => {
    const source = fp.readFile(f) || '';
    let contentHash = stableHash(source);
    if (/\.(mjs|cjs|js)$/.test(f)) {
      for (const sourceType of ['module', 'script']) {
        try { contentHash = stableHash(cleanAst(parse(source, { ecmaVersion: 'latest', sourceType }))); break; } catch { /* preserve unknown syntax as an opaque digest */ }
      }
    }
    return stableHash({ pathHash: stableHash(f.split(path.sep).join('/')), contentHash });
  });
  const packageExecution = Object.fromEntries(['type', 'main', 'scripts', 'dependencies', 'optionalDependencies', 'engines']
    .filter((key) => fp.packageJson?.[key] !== undefined).map((key) => [key, fp.packageJson[key]]));
  return stableHash({ architecture: architectureSignature(fp), packageExecution, files: digestOrder(files) });
}

export function compatibilityKnowledge(manifest, fp, plan) {
  const contract = toCapabilityContract(manifest);
  return {
    schemaVersion: '1.0.0', capabilityId: contract.capabilityId, capabilityCategory: manifest.identity.category,
    sourceArchitecture: contract.sourceArchitecture, destinationArchitecture: architectureSignature(fp),
    result: plan.status === 'blocked' ? 'refused' : plan.status === 'needs-resolution' || plan.compatibility.warnings.length ? 'conditionally-supported' : 'supported',
    reasons: plan.compatibility.checks.map((c) => ({ code: c.id, status: c.status, reason: c.title })),
    adaptation: plan.adaptation.profile, engineVersion: ENGINE_VERSION,
    recipeId: plan.engine?.recipe?.recipeId || null, capabilityKind: plan.engine?.genome?.identity?.kind || null,
  };
}

function localRecords(root, directory) {
  let folder;
  try { folder = safeProjectPath(root, directory); } catch { return []; }
  if (!fs.existsSync(folder)) return [];
  const records = [];
  // Bounded local history. An unreadable or edited record cannot assert source verification.
  const names = fs.readdirSync(folder).filter((n) => /^[a-zA-Z0-9-]+\.json$/.test(n)).sort();
  if (names.length > 1000) throw new Error('Local capability history exceeds the 1000-record inspection limit; explicit archival is required.');
  for (const name of names) {
    try {
      const file = safeProjectPath(root, `${directory}/${name}`);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || stat.nlink !== 1) continue;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (directory === '.graft/compatibility' && !validObservation(record)) continue;
        records.push(record);
      } finally { fs.closeSync(fd); }
    } catch { /* Non-authoritative history is never a reason to invent a verdict. */ }
  }
  return records;
}

function validObservation(record) {
  if (!record || record.schemaVersion !== '1.0.0') return false;
  const { eventId, ...payload } = record;
  if (eventId !== stableHash(payload)) return false;
  const digest = (v) => typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v);
  if (![record.capabilityId, record.sourceFingerprint, record.destinationFingerprint].every(digest)) return false;
  if (!['supported', 'refused', 'conditionally-supported'].includes(record.result)) return false;
  if (!Array.isArray(record.ancestors) || record.ancestors.length > 256) return false;
  const observation = (v) => v && ['VERIFIED', 'FAILED', 'NEEDS_REVIEW'].includes(v.verdict)
    && Number.isFinite(Date.parse(v.at)) && Array.isArray(v.tests)
    && v.tests.every((t) => typeof t.id === 'string' && typeof t.required === 'boolean' && ['passed', 'failed', 'inconclusive'].includes(t.outcome));
  return observation(record.verification) && record.ancestors.every((a) => a && digest(a.capabilityId)
    && digest(a.eventId) && digest(a.sourceFingerprint) && digest(a.destinationFingerprint) && observation(a.verification));
}

/** Parentage is an informational local claim; every new harvest still runs the verifier. */
export function inheritedLineage(fp, category) {
  const fingerprint = projectFingerprint(fp);
  const matches = localRecords(fp.root, '.graft/compatibility').filter((r) => r.schemaVersion === '1.0.0'
    && r.destinationFingerprint === fingerprint && r.capabilityCategory === category && r.verification?.verdict === 'VERIFIED');
  const latest = matches.sort((a, b) => String(b.verification.at).localeCompare(String(a.verification.at)))[0];
  if (!latest) return { schemaVersion: '1.0.0', parents: [], transplants: [] };
  if (latest.ancestors.length >= 256) throw new Error('Local lineage exceeds the 256-generation contract limit; explicit lineage archival is required.');
  return { schemaVersion: '1.0.0', parents: [...latest.ancestors, {
    capabilityId: latest.capabilityId, eventId: latest.eventId, sourceFingerprint: latest.sourceFingerprint,
    destinationFingerprint: latest.destinationFingerprint, adaptation: latest.adaptation,
    verification: latest.verification, engineVersion: latest.engineVersion,
  }], transplants: [] };
}

/**
 * The observation an actual applied contract produced, without writing it. `null` when the
 * destination holds no transplant receipt for the capability (nothing was applied there).
 */
export function buildCompatibilityObservation(manifest, fp, report) {
  const contract = toCapabilityContract(manifest);
  const receipt = localRecords(fp.root, '.graft/transplants').filter((r) => r.capabilityContract?.capabilityId === contract.capabilityId)
    .sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)))[0];
  if (!receipt?.compatibilityKnowledge) return null;
  const event = {
    ...receipt.compatibilityKnowledge, sourceFingerprint: contract.sourceFingerprint,
    sourceArchitecture: contract.sourceArchitecture, destinationArchitecture: architectureSignature(fp),
    destinationFingerprint: projectFingerprint(fp), ancestors: contract.lineage.parents,
    verification: { verdict: report.verdict, at: report.finishedAt, summary: report.summary,
      tests: report.results.map((r) => ({ id: r.id, required: r.required, outcome: r.outcome })) },
    engineVersion: ENGINE_VERSION,
  };
  event.eventId = stableHash(event);
  return event;
}

/** Append an observation for an actual applied contract. History never approves a plan. */
export function recordCompatibilityObservation(manifest, fp, report) {
  const event = buildCompatibilityObservation(manifest, fp, report);
  if (!event) return null;
  const relative = '.graft/compatibility';
  const folder = safeProjectPath(fp.root, relative);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = safeProjectPath(fp.root, `${relative}/${event.eventId.slice(7)}.json`);
  try { fs.writeFileSync(file, JSON.stringify(event, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size > 2 * 1024 * 1024 || canonicalSerialize(JSON.parse(fs.readFileSync(fd, 'utf8'))) !== canonicalSerialize(event)) {
        throw new Error('Existing compatibility observation differs; no history was overwritten.');
      }
    } finally { fs.closeSync(fd); }
  }
  return event;
}

export function localCompatibilityHistory(root, capabilityId) {
  return localRecords(root, '.graft/compatibility').filter((e) => !capabilityId || e.capabilityId === capabilityId);
}

/** Local projection across explicitly selected repositories; never uploads or rewrites a bank. */
export function inspectLocalCapability(manifest, destinations = []) {
  const contract = toCapabilityContract(manifest);
  const unique = new Map(destinations.flatMap((root) => localCompatibilityHistory(root, contract.capabilityId)).map((e) => [e.eventId, e]));
  return { ...contract, lineage: { ...contract.lineage,
    transplants: [...unique.values()].map((e) => ({ eventId: e.eventId, destinationFingerprint: e.destinationFingerprint,
      destinationArchitecture: e.destinationArchitecture, adaptation: e.adaptation, compatibility: e.result,
      verification: e.verification, engineVersion: e.engineVersion })) } };
}
