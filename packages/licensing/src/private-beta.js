// Private Beta Program — the one issuance path. The operator CLI and the server-to-server approval
// route both call issueAndInvite(); nothing else creates a private-beta licence. The result never
// carries the full key: the tester receives it by email, everyone else sees the masked form.
import { maskKey, PRIVATE_BETA_DEFAULT_DAYS } from './licenses.js';

const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : null);

/** The safe, operator- and website-facing view of a private-beta record. */
export function safeLicenseFacts(record, now = Date.now()) {
  return {
    email: record.customerEmail,
    licenseMasked: maskKey(record.key),
    licenseType: record.licenseType || 'purchase',
    status: record.status !== 'active' ? record.status : (Date.parse(record.expiresAt) <= now ? 'expired' : 'active'),
    issuedAt: record.issuedAt || null,
    expiresAt: record.expiresAt || null,
    expires: longDate(record.expiresAt),
    seats: { used: record.instances.length, max: record.maxActivations },
    delivery: record.delivery ? { status: record.delivery.status, at: record.delivery.at, error: record.delivery.error || null } : { status: 'not-sent', at: null, error: null },
    feedback: record.feedback ? { count: record.feedback.count, lastAt: record.feedback.lastAt, lastRating: record.feedback.lastRating } : null,
  };
}

/**
 * Issue a private-beta licence for an address and email the invitation. A current licence for the
 * same address is reported instead of duplicated unless `reissue` is set. `reference` (e.g. the
 * website application id) is recorded in the licence history for audit only.
 */
export async function issueAndInvite({ registry, mailer, email, days = PRIVATE_BETA_DEFAULT_DAYS, reissue = false, reference = null, now = Date.now }) {
  const result = await registry.issuePrivateBeta({ email, days, reissue, reference });
  if (!result.issued) return { ok: true, issued: false, reason: 'current-license-exists', license: safeLicenseFacts(result.existing, now()) };
  const outcome = await mailer.sendPrivateBeta({ to: result.record.customerEmail, key: result.record.key, expiresAt: result.record.expiresAt });
  const record = await registry.recordDelivery(result.record.key, outcome);
  return { ok: outcome.sent, issued: true, reason: outcome.sent ? null : `delivery-${outcome.status}`, deliveryError: outcome.error || null, license: safeLicenseFacts(record, now()), replaced: result.replaced ? maskKey(result.replaced) : null, key: record.key };
}
