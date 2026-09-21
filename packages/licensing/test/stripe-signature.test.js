import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhookSignature, SignatureError, stripeClient } from '../src/stripe.js';

const secret = 'whsec_test_secret';
function sign(payload, { t = Math.floor(Date.now() / 1000), key = secret } = {}) {
  const signature = crypto.createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${signature}`;
}

test('a correctly signed webhook is accepted and parsed', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const event = verifyWebhookSignature(payload, sign(payload), secret, { now: () => Date.now() });
  assert.equal(event.id, 'evt_1');
});

test('a forged body with a real header is rejected', () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const header = sign(payload);
  const tampered = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', extra: 'injected' });
  assert.throws(() => verifyWebhookSignature(tampered, header, secret), SignatureError);
});

test('a signature made with the wrong secret is rejected', () => {
  const payload = JSON.stringify({ id: 'evt_2' });
  assert.throws(() => verifyWebhookSignature(payload, sign(payload, { key: 'whsec_wrong' }), secret), SignatureError);
});

test('a replayed (stale) timestamp outside tolerance is rejected even with a valid signature', () => {
  const payload = JSON.stringify({ id: 'evt_3' });
  const old = Math.floor(Date.now() / 1000) - 10000;
  assert.throws(() => verifyWebhookSignature(payload, sign(payload, { t: old }), secret, { toleranceSec: 300 }), SignatureError);
});

test('a missing or malformed signature header is rejected', () => {
  const payload = JSON.stringify({ id: 'evt_4' });
  assert.throws(() => verifyWebhookSignature(payload, '', secret), SignatureError);
  assert.throws(() => verifyWebhookSignature(payload, 'garbage', secret), SignatureError);
  assert.throws(() => verifyWebhookSignature(payload, `t=abc,v1=${'0'.repeat(64)}`, secret), SignatureError);
});

test('an absent webhook secret refuses rather than accepting anything', () => {
  assert.throws(() => verifyWebhookSignature('{}', 't=1,v1=x', null), SignatureError);
});

test('the checkout session request is one-time, single quantity, and never enables self-serve tax', async () => {
  let captured;
  const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl: async (url, options) => {
    captured = { url, body: options.body.toString(), headers: options.headers };
    return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }) };
  } });
  const session = await client.createCheckoutSession({ priceId: 'price_1', successUrl: 'https://x/success', cancelUrl: 'https://x/cancel', clientReferenceId: 'graft-1' });
  assert.equal(session.url, 'https://checkout.stripe.com/c/pay/cs_1');
  assert.match(captured.url, /\/v1\/checkout\/sessions$/);
  assert.match(captured.body, /mode=payment/);
  assert.match(captured.body, /line_items%5B0%5D%5Bprice%5D=price_1/);
  assert.match(captured.body, /line_items%5B0%5D%5Bquantity%5D=1/);
  // Merchant of Record is Stripe (Managed Payments): we must not enable self-serve Stripe Tax.
  assert.doesNotMatch(captured.body, /automatic_tax/);
  assert.equal(captured.headers.Authorization, 'Bearer sk_test_x');
});

test('the secret key is sent only as a Bearer header, never in the body', async () => {
  let captured;
  const client = stripeClient({ secretKey: 'sk_test_secret_value', fetchImpl: async (url, options) => {
    captured = { body: options.body?.toString() || '', auth: options.headers.Authorization };
    return { ok: true, json: async () => ({ id: 'cs', url: 'https://checkout.stripe.com/x' }) };
  } });
  await client.createCheckoutSession({ priceId: 'price_1', successUrl: 'https://x/s', cancelUrl: 'https://x/c', clientReferenceId: 'r' });
  assert.doesNotMatch(captured.body, /sk_test_secret_value/);
  assert.equal(captured.auth, 'Bearer sk_test_secret_value');
});
