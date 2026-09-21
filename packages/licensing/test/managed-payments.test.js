// Proofs that GRAFT's Stripe integration meets the authoritative Managed Payments
// blueprint: preview API version, Product + default_price_data, per-session Managed
// Payments enablement, no forbidden session parameters, and eligible software tax code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeClient, assertManagedPaymentsCompatible, MANAGED_PAYMENTS_UNSUPPORTED, STRIPE_API_VERSION, StripeError } from '../src/stripe.js';
import { MANAGED_PAYMENTS_SOFTWARE_TAX_CODES, DEFAULT_TAX_CODE, DEFAULT_PRICE_USD_CENTS, assertEligibleTaxCode, productParams, priceParams, LOOKUP_KEY } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { setupStripeCatalog } from '../src/catalog-setup.js';

function capturingClient() {
  const calls = [];
  const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body ? options.body.toString() : '', params: options.body ? new URLSearchParams(options.body.toString()) : null, headers: options.headers });
    return { ok: true, json: async () => ({ id: 'obj_1', url: 'https://checkout.stripe.com/c/pay/cs_1', default_price: 'price_default', data: [] }) };
  } });
  return { client, calls };
}
const checkout = (client) => client.createCheckoutSession({ priceId: 'price_1', successUrl: 'https://x/success', cancelUrl: 'https://x/cancel', clientReferenceId: 'graft-1' });

test('every Checkout Session requests managed_payments[enabled]=true', async () => {
  const { client, calls } = capturingClient();
  await checkout(client);
  assert.equal(calls[0].params.get('managed_payments[enabled]'), 'true');
  assert.equal(calls[0].params.get('mode'), 'payment');
  assert.equal(calls[0].params.get('line_items[0][quantity]'), '1');
  assert.equal(calls[0].params.get('line_items[0][price]'), 'price_1');
});

test('the authoritative preview Stripe API version is sent on Product and Checkout requests', async () => {
  const { client, calls } = capturingClient();
  await checkout(client);
  await client.createProduct(productParams({ taxCode: DEFAULT_TAX_CODE }));
  assert.equal(STRIPE_API_VERSION, '2026-02-25.preview');
  for (const call of calls) assert.equal(call.headers['Stripe-Version'], '2026-02-25.preview');
  assert.match(calls[0].url, /\/v1\/checkout\/sessions$/);
  assert.match(calls[1].url, /\/v1\/products$/);
});

test('automatic_tax is absent from Checkout Sessions because Managed Payments owns tax', async () => {
  const { client, calls } = capturingClient();
  await checkout(client);
  assert.equal(calls[0].params.has('automatic_tax[enabled]'), false);
  assert.doesNotMatch(calls[0].body, /automatic_tax/);
});

test('no parameter reserved by Managed Payments is sent', async () => {
  const { client, calls } = capturingClient();
  await checkout(client);
  const sent = [...calls[0].params.keys()];
  for (const forbidden of MANAGED_PAYMENTS_UNSUPPORTED) {
    const prefix = forbidden.replace('.', '[') + (forbidden.includes('.') ? ']' : '');
    assert.ok(!sent.some((k) => k === forbidden || k.startsWith(`${forbidden}[`) || k.startsWith(prefix)), `must not send ${forbidden}`);
  }
});

test('the guard refuses forbidden parameters or a Checkout without Managed Payments', () => {
  const base = { mode: 'payment', managed_payments: { enabled: true }, line_items: [{ price: 'p', quantity: 1 }], success_url: 'https://x' };
  assert.throws(() => assertManagedPaymentsCompatible({ ...base, automatic_tax: { enabled: true } }), StripeError);
  assert.throws(() => assertManagedPaymentsCompatible({ ...base, tax_id_collection: { enabled: true } }), StripeError);
  assert.throws(() => assertManagedPaymentsCompatible({ ...base, payment_intent_data: { receipt_email: 'a@b.co' } }), StripeError);
  assert.throws(() => assertManagedPaymentsCompatible({ ...base, shipping_address_collection: { allowed_countries: ['US'] } }), StripeError);
  assert.throws(() => assertManagedPaymentsCompatible({ ...base, managed_payments: { enabled: false } }), StripeError);
  assert.throws(() => assertManagedPaymentsCompatible({ ...base, managed_payments: undefined }), StripeError);
  assert.doesNotThrow(() => assertManagedPaymentsCompatible(base));
});

test('Product creation includes eligible tax code and $49 default_price_data in the same request', async () => {
  const { client, calls } = capturingClient();
  await client.createProduct(productParams({ taxCode: DEFAULT_TAX_CODE }));
  assert.match(calls[0].url, /\/v1\/products$/);
  assert.equal(calls[0].params.get('name'), 'GRAFT');
  assert.equal(calls[0].params.get('tax_code'), DEFAULT_TAX_CODE);
  assert.equal(calls[0].params.get('default_price_data[unit_amount]'), String(DEFAULT_PRICE_USD_CENTS));
  assert.equal(calls[0].params.get('default_price_data[currency]'), 'usd');
  assert.equal(calls[0].params.has('product'), false);
});

