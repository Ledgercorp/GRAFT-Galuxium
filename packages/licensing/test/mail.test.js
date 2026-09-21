// Commercial Beta 0.1, Checkpoint B — transactional key email as SECONDARY delivery: mailed once
// per licence to the checkout address; a mail failure never touches issuance or payment, is
// recorded on the licence, and is retried by the next fulfilment; unconfigured mail is not an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createLicensingServer } from '../src/server.js';
import { createLicenseRegistry } from '../src/licenses.js';
import { memoryStore } from '../src/store.js';
import { createLicenseMailer, licenseEmailContent } from '../src/mail.js';
import { loadConfig } from '../src/config.js';

const webhookSecret = 'whsec_test_' + 'a'.repeat(24);
const product = { storeId: 1, productId: 1, variantId: 1 };
const config = { merchantOfRecord: 'stripe-managed-payments', managedPayments: true, mode: 'test', webhookSecret, priceId: 'price_1', publicUrl: 'http://127.0.0.1', downloadUrl: 'https://downloads.example/GRAFT.dmg', product, signatureToleranceSec: 300 };
function fakeStripe(email = 'buyer@example.co') {
  const sessions = new Map();
  const expectedPrice = { id: config.priceId, object: 'price', currency: 'usd', unit_amount: 4900, type: 'one_time', recurring: null, product: 'prod_graft' };
  const expectedProduct = { id: 'prod_graft', name: 'GRAFT', tax_code: 'txcd_10202003', metadata: { graft: 'desktop-onetime' } };
  return {
    createCheckoutSession: async ({ successUrl = 'x' } = {}) => { const id = `cs_${crypto.randomUUID()}`; sessions.set(id, { id, payment_status: 'paid', mode: 'payment', currency: 'usd', amount_subtotal: 4900, amount_total: 5243, payment_intent: `pi_${id}`, customer_details: email ? { email } : null, line_items: { data: [{ quantity: 1, amount_subtotal: 4900, price: expectedPrice }], has_more: false }, url: `https://checkout.stripe.com/pay/${id}`, successUrl }); return sessions.get(id); },
    retrieveSession: async (id) => sessions.get(id) || { id, payment_status: 'unpaid' },
    retrievePrice: async () => expectedPrice,
    retrieveProduct: async () => expectedProduct,
  };
}
const sign = (payload) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', webhookSecret).update(`${t}.${payload}`).digest('hex')}`; };
/** A fake Resend endpoint: records every request; answers per the script. */
function fakeResend(script = []) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }); const next = script.shift() || { status: 200 }; if (next.throw) throw Object.assign(new Error('boom'), { name: next.throw }); return { status: next.status, async json() { return { id: 'email_1' }; } }; };
  return { calls, fetchImpl };
}
async function boot({ mailer, email } = {}) {
  const registry = createLicenseRegistry({ store: memoryStore(), product, maxActivations: 3 });
  const stripe = fakeStripe(email);
  const { server } = createLicensingServer({ config, stripe, registry, mailer });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const webhook = async (session) => { const payload = JSON.stringify({ id: `evt_${session.id}`, type: 'checkout.session.completed', data: { object: session } }); return fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sign(payload) }, body: payload }); };
  return { registry, stripe, base, webhook, close: () => new Promise((r) => server.close(r)) };
}
const mailerWith = (resend) => createLicenseMailer({ apiKey: 're_test_key', from: 'GRAFT <graft@leftsock.example>', supportEmail: 'support@leftsock.example', downloadUrl: 'https://downloads.example/GRAFT.dmg', fetchImpl: resend.fetchImpl });

test('the licence key is mailed once, to the checkout address, with download link, activation instruction and support contact — and no Stripe ids', async (t) => {
  const resend = fakeResend(); const env = await boot({ mailer: mailerWith(resend) }); t.after(env.close);
  const session = await env.stripe.createCheckoutSession();
  assert.equal((await env.webhook(session)).status, 200);
  const record = await env.registry.getBySession(session.id);
  assert.equal(record.status, 'active'); assert.deepEqual([record.delivery.status, record.delivery.attempts, record.delivery.providerId], ['sent', 1, 'email_1']);
  assert.equal(resend.calls.length, 1);
  const mail = resend.calls[0];
  assert.equal(mail.url, 'https://api.resend.com/emails'); assert.equal(mail.auth, 'Bearer re_test_key');
  assert.deepEqual(mail.body.to, ['buyer@example.co']); assert.equal(mail.body.reply_to, 'support@leftsock.example'); assert.equal(mail.body.subject, 'Your GRAFT licence key');
  assert.match(mail.body.text, new RegExp(`Your licence key: ${record.key}`)); assert.match(mail.body.text, /https:\/\/downloads\.example\/GRAFT\.dmg/); assert.match(mail.body.text, /paste the key on the licence page/); assert.match(mail.body.text, /support@leftsock\.example/);
  assert.doesNotMatch(mail.body.text, /cs_|pi_|evt_|sk_|whsec_/, 'no Stripe identifiers or secrets');
  // Replays and the success page do not mail again; exactly one licence.
  assert.equal((await env.webhook(session)).status, 200);
  const html = await (await fetch(`${env.base}/success?session_id=${session.id}`)).text();
  assert.match(html, new RegExp(record.key));
  assert.equal(resend.calls.length, 1); assert.equal((await env.registry.getBySession(session.id)).key, record.key);
});

