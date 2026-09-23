import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLicenseService } from '../src/license-service.js';
import { graftLicenseProvider, LicenseUnavailable, LicenseRejected, resolveLicenseEndpoint } from '../src/license-provider.js';
import { assertPublicBuildConfig, secureLicenseApiBase } from '../../../scripts/desktop/release-gate.mjs';
const config = { storeId: 1, productId: 2, variantIds: [3], offlineDays: 30 };
const key = 'test-license-key';
const valid = (flag, changes = {}) => ({ [flag]: true, error: null, license_key: { key, status: 'active', expires_at: null }, instance: { id: 'instance' }, meta: { store_id: 1, product_id: 2, variant_id: 3 }, ...changes });
function setup() {
  let record = null, installation = null, time = 1000000000000;
  const provider = { activate: async () => valid('activated'), validate: async () => valid('valid'), deactivate: async () => ({ deactivated: true, error: null }) };
  const store = { read: async () => record, write: async (v) => { record = structuredClone(v); }, clear: async () => { record = null; },
    readInstallation: async () => installation, writeInstallation: async (id) => { installation = id; } };
  const service = () => createLicenseService({ provider, store, config, now: () => time });
  return { provider, service, store, record: () => record, installation: () => installation, resetInstallation: () => { installation = null; }, advance: (ms) => { time += ms; } };
}
test('activation persists matching instance, validates it, and deactivates', async () => {
  const f = setup(), s = f.service();
  assert.equal(s.canUse(), false); assert.equal((await s.activate(key)).allowed, true);
  assert.equal(f.record().instanceId, 'instance');
  f.provider.validate = async (sentKey, instance) => { assert.equal(sentKey, key); assert.equal(instance, 'instance'); return valid('valid'); };
  const restarted = f.service(); assert.equal((await restarted.initialize()).allowed, true);
  assert.equal((await restarted.deactivate()).allowed, false); assert.equal(f.record(), null);
});
for (const [name, changes] of [
  ['wrong store', { meta: { store_id: 9, product_id: 2, variant_id: 3 } }],
  ['wrong product', { meta: { store_id: 1, product_id: 9, variant_id: 3 } }],
  ['wrong variant', { meta: { store_id: 1, product_id: 2, variant_id: 9 } }],
  ['invalid', { valid: false }], ['disabled', { license_key: { key, status: 'disabled', expires_at: null } }],
  ['expired', { license_key: { key, status: 'expired', expires_at: '2000-01-01T00:00:00Z' } }],
  ['past expiration even when active', { license_key: { key, status: 'active', expires_at: '2000-01-01T00:00:00Z' } }],
  ['missing expiration', { license_key: { key, status: 'active' } }],
  ['wrong key echo', { license_key: { key: 'another', status: 'active', expires_at: null } }],
]) test(`rejects ${name} before activation`, async () => {
  const f = setup(); let activated = false;
  f.provider.validate = async () => valid('valid', changes); f.provider.activate = async () => { activated = true; return valid('activated'); };
  const s = f.service(); await assert.rejects(s.activate(key)); assert.equal(activated, false); assert.equal(s.canUse(), false); assert.equal(f.record(), null);
});
test('network failure cannot activate; cached license survives outage only for bounded grace', async () => {
  const f = setup(), s = f.service(), online = f.provider.validate;
  f.provider.validate = async () => { throw new LicenseUnavailable(); };
  await assert.rejects(s.activate(key)); assert.equal(s.canUse(), false);
  f.provider.validate = online; await s.activate(key);
  f.provider.validate = async () => { throw new LicenseUnavailable(); };
  f.advance(29 * 86400000); const restarted = f.service(); assert.equal((await restarted.initialize()).allowed, true);
  f.advance(2 * 86400000); assert.equal((await restarted.validate()).allowed, false);
});
test('explicit invalidation removes cached access; a later outage cannot restore it', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.provider.validate = async () => valid('valid', { valid: false }); assert.equal((await s.validate()).allowed, false);
  f.provider.validate = async () => { throw new LicenseUnavailable(); }; assert.equal((await f.service().initialize()).allowed, false);
});
test('failed deletion persists a revocation tombstone and cannot revive offline', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.store.clear = async () => { throw new Error('delete unavailable'); };
  f.provider.validate = async () => valid('valid', { valid: false });
  assert.equal((await s.validate()).allowed, false);
  assert.equal(f.record().revoked, true);
  assert.equal(f.record().key, undefined);
  f.provider.validate = async () => { throw new LicenseUnavailable(); };
  const restarted = f.service();
  assert.equal((await restarted.initialize()).allowed, false);
  assert.equal(restarted.status().activated, false);
});
test('complete revocation storage failure is denied in-session and reported explicitly', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.store.clear = f.store.write = async () => { throw new Error('read only'); };
  f.provider.validate = async () => valid('valid', { valid: false });
  const status = await s.validate();
  assert.equal(status.allowed, false);
  assert.match(status.message, /Revocation could not be saved/);
});
test('wrong instance and clock rollback cannot reuse a cache', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.advance(-86400000); assert.equal(s.canUse(), false);
  f.provider.validate = async () => valid('valid', { instance: { id: 'other' } });
  assert.equal((await s.validate()).allowed, false); assert.equal(f.record(), null);
});
test('deactivation network failure retains activation for retry', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.provider.deactivate = async () => { throw new LicenseUnavailable(); };
  await assert.rejects(s.deactivate()); assert.equal(s.canUse(), true); assert.ok(f.record());
});
test('serializes validation and deactivation so late validation cannot restore access', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  const validation = s.validate(), deactivation = s.deactivate(); await Promise.all([validation, deactivation]);
  assert.equal(s.canUse(), false); assert.equal(f.record(), null);
});
test('missing product configuration fails closed', async () => {
  const f = setup(); const s = createLicenseService({ provider: f.provider, store: f.store, config: { variantIds: [] } });
  await assert.rejects(s.activate(key)); assert.equal(s.canUse(), false);
});
test('desktop provider posts JSON to the GRAFT backend, sends the instance id, carries no secret, and refuses redirects', async () => {
  const calls = [];
  const provider = graftLicenseProvider({ baseUrl: 'https://licensing.graft.example', fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify(valid('valid')) }; } });
  await provider.validate(key, 'instance'); const { url, options } = calls[0];
  assert.equal(url, 'https://licensing.graft.example/licenses/validate'); assert.equal(options.redirect, 'error');
  assert.equal(JSON.parse(options.body).instance_id, 'instance'); assert.equal(options.headers.Authorization, undefined);
  // No Stripe secret or bearer token ever leaves the desktop.
  assert.doesNotMatch(options.body, /sk_(test|live)_/);
});

