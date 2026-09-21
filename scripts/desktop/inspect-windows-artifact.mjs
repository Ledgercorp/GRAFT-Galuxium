// Validates the unsigned Windows release candidate produced by `npm run desktop:make` on Windows:
// the Squirrel Setup.exe, RELEASES manifest and full .nupkg exist and are internally consistent,
// the packaged ASAR excludes the licensing backend, tests and the fixture, and the product
// configuration is unset (fails closed). Exits non-zero on any failure. Runs on any platform
// given the out/ directory; CI runs it on windows-latest right after the make step.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const version = require('../../package.json').version;
const arch = process.env.GRAFT_WIN_ARCH || 'x64';
const packaged = path.resolve(`out/desktop/GRAFT-win32-${arch}`);
const make = path.resolve(`out/desktop/make/squirrel.windows/${arch}`);
const setup = path.join(make, `GRAFT-${version}-Setup.exe`);
const releases = path.join(make, 'RELEASES');
const nupkg = path.join(make, `GRAFT-${version}-full.nupkg`);
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`); };

// Packaged application directory (input to the installer).
check('packaged GRAFT.exe exists', fs.existsSync(path.join(packaged, 'GRAFT.exe')));
check('bundled standalone Node is inside resources', fs.existsSync(path.join(packaged, 'resources', 'runtime', 'node.exe')) && fs.existsSync(path.join(packaged, 'resources', 'runtime', 'runtime.json')));
const runtime = JSON.parse(fs.readFileSync(path.join(packaged, 'resources', 'runtime', 'runtime.json'), 'utf8'));
check('bundled runtime manifest is the pinned Windows build', runtime.platform === 'win32' && runtime.arch === arch && runtime.version === '24.21.0', JSON.stringify(runtime));
const asarPath = path.join(packaged, 'resources', 'app.asar');
check('application ASAR exists', fs.existsSync(asarPath));
const files = asar.listPackage(asarPath).map((f) => f.replace(/\\/g, '/'));
check('ASAR excludes the licensing backend', !files.some((f) => f.includes('/packages/licensing/')));
check('ASAR excludes the deterministic test fixture', !files.some((f) => f.endsWith('/test-fixture.js')));
check('ASAR excludes test directories', !files.some((f) => /\/test\//.test(f)));
const nodeModule = (f) => (f.match(/\/node_modules\/([^/]+)/) || [])[1];
check('ASAR carries the engine, web workspace, desktop and acorn only',
  files.some((f) => f.endsWith('/packages/core/src/index.js')) && files.some((f) => f.endsWith('/packages/desktop/src/main.js'))
  && files.some((f) => f.endsWith('/node_modules/acorn/package.json'))
  && files.every((f) => { const m = nodeModule(f); return !m || m === 'acorn'; }));
// asar.getNode splits the lookup path on path.sep, so the key must use the native separator.
const asarKey = (posix) => posix.split('/').join(path.sep);
const product = JSON.parse(asar.extractFile(asarPath, asarKey('packages/desktop/config/product.json')).toString());
check('shipped product configuration is unset so the build fails closed', product.testBuild === false && product.licenseApiBase === null && product.productId === null, JSON.stringify(product));

// Installer artifacts.
check('Setup.exe exists', fs.existsSync(setup), setup);
if (fs.existsSync(setup)) {
  const head = fs.readFileSync(setup).subarray(0, 2).toString('ascii');
  check('Setup.exe is a Windows PE executable (MZ header)', head === 'MZ');
  check('Setup.exe has a plausible size for Electron + runtime', fs.statSync(setup).size > 60 * 1024 * 1024, `${(fs.statSync(setup).size / 1048576).toFixed(1)} MiB`);
}
check('RELEASES manifest exists', fs.existsSync(releases));
check('full .nupkg exists', fs.existsSync(nupkg));
if (fs.existsSync(releases) && fs.existsSync(nupkg)) {
  const [sha1, name, size] = fs.readFileSync(releases, 'utf8').trim().split(/\s+/);
  const actual = crypto.createHash('sha1').update(fs.readFileSync(nupkg)).digest('hex').toUpperCase();
  check('RELEASES references the .nupkg by matching SHA1 and size', name === path.basename(nupkg) && sha1.toUpperCase() === actual && Number(size) === fs.statSync(nupkg).size, `${name} ${sha1}`);
  // The .nupkg is a zip; bsdtar (present on Windows 10+, macOS and Linux) lists it.
  const listing = execFileSync('tar', ['-tf', nupkg], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\\/g, '/');
  check('.nupkg contains GRAFT.exe, the ASAR and the bundled runtime', listing.includes('lib/net45/GRAFT.exe') && listing.includes('lib/net45/resources/app.asar') && listing.includes('lib/net45/resources/runtime/node.exe'));
  check('.nupkg does not contain the licensing backend', !listing.includes('packages/licensing/'));
}
if (failures) { console.error(`\n${failures} Windows artifact check(s) failed.`); process.exit(1); }
console.log('\nWindows release-candidate artifact is internally valid (unsigned).');
