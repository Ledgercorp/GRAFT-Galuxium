import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createLicensingServer, isFullRefund } from '../src/server.js';
import { successPage, safeHref } from '../src/pages.js';
import { url as serverUrl } from '../src/config.js';
import { resolveLicenseEndpoint } from '../../desktop/src/license-provider.js';
import { isValidInstallationId as clientAccepts } from '../../desktop/src/license-service.js';
import { isValidInstallationId as serverAccepts } from '../src/licenses.js';
import { createLicenseRegistry } from '../src/licenses.js';
import { memoryStore } from '../src/store.js';
import { createLicenseService } from '../../desktop/src/license-service.js';
import { graftLicenseProvider, LicenseUnavailable } from '../../desktop/src/license-provider.js';
import { StripeError } from '../src/stripe.js';

const product = { storeId: 1, productId: 1, variantId: 1 };
const webhookSecret = 'whsec_test';
const config = {
  merchantOfRecord: 'stripe-managed-payments', managedPayments: true, mode: 'test',
  webhookSecret, priceId: 'price_1', publicUrl: 'http://127.0.0.1', downloadUrl: 'https://downloads.example/GRAFT.dmg',
  product, signatureToleranceSec: 300,
};

function fakeStripe({ paid = true, canonicalPrice = {}, canonicalProduct = {} } = {}) {
  const sessions = new Map();
  const expectedPrice = {
    id: config.priceId,
    object: 'price',
    currency: 'usd',
    unit_amount: 4900,
    type: 'one_time',
    recurring: null,
    product: 'prod_graft',
    ...canonicalPrice,
  };
  const expectedProduct = { id: expectedPrice.product, name: 'GRAFT', tax_code: 'txcd_10202003', metadata: { graft: 'desktop-onetime' }, ...canonicalProduct };
  return {
    createCheckoutSession: async ({ successUrl, priceId = config.priceId }) => {
      const id = `cs_${crypto.randomUUID()}`;
      const linePrice = { ...expectedPrice, id: priceId };
      sessions.set(id, {
        id,
        payment_status: paid ? 'paid' : 'unpaid',
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: 4900,
        amount_total: 5243,
        payment_intent: `pi_${id}`,
        customer_details: { email: 'buyer@example.co' },
        line_items: { data: [{ quantity: 1, amount_subtotal: 4900, price: linePrice }], has_more: false },
        url: `https://checkout.stripe.com/pay/${id}`,
        successUrl,
      });
      return sessions.get(id);
    },
    retrieveSession: async (id) => sessions.get(id) || { id, payment_status: 'unpaid' },
    retrievePrice: async () => expectedPrice,
    retrieveProduct: async () => expectedProduct,
    _sessions: sessions,
    _expectedPrice: expectedPrice,
    _expectedProduct: expectedProduct,
  };
}

function sign(payload) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', webhookSecret).update(`${t}.${payload}`).digest('hex')}`;
}

async function boot(over = {}) {
  const store = memoryStore();
  const registry = createLicenseRegistry({ store, product, maxActivations: 2 });
  const stripe = over.stripe || fakeStripe();
  const { server } = createLicensingServer({ config: { ...config, ...over.config }, stripe, registry });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { registry, store, stripe, base, server, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('buy creates a checkout session and redirects to Stripe', async (t) => {
  const env = await boot(); t.after(env.close);
  const res = await fetch(`${env.base}/buy`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /checkout\.stripe\.com\/pay\/cs_/);
});

test('a signed completed-checkout webhook issues exactly one license; the success page reveals it', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } });
  const first = await post(env.base, '/webhook', payload, { 'stripe-signature': sign(payload) });
  assert.equal(first.status, 200);
  const replay = await post(env.base, '/webhook', payload, { 'stripe-signature': sign(payload) }); // retry
  assert.equal(replay.status, 200);
  const record = await env.registry.getBySession(session.id);
  assert.ok(record && record.status === 'active');
  const success = await fetch(`${env.base}/success?session_id=${session.id}`);
  const html = await success.text();
  assert.match(html, new RegExp(record.key.replace(/[-]/g, '\\-')));
  assert.match(html, /Merchant of Record/i);
});