test('product setup refuses a missing or ineligible tax code', () => {
  assert.throws(() => productParams({}), /tax code is required/);
  assert.throws(() => productParams({ taxCode: null }), /tax code is required/);
  assert.throws(() => productParams({ taxCode: 'txcd_99999999' }), /tax code is required/);
  assert.throws(() => productParams({ taxCode: 'txcd_10103001' }), /tax code is required/);
});

test('product default price is $49 USD one-time and validates the amount', () => {
  const params = productParams({ taxCode: DEFAULT_TAX_CODE });
  assert.equal(params.default_price_data.currency, 'usd');
  assert.equal(params.default_price_data.unit_amount, 4900);
  assert.equal('recurring' in params.default_price_data, false);
  assert.throws(() => productParams({ taxCode: DEFAULT_TAX_CODE, unitAmount: 0 }), /positive integer/);
});

test('legacy priceParams remains compatible for already-created sandbox resources only', () => {
  const params = priceParams({ productId: 'prod_1' });
  assert.equal(params.currency, 'usd');
  assert.equal(params.unit_amount, 4900);
  assert.equal(params.lookup_key, LOOKUP_KEY);
  assert.equal('recurring' in params, false);
  assert.throws(() => priceParams({}), /product id/);
});

test('the default GRAFT tax code is Downloadable Software - business use and allowlisted', async () => {
  assert.equal(DEFAULT_TAX_CODE, 'txcd_10202003');
  assert.equal(MANAGED_PAYMENTS_SOFTWARE_TAX_CODES[DEFAULT_TAX_CODE], 'Downloadable Software - business use');
  assert.equal(loadConfig({}).taxCode, DEFAULT_TAX_CODE);
  assert.equal(loadConfig({ GRAFT_TAX_CODE: 'txcd_10202001' }).taxCode, 'txcd_10202001');
  for (const code of Object.keys(MANAGED_PAYMENTS_SOFTWARE_TAX_CODES)) assert.equal(assertEligibleTaxCode(code), code);
});

test('catalog reuse can retrieve both Price and linked Product without unsafe path interpolation', async () => {
  const { client, calls } = capturingClient();
  await client.retrievePrice('price_x/../y');
  await client.retrieveProduct('prod_x/../y');
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/prices/price_x%2F..%2Fy');
  assert.equal(calls[1].url, 'https://api.stripe.com/v1/products/prod_x%2F..%2Fy');
  assert.equal(calls[0].body, '');
  assert.equal(calls[1].body, '');
});

test('catalog setup rediscovers its marked Product on rerun and creates only once', async () => {
  const products = [];
  const prices = new Map();
  let creates = 0;
  const client = {
    findProductsByMetadata: async (key, value) => products.filter((product) => product.metadata?.[key] === value),
    findPriceByLookupKey: async () => null,
    createProduct: async (params) => {
      creates += 1;
      const product = { id: 'prod_graft', name: params.name, tax_code: params.tax_code, metadata: params.metadata, default_price: 'price_graft' };
      products.push(product);
      prices.set('price_graft', { id: 'price_graft', product: product.id, currency: 'usd', unit_amount: 4900, type: 'one_time', recurring: null });
      return product;
    },
    retrievePrice: async (id) => prices.get(id),
    retrieveProduct: async (id) => products.find((product) => product.id === id),
  };
  const first = await setupStripeCatalog({ client, taxCode: DEFAULT_TAX_CODE });
  const rerun = await setupStripeCatalog({ client, taxCode: DEFAULT_TAX_CODE });
  assert.equal(first.created, true);
  assert.equal(rerun.created, false);
  assert.equal(first.price.id, rerun.price.id);
  assert.equal(creates, 1);
});

test('catalog setup refuses ambiguous marked Products instead of choosing or creating', async () => {
  let creates = 0;
  const client = {
    findProductsByMetadata: async () => [
      { id: 'prod_a', metadata: { graft: 'desktop-onetime' }, default_price: 'price_a' },
      { id: 'prod_b', metadata: { graft: 'desktop-onetime' }, default_price: 'price_b' },
    ],
    createProduct: async () => { creates += 1; },
  };
  await assert.rejects(setupStripeCatalog({ client, taxCode: DEFAULT_TAX_CODE }), /refusing ambiguous setup/);
  assert.equal(creates, 0);
});

test('Product metadata rediscovery exhausts pagination and returns only exact markers', async () => {
  const calls = [];
  const pages = [
    { has_more: true, data: [{ id: 'prod_other', metadata: { graft: 'other' } }, { id: 'prod_graft_a', metadata: { graft: 'desktop-onetime' } }] },
    { has_more: false, data: [{ id: 'prod_graft_b', metadata: { graft: 'desktop-onetime' } }] },
  ];
  const client = stripeClient({ secretKey: 'sk_test_x', fetchImpl: async (url) => {
    calls.push(url);
    return { ok: true, json: async () => pages.shift() };
  } });
  const products = await client.findProductsByMetadata('graft', 'desktop-onetime');
  assert.deepEqual(products.map(({ id }) => id), ['prod_graft_a', 'prod_graft_b']);
  assert.match(calls[0], /\/v1\/products\?limit=100$/);
  assert.match(calls[1], /starting_after=prod_graft_a$/);
});
