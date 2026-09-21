// Library Host Adaptation 0.1b — Checkpoint A.
//
// Proves the adaptation core for one capability kind in library form into one destination host
// profile: interoperability measured rather than assumed, artifact identity enforced before any
// write, a narrowly-scoped structural support predicate, a generated adapter, destination proof
// through the shared verdict authority, host preservation with a baseline captured first, and the
// refusals. Nothing here installs, builds or reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvest } from '../src/harvest/index.js';
import { buildHostModel } from '../src/engine/host.js';
import { hostPreservationTests } from '../src/plan/index.js';
import { prepareTransplant } from '../src/apply/worktree.js';
import { LIBRARY_HOST_ADAPTATIONS, INTEROP, libraryHostAdaptationSupport, checkArtifactIdentity,
  adaptLibraryCapability, applyLibraryAdaptation, destinationVerificationContract, libraryArtifactOf } from '../src/adapt/library-host.js';
import { verifyAdaptedLibraryCapability, captureAdaptationHostBaseline, verifyHostPreservation } from '../src/adapt/verify.js';

const SWIVEL = path.join(os.homedir(), 'Developer/GRAFT-Dogfood/swiveljs');
const haveSwivel = fs.existsSync(path.join(SWIVEL, 'dist/swivel.js'));
const needSwivel = { skip: haveSwivel ? false : 'the SwivelJS checkout is not present' };
const ESM_HOST = { profile: 'esm-node-http-central', moduleSystem: 'esm' };
const libraryManifest = () => harvest(fingerprintProject(SWIVEL), 'feature-flags-library');
/** assert.throws does not hand back the error, and these refusals carry codes worth asserting. */
const thrown = (fn) => { try { fn(); return null; } catch (error) { return error; } };
const tmp = (t, prefix = 'graft-adapt-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A minimal destination of the proven shape: an ESM package with a node:http central handler. */
function esmHost(dir, { name = 'probe-host' } = {}) {
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', engines: { node: '>=20' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'server.mjs'), `import http from 'node:http';
const json = (res, status, body) => { const p = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(p) }); res.end(p); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/') return json(res, 200, { name: ${JSON.stringify(name)} });
  return json(res, 404, { error: 'not-found' });
});
server.listen(Number(process.env.PORT || 3000));
`);
  return dir;
}

// ---------------------------------------------------------------------------------------------
// 1. Interoperability: measured on this runtime, not assumed.
// ---------------------------------------------------------------------------------------------
test('the recorded CommonJS/ESM interop facts are what this Node runtime actually does', needSwivel, async (t) => {
  const dir = tmp(t, 'graft-interop-');
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "interop", "type": "module" }\n');
  const source = fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'));
  fs.writeFileSync(path.join(dir, 'swivel.js'), source);
  fs.writeFileSync(path.join(dir, 'swivel.cjs'), source);
  // Renaming changes nothing about the bytes.
  assert.equal(Buffer.compare(source, fs.readFileSync(path.join(dir, 'swivel.cjs'))), 0, 'the .cjs copy is byte-identical');

  const run = (body) => {
    const file = path.join(dir, `probe-${crypto.randomBytes(3).toString('hex')}.mjs`);
    fs.writeFileSync(file, body);
    try { return { ok: true, out: JSON.parse(execFileSync(process.execPath, ['--no-warnings', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })) }; }
    catch (error) { return { ok: false, stderr: String(error.stderr || error.message) }; }
  };

  // The trap: as .js inside an ESM package the artifact imports WITHOUT error, exports nothing,
  // and assigns a global instead. Anything built on that would look like it worked.
  const asJs = run(`const m = await import('./swivel.js');
    console.log(JSON.stringify({ keys: Object.keys(m), global: typeof globalThis.Swivel }));`);
  assert.equal(asJs.ok, true, 'the .js import does not throw — which is exactly why it is unsafe');
  assert.deepEqual(asJs.out.keys, [], 'it exports nothing');
  assert.equal(asJs.out.global, 'function', 'it silently assigns a global instead');

  // require() cannot reach it either: the package type makes .js an ES module.
  const required = run(`import { createRequire } from 'node:module';
    const m = createRequire(import.meta.url)('./swivel.js');
    console.log(JSON.stringify({ type: typeof m, keys: Object.keys(m) }));`);
  assert.equal(required.out?.keys.length, 0, 'require() of the .js yields no usable export');

  // The chosen mechanism: a static default import of the byte-identical .cjs copy. It works, and
  // it leaves no global behind.
  const chosen = run(`import Library from './swivel.cjs';
    const before = typeof globalThis.Swivel;
    const s = new Library({ map: { a: [1] }, bucketIndex: 1 });
    console.log(JSON.stringify({ isFn: typeof Library === 'function', on: s.returnValue('a', 'on', 'off'), globalBefore: before, globalAfter: typeof globalThis.Swivel }));`);
  assert.equal(chosen.ok, true);
  assert.equal(chosen.out.isFn, true);
  assert.equal(chosen.out.on, 'on');
  assert.equal(chosen.out.globalAfter, 'undefined', 'the chosen mechanism pollutes no global');

  // A NAMED import is not available: the UMD assigns its export dynamically.
  const named = run(`import { Swivel } from './swivel.cjs'; console.log(JSON.stringify({ t: typeof Swivel }));`);
  assert.equal(named.ok, false);
  assert.match(named.stderr, /Named export 'Swivel' not found/);

  // The module's recorded claims match all of the above.
  assert.equal(INTEROP.chosen, 'byte-identical .cjs copy + static ESM default import');
  assert.deepEqual(INTEROP.mechanisms.filter((m) => m.works).map((m) => m.id), ['esm-import-dot-cjs', 'create-require-dot-cjs']);
  assert.ok(INTEROP.mechanisms.filter((m) => !m.works).every((m) => m.rejected), 'every rejected mechanism says why');
});

// ---------------------------------------------------------------------------------------------
// 2. Structural support: narrow, and derived from capability evidence only.
// ---------------------------------------------------------------------------------------------
test('adaptation support is structural, and refuses every shape it has not proven', needSwivel, () => {
  const m = libraryManifest();
  const ok = libraryHostAdaptationSupport({ manifest: m, host: ESM_HOST });
  assert.equal(ok.supported, true, ok.checks.filter((c) => !c.ok).map((c) => c.detail).join('; '));
  assert.equal(ok.adaptation, 'feature-flags-library-into-esm-node-http-central');
  assert.ok(ok.checks.every((c) => c.ok === true));

  // A service-form capability is not a library: the library adapter refuses it.
  const asService = { ...m, identity: { ...m.identity, implementationForm: 'service' } };
  const service = libraryHostAdaptationSupport({ manifest: asService, host: ESM_HOST });
  assert.equal(service.supported, false);
  assert.match(service.checks.find((c) => c.id === 'capability-kind').detail, /service form/);

  // A different capability kind in library form has no proven adaptation.
  const otherKind = { ...m, identity: { ...m.identity, category: 'session-auth' } };
  assert.equal(libraryHostAdaptationSupport({ manifest: otherKind, host: ESM_HOST }).supported, false);

  // An unsupported host is refused, and named.
  for (const host of [{ profile: 'express-req-res', moduleSystem: 'esm' }, { profile: 'esm-return-response', moduleSystem: 'esm' }, { profile: null, moduleSystem: 'cjs' }]) {
    const r = libraryHostAdaptationSupport({ manifest: m, host });
    assert.equal(r.supported, false, `${host.profile} must not be supported yet`);
    assert.equal(r.checks.find((c) => c.id === 'host-profile').ok, false);
  }

  // A library that declares HTTP surface is a service in disguise: refused, so no fake-service path.
  const withEndpoint = structuredClone(m);
  withEndpoint.architecture.capabilityModel.endpoints = [{ role: 'list', method: 'GET', path: '/flags' }];
  const shaped = libraryHostAdaptationSupport({ manifest: withEndpoint, host: ESM_HOST });
  assert.equal(shaped.supported, false);
  assert.match(shaped.checks.find((c) => c.id === 'library-shaped').detail, /that is a service, not a library/);

  // Missing a proven operation role is refused rather than worked around.
  const noBranch = structuredClone(m);
  noBranch.architecture.capabilityModel.operations = noBranch.architecture.capabilityModel.operations.filter((o) => o.role !== 'invoke-branch');
  const roles = libraryHostAdaptationSupport({ manifest: noBranch, host: ESM_HOST });
  assert.equal(roles.supported, false);
  assert.match(roles.checks.find((c) => c.id === 'verified-operations').detail, /invoke-branch/);

  // A different configuration shape is a different capability, not this one.
  const otherConfig = structuredClone(m);
  otherConfig.architecture.capabilityModel.configuration.contextShape = 'user-attributes';
  assert.equal(libraryHostAdaptationSupport({ manifest: otherConfig, host: ESM_HOST }).supported, false);

  // An ESM artifact is outside the proven shape: the interop mechanism was measured for CommonJS.
  const esmArtifact = structuredClone(m);
  esmArtifact.architecture.capabilityModel.artifact.moduleSystem = 'esm';
  assert.equal(libraryHostAdaptationSupport({ manifest: esmArtifact, host: ESM_HOST }).supported, false);

  // The table itself stays narrow.
  assert.equal(LIBRARY_HOST_ADAPTATIONS.length, 1, 'only the shape that was actually proven is listed');
});

test('adaptation authority names no upstream package, repository or revision', () => {
  const sources = ['../src/adapt/library-host.js', '../src/adapt/verify.js']
    .map((f) => fs.readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8'));
  // The INTEROP record quotes a measured error message, which legitimately names the export it
  // could not find; support and adaptation logic must not branch on any upstream identity.
  const logic = sources.map((s) => s.split('export const INTEROP')[0] + (s.split('});').slice(-1)[0] || '')).join('\n');
  for (const token of ['swiveljs', 'zumba', 'f4d6efd', 'github.com']) {
    assert.equal(new RegExp(token, 'i').test(logic), false, `adaptation logic must not mention ${token}`);
  }
  // And nothing anywhere keys a decision off a package name.
  for (const s of sources) assert.equal(/packageName\s*===/.test(s), false, 'no branch on a package name');
});

// ---------------------------------------------------------------------------------------------
// 3. Artifact identity, enforced before anything is written.
// ---------------------------------------------------------------------------------------------
test('the artifact GRAFT verified is the only artifact it will adapt', needSwivel, (t) => {
  const m = libraryManifest();
  const good = checkArtifactIdentity({ manifest: m, sourceRoot: SWIVEL });
  assert.equal(good.matched, true);
  assert.equal(good.expected, libraryArtifactOf(m).recordedSha256);
  assert.equal(good.actualFull, crypto.createHash('sha256').update(fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'))).digest('hex'));

  // A source whose artifact differs by one byte is not the verified artifact.
  const altered = tmp(t, 'graft-altered-');
  fs.mkdirSync(path.join(altered, 'dist'));
  fs.copyFileSync(path.join(SWIVEL, 'package.json'), path.join(altered, 'package.json'));
  fs.writeFileSync(path.join(altered, 'dist/swivel.js'), `${fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'), 'utf8')}\n// tampered\n`);
  const bad = checkArtifactIdentity({ manifest: m, sourceRoot: altered });
  assert.equal(bad.matched, false);
  assert.equal(bad.reason, 'artifact-identity-mismatch');
  assert.match(bad.detail, /is not the artifact GRAFT verified/);

  // THE REFUSAL: adaptation stops, and writes nothing into the destination.
  const dest = esmHost(tmp(t, 'graft-dest-'));
  const before = fs.readdirSync(dest).sort();
  const error = thrown(() => adaptLibraryCapability({ manifest: m, sourceRoot: altered, host: ESM_HOST }));
  assert.equal(error?.code, 'artifact-identity-mismatch');
  assert.equal(error.expected, good.expected);
  assert.notEqual(error.actual, good.expected);
  assert.deepEqual(fs.readdirSync(dest).sort(), before, 'no file is written into the destination when identity fails');
  assert.equal(fs.existsSync(path.join(dest, 'vendor')), false);
  assert.equal(fs.existsSync(path.join(dest, 'src')), false);

  // A missing artifact is refused too, and never treated as "nothing to check".
  const empty = tmp(t, 'graft-empty-');
  fs.writeFileSync(path.join(empty, 'package.json'), '{"name":"x"}');
  assert.equal(checkArtifactIdentity({ manifest: m, sourceRoot: empty }).reason, 'artifact-missing');
  // An unsupported shape is refused before identity is even consulted.
  const unsupported = thrown(() => adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: { profile: 'express-req-res', moduleSystem: 'esm' } }));
  assert.equal(unsupported?.code, 'adaptation-unsupported');
});

