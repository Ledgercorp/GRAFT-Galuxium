// Private Beta Program: operator issuance, authoritative expiry, one seat, invitation email,
// end-of-beta feedback relay, operator inspect/extend/revoke — and the purchased-licence path
// (Stripe issuance, perpetual keys, seat pools) untouched by any of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLicenseRegistry, maskKey, normalizeEmail, PRIVATE_BETA_DEFAULT_DAYS, PRIVATE_BETA_MAX_DAYS } from '../src/licenses.js';
import { memoryStore, fileStore } from '../src/store.js';
import { createLicenseMailer, privateBetaEmailContent, feedbackEmailContent } from '../src/mail.js';
import { createLicensingServer, parseFeedback, createRateLimiter } from '../src/server.js';
import { parseArgs, run as runCli, format as formatCli, dropToStoreOwner } from '../src/beta-cli.js';
import { createLicenseService } from '../../desktop/src/license-service.js';
import { graftLicenseProvider } from '../../desktop/src/license-provider.js';

const DAY = 86400000;
const T0 = Date.parse('2026-09-13T12:00:00.000Z');
const product = { storeId: 1, productId: 1, variantId: 1 };
const clock = (start = T0) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } }; };
const make = (c = clock(), store = memoryStore()) => createLicenseRegistry({ store, product, maxActivations: 3, now: c.now });
const install = (label) => ({ installationId: `inst-${label}-00000000`, instanceName: 'GRAFT desktop (macOS)' });
const fakeResend = () => { const calls = []; return { calls, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ id: `re_${calls.length}` }) }; } }; };
const mailer = (resend = fakeResend()) => createLicenseMailer({ apiKey: 're_secret', from: 'GRAFT <licenses@mail.leftsocklabs.com>', supportEmail: 'support@leftsocklabs.com', downloadUrl: 'https://downloads.example/GRAFT-beta.dmg', fetchImpl: resend.fetchImpl });

// ---- Issuance ----
test('issuance: default 30 days, one seat, private_beta type, no Stripe session or payment intent', async () => {
  const c = clock(); const registry = make(c);
  const { issued, record } = await registry.issuePrivateBeta({ email: 'Tester@Example.COM' });
  assert.equal(issued, true);
  assert.equal(record.licenseType, 'private_beta'); assert.equal(record.status, 'active'); assert.equal(record.maxActivations, 1);
  assert.equal(record.customerEmail, 'tester@example.com');
  assert.equal(record.sessionId, null); assert.equal(record.paymentIntent, null);
  assert.equal(record.issuedAt, new Date(T0).toISOString());
  assert.equal(Date.parse(record.expiresAt) - T0, PRIVATE_BETA_DEFAULT_DAYS * DAY);
  assert.match(record.key, /^GRAFT-(?:[A-Z2-9]{4}-){4}[A-Z2-9]{4}$/);
  assert.equal(record.history[0].event, 'issue-private-beta');
});
test('issuance: duration override works; above the maximum, zero, fractional and invalid email are refused', async () => {
  const registry = make();
  const { record } = await registry.issuePrivateBeta({ email: 'a@example.com', days: 45 });
  assert.equal(Date.parse(record.expiresAt) - T0, 45 * DAY);
  await assert.rejects(registry.issuePrivateBeta({ email: 'b@example.com', days: PRIVATE_BETA_MAX_DAYS + 1 }), /between 1 and 90/);
  await assert.rejects(registry.issuePrivateBeta({ email: 'b@example.com', days: 0 }), /between 1 and 90/);
  await assert.rejects(registry.issuePrivateBeta({ email: 'b@example.com', days: 2.5 }), /between 1 and 90/);
  for (const bad of ['', 'nope', 'a@b', 'a b@c.d', null, undefined, 'x@'.padEnd(300, 'a') + '.com']) await assert.rejects(registry.issuePrivateBeta({ email: bad }), /valid email/);
  assert.equal(normalizeEmail('  X@Y.io '), 'x@y.io');
});
test('issuance: a current licence for the same address is never silently duplicated; --reissue revokes it and issues one new key', async () => {
  const c = clock(); const registry = make(c);
  const first = await registry.issuePrivateBeta({ email: 't@example.com' });
  const again = await registry.issuePrivateBeta({ email: 'T@EXAMPLE.com' });
  assert.equal(again.issued, false); assert.equal(again.existing.key, first.record.key);
  const reissued = await registry.issuePrivateBeta({ email: 't@example.com', reissue: true });
  assert.equal(reissued.issued, true); assert.notEqual(reissued.record.key, first.record.key); assert.equal(reissued.replaced, first.record.key);
  assert.equal((await registry.get(first.record.key)).status, 'revoked');
  assert.equal((await registry.validate(first.record.key, null)).valid, false);
  // Once the current licence has expired, a plain issue creates a new one (the old stays as history).
  c.advance(31 * DAY);
  const later = await registry.issuePrivateBeta({ email: 't@example.com' });
  assert.equal(later.issued, true); assert.notEqual(later.record.key, reissued.record.key);
});
test('the mask never shows the middle of a key', () => {
  assert.equal(maskKey('GRAFT-ABCD-EFGH-JKLM-NPQR-STUV'), 'GRAFT-ABCD-••••-••••-••••-STUV');
  assert.equal(maskKey('GRAFT-ABCD-EFGH-JKLM-NPQR-STUV').includes('EFGH'), false);
});