test('a client CANNOT forge payment success: an unsigned/mis-signed webhook is refused and issues nothing', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const payload = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: session } });
  assert.equal((await post(env.base, '/webhook', payload)).status, 400); // no signature
  assert.equal((await post(env.base, '/webhook', payload, { 'stripe-signature': 't=1,v1=deadbeef' })).status, 400);
  const forged = JSON.stringify({ id: 'evt_y', type: 'checkout.session.completed', data: { object: { ...session, id: 'cs_attacker' } } });
  assert.equal((await post(env.base, '/webhook', forged, { 'stripe-signature': sign(payload) })).status, 400); // body != signed payload
  assert.equal(await env.registry.getBySession(session.id), null);
  assert.equal(await env.registry.getBySession('cs_attacker'), null);
});

test('the success page never issues a license for an unpaid session', async (t) => {
  const env = await boot({ stripe: fakeStripe({ paid: false }) }); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const res = await fetch(`${env.base}/success?session_id=${session.id}`);
  assert.match(await res.text(), /Confirming your payment/);
  assert.equal(await env.registry.getBySession(session.id), null);
});

test('the success page issues server-side for a paid session even before the webhook arrives', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const res = await fetch(`${env.base}/success?session_id=${session.id}`);
  assert.match(await res.text(), new RegExp('GRAFT-'));
  assert.ok((await env.registry.getBySession(session.id)).status === 'active');
});

test('AUTHORITY: a paid foreign Price issues no license through either success or webhook', async (t) => {
  const successEnv = await boot(); t.after(successEnv.close);
  const foreign = await successEnv.stripe.createCheckoutSession({ successUrl: 'x', priceId: 'price_foreign_100' });
  foreign.amount_subtotal = 100;
  foreign.amount_total = 100;
  foreign.line_items.data[0].amount_subtotal = 100;
  foreign.line_items.data[0].price.unit_amount = 100;
  const page = await fetch(`${successEnv.base}/success?session_id=${foreign.id}`);
  assert.doesNotMatch(await page.text(), /GRAFT-[A-Z2-9]/);
  assert.equal(await successEnv.registry.getBySession(foreign.id), null);

  const webhookEnv = await boot(); t.after(webhookEnv.close);
  const webhookForeign = await webhookEnv.stripe.createCheckoutSession({ successUrl: 'x', priceId: 'price_foreign_100' });
  webhookForeign.amount_subtotal = 100;
  webhookForeign.line_items.data[0].amount_subtotal = 100;
  webhookForeign.line_items.data[0].price.unit_amount = 100;
  assert.equal((await webhook(webhookEnv, 'evt_foreign', 'checkout.session.completed', webhookForeign)).status, 200);
  assert.equal(await webhookEnv.registry.getBySession(webhookForeign.id), null);
});

test('AUTHORITY: foreign Product, wrong quantity, recurring Price, or wrong currency issues no license', async (t) => {
  const cases = [
    { name: 'foreign product', mutate: (session) => { session.line_items.data[0].price.product = 'prod_foreign'; } },
    { name: 'wrong quantity', mutate: (session) => { session.line_items.data[0].quantity = 2; session.line_items.data[0].amount_subtotal = 9800; } },
    { name: 'wrong currency', mutate: (session) => { session.currency = 'eur'; } },
  ];
  for (const entry of cases) {
    const env = await boot(); t.after(env.close);
    const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
    entry.mutate(session);
    await fetch(`${env.base}/success?session_id=${session.id}`);
    assert.equal(await env.registry.getBySession(session.id), null, entry.name);
  }

  const recurring = await boot({ stripe: fakeStripe({ canonicalPrice: { type: 'recurring', recurring: { interval: 'month' } } }) });
  t.after(recurring.close);
  const session = await recurring.stripe.createCheckoutSession({ successUrl: 'x' });
  await fetch(`${recurring.base}/success?session_id=${session.id}`);
  assert.equal(await recurring.registry.getBySession(session.id), null, 'recurring price');

  const foreignProduct = await boot({ stripe: fakeStripe({ canonicalProduct: { name: 'Another product', metadata: { graft: 'other' } } }) });
  t.after(foreignProduct.close);
  const foreignProductSession = await foreignProduct.stripe.createCheckoutSession({ successUrl: 'x' });
  await fetch(`${foreignProduct.base}/success?session_id=${foreignProductSession.id}`);
  assert.equal(await foreignProduct.registry.getBySession(foreignProductSession.id), null, 'configured Price belongs to a foreign Product');
});

