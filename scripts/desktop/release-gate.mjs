// The public-build gate: what product.json must contain before GRAFT may be signed.
// Kept as a pure function so it is unit-tested; build.mjs calls it when GRAFT_SIGN=1.

export function secureLicenseApiBase(value) {
  if (typeof value !== 'string' || !value) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password;
}

export function assertPublicBuildConfig(config) {
  if (config.testBuild || config.provider !== 'graft-stripe-managed-payments' || !config.storeId || !config.productId || !Array.isArray(config.variantIds) || !config.variantIds.length || !config.licenseApiBase || !config.purchaseUrl || !config.downloadUrl) {
    throw new Error('A public build requires configured GRAFT licensing (identity, licenseApiBase) and purchase/download URLs.');
  }
  // License keys travel in request bodies: a signed build may only ever talk to HTTPS.
  if (!secureLicenseApiBase(config.licenseApiBase)) throw new Error('A public build requires licenseApiBase to be an HTTPS URL without credentials.');
  return config;
}