test('timezone-less provider expiry is interpreted as UTC', async () => {
  const f = setup(), s = f.service();
  const until = '2001-09-09 01:46:41'; // exactly one second after the fixture clock
  f.provider.validate = async () => valid('valid', { license_key: { key, status: 'active', expires_at: until } });
  f.provider.activate = async () => valid('activated', { license_key: { key, status: 'active', expires_at: until } });
  await s.activate(key); assert.equal(s.canUse(), true); f.advance(1001); assert.equal(s.canUse(), false);
});
test('offline storage failure denies access without an unhandled validation rejection', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.provider.validate = async () => { throw new LicenseUnavailable(); }; f.store.write = async () => { throw new Error('read only'); };
  assert.equal((await s.validate()).allowed, false);
});
test('invalid activation success response cannot be cached', async () => {
  const f = setup(), s = f.service(); f.provider.activate = async () => valid('activated', { instance: null });
  await assert.rejects(s.activate(key)); assert.equal(f.record(), null); assert.equal(s.canUse(), false);
});

test('installation identity: minted once, random, persisted before activation, reused across restart and deactivation', async () => {
  const f = setup(); const sent = [];
  f.provider.activate = async (_key, installation) => { sent.push(installation); return valid('activated'); };
  assert.equal(f.installation(), null);
  const s = f.service(); await s.activate(key);
  const id = f.installation();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a UUID, not a device fingerprint');
  assert.deepEqual(sent[0], { installationId: id, name: 'GRAFT desktop' });
  // Deactivation clears the activation record but keeps the identity.
  await s.deactivate(); assert.equal(f.record(), null); assert.equal(f.installation(), id);
  // A restarted app re-activating sends the SAME id, so the backend reuses the seat.
  await f.service().activate(key); assert.equal(sent[1].installationId, id);
  // Server-side revocation (seen by a restarted app) also keeps the identity.
  f.provider.validate = async () => valid('valid', { valid: false });
  const restarted = f.service(); assert.equal((await restarted.initialize()).allowed, false);
  assert.equal(f.record(), null); assert.equal(f.installation(), id);
});