test('AUTHORITY: Managed Payments tax may change amount_total without rejecting the $49 pre-tax item', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  session.amount_total = 5733;
  const response = await fetch(`${env.base}/success?session_id=${session.id}`);
  assert.match(await response.text(), /GRAFT-[A-Z2-9]/);
  assert.equal((await env.registry.getBySession(session.id)).status, 'active');
});

test('AUTHORITY: canonical Stripe uncertainty never issues and remains retryable', async (t) => {
  const stripe = fakeStripe();
  const session = await stripe.createCheckoutSession({ successUrl: 'x' });
  stripe.retrieveSession = async () => { throw new StripeError('temporary outage'); };
  const env = await boot({ stripe }); t.after(env.close);

  const success = await fetch(`${env.base}/success?session_id=${session.id}`);
  assert.equal(success.status, 502);
  assert.match(await success.text(), /refresh shortly/i);
  assert.equal(await env.registry.getBySession(session.id), null);

  const hook = await webhook(env, 'evt_retry', 'checkout.session.completed', session);
  assert.equal(hook.status, 502);
  assert.equal(await env.registry.getBySession(session.id), null);
});

test('download entitlement requires a valid activated license', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const record = await env.registry.issue({ sessionId: session.id, paymentIntent: session.payment_intent });
  const activation = await env.registry.activate(record.key, { installationId: 'mac-00000001', instanceName: 'mac' });
  const denied = await fetch(`${env.base}/download?key=GRAFT-NOPE&instance=x`, { redirect: 'manual' });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${env.base}/download?key=${record.key}&instance=${activation.instance.id}`, { redirect: 'manual' });
  assert.equal(allowed.status, 303);
  assert.equal(allowed.headers.get('location'), config.downloadUrl);
});

test('end to end through the REAL desktop license service and provider', async (t) => {
  const env = await boot(); t.after(env.close);
  const provider = graftLicenseProvider({ baseUrl: env.base, allowInsecureLoopback: true });
  let record = null, installation = null;
  const store = { read: async () => record, write: async (v) => { record = structuredClone(v); }, clear: async () => { record = null; },
    readInstallation: async () => installation, writeInstallation: async (id) => { installation = id; } };
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const service = createLicenseService({ provider, store, config: { storeId: 1, productId: 1, variantIds: [1], offlineDays: 30 }, now: () => clock });

  // A license only exists because the backend issued it after (simulated) payment.
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const issued = await env.registry.issue({ sessionId: session.id, paymentIntent: session.payment_intent });

  assert.equal(service.canUse(), false);
  assert.equal((await service.activate(issued.key)).allowed, true);
  assert.equal((await service.validate()).allowed, true);

  // Offline: provider unreachable → cached license still usable within the 30-day grace.
  const offline = graftLicenseProvider({ baseUrl: env.base, allowInsecureLoopback: true, fetchImpl: async () => { throw new Error('down'); } });
  const offlineService = createLicenseService({ provider: offline, store, config: { storeId: 1, productId: 1, variantIds: [1], offlineDays: 30 }, now: () => clock });
  assert.equal((await offlineService.initialize()).allowed, true);
  clock += 31 * 86400000; // past the bounded grace window
  assert.equal(offlineService.canUse(), false);

  // Refund revokes server-side; the next online validation fails closed and clears the record.
  await env.registry.revokeByPaymentIntent(session.payment_intent, 'charge.refunded');
  clock = Date.parse('2026-01-02T00:00:00Z');
  assert.equal((await service.validate()).allowed, false);
  assert.equal(record, null);
});

test('the offline provider surfaces LicenseUnavailable, not a hard rejection', async () => {
  const provider = graftLicenseProvider({ baseUrl: 'http://127.0.0.1:1', allowInsecureLoopback: true, fetchImpl: async () => { throw new Error('refused'); } });
  await assert.rejects(provider.validate('GRAFT-X', 'i'), LicenseUnavailable);
});

const webhook = (env, id, type, object) => { const payload = JSON.stringify({ id, type, data: { object } }); return post(env.base, '/webhook', payload, { 'stripe-signature': sign(payload) }); };
async function paidLicense(env) {
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const record = await env.registry.issue({ sessionId: session.id, paymentIntent: session.payment_intent });
  const activation = await env.registry.activate(record.key, { installationId: 'mac-00000001', instanceName: 'GRAFT desktop' });
  return { session, record, activation, charge: { id: 'ch_1', object: 'charge', payment_intent: session.payment_intent, amount: 5243, currency: 'usd' } };
}
const valid = (env, key, instance) => env.registry.validate(key, instance).then((r) => r.valid);

test('isFullRefund follows Stripe charge semantics: refunded flag, amounts, ambiguity', () => {
  assert.equal(isFullRefund({ refunded: true, amount: 5243, amount_refunded: 5243 }), true);
  assert.equal(isFullRefund({ refunded: false, amount: 5243, amount_refunded: 100 }), false);
  assert.equal(isFullRefund({ amount: 5243, amount_refunded: 5243 }), true);        // flag absent, amounts decide
  assert.equal(isFullRefund({ amount: 5243, amount_refunded: 5242 }), false);
  assert.equal(isFullRefund({ refunded: false }), false);                            // authoritative flag alone
  assert.equal(isFullRefund({}), null);                                              // ambiguous -> caller fails closed
  assert.equal(isFullRefund({ amount: 0, amount_refunded: 0 }), null);
});

test('a PARTIAL refund keeps the license usable and is recorded for audit', async (t) => {
  const env = await boot(); t.after(env.close);
  const { record, activation, charge } = await paidLicense(env);
  const res = await webhook(env, 'evt_pr', 'charge.refunded', { ...charge, refunded: false, amount_refunded: 100 });
  assert.equal(res.status, 200);
  assert.equal(await valid(env, record.key, activation.instance.id), true);
  const stored = await env.registry.get(record.key);
  assert.equal(stored.status, 'active');
  assert.match(stored.history.at(-1).reason, /partial refund 100\/5243/);
});

test('a FULL refund revokes; repeated delivery of the refund event is idempotent', async (t) => {
  const env = await boot(); t.after(env.close);
  const { record, activation, charge } = await paidLicense(env);
  const full = { ...charge, refunded: true, amount_refunded: 5243 };
  assert.equal((await webhook(env, 'evt_fr', 'charge.refunded', full)).status, 200);
  assert.equal(await valid(env, record.key, activation.instance.id), false);
  assert.equal((await webhook(env, 'evt_fr', 'charge.refunded', full)).status, 200); // Stripe retry
  assert.equal((await webhook(env, 'evt_fr2', 'charge.refunded', full)).status, 200);
  const stored = await env.registry.get(record.key);
  assert.equal(stored.status, 'revoked');
  assert.equal(stored.revokedReason, 'charge.refunded');
  assert.equal(stored.history.filter((h) => h.to === 'revoked' && h.from !== 'revoked').length, 1, 'revoked exactly once');
});

test('a partial refund that later becomes full revokes; an ambiguous refund payload fails closed', async (t) => {
  const env = await boot(); t.after(env.close);
  const { record, activation, charge } = await paidLicense(env);
  await webhook(env, 'evt_p1', 'charge.refunded', { ...charge, refunded: false, amount_refunded: 2000 });
  assert.equal(await valid(env, record.key, activation.instance.id), true);
  await webhook(env, 'evt_p2', 'charge.refunded', { ...charge, refunded: false, amount_refunded: 5243 }); // amounts say full even if flag lags
  assert.equal(await valid(env, record.key, activation.instance.id), false);

  const env2 = await boot(); t.after(env2.close);
  const second = await paidLicense(env2);
  await webhook(env2, 'evt_amb', 'charge.refunded', { id: 'ch_2', object: 'charge', payment_intent: second.session.payment_intent });
  assert.equal(await valid(env2, second.record.key, second.activation.instance.id), false);
  assert.match((await env2.registry.get(second.record.key)).revokedReason, /ambiguous/);
});

test('dispute lifecycle over signed webhooks: inquiry suspends, warning_closed restores; chargeback lost revokes; won after funds withdrawn restores', async (t) => {
  const env = await boot(); t.after(env.close);
  const { record, activation, session } = await paidLicense(env);
  const dispute = (id, status) => ({ id, object: 'dispute', payment_intent: session.payment_intent, charge: 'ch_1', status, amount: 5243 });
  const state = async () => (await env.registry.get(record.key)).status;

  // Bank inquiry: suspended, not revoked; desktop fails closed meanwhile.
  await webhook(env, 'e1', 'charge.dispute.created', dispute('du_inq', 'warning_needs_response'));
  assert.equal(await state(), 'suspended');
  assert.equal(await valid(env, record.key, activation.instance.id), false);
  await webhook(env, 'e2', 'charge.dispute.updated', dispute('du_inq', 'warning_under_review'));
  assert.equal(await state(), 'suspended');
  await webhook(env, 'e3', 'charge.dispute.closed', dispute('du_inq', 'warning_closed'));
  assert.equal(await state(), 'active');
  assert.equal(await valid(env, record.key, activation.instance.id), true, 'the same activation resumes');
  await webhook(env, 'e1', 'charge.dispute.created', dispute('du_inq', 'warning_needs_response')); // replayed after close
  assert.equal(await state(), 'active');

  // Formal chargeback: funds withdrawn -> revoked; merchant wins -> reinstated -> restored.
  await webhook(env, 'e4', 'charge.dispute.created', dispute('du_cb', 'needs_response'));
  assert.equal(await state(), 'suspended');
  await webhook(env, 'e5', 'charge.dispute.funds_withdrawn', dispute('du_cb', 'needs_response'));
  assert.equal(await state(), 'revoked');
  await webhook(env, 'e5', 'charge.dispute.funds_withdrawn', dispute('du_cb', 'needs_response')); // replay
  assert.equal(await state(), 'revoked');
  await webhook(env, 'e6', 'charge.dispute.closed', dispute('du_cb', 'won'));
  await webhook(env, 'e7', 'charge.dispute.funds_reinstated', dispute('du_cb', 'won'));
  assert.equal(await state(), 'active');
  assert.equal(await valid(env, record.key, activation.instance.id), true);

  // Second chargeback lost: revoked and stays revoked through any later replay.
  await webhook(env, 'e8', 'charge.dispute.created', dispute('du_lost', 'needs_response'));
  await webhook(env, 'e9', 'charge.dispute.closed', dispute('du_lost', 'lost'));
  assert.equal(await state(), 'revoked');
  await webhook(env, 'e7', 'charge.dispute.funds_reinstated', dispute('du_cb', 'won')); // stale event for the OLD dispute
  assert.equal(await state(), 'revoked', 'a different dispute cannot restore a license revoked by this one');
  assert.equal(await valid(env, record.key, activation.instance.id), false);
});

test('a dispute event without a payment intent or dispute id changes nothing (never fails open)', async (t) => {
  const env = await boot(); t.after(env.close);
  const { record, activation } = await paidLicense(env);
  assert.equal((await webhook(env, 'e_nopi', 'charge.dispute.created', { id: 'du_x', object: 'dispute', status: 'needs_response' })).status, 200);
  assert.equal((await webhook(env, 'e_noid', 'charge.dispute.closed', { object: 'dispute', payment_intent: 'pi_other', status: 'won' })).status, 200);
  assert.equal(await valid(env, record.key, activation.instance.id), true);
  assert.equal((await env.registry.get(record.key)).status, 'active');
});

test('/licenses/activate requires installation_id and enforces seats per installation over HTTP', async (t) => {
  const env = await boot(); t.after(env.close); // maxActivations: 2
  const { record } = await paidLicense(env); // one seat already used by mac-00000001
  assert.equal((await post(env.base, '/licenses/activate', { license_key: record.key, instance_name: 'GRAFT desktop' })).status, 400);
  assert.equal((await post(env.base, '/licenses/activate', { license_key: record.key, installation_id: 'no', instance_name: 'GRAFT desktop' })).status, 400);
  const same = await (await post(env.base, '/licenses/activate', { license_key: record.key, installation_id: 'mac-00000001', instance_name: 'GRAFT desktop' })).json();
  assert.equal(same.activated, true);
  const second = await (await post(env.base, '/licenses/activate', { license_key: record.key, installation_id: 'mac-00000002', instance_name: 'GRAFT desktop' })).json();
  assert.equal(second.activated, true);
  const third = await (await post(env.base, '/licenses/activate', { license_key: record.key, installation_id: 'mac-00000003', instance_name: 'GRAFT desktop' })).json();
  assert.equal(third.activated, false);
  assert.equal((await env.registry.get(record.key)).instances.length, 2);
});

test('the success page never renders a non-http(s) href, even if configuration were bypassed', () => {
  for (const bad of ['javascript://localhost/alert(1)', 'javascript:alert(1)', 'data:text/html,x', 'ftp://localhost/x', 'file:///x', 'not a url']) {
    assert.equal(safeHref(bad), null, bad);
    assert.doesNotMatch(successPage({ key: 'GRAFT-TEST', downloadUrl: bad }), /href=/, bad);
  }
  assert.match(successPage({ key: 'GRAFT-TEST', downloadUrl: 'https://d.example/GRAFT.dmg' }), /href="https:\/\/d\.example\/GRAFT\.dmg"/);
  assert.match(successPage({ key: 'GRAFT-TEST', downloadUrl: 'https://d.example/x?a=1&b="<' }), /href="https:\/\/d\.example\/x\?a=1&amp;b=%22%3C"/);
});

test('INVARIANT BREACH: a signed PAID checkout without a payment_intent is dead-lettered, acknowledged 200, never issued, never duplicated, and surfaces on /health and the success page', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const broken = { ...session, payment_intent: null, customer_details: { email: 'buyer@example.co' } };
  env.stripe._sessions.set(session.id, broken); // Stripe's retrieve also lacks it
  const errors = []; const original = console.error; console.error = (m) => errors.push(String(m)); t.after(() => { console.error = original; });

  const first = await webhook(env, 'evt_b1', 'checkout.session.completed', broken);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { received: true, quarantined: true, reference: session.id });
  assert.equal(await env.registry.getBySession(session.id), null, 'no license issued');
  // Stripe retries (same event) and a re-fire (new event id) converge on one dead letter.
  await webhook(env, 'evt_b1', 'checkout.session.completed', broken);
  await webhook(env, 'evt_b2', 'checkout.session.completed', broken);
  const letters = await env.registry.deadLetters();
  assert.equal(letters.length, 1);
  assert.deepEqual(letters[0].eventIds, ['evt_b1', 'evt_b2']);
  assert.equal(letters[0].count, 3);
  assert.equal(letters[0].sessionId, session.id);
  assert.match(letters[0].reason, /payment_intent/);
  assert.equal(JSON.stringify(letters).includes('buyer@example.co'), false, 'no PII in the dead letter');
  assert.ok(errors.some((m) => /INVARIANT BREACH/.test(m) && m.includes(session.id)), 'logged loudly with the reference');
  assert.ok(errors.every((m) => !m.includes('buyer@example.co')), 'no PII in logs');
  // Health reports the condition so monitoring cannot miss it.
  const health = await fetch(`${env.base}/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { service: 'graft-licensing', merchantOfRecord: 'stripe-managed-payments', mode: 'test', ok: false, deadLetters: 1 });
  // The customer sees a review page with the reference — not an error, not a key, not a dead end.
  const page = await (await fetch(`${env.base}/success?session_id=${session.id}`)).text();
  assert.match(page, /under review/i); assert.match(page, new RegExp(session.id)); assert.doesNotMatch(page, /GRAFT-[A-Z0-9]{4}-/);
  assert.equal((await env.registry.deadLetters()).length, 1, 'the success page joins the same entry');
  assert.equal(await env.registry.getBySession(session.id), null);

  // Resolution: Stripe later delivers the session WITH its payment intent -> issued once, dead letter cleared.
  const fixed = { ...broken, payment_intent: 'pi_recovered' };
  env.stripe._sessions.set(session.id, fixed);
  assert.equal((await webhook(env, 'evt_b3', 'checkout.session.completed', fixed)).status, 200);
  const record = await env.registry.getBySession(session.id);
  assert.ok(record && record.status === 'active' && record.paymentIntent === 'pi_recovered');
  assert.equal((await env.registry.deadLetters()).length, 0);
  assert.equal((await fetch(`${env.base}/health`)).status, 200);
  const stale = await webhook(env, 'evt_b1', 'checkout.session.completed', broken); // a stale retry of the broken event after resolution
  assert.deepEqual(await stale.json(), { received: true }, 'not quarantined again');
  assert.equal((await env.registry.getBySession(session.id)).key, record.key, 'still exactly one license');
  assert.equal((await env.registry.deadLetters()).length, 0, 'a resolved session is never re-dead-lettered');
  assert.equal((await fetch(`${env.base}/health`)).status, 200);
  assert.deepEqual(await env.registry.deadLetter({ sessionId: session.id, type: 'x', reason: 'y' }), { sessionId: session.id, resolved: true, key: record.key });
});

