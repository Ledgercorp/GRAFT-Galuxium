import test from 'node:test';
import assert from 'node:assert/strict';
import { createLicenseRegistry, generateKey, isValidInstallationId } from '../src/licenses.js';
import { memoryStore } from '../src/store.js';

const product = { storeId: 1, productId: 1, variantId: 1 };
const make = (over = {}) => createLicenseRegistry({ store: memoryStore(), product, maxActivations: 2, now: () => 1700000000000, ...over });
// Installation ids as the desktop mints them: opaque, unique per installation.
const install = (label) => ({ installationId: `inst-${label.replace(/[^A-Za-z0-9._-]/g, '_')}-00000000`, instanceName: 'GRAFT desktop' });

test('generated keys are unique, prefixed, and use an unambiguous alphabet', () => {
  const keys = new Set();
  for (let i = 0; i < 500; i += 1) {
    const key = generateKey();
    assert.match(key, /^GRAFT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789-]+$/);
    assert.ok(!keys.has(key), 'keys must not collide');
    keys.add(key);
  }
});

test('issuance is idempotent by checkout session id', async () => {
  const registry = make();
  const first = await registry.issue({ sessionId: 'cs_1', paymentIntent: 'pi_1', customerEmail: 'a@b.co' });
  const second = await registry.issue({ sessionId: 'cs_1', paymentIntent: 'pi_1', customerEmail: 'a@b.co' });
  assert.equal(first.key, second.key);
  assert.equal(first.status, 'active');
  assert.equal(first.expiresAt, null);
});

test('issuance without a payment intent is refused, so no unrevocable license exists', async () => {
  const registry = make();
  await assert.rejects(registry.issue({ sessionId: 'cs_no_pi' }), /payment intent is required/);
  await assert.rejects(registry.issue({ sessionId: 'cs_no_pi', paymentIntent: '' }), /payment intent is required/);
  assert.equal(await registry.getBySession('cs_no_pi'), null);
});

test('a purchased license activates, validates its instance, and matches the product identity', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_2', paymentIntent: 'pi_2' });
  const activation = await registry.activate(record.key, install('GRAFT desktop'));
  assert.equal(activation.activated, true);
  assert.deepEqual(activation.meta, { store_id: 1, product_id: 1, variant_id: 1 });
  const validation = await registry.validate(record.key, activation.instance.id);
  assert.equal(validation.valid, true);
  assert.equal(validation.instance.id, activation.instance.id);
  assert.equal(validation.license_key.status, 'active');
});

test('pre-activation validate proves identity without consuming a seat', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_3', paymentIntent: 'pi_3' });
  const check = await registry.validate(record.key, null);
  assert.equal(check.valid, true);
  assert.equal(check.license_key.status, 'inactive');
  assert.equal((await registry.get(record.key)).instances.length, 0);
});

test('activation is bounded by the seat limit', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_4', paymentIntent: 'pi_4' });
  assert.equal((await registry.activate(record.key, install('mac-1'))).activated, true);
  assert.equal((await registry.activate(record.key, install('mac-2'))).activated, true);
  const third = await registry.activate(record.key, install('mac-3'));
  assert.equal(third.activated, false);
  assert.match(third.error, /activation limit/);
});

test('re-activating from the same installation is idempotent and consumes no extra seat', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_5', paymentIntent: 'pi_5' });
  const a = await registry.activate(record.key, install('same-mac'));
  const b = await registry.activate(record.key, install('same-mac'));
  assert.equal(a.instance.id, b.instance.id);
  assert.equal((await registry.get(record.key)).instances.length, 1);
});

test('deactivation frees a seat', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_6', paymentIntent: 'pi_6' });
  const a = await registry.activate(record.key, install('mac-a'));
  await registry.activate(record.key, install('mac-b'));
  assert.equal((await registry.deactivate(record.key, a.instance.id)).deactivated, true);
  assert.equal((await registry.get(record.key)).instances.length, 1);
  assert.equal((await registry.activate(record.key, install('mac-c'))).activated, true);
});

