// GRAFT's Stripe product catalog rules for Managed Payments.
//
// Managed Payments (Stripe as Merchant of Record) requires every Product sold to carry a
// tax code from Stripe's eligible-digital-goods list. GRAFT is prewritten, downloadable
// desktop software sold as a one-time perpetual license. The authoritative Managed
// Payments blueprint creates the Product and its one-time default Price in the same
// POST /v1/products request through default_price_data.

export const MANAGED_PAYMENTS_SOFTWARE_TAX_CODES = Object.freeze({
  txcd_10202000: 'Downloadable Software - personal use',
  txcd_10202001: 'Downloadable Software - non-recreational - personal use',
  txcd_10202003: 'Downloadable Software - business use',
  txcd_10000000: 'General - Electronically Supplied Services',
});

export const LOOKUP_KEY = 'graft_desktop_onetime_49';

// GRAFT's chosen tax code: Downloadable Software - business use (owner decision, 2026-09-10).
export const DEFAULT_TAX_CODE = 'txcd_10202003';
export const DEFAULT_PRICE_USD_CENTS = 4900;

export function assertEligibleTaxCode(taxCode) {
  if (typeof taxCode !== 'string' || !Object.hasOwn(MANAGED_PAYMENTS_SOFTWARE_TAX_CODES, taxCode)) {
    const choices = Object.entries(MANAGED_PAYMENTS_SOFTWARE_TAX_CODES).map(([code, name]) => `${code} (${name})`).join(', ');
    throw new Error(`A Managed Payments-eligible downloadable-software tax code is required. Set GRAFT_TAX_CODE to one of: ${choices}.`);
  }
  return taxCode;
}

function assertUnitAmount(unitAmount) {
  if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) throw new Error('unitAmount must be a positive integer in cents.');
  return unitAmount;
}

// Parameters for the authoritative POST /v1/products setup call. The Product carries the
// eligible tax code and Stripe creates the one-time default Price atomically from
// default_price_data, matching the Managed Payments blueprint.
export function productParams({ taxCode, unitAmount = DEFAULT_PRICE_USD_CENTS } = {}) {
  return {
    name: 'GRAFT',
    description: 'GRAFT desktop — private capability memory and verified software reuse. One-time license.',
    tax_code: assertEligibleTaxCode(taxCode),
    default_price_data: {
      unit_amount: assertUnitAmount(unitAmount),
      currency: 'usd',
    },
    metadata: { graft: 'desktop-onetime' },
  };
}

// Retained for compatibility with already-created GRAFT sandbox resources and older
// deployment tooling. New product setup must use productParams/default_price_data instead.
export function priceParams({ productId, unitAmount = DEFAULT_PRICE_USD_CENTS }) {
  if (!productId) throw new Error('A product id is required to create the price.');
  return {
    product: productId,
    currency: 'usd',
    unit_amount: assertUnitAmount(unitAmount),
    lookup_key: LOOKUP_KEY,
    metadata: { graft: 'desktop-onetime' },
  };
}
