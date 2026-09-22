import crypto from 'node:crypto';
import { validateAcceptanceTests } from '../manifest/schema.js';

export const CAPABILITY_CONTRACT_VERSION = '1.0.0';
export const ENGINE_VERSION = '0.6.0';

/** JSON canonicalization: object keys are unordered; array order remains meaningful. */
export function canonicalSerialize(value) {
  const walk = (v) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return Object.is(v, -0) ? 0 : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, walk(v[k])]));
    }
    throw new TypeError('Capability contracts contain only finite JSON values.');
  };
  return JSON.stringify(walk(value));
}

export const stableHash = (value) => `sha256:${crypto.createHash('sha256').update(canonicalSerialize(value)).digest('hex')}`;
const text = (value) => String(value || '').trim().replace(/\s+/g, ' ');
// Only explicitly declared sets are reordered. HTTP steps and arbitrary JSON bodies are sequences.
const set = (values = []) => values.map((v) => JSON.parse(canonicalSerialize(v))).sort((a, b) => {
  const left = canonicalSerialize(a), right = canonicalSerialize(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const pick = (value, keys) => Object.fromEntries(keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]));
// Package specifications can contain local paths and credentials. Preserve only
// ordinary version-range syntax; represent every other specification opaquely.
const versionRange = (value) => value == null ? null : typeof value === 'string'
  && /^[v~^<>=*xX0-9][v0-9xX~^<>=*|.+ -]*$/.test(value) ? value : `opaque:${stableHash(value)}`;
const packageName = (value) => typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value)
  ? value : `opaque:${stableHash(value)}`;

export function architectureSignature(fp) {
  const value = (field) => typeof field === 'string' ? field : field?.value || 'unknown';
  return {
    runtime: { family: 'node', range: versionRange(fp.packageJson?.engines?.node) },
    framework: value(fp.framework), moduleSystem: value(fp.moduleSystem),
    handlerContract: value(fp.handlerContract), persistence: value(fp.persistence),
    dependencies: set((fp.dependencies || []).map((d) => ({ name: packageName(d.name), range: versionRange(d.range) }))),
  };
}

/** A stable behavioral identity, independent of source layout, evidence and collection time. */
export function capabilityRequirements(manifest) {
  const m = manifest;
  const model = structuredClone(m.architecture.capabilityModel);
  model.endpoints = set(model.endpoints);
  return {
    identity: { category: m.identity.category, slug: m.identity.slug },
    behavioralRequirements: set(m.behavior.statements.map((s) => ({ id: s.id, text: text(s.text) }))),
    model,
    interfaces: {
      inbound: set(m.interfaces.inbound), outbound: set(m.interfaces.outbound),
      providedToHost: set(m.interfaces.providedToHost), consumedFromHost: set(m.interfaces.consumedFromHost),
    },
    dependencies: { packages: set(m.dependencies.packages), runtime: set(m.dependencies.runtime), services: set(m.dependencies.services) },
    persistence: {
      entities: set(m.dataModel.entities.map((e) => ({ ...pick(e, ['name']), fields: set(e.fields) }))),
      relationships: set(m.dataModel.relationships), assumptions: set(m.dataModel.persistenceAssumptions),
    },
    environment: { variables: set(m.environment.variables) },
    securityInvariants: { assumptions: set(m.security.assumptions.map((s) => ({ id: s.id, text: text(s.text) }))), boundaries: set(m.security.boundaries) },
    acceptanceTests: set(m.acceptanceTests.tests.map((t) => ({
      ...pick(t, ['id', 'kind', 'required', 'provesBehavior']),
      steps: t.steps.map((s) => ({ ...s, ...(s.expect?.status ? { expect: { ...s.expect, status: set(Array.isArray(s.expect.status) ? s.expect.status : [s.expect.status]) } } : {}) })),
    }))),
    destinationRequirements: {
      adaptation: 'explicit-engine-profile', unresolvedArchitecture: 'refuse',
      runtime: 'node-entrypoint', routeConflicts: 'explicit-approval', verification: 'observed-http-acceptance-suite',
    },
  };
}

export function toCapabilityContract(manifest) {
  const requirements = capabilityRequirements(manifest);
  const version = CAPABILITY_CONTRACT_VERSION;
  const evidence = manifest.provenance.verifiedInSource;
  return {
    contractVersion: version,
    capabilityId: stableHash({ contractVersion: version, requirements }),
    requirements,
    sourceArchitecture: manifest.provenance.capabilitySource?.architecture || architectureSignature(manifest.architecture.sourceShape),
    sourceFingerprint: manifest.provenance.capabilitySource?.fingerprint || stableHash({ sourceShape: manifest.architecture.sourceShape, files: set(manifest.sourceMap.files.map((f) => ({ digest: f.sha256, role: f.role }))) }),
    provenance: { engineVersion: ENGINE_VERSION, legacyManifestVersion: manifest.identity.manifestVersion, method: manifest.provenance.method, harvestedAt: manifest.provenance.harvestedAt },
    sourceVerification: { verdict: evidence.verdict, at: evidence.at, summary: evidence.summary || null,
      tests: set((evidence.tests || []).map((t) => pick(t, ['id', 'required', 'outcome']))) },
    lineage: manifest.provenance.capabilityLineage || { schemaVersion: '1.0.0', parents: [], transplants: [] },
  };
}

export function validateCapabilityContract(contract, manifest) {
  if (contract?.contractVersion !== CAPABILITY_CONTRACT_VERSION) throw new Error('Unsupported capability contract version; explicit migration is required.');
  if (contract.capabilityId !== stableHash({ contractVersion: contract.contractVersion, requirements: contract.requirements })) throw new Error('Capability contract hash mismatch.');
  const r = contract.requirements;
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!object(r) || !object(r.identity) || typeof r.identity.slug !== 'string' || typeof r.identity.category !== 'string'
    || !Array.isArray(r.behavioralRequirements) || !r.behavioralRequirements.length
    || !r.behavioralRequirements.every((b) => typeof b.id === 'string' && typeof b.text === 'string')
    || !['model', 'interfaces', 'dependencies', 'persistence', 'environment', 'securityInvariants', 'destinationRequirements'].every((key) => object(r[key]))
    || !validateAcceptanceTests(r.acceptanceTests).ok
    || !object(contract.sourceArchitecture) || !/^sha256:[0-9a-f]{64}$/.test(contract.sourceFingerprint)
    || !object(contract.provenance) || !object(contract.sourceVerification)
    || !object(contract.lineage) || contract.lineage.schemaVersion !== '1.0.0'
    || !Array.isArray(contract.lineage.parents) || !Array.isArray(contract.lineage.transplants)) {
    throw new Error('Invalid capability contract structure.');
  }
  if (manifest && canonicalSerialize(contract) !== canonicalSerialize(toCapabilityContract(manifest))) throw new Error('Capability contract disagrees with its manifest or evidence.');
  return contract;
}