test('a refund revokes the license and validation then fails closed', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_7', paymentIntent: 'pi_7' });
  const activation = await registry.activate(record.key, install('mac'));
  assert.equal((await registry.revokeByPaymentIntent('pi_7', 'charge.refunded')).revoked, true);
  const validation = await registry.validate(record.key, activation.instance.id);
  assert.equal(validation.valid, false);
  assert.equal(validation.license_key.status, 'disabled');
  assert.equal((await registry.activate(record.key, install('mac-2'))).activated, false);
});

test('an unknown key is rejected (never silently valid)', async () => {
  const registry = make();
  await assert.rejects(registry.validate('GRAFT-NOPE', null));
  await assert.rejects(registry.activate('GRAFT-NOPE', install('mac')));
});

test('validating a real license with a foreign instance id fails closed', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_8', paymentIntent: 'pi_8' });
  await registry.activate(record.key, install('mac'));
  const validation = await registry.validate(record.key, 'not-a-real-instance');
  assert.equal(validation.valid, false);
});

test('seat identity is the installation id, never the display name: same name on distinct installations consumes distinct seats, the fourth is refused', async () => {
  const registry = make({ maxActivations: 3 });
  const record = await registry.issue({ sessionId: 'cs_seat', paymentIntent: 'pi_seat' });
  const macs = ['a', 'b', 'c'].map((l) => ({ installationId: `mac-${l}-11111111`, instanceName: 'GRAFT desktop' }));
  const ids = [];
  for (const mac of macs) { const r = await registry.activate(record.key, mac); assert.equal(r.activated, true); ids.push(r.instance.id); }
  assert.equal(new Set(ids).size, 3, 'three installations sharing a display name must get three distinct instances');
  assert.equal((await registry.get(record.key)).instances.length, 3);
  const fourth = await registry.activate(record.key, { installationId: 'mac-d-11111111', instanceName: 'GRAFT desktop' });
  assert.equal(fourth.activated, false);
  assert.match(fourth.error, /activation limit/);
  // Retries from any of the three keep working and consume nothing.
  const retry = await registry.activate(record.key, macs[1]);
  assert.equal(retry.activated, true);
  assert.equal(retry.instance.id, ids[1]);
  assert.equal((await registry.get(record.key)).instances.length, 3);
});

test('deactivating one installation frees exactly its seat for a new installation', async () => {
  const registry = make({ maxActivations: 3 });
  const record = await registry.issue({ sessionId: 'cs_free', paymentIntent: 'pi_free' });
  const a = await registry.activate(record.key, install('a'));
  await registry.activate(record.key, install('b'));
  await registry.activate(record.key, install('c'));
  assert.equal((await registry.activate(record.key, install('d'))).activated, false);
  assert.equal((await registry.deactivate(record.key, a.instance.id)).deactivated, true);
  assert.equal((await registry.validate(record.key, a.instance.id)).valid, false, 'a released instance no longer validates');
  assert.equal((await registry.activate(record.key, install('d'))).activated, true);
  assert.equal((await registry.activate(record.key, install('e'))).activated, false);
});

test('activation without a well-formed installation id is refused before any seat is consumed', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_noid', paymentIntent: 'pi_noid' });
  for (const bad of [undefined, null, '', 'short', 'has space 12345', 'x'.repeat(129), 42]) {
    await assert.rejects(registry.activate(record.key, { installationId: bad, instanceName: 'GRAFT desktop' }), /installation id/);
  }
  await assert.rejects(registry.activate(record.key, 'GRAFT desktop'), /installation id/); // the old name-only contract
  assert.equal((await registry.get(record.key)).instances.length, 0);
  assert.equal(isValidInstallationId('8f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'), true);
  assert.equal(isValidInstallationId('GRAFT desktop'), false);
});