test('installation identity: a reinstall (wiped identity) or a corrupt identity mints a new id, which the backend treats as a new installation', async () => {
  const f = setup(); const sent = [];
  f.provider.activate = async (_key, installation) => { sent.push(installation.installationId); return valid('activated'); };
  await f.service().activate(key); const first = f.installation();
  await f.service().deactivate();
  f.resetInstallation(); // the application data directory was removed
  await f.service().activate(key);
  assert.notEqual(sent[1], first); assert.equal(f.installation(), sent[1]);
  await f.service().deactivate();
  await f.store.writeInstallation('bad id!'); // corrupt / tampered
  await f.service().activate(key);
  assert.notEqual(sent[2], 'bad id!'); assert.match(f.installation(), /^[0-9a-f-]{36}$/);
});

test('installation identity that cannot be persisted blocks activation before any seat is consumed', async () => {
  const f = setup(); let activated = false;
  f.provider.activate = async () => { activated = true; return valid('activated'); };
  f.store.writeInstallation = async () => { throw new Error('keychain locked'); };
  await assert.rejects(f.service().activate(key), LicenseRejected);
  assert.equal(activated, false); assert.equal(f.record(), null);
});

test('an UNREADABLE identity store (e.g. locked Keychain) blocks activation and never mints a replacement id', async () => {
  const f = setup(); let activated = false;
  f.provider.activate = async () => { activated = true; return valid('activated'); };
  f.store.readInstallation = async () => { throw new Error('keychain locked'); };
  await assert.rejects(f.service().activate(key), LicenseRejected);
  assert.equal(activated, false); assert.equal(f.installation(), null); assert.equal(f.record(), null);
});

test('license API endpoint: HTTPS required; loopback HTTP only by explicit opt-in; malformed and credentialed URLs fail closed', () => {
  assert.deepEqual(resolveLicenseEndpoint('https://licensing.graft.example/'), { endpoint: 'https://licensing.graft.example' });
  for (const insecure of ['http://licensing.graft.example', 'http://127.0.0.1:8787', 'http://localhost', 'ftp://licensing.graft.example', 'file:///tmp/x']) {
    assert.match(resolveLicenseEndpoint(insecure).error, /HTTPS/, insecure);
  }
  for (const malformed of ['licensing.graft.example', 'htps://x', '://', 'https://']) assert.ok(resolveLicenseEndpoint(malformed).error, malformed);
  assert.match(resolveLicenseEndpoint('https://user:pw@licensing.graft.example').error, /credentials/);
  assert.match(resolveLicenseEndpoint(null).error, /not configured/);
  // Opt-in is only honoured for loopback, and only for the literal boolean true.
  assert.deepEqual(resolveLicenseEndpoint('http://127.0.0.1:8787', { allowInsecureLoopback: true }), { endpoint: 'http://127.0.0.1:8787' });
  assert.deepEqual(resolveLicenseEndpoint('http://localhost:8787/', { allowInsecureLoopback: true }), { endpoint: 'http://localhost:8787' });
  assert.deepEqual(resolveLicenseEndpoint('http://[::1]:8787', { allowInsecureLoopback: true }), { endpoint: 'http://[::1]:8787' });
  assert.match(resolveLicenseEndpoint('http://[::1]:8787').error, /HTTPS/);
  assert.match(resolveLicenseEndpoint('http://licensing.graft.example', { allowInsecureLoopback: true }).error, /HTTPS/);
  assert.match(resolveLicenseEndpoint('http://127.0.0.1', { allowInsecureLoopback: 'yes' }).error, /HTTPS/);
});

test('the provider never sends a request to an insecure endpoint: it rejects (fail closed, no offline grace) without calling fetch', async () => {
  let fetched = 0;
  for (const baseUrl of ['http://licensing.graft.example', 'http://127.0.0.1:8787', 'not a url', 'https://u:p@x.example']) {
    const provider = graftLicenseProvider({ baseUrl, fetchImpl: async () => { fetched += 1; return { ok: true, status: 200, text: async () => JSON.stringify(valid('valid')) }; } });
    await assert.rejects(provider.validate(key, 'instance'), LicenseRejected, baseUrl);
    await assert.rejects(provider.activate(key, { installationId: 'x'.repeat(16), name: 'n' }), LicenseRejected, baseUrl);
  }
  assert.equal(fetched, 0);
});

