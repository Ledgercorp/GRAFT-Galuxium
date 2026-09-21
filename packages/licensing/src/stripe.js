// A dependency-free Stripe client and webhook verifier.
//
// It speaks Stripe's REST API directly over fetch with the secret key as a Bearer
// token, and verifies webhook signatures with a hand-rolled HMAC so payment success
// is established from Stripe's own signed events — never trusted from a client.
//
// Merchant of Record: GRAFT sells through Stripe Managed Payments. The authoritative
// Managed Payments blueprint requires Checkout Sessions to set
// `managed_payments[enabled]=true` and pins the preview API version used by both Product
// creation and Checkout Session creation. Stripe owns tax, payment-method, shipping,
// Connect and post-sale controls for these sessions, so this client refuses those fields.

import crypto from 'node:crypto';

export class StripeError extends Error {}
export class SignatureError extends Error {}

const API_BASE = 'https://api.stripe.com';
export const STRIPE_API_VERSION = '2026-02-25.preview';

// Checkout Session parameters Stripe documents as unsupported for one-time-payment
// Managed Payments sessions. Any of these in a request is a bug, so we refuse.
export const MANAGED_PAYMENTS_UNSUPPORTED = Object.freeze([
  'automatic_tax',
  'tax_id_collection',
  'excluded_payment_method_types',
  'adaptive_pricing',
  'payment_method_configuration',
  'payment_method_types',
  'customer_update',
  'shipping_address_collection',
  'shipping_options',
  'invoice_creation',
  'payment_intent_data.shipping',
  'payment_intent_data.application_fee_amount',
  'payment_intent_data.on_behalf_of',
  'payment_intent_data.transfer_data',
  'payment_intent_data.transfer_group',
  'payment_intent_data.statement_descriptor',
  'payment_intent_data.statement_descriptor_suffix',
  'payment_intent_data.receipt_email',
]);

function hasPath(object, dotted) {
  return dotted.split('.').reduce((current, key) => (current && Object.hasOwn(current, key) ? current[key] : undefined), object) !== undefined;
}

export function assertManagedPaymentsCompatible(params) {
  const offending = MANAGED_PAYMENTS_UNSUPPORTED.filter((name) => hasPath(params, name));
  if (offending.length) throw new StripeError(`Parameters not supported by Managed Payments: ${offending.join(', ')}.`);
  if (params.managed_payments?.enabled !== true) throw new StripeError('Managed Payments must be enabled on every GRAFT Checkout Session.');
  return params;
}

// Flatten nested params into Stripe's bracket form, e.g. line_items[0][price].
function encode(params, prefix, out) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item, index) => encode({ [index]: item }, field, out));
    else if (typeof value === 'object') encode(value, field, out);
    else out.append(field, String(value));
  }
  return out;
}

export function stripeClient({ secretKey, fetchImpl = fetch, apiBase = API_BASE, timeoutMs = 15000 } = {}) {
  if (!secretKey) throw new StripeError('A Stripe secret key is required to reach the Stripe API.');
  async function request(method, path, params) {
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': STRIPE_API_VERSION,
        },
        body: params ? encode(params, '', new URLSearchParams()) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new StripeError('Could not reach Stripe.'); }
    let body;
    try { body = await response.json(); } catch { throw new StripeError('Stripe returned an unreadable response.'); }
    if (!response.ok) throw new StripeError(body?.error?.message || `Stripe request failed (${response.status}).`);
    return body;
  }
  return {
    request,
    // One product, one price, one-time payment, Stripe as Merchant of Record.
    createCheckoutSession({ priceId, successUrl, cancelUrl, clientReferenceId }) {
      const params = assertManagedPaymentsCompatible({
        mode: 'payment',
        managed_payments: { enabled: true },
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: clientReferenceId,
      });
      return request('POST', '/v1/checkout/sessions', params);
    },
    retrieveSession(id) {
      const query = new URLSearchParams({
        'expand[0]': 'payment_intent',
        'expand[1]': 'customer',
        'expand[2]': 'line_items.data.price.product',
      });
      return request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?${query}`);
    },
    createProduct(params) { return request('POST', '/v1/products', params); },
    retrieveProduct(id) { return request('GET', `/v1/products/${encodeURIComponent(id)}`); },
    createPrice(params) { return request('POST', '/v1/prices', params); },
    retrievePrice(id) { return request('GET', `/v1/prices/${encodeURIComponent(id)}`); },
    async findProductsByMetadata(key, value) {
      const matches = [];
      let startingAfter = null;
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (startingAfter) query.set('starting_after', startingAfter);
        const page = await request('GET', `/v1/products?${query}`);
        const products = Array.isArray(page.data) ? page.data : [];
        matches.push(...products.filter((product) => product?.metadata?.[key] === value));
        if (!page.has_more) break;
        startingAfter = products.at(-1)?.id;
        if (!startingAfter) throw new StripeError('Stripe returned an unreadable Product list.');
      } while (true);
      return matches;
    },
    findPriceByLookupKey(lookupKey) {
      const query = new URLSearchParams({ 'lookup_keys[0]': lookupKey, active: 'true', limit: '1' });
      return request('GET', `/v1/prices?${query}`).then((page) => page.data?.[0] || null);
    },
  };
}

// Verify a Stripe webhook signature and return the parsed event. Throws SignatureError
// on any mismatch or a stale timestamp, so a forged or replayed body is refused.
export function verifyWebhookSignature(rawBody, signatureHeader, secret, { toleranceSec = 300, now = Date.now } = {}) {
  if (!secret) throw new SignatureError('No webhook signing secret is configured.');
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') throw new SignatureError('Webhook body must be the raw request bytes.');
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) throw new SignatureError('Missing Stripe-Signature header.');

  const parts = {};
  for (const segment of signatureHeader.split(',')) {
    const index = segment.indexOf('=');
    if (index === -1) continue;
    const name = segment.slice(0, index);
    const value = segment.slice(index + 1);
    if (name === 'v1') (parts.v1 ||= []).push(value);
    else parts[name] = value;
  }
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) throw new SignatureError('Malformed Stripe signature timestamp.');
  if (!parts.v1 || parts.v1.length === 0) throw new SignatureError('No v1 signature scheme in the Stripe-Signature header.');

  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const matched = parts.v1.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, 'utf8');
    return candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf);
  });
  if (!matched) throw new SignatureError('Stripe signature verification failed.');
  if (Math.abs(now() / 1000 - timestamp) > toleranceSec) throw new SignatureError('Stripe signature timestamp is outside the tolerance window.');

  try { return JSON.parse(payload); }
  catch { throw new SignatureError('Webhook body is not valid JSON.'); }
}
