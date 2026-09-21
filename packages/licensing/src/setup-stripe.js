#!/usr/bin/env node
// One-time helper for the GRAFT Managed Payments catalog.
//
// The authoritative Stripe blueprint creates the Product and its one-time default Price in
// the SAME POST /v1/products request via default_price_data. This helper follows that shape,
// then prints the returned default Price id for STRIPE_PRICE_ID.
//
//   STRIPE_SECRET_KEY=sk_test_... GRAFT_TAX_CODE=txcd_... node packages/licensing/src/setup-stripe.js
//
// Existing sandbox deployments can reuse STRIPE_PRICE_ID or the legacy lookup-key price.
// New catalog creation never performs a second POST /v1/prices call.

import { loadConfig } from './config.js';
import { stripeClient } from './stripe.js';
import { assertEligibleTaxCode } from './catalog.js';
import { setupStripeCatalog } from './catalog-setup.js';

const config = loadConfig();
if (!config.secretKey) { console.error('Set STRIPE_SECRET_KEY first.'); process.exit(1); }
let taxCode;
try { taxCode = assertEligibleTaxCode(config.taxCode); }
catch (err) { console.error(err.message); process.exit(1); }

const client = stripeClient({ secretKey: config.secretKey });
const mode = config.mode === 'live' ? 'LIVE' : 'test';

try {
  const result = await setupStripeCatalog({ client, priceId: config.priceId, taxCode });
  const action = result.created ? 'Created' : 'Reusing existing';
  console.log(`${action} ${mode} product ${result.product.id} with price ${result.price.id} ($49.00 one-time, tax handled by Managed Payments).`);
  console.log(`GRAFT_STRIPE_PRODUCT_ID=${result.product.id}`);
  console.log(`STRIPE_PRICE_ID=${result.price.id}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