test('the dead-letter store survives a file-backed restart', async (t) => {
  const { fileStore } = await import('../src/store.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-dl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'licenses.json');
  const a = createLicenseRegistry({ store: fileStore(file), product });
  await a.deadLetter({ sessionId: 'cs_persist', eventId: 'evt_p', type: 'checkout.session.completed', reason: 'paid session carried no payment_intent' });
  const b = createLicenseRegistry({ store: fileStore(file), product });
  assert.equal((await b.deadLetters())[0].sessionId, 'cs_persist');
  await b.issue({ sessionId: 'cs_persist', paymentIntent: 'pi_p' });
  assert.equal((await b.deadLetters()).length, 0);
});

test('CONTRACT: the desktop client and the backend accept and reject exactly the same installation-id grammar', () => {
  const samples = [
    '8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f', 'abcdefgh', 'a.b_c-d1', 'x'.repeat(128),   // accepted
    '', 'abcdefg', 'x'.repeat(129), 'has space1', 'GRAFT desktop', 'unicodé-id', 'semi;colon1', 'slash/id12', null, undefined, 42, {},
  ];
  for (const sample of samples) assert.equal(clientAccepts(sample), serverAccepts(sample), `disagreement on ${JSON.stringify(sample)}`);
  assert.equal(clientAccepts('8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'), true);
  assert.equal(clientAccepts('GRAFT desktop'), false);
});

test('ORDERING: charge.refunded delivered before checkout.session.completed -> license issued revoked; success page hides the key; download refused', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const charge = { id: 'ch_o1', object: 'charge', payment_intent: session.payment_intent, amount: 5243, amount_refunded: 5243, refunded: true };
  assert.equal((await webhook(env, 'e_r', 'charge.refunded', charge)).status, 200);
  assert.equal(await env.registry.getBySession(session.id), null);
  assert.equal((await webhook(env, 'e_c', 'checkout.session.completed', session)).status, 200);
  const record = await env.registry.getBySession(session.id);
  assert.equal(record.status, 'revoked');
  const page = await (await fetch(`${env.base}/success?session_id=${session.id}`)).text();
  assert.match(page, /not active/i); assert.doesNotMatch(page, new RegExp(record.key)); assert.doesNotMatch(page, /Download GRAFT/);
  assert.equal((await fetch(`${env.base}/download?key=${record.key}&instance=x`, { redirect: 'manual' })).status, 403);
  await webhook(env, 'e_r', 'charge.refunded', charge); await webhook(env, 'e_c', 'checkout.session.completed', session); // replays
  assert.equal((await env.registry.getBySession(session.id)).key, record.key);
  assert.equal((await env.registry.getBySession(session.id)).status, 'revoked');
});

