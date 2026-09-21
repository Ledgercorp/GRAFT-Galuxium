import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateEvidence, decodeEvidence } from '../judge/evidence.js';
import { previewServer, publicFiles } from '../../../scripts/demo/judge-preview.mjs';
const root = new URL('../judge/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
const recorded = JSON.parse(read('evidence.json'));
const clone = () => structuredClone(recorded.payload);

test('recorded evidence is internally consistent and checksum-bound', async () => {
  const d = await decodeEvidence(recorded);
  assert.equal(d.source.verification.verdict, 'VERIFIED');
  assert.equal(d.destination.verification.verdict, 'VERIFIED');
  assert.notEqual(d.destination.baseRevision, d.destination.revision);
  for (const phase of [d.source, d.destination]) {
    assert.equal(phase.verification.summary.required, 6);
    assert.equal(phase.verification.tests.find((t) => t.id === 'auth.session.survives-restart').outcome, 'failed');
  }
  assert.match(d.diff, /registerAuthRoutes/);
  assert.equal(d.plan.conflictResolutionApproved, true);
});
test('missing, corrupted, forged and unknown evidence fails closed', async () => {
  await assert.rejects(decodeEvidence(null));
  const altered = structuredClone(recorded); altered.payload.destination.verification.verdict = 'FAILED';
  await assert.rejects(decodeEvidence(altered));
  for (const modify of [
    (d) => { delete d.source; },
    (d) => { d.destination.verification.summary.passed = 99; },
    (d) => { d.destination.verification.tests[0].steps[0].checks[0].ok = false; },
    (d) => { d.source.rawReceipt = {}; },
    (d) => { d.source.verification.tests.push(d.source.verification.tests[0]); },
    (d) => { d.plan.files[0].path = '../private'; },
  ]) { const d = clone(); modify(d); assert.throws(() => validateEvidence(d)); }
});
test('sensitive values are rejected even inside permitted display fields', () => {
  for (const value of ['/Users/person/private', '/home/person/private', '/var/folders/private', 'Bearer abc123', 'sk_live_example', 'ghp_example', 'licenseKey', 'person@example.com', '-----BEGIN PRIVATE KEY-----']) {
    const d = clone(); d.plan.adaptation = value; assert.throws(() => validateEvidence(d), value);
  }
});
test('FAILED and NEEDS_REVIEW remain distinct from VERIFIED', () => {
  for (const verdict of ['FAILED', 'NEEDS_REVIEW']) { const d = clone(); d.destination.verification.verdict = verdict; assert.equal(validateEvidence(d).destination.verification.verdict, verdict); }
});
test('static public directory has only reviewed assets and no executable backend', () => {
  const localOnly = new Set(['.env.local', '.gitignore', '.vercel']);
  const publishable = fs.readdirSync(root).filter((name) => !localOnly.has(name));
  assert.deepEqual(publishable.sort(), [...Object.keys(publicFiles), 'vercel.json'].sort());
  assert.match(read('.gitignore'), /^\.vercel\n\.env\*\n$/);
  const deployment = JSON.parse(read('vercel.json'));
  const headers = Object.fromEntries(deployment.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.equal(deployment.headers[0].source, '/(.*)');
  assert.match(headers['Content-Security-Policy'], /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL('brand-icon.png', root))).digest('hex'), crypto.createHash('sha256').update(fs.readFileSync(new URL('../public/brand-icon.png', import.meta.url))).digest('hex'));
  for (const f of ['index.html', 'docs.html']) {
    const page = read(f);
    for (const [, href] of page.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
      const file = href.split('#')[0].replace(/^\.\//, '') || 'index.html';
      assert.ok(Object.hasOwn(publicFiles, file), `${f}: broken link ${href}`);
    }
  }
  assert.doesNotMatch(read('app.js'), /innerHTML|eval\(|localhost|127\.0\.0\.1|\/api\//);
});
test('preview serves judge routes and refuses repository, executor and mutation paths', async (t) => {
  const server = previewServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const f of Object.keys(publicFiles)) {
    const response = await fetch(`${origin}/${f}`); assert.equal(response.status, 200, f);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await fetch(origin)).status, 200);
  for (const p of ['/api/harvest', '/api/verify', '/../../HANDOFF.md', '/.env', '/packages/licensing/src/mail.js']) assert.equal((await fetch(origin + p)).status, 404);
  assert.equal((await fetch(origin, { method: 'POST' })).status, 404);
});
