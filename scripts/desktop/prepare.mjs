// Download, verify and stage the pinned standalone Node runtime for the HOST platform, so the
// packaged GRAFT never depends on a customer-installed Node. Checksums are the official
// values from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const version = '24.21.0';
export const RUNTIMES = Object.freeze({
  'darwin-arm64': { archive: `node-v${version}-darwin-arm64.tar.gz`, checksum: 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057', executable: ['bin', 'node'], archived: ['bin', 'node'] },
  'win32-x64': { archive: `node-v${version}-win-x64.zip`, checksum: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541', executable: ['node.exe'], archived: ['node.exe'] },
});

const key = `${process.platform}-${process.arch}`;
const runtimeSpec = RUNTIMES[key];
if (!runtimeSpec) throw new Error(`No pinned Node runtime for ${key}; GRAFT desktop supports ${Object.keys(RUNTIMES).join(', ')}.`);
const { archive, checksum, executable, archived } = runtimeSpec;
const root = path.resolve('.desktop-build');
const download = path.join(root, archive);
fs.mkdirSync(root, { recursive: true });
// curl and tar (bsdtar, which also reads zip) ship with macOS and with Windows 10+/Server 2019+.
if (!fs.existsSync(download)) execFileSync('curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--output', download, `https://nodejs.org/dist/v${version}/${archive}`], { stdio: 'inherit', timeout: 180000 });
if (crypto.createHash('sha256').update(fs.readFileSync(download)).digest('hex') !== checksum) throw new Error('Pinned Node archive checksum mismatch.');
const extraction = fs.mkdtempSync(path.join(root, 'verified-node-'));
const extracted = path.join(extraction, archive.replace(/\.(tar\.gz|zip)$/, ''));
try {
  execFileSync('tar', ['-xf', download, '-C', extraction], { timeout: 60000 });
  const runtime = path.join(root, 'runtime');
  fs.rmSync(runtime, { recursive: true, force: true });
  fs.mkdirSync(path.join(runtime, ...executable.slice(0, -1)), { recursive: true });
  fs.copyFileSync(path.join(extracted, ...archived), path.join(runtime, ...executable));
  if (process.platform !== 'win32') fs.chmodSync(path.join(runtime, ...executable), 0o755);
  fs.copyFileSync(path.join(extracted, 'LICENSE'), path.join(runtime, 'NODE-LICENSE.txt'));
  fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify({ version, platform: process.platform, arch: process.arch, archive, archiveSHA256: checksum }, null, 2) + '\n');
  console.log(`Prepared pinned standalone Node ${version} for ${key}.`);
} finally { fs.rmSync(extraction, { recursive: true, force: true }); }