test('the provider sends the installation id as the seat identity', async () => {
  const calls = [];
  const provider = graftLicenseProvider({ baseUrl: 'https://licensing.graft.example', fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, text: async () => JSON.stringify(valid('activated')) }; } });
  await provider.activate(key, { installationId: 'abcdefgh-1234', name: 'GRAFT desktop' });
  assert.equal(calls[0].url, 'https://licensing.graft.example/licenses/activate');
  assert.deepEqual(JSON.parse(calls[0].options.body), { license_key: key, installation_id: 'abcdefgh-1234', instance_name: 'GRAFT desktop' });
});

test('the signing gate refuses a non-HTTPS, malformed, or credentialed licenseApiBase and cannot be bypassed by configuration', () => {
  const good = { provider: 'graft-stripe-managed-payments', storeId: 1, productId: 1, variantIds: [1], licenseApiBase: 'https://licensing.graft.example', purchaseUrl: 'https://graft.example/buy', downloadUrl: 'https://graft.example/GRAFT.dmg', testBuild: false };
  assert.equal(assertPublicBuildConfig(good), good);
  for (const base of ['http://licensing.graft.example', 'http://127.0.0.1:8787', 'http://localhost:8787', 'licensing.graft.example', 'https://u:p@licensing.graft.example', 'ftp://x', '', null]) {
    assert.throws(() => assertPublicBuildConfig({ ...good, licenseApiBase: base }), /HTTPS|licenseApiBase/, String(base));
    assert.equal(secureLicenseApiBase(base), false);
  }
  // A test build (the only context where loopback HTTP is tolerated at runtime) is never signable.
  assert.throws(() => assertPublicBuildConfig({ ...good, testBuild: true }));
  assert.throws(() => assertPublicBuildConfig({ ...good, provider: 'deterministic-fixture' }));
});

// The private-beta profile is intentionally withheld from the public repository (see README, Public repository scope).
const privateBetaProfile = new URL('../config/product.private-beta.json', import.meta.url);
test('the private-beta product configuration: invite-only, purchasing disabled, HTTPS TEST service; otherwise a complete public-build profile', { skip: !fs.existsSync(privateBetaProfile) && 'private-beta configuration is not published' }, () => {
  const profile = JSON.parse(fs.readFileSync(new URL('../config/product.private-beta.json', import.meta.url), 'utf8'));
  assert.equal(profile.purchaseUrl, null, 'private beta testers are not asked to pay');
  assert.equal(profile.inviteOnly, true);
  assert.equal(profile.supportEmail, 'support@leftsocklabs.com');
  assert.equal(profile.licenseApiBase, 'https://graft-licensing-test.fly.dev');
  assert.match(profile.downloadUrl, /^https:\/\/graft-beta-downloads\.fly\.storage\.tigris\.dev\/GRAFT-0\.5\.0-private-beta-\d+-arm64\.dmg$/);
  // Everything but the purchase URL satisfies the public-build gate: turning purchasing on later is one field.
  const withPurchase = { ...profile, purchaseUrl: 'https://graft-licensing-test.fly.dev/buy' };
  assert.equal(assertPublicBuildConfig(withPurchase), withPurchase);
  assert.throws(() => assertPublicBuildConfig(profile), /purchase/, 'the gate itself still demands a purchase URL for a public build');
  assert.equal(profile.testBuild, false);
  // The shipped default stays unset so an unnamed build fails closed.
  const shipped = JSON.parse(fs.readFileSync(new URL('../config/product.json', import.meta.url), 'utf8'));
  assert.equal(shipped.purchaseUrl, null); assert.equal(shipped.licenseApiBase, null);
});