test('ORDERING: dispute created before completion -> issued suspended (page says on hold); won afterwards -> active and the key is then shown', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const dispute = (status) => ({ id: 'du_o2', object: 'dispute', payment_intent: session.payment_intent, status });
  await webhook(env, 'e_d1', 'charge.dispute.created', dispute('needs_response'));
  await webhook(env, 'e_c', 'checkout.session.completed', session);
  const record = await env.registry.getBySession(session.id);
  assert.equal(record.status, 'suspended');
  let page = await (await fetch(`${env.base}/success?session_id=${session.id}`)).text();
  assert.match(page, /on hold/i); assert.doesNotMatch(page, new RegExp(record.key));
  await webhook(env, 'e_d2', 'charge.dispute.closed', dispute('won'));
  assert.equal((await env.registry.getBySession(session.id)).status, 'active');
  page = await (await fetch(`${env.base}/success?session_id=${session.id}`)).text();
  assert.match(page, new RegExp(record.key));
});

test('ORDERING: dispute lost before completion -> revoked; dispute won before completion -> active; refund + later dispute win -> revoked', async (t) => {
  const env = await boot(); t.after(env.close);
  const cases = [
    { events: [['charge.dispute.created', 'needs_response'], ['charge.dispute.closed', 'lost']], expect: 'revoked' },
    { events: [['charge.dispute.created', 'warning_needs_response'], ['charge.dispute.closed', 'warning_closed']], expect: 'active' },
    { events: [['charge.dispute.created', 'needs_response'], ['charge.dispute.funds_withdrawn', 'needs_response']], expect: 'revoked' },
  ];
  let n = 0;
  for (const { events, expect } of cases) {
    const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
    for (const [type, status] of events) await webhook(env, `e_${n += 1}`, type, { id: `du_${session.id}`, object: 'dispute', payment_intent: session.payment_intent, status });
    await webhook(env, `e_${n += 1}`, 'checkout.session.completed', session);
    assert.equal((await env.registry.getBySession(session.id)).status, expect, JSON.stringify(events));
  }
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  await webhook(env, 'e_rf', 'charge.refunded', { id: 'ch', object: 'charge', payment_intent: session.payment_intent, amount: 5243, amount_refunded: 5243, refunded: true });
  await webhook(env, 'e_dc', 'charge.dispute.created', { id: 'du_rf', object: 'dispute', payment_intent: session.payment_intent, status: 'needs_response' });
  await webhook(env, 'e_dw', 'charge.dispute.closed', { id: 'du_rf', object: 'dispute', payment_intent: session.payment_intent, status: 'won' });
  await webhook(env, 'e_cc', 'checkout.session.completed', session);
  assert.equal((await env.registry.getBySession(session.id)).status, 'revoked', 'a won dispute never revives a refund');
});

