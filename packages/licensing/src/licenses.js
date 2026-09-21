// The license registry: issuance, activation, validation, deactivation and revocation.
//
// It produces exactly the response shape the desktop license service already expects
// (activate/validate/deactivate with a { license_key, instance, meta } body), so the
// desktop's proven fail-closed state machine is reused unchanged.
//
// Issuance is idempotent by Stripe checkout session id: a webhook retry, or the success
// page racing the webhook, returns the same license rather than minting duplicates.
//
// Activation seats are keyed by a client-generated installation id (an opaque identifier
// each GRAFT installation mints once and persists), never by a human-readable name: the
// same installation re-activating is idempotent, distinct installations consume distinct
// seats, and the seat limit is enforced on the count of distinct installations.
//
// Entitlement states: 'active' -> 'suspended' (a dispute or inquiry is open; fails closed
// until Stripe resolves it) -> 'active' (won / inquiry closed / funds reinstated) or
// 'revoked' (lost / funds withdrawn / fully refunded). 'revoked' is terminal except that a
// revocation caused by a dispute is restored if Stripe later reinstates the funds for that
// same dispute. Every transition is appended to the record's history for audit.
//
// Private-beta licences (Private Beta Program): issued by the operator, never by Stripe — no
// session, no payment intent, so no Stripe event can ever match them. They carry
// licenseType 'private_beta', one seat, and an authoritative expiresAt: at or after it the
// registry answers status 'expired' to every activation and validation, consumes no seat,
// and the desktop ends the beta. Purchased licences keep expiresAt null and are untouched.
//
// Stripe delivers events out of order: a refund or dispute can arrive BEFORE the
// checkout.session.completed that issues the license. Such state is persisted as a
// pre-issuance HOLD keyed by payment intent — a record without a key, driven by the same
// transitions — and issue() consumes it atomically, so the license is born revoked or
// suspended rather than silently active.

import crypto from 'node:crypto';

export class LicenseError extends Error {}

// Client-generated installation identifier: opaque, at least 8 characters, URL-safe.
const INSTALLATION_ID = /^[A-Za-z0-9._-]{8,128}$/;
export function isValidInstallationId(value) { return typeof value === 'string' && INSTALLATION_ID.test(value); }

const HISTORY_LIMIT = 100;
export const PRIVATE_BETA_DEFAULT_DAYS = 30;
export const PRIVATE_BETA_MAX_DAYS = 90;
const DAY_MS = 86400000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Lower-cased, trimmed; refused unless it looks like one address. */
export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new LicenseError('A valid email address is required.');
  return email;
}
/** The operator-facing form of a key: first and last groups only. */
export function maskKey(key) {
  const groups = String(key || '').split('-');
  if (groups.length < 3) return '•••••';
  return [groups[0], groups[1], ...groups.slice(2, -1).map((g) => '•'.repeat(g.length)), groups.at(-1)].join('-');
}
const DISPUTE_TERMINAL = new Set(['won', 'lost', 'warning_closed', 'prevented']);

// A readable, unambiguous key: GRAFT-XXXXX-XXXXX-XXXXX-XXXXX from 20 random bytes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
function generateKey(randomBytes = (n) => crypto.randomBytes(n)) {
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return `GRAFT-${out}`;
}

