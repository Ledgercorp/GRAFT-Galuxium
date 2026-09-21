import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p) => fs.readFileSync(path.join(repoRoot, p));
const sha256 = (buffer) => `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;

test('the in-app logo is derived from the one canonical application icon, and cannot drift from it', () => {
  const record = JSON.parse(read('packages/web/public/brand-icon.json'));
  // The record names the master the logo came from; if either file changes without re-deriving,
  // these hashes stop matching and this test fails.
  assert.equal(record.master, 'packages/desktop/assets/icon.png');
  assert.equal(sha256(read(record.master)), record.masterSha256, 'the application icon changed without re-deriving the in-app logo');
  assert.equal(sha256(read(record.derived)), record.derivedSha256, 'the in-app logo was edited by hand');
  const logo = read('packages/web/public/brand-icon.png');
  assert.equal(logo.readUInt32BE(0), 0x89504e47, 'the logo is a PNG');
  assert.equal(logo.readUInt32BE(16), record.size);
  assert.equal(logo.readUInt32BE(20), record.size);
});

test('every product surface renders the canonical mark, and the old one is gone', () => {
  const page = read('packages/web/public/app.js').toString('utf8');
  const shell = read('packages/web/public/index.html').toString('utf8');
  const server = read('packages/web/src/server.js').toString('utf8');
  assert.match(page, /<img src="\/brand-icon\.png"/, 'the sidebar brand uses the canonical artwork');
  assert.match(shell, /<link rel="icon" href="\/brand-icon\.png"/, 'the tab icon uses the canonical artwork');
  assert.match(server, /'\/brand-icon\.png': \['brand-icon\.png', 'image\/png'\]/, 'the product serves it');
  // No separately drawn mark survives anywhere in the product.
  assert.equal(fs.existsSync(path.join(repoRoot, 'packages/web/public/favicon.svg')), false);
  for (const file of ['packages/web/public/app.js', 'packages/web/public/index.html', 'packages/web/src/server.js']) {
    assert.equal(/favicon\.svg/.test(read(file).toString('utf8')), false, `${file} still references the retired mark`);
  }
});