// ---- Validation / activation / expiry ----
test('validation: valid before expiry; at expiresAt the answer is a distinct expired state, no activation, no seat', async () => {
  const c = clock(); const registry = make(c);
  const { record } = await registry.issuePrivateBeta({ email: 't@example.com' });
  const pre = await registry.validate(record.key, null);
  assert.equal(pre.valid, true); assert.equal(pre.license_key.license_type, 'private_beta'); assert.equal(pre.license_key.expires_at, record.expiresAt); assert.equal(pre.license_key.issued_at, record.issuedAt);
  const activated = await registry.activate(record.key, install('mac'));
  assert.equal(activated.activated, true); assert.equal(activated.license_key.status, 'active');
  c.advance(30 * DAY - 1);
  assert.equal((await registry.validate(record.key, activated.instance.id)).valid, true);
  c.advance(1); // exactly expiresAt
  const expired = await registry.validate(record.key, activated.instance.id);
  assert.equal(expired.valid, false); assert.equal(expired.license_key.status, 'expired'); assert.match(expired.error, /private beta license has expired/);
  const again = await registry.activate(record.key, install('other-mac'));
  assert.equal(again.activated, false); assert.equal(again.license_key.status, 'expired');
  assert.equal((await registry.get(record.key)).instances.length, 1, 'no seat was consumed after expiry');
  assert.equal((await registry.get(record.key)).status, 'active', 'the record itself is not rewritten: expiry is computed from expiresAt');
});
test('one device: a second installation is refused; the same installation re-activates idempotently', async () => {
  const registry = make();
  const { record } = await registry.issuePrivateBeta({ email: 't@example.com' });
  const first = await registry.activate(record.key, install('mac1'));
  assert.equal(first.activated, true);
  assert.equal((await registry.activate(record.key, install('mac2'))).error, 'This license has reached its activation limit.');
  assert.equal((await registry.activate(record.key, install('mac1'))).instance.id, first.instance.id);
  await registry.deactivate(record.key, first.instance.id);
  assert.equal((await registry.activate(record.key, install('mac2'))).activated, true);
});
test('purchased licences are untouched: perpetual, three seats, license_type purchase, no expiry state ever', async () => {
  const c = clock(); const registry = make(c);
  const paid = await registry.issue({ sessionId: 'cs_1', paymentIntent: 'pi_1', customerEmail: 'buyer@example.com' });
  assert.equal(paid.expiresAt, null); assert.equal(paid.licenseType, undefined);
  c.advance(400 * DAY);
  const v = await registry.validate(paid.key, null);
  assert.equal(v.valid, true); assert.equal(v.license_key.license_type, 'purchase'); assert.equal(v.license_key.expires_at, null);
  for (const m of ['a', 'b', 'c']) assert.equal((await registry.activate(paid.key, install(m))).activated, true);
  assert.equal((await registry.activate(paid.key, install('d'))).activated, false);
  // A private-beta licence has no payment intent, so Stripe refund/dispute handling can never touch it.
  const beta = (await registry.issuePrivateBeta({ email: 't@example.com' })).record;
  await registry.revokeByPaymentIntent('pi_1', 'charge.refunded');
  assert.equal((await registry.get(paid.key)).status, 'revoked');
  assert.equal((await registry.get(beta.key)).status, 'active');
  assert.equal((await registry.holds()).length, 0);
});
test('old records without licenseType/issuedAt load and validate exactly as before', async () => {
  const c = clock(); const registry = make(c, memoryStore({ licenses: { 'GRAFT-OLD': { key: 'GRAFT-OLD', status: 'active', expiresAt: null, sessionId: 'cs', paymentIntent: 'pi', customerEmail: null, maxActivations: 3, instances: [], history: [] } }, sessions: { cs: 'GRAFT-OLD' } }));
  const v = await registry.validate('GRAFT-OLD', null);
  assert.equal(v.valid, true); assert.equal(v.license_key.status, 'inactive'); assert.equal(v.license_key.license_type, 'purchase'); assert.equal(v.license_key.issued_at, null);
  assert.equal((await registry.activate('GRAFT-OLD', install('x'))).activated, true);
});

