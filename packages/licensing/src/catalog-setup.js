import { DEFAULT_PRICE_USD_CENTS, LOOKUP_KEY, assertEligibleTaxCode, productParams } from './catalog.js';

const stripeIdOf = (object) => (typeof object === 'string' ? object : (typeof object?.id === 'string' ? object.id : null));

async function assertExistingCatalog(client, price, taxCode) {
  if (!price?.id || !price.product) throw new Error('Configured Stripe Price is incomplete.');
  const product = await client.retrieveProduct(stripeIdOf(price.product));
  if (product?.name !== 'GRAFT' || product?.metadata?.graft !== 'desktop-onetime') throw new Error(`Price ${price.id} is not attached to the marked GRAFT Product.`);
  if (product.active === false) throw new Error(`GRAFT Product ${product.id} is inactive; refusing to create a duplicate.`);
  assertEligibleTaxCode(product.tax_code);
  if (product.tax_code !== taxCode) throw new Error(`Existing GRAFT Product ${product.id} uses tax_code ${product.tax_code}, expected ${taxCode}.`);
  if (price.currency !== 'usd') throw new Error(`Existing GRAFT Price ${price.id} uses ${price.currency}, expected usd.`);
  if (price.unit_amount !== DEFAULT_PRICE_USD_CENTS) throw new Error(`Existing GRAFT Price ${price.id} is ${price.unit_amount} cents, expected ${DEFAULT_PRICE_USD_CENTS}.`);
  if (price.type !== 'one_time' || price.recurring) throw new Error(`Existing GRAFT Price ${price.id} is not a one-time price.`);
  return { product, price };
}

export async function setupStripeCatalog({ client, priceId = null, taxCode }) {
  assertEligibleTaxCode(taxCode);

  if (priceId) return { created: false, ...await assertExistingCatalog(client, await client.retrievePrice(priceId), taxCode) };

  // Product listing is used instead of eventually-consistent search so an immediate rerun
  // cannot miss the Product just created. Multiple markers are never resolved arbitrarily.
  const marked = await client.findProductsByMetadata('graft', 'desktop-onetime');
  if (marked.length > 1) throw new Error(`Found ${marked.length} GRAFT Products marked metadata.graft=desktop-onetime; refusing ambiguous setup. Configure STRIPE_PRICE_ID after manual resolution.`);
  if (marked.length === 1) {
    const product = marked[0];
    let existingPriceId = stripeIdOf(product.default_price);
    if (!existingPriceId) {
      const legacy = await client.findPriceByLookupKey(LOOKUP_KEY);
      if (legacy && stripeIdOf(legacy.product) === product.id) existingPriceId = legacy.id;
    }
    if (!existingPriceId) throw new Error(`Existing GRAFT Product ${product.id} has no reusable default Price; refusing to create a duplicate.`);
    return { created: false, ...await assertExistingCatalog(client, await client.retrievePrice(existingPriceId), taxCode) };
  }

  const legacy = await client.findPriceByLookupKey(LOOKUP_KEY);
  if (legacy) return { created: false, ...await assertExistingCatalog(client, legacy, taxCode) };

  const product = await client.createProduct(productParams({ taxCode }));
  const defaultPriceId = stripeIdOf(product.default_price);
  if (!product?.id || !defaultPriceId) throw new Error('Stripe created the GRAFT Product without returning a default Price id.');
  const verified = await assertExistingCatalog(client, await client.retrievePrice(defaultPriceId), taxCode);
  return { created: true, ...verified };
}