test('dispute lifecycle: suspend fails closed, won restores, replayed created cannot re-suspend, refund revocation is never restored', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_d', paymentIntent: 'pi_d' });
  const act = await registry.activate(record.key, install('m'));
  assert.equal((await registry.suspendByPaymentIntent('pi_d', 'charge.dispute.created:needs_response', { disputeId: 'du_1' })).suspended, true);
  let v = await registry.validate(record.key, act.instance.id);
  assert.equal(v.valid, false); assert.match(v.error, /suspended/); assert.equal(v.license_key.status, 'disabled');
  assert.match((await registry.activate(record.key, install('other'))).error, /suspended/);
  // Replay of the suspension is a no-op on state.
  await registry.suspendByPaymentIntent('pi_d', 'charge.dispute.updated:under_review', { disputeId: 'du_1' });
  assert.equal((await registry.get(record.key)).status, 'suspended');
  // Won: restored, and the existing activation resumes without consuming a new seat.
  assert.equal((await registry.restoreByPaymentIntent('pi_d', 'charge.dispute.closed:won', { disputeId: 'du_1', outcome: 'won' })).restored, true);
  v = await registry.validate(record.key, act.instance.id);
  assert.equal(v.valid, true);
  assert.equal((await registry.get(record.key)).instances.length, 1);
  // A late/replayed 'created' for the already-won dispute cannot re-suspend.
  await registry.suspendByPaymentIntent('pi_d', 'charge.dispute.created:needs_response', { disputeId: 'du_1' });
  assert.equal((await registry.get(record.key)).status, 'active');
  // A different, new dispute suspends again.
  await registry.suspendByPaymentIntent('pi_d', 'charge.dispute.created:needs_response', { disputeId: 'du_2' });
  assert.equal((await registry.get(record.key)).status, 'suspended');
  // A won outcome for the WRONG dispute id does not restore.
  await registry.restoreByPaymentIntent('pi_d', 'charge.dispute.closed:won', { disputeId: 'du_1', outcome: 'won' });
  assert.equal((await registry.get(record.key)).status, 'suspended');
  // Lost: revoked. Then a restore for that dispute id is legitimate (funds reinstated) ...
  await registry.loseByPaymentIntent('pi_d', 'charge.dispute.closed:lost', { disputeId: 'du_2', outcome: 'lost' });
  assert.equal((await registry.get(record.key)).status, 'revoked');
  await registry.restoreByPaymentIntent('pi_d', 'charge.dispute.funds_reinstated', { disputeId: 'du_2', outcome: 'won' });
  assert.equal((await registry.get(record.key)).status, 'active');
  // ... but a FULL REFUND revocation is terminal: no dispute event can restore it.
  await registry.revokeByPaymentIntent('pi_d', 'charge.refunded');
  await registry.restoreByPaymentIntent('pi_d', 'charge.dispute.funds_reinstated', { disputeId: 'du_2', outcome: 'won' });
  await registry.restoreByPaymentIntent('pi_d', 'charge.dispute.closed:won', { disputeId: 'du_3', outcome: 'won' });
  assert.equal((await registry.get(record.key)).status, 'revoked');
  // Audit trail records every transition with its cause.
  const history = (await registry.get(record.key)).history;
  assert.deepEqual(history.map((h) => `${h.from}>${h.to}`).filter((x, i, a) => a[i - 1] !== x),
    ['active>suspended', 'suspended>suspended', 'suspended>active', 'active>active', 'active>suspended', 'suspended>suspended', 'suspended>revoked', 'revoked>active', 'active>revoked', 'revoked>revoked']);
  assert.ok(history.every((h) => typeof h.at === 'string' && typeof h.event === 'string'));
});