// ---- Revoke / extend / inspect ----
test('revoke: validation then fails closed; extend: authoritative new expiry, same key, capped at 90 days from today', async () => {
  const c = clock(); const registry = make(c);
  const { record } = await registry.issuePrivateBeta({ email: 't@example.com' });
  const act = await registry.activate(record.key, install('mac'));
  c.advance(10 * DAY);
  const ext = await registry.extendPrivateBeta(record.key, 14);
  assert.equal(ext.record.key, record.key);
  assert.equal(Date.parse(ext.record.expiresAt), Date.parse(record.expiresAt) + 14 * DAY, 'extends from the current expiry when it is still ahead');
  assert.equal((await registry.validate(record.key, act.instance.id)).license_key.expires_at, ext.record.expiresAt, 'the desktop receives the new expiry on its next validation');
  await assert.rejects(registry.extendPrivateBeta(record.key, 80), /more than 90 days from today/);
  await assert.rejects(registry.extendPrivateBeta(record.key, 0), /between 1 and 90/);
  // Expired: the extension runs from now, not from the past expiry.
  c.advance(60 * DAY);
  assert.equal((await registry.validate(record.key, act.instance.id)).license_key.status, 'expired');
  const revived = await registry.extendPrivateBeta(record.key, 7);
  assert.equal(Date.parse(revived.record.expiresAt), c.now() + 7 * DAY);
  assert.equal((await registry.validate(record.key, act.instance.id)).valid, true);
  const rev = await registry.revokePrivateBeta(record.key, 'testing over');
  assert.equal(rev.revoked, true);
  assert.equal((await registry.validate(record.key, act.instance.id)).valid, false);
  assert.equal((await registry.activate(record.key, install('mac'))).activated, false);
  await assert.rejects(registry.extendPrivateBeta(record.key, 7), /revoked/);
  assert.equal((await registry.revokePrivateBeta(record.key)).revoked, false, 'idempotent');
  await assert.rejects(registry.revokePrivateBeta('GRAFT-NOPE'), /Unknown private-beta/);
  // find: by key, or by address (current first, else the latest).
  assert.equal((await registry.findPrivateBeta({ key: record.key })).key, record.key);
  assert.equal((await registry.findPrivateBeta({ email: 'T@example.com' })).key, record.key);
  assert.equal(await registry.findPrivateBeta({ email: 'nobody@example.com' }), null);
});
test('a purchased key is not a private-beta licence to the operator commands', async () => {
  const registry = make();
  const paid = await registry.issue({ sessionId: 'cs', paymentIntent: 'pi', customerEmail: 'b@example.com' });
  assert.equal(await registry.findPrivateBeta({ key: paid.key }), null);
  await assert.rejects(registry.revokePrivateBeta(paid.key), /Unknown private-beta/);
  await assert.rejects(registry.extendPrivateBeta(paid.key, 7), /Unknown private-beta/);
  await assert.rejects(registry.recordFeedback(paid.key, { rating: 5 }), /Unknown private-beta/);
});

// ---- Email ----
test('invitation email: recipient, sender, Reply-To support, the issued key, the expiry, the configured download URL, no commerce wording', async () => {
  const resend = fakeResend(); const m = mailer(resend);
  const registry = make();
  const { record } = await registry.issuePrivateBeta({ email: 't@example.com' });
  const outcome = await m.sendPrivateBeta({ to: record.customerEmail, key: record.key, expiresAt: record.expiresAt });
  assert.equal(outcome.sent, true); assert.equal(outcome.providerId, 're_1');
  const sent = resend.calls[0].body;
  assert.deepEqual(sent.to, ['t@example.com']); assert.equal(sent.from, 'GRAFT <licenses@mail.leftsocklabs.com>'); assert.equal(sent.reply_to, 'support@leftsocklabs.com');
  assert.equal(sent.subject, 'Your GRAFT private beta license');
  assert.ok(sent.text.includes(`License key: ${record.key}`));
  assert.ok(sent.text.includes('Expires: October 13, 2026'));
  assert.ok(sent.text.includes('https://downloads.example/GRAFT-beta.dmg'));
  assert.ok(sent.text.includes('one Apple Silicon Mac'));
  assert.ok(sent.text.includes('support@leftsocklabs.com'));
  assert.ok(sent.text.includes('You’re in the GRAFT private beta.'));
  for (const word of ['Stripe', 'sandbox', 'Tigris', 'Fly', 'test', 'buy', 'purchase', 'pay']) assert.equal(sent.text.toLowerCase().includes(word.toLowerCase()), false, word);
  assert.equal((await m.sendPrivateBeta({ to: 't@example.com', key: 'GRAFT-BAD', expiresAt: record.expiresAt })).status, 'failed');
  assert.equal((await m.sendPrivateBeta({ to: 't@example.com', key: record.key, expiresAt: 'never' })).status, 'failed');
  assert.equal((await createLicenseMailer({}).sendPrivateBeta({ to: 't@example.com', key: record.key, expiresAt: record.expiresAt })).status, 'not-configured');
  assert.match(privateBetaEmailContent({ key: 'GRAFT-X', expiresAt: '2026-11-01T00:00:00Z', downloadUrl: 'https://d', supportEmail: 's@e.co' }).text, /November 1, 2026/);
});

