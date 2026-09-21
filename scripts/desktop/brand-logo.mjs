// Derive the in-app logo from the one canonical icon artwork.
//
// `packages/desktop/assets/icon.png` is the master the application icon is built from (see
// icon-ico.mjs). The product used to render a separately drawn SVG inside the app, which meant two
// pieces of artwork could — and did — drift apart. There is now one source: this script derives the
// in-app logo from the master, exactly as the .ico sizes are derived, and records the master's hash
// beside it so a test can prove the two never diverge again.
//
// Run: node scripts/desktop/brand-logo.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const master = path.resolve('packages/desktop/assets/icon.png');
const target = path.resolve('packages/web/public/brand-icon.png');
const record = path.resolve('packages/web/public/brand-icon.json');
const SIZE = 128; // Rendered at 34 px in the sidebar; 128 keeps it crisp on a 3× display.

const sha256 = (buffer) => `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
const masterBytes = fs.readFileSync(master);
if (masterBytes.readUInt32BE(0) !== 0x89504e47) throw new Error('The canonical icon is not a PNG.');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-brand-'));
try {
  const out = path.join(work, `brand-${SIZE}.png`);
  if (process.platform !== 'darwin') throw new Error('Resizing needs macOS sips; derive the PNG another way and rerun.');
  execFileSync('sips', ['--resampleHeightWidth', String(SIZE), String(SIZE), master, '--out', out], { stdio: 'pipe' });
  const derived = fs.readFileSync(out);
  fs.writeFileSync(target, derived);
  fs.writeFileSync(record, `${JSON.stringify({
    note: 'Derived from the canonical application icon. Do not edit by hand; run scripts/desktop/brand-logo.mjs.',
    master: path.relative(process.cwd(), master), masterSha256: sha256(masterBytes),
    derived: path.relative(process.cwd(), target), derivedSha256: sha256(derived), size: SIZE,
  }, null, 2)}\n`);
  console.log(`in-app logo derived from ${path.relative(process.cwd(), master)} at ${SIZE}px → ${path.relative(process.cwd(), target)}`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
