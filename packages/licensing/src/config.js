// Configuration for the GRAFT licensing backend.
//
// Secrets are read only from the environment. Nothing here is committed, and none
// of these values ever reach the desktop client — the desktop knows only the public
// base URL of this service. The service fails closed: if a required secret is absent
// for an operation, that operation refuses rather than guessing.

import { DEFAULT_PRICE_USD_CENTS, DEFAULT_TAX_CODE } from './catalog.js';

function intOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received "${value}".`);
  return parsed;
}

// Same posture as the desktop's resolveLicenseEndpoint: HTTPS, or plain HTTP to loopback
// only outside live mode. Every other scheme (javascript:, data:, ftp:, file:, ...) and any
// credentialed URL is refused, so a misconfigured value can never reach a rendered href.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function isLoopback(value) { try { return LOOPBACK.has(new URL(String(value)).hostname); } catch { return false; } }
export function url(value, field, { allowInsecureLoopback = false } = {}) {
  if (!value) return null;
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error(`${field} must be an absolute URL.`); }
  if (parsed.username || parsed.password) throw new Error(`${field} must not carry credentials.`);
  const secure = parsed.protocol === 'https:';
  const loopback = parsed.protocol === 'http:' && allowInsecureLoopback === true && LOOPBACK.has(parsed.hostname);
  if (!secure && !loopback) throw new Error(`${field} must use HTTPS (plain-HTTP loopback is allowed only outside live mode).`);
  return parsed.toString().replace(/\/$/, '');
}

// A Payment Link must be a Stripe-hosted HTTPS page; anything else would send buyers off Stripe.
function paymentLink(value) {
  const normalized = url(value, 'STRIPE_PAYMENT_LINK_URL');
  if (normalized && new URL(normalized).hostname !== 'buy.stripe.com') throw new Error('STRIPE_PAYMENT_LINK_URL must be a buy.stripe.com Payment Link.');
  return normalized;
}

function capTolerance(seconds) {
  // A wide replay window weakens webhook security; hold it to at most 10 minutes.
  if (seconds > 600) throw new Error('STRIPE_SIGNATURE_TOLERANCE_SEC must be 600 seconds or less.');
  return seconds;
}

export function loadConfig(env = process.env) {
  const secretKey = env.STRIPE_SECRET_KEY || null;
  const mode = secretKey ? (secretKey.startsWith('sk_live_') ? 'live' : 'test') : 'unconfigured';
  const allowInsecureLoopback = mode !== 'live';
  // Live mode never defaults: Checkout return URLs are customer-facing, so a loopback
  // publicUrl would strand every buyer after payment. Refused whether defaulted or explicit.
  const publicUrl = url(env.GRAFT_PUBLIC_URL, 'GRAFT_PUBLIC_URL', { allowInsecureLoopback }) || (allowInsecureLoopback ? 'http://127.0.0.1:8787' : null);
  if (mode === 'live' && publicUrl && isLoopback(publicUrl)) throw new Error('GRAFT_PUBLIC_URL must not be a loopback address in live mode.');
  return {
    // Stripe is the Merchant of Record via Managed Payments. This service never
    // computes, collects, or remits tax; Stripe does that at the account level.
    merchantOfRecord: 'stripe-managed-payments',
    managedPayments: true,
    mode,
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    priceId: env.STRIPE_PRICE_ID || null,
    // Optional Stripe Payment Link: when set, /buy redirects buyers to it and Stripe creates the
    // Checkout Session. Verification is unchanged (the session is still re-fetched and checked
    // against the configured price), so the secret key only needs read access.
    paymentLinkUrl: paymentLink(env.STRIPE_PAYMENT_LINK_URL),
    // Product identity triple the desktop license service checks. These are GRAFT's
    // own identifiers, not Stripe object ids; they must match packages/desktop/config/product.json.
    product: {
      storeId: intOr(env.GRAFT_STORE_ID, 1),
      productId: intOr(env.GRAFT_PRODUCT_ID, 1),
      variantId: intOr(env.GRAFT_VARIANT_ID, 1),
    },
    // Commercial authority: GRAFT's launch price is fixed, not runtime-configurable.
    priceUsd: DEFAULT_PRICE_USD_CENTS,
    maxActivations: intOr(env.GRAFT_MAX_ACTIVATIONS, 3),
    publicUrl,
    downloadUrl: url(env.GRAFT_DOWNLOAD_URL, 'GRAFT_DOWNLOAD_URL', { allowInsecureLoopback }),
    port: intOr(env.PORT, 8787),
    storePath: env.GRAFT_LICENSE_STORE || null,
    // Managed Payments requires an eligible tax code on the Product; validated by catalog.js at setup.
    taxCode: env.GRAFT_TAX_CODE || DEFAULT_TAX_CODE,
    signatureToleranceSec: capTolerance(intOr(env.STRIPE_SIGNATURE_TOLERANCE_SEC, 300)),
    // Transactional key email (secondary delivery; see mail.js). The API key is a secret and stays in the environment.
    mail: { apiKey: env.RESEND_API_KEY || null, from: env.GRAFT_MAIL_FROM || null, supportEmail: env.GRAFT_SUPPORT_EMAIL || null },
    // Private Beta Program: the dedicated server-to-server credential the website's approval action
    // presents to issue a licence. Unset means the internal route refuses (503). Never a Stripe or Resend key.
    betaApprovalToken: env.GRAFT_BETA_APPROVAL_TOKEN || null,
  };
}

// Assert the secrets required to actually transact are present. Called by the CLI at
// startup so a misconfigured deployment refuses to run rather than half-working.
export function requireStripe(config) {
  const missing = [];
  if (!config.secretKey) missing.push('STRIPE_SECRET_KEY');
  if (!config.priceId) missing.push('STRIPE_PRICE_ID');
  if (!config.publicUrl) missing.push('GRAFT_PUBLIC_URL');
  if (!config.webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');
  if (!config.downloadUrl) missing.push('GRAFT_DOWNLOAD_URL');
  if (missing.length) throw new Error(`GRAFT licensing is not configured. Set: ${missing.join(', ')}.`);
  return config;
}