// ---- Operator CLI ----
test('operator CLI: issue prints a masked safe summary, never the full key; duplicate refused; inspect/extend/revoke work by email', async () => {
  const c = clock(); const registry = make(c); const resend = fakeResend(); const m = mailer(resend);
  const issued = await runCli(parseArgs(['issue', '--email', 'Tester@Example.com']), { registry, mailer: m, now: c.now });
  const text = formatCli(issued);
  assert.equal(issued.ok, true); assert.equal(issued.email, 'tester@example.com'); assert.equal(issued.expires, 'October 13, 2026'); assert.equal(issued.seats, '0 of 1 in use'); assert.match(issued.delivery, /^sent/);
  const key = resend.calls[0].body.text.match(/License key: (GRAFT-[A-Z2-9-]+)/)[1];
  assert.equal(text.includes(key), false, 'the full key is not in the operator output');
  assert.equal(JSON.stringify(issued).includes(key), false);
  assert.ok(text.includes(maskKey(key)));
  const dup = await runCli(parseArgs(['issue', '--email', 'tester@example.com']), { registry, mailer: m, now: c.now });
  assert.equal(dup.ok, false); assert.match(dup.title, /NOT issued/); assert.equal(resend.calls.length, 1, 'no second email');
  const inspected = await runCli(parseArgs(['inspect', '--email', 'tester@example.com']), { registry, mailer: m, now: c.now });
  assert.equal(inspected.status, 'active'); assert.equal(inspected.feedback, 'none');
  const extended = await runCli(parseArgs(['extend', '--email', 'tester@example.com', '--days', '7']), { registry, mailer: m, now: c.now });
  assert.equal(extended.expires, 'October 20, 2026'); assert.equal(extended.previous, 'October 13, 2026');
  const revoked = await runCli(parseArgs(['revoke', '--email', 'tester@example.com', '--reason', 'done']), { registry, mailer: m, now: c.now });
  assert.equal(revoked.status, 'revoked');
  assert.equal((await runCli(parseArgs(['inspect', '--email', 'nobody@example.com']), { registry, mailer: m, now: c.now })).ok, false);
  for (const bad of [['issue'], ['extend', '--email', 'a@b.co'], ['bogus'], ['issue', '--email', 'a@b.co', '--days', 'x'], ['inspect']]) assert.throws(() => parseArgs(bad));
  await assert.rejects(runCli(parseArgs(['issue', '--email', 'z@example.com', '--days', '91']), { registry, mailer: m, now: c.now }), /between 1 and 90/);
});
test('operator CLI: when the invitation email fails, the licence exists, delivery is recorded, and the key is revealed only on request', async () => {
  const c = clock(); const registry = make(c);
  const failing = createLicenseMailer({ apiKey: 'k', from: 'GRAFT <x@y.z>', supportEmail: 's@y.z', downloadUrl: 'https://d/x.dmg', fetchImpl: async () => ({ status: 500, json: async () => ({}) }) });
  const out = await runCli(parseArgs(['issue', '--email', 't@example.com']), { registry, mailer: failing, now: c.now });
  assert.equal(out.ok, false); assert.match(out.title, /NOT sent/); assert.match(out.delivery, /^failed/); assert.equal(out.key, undefined);
  const record = await registry.findPrivateBeta({ email: 't@example.com' });
  assert.equal(record.delivery.status, 'failed');
  const revealed = await runCli(parseArgs(['issue', '--email', 't@example.com', '--reissue', '--reveal-key']), { registry, mailer: failing, now: c.now });
  assert.match(revealed.key, /^GRAFT-/);
});
test('operator CLI: run as root it drops to the store owner, and refuses when the store is root-owned or absent', () => {
  const calls = [];
  const proc = { getuid: () => 0, setgid: (g) => calls.push(['gid', g]), setuid: (u) => calls.push(['uid', u]) };
  assert.deepEqual(dropToStoreOwner('/data/licenses.json', { fs: { statSync: () => ({ uid: 1000, gid: 1000 }) }, proc }), { dropped: true, uid: 1000 });
  assert.deepEqual(calls, [['gid', 1000], ['uid', 1000]]);
  assert.throws(() => dropToStoreOwner('/data/licenses.json', { fs: { statSync: () => ({ uid: 0, gid: 0 }) }, proc }), /Refusing to run as root/);
  assert.throws(() => dropToStoreOwner('/data/licenses.json', { fs: { statSync: () => { throw new Error('ENOENT'); } }, proc }), /Refusing to run as root/);
  assert.deepEqual(dropToStoreOwner('/x', { fs: {}, proc: { getuid: () => 501 } }), { dropped: false });
});
test('the cross-process store lock serialises registry operations between two processes sharing one file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-beta-lock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'licenses.json');
  const a = make(clock(), fileStore(file)); const b = make(clock(), fileStore(file));
  await Promise.all([a.issuePrivateBeta({ email: 'one@example.com' }), b.issuePrivateBeta({ email: 'two@example.com' }), a.issuePrivateBeta({ email: 'three@example.com' })]);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(doc.licenses).length, 3, 'no lost update');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock released');
});

