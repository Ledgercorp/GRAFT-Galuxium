import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { discoverCapabilities } from '../src/harvest/index.js';
import { detect as detectLibrary } from '../src/harvest/detectors/feature-flags-library.js';
import { detect as detectService } from '../src/harvest/detectors/feature-flags.js';
import { IMPLEMENTATION_FORMS, isImplementationForm, deriveImplementationForm, FORM_LABELS } from '../src/capability/form.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixture = (name) => path.join(repoRoot, 'fixtures', name);
const form = (name) => path.join(repoRoot, 'fixtures/forms', name);
/** The real third-party library, when it is present on this machine. */
const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const haveSwivel = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js'));

test('implementation form is a small, closed dimension, independent of capability kind', () => {
  assert.deepEqual([...IMPLEMENTATION_FORMS], ['service', 'library']);
  assert.equal(isImplementationForm('library'), true);
  assert.equal(isImplementationForm('feature-flags-library'), false, 'form is never a capability kind');
  assert.deepEqual(Object.keys(FORM_LABELS).sort(), ['library', 'service']);
});

test('legacy artifacts without a form are derived only where the structure proves it, never guessed', () => {
  // A recorded form always wins.
  assert.deepEqual(deriveImplementationForm({ identity: { implementationForm: 'library' } }), { form: 'library', derived: false, evidence: 'recorded in the manifest' });
  // HTTP endpoints in the capability model mean service — that is what the field means.
  const withEndpoints = deriveImplementationForm({ architecture: { capabilityModel: { endpoints: [{ role: 'list', method: 'GET', path: '/flags' }] } } });
  assert.equal(withEndpoints.form, 'service'); assert.equal(withEndpoints.derived, true);
  assert.match(withEndpoints.evidence, /1 HTTP endpoint/);
  // So do acceptance tests that are entirely HTTP exchanges.
  assert.equal(deriveImplementationForm({ acceptanceTests: { tests: [{ kind: 'http' }, { kind: 'http' }] } }).form, 'service');
  // Nothing structural: stay silent rather than claim a history nobody recorded.
  assert.deepEqual(deriveImplementationForm({ identity: { name: 'x' } }), { form: null, derived: false, evidence: 'no structural evidence of an implementation form' });
  assert.equal(deriveImplementationForm({ acceptanceTests: { tests: [{ kind: 'library' }] } }).form, null);
  assert.equal(deriveImplementationForm({ architecture: { capabilityModel: { endpoints: [] } } }).form, null);
});

test('service-shaped feature flags are unchanged and still report service form', () => {
  const fp = fingerprintProject(fixture('config-service'));
  const service = detectService(fp);
  assert.equal(service.found, true, 'the existing service detector is untouched');
  assert.ok(service.routes.some((r) => r.role === 'list'));
  assert.ok(Object.keys(service.defaults).length > 0);
  const discovered = discoverCapabilities(fp);
  const flags = discovered.find((c) => c.category === 'feature-flags');
  assert.equal(flags.id, 'feature-flags', 'the service form keeps the plain capability id');
  assert.equal(flags.implementationForm, 'service');
  // The library detector must not also claim a project that serves its own routes.
  assert.equal(detectLibrary(fp).found, false);
  assert.match(detectLibrary(fp).reason, /serves its own HTTP routes/);
});