test('a malformed pre-issuance hold makes issuance quarantine the session (dead letter), never issue', async (t) => {
  const env = await boot(); t.after(env.close);
  const session = await env.stripe.createCheckoutSession({ successUrl: 'x' });
  const store = env.registry; // seed a corrupt hold through a dispute event, then corrupt it on disk
  await webhook(env, 'e_h', 'charge.dispute.created', { id: 'du_h', object: 'dispute', payment_intent: session.payment_intent, status: 'needs_response' });
  const document = await env.store.load(); document.holds[session.payment_intent].status = 'garbage'; await env.store.save(document);
  const res = await webhook(env, 'e_hc', 'checkout.session.completed', session);
  assert.deepEqual(await res.json(), { received: true, quarantined: true, reference: session.id });
  assert.equal(await store.getBySession(session.id), null);
  assert.match((await store.deadLetters())[0].reason, /malformed/);
  assert.equal((await fetch(`${env.base}/health`)).status, 503);
});

test('/buy in live mode refuses to create a Checkout Session with a loopback or missing public URL (no Stripe call is made)', async (t) => {
  let calls = 0;
  const stripe = { createCheckoutSession: async () => { calls += 1; return { url: 'https://checkout.stripe.com/pay/x' }; }, retrieveSession: async () => ({}) };
  for (const publicUrl of ['http://127.0.0.1:8787', 'https://localhost', 'https://[::1]', null]) {
    const env = await boot({ stripe, config: { mode: 'live', publicUrl } }); t.after(env.close);
    assert.equal((await fetch(`${env.base}/buy`, { redirect: 'manual' })).status, 503, String(publicUrl));
  }
  assert.equal(calls, 0);
  const live = await boot({ stripe, config: { mode: 'live', publicUrl: 'https://licensing.graft.example' } }); t.after(live.close);
  assert.equal((await fetch(`${live.base}/buy`, { redirect: 'manual' })).status, 303);
  assert.equal(calls, 1);
});

