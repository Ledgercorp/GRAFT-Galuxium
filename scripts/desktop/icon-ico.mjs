// Assemble packages/desktop/assets/icon.ico from the committed master icon.png.
// Windows needs a multi-size .ico; each entry is stored as PNG (supported since Vista), so
// no image codec is required here — only a resizer for the intermediate sizes. On macOS
// that is `sips`; pass pre-resized PNGs on other systems. Run: node scripts/desktop/icon-ico.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const assets = path.resolve('packages/desktop/assets');
const master = path.join(assets, 'icon.png');
const target = path.join(assets, 'icon.ico');
const SIZES = [256, 128, 64, 48, 32, 16];

function pngSize(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG.');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function resized(size, work) {
  const out = path.join(work, `icon-${size}.png`);
  if (process.platform === 'darwin') execFileSync('sips', ['--resampleHeightWidth', String(size), String(size), master, '--out', out], { stdio: 'pipe' });
  else throw new Error('Resizing needs macOS sips; generate the intermediate PNGs another way and rerun.');
  return fs.readFileSync(out);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-ico-'));
try {
  const images = SIZES.map((size) => {
    const png = resized(size, work);
    const { width, height } = pngSize(png);
    if (width !== size || height !== size) throw new Error(`Resize to ${size} produced ${width}x${height}.`);
    return { size, png };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4); // reserved, type=icon, count
  const directory = Buffer.alloc(16 * images.length);
  let offset = 6 + directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);      // width (0 means 256)
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);  // height
    directory.writeUInt8(0, entry + 2);                        // palette
    directory.writeUInt8(0, entry + 3);                        // reserved
    directory.writeUInt16LE(1, entry + 4);                     // colour planes
    directory.writeUInt16LE(32, entry + 6);                    // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);            // bytes
    directory.writeUInt32LE(offset, entry + 12);               // offset
    offset += png.length;
  });
  fs.writeFileSync(target, Buffer.concat([header, directory, ...images.map((i) => i.png)]));
  console.log(`Wrote ${path.relative(process.cwd(), target)}: ${images.map((i) => i.size).join('/')} px, ${fs.statSync(target).size} bytes.`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