// ---- Network error classification (transient failures must never wipe a cached activation) ----
const body = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
const abortError = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('provider classification: connection failure, and a timeout/reset while READING the body, are LicenseUnavailable; a complete non-JSON body or a 4xx is LicenseRejected', async () => {
  const at = (fetchImpl) => graftLicenseProvider({ baseUrl: 'https://licensing.graft.example', fetchImpl });
  await assert.rejects(at(async () => { throw new TypeError('fetch failed'); }).validate(key, 'i'), LicenseUnavailable);
  await assert.rejects(at(async () => ({ ok: true, status: 200, text: async () => { throw abortError(); } })).validate(key, 'i'), LicenseUnavailable, 'timeout mid-body');
  await assert.rejects(at(async () => ({ ok: true, status: 200, text: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }); } })).validate(key, 'i'), LicenseUnavailable, 'socket reset mid-body');
  await assert.rejects(at(async () => ({ ok: true, status: 503, text: async () => '' })).validate(key, 'i'), LicenseUnavailable, '5xx');
  await assert.rejects(at(async () => ({ ok: true, status: 200, text: async () => '<html>not json' })).validate(key, 'i'), LicenseRejected, 'complete but malformed');
  await assert.rejects(at(async () => ({ ok: false, status: 404, text: async () => '{"error":"Unknown license key."}' })).validate(key, 'i'), LicenseRejected, 'genuine rejection');
  assert.deepEqual(await at(async () => body(valid('valid'))).validate(key, 'i'), valid('valid'));
});

test('background revalidation: a mid-body network failure keeps the cached activation and bounded offline grace; a genuine rejection still revokes', async () => {
  let record = null, installation = null, time = Date.parse('2026-01-01T00:00:00Z');
  const store = { read: async () => record, write: async (v) => { record = structuredClone(v); }, clear: async () => { record = null; }, readInstallation: async () => installation, writeInstallation: async (id) => { installation = id; } };
  let mode = 'activate', calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (mode === 'activate') return body(valid(calls === 1 ? 'valid' : 'activated')); // pre-check, then activate
    if (mode === 'mid-body-timeout') return { ok: true, status: 200, text: async () => { throw abortError(); } };
    if (mode === 'reset') return { ok: true, status: 200, text: async () => { throw new TypeError('terminated'); } };
    if (mode === 'rejected') return body(valid('valid', { valid: false, error: 'This license has been revoked.' }));
    throw new Error('unexpected');
  };
  const provider = graftLicenseProvider({ baseUrl: 'https://licensing.graft.example', fetchImpl });
  const service = createLicenseService({ provider, store, config, now: () => time });
  assert.equal((await service.activate(key)).allowed, true);
  const cached = structuredClone(record);
  // Daily background validation hits a slow network: timeout fires while the body streams.
  mode = 'mid-body-timeout'; time += 86400000;
  let status = await service.validate();
  assert.equal(status.allowed, true, 'still allowed under offline grace');
  assert.match(status.message, /unavailable/i);
  assert.ok(record, 'activation record NOT wiped');
  assert.equal(record.key, cached.key); assert.equal(record.instanceId, cached.instanceId);
  assert.equal(record.verifiedAt, cached.verifiedAt, 'an outage never extends the verified time');
  // Socket reset mid-body, same result.
  mode = 'reset'; time += 86400000;
  assert.equal((await service.validate()).allowed, true); assert.ok(record);
  // Grace is bounded: 31 days without a successful validation ends access, still without wiping.
  time = cached.verifiedAt + 31 * 86400000;
  assert.equal((await service.validate()).allowed, false); assert.ok(record, 'record retained for when the network returns');
  // Back online with a genuine server rejection: THAT revokes and clears.
  mode = 'rejected';
  assert.equal((await service.validate()).allowed, false); assert.equal(record, null);
});