test('CONTRACT: the server URL rule (config.js url) and the desktop URL rule (resolveLicenseEndpoint) accept and reject the same inputs in both postures', () => {
  const samples = ['https://licensing.graft.example/', 'https://licensing.graft.example/v1/', 'HTTPS://LICENSING.GRAFT.EXAMPLE', 'https://127.0.0.1:8787', 'https://[::1]:8787',
    'http://127.0.0.1:8787', 'http://localhost:8787/', 'http://[::1]:8787', 'http://0.0.0.0:8787', 'http://127.0.0.2', 'http://licensing.graft.example',
    'javascript://localhost/alert(1)', 'javascript:alert(1)', 'data:text/html,x', 'ftp://localhost/x', 'file:///tmp/x', 'gopher://127.0.0.1/', 'ws://127.0.0.1',
    'https://u:p@licensing.graft.example', 'https://u@localhost', 'http://u:p@127.0.0.1', 'not a url', 'licensing.graft.example', 'https://', '://x', ' https://x.example', 'https://x.example\\evil'];
  for (const allowInsecureLoopback of [false, true]) {
    for (const sample of samples) {
      let server; try { server = { endpoint: serverUrl(sample, 'X', { allowInsecureLoopback }) }; } catch (err) { server = { error: err.message }; }
      const desktop = resolveLicenseEndpoint(sample, { allowInsecureLoopback });
      assert.equal(Boolean(server.error), Boolean(desktop.error), `verdict differs for ${JSON.stringify(sample)} (loopback ${allowInsecureLoopback}): server=${JSON.stringify(server)} desktop=${JSON.stringify(desktop)}`);
      if (!server.error) assert.equal(server.endpoint, desktop.endpoint, `endpoint differs for ${JSON.stringify(sample)}`);
    }
  }
});