// ---- Feedback route ----
const serverConfig = { merchantOfRecord: 'stripe-managed-payments', managedPayments: true, mode: 'test', webhookSecret: 'whsec_x', priceId: 'price_1', publicUrl: 'http://127.0.0.1', downloadUrl: 'https://downloads.example/GRAFT-beta.dmg', signatureToleranceSec: 300, product };
async function bootServer({ mailer: m, now, feedbackLimits } = {}) {
  const c = clock(); const registry = make(c);
  const { server } = createLicensingServer({ config: serverConfig, stripe: {}, registry, mailer: m, now: now || c.now, ...(feedbackLimits ? { feedbackLimits } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { c, registry, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const answers = (over = {}) => ({ rating: 4, wouldUseAgain: 'yes', usedFor: 'Moving sign-in into a new portal', workedWell: 'The proofs', frustrated: 'Indexing pace', ...over });

test('feedback: accepted from an EXPIRED private-beta licence, delivered to support only with the tester as Reply-To, subject carries the rating, entitlement unchanged', async (t) => {
  const resend = fakeResend(); const s = await bootServer({ mailer: mailer(resend) }); t.after(s.close);
  const { record } = await s.registry.issuePrivateBeta({ email: 't@example.com' });
  const act = await s.registry.activate(record.key, install('mac'));
  s.c.advance(31 * DAY);
  assert.equal((await s.registry.validate(record.key, act.instance.id)).license_key.status, 'expired');
  const res = await post(s.base, '/licenses/feedback', { license_key: record.key, responses: answers({ worthPaying: 'Windows support', anythingElse: 'Nice work' }), client: { version: '0.5.0', os: 'macOS 25.6.0', arch: 'arm64', path: '/Users/x/secret' }, to: 'attacker@example.com', reply_to: 'attacker@example.com' });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { sent: true });
  const sent = resend.calls[0].body;
  assert.deepEqual(sent.to, ['support@leftsocklabs.com']); assert.equal(sent.reply_to, 't@example.com'); assert.equal(sent.from, 'GRAFT <licenses@mail.leftsocklabs.com>');
  assert.equal(sent.subject, 'GRAFT Private Beta Feedback — 4/5');
  assert.ok(sent.text.includes('Moving sign-in into a new portal') && sent.text.includes('Windows support') && sent.text.includes('GRAFT 0.5.0 · macOS 25.6.0 arm64'));
  assert.equal(sent.text.includes(record.key), false, 'the full key is not in the email'); assert.ok(sent.text.includes(maskKey(record.key)));
  assert.equal(sent.text.includes('/Users/x/secret'), false, 'unknown client fields are dropped');
  assert.equal(JSON.stringify(sent).includes('attacker@example.com'), false, 'no caller-chosen recipient or Reply-To');
  const after = await s.registry.get(record.key);
  assert.equal(after.feedback.count, 1); assert.equal(after.feedback.lastRating, 4);
  assert.equal((await s.registry.validate(record.key, act.instance.id)).license_key.status, 'expired', 'submitting feedback reactivates nothing');
  assert.equal(after.instances.length, 1);
});
test('feedback: shape and limits are enforced; purchased, unknown and revoked licences are refused; unconfigured mail is a 503 not a silent success', async (t) => {
  const resend = fakeResend(); const s = await bootServer({ mailer: mailer(resend) }); t.after(s.close);
  const { record } = await s.registry.issuePrivateBeta({ email: 't@example.com' });
  const paid = await s.registry.issue({ sessionId: 'cs', paymentIntent: 'pi', customerEmail: 'b@example.com' });
  const expect = async (body, status, pattern) => { const res = await post(s.base, '/licenses/feedback', body); assert.equal(res.status, status, JSON.stringify(body).slice(0, 80)); if (pattern) assert.match((await res.json()).error, pattern); };
  await expect({ license_key: record.key, responses: answers({ rating: 0 }) }, 400, /1 to 5/);
  await expect({ license_key: record.key, responses: answers({ rating: 6 }) }, 400, /1 to 5/);
  await expect({ license_key: record.key, responses: answers({ rating: '4' }) }, 400, /1 to 5/);
  await expect({ license_key: record.key, responses: answers({ wouldUseAgain: 'sure' }) }, 400, /yes, maybe or no/);
  await expect({ license_key: record.key, responses: answers({ usedFor: '' }) }, 400, /"usedFor" is required/);
  await expect({ license_key: record.key, responses: answers({ workedWell: '   ' }) }, 400, /"workedWell" is required/);
  await expect({ license_key: record.key, responses: answers({ frustrated: 'x'.repeat(2001) }) }, 400, /longer than 2000/);
  await expect({ license_key: record.key, responses: answers({ anythingElse: ['array'] }) }, 400, /must be text/);
  await expect({ license_key: record.key }, 400, /Missing "responses"/);
  await expect({ license_key: paid.key, responses: answers() }, 403, /private beta licenses only/);
  await expect({ license_key: 'GRAFT-NOPE', responses: answers() }, 403, /private beta licenses only/);
  await s.registry.revokePrivateBeta(record.key);
  await expect({ license_key: record.key, responses: answers() }, 403, /no longer recognised/);
  assert.equal(resend.calls.length, 0, 'nothing was relayed');
  const quiet = await bootServer({ mailer: createLicenseMailer({}) }); t.after(quiet.close);
  const { record: r2 } = await quiet.registry.issuePrivateBeta({ email: 'q@example.com' });
  const res = await post(quiet.base, '/licenses/feedback', { license_key: r2.key, responses: answers() });
  assert.equal(res.status, 503);
  assert.equal((await quiet.registry.get(r2.key)).feedback, undefined);
});
test('feedback: control characters are stripped, text trimmed, and a provider failure is a retryable 502 that records nothing', async (t) => {
  const resend = fakeResend(); const s = await bootServer({ mailer: mailer(resend) }); t.after(s.close);
  const { record } = await s.registry.issuePrivateBeta({ email: 't@example.com' });
  const res = await post(s.base, '/licenses/feedback', { license_key: record.key, responses: answers({ usedFor: '  hello\u0007 world\u001b[31m \n ok  ' }) });
  assert.equal(res.status, 200);
  assert.ok(resend.calls[0].body.text.includes('hello world[31m \n ok'), JSON.stringify(resend.calls[0].body.text));
  const failing = createLicenseMailer({ apiKey: 'k', from: 'GRAFT <x@y.z>', supportEmail: 'support@leftsocklabs.com', downloadUrl: 'https://d/x.dmg', fetchImpl: async () => { throw new Error('down'); } });
  const s2 = await bootServer({ mailer: failing }); t.after(s2.close);
  const { record: r2 } = await s2.registry.issuePrivateBeta({ email: 't@example.com' });
  const res2 = await post(s2.base, '/licenses/feedback', { license_key: r2.key, responses: answers() });
  assert.equal(res2.status, 502); assert.match((await res2.json()).error, /not lost/);
  assert.equal((await s2.registry.get(r2.key)).feedback, undefined);
});
test('feedback: rate limited per licence and per address', async (t) => {
  const resend = fakeResend(); const s = await bootServer({ mailer: mailer(resend), feedbackLimits: { perKey: { limit: 2, windowMs: 60000 }, perAddress: { limit: 3, windowMs: 60000 } } }); t.after(s.close);
  const { record } = await s.registry.issuePrivateBeta({ email: 'a@example.com' });
  const { record: other } = await s.registry.issuePrivateBeta({ email: 'b@example.com' });
  assert.equal((await post(s.base, '/licenses/feedback', { license_key: record.key, responses: answers() })).status, 200);
  assert.equal((await post(s.base, '/licenses/feedback', { license_key: record.key, responses: answers() })).status, 200);
  assert.equal((await post(s.base, '/licenses/feedback', { license_key: record.key, responses: answers() })).status, 429, 'third for the same licence');
  assert.equal((await post(s.base, '/licenses/feedback', { license_key: other.key, responses: answers() })).status, 429, 'fourth from the same address');
  assert.equal(resend.calls.length, 2);
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
  assert.equal(limiter.take('k'), true); assert.equal(limiter.take('k'), false);
});
test('parseFeedback: only the known fields survive; the client block is bounded', () => {
  const parsed = parseFeedback({ responses: { ...answers(), extra: 'x', to: 'y' }, client: { version: '0.5.0', os: 'macOS 25.6.0', arch: 'arm64', env: { SECRET: '1' }, version2: 'z' } });
  assert.deepEqual(Object.keys(parsed.responses).sort(), ['frustrated', 'rating', 'usedFor', 'workedWell', 'wouldUseAgain']);
  assert.deepEqual(parsed.client, { version: '0.5.0', os: 'macOS 25.6.0', arch: 'arm64' });
  assert.equal(feedbackEmailContent({ rating: 5, responses: answers(), tester: 't@e.co', license: { masked: 'GRAFT-A-••-Z', issuedAt: 'i', expiresAt: 'e', status: 'expired' }, client: {} }).subject, 'GRAFT Private Beta Feedback — 5/5');
});

// ---- Website approval: the internal server-to-server issuance route ----
const TOKEN = 'beta-approval-test-token-0123456789abcdef';
test('internal issue: refuses without the dedicated credential, with a wrong one, and when unconfigured; issues once with the fixed terms; never returns the key; duplicate reported not duplicated', async (t) => {
  const resend = fakeResend(); const c = clock(); const registry = make(c);
  const { server } = createLicensingServer({ config: { ...serverConfig, betaApprovalToken: TOKEN }, stripe: {}, registry, mailer: mailer(resend), now: c.now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (body, auth) => fetch(`${base}/internal/private-beta/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
  assert.equal((await call({ email: 'a@example.com' })).status, 401);
  assert.equal((await call({ email: 'a@example.com' }, 'Bearer nope')).status, 401);
  assert.equal((await call({ email: 'a@example.com' }, `Bearer ${TOKEN}x`)).status, 401);
  assert.equal((await call({ email: 'a@example.com' }, TOKEN)).status, 401);
  assert.equal(resend.calls.length, 0);
  assert.equal((await call({ email: 'not-an-email' }, `Bearer ${TOKEN}`)).status, 400);
  assert.equal((await call({ email: 'a@example.com', days: 90, maxActivations: 5, licenseType: 'purchase' }, `Bearer ${TOKEN}`)).status, 200, 'extra fields are ignored, never honoured');
  const first = await (await call({ email: ' Tester@Example.COM ', reference: 'app_42' }, `Bearer ${TOKEN}`)).json();
  assert.equal(first.ok, true); assert.equal(first.issued, true); assert.equal(first.key, undefined);
  assert.equal(first.license.email, 'tester@example.com'); assert.equal(first.license.seats.max, 1); assert.equal(first.license.expires, 'October 13, 2026'); assert.equal(first.license.delivery.status, 'sent');
  assert.match(first.license.licenseMasked, /^GRAFT-[A-Z2-9]{4}-••••-••••-••••-[A-Z2-9]{4}$/);
  assert.equal(JSON.stringify(first).includes(resend.calls.at(-1).body.text.match(/License key: (GRAFT-[A-Z2-9-]+)/)[1]), false);
  const stored = await registry.findPrivateBeta({ email: 'tester@example.com' });
  assert.equal(stored.maxActivations, 1); assert.equal(Date.parse(stored.expiresAt) - c.now(), 30 * DAY); assert.match(stored.history[0].reason, /reference app_42/);
  const again = await (await call({ email: 'tester@example.com', reference: 'app_42' }, `Bearer ${TOKEN}`)).json();
  assert.equal(again.issued, false); assert.equal(again.reason, 'current-license-exists'); assert.equal(again.license.licenseMasked, first.license.licenseMasked);
  assert.equal((await registry.findPrivateBeta({ email: 'tester@example.com' })).key, stored.key, 'one licence');
  assert.equal(resend.calls.filter((x) => x.body.subject === 'Your GRAFT private beta license').length, 2, 'one invitation per issued licence (the earlier a@example.com and this one)');
  // Unconfigured credential or mail: refuse, issue nothing.
  const quiet = createLicensingServer({ config: serverConfig, stripe: {}, registry, mailer: mailer(resend), now: c.now }).server;
  await new Promise((resolve) => quiet.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((r) => quiet.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${quiet.address().port}/internal/private-beta/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ email: 'z@example.com' }) })).status, 503);
  const nomail = createLicensingServer({ config: { ...serverConfig, betaApprovalToken: TOKEN }, stripe: {}, registry, mailer: createLicenseMailer({}), now: c.now }).server;
  await new Promise((resolve) => nomail.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((r) => nomail.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${nomail.address().port}/internal/private-beta/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ email: 'z@example.com' }) })).status, 503);
  assert.equal(await registry.findPrivateBeta({ email: 'z@example.com' }), null);
  // A short token is never accepted as configured.
  const weak = createLicensingServer({ config: { ...serverConfig, betaApprovalToken: 'short' }, stripe: {}, registry, mailer: mailer(resend), now: c.now }).server;
  await new Promise((resolve) => weak.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise((r) => weak.close(r)));
  assert.equal((await fetch(`http://127.0.0.1:${weak.address().port}/internal/private-beta/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer short' }, body: JSON.stringify({ email: 'z@example.com' }) })).status, 401);
});

// ---- End to end through the REAL desktop service and provider ----
test('END TO END: a private-beta key activates on the desktop, expires authoritatively, becomes the ended state, feedback goes to support, nothing reactivates; extension is picked up by re-activation', async (t) => {
  const resend = fakeResend(); const s = await bootServer({ mailer: mailer(resend) }); t.after(s.close);
  const { record } = await s.registry.issuePrivateBeta({ email: 't@example.com' });
  let stored = null, installation = null;
  const desktopClock = { t: T0 };
  const store = { read: async () => stored, write: async (v) => { stored = structuredClone(v); }, clear: async () => { stored = null; }, readInstallation: async () => installation, writeInstallation: async (id) => { installation = id; } };
  const provider = graftLicenseProvider({ baseUrl: s.base, allowInsecureLoopback: true });
  const desktop = () => createLicenseService({ provider, store, config: { storeId: 1, productId: 1, variantIds: [1], offlineDays: 30, inviteOnly: true }, now: () => desktopClock.t });
  let d = desktop();
  const activated = await d.activate(record.key);
  assert.equal(activated.allowed, true); assert.equal(activated.licenseType, 'private_beta'); assert.equal(activated.expiresAt, Date.parse(record.expiresAt));
  assert.equal(stored.licenseType, 'private_beta'); assert.equal(stored.issuedAt, Date.parse(record.issuedAt));
  // The term ends: the service and the desktop clock both pass expiresAt.
  s.c.advance(30 * DAY); desktopClock.t += 30 * DAY;
  const endedStatus = await d.validate();
  assert.equal(endedStatus.allowed, false); assert.equal(endedStatus.activated, false);
  assert.deepEqual(endedStatus.betaEnded, { issuedAt: Date.parse(record.issuedAt), expiresAt: Date.parse(record.expiresAt), feedbackSubmitted: false, askForFeedback: true });
  assert.equal(stored.betaEnded, true); assert.equal(stored.key, record.key); assert.equal(stored.verifiedAt, undefined, 'the ended record is not an activation record');
  // Relaunch: the ended state is restored without a network round trip and still asks for feedback.
  d = desktop();
  const relaunched = await d.initialize();
  assert.equal(relaunched.betaEnded.askForFeedback, true); assert.equal(relaunched.allowed, false);
  assert.equal(d.dismissFeedback().betaEnded.askForFeedback, false, '"Not now" is remembered for this process only');
  assert.equal((await desktop().initialize()).betaEnded.askForFeedback, true);
  // Feedback through the real provider and route.
  const after = await d.feedback(answers({ rating: 5 }), { version: '0.5.0', os: 'macOS 25', arch: 'arm64' });
  assert.equal(after.allowed, false); assert.equal(after.betaEnded.feedbackSubmitted, true); assert.equal(after.betaEnded.askForFeedback, false);
  assert.deepEqual(resend.calls[0].body.to, ['support@leftsocklabs.com']); assert.equal(resend.calls[0].body.reply_to, 't@example.com');
  assert.equal(stored.feedbackSubmittedAt, desktopClock.t);
  assert.equal((await desktop().initialize()).betaEnded.askForFeedback, false, 'a later launch shows the simpler completed state');
  assert.equal(d.canUse(), false);
  // The same expired key cannot be re-activated…
  await assert.rejects(d.activate(record.key), /private beta access has ended/);
  assert.equal(stored.betaEnded, true, 'the ended state survives a refused re-activation');
  // …until the operator extends it server-side: the next launch (or Validate) resumes on the same seat.
  await s.registry.extendPrivateBeta(record.key, 14);
  const again = await desktop().initialize();
  assert.equal(again.allowed, true); assert.equal(again.betaEnded, null); assert.equal(again.expiresAt, s.c.now() + 14 * DAY);
  assert.equal((await s.registry.get(record.key)).instances.length, 1, 'same installation, same seat');
});
