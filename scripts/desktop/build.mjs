import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertPublicBuildConfig } from './release-gate.mjs';
const require = createRequire(import.meta.url);
const repo = process.cwd();
const fixture = process.argv.includes('--fixture');
const judge = process.argv.includes('--judge');
if (fixture && judge) throw new Error('Choose either --fixture or --judge.');
const localDemo = fixture || judge;
const stage = path.join(repo, '.desktop-build', judge ? 'judge-app' : fixture ? 'fixture-app' : 'app');
execFileSync(process.execPath, ['scripts/desktop/prepare.mjs'], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });
// The licensing backend holds server-only Stripe logic and must never ship inside the client bundle.
const excludedPackage = path.join(repo, 'packages', 'licensing');
const productConfigDir = path.join(repo, 'packages', 'desktop', 'config');
const namedProductConfig = (file) => path.dirname(file) === productConfigDir && /^product\..+\.json$/.test(path.basename(file));
for (const directory of ['packages', 'fixtures']) fs.cpSync(path.join(repo, directory), path.join(stage, directory), { recursive: true,
  // Exclusions compare path segments, never separator-specific strings, so they hold on Windows too.
  filter: (file) => !['test', 'node_modules', '.git'].includes(path.basename(file)) && !(file === excludedPackage || file.startsWith(excludedPackage + path.sep))
    && !namedProductConfig(file) && (localDemo || path.basename(file) !== 'test-fixture.js') });
fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true });
fs.cpSync(path.join(repo, 'node_modules/acorn'), path.join(stage, 'node_modules/acorn'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync('package.json'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: judge ? 'graft-galuxium' : fixture ? 'graft-fixture' : 'graft-desktop', productName: judge ? 'GRAFT Galuxium' : fixture ? 'GRAFT Fixture' : 'GRAFT',
  version: pkg.version, private: true, type: 'module', main: pkg.main, description: pkg.description, author: pkg.author,
  dependencies: { acorn: pkg.dependencies.acorn }, devDependencies: { electron: pkg.devDependencies.electron }, config: { forge: path.join(repo, 'forge.config.cjs') } }, null, 2));
// The fixture's licence record is stamped with this build id: the same commit rebuilt keeps its
// record, a different commit activates again. Deterministic, and only present in fixture builds.
const fixtureBuildId = (() => { try { return `${pkg.version}:${execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`; } catch { return `${pkg.version}:unversioned`; } })();
if (fixture) fs.writeFileSync(path.join(stage, 'packages/desktop/config/product.json'), JSON.stringify({ provider: 'deterministic-fixture', storeId: 101, productId: 202, variantIds: [303], offlineDays: 30, testBuild: true, inviteOnly: true, supportEmail: 'support@leftsocklabs.com', fixtureBuildId }));
if (judge) fs.writeFileSync(path.join(stage, 'packages/desktop/config/product.json'), JSON.stringify({ provider: 'galuxium-judge-demo', storeId: 101, productId: 202, variantIds: [303], offlineDays: 30, testBuild: true, judgeBuild: true, inviteOnly: false, supportEmail: 'support@leftsocklabs.com', fixtureBuildId }));
// A named product configuration (`--product-config private-beta` → packages/desktop/config/product.private-beta.json)
// replaces the unset default for that build only: the same file the app reads, the same fields, just
// pointed at a real licensing service and checkout. Nothing is hard-coded in the product. The default
// product.json stays unset so an unnamed build still fails closed.
const profile = process.argv.indexOf('--product-config') >= 0 ? process.argv[process.argv.indexOf('--product-config') + 1] : null;
if (profile) {
  if (localDemo) throw new Error('--product-config does not apply to fixture or judge builds');
  if (!/^[a-z0-9-]+$/.test(profile)) throw new Error(`product configuration name must be lower-case letters, digits or dashes: ${profile}`);
  const source = path.join(repo, 'packages/desktop/config', `product.${profile}.json`);
  if (!fs.existsSync(source)) throw new Error(`no product configuration at ${source}`);
  const config = JSON.parse(fs.readFileSync(source, 'utf8'));
  fs.writeFileSync(path.join(stage, 'packages/desktop/config/product.json'), JSON.stringify(config, null, 2) + '\n');
  console.log(`product configuration: ${profile} (licenseApiBase ${config.licenseApiBase}, purchaseUrl ${config.purchaseUrl})`);
}
if (process.env.GRAFT_SIGN === '1') {
  assertPublicBuildConfig(JSON.parse(fs.readFileSync(path.join(stage, 'packages/desktop/config/product.json'))));
}
process.env.GRAFT_BUILD_FIXTURE = fixture ? '1' : '0';
process.env.GRAFT_BUILD_JUDGE = judge ? '1' : '0';
const forge = require('@electron-forge/core').api;
// Always the host platform and CPU: Windows installers are made on Windows, macOS bundles on macOS.
const options = { dir: stage, arch: process.arch, platform: process.platform, outDir: path.join(repo, 'out', judge ? 'judge' : fixture ? 'fixture' : 'desktop') };
if (process.argv.includes('--make')) await forge.make(options); else await forge.package(options);