// Generalization Hardening 0.1: the fixture build keeps its (non-secret) licence in a
// build-stamped plain file, so rebuilding the fixture never strands a keychain record.
// Production builds never import the fixture module. The separately named judge demo uses it
// deliberately, with an isolated local home and no live entitlement or operator credential.
test('the fixture licence store is build-bound; only fixture and judge-demo builds can reach it', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { store } = await import('../src/test-fixture.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-fixture-licence-'));
  try {
    const a = store(dir, { build: '0.5.0:fixture:1' });
    assert.equal(await a.read(), null);
    await a.writeInstallation('inst-1');
    await a.write({ schema: 1, key: 'GRAFT-FIXTURE-VALID', instanceId: 'graft-fixture-instance' });
    assert.deepEqual(await a.read(), { schema: 1, key: 'GRAFT-FIXTURE-VALID', instanceId: 'graft-fixture-instance' });
    assert.equal(await a.readInstallation(), 'inst-1');
    assert.equal(fs.statSync(path.join(dir, 'fixture-activation.json')).mode & 0o777, 0o600);
    // The same home reopened by the same fixture build: the record is there (no keychain, no prompt).
    assert.deepEqual(await store(dir, { build: '0.5.0:fixture:1' }).read(), (await a.read()));
    // Reopened by a rebuilt fixture: the record belongs to another build and is treated as absent,
    // so activation simply happens again — never a decryption error, never manual cleanup.
    const rebuilt = store(dir, { build: '0.5.0:fixture:2' });
    assert.equal(await rebuilt.read(), null);
    assert.equal(await rebuilt.readInstallation(), null);
    await a.clear();
    assert.equal(await a.read(), null);
    assert.equal(await a.readInstallation(), 'inst-1', 'clearing the activation keeps the installation identity');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The gate: the fixture module is only loaded behind config.testBuild, the fixture store is only
  // chosen when that module loaded, and the fixture module is only copied into fixture artifacts.
  const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(config\.testBuild\) \{\s*fixture = await import\('\.\/test-fixture\.js'\);/);
  assert.match(main, /store: fixture \? fixture\.store\(/);
  assert.match(main, /: encryptedLicenseStore\(path\.join\(app\.getPath\('userData'\), 'licensing'\), safeStorage\)/);
  assert.equal(/fixture\.store/.test(main.split('store: fixture ? fixture.store(')[0]), false, 'no other path reaches the fixture store');
  const build = fs.readFileSync(new URL('../../../scripts/desktop/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /\(localDemo \|\| path\.basename\(file\) !== 'test-fixture\.js'\)/, 'test-fixture.js is copied only into fixture and judge-demo builds');
  assert.match(build, /!namedProductConfig\(file\)/, 'named operational product profiles never enter an artifact');
  assert.match(build, /provider: 'galuxium-judge-demo'/);
  assert.match(main, /config\.judgeBuild === true && !licensing\.canUse\(\)/, 'judge access is explicit and bounded to its named build');
  const product = JSON.parse(fs.readFileSync(new URL('../config/product.json', import.meta.url), 'utf8'));
  assert.notEqual(product.testBuild, true, 'the committed product configuration is not a test build');
});

// ---- Private Beta Program: expiry, offline override, ended state, feedback, drafts ----
const DAY_MS = 86400000;
const betaKey = 'GRAFT-BETA-KEY';
const beta = (flag, { expiresAt, status = 'active', issuedAt = '2026-09-01T00:00:00.000Z' } = {}) => ({ [flag]: status === 'active', error: status === 'active' ? null : 'This private beta license has expired.',
  license_key: { key: betaKey, status, expires_at: expiresAt, license_type: 'private_beta', issued_at: issuedAt }, instance: { id: 'beta-instance' }, meta: { store_id: 1, product_id: 2, variant_id: 3 } });
function betaSetup({ start = Date.parse('2026-09-13T00:00:00.000Z'), expiresAt = '2026-10-01T00:00:00.000Z' } = {}) {
  let record = null, installation = null, draft = null, time = start, expired = false, feedbackCalls = [];
  const provider = {
    activate: async (k) => (k === key ? valid('activated') : beta('activated', { expiresAt, status: expired ? 'expired' : 'active' })),
    validate: async (k) => (k === key ? valid('valid') : beta('valid', { expiresAt, status: expired ? 'expired' : 'active' })),
    deactivate: async () => ({ deactivated: true, error: null }),
    feedback: async (k, payload) => { feedbackCalls.push({ k, payload }); return { sent: true }; },
  };
  const store = { read: async () => record, write: async (v) => { record = structuredClone(v); }, clear: async () => { record = null; },
    readInstallation: async () => installation, writeInstallation: async (id) => { installation = id; },
    readDraft: async () => draft, writeDraft: async (v) => { draft = structuredClone(v); }, clearDraft: async () => { draft = null; } };
  const service = () => createLicenseService({ provider, store, config: { ...config, inviteOnly: true }, now: () => time });
  return { provider, service, store, record: () => record, draft: () => draft, feedbackCalls, expire: () => { expired = true; }, advance: (ms) => { time += ms; }, setTime: (t) => { time = t; } };
}
const answers = { rating: 4, wouldUseAgain: 'maybe', usedFor: 'a', workedWell: 'b', frustrated: 'c' };
test('private beta: activation stores the type and term; before expiry it is a normal activation; the invite-only build words the prompt accordingly', async () => {
  const f = betaSetup(), s = f.service();
  assert.equal(s.status().message, 'Enter the license key from your invitation email.');
  const st = await s.activate(betaKey);
  assert.equal(st.allowed, true); assert.equal(st.licenseType, 'private_beta'); assert.equal(st.expiresAt, Date.parse('2026-10-01T00:00:00.000Z')); assert.equal(st.betaEnded, null);
  assert.equal(f.record().licenseType, 'private_beta'); assert.equal(f.record().issuedAt, Date.parse('2026-09-01T00:00:00.000Z'));
  assert.equal(st.offlineUntil, Date.parse('2026-10-01T00:00:00.000Z'), 'the offline deadline is min(grace, expiresAt) — here expiresAt');
});
test('private beta: the authoritative expired verdict ends the beta (no generic revocation), persists the ended record, and asks for feedback', async () => {
  const f = betaSetup(), s = f.service(); await s.activate(betaKey);
  f.expire(); f.advance(20 * DAY_MS);
  const st = await s.validate();
  assert.equal(st.allowed, false); assert.equal(st.activated, false); assert.equal(st.message, 'Your GRAFT private beta access has ended.');
  assert.deepEqual(st.betaEnded, { issuedAt: Date.parse('2026-09-01T00:00:00.000Z'), expiresAt: Date.parse('2026-10-01T00:00:00.000Z'), feedbackSubmitted: false, askForFeedback: true });
  assert.equal(f.record().betaEnded, true); assert.equal(f.record().key, betaKey); assert.equal(f.record().feedbackSubmittedAt, null);
  assert.equal(f.record().verifiedAt, undefined, 'the ended record is not an activation record');
  assert.equal(s.canUse(), false);
});
test('private beta: an operator extension is picked up at the next launch or Validate (same key, same seat); a still-expired answer leaves the beta ended', async () => {
  const f = betaSetup(); let s = f.service(); await s.activate(betaKey); f.expire(); await s.validate();
  assert.ok(s.status().betaEnded);
  assert.ok((await s.validate()).betaEnded, 'Validate while still expired: ended stays');
  assert.ok((await f.service().initialize()).betaEnded, 'relaunch while still expired: ended stays');
  // The operator extends: the service now answers active with a later expiry for the same instance.
  let seen = null;
  f.provider.validate = async (k, instance) => { seen = { k, instance }; return beta('valid', { expiresAt: '2026-11-01T00:00:00.000Z' }); };
  const st = await s.validate();
  assert.equal(st.allowed, true); assert.equal(st.betaEnded, null); assert.equal(st.expiresAt, Date.parse('2026-11-01T00:00:00.000Z'));
  assert.deepEqual(seen, { k: betaKey, instance: 'beta-instance' }, 'the same activation instance is validated, no new seat');
  assert.equal(f.record().betaEnded, undefined); assert.equal(f.record().instanceId, 'beta-instance');
  s = f.service(); assert.equal((await s.initialize()).allowed, true);
});
test('private beta OFFLINE: works within the term and grace; the local deadline is min(grace, expiresAt), so past expiresAt the beta ends even while the service is unreachable', async () => {
  const f = betaSetup(), s = f.service(); await s.activate(betaKey);
  f.provider.validate = async () => { throw new LicenseUnavailable(); };
  f.advance(10 * DAY_MS);
  assert.equal((await s.validate()).allowed, true, 'offline inside the term');
  f.setTime(Date.parse('2026-10-01T00:00:00.000Z') - 1);
  assert.equal((await s.validate()).allowed, true, 'one millisecond before expiry, still offline');
  f.advance(1);
  const st = await s.validate();
  assert.equal(st.allowed, false); assert.ok(st.betaEnded); assert.equal(st.betaEnded.askForFeedback, true);
  assert.equal(f.record().betaEnded, true);
  // A purchased licence in the same situation keeps its 30-day grace: expiry never applies to it.
  const g = betaSetup(), p = g.service(); await p.activate(key);
  g.provider.validate = async () => { throw new LicenseUnavailable(); };
  g.advance(29 * DAY_MS); assert.equal((await p.validate()).allowed, true); assert.equal(p.status().betaEnded, null);
});
test('private beta: a licence whose term is 45 days still ends offline at the 30-day grace, never later than expiresAt', async () => {
  const f = betaSetup({ expiresAt: '2026-10-28T00:00:00.000Z' }), s = f.service(); await s.activate(betaKey);
  assert.equal(s.status().offlineUntil, Date.parse('2026-09-13T00:00:00.000Z') + 30 * DAY_MS, 'grace is the earlier deadline here');
  f.provider.validate = async () => { throw new LicenseUnavailable(); };
  f.advance(31 * DAY_MS);
  const st = await s.validate();
  assert.equal(st.allowed, false); assert.equal(st.betaEnded, null, 'inside the term but past grace: needs online validation, not ended');
  assert.equal(st.message, 'Online license validation is required.');
});
test('private beta: relaunch restores the ended state without the network; "Not now" holds for the process only; feedback is sent once through the provider and never reactivates', async () => {
  const f = betaSetup(); let s = f.service(); await s.activate(betaKey); f.expire(); await s.validate();
  f.provider.validate = async () => { throw new LicenseUnavailable(); }; // unreachable: the ended state is restored from the store
  s = f.service();
  const st = await s.initialize();
  assert.equal(st.betaEnded.askForFeedback, true); assert.equal(st.allowed, false);
  assert.equal(s.dismissFeedback().betaEnded.askForFeedback, false);
  assert.equal((await f.service().initialize()).betaEnded.askForFeedback, true, 'asked again on the next launch');
  await f.store.writeDraft(answers);
  const after = await s.feedback(answers, { version: '0.5.0', os: 'macOS 25', arch: 'arm64' });
  assert.equal(after.allowed, false); assert.equal(after.activated, false); assert.equal(after.betaEnded.feedbackSubmitted, true); assert.equal(after.betaEnded.askForFeedback, false);
  assert.equal(f.feedbackCalls.length, 1); assert.equal(f.feedbackCalls[0].k, betaKey); assert.deepEqual(Object.keys(f.feedbackCalls[0].payload), ['responses', 'client']);
  assert.equal(f.draft(), null, 'a successful submission clears the draft');
  assert.equal(f.record().feedbackSubmittedAt, Date.parse('2026-09-13T00:00:00.000Z'));
  assert.equal((await f.service().initialize()).betaEnded.askForFeedback, false, 'the simpler completed state afterwards');
  assert.equal(s.canUse(), false);
});
test('private beta: a failed submission keeps the draft and the ended state; feedback is refused without a beta licence', async () => {
  const f = betaSetup(), s = f.service(); await s.activate(betaKey); f.expire(); await s.validate();
  f.provider.feedback = async () => { throw new LicenseUnavailable('down'); };
  await f.store.writeDraft(answers);
  await assert.rejects(s.feedback(answers, {}), LicenseUnavailable);
  assert.deepEqual(f.draft(), answers); assert.equal(f.record().feedbackSubmittedAt, null); assert.equal(s.status().betaEnded.askForFeedback, true);
  f.provider.feedback = async () => ({ sent: false });
  await assert.rejects(s.feedback(answers, {}), /could not be delivered/);
  const paid = betaSetup(); const p = paid.service(); await p.activate(key);
  await assert.rejects(p.feedback(answers, {}), /private beta testers/);
  assert.equal(paid.feedbackCalls.length, 0);
});
test('private beta: after the end, the same expired key is refused and the ended state survives; a new key (or an extended one) activates and clears it', async () => {
  const f = betaSetup(), s = f.service(); await s.activate(betaKey); f.expire(); await s.validate();
  await assert.rejects(s.activate(betaKey), /private beta access has ended/);
  assert.equal(f.record().betaEnded, true); assert.equal(s.status().betaEnded.askForFeedback, true);
  const st = await s.activate(key); // a different, valid licence
  assert.equal(st.allowed, true); assert.equal(st.betaEnded, null); assert.equal(f.record().key, key);
});
test('private beta: an expired verdict for a PURCHASED licence is still a plain revocation (no feedback experience)', async () => {
  const f = setup(), s = f.service(); await s.activate(key);
  f.provider.validate = async () => valid('valid', { license_key: { key, status: 'expired', expires_at: '2000-01-01T00:00:00Z', license_type: 'purchase' } });
  const st = await s.validate();
  assert.equal(st.allowed, false); assert.equal(st.betaEnded, null); assert.equal(st.message, 'This license has expired.'); assert.equal(f.record(), null);
});