test('revocation is idempotent and a revoked license ignores suspension', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_r', paymentIntent: 'pi_r' });
  assert.equal((await registry.revokeByPaymentIntent('pi_r', 'charge.refunded')).revoked, true);
  assert.equal((await registry.revokeByPaymentIntent('pi_r', 'charge.refunded')).revoked, false);
  await registry.suspendByPaymentIntent('pi_r', 'charge.dispute.created:needs_response', { disputeId: 'du_x' });
  assert.equal((await registry.get(record.key)).status, 'revoked');
  assert.equal((await registry.get(record.key)).revokedReason, 'charge.refunded');
});

test('winning one dispute while another is still open keeps the license withheld under the open one', async () => {
  const registry = make();
  const record = await registry.issue({ sessionId: 'cs_two', paymentIntent: 'pi_two' });
  await registry.suspendByPaymentIntent('pi_two', 'charge.dispute.created:needs_response', { disputeId: 'du_a' });
  await registry.suspendByPaymentIntent('pi_two', 'charge.dispute.created:needs_response', { disputeId: 'du_b' });
  await registry.restoreByPaymentIntent('pi_two', 'charge.dispute.closed:won', { disputeId: 'du_a', outcome: 'won' });
  assert.equal((await registry.get(record.key)).status, 'suspended');
  assert.equal((await registry.get(record.key)).suspendedByDispute, 'du_b');
  await registry.restoreByPaymentIntent('pi_two', 'charge.dispute.closed:won', { disputeId: 'du_b', outcome: 'won' });
  assert.equal((await registry.get(record.key)).status, 'active');
});

// ---- Pre-issuance ordering: Stripe events for a payment that has no license yet ----
const suspend = (r, pi, id) => r.suspendByPaymentIntent(pi, 'charge.dispute.created:needs_response', { disputeId: id });
const won = (r, pi, id) => r.restoreByPaymentIntent(pi, 'charge.dispute.closed:won', { disputeId: id, outcome: 'won' });
const lost = (r, pi, id) => r.loseByPaymentIntent(pi, 'charge.dispute.closed:lost', { disputeId: id, outcome: 'lost' });

test('pre-issuance: a full refund before checkout.session.completed makes the eventual license revoked, and it stays that way', async () => {
  const registry = make();
  assert.equal((await registry.revokeByPaymentIntent('pi_p1', 'charge.refunded')).revoked, true);
  assert.equal((await registry.holds()).length, 1);
  const record = await registry.issue({ sessionId: 'cs_p1', paymentIntent: 'pi_p1' });
  assert.equal(record.status, 'revoked'); assert.equal(record.revokedReason, 'charge.refunded');
  assert.equal((await registry.holds()).length, 0, 'the hold is consumed');
  assert.equal((await registry.validate(record.key, null)).valid, false);
  assert.equal((await registry.activate(record.key, install('m'))).activated, false);
  // Replays after issuance are idempotent; a dispute won can never revive a refund revocation.
  assert.equal((await registry.revokeByPaymentIntent('pi_p1', 'charge.refunded')).revoked, false);
  await suspend(registry, 'pi_p1', 'du_z'); await won(registry, 'pi_p1', 'du_z');
  assert.equal((await registry.get(record.key)).status, 'revoked');
  const history = (await registry.get(record.key)).history;
  assert.equal(history[0].event, 'charge.refunded'); assert.equal(history[1].event, 'issue'); assert.match(history[1].reason, /pre-issuance state 'revoked'/);
});

test('pre-issuance: an open dispute before issuance yields a suspended license; won afterwards restores it', async () => {
  const registry = make();
  await suspend(registry, 'pi_p2', 'du_1');
  const record = await registry.issue({ sessionId: 'cs_p2', paymentIntent: 'pi_p2' });
  assert.equal(record.status, 'suspended'); assert.equal(record.suspendedByDispute, 'du_1');
  assert.match((await registry.validate(record.key, null)).error, /suspended/);
  await won(registry, 'pi_p2', 'du_1');
  assert.equal((await registry.get(record.key)).status, 'active');
  assert.equal((await registry.activate(record.key, install('m'))).activated, true);
});