test('a real third-party feature-flags library is detected structurally, with no HTTP route required', { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' }, () => {
  const fp = fingerprintProject(SWIVEL);
  assert.equal(fp.routes.length, 0, 'the library serves nothing');
  const r = detectLibrary(fp);
  assert.equal(r.found, true);
  assert.equal(r.implementationForm, 'library');
  assert.equal(r.confidence, 'high');
  assert.equal(r.category, 'feature-flags', 'the kind is unchanged: form is orthogonal');
  // Every signal is a code shape, and the entry is the artifact package.json names.
  const ids = r.signals.map((s) => s.id).sort();
  assert.deepEqual(ids, ['feature-predicate', 'feature-registry', 'feature-selection', 'library-entry', 'no-http-surface']);
  assert.equal(r.entry, 'dist/swivel.js');
  assert.match(r.api.predicate.join(' '), /enabled\(slug/);
  assert.match(r.api.selection.join(' '), /returnValue\(slug, a, b\)|invoke\(slug, a, b\)/);
  assert.match(r.api.registry.join(' '), /FeatureMap\(map\)/);
  assert.deepEqual(r.runtimeDependencies, [], 'the library declares no runtime dependencies');
  // Through the product's own discovery, with the form attached.
  const discovered = discoverCapabilities(fp);
  const found = discovered.find((c) => c.category === 'feature-flags');
  assert.equal(found.implementationForm, 'library');
  assert.equal(found.harvestable, true);
});

test('ordinary libraries are not feature-flags capabilities: name, README, booleans, config and strategies are all refused', () => {
  const cases = [
    ['config-library', /no feature-evaluation API/],
    ['boolean-library', /no feature-evaluation API/],
    ['named-feature-flags', /no feature-evaluation API/],
    ['strategy-library', /no feature-evaluation API/],
  ];
  for (const [name, reason] of cases) {
    const fp = fingerprintProject(form(name));
    const r = detectLibrary(fp);
    assert.equal(r.found, false, `${name} must not be detected`);
    assert.equal(r.ambiguous, false, name);
    assert.match(r.reason, reason, name);
    assert.deepEqual(discoverCapabilities(fp), [], `${name} yields no capability at all`);
  }
  // The package named "feature-flags" whose README is all about flags is refused on code alone.
  const named = fingerprintProject(form('named-feature-flags'));
  assert.equal(named.packageJson.name, 'feature-flags');
  assert.match(fs.readFileSync(path.join(form('named-feature-flags'), 'README.md'), 'utf8'), /feature flag/i);
  assert.equal(detectLibrary(named).found, false, 'a package name and a README are never evidence');
  // A library that exports a feature map and nothing else is ambiguous, not a capability.
  const half = detectLibrary(fingerprintProject(form('ambiguous-flags')));
  assert.equal(half.found, false);
  assert.equal(half.ambiguous, true);
  assert.match(half.reason, /only one feature-evaluation signal/);
  assert.deepEqual(discoverCapabilities(fingerprintProject(form('ambiguous-flags'))), []);
});

// ---------------------------------------------------------------------------------------------
// Checkpoint B: form-aware representation and the non-HTTP verification path.
// ---------------------------------------------------------------------------------------------
import { harvest, harvestCapability, harvestPolicy } from '../src/harvest/index.js';
import { validateManifest } from '../src/manifest/schema.js';
import { buildEngineArtifacts } from '../src/engine/index.js';
import { runLibrarySuite } from '../src/verify/library-runner.js';
import { writeManifest, readManifest } from '../src/manifest/io.js';

const libraryManifest = () => harvest(fingerprintProject(SWIVEL), 'feature-flags-library');
const skipWithoutSwivel = { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' };

test('a library manifest declares real operations and no HTTP anywhere', skipWithoutSwivel, () => {
  const m = libraryManifest();
  assert.deepEqual(validateManifest(m).errors, []);
  assert.equal(m.identity.category, 'feature-flags');
  assert.equal(m.identity.implementationForm, 'library');
  const model = m.architecture.capabilityModel;
  assert.deepEqual(model.endpoints, [], 'a library registers no routes');
  assert.deepEqual(m.interfaces.inbound, [], 'a library has no inbound HTTP interface');
  assert.equal(model.artifact.entry, 'dist/swivel.js');
  assert.equal(model.artifact.moduleSystem, 'commonjs');
  assert.deepEqual(model.operations.map((o) => o.name).sort(), ['invoke', 'returnValue']);
  assert.equal(model.configuration.defaultsInCode, false, 'the library has no defaults in code');
  // No HTTP anywhere it would describe the capability: architecture, interfaces, acceptance tests.
  const described = JSON.stringify({ architecture: m.architecture, interfaces: m.interfaces, acceptanceTests: m.acceptanceTests });
  assert.equal(/"method":|"path":"\/|"status":|"cookie/.test(described), false, 'no fabricated HTTP in the manifest');
  assert.ok(m.acceptanceTests.tests.every((t) => t.kind === 'library' && t.steps.every((s) => s.call && !s.method && !s.path)));
  // The library itself is what a destination would have to resolve — recorded, never installed.
  assert.deepEqual(m.dependencies.packages, []);
  assert.equal(m.dependencies.hostRequirements[0].name, 'swiveljs');
  assert.equal(m.dependencies.hostRequirements[0].satisfiedByGraft, false);
});

test('Genome and IR describe a library without inventing endpoints, and keep stable identity', skipWithoutSwivel, () => {
  const m = libraryManifest();
  const { genome, ir, verificationContract } = buildEngineArtifacts(m);
  assert.equal(genome.identity.category, 'feature-flags');
  assert.equal(genome.entrypoints.filter((e) => e.kind === 'http-endpoint').length, 0);
  assert.deepEqual([...new Set(genome.entrypoints.map((e) => e.kind))], ['module-export']);
  assert.deepEqual(genome.outputs, []);
  assert.deepEqual(genome.sideEffects, [], 'evaluating a feature changes nothing');
  assert.match(genome.genomeId, /^sha256:/);
  assert.deepEqual(ir.operations.map((o) => o.kind), ['library-operation', 'library-operation']);
  assert.deepEqual(ir.operations.map((o) => o.name).sort(), ['invoke', 'returnValue']);
  assert.equal(ir.operations.every((o) => !('method' in o) && !('path' in o)), true, 'library operations have no method or path');
  assert.equal(ir.policies.configuration.defaults, null);
  assert.equal(ir.policies.configuration.envVar, null);
  assert.equal(ir.policies.configuration.hierarchical, true);
  assert.equal(verificationContract.operations.every((o) => o.kind === 'library-operation' && o.name), true);
  // Identity is deterministic: the same manifest gives the same ids.
  const again = buildEngineArtifacts(libraryManifest());
  assert.equal(again.genome.genomeId, genome.genomeId);
  assert.equal(again.ir.irId, ir.irId);
});

test('the library runner executes the real artifact and reaches VERIFIED through the shared verdict authority', skipWithoutSwivel, async () => {
  const before = fs.readdirSync(SWIVEL, { recursive: true }).length;
  const { manifest, verification, policy } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  assert.equal(verification.verdict, 'VERIFIED');
  assert.equal(verification.method, 'library-artifact');
  assert.equal(verification.artifact.loaded, true);
  assert.equal(verification.summary.required, 8);
  assert.equal(verification.summary.passed, 8);
  assert.equal(verification.summary.failed + verification.summary.inconclusive, 0);
  assert.match(verification.rationale, /library artifact dist\/swivel\.js/, 'the rationale names what was exercised, not a server');
  // The behaviours proved are the ones characterised from the library itself.
  assert.deepEqual(verification.behaviorCovered.sort(), ['flags.branch', 'flags.deterministic', 'flags.disabled', 'flags.evaluate', 'flags.hierarchy', 'flags.unknown']);
  // Coverage is stated in the library's own terms; no route is invented.
  assert.ok(verification.proof.routeCoverage.every((c) => c.kind === 'library-operation' && c.exercised === true && c.call));
  assert.equal(/undefined/.test(JSON.stringify(verification.proof.routeCoverage)), false);
  // Source verification is not a claim about hosts.
  assert.equal(policy.transplantReady, false);
  assert.equal(policy.integration, 'not-yet-proven');
  assert.equal(manifest.provenance.verifiedInSource.verdict, 'VERIFIED');
  assert.equal(fs.readdirSync(SWIVEL, { recursive: true }).length, before, 'the source checkout is only read');
});

test('library verification is honest when behaviour breaks, when the artifact cannot load, and when repeated', skipWithoutSwivel, async () => {
  const m = libraryManifest();
  const artifact = m.architecture.capabilityModel.artifact;
  const good = m.acceptanceTests.tests;
  // A. A required case whose expectation the library does not meet: FAILED, never inconclusive.
  const broken = good.map((t) => (t.id === 'flags.enabled-for-context'
    ? { ...t, steps: [{ ...t.steps[0], expect: { equals: 'this-is-not-what-the-library-returns' } }] } : t));
  const failed = await runLibrarySuite({ sourceRoot: SWIVEL, artifact, tests: broken });
  assert.equal(failed.verdict, 'FAILED');
  assert.equal(failed.summary.failed, 1);
  assert.match(failed.results.find((r) => r.id === 'flags.enabled-for-context').detail, /produced "on", expected/);
  // B. A declared artifact that is not there: nothing could be observed, so NEEDS_REVIEW.
  const missing = await runLibrarySuite({ sourceRoot: SWIVEL, artifact: { ...artifact, entry: 'dist/not-published.js' }, tests: good });
  assert.equal(missing.verdict, 'NEEDS_REVIEW');
  assert.equal(missing.artifact.loaded, false);
  assert.equal(missing.summary.passed, 0);
  assert.match(missing.rationale, /could not be exercised/);
  // An artifact outside the project is refused rather than loaded.
  const escaped = await runLibrarySuite({ sourceRoot: SWIVEL, artifact: { ...artifact, entry: '../../../etc/hosts' }, tests: good });
  assert.equal(escaped.verdict, 'NEEDS_REVIEW');
  assert.equal(escaped.artifact.loaded, false);
  // C. A case naming an operation the library does not expose is inconclusive, never passed.
  const bogus = await runLibrarySuite({ sourceRoot: SWIVEL, artifact, tests: [{ id: 'flags.nope', required: true, provesBehavior: 'flags.evaluate', construct: good[0].construct, steps: [{ name: 'x', call: 'noSuchOperation', args: ['a'], expect: { equals: true } }] }] });
  assert.equal(bogus.verdict, 'NEEDS_REVIEW');
  assert.equal(bogus.results[0].outcome, 'inconclusive');
  assert.match(bogus.results[0].detail, /no noSuchOperation\(\) operation/);
  // D. Deterministic: the same suite twice gives the same verdict and the same per-case outcomes.
  const first = await runLibrarySuite({ sourceRoot: SWIVEL, artifact, tests: good });
  const second = await runLibrarySuite({ sourceRoot: SWIVEL, artifact, tests: good });
  assert.equal(first.verdict, second.verdict);
  assert.deepEqual(first.results.map((r) => [r.id, r.outcome]), second.results.map((r) => [r.id, r.outcome]));
});

test('a harvested library organ survives being written and read back, with its form, provenance and licence intact', skipWithoutSwivel, async (t) => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-form-bank-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(work, manifest);
  const reopened = readManifest(path.join(work, 'feature-flags-library.graft'));
  assert.equal(reopened.identity.implementationForm, 'library');
  assert.equal(reopened.identity.category, 'feature-flags');
  assert.equal(reopened.architecture.capabilityModel.artifact.packageName, 'swiveljs');
  assert.equal(reopened.architecture.capabilityModel.artifact.packageVersion, '3.0.0');
  assert.equal(reopened.provenance.sourceProject.name, 'swiveljs');
  assert.deepEqual(reopened.architecture.capabilityModel.endpoints, []);
  assert.deepEqual(validateManifest(reopened).errors, []);
  // Both forms of the one kind can sit in a bank side by side, as separate artifacts.
  const service = harvest(fingerprintProject(fixture('config-service')), 'feature-flags');
  writeManifest(work, service);
  assert.deepEqual(fs.readdirSync(work).sort(), ['feature-flags-library.graft', 'feature-flags.graft']);
  assert.equal(readManifest(path.join(work, 'feature-flags.graft')).identity.implementationForm, 'service');
});

test('harvest policy separates proven behaviour from host readiness', () => {
  assert.deepEqual(harvestPolicy('VERIFIED'), { status: 'verified', bankable: true, transplantReady: true, label: 'Verified in source' });
  const library = harvestPolicy('VERIFIED', { implementationForm: 'library' });
  assert.equal(library.status, 'verified');
  assert.equal(library.transplantReady, false, 'source verification never implies host support');
  assert.equal(library.integration, 'not-yet-proven');
  assert.equal(harvestPolicy('FAILED', { implementationForm: 'library' }).bankable, false);
});

// ---------------------------------------------------------------------------------------------
// Checkpoint C: the product surface — export, Laboratory candidacy, planner honesty.
// ---------------------------------------------------------------------------------------------
import { buildCapabilityPackage } from '../src/export/index.js';
import { bankDir } from '../src/registry/index.js';
import { createBlueprint, addGoal, selectImplementation, analyseBlueprint } from '../src/laboratory/index.js';
import { buildAssemblyPlan, newHostSpecification } from '../src/laboratory/assembly.js';

const EMPTY_INDEX = { indexVersion: '1.0.0', roots: [], updatedAt: null, projects: [] };
/** Harvest the real library into an isolated bank. */
async function bankedLibrary(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-form-c-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const { manifest } = await harvestCapability(fingerprintProject(SWIVEL), 'feature-flags-library');
  writeManifest(bankDir(), manifest);
  return { home, manifest, organDir: path.join(bankDir(), 'feature-flags-library.graft') };
}

test('a library capability exports as the library itself, with provenance and licence, and claims no integration', skipWithoutSwivel, async (t) => {
  const { organDir } = await bankedLibrary(t);
  const pkg = buildCapabilityPackage({ organDir, graftVersion: '0.0.0-test' });
  assert.equal(pkg.implementationForm, 'library');
  assert.deepEqual(pkg.fileList, [
    'feature-flags-library/GRAFT.md',
    'feature-flags-library/LICENSES/LICENSE',
    'feature-flags-library/dependencies.json',
    'feature-flags-library/graft-capability.json',
    'feature-flags-library/library/swivel.js',
    'feature-flags-library/provenance.json',
    'feature-flags-library/verification-contract.json',
  ]);
  // The artifact is the library's own file, byte for byte — not something GRAFT generated.
  const shipped = pkg.files['feature-flags-library/library/swivel.js'];
  assert.deepEqual(Buffer.from(shipped), fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js')));
  const m = JSON.parse(pkg.files['feature-flags-library/graft-capability.json']);
  assert.equal(m.kind, 'feature-flags');
  assert.equal(m.implementationForm, 'library');
  assert.equal(m.verification.source.verdict, 'VERIFIED');
  assert.equal(m.verification.destinationIntegration, 'not-yet-proven');
  assert.equal(m.verification.universalCompatibility, 'not-claimed');
  assert.deepEqual(m.verification.transplantEvidence, []);
  assert.equal(m.implementation.artifact.packageName, 'swiveljs');
  assert.equal(m.implementation.artifact.packageVersion, '3.0.0');
  assert.match(m.implementation.artifact.sha256, /^sha256:/);
  assert.deepEqual(m.implementation.operations.map((o) => o.name).sort(), ['invoke', 'returnValue']);
  assert.equal(m.licence.declared, 'MIT');
  // Provenance names the upstream project and the exact revision; the licence text travels with it.
  const provenance = JSON.parse(pkg.files['feature-flags-library/provenance.json']);
  assert.match(provenance.sourceProject.remote, /zumba\/swiveljs/);
  assert.match(provenance.sourceProject.revision, /^[0-9a-f]{40}$/);
  assert.equal(provenance.artifact.copiedVerbatim, true);
  assert.match(pkg.files['feature-flags-library/LICENSES/LICENSE'], /MIT License/);
  // The document says what was proved and what was not, in plain words, with no service wording.
  const doc = pkg.files['feature-flags-library/GRAFT.md'];
  assert.match(doc, /implemented by an external library/);
  assert.match(doc, /Source behaviour: \*\*VERIFIED\*\*/);
  assert.match(doc, /Destination integration is not yet proven/);
  assert.match(doc, /Universal compatibility is not claimed/);
  assert.equal(/register these routes|mount|middleware|endpoint/i.test(doc), false, 'no service wording in a library document');
  // Nothing private travels: no home, no absolute path, no whole repository.
  const everything = pkg.fileList.map((f) => String(pkg.files[f])).join('\n');
  assert.equal(everything.includes(os.homedir()), false);
  assert.equal(everything.includes(SWIVEL), false);
  assert.equal(/\/\.git\//.test(everything), false);
  assert.equal(pkg.fileList.some((f) => /src\/Swivel|test\/spec|package-lock/.test(f)), false, 'the upstream repository is not copied wholesale');
  assert.match(pkg.packageHash, /^sha256:/);
  // Deterministic: the same organ packages identically.
  assert.equal(buildCapabilityPackage({ organDir, graftVersion: '0.0.0-test' }).packageHash, pkg.packageHash);
});

test('a library whose artifact changed after harvest cannot be exported under the recorded verified revision', skipWithoutSwivel, async (t) => {
  // A disposable clone: the donor checkout is never touched. The harvest records the revision and
  // the artifact identity; the export reads the artifact live, so the two must still agree.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-form-drift-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(home, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  const src = path.join(home, 'swiveljs');
  const git = (args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd: src, encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['clone', '-q', SWIVEL, src], { stdio: 'pipe' });
  const { manifest, verification } = await harvestCapability(fingerprintProject(src), 'feature-flags-library');
  assert.equal(verification.verdict, 'VERIFIED');
  const harvestedHead = manifest.provenance.verifiedInSource.sourceState.head;
  writeManifest(bankDir(), manifest);
  const organDir = path.join(bankDir(), 'feature-flags-library.graft');
  // Unchanged checkout: the export succeeds and names the harvested revision.
  const intact = buildCapabilityPackage({ organDir, graftVersion: '0.0.0-test' });
  assert.equal(JSON.parse(intact.files['feature-flags-library/graft-capability.json']).source.revision, harvestedHead);
  // The artifact changes after the harvest and the checkout moves on.
  fs.appendFileSync(path.join(src, manifest.architecture.capabilityModel.artifact.entry), '\n;globalThis.__changedAfterHarvest = true;\n');
  git(['add', '-A']); git(['commit', '-qm', 'change the artifact after harvest']);
  assert.notEqual(git(['rev-parse', 'HEAD']), harvestedHead);
  assert.throws(() => buildCapabilityPackage({ organDir, graftVersion: '0.0.0-test' }), (err) => err.code === 'artifact-identity-mismatch' && /not the artifact GRAFT verified/.test(err.message) && /Harvest the capability again/.test(err.remedy || ''));
  // Nothing was written into the bank or the source: the organ still records the harvested identity, and no package exists.
  assert.equal(readManifest(organDir).provenance.verifiedInSource.sourceState.head, harvestedHead);
  assert.equal(fs.existsSync(path.join(home, 'home', 'exports')), false);
  // Restoring the verified bytes (a new commit, same artifact) makes the export possible again: identity is about bytes, not HEAD.
  git(['revert', '--no-edit', 'HEAD']);
  const restored = buildCapabilityPackage({ organDir, graftVersion: '0.0.0-test' });
  assert.equal(restored.packageHash, intact.packageHash, 'the same verified artifact packages identically');
});

test('the library is a real Laboratory candidate, integrable only where an adaptation is proven', skipWithoutSwivel, async (t) => {
  await bankedLibrary(t);
  const bp = createBlueprint({ name: 'Flagged application', hostIntent: 'new-application' });
  const goal = addGoal(bp, { category: 'feature-flags' });
  const candidate = analyseBlueprint(bp, { index: EMPTY_INDEX }).goals[0].candidates.find((c) => c.kind === 'organ');
  // Visible, selectable, and honest about both claims.
  assert.equal(candidate.implementationForm, 'library');
  assert.equal(candidate.verification.source, 'VERIFIED');
  assert.equal(candidate.origin.kind, 'open-source');
  assert.equal(candidate.origin.licence.declared, 'MIT');
  // 0.1b Checkpoint B: a destination integration now exists, and the candidate names exactly the
  // host shape that was proven rather than claiming general support.
  assert.equal(candidate.integration.supported, true);
  assert.match(candidate.integration.reason, /node \/ esm esm-node-http-central application/);
  assert.match(candidate.integration.reason, /other destination shapes are not proven yet/);
  assert.deepEqual(candidate.integration.targets.map((x) => x.profile), ['esm-node-http-central']);
  selectImplementation(bp, goal.goalId, { kind: 'organ', slug: candidate.slug, capabilityId: candidate.capabilityId, name: candidate.name });
  assert.equal(analyseBlueprint(bp, { index: EMPTY_INDEX }).readiness, 'READY_FOR_ASSEMBLY_PLANNING', 'the person may select it');
  // The proven host shape is assemblable; every other host is still refused, and never as a
  // transplant. A library is never routed through the service emitter.
  const proven = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-http-central'), index: EMPTY_INDEX });
  assert.equal(proven.readiness, 'READY_TO_ASSEMBLE', JSON.stringify(proven.blockers));
  assert.equal(proven.executable, true);
  assert.ok(proven.steps.some((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY' && s.supported === true));
  assert.equal(proven.steps.some((s) => s.type === 'TRANSPLANT_CAPABILITY'), false, 'a library is never emitted as a service');

  const express = buildAssemblyPlan(bp, { host: newHostSpecification('node-esm-express'), index: EMPTY_INDEX });
  assert.equal(express.readiness, 'BLOCKED_CAPABILITY_SUPPORT');
  assert.equal(express.executable, false);
  const blocker = express.blockers.find((b) => b.kind === 'capability-unsupported');
  assert.match(blocker.detail, /no proven adaptation writes feature-flags in library form into the express-req-res host/);
  assert.equal(/npm install/.test(blocker.detail), false, 'the blocker names the missing operation, not a guess about packaging');
  assert.equal(express.steps.some((s) => s.type === 'TRANSPLANT_CAPABILITY' && s.supported === true), false);
});