test('mail failure never touches issuance: the licence is issued and shown, the failure is recorded, and the next fulfilment retries once', async (t) => {
  const resend = fakeResend([{ status: 500 }, { throw: 'AbortError' }, { status: 200 }]); const env = await boot({ mailer: mailerWith(resend) }); t.after(env.close);
  const session = await env.stripe.createCheckoutSession();
  assert.equal((await env.webhook(session)).status, 200);
  let record = await env.registry.getBySession(session.id);
  assert.equal(record.status, 'active'); assert.deepEqual([record.delivery.status, record.delivery.error, record.delivery.attempts], ['failed', 'mail provider returned HTTP 500', 1]);
  // The success page shows the key regardless, and retries the mail (unreachable this time).
  const html = await (await fetch(`${env.base}/success?session_id=${session.id}`)).text();
  assert.match(html, new RegExp(record.key));
  record = await env.registry.getBySession(session.id);
  assert.deepEqual([record.delivery.status, record.delivery.attempts], ['failed', 2]); assert.match(record.delivery.error, /unreachable \(AbortError\)/);
  // A webhook replay retries again and succeeds; still one licence, still the same key.
  assert.equal((await env.webhook(session)).status, 200);
  record = await env.registry.getBySession(session.id);
  assert.deepEqual([record.delivery.status, record.delivery.attempts, record.key === record.key], ['sent', 3, true]);
  assert.equal(resend.calls.length, 3); assert.ok(resend.calls.every((c) => c.body.text.includes(record.key)));
});

test('unconfigured mail is not an error; a purchase with no email address is recorded as such; a malformed key is never mailed', async (t) => {
  const none = await boot({ mailer: null }); t.after(none.close);
  const s1 = await none.stripe.createCheckoutSession(); assert.equal((await none.webhook(s1)).status, 200);
  assert.equal((await none.registry.getBySession(s1.id)).delivery, undefined);
  const disabled = createLicenseMailer({});
  assert.equal(disabled.enabled, false); assert.deepEqual(await disabled.send({ to: 'x@y.z', key: 'GRAFT-ABCD-EFGH-JKLM-NPQR-STUV' }), { sent: false, status: 'not-configured', error: null });
  const resend = fakeResend(); const env = await boot({ mailer: mailerWith(resend), email: null }); t.after(env.close);
  const s2 = await env.stripe.createCheckoutSession(); assert.equal((await env.webhook(s2)).status, 200);
  const record = await env.registry.getBySession(s2.id);
  assert.equal(record.status, 'active'); assert.deepEqual([record.delivery.status, record.delivery.error], ['no-address', 'no valid customer email']); assert.equal(resend.calls.length, 0);
  assert.equal((await mailerWith(fakeResend()).send({ to: 'a@b.co', key: 'not-a-key' })).status, 'failed');
  const content = licenseEmailContent({ key: 'GRAFT-ABCD-EFGH-JKLM-NPQR-STUV', downloadUrl: 'https://d/x.dmg', supportEmail: 's@e.co' });
  assert.match(content.text, /three computers/); assert.match(content.text, /diagnostic bundle/);
  // Configuration comes only from the environment; the API key is a secret that stays there.
  const cfg = loadConfig({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_x', RESEND_API_KEY: 're_x', GRAFT_MAIL_FROM: 'GRAFT <g@e.co>', GRAFT_SUPPORT_EMAIL: 's@e.co', GRAFT_DOWNLOAD_URL: 'https://d/x.dmg' });
  assert.deepEqual(cfg.mail, { apiKey: 're_x', from: 'GRAFT <g@e.co>', supportEmail: 's@e.co' });
});