test('pre-issuance: a dispute lost (or funds withdrawn) before issuance yields a revoked license', async () => {
  const registry = make();
  await suspend(registry, 'pi_p3', 'du_1'); await lost(registry, 'pi_p3', 'du_1');
  const a = await registry.issue({ sessionId: 'cs_p3', paymentIntent: 'pi_p3' });
  assert.equal(a.status, 'revoked'); assert.equal(a.revokedByDispute, 'du_1');
  const b = make();
  await b.loseByPaymentIntent('pi_p4', 'charge.dispute.funds_withdrawn', { disputeId: 'du_w', outcome: 'open' });
  assert.equal((await b.issue({ sessionId: 'cs_p4', paymentIntent: 'pi_p4' })).status, 'revoked');
  // Funds reinstated for THAT dispute later restores (a legitimate outcome), for another it does not.
  await b.restoreByPaymentIntent('pi_p4', 'charge.dispute.funds_reinstated', { disputeId: 'du_other', outcome: 'won' });
  assert.equal((await b.getBySession('cs_p4')).status, 'revoked');
  await b.restoreByPaymentIntent('pi_p4', 'charge.dispute.funds_reinstated', { disputeId: 'du_w', outcome: 'won' });
  assert.equal((await b.getBySession('cs_p4')).status, 'active');
});

test('pre-issuance: a dispute opened and won before issuance yields an ACTIVE license only because it was won; a replayed created for it cannot suspend later', async () => {
  const registry = make();
  await suspend(registry, 'pi_p5', 'du_1'); await won(registry, 'pi_p5', 'du_1');
  const record = await registry.issue({ sessionId: 'cs_p5', paymentIntent: 'pi_p5' });
  assert.equal(record.status, 'active');
  await suspend(registry, 'pi_p5', 'du_1'); // stale replay
  assert.equal((await registry.get(record.key)).status, 'active');
  await suspend(registry, 'pi_p5', 'du_2'); // a genuinely new dispute still works
  assert.equal((await registry.get(record.key)).status, 'suspended');
});

test('pre-issuance: refund then a dispute won before issuance -> the license is still born revoked', async () => {
  const registry = make();
  await registry.revokeByPaymentIntent('pi_p6', 'charge.refunded');
  await suspend(registry, 'pi_p6', 'du_1'); await won(registry, 'pi_p6', 'du_1');
  assert.equal((await registry.holds())[0].status, 'revoked');
  assert.equal((await registry.issue({ sessionId: 'cs_p6', paymentIntent: 'pi_p6' })).status, 'revoked');
});

test('pre-issuance: replayed events before issuance are idempotent and a partial refund creates only an audit hold', async () => {
  const registry = make();
  for (let i = 0; i < 3; i += 1) await registry.revokeByPaymentIntent('pi_p7', 'charge.refunded');
  const [hold] = await registry.holds();
  assert.equal(hold.status, 'revoked');
  assert.equal(hold.history.filter((h) => h.to === 'revoked' && h.from !== 'revoked').length, 1);
  await registry.annotateByPaymentIntent('pi_p8', 'charge.refunded', 'partial refund 100/5243; entitlement retained');
  const audit = (await registry.holds()).find((h) => h.paymentIntent === 'pi_p8');
  assert.equal(audit.status, 'active');
  assert.equal((await registry.issue({ sessionId: 'cs_p8', paymentIntent: 'pi_p8' })).status, 'active');
});