export function createLicenseRegistry({ store, product, maxActivations = 3, now = Date.now, keyFactory = generateKey }) {
  let queue = Promise.resolve();
  // In-process ordering plus, when the store offers one, a cross-process lock around each operation.
  const serialize = (fn) => {
    const work = queue.then(async () => { const release = store.lock ? await store.lock() : null; try { return await fn(); } finally { release?.(); } });
    queue = work.catch(() => {}); return work;
  };

  const meta = () => ({ store_id: product.storeId, product_id: product.productId, variant_id: product.variantId });
  // The desktop service treats anything but 'active' as disabled and fails closed.
  const expired = (record) => typeof record.expiresAt === 'string' && now() >= Date.parse(record.expiresAt);
  const licenseType = (record) => record.licenseType || 'purchase';
  const licenseKeyBody = (record) => ({ key: record.key, status: record.status !== 'active' ? 'disabled' : expired(record) ? 'expired' : 'active', expires_at: record.expiresAt, license_type: licenseType(record), issued_at: record.issuedAt || null });
  const unusable = (record) => (record.status === 'suspended'
    ? 'This license is temporarily suspended while a payment dispute is resolved.'
    : record.status !== 'active' ? 'This license has been revoked.'
    : licenseType(record) === 'private_beta' ? 'This private beta license has expired.' : 'This license has expired.');
  const withinTerm = (record) => record.status === 'active' && !expired(record);
  function transition(record, { event, to, reason, disputeId = null }) {
    const from = record.status;
    if (to) record.status = to;
    record.history = (record.history || []).concat({ at: new Date(now()).toISOString(), event, from, to: to || from, reason: reason || null, disputeId }).slice(-HISTORY_LIMIT);
  }

  async function issue({ sessionId, paymentIntent, customerEmail }) {
    if (!sessionId) throw new LicenseError('A checkout session id is required to issue a license.');
    // Refunds and disputes are matched by payment intent. Refuse to issue a license we could
    // never revoke, so a missing payment intent fails closed rather than becoming unrevocable.
    if (typeof paymentIntent !== 'string' || paymentIntent.length === 0) throw new LicenseError('A payment intent is required to issue a license.');
    return serialize(async () => {
      const document = await store.load();
      const existingKey = document.sessions[sessionId];
      if (existingKey && document.licenses[existingKey]) return document.licenses[existingKey];
      // Pre-issuance state for this payment (refund/dispute that arrived first) is consumed
      // here, atomically with issuance. Malformed state is refused, never ignored.
      const hold = document.holds?.[paymentIntent] || null;
      if (hold && !(HOLD_STATUSES.has(hold.status) && Array.isArray(hold.history) && typeof hold.disputes === 'object')) {
        throw new LicenseError(`Pre-issuance payment state for this purchase is malformed (status ${JSON.stringify(hold.status)}); refusing to issue.`);
      }
      let key;
      do { key = keyFactory(); } while (document.licenses[key]);
      const record = {
        key,
        status: 'active',
        expiresAt: null, // perpetual one-time purchase
        sessionId,
        paymentIntent,
        customerEmail: customerEmail || null,
        maxActivations,
        instances: [],
        issuedAt: new Date(now()).toISOString(),
        history: [],
      };
      if (hold) {
        for (const field of ['status', 'history', 'disputes', 'revokedAt', 'revokedReason', 'revokedByDispute', 'suspendedByDispute']) {
          if (hold[field] !== undefined) record[field] = hold[field];
        }
        transition(record, { event: 'issue', reason: `issued into pre-issuance state '${hold.status}' (${hold.history.length} earlier event(s))` });
        delete document.holds[paymentIntent];
      }
      document.licenses[key] = record;
      document.sessions[sessionId] = key;
      if (document.deadLetters?.[sessionId]) delete document.deadLetters[sessionId]; // resolved
      await store.save(document);
      return record;
    });
  }

  async function activate(key, { installationId, instanceName } = {}) {
    if (!isValidInstallationId(installationId)) throw new LicenseError('An installation id is required to activate.');
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record) throw new LicenseError('Unknown license key.');
      // Expiry is authoritative here: an expired licence activates nothing and consumes no seat.
      if (!withinTerm(record)) return { activated: false, error: unusable(record), license_key: licenseKeyBody(record), meta: meta() };
      // Re-activation from the same installation is idempotent and consumes no new seat.
      // The name is descriptive only; identity is the installation id.
      let instance = record.instances.find((i) => i.installationId === installationId);
      if (!instance) {
        if (record.instances.length >= record.maxActivations) {
          return { activated: false, error: 'This license has reached its activation limit.', license_key: licenseKeyBody(record), meta: meta() };
        }
        const name = typeof instanceName === 'string' && instanceName.length ? instanceName.slice(0, 128) : 'GRAFT desktop';
        instance = { id: crypto.randomUUID(), installationId, name, activatedAt: new Date(now()).toISOString() };
        record.instances.push(instance);
        await store.save(document);
      }
      return { activated: true, error: null, license_key: licenseKeyBody(record), instance: { id: instance.id }, meta: meta() };
    });
  }

  async function validate(key, instanceId) {
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record) throw new LicenseError('Unknown license key.');
      if (!withinTerm(record)) return { valid: false, error: unusable(record), license_key: licenseKeyBody(record), meta: meta() };
      // A specific installation must correspond to a real activation instance.
      if (instanceId) {
        const instance = record.instances.find((i) => i.id === instanceId);
        if (!instance) return { valid: false, error: 'This activation is not recognized.', license_key: licenseKeyBody(record), meta: meta() };
        return { valid: true, error: null, license_key: licenseKeyBody(record), instance: { id: instance.id }, meta: meta() };
      }
      // Pre-activation identity check: prove the key is a real, active GRAFT license.
      return { valid: true, error: null, license_key: { ...licenseKeyBody(record), status: 'inactive' }, meta: meta() };
    });
  }

  async function deactivate(key, instanceId) {
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record) throw new LicenseError('Unknown license key.');
      const before = record.instances.length;
      record.instances = record.instances.filter((i) => i.id !== instanceId);
      if (record.instances.length !== before) await store.save(document);
      return { deactivated: true, error: null };
    });
  }

  const HOLD_STATUSES = new Set(['active', 'suspended', 'revoked']);
  // The records a payment-intent event applies to: issued licenses, or — before issuance —
  // the hold for that payment intent, created on first sight so no adverse event is lost.
  const byPaymentIntent = (document, paymentIntent) => {
    if (typeof paymentIntent !== 'string' || !paymentIntent.length) return [];
    const issued = Object.values(document.licenses).filter((record) => record.paymentIntent === paymentIntent);
    if (issued.length) return issued;
    document.holds ||= {};
    document.holds[paymentIntent] ||= { paymentIntent, status: 'active', history: [], disputes: {}, createdAt: new Date(now()).toISOString() };
    return [document.holds[paymentIntent]];
  };

  // Full refund, dispute lost, or funds withdrawn: Stripe tells us server-side, we revoke,
  // the desktop fails closed. Idempotent: an already-revoked license is left untouched.
  async function revokeByPaymentIntent(paymentIntent, reason, { disputeId = null } = {}) {
    return serialize(async () => {
      const document = await store.load();
      let changed = false;
      for (const record of byPaymentIntent(document, paymentIntent)) {
        if (record.status === 'revoked') continue;
        transition(record, { event: reason, to: 'revoked', reason, disputeId });
        record.revokedAt = new Date(now()).toISOString();
        record.revokedReason = reason || 'refunded-or-disputed';
        // Only a dispute-caused revocation can ever be restored, and only by that dispute.
        record.revokedByDispute = disputeId;
        changed = true;
      }
      if (changed) await store.save(document);
      return { revoked: changed };
    });
  }

  // A dispute or inquiry was opened: entitlement is withheld until Stripe resolves it.
  // A dispute already resolved (a replayed 'created' after 'closed') cannot re-suspend.
  async function suspendByPaymentIntent(paymentIntent, reason, { disputeId }) {
    if (typeof disputeId !== 'string' || !disputeId) throw new LicenseError('A dispute id is required to suspend.');
    return serialize(async () => {
      const document = await store.load();
      let changed = false;
      for (const record of byPaymentIntent(document, paymentIntent)) {
        record.disputes ||= {};
        const known = record.disputes[disputeId];
        if (known && DISPUTE_TERMINAL.has(known.status)) {
          // A stale or replayed event for a dispute Stripe already closed: audit it, change nothing.
          transition(record, { event: reason, reason: `${reason} (ignored: dispute already ${known.status})`, disputeId });
          changed = true;
          continue;
        }
        record.disputes[disputeId] = { status: 'open', updatedAt: new Date(now()).toISOString() };
        if (record.status === 'active') {
          transition(record, { event: reason, to: 'suspended', reason, disputeId });
          record.suspendedByDispute = disputeId;
        } else {
          transition(record, { event: reason, reason: `${reason} (already ${record.status})`, disputeId });
        }
        changed = true;
      }
      if (changed) await store.save(document);
      return { suspended: changed };
    });
  }

  // Dispute closed in our favour or funds reinstated: restore entitlement, but only if the
  // record's current state was caused by this very dispute. A refund-caused revocation, or
  // a suspension for a different dispute, is never restored here.
  async function restoreByPaymentIntent(paymentIntent, reason, { disputeId, outcome }) {
    if (typeof disputeId !== 'string' || !disputeId) throw new LicenseError('A dispute id is required to restore.');
    return serialize(async () => {
      const document = await store.load();
      let changed = false;
      for (const record of byPaymentIntent(document, paymentIntent)) {
        record.disputes ||= {};
        record.disputes[disputeId] = { status: outcome, updatedAt: new Date(now()).toISOString() };
        const eligible = (record.status === 'suspended' && record.suspendedByDispute === disputeId)
          || (record.status === 'revoked' && record.revokedByDispute === disputeId);
        const otherOpen = Object.keys(record.disputes).find((id) => id !== disputeId && record.disputes[id].status === 'open');
        if (eligible && otherOpen) {
          // This dispute resolved in our favour, but another is still open: stay withheld under it.
          transition(record, { event: reason, to: 'suspended', reason: `${reason} (dispute ${otherOpen} still open)`, disputeId });
          record.suspendedByDispute = otherOpen; delete record.revokedByDispute; delete record.revokedAt; delete record.revokedReason;
        } else if (eligible) {
          transition(record, { event: reason, to: 'active', reason, disputeId });
          delete record.suspendedByDispute; delete record.revokedByDispute; delete record.revokedAt; delete record.revokedReason;
        } else {
          transition(record, { event: reason, reason: `${reason} (no restoration: state ${record.status} not caused by ${disputeId})`, disputeId });
        }
        changed = true;
      }
      if (changed) await store.save(document);
      return { restored: changed };
    });
  }

  // Dispute closed against us: mark the dispute terminal and revoke.
  async function loseByPaymentIntent(paymentIntent, reason, { disputeId, outcome }) {
    if (typeof disputeId !== 'string' || !disputeId) throw new LicenseError('A dispute id is required.');
    await serialize(async () => {
      const document = await store.load();
      let changed = false;
      for (const record of byPaymentIntent(document, paymentIntent)) {
        record.disputes ||= {};
        record.disputes[disputeId] = { status: outcome, updatedAt: new Date(now()).toISOString() };
        changed = true;
      }
      if (changed) await store.save(document);
    });
    return revokeByPaymentIntent(paymentIntent, reason, { disputeId });
  }

  // Audit-only: record a Stripe event that intentionally changes no entitlement (e.g. a
  // partial refund), so the history explains why the license is still usable.
  // Secondary delivery state for a licence: recorded, never a condition of issuance.
  async function recordDelivery(key, delivery) {
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record) throw new LicenseError('Unknown license key.');
      record.delivery = { status: delivery.status, at: new Date(now()).toISOString(), error: delivery.error || null, providerId: delivery.providerId || null, attempts: (record.delivery?.attempts || 0) + 1 };
      await store.save(document);
      return record;
    });
  }

  async function annotateByPaymentIntent(paymentIntent, event, reason) {
    return serialize(async () => {
      const document = await store.load();
      let changed = false;
      for (const record of byPaymentIntent(document, paymentIntent)) { transition(record, { event, reason }); changed = true; }
      if (changed) await store.save(document);
      return { annotated: changed };
    });
  }

  // A paid purchase Stripe reported without what we need to issue safely (an invariant
  // breach, e.g. no payment_intent). Preserved durably, keyed by session so webhook retries
  // and the success page converge on ONE entry, for manual triage. No PII is stored.
  async function deadLetter({ sessionId, eventId = null, type, reason }) {
    if (!sessionId) throw new LicenseError('A checkout session id is required to dead-letter.');
    return serialize(async () => {
      const document = await store.load();
      // A session that already has a license is resolved: a stale replay of the broken
      // event must not reopen review for it.
      const issuedKey = document.sessions[sessionId];
      if (issuedKey && document.licenses[issuedKey]) return { sessionId, resolved: true, key: issuedKey };
      document.deadLetters ||= {};
      const at = new Date(now()).toISOString();
      const entry = document.deadLetters[sessionId] || { sessionId, type, reason, eventIds: [], firstSeenAt: at, count: 0 };
      if (eventId && !entry.eventIds.includes(eventId)) entry.eventIds.push(eventId);
      entry.lastSeenAt = at; entry.count += 1; entry.reason = reason || entry.reason;
      document.deadLetters[sessionId] = entry;
      await store.save(document);
      return entry;
    });
  }
  async function holds() {
    const document = await store.load();
    return Object.values(document.holds || {});
  }
  async function deadLetters() {
    const document = await store.load();
    return Object.values(document.deadLetters || {});
  }

  // ---- Private Beta Program: operator-issued, time-limited, one seat, no Stripe ----
  const privateBetaRecords = (document) => Object.values(document.licenses).filter((r) => r.licenseType === 'private_beta');
  const currentPrivateBeta = (document, email) => privateBetaRecords(document).find((r) => r.customerEmail === email && withinTerm(r)) || null;
  function checkDays(days) {
    if (!Number.isSafeInteger(days) || days < 1 || days > PRIVATE_BETA_MAX_DAYS) throw new LicenseError(`Duration must be a whole number of days between 1 and ${PRIVATE_BETA_MAX_DAYS}.`);
    return days;
  }
  /** Issue one private-beta licence. A current (active, unexpired) one for the same address is returned
   * as { issued: false, existing } unless reissue is set, in which case it is revoked first. */
  async function issuePrivateBeta({ email, days = PRIVATE_BETA_DEFAULT_DAYS, reissue = false, reference = null } = {}) {
    const address = normalizeEmail(email);
    const term = checkDays(days);
    return serialize(async () => {
      const document = await store.load();
      const current = currentPrivateBeta(document, address);
      if (current && !reissue) return { issued: false, existing: current };
      if (current) {
        transition(current, { event: 'reissue', to: 'revoked', reason: 'replaced by a reissued private-beta license' });
        current.revokedAt = new Date(now()).toISOString(); current.revokedReason = 'reissued';
      }
      let key;
      do { key = keyFactory(); } while (document.licenses[key]);
      const issuedAt = new Date(now()).toISOString();
      const record = {
        key, licenseType: 'private_beta', status: 'active',
        issuedAt, expiresAt: new Date(now() + term * DAY_MS).toISOString(),
        sessionId: null, paymentIntent: null, customerEmail: address,
        maxActivations: 1, instances: [], history: [],
      };
      transition(record, { event: 'issue-private-beta', reason: `${term} day(s), 1 seat${typeof reference === 'string' && reference ? `; reference ${String(reference).slice(0, 80)}` : ''}` });
      document.licenses[key] = record;
      await store.save(document);
      return { issued: true, record, replaced: current ? current.key : null };
    });
  }
  /** Look a private-beta licence up by key, or by the address (its current licence, else the latest). */
  async function findPrivateBeta({ key = null, email = null } = {}) {
    const document = await store.load();
    if (key) { const record = document.licenses[key]; return record?.licenseType === 'private_beta' ? record : null; }
    const address = normalizeEmail(email);
    const mine = privateBetaRecords(document).filter((r) => r.customerEmail === address).sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
    return currentPrivateBeta(document, address) || mine[0] || null;
  }
  async function revokePrivateBeta(key, reason = 'revoked by operator') {
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record || record.licenseType !== 'private_beta') throw new LicenseError('Unknown private-beta license.');
      if (record.status === 'revoked') return { revoked: false, record };
      transition(record, { event: 'revoke-private-beta', to: 'revoked', reason });
      record.revokedAt = new Date(now()).toISOString(); record.revokedReason = reason;
      await store.save(document);
      return { revoked: true, record };
    });
  }
  /** Extend by whole days from the later of now and the current expiry; the key never changes and the
   * new expiry may not lie more than PRIVATE_BETA_MAX_DAYS past now. */
  async function extendPrivateBeta(key, days) {
    const term = checkDays(days);
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record || record.licenseType !== 'private_beta') throw new LicenseError('Unknown private-beta license.');
      if (record.status !== 'active') throw new LicenseError(`This private-beta license is ${record.status}; it cannot be extended.`);
      const base = Math.max(now(), Date.parse(record.expiresAt) || 0);
      const next = base + term * DAY_MS;
      if (next > now() + PRIVATE_BETA_MAX_DAYS * DAY_MS) throw new LicenseError(`An extension may not place the expiry more than ${PRIVATE_BETA_MAX_DAYS} days from today.`);
      const previous = record.expiresAt;
      record.expiresAt = new Date(next).toISOString();
      transition(record, { event: 'extend-private-beta', reason: `${previous} -> ${record.expiresAt} (+${term} day(s))` });
      await store.save(document);
      return { extended: true, record, previous };
    });
  }
  /** Feedback outcome for a private-beta licence: counts and the last rating only; the text lives in the support email. */
  async function recordFeedback(key, { rating, providerId = null }) {
    return serialize(async () => {
      const document = await store.load();
      const record = document.licenses[key];
      if (!record || record.licenseType !== 'private_beta') throw new LicenseError('Unknown private-beta license.');
      const feedback = record.feedback || { count: 0, providerIds: [] };
      feedback.count += 1; feedback.lastAt = new Date(now()).toISOString(); feedback.lastRating = rating;
      if (providerId) feedback.providerIds = feedback.providerIds.concat(providerId).slice(-20);
      record.feedback = feedback;
      await store.save(document);
      return record;
    });
  }

  async function get(key) {
    const document = await store.load();
    return document.licenses[key] || null;
  }
  async function getBySession(sessionId) {
    const document = await store.load();
    const key = document.sessions[sessionId];
    return key ? document.licenses[key] : null;
  }

  return { issue, activate, validate, deactivate, recordDelivery, issuePrivateBeta, findPrivateBeta, revokePrivateBeta, extendPrivateBeta, recordFeedback, revokeByPaymentIntent, suspendByPaymentIntent, restoreByPaymentIntent, loseByPaymentIntent, annotateByPaymentIntent, deadLetter, deadLetters, holds, get, getBySession };
}

export { generateKey };
