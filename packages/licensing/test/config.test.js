import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, requireStripe } from '../src/config.js';

const base = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_x', GRAFT_DOWNLOAD_URL: 'https://d.example/GRAFT.dmg' };

test('a live secret key selects live mode; a test key selects test mode', () => {
  assert.equal(loadConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }).mode, 'test');
  assert.equal(loadConfig({ STRIPE_SECRET_KEY: 'sk_live_x' }).mode, 'live');
  assert.equal(loadConfig({}).mode, 'unconfigured');
});

test('the $49 launch price is fixed and cannot be overridden by the environment', () => {
  assert.equal(loadConfig({}).priceUsd, 4900);
  assert.equal(loadConfig({ GRAFT_PRICE_USD_CENTS: '100' }).priceUsd, 4900);
});

test('the webhook signature tolerance is bounded to at most 600 seconds', () => {
  assert.equal(loadConfig({ ...base, STRIPE_SIGNATURE_TOLERANCE_SEC: '300' }).signatureToleranceSec, 300);
  assert.equal(loadConfig({ ...base, STRIPE_SIGNATURE_TOLERANCE_SEC: '600' }).signatureToleranceSec, 600);
  assert.throws(() => loadConfig({ ...base, STRIPE_SIGNATURE_TOLERANCE_SEC: '86400' }), /600 seconds or less/);
});

test('the service refuses to run when transacting secrets are missing', () => {
  assert.throws(() => requireStripe(loadConfig({})), /STRIPE_SECRET_KEY/);
  assert.doesNotThrow(() => requireStripe(loadConfig(base)));
});

test('download/public URL scheme: HTTPS accepted; plain-HTTP loopback only outside live mode; every other scheme, malformed or credentialed URL refused', () => {
  assert.equal(loadConfig({ ...base, GRAFT_DOWNLOAD_URL: 'https://d.example/GRAFT.dmg' }).downloadUrl, 'https://d.example/GRAFT.dmg');
  // Test mode: loopback HTTP is a development convenience.
  assert.equal(loadConfig({ ...base, GRAFT_PUBLIC_URL: 'http://127.0.0.1:8787' }).publicUrl, 'http://127.0.0.1:8787');
  assert.equal(loadConfig({ ...base, GRAFT_DOWNLOAD_URL: 'http://localhost:8787/GRAFT.dmg' }).downloadUrl, 'http://localhost:8787/GRAFT.dmg');
  assert.equal(loadConfig({ ...base, GRAFT_PUBLIC_URL: 'http://[::1]:8787' }).publicUrl, 'http://[::1]:8787');
  assert.throws(() => loadConfig({ ...base, STRIPE_SECRET_KEY: 'sk_live_x', GRAFT_PUBLIC_URL: 'http://[::1]:8787' }), /HTTPS/);
  // Live mode: no loopback exception at all.
  const live = { ...base, STRIPE_SECRET_KEY: 'sk_live_x' };
  assert.throws(() => loadConfig({ ...live, GRAFT_DOWNLOAD_URL: 'http://127.0.0.1:8787/GRAFT.dmg' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...live, GRAFT_PUBLIC_URL: 'http://localhost:8787' }), /HTTPS/);
  assert.doesNotThrow(() => loadConfig({ ...live, GRAFT_PUBLIC_URL: 'https://licensing.graft.example' }));
  // Dangerous or wrong schemes are refused in every mode, loopback host or not.
  for (const bad of ['javascript://localhost/alert(1)', 'javascript:alert(1)', 'ftp://localhost/x', 'file:///tmp/GRAFT.dmg', 'data://localhost/x', 'data:text/html,hi', 'gopher://127.0.0.1/x', 'http://evil.example/x']) {
    assert.throws(() => loadConfig({ ...base, GRAFT_DOWNLOAD_URL: bad }), /HTTPS/, bad);
    assert.throws(() => loadConfig({ ...base, GRAFT_PUBLIC_URL: bad }), /HTTPS/, bad);
  }
  for (const malformed of ['not a url', 'd.example/GRAFT.dmg', 'https://', '://x']) assert.throws(() => loadConfig({ ...base, GRAFT_DOWNLOAD_URL: malformed }), /absolute URL|HTTPS/, malformed);
  assert.throws(() => loadConfig({ ...base, GRAFT_DOWNLOAD_URL: 'https://u:p@d.example/GRAFT.dmg' }), /credentials/);
});

test('live mode never defaults GRAFT_PUBLIC_URL to loopback: it must be explicit, HTTPS, and non-loopback, and requireStripe fails closed without it', () => {
  const live = { ...base, STRIPE_SECRET_KEY: 'sk_live_x' };
  // Test mode keeps the development default.
  assert.equal(loadConfig(base).publicUrl, 'http://127.0.0.1:8787');
  // Live mode: unset -> null -> refused at startup.
  assert.equal(loadConfig(live).publicUrl, null);
  assert.throws(() => requireStripe(loadConfig(live)), /GRAFT_PUBLIC_URL/);
  // Live mode: loopback is refused even over HTTPS, and plain HTTP anywhere is refused.
  for (const bad of ['https://127.0.0.1:8787', 'https://localhost', 'https://[::1]:8787', 'http://127.0.0.1:8787', 'http://licensing.graft.example']) {
    assert.throws(() => loadConfig({ ...live, GRAFT_PUBLIC_URL: bad }), /HTTPS|loopback/, bad);
  }
  // Live mode: a real HTTPS origin starts.
  const ok = loadConfig({ ...live, GRAFT_PUBLIC_URL: 'https://licensing.graft.example/' });
  assert.equal(ok.publicUrl, 'https://licensing.graft.example');
  assert.doesNotThrow(() => requireStripe(ok));
});

test('STRIPE_PAYMENT_LINK_URL is optional, must be HTTPS on buy.stripe.com, and does not change what is required', () => {
  assert.equal(loadConfig(base).paymentLinkUrl, null);
  assert.equal(loadConfig({ ...base, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test_abc/' }).paymentLinkUrl, 'https://buy.stripe.com/test_abc');
  assert.throws(() => loadConfig({ ...base, STRIPE_PAYMENT_LINK_URL: 'https://example.com/pay' }), /buy\.stripe\.com/);
  assert.throws(() => loadConfig({ ...base, STRIPE_PAYMENT_LINK_URL: 'http://buy.stripe.com/test_abc' }), /HTTPS/);
  assert.throws(() => requireStripe(loadConfig({ ...base, STRIPE_SECRET_KEY: undefined, STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test_abc' })), /STRIPE_SECRET_KEY/);
});