test('pre-issuance: a malformed hold is refused at issuance (fail closed), never issued active', async () => {
  const store = memoryStore({ licenses: {}, sessions: {}, deadLetters: {}, holds: { pi_bad: { paymentIntent: 'pi_bad', status: 'nonsense', history: [], disputes: {} } } });
  const registry = createLicenseRegistry({ store, product });
  await assert.rejects(registry.issue({ sessionId: 'cs_bad', paymentIntent: 'pi_bad' }), /malformed/);
  assert.equal(await registry.getBySession('cs_bad'), null);
  const store2 = memoryStore({ licenses: {}, sessions: {}, deadLetters: {}, holds: { pi_bad2: { paymentIntent: 'pi_bad2', status: 'revoked' } } }); // missing history/disputes
  await assert.rejects(createLicenseRegistry({ store: store2, product }).issue({ sessionId: 'cs_bad2', paymentIntent: 'pi_bad2' }), /malformed/);
});

test('pre-issuance holds persist across a file-backed restart and old documents without holds still load', async (t) => {
  const { fileStore } = await import('../src/store.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-hold-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'licenses.json');
  fs.writeFileSync(file, JSON.stringify({ licenses: {}, sessions: {} })); // a pre-upgrade document
  const a = createLicenseRegistry({ store: fileStore(file), product });
  assert.deepEqual(await a.holds(), []);
  await a.suspendByPaymentIntent('pi_restart', 'charge.dispute.created:needs_response', { disputeId: 'du_r' });
  const b = createLicenseRegistry({ store: fileStore(file), product }); // restart
  assert.equal((await b.holds())[0].status, 'suspended');
  const record = await b.issue({ sessionId: 'cs_restart', paymentIntent: 'pi_restart' });
  assert.equal(record.status, 'suspended');
  assert.deepEqual(await createLicenseRegistry({ store: fileStore(file), product }).holds(), []);
});

test('ONE seat pool across platforms: two Macs and a Windows PC fill the 3 seats; a fourth of either kind is refused; deactivating a Mac frees exactly one seat for Windows', async () => {
  const registry = make({ maxActivations: 3 });
  const record = await registry.issue({ sessionId: 'cs_xplat', paymentIntent: 'pi_xplat' });
  const mac1 = { installationId: 'mac-11111111-aaaa', instanceName: 'GRAFT desktop (macOS)' };
  const mac2 = { installationId: 'mac-22222222-bbbb', instanceName: 'GRAFT desktop (macOS)' };
  const win1 = { installationId: 'win-33333333-cccc', instanceName: 'GRAFT desktop (Windows)' };
  const win2 = { installationId: 'win-44444444-dddd', instanceName: 'GRAFT desktop (Windows)' };
  const a = await registry.activate(record.key, mac1); const b = await registry.activate(record.key, mac2); const c = await registry.activate(record.key, win1);
  assert.ok(a.activated && b.activated && c.activated);
  assert.equal((await registry.activate(record.key, win2)).activated, false, 'fourth installation (Windows) refused');
  assert.equal((await registry.activate(record.key, { installationId: 'mac-55555555-eeee', instanceName: 'GRAFT desktop (macOS)' })).activated, false, 'fourth installation (Mac) refused');
  // Same Windows installation re-activating (reopen/reinstall with identity intact) is idempotent.
  assert.equal((await registry.activate(record.key, win1)).instance.id, c.instance.id);
  assert.equal((await registry.get(record.key)).instances.length, 3);
  assert.deepEqual((await registry.get(record.key)).instances.map((i) => i.name), ['GRAFT desktop (macOS)', 'GRAFT desktop (macOS)', 'GRAFT desktop (Windows)']);
  // Deactivate one Mac: that seat, and only that seat, becomes available to the second Windows PC.
  await registry.deactivate(record.key, a.instance.id);
  assert.equal((await registry.validate(record.key, a.instance.id)).valid, false);
  assert.equal((await registry.validate(record.key, b.instance.id)).valid, true);
  assert.equal((await registry.validate(record.key, c.instance.id)).valid, true);
  assert.equal((await registry.activate(record.key, win2)).activated, true);
  assert.equal((await registry.activate(record.key, { installationId: 'win-66666666-ffff', instanceName: 'GRAFT desktop (Windows)' })).activated, false);
});
