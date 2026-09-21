import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { harvestCapability } from '../src/harvest/index.js';
import { writeManifest, readOrganEngine } from '../src/manifest/io.js';
import { buildCapabilityPackage, exportCapabilityPackage, readZip, zipBuffer, crc32, detectLicense, loadExportReceipts, alternateDestination, LICENSE_WARNING, PACKAGE_SCHEMA_VERSION } from '../src/export/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const write = (root, files) => { for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } return root; };
function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-export-')));
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = path.join(work, 'home');
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; fs.rmSync(work, { recursive: true, force: true }); });
  return work;
}
const SECRET = 'sk_live_this_value_must_never_travel';
/** A harvestable session-auth source: the fixture copied, with a licence, a git identity, and a .env full of values. */
async function organ(t, work, { licence = 'MIT', gitInit = true } = {}) {
  const src = path.join(work, 'source');
  fs.cpSync(path.join(repoRoot, 'fixtures/old-saas-project'), src, { recursive: true, filter: (f) => !['node_modules', '.git'].includes(path.basename(f)) });
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  if (licence) { pkg.license = licence; fs.writeFileSync(path.join(src, 'LICENSE'), `${licence} License\n\nCopyright (c) Example Author\n`); } else { delete pkg.license; fs.rmSync(path.join(src, 'LICENSE'), { force: true }); }
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify(pkg, null, 2));
  write(src, { '.env': `SESSION_SECRET=${SECRET}\nDATABASE_URL=postgres://user:${SECRET}@db/app\n`, 'id_rsa': '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' });
  if (gitInit) { const git = (args) => execFileSync('git', args, { cwd: src, stdio: 'pipe' }); git(['init', '-q', '-b', 'main']); git(['remote', 'add', 'origin', 'https://token123@github.com/example/old-saas.git']); git(['add', '-A']); git(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']); }
  const { manifest, verification } = await harvestCapability(fingerprintProject(src), 'authentication');
  assert.equal(verification.verdict, 'VERIFIED');
  const organDir = path.join(work, 'home', 'organ-bank', `${manifest.identity.slug}.graft`);
  writeManifest(path.join(work, 'home', 'organ-bank'), manifest);
  return { src, organDir, manifest };
}

test('a package holds GRAFT\'s regenerated implementation plus honest metadata, and nothing from the source checkout', async (t) => {
  const work = sandbox(t);
  const { src, organDir, manifest: harvested } = await organ(t, work);
  // Revision-bound Capability Memory: the harvest records the repository identity beside the
  // revision it verified (credential stripped), and the export names THAT revision — even after the
  // source checkout has moved on, because the evidence is about the harvested revision, not HEAD.
  const recorded = harvested.provenance.verifiedInSource.sourceState;
  assert.equal(recorded.remote, 'https://github.com/example/old-saas.git');
  assert.match(recorded.head, /^[0-9a-f]{40}$/); assert.equal(recorded.dirty, false);
  fs.writeFileSync(path.join(src, 'later.txt'), 'a change after the harvest\n');
  execFileSync('git', ['add', '-A'], { cwd: src, stdio: 'pipe' }); execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'later'], { cwd: src, stdio: 'pipe' });
  assert.notEqual(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim(), recorded.head, 'the checkout moved');
  const built = buildCapabilityPackage({ organDir, graftVersion: '0.5.0' });
  assert.equal(JSON.parse(built.files['authentication/graft-capability.json']).source.revision, recorded.head, 'the package names the revision its evidence came from, not the checkout\'s current HEAD');
  assert.equal(built.name, 'authentication');
  assert.equal(built.profile, 'esm-return-response', 'the least framework-bound profile that can write the kind');
  const names = built.fileList.map((f) => f.replace('authentication/', ''));
  for (const required of ['GRAFT.md', 'graft-capability.json', 'dependencies.json', 'configuration.example', 'verification-contract.json', 'provenance.json', 'LICENSES/LICENSE']) assert.ok(names.includes(required), required);
  assert.ok(names.filter((n) => n.startsWith('src/')).length >= 3, 'the regenerated implementation is under src/');
  // Nothing copied from the source: none of the source's own files, secrets, or private paths.
  const text = Object.values(built.files).map(String).join('\n');
  for (const forbidden of [SECRET, 'BEGIN PRIVATE KEY', 'postgres://', src, os.homedir(), process.env.GRAFT_HOME, 'token123@']) assert.equal(text.includes(forbidden), false, `must not contain ${forbidden}`);
  assert.equal(names.some((n) => /\.env|id_rsa|node_modules|\.git\//.test(n)), false);
  const manifest = JSON.parse(built.files['authentication/graft-capability.json']);
  assert.equal(manifest.schemaVersion, PACKAGE_SCHEMA_VERSION);
  assert.equal(manifest.kind, 'session-auth');
  assert.match(manifest.capabilityId, /^sha256:/);
  assert.match(manifest.genomeId, /^sha256:/);
  assert.match(manifest.verificationContractId, /^sha256:/);
  assert.deepEqual(manifest.implementation.files, names.filter((n) => n.startsWith('src/')).sort());
  assert.equal(manifest.source.remote, 'https://github.com/example/old-saas.git', 'the remote is kept without its credential');
  assert.match(manifest.source.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.verification.source.verdict, 'VERIFIED');
  assert.equal(manifest.verification.universalCompatibility, 'not-claimed');
  assert.ok(manifest.configuration.every((c) => typeof c.name === 'string' && !('value' in c)));
  const config = built.files['authentication/configuration.example'];
  for (const line of config.split('\n').filter((l) => l && !l.startsWith('#'))) assert.match(line, /^[A-Z0-9_]+=$/, `names only: ${line}`);
  const deps = JSON.parse(built.files['authentication/dependencies.json']);
  assert.ok(Array.isArray(deps.runtime) && deps.runtime.some((r) => r.name === 'node'));
  assert.ok(Array.isArray(deps.packages));
  assert.match(deps.installation, /installs nothing/);
  const contract = JSON.parse(built.files['authentication/verification-contract.json']);
  assert.equal(contract.contract.contractId, manifest.verificationContractId);
  assert.ok(contract.acceptanceTests.length > 0);
  assert.equal(contract.verification.universalCompatibility, 'not-claimed');
  const provenance = JSON.parse(built.files['authentication/provenance.json']);
  assert.equal(provenance.sourceProject.remote, 'https://github.com/example/old-saas.git');
  assert.equal(provenance.licence.state, 'detected');
  assert.equal(provenance.licence.declared, 'MIT');
  assert.ok(provenance.evidence.detectorSignals.every((s) => !s.evidence.includes(src)));
  assert.match(built.files['authentication/GRAFT.md'], /Universal compatibility: NOT CLAIMED/);
  assert.match(built.files['authentication/GRAFT.md'], /Adaptation may be required/);
  assert.doesNotMatch(built.files['authentication/GRAFT.md'], /drop this into any project/i);
  assert.match(built.files['authentication/LICENSES/LICENSE'], /MIT License/);
});

test('packages are deterministic: same organ, same revision, same version, same hash; timestamps live only in the receipt', async (t) => {
  const work = sandbox(t);
  const { organDir } = await organ(t, work);
  const a = buildCapabilityPackage({ organDir, graftVersion: '0.5.0' });
  const b = buildCapabilityPackage({ organDir, graftVersion: '0.5.0' });
  assert.equal(a.packageHash, b.packageHash);
  assert.deepEqual(a.files, b.files);
  assert.equal(JSON.stringify(a.files).includes(new Date().getFullYear() + '-'), false, 'no ISO timestamps inside the package');
  const c = buildCapabilityPackage({ organDir, graftVersion: '0.6.0' });
  assert.notEqual(c.packageHash, a.packageHash, 'the GRAFT version is part of the logical contents');
  assert.equal(zipBuffer(a.files).equals(zipBuffer(b.files)), true, 'the archive bytes are deterministic too');
});

test('licence handling preserves what was detected and warns when nothing was', async (t) => {
  const work = sandbox(t);
  const { organDir } = await organ(t, work, { licence: null });
  const built = buildCapabilityPackage({ organDir, graftVersion: '0.5.0' });
  // The fixture is marked private and declares nothing: the precise state, with the caution.
  assert.equal(built.licence.state, 'private-unspecified');
  assert.match(built.licence.warning, /Confirm you have the right to reuse or distribute/);
  assert.match(built.files['authentication/GRAFT.md'], /Confirm you have the right to reuse or distribute/);
  const nothing = detectLicense(write(path.join(work, 'none'), { 'package.json': '{"name":"x"}' }));
  assert.equal(nothing.state, 'not-detected'); assert.equal(nothing.warning, LICENSE_WARNING);
  const two = detectLicense(write(path.join(work, 'two'), { 'package.json': '{"name":"x","license":"MIT"}', 'LICENSE': 'Apache License\nVersion 2.0\n' }));
  assert.equal(two.state, 'multiple-detected');
  assert.equal(built.fileList.some((f) => f.includes('LICENSES/')), false);
  assert.doesNotMatch(built.files['authentication/GRAFT.md'], /safe for commercial use/i);
  const detected = detectLicense(write(path.join(work, 'lic'), { 'package.json': '{"name":"x","license":"Apache-2.0"}', 'LICENSE': 'Apache License\nVersion 2.0\n' }));
  assert.equal(detected.state, 'detected'); assert.equal(detected.declared, 'Apache-2.0'); assert.equal(detected.warning, null);
  assert.equal(detectLicense(write(path.join(work, 'priv'), { 'package.json': '{"name":"x","private":true}' })).state, 'private-unspecified');
  assert.match(detectLicense(write(path.join(work, 'unl'), { 'package.json': '{"name":"x","license":"UNLICENSED"}' })).warning, /UNLICENSED/);
  // A licence "file" that is a symlink is never followed.
  const linked = write(path.join(work, 'linked'), { 'package.json': '{"name":"x"}' });
  fs.symlinkSync('/etc/hosts', path.join(linked, 'LICENSE'));
  assert.deepEqual(detectLicense(linked).files, []);
});

test('the archive is written atomically to an explicit destination, refuses unsafe places, and handles collisions deterministically', async (t) => {
  const work = sandbox(t);
  const { src, organDir } = await organ(t, work);
  const out = path.join(work, 'out'); fs.mkdirSync(out);
  const receiptsFile = path.join(work, 'home', 'exports', 'receipts.json');
  const destination = path.join(out, 'authentication.zip');
  const { receipt, package: pkg } = exportCapabilityPackage({ organDir, destination, graftVersion: '0.5.0', receiptsFile, now: () => '2026-01-01T00:00:00.000Z' });
  assert.equal(fs.existsSync(destination), true);
  assert.deepEqual(fs.readdirSync(out), ['authentication.zip'], 'no temporary part file remains');
  const entries = readZip(fs.readFileSync(destination));
  assert.deepEqual(Object.keys(entries).sort(), pkg.files);
  assert.equal(receipt.kind, 'CapabilityExportReceipt');
  assert.equal(receipt.packageHash, pkg.packageHash);
  assert.equal(receipt.exportedFileCount, pkg.files.length);
  assert.equal(receipt.destination, destination);
  assert.equal(receipt.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(receipt.verification.universalCompatibility, 'not-claimed');
  assert.equal(loadExportReceipts({ file: receiptsFile }).receipts.length, 1);
  assert.ok(!('verdict' in receipt) && !JSON.stringify(receipt).includes('"VERIFIED"') || receipt.verification.source === 'VERIFIED', 'the receipt reports the source verdict but is not itself a verdict');
  // Collision: refused, then replaced only on request, or given a deterministic sibling name.
  assert.throws(() => exportCapabilityPackage({ organDir, destination, graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'destination-exists');
  const alt = exportCapabilityPackage({ organDir, destination, graftVersion: '0.5.0', receiptsFile, alternate: true });
  assert.equal(path.basename(alt.receipt.destination), 'authentication-2.zip');
  assert.equal(alternateDestination(destination), path.join(out, 'authentication-3.zip'));
  const over = exportCapabilityPackage({ organDir, destination, graftVersion: '0.5.0', receiptsFile, overwrite: true });
  assert.equal(over.receipt.destination, destination);
  // Unsafe destinations: inside the source checkout, inside the organ bank, through a symlinked folder, not a .zip, relative, traversal.
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(src, 'pkg.zip'), graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'destination-inside-source');
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(organDir, 'pkg.zip'), graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'destination-inside-source');
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(work, 'home', 'organ-bank', 'sibling.zip'), graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'destination-inside-source', 'the bank folder itself is refused');
  fs.mkdirSync(path.join(work, 'home', 'exports'), { recursive: true });
  assert.equal(path.basename(exportCapabilityPackage({ organDir, destination: path.join(work, 'home', 'exports', 'default.zip'), graftVersion: '0.5.0', receiptsFile }).receipt.destination), 'default.zip', 'GRAFT\'s own exports folder stays allowed');
  fs.symlinkSync(out, path.join(work, 'out-link'));
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(work, 'out-link', 'x.zip'), graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'destination-symlink');
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(out, 'x.tar'), graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'invalid-destination');
  assert.throws(() => exportCapabilityPackage({ organDir, destination: 'relative.zip', graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'invalid-destination');
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(out, '..', 'source', 'x.zip'), graftVersion: '0.5.0', receiptsFile }), (e) => e.code === 'destination-inside-source');
  // An existing symlink at the destination is never replaced through.
  fs.symlinkSync(path.join(src, 'package.json'), path.join(out, 'link.zip'));
  assert.throws(() => exportCapabilityPackage({ organDir, destination: path.join(out, 'link.zip'), graftVersion: '0.5.0', receiptsFile, overwrite: true }), (e) => e.code === 'destination-not-a-file');
  assert.equal(fs.readFileSync(path.join(src, 'package.json'), 'utf8').includes('"name"'), true, 'the source file behind the link is intact');
  // Archive entries can never traverse.
  assert.throws(() => zipBuffer({ '../escape.txt': 'x' }), (e) => e.code === 'unsafe-entry');
  assert.throws(() => zipBuffer({ '/abs.txt': 'x' }), (e) => e.code === 'unsafe-entry');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 check value');
});

test('an organ without engine artifacts cannot be exported, and export never touches verification state', async (t) => {
  const work = sandbox(t);
  const { organDir, manifest } = await organ(t, work);
  const before = JSON.stringify(readOrganEngine(organDir));
  const verifiedBefore = JSON.stringify(manifest.provenance.verifiedInSource);
  buildCapabilityPackage({ organDir, graftVersion: '0.5.0' });
  assert.equal(JSON.stringify(readOrganEngine(organDir)), before, 'the organ is read, never rewritten');
  assert.equal(JSON.stringify(manifest.provenance.verifiedInSource), verifiedBefore);
  const stale = path.join(work, 'home', 'organ-bank', 'stale.graft');
  fs.cpSync(organDir, stale, { recursive: true });
  fs.rmSync(path.join(stale, 'graft-engine.json'));
  assert.throws(() => buildCapabilityPackage({ organDir: stale, graftVersion: '0.5.0' }), (e) => e.code === 'organ-has-no-engine-artifacts');
});