// ---------------------------------------------------------------------------------------------
// 4. The plan, the generated adapter and the writes.
// ---------------------------------------------------------------------------------------------
test('the adaptation plan describes writes only, and decides no verdict', needSwivel, () => {
  const m = libraryManifest();
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: ESM_HOST });
  assert.equal(plan.adaptationStatus, 'planned');
  assert.equal(plan.verdict, null, 'a plan never carries a verdict');
  assert.equal(plan.authority.verdictDecidedHere, false);
  assert.equal(plan.artifactIdentity.byteIdentical, true);
  assert.deepEqual(plan.files.map((f) => f.path), ['vendor/swivel.cjs', 'vendor/swivel.LICENSE', 'vendor/swivel.provenance.json', 'src/feature-flags.js']);
  // Only the adapter and the provenance record are GRAFT's; the artifact and licence are not.
  assert.deepEqual(plan.files.filter((f) => f.authoredBy === 'GRAFT').map((f) => f.path), ['vendor/swivel.provenance.json', 'src/feature-flags.js']);
  assert.ok(plan.files.filter((f) => f.authoredBy === 'third-party').every((f) => f.verbatim === true));
  // The vendored artifact is the source bytes, unchanged.
  assert.equal(Buffer.compare(plan.files[0].contents, fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'))), 0);

  const adapter = plan.files.find((f) => f.path === 'src/feature-flags.js').contents.toString('utf8');
  // The adapter exposes exactly the three operations the source proved, and no HTTP at all.
  assert.match(adapter, /import libraryExport from '\.\.\/vendor\/swivel\.cjs'/, 'a static default import of the .cjs artifact');
  assert.match(adapter, /isEnabled\(featureName\)/);
  assert.match(adapter, /choose\(featureName, enabledValue, disabledValue\)/);
  assert.match(adapter, /branch\(featureName, onEnabled, onDisabled\)/);
  // Checked against the code, not the header: the provenance comment legitimately carries an https URL.
  const adapterCode = adapter.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
  assert.equal(/createRequire|require\(|node:http|createServer|express|fetch\(|res\.|req\.|'\/flags'|'\/features'/.test(adapterCode), false, `no require plumbing and no HTTP surface in the adapter: ${adapterCode}`);
  assert.match(adapter, /GRAFT did not author, modify, transpile,\n\/\/ bundle or rebuild/);

  // Every adapter operation maps to a source operation, and a normalised one says so.
  assert.deepEqual(plan.mapping.map((x) => x.adapterOperation), ['isEnabled(featureName)', 'choose(featureName, enabledValue, disabledValue)', 'branch(featureName, onEnabled, onDisabled)']);
  assert.ok(plan.mapping.every((x) => x.sourceOperation && x.sourceCall && x.provenBy.length));
  const predicate = plan.mapping[0];
  assert.equal(predicate.normalised, true);
  assert.equal(predicate.sourceCall, 'returnValue');
  assert.match(predicate.translation, /returnValue\(featureName, true, false\) === true/);
  assert.ok(plan.mapping.slice(1).every((x) => x.normalised === false), 'the other two are pass-throughs, not relabelling');
  // Every contract case names a mapping, and every mapping is covered by the contract.
  const contract = new Set(plan.verificationContract.map((c) => c.id));
  for (const x of plan.mapping) for (const id of x.provenBy) assert.ok(contract.has(id), `${id} is missing from the contract`);
});

test('applying an adaptation stays inside the destination and overwrites nothing', needSwivel, (t) => {
  const m = libraryManifest();
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: ESM_HOST });
  const dest = esmHost(tmp(t, 'graft-apply-'));
  const receipt = applyLibraryAdaptation({ plan, destinationRoot: dest });
  assert.equal(receipt.adaptationStatus, 'completed');
  assert.equal(receipt.verdict, null, 'a write receipt is not a verdict');
  assert.match(receipt.note, /decided by destination verification/);
  assert.equal(Buffer.compare(fs.readFileSync(path.join(dest, 'vendor/swivel.cjs')), fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'))), 0, 'byte-identical in the destination');
  // The host's own files are untouched.
  assert.match(fs.readFileSync(path.join(dest, 'server.mjs'), 'utf8'), /not-found/);

  // Applying again refuses rather than overwriting somebody's files.
  const again = thrown(() => applyLibraryAdaptation({ plan, destinationRoot: dest }));
  assert.equal(again?.code, 'adaptation-path-occupied');

  // A symlinked folder inside the destination must not let a write land outside it.
  const linked = esmHost(tmp(t, 'graft-link-'));
  const outside = tmp(t, 'graft-outside-');
  fs.symlinkSync(outside, path.join(linked, 'vendor'));
  const escape = thrown(() => applyLibraryAdaptation({ plan, destinationRoot: linked }));
  assert.equal(escape?.code, 'unsafe-adaptation-path', 'a symlinked folder must not be written through');
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written outside the destination');

  // A plan naming a path outside the destination is refused.
  for (const bad of ['../escape.js', '/etc/passwd', 'vendor/../../escape.js']) {
    const evil = { ...plan, files: [{ path: bad, contents: Buffer.from('x'), role: 'adapter', authoredBy: 'GRAFT' }] };
    const error = thrown(() => applyLibraryAdaptation({ plan: evil, destinationRoot: esmHost(tmp(t, 'graft-evil-')) }));
    assert.equal(error?.code, 'unsafe-adaptation-path', `${bad} must be refused`);
  }
});

test('the destination records the upstream repository, revision, licence and artifact hash', needSwivel, () => {
  const m = libraryManifest();
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: ESM_HOST });
  const p = plan.provenance;
  assert.match(p.source.repository, /zumba\/swiveljs/, 'the upstream repository, read from the source checkout');
  assert.equal(p.source.revision, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SWIVEL, encoding: 'utf8' }).trim());
  assert.equal(p.licence.declared, 'MIT');
  assert.equal(p.licence.warning, null);
  assert.equal(p.artifact.sha256, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(SWIVEL, 'dist/swivel.js'))).digest('hex')}`);
  assert.equal(p.artifact.copiedVerbatim, true);
  assert.equal(p.artifact.renamed.from, 'swivel.js');
  assert.equal(p.artifact.renamed.to, 'swivel.cjs');
  assert.match(p.artifact.renamed.reason, /destination packaging only/);
  assert.match(p.note, /GRAFT did not author or modify it/);
  assert.equal(p.adaptation.adapterAuthoredBy, 'GRAFT');
  // The licence text travels verbatim.
  const licence = plan.files.find((f) => f.role === 'licence').contents.toString('utf8');
  assert.equal(licence, fs.readFileSync(path.join(SWIVEL, 'LICENSE'), 'utf8'));
  assert.match(licence, /MIT License/i);
});

test('a source with no licence file is adapted without inventing one', needSwivel, (t) => {
  const m = libraryManifest();
  // The same artifact, byte-for-byte, in a source that carries no licence file.
  const bare = tmp(t, 'graft-nolicence-');
  fs.mkdirSync(path.join(bare, 'dist'));
  fs.copyFileSync(path.join(SWIVEL, 'dist/swivel.js'), path.join(bare, 'dist/swivel.js'));
  fs.copyFileSync(path.join(SWIVEL, 'package.json'), path.join(bare, 'package.json'));
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: bare, host: ESM_HOST });
  // Identity still holds, and no licence file is fabricated.
  assert.equal(plan.artifactIdentity.byteIdentical, true);
  assert.deepEqual(plan.files.map((f) => f.path), ['vendor/swivel.cjs', 'vendor/swivel.provenance.json', 'src/feature-flags.js']);
  assert.equal(plan.files.some((f) => f.role === 'licence'), false);
  // The declaration the package makes is still reported, and the missing file is reported as missing.
  assert.equal(plan.provenance.licence.declared, 'MIT');
  assert.equal(plan.provenance.licence.file, null);
  assert.equal(plan.provenance.licence.originalFile, null);
  const adapter = plan.files.find((f) => f.role === 'adapter').contents.toString('utf8');
  assert.equal(/its licence is kept at/.test(adapter), false, 'the adapter does not point at a licence file that was not carried');
});

// ---------------------------------------------------------------------------------------------
// 5. Destination proof, and the failure modes.
// ---------------------------------------------------------------------------------------------
const adapted = (t, prefix) => {
  const m = libraryManifest();
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: ESM_HOST });
  const dest = esmHost(tmp(t, prefix));
  applyLibraryAdaptation({ plan, destinationRoot: dest });
  return { plan, dest };
};

test('the adapted capability is VERIFIED in the destination, through the shared verdict authority', needSwivel, async (t) => {
  const { plan, dest } = adapted(t, 'graft-verify-');
  const report = await verifyAdaptedLibraryCapability({ plan, destinationRoot: dest });
  assert.equal(report.verdict, 'VERIFIED', report.rationale);
  assert.equal(report.summary.required, 10);
  assert.equal(report.summary.passed, 10);
  assert.equal(report.proofOf, 'destination-adaptation', 'this proof is about the destination, not the source');
  // What ran was the generated adapter, and the report says so.
  assert.equal(report.runtime.entrypoint, 'src/feature-flags.js');
  assert.equal(report.runtime.profile, 'library-artifact');
  assert.match(report.rationale, /src\/feature-flags\.js/);
  // No adaptation-only verdict vocabulary anywhere.
  assert.equal(/ADAPTED|LIBRARY_OK|INTEGRATED|WORKS/.test(JSON.stringify(report)), false);
  // Every contract case covers a semantic the adapter genuinely exposes.
  assert.deepEqual(report.results.map((r) => r.outcome), Array(10).fill('passed'));
});

test('a semantic break in the destination is FAILED, not repaired and not excused', needSwivel, async (t) => {
  const { plan, dest } = adapted(t, 'graft-failed-');
  // Invert the predicate in the generated adapter: the capability now answers wrongly.
  const adapter = path.join(dest, 'src/feature-flags.js');
  fs.writeFileSync(adapter, fs.readFileSync(adapter, 'utf8').replace('returnValue(featureName, true, false) === true', 'returnValue(featureName, true, false) !== true'));
  const report = await verifyAdaptedLibraryCapability({ plan, destinationRoot: dest });
  assert.equal(report.verdict, 'FAILED');
  assert.ok(report.summary.failed > 0);
  assert.match(report.rationale, /required acceptance test\(s\) failed/);
  // The file was left broken: nothing repaired it.
  assert.match(fs.readFileSync(adapter, 'utf8'), /!== true/);
});

test('an unloadable artifact is NEEDS_REVIEW, never VERIFIED and never FAILED', needSwivel, async (t) => {
  const { plan, dest } = adapted(t, 'graft-review-');
  // Corrupt the vendored artifact so the adapter cannot load it at all.
  fs.writeFileSync(path.join(dest, 'vendor/swivel.cjs'), 'this is not valid javascript (((\n');
  const report = await verifyAdaptedLibraryCapability({ plan, destinationRoot: dest });
  assert.equal(report.verdict, 'NEEDS_REVIEW', report.rationale);
  assert.equal(report.summary.failed, 0, 'nothing was observed, so nothing failed');
  assert.equal(report.artifact.loaded, false);

  // A missing adapter is the same: no evidence, so no verdict either way.
  fs.rmSync(path.join(dest, 'src/feature-flags.js'));
  const gone = await verifyAdaptedLibraryCapability({ plan, destinationRoot: dest });
  assert.equal(gone.verdict, 'NEEDS_REVIEW');
});

// ---------------------------------------------------------------------------------------------
// 6. Host preservation — baseline first.
// ---------------------------------------------------------------------------------------------
test('host preservation captures a baseline before any write, and survives the adaptation', needSwivel, async (t) => {
  const m = libraryManifest();
  const dest = esmHost(tmp(t, 'graft-preserve-'));
  const probes = hostPreservationTests(fingerprintProject(dest), m);
  // BEFORE the writes. A baseline taken afterwards would compare the changed application with
  // itself and pass by construction (this went wrong once in 0.4a).
  const baseline = await captureAdaptationHostBaseline({ destinationRoot: dest, tests: probes });
  assert.equal(baseline.captured, true, baseline.reason || '');
  const byPath = new Map(baseline.observed.map((o) => [o.path, o.status]));
  assert.equal(byPath.get('/'), 200);
  assert.equal(byPath.get('/health'), 200);
  assert.equal(byPath.get('/%2e%2e/%2e%2e/%2e%2e/etc/passwd'), 404, 'the host refuses traversal deterministically');
  assert.equal(fs.existsSync(path.join(dest, 'vendor')), false, 'the baseline is captured before anything is written');

  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: ESM_HOST });
  applyLibraryAdaptation({ plan, destinationRoot: dest });
  const after = await verifyHostPreservation({ destinationRoot: dest, tests: baseline.tests });
  assert.equal(after.failed, 0, JSON.stringify(after.results));
  assert.equal(after.passed, after.tests);
  assert.equal(after.verdict, 'VERIFIED');
  assert.equal(after.proofOf, 'host-preservation');
});

test('a destination whose own behaviour breaks does not pass host preservation', needSwivel, async (t) => {
  const m = libraryManifest();
  const dest = esmHost(tmp(t, 'graft-broken-'));
  const baseline = await captureAdaptationHostBaseline({ destinationRoot: dest, tests: hostPreservationTests(fingerprintProject(dest), m) });
  assert.equal(baseline.captured, true);
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host: ESM_HOST });
  applyLibraryAdaptation({ plan, destinationRoot: dest });
  // Break the host's own health route, exactly the kind of damage preservation exists to catch.
  // A route that answers 5xx where the baseline saw 200 is a real failure of the host's behaviour.
  const server = path.join(dest, 'server.mjs');
  const healthy = fs.readFileSync(server, 'utf8');
  fs.writeFileSync(server, healthy.replace('return json(res, 200, { ok: true });', "return json(res, 500, { error: 'broken' });"));
  const broken = await verifyHostPreservation({ destinationRoot: dest, tests: baseline.tests });
  assert.equal(broken.verdict, 'FAILED', JSON.stringify(broken.results));
  assert.ok(broken.failed > 0, 'a host route answering 5xx must fail preservation');

  // A host that cannot serve at all yields no evidence: NEEDS_REVIEW, never a pass.
  fs.writeFileSync(server, healthy.replace('return json(res, 200, { ok: true });', "throw new Error('broken');"));
  const crashed = await verifyHostPreservation({ destinationRoot: dest, tests: baseline.tests });
  assert.notEqual(crashed.verdict, 'VERIFIED', 'a host that stops answering never passes preservation');
  assert.equal(crashed.passed, 0);
});

// ---------------------------------------------------------------------------------------------
// 7. The whole operation, through the managed worktree, against the real host shape.
// ---------------------------------------------------------------------------------------------
test('the adaptation runs in a managed worktree and leaves the source and the checkout alone', needSwivel, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-worktree-'));
  const previous = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });

  const { createHost } = await import('../src/laboratory/execution.js');
  const parent = fs.mkdirSync(path.join(work, 'projects'), { recursive: true }) || path.join(work, 'projects');
  const receipt = createHost({ parentDir: parent, name: 'flag-host', architectureId: 'node-esm-http-central' });
  const hostRoot = receipt.root;
  assert.equal(receipt.fingerprint.profile, 'esm-node-http-central');
  assert.deepEqual(receipt.remotes, [], 'the host has no remote, so nothing can be pushed');

  const m = libraryManifest();
  const hostFp = fingerprintProject(hostRoot);
  const host = { profile: buildHostModel(hostFp).constraints.adaptationProfile, moduleSystem: hostFp.moduleSystem.value };
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim();
  const sourceHeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SWIVEL, encoding: 'utf8' }).trim();
  const sourceStatusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: SWIVEL, encoding: 'utf8' });

  const transplant = prepareTransplant({ destinationRoot: hostRoot, sourceRoot: SWIVEL, capabilitySlug: 'feature-flags-library', fromRevision: head });
  const wt = transplant.worktree.path;
  assert.equal(transplant.baseHead, head, 'the worktree is cut from the host revision that was planned');
  assert.notEqual(path.resolve(wt), path.resolve(hostRoot), 'the worktree is not the checkout');

  const baseline = await captureAdaptationHostBaseline({ destinationRoot: wt, tests: hostPreservationTests(hostFp, m) });
  assert.equal(baseline.captured, true);
  const plan = adaptLibraryCapability({ manifest: m, sourceRoot: SWIVEL, host });
  applyLibraryAdaptation({ plan, destinationRoot: wt });

  const verification = await verifyAdaptedLibraryCapability({ plan, destinationRoot: wt });
  assert.equal(verification.verdict, 'VERIFIED', verification.rationale);
  const preservation = await verifyHostPreservation({ destinationRoot: wt, tests: baseline.tests });
  assert.equal(preservation.failed, 0);

  // Everything was written in the worktree; the checkout and the source are untouched.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: hostRoot, encoding: 'utf8' }).trim(), '', 'the primary checkout is unchanged');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: hostRoot, encoding: 'utf8' }).trim(), head);
  assert.equal(fs.existsSync(path.join(hostRoot, 'vendor')), false, 'nothing was written into the checkout');
  assert.equal(fs.existsSync(path.join(hostRoot, 'src')), false);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SWIVEL, encoding: 'utf8' }).trim(), sourceHeadBefore, 'the source repository is unchanged');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: SWIVEL, encoding: 'utf8' }), sourceStatusBefore);
  const changed = execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(changed, ['?? src/', '?? vendor/'], 'the worktree carries exactly the adaptation');
  // The worktree lives under GRAFT_HOME, so no remote of the person's was touched.
  assert.ok(path.resolve(wt).startsWith(path.resolve(process.env.GRAFT_HOME)));
});

// ---------------------------------------------------------------------------------------------
// 8. Authority: what this checkpoint deliberately does NOT do yet.
// ---------------------------------------------------------------------------------------------
test('adaptation cannot reach the verdict engine, and the planner asks it rather than copying it', async () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../src/adapt/library-host.js', import.meta.url)), 'utf8');
  // Comments may explain the rule; the code must not be able to apply it. Strip line comments and
  // block comments, then look for any verdict the module could produce.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(/decideVerdict|VERIFIED|NEEDS_REVIEW|'FAILED'/.test(code), false, 'the adaptation module cannot name or reach a verdict');
  assert.equal(/runLibrarySuite|runAcceptanceSuite|captureHostBaseline/.test(code), false, 'adaptation does not run verification itself');
  assert.equal(/from '\.\.\/verify\//.test(code), false, 'adaptation does not import the verification machinery at all');

  // Checkpoint B wired this into the planner. The requirement that survives is that there is ONE
  // definition of what can be adapted: the planner asks this authority and never re-decides it.
  const assembly = fs.readFileSync(fileURLToPath(new URL('../src/laboratory/assembly.js', import.meta.url)), 'utf8');
  assert.match(assembly, /import \{ libraryHostAdaptationSupport.*\} from '\.\.\/adapt\/library-host\.js'/);
  assert.match(assembly, /libraryHostAdaptationSupport\(\{ manifest, host/);
  // The planner must not reimplement the predicate or reach past it into the table of shapes.
  for (const copied of ['artifactModuleSystems', 'operationRoles', "configuration.shape", 'vendorDir']) {
    assert.equal(assembly.includes(copied), false, `the planner must not re-decide ${copied}; that belongs to the adaptation authority`);
  }
});
