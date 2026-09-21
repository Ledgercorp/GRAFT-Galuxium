import crypto from 'node:crypto';
import { LicenseRejected, LicenseUnavailable } from './license-provider.js';
const day = 86400000;
// Must match the backend's grammar (packages/licensing/src/licenses.js); a contract test
// in packages/licensing/test asserts both sides agree, without a shared runtime dependency.
const INSTALLATION_ID = /^[A-Za-z0-9._-]{8,128}$/;
export const isValidInstallationId = (value) => typeof value === 'string' && INSTALLATION_ID.test(value);

// Private Beta Program: a private_beta licence carries an authoritative expiresAt from the service.
// Offline, the effective deadline is min(offline grace, expiresAt) — see usable(). When the
// service answers 'expired' (or the local deadline passes with the service unreachable), the
// activation record is replaced by a small ENDED record: no key usable for operations, only
// what the end-of-beta feedback needs (the key to authenticate the submission, the term dates,
// whether feedback was already sent). Submitting feedback never touches entitlement.
export function createLicenseService({ provider, store, config, now = Date.now, randomId = () => crypto.randomUUID(), installationName = 'GRAFT desktop' }) {
  let record = null;
  let ended = null; // { schema: 1, betaEnded: true, key, licenseType, issuedAt, expiresAt, endedAt, feedbackSubmittedAt }
  let feedbackDismissed = false; // "Not now" for this process only; the next launch asks again
  let reason = config.inviteOnly ? 'Enter the license key from your invitation email.' : 'Enter your purchased GRAFT license.';
  let queue = Promise.resolve();
  const configured = Number.isSafeInteger(config.storeId) && config.storeId > 0 && Number.isSafeInteger(config.productId) && config.productId > 0
    && Array.isArray(config.variantIds) && config.variantIds.length > 0 && config.variantIds.every((id) => Number.isSafeInteger(id) && id > 0);
  const matches = (ids) => ids?.store_id === config.storeId && ids?.product_id === config.productId && config.variantIds.includes(ids?.variant_id);
  const serialize = (fn) => { const work = queue.then(fn); queue = work.catch(() => {}); return work; };
  function usable() {
    const time = now();
    return Boolean(configured && record?.schema === 1 && matches(record.meta) && typeof record.key === 'string' && record.key.length > 0
      && typeof record.instanceId === 'string' && record.instanceId.length > 0 && Number.isFinite(record.verifiedAt) && Number.isFinite(record.lastSeenAt)
      && time >= record.lastSeenAt - 300000 && time >= record.verifiedAt - 300000
      && time - record.verifiedAt <= Math.min(config.offlineDays || 30, 30) * day
      && (record.expiresAt === null || (Number.isFinite(record.expiresAt) && time < record.expiresAt)));
  }
  function status() {
    return { allowed: usable(), activated: Boolean(record), configured, mode: config.testBuild ? 'test-fixture' : 'purchased',
      message: !configured ? 'GRAFT license product is not configured in this development candidate.' : usable() ? reason : record ? 'Online license validation is required.' : reason,
      offlineUntil: record ? Math.min(record.verifiedAt + Math.min(config.offlineDays || 30, 30) * day, record.expiresAt ?? Infinity) : null,
      licenseType: record?.licenseType || null, expiresAt: record?.expiresAt ?? null,
      // The end-of-beta state the licence page renders; never a way back into the workspace.
      betaEnded: ended ? { issuedAt: ended.issuedAt, expiresAt: ended.expiresAt, feedbackSubmitted: Boolean(ended.feedbackSubmittedAt), askForFeedback: !ended.feedbackSubmittedAt && !feedbackDismissed } : null };
  }
  const isBeta = (result) => result?.license_key?.license_type === 'private_beta';
  // Replace the activation with the ended record. The seat is not released here: the service
  // already refuses the expired licence, and the record must not be usable for operations.
  async function endBeta(from, { expiresAt, issuedAt }) {
    // instanceId and meta are kept only so an operator EXTENSION can be recognised on a later validation.
    ended = { schema: 1, betaEnded: true, key: from.key, instanceId: from.instanceId ?? null, meta: from.meta ?? null, licenseType: 'private_beta', issuedAt: issuedAt ?? from.issuedAt ?? null, expiresAt: expiresAt ?? from.expiresAt ?? null, endedAt: now(), feedbackSubmittedAt: null };
    record = null; reason = 'Your GRAFT private beta access has ended.';
    try { await store.write(ended); } catch { reason += ' (This could not be saved; GRAFT will check again next time.)'; }
  }
  const parseExpiry = (rawExpiry) => {
    const utcExpiry = typeof rawExpiry === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(rawExpiry) ? rawExpiry.replace(' ', 'T') + 'Z' : rawExpiry;
    return rawExpiry === null ? null : Date.parse(utcExpiry); // absent (undefined) is malformed, not perpetual
  };
  const expiredError = (result) => {
    const err = new LicenseRejected(isBeta(result) ? 'Your GRAFT private beta access has ended.' : 'This license has expired.');
    err.expired = true; err.privateBeta = isBeta(result);
    err.expiresAt = parseExpiry(result?.license_key?.expires_at); err.issuedAt = parseExpiry(result?.license_key?.issued_at ?? null);
    return err;
  };
  function verify(result, key, action, instanceId = null) {
    // An authoritative 'expired' verdict for OUR key is a distinct outcome, not a generic rejection.
    if (result?.license_key?.key === key && matches(result.meta) && result.license_key.status === 'expired') throw expiredError(result);
    if (result[action] !== true || result.error || !matches(result.meta) || result.license_key?.key !== key
      || !['active', ...(action === 'valid' && !instanceId ? ['inactive'] : [])].includes(result.license_key?.status)) {
      throw new LicenseRejected('This license is invalid, disabled, or belongs to another product.');
    }
    const expiry = parseExpiry(result.license_key.expires_at);
    if (expiry !== null && !Number.isFinite(expiry)) throw new LicenseRejected('This license has expired.');
    if (expiry !== null && expiry <= now()) throw expiredError(result);
    if ((action === 'activated' || instanceId) && (typeof result.instance?.id !== 'string' || !result.instance.id || (instanceId && result.instance.id !== instanceId))) {
      throw new LicenseRejected('The license activation instance does not match this installation.');
    }
    const licenseType = typeof result.license_key.license_type === 'string' ? result.license_key.license_type.slice(0, 32) : 'purchase';
    const issuedAt = parseExpiry(result.license_key.issued_at ?? null);
    return { expiry, licenseType, issuedAt: Number.isFinite(issuedAt) ? issuedAt : null, meta: { store_id: result.meta.store_id, product_id: result.meta.product_id, variant_id: result.meta.variant_id } };
  }
  // The installation identity: minted once per installation, persisted separately from the
  // activation record so it survives deactivation and revocation, and reused on every
  // activation so retries from this installation never consume another seat. It is random,
  // not a hardware fingerprint. A reinstall (or a wiped/corrupt identity) mints a new one,
  // which the backend treats as a distinct installation. A store that cannot be READ (e.g. a
  // locked Keychain) fails closed instead of minting: a transient error must not burn a seat.
  async function installationId() {
    let id = await store.readInstallation();
    if (typeof id === 'string' && INSTALLATION_ID.test(id)) return id;
    id = randomId();
    if (!INSTALLATION_ID.test(id)) throw new LicenseRejected('Could not create an installation identity.');
    await store.writeInstallation(id); // persisted BEFORE any seat is consumed, so a retry reuses it
    return id;
  }
  async function revoke(message) {
    record = null; reason = message;
    try { await store.clear(); } catch {
      try { await store.write({ schema: 1, revoked: true, revokedAt: now() }); }
      catch {
        // With no durable writes possible, only the current process can fail closed.
        reason += ' Revocation could not be saved. Restore storage access and validate online before restarting.';
      }
    }
  }
  async function validate() {
    if (!record) return status();
    try {
      const result = await provider.validate(record.key, record.instanceId);
      const checked = verify(result, record.key, 'valid', record.instanceId);
      // The service is the authority on the term: a fresh expiresAt (an extension) replaces the stored one.
      const next = { ...record, ...{ meta: checked.meta, expiresAt: checked.expiry, licenseType: checked.licenseType, issuedAt: checked.issuedAt ?? record.issuedAt ?? null }, verifiedAt: now(), lastSeenAt: now() };
      await store.write(next); record = next; reason = 'License validated.';
    } catch (err) {
      if (err instanceof LicenseUnavailable) {
        // Offline: a private beta whose authoritative expiry has passed ends now, grace or not.
        if (record?.licenseType === 'private_beta' && Number.isFinite(record.expiresAt) && now() >= record.expiresAt) { await endBeta(record, {}); return status(); }
        reason = usable() ? 'Using your cached license while the license service is unavailable.' : 'Connect to validate your license before continuing.';
        // Offline use never extends the last successful validation time.
        if (record) {
          record.lastSeenAt = Math.max(record.lastSeenAt, now());
          try { await store.write(record); } catch { record = null; reason = 'Secure license storage is unavailable. Restore access and validate online.'; }
        }
      } else if (err?.expired && (err.privateBeta || record?.licenseType === 'private_beta')) {
        await endBeta(record, { expiresAt: Number.isFinite(err.expiresAt) ? err.expiresAt : undefined, issuedAt: Number.isFinite(err.issuedAt) ? err.issuedAt : undefined });
      } else { await revoke(err instanceof LicenseRejected ? err.message : 'License storage could not be updated. Activate again.'); }
    }
    return status();
  }
  // An ended beta asks the service once per launch (and on demand) whether the operator extended the
  // term. Only an authoritative 'active' answer for the same key and activation restores the
  // activation; 'expired', unknown, revoked or unreachable all leave the beta ended.
  async function resumeIfExtended() {
    if (!ended || typeof ended.instanceId !== 'string' || !ended.instanceId) return status();
    let checked;
    try { checked = verify(await provider.validate(ended.key, ended.instanceId), ended.key, 'valid', ended.instanceId); }
    catch { return status(); }
    const next = { schema: 1, key: ended.key, instanceId: ended.instanceId, meta: checked.meta, expiresAt: checked.expiry, licenseType: checked.licenseType, issuedAt: checked.issuedAt ?? ended.issuedAt ?? null, verifiedAt: now(), lastSeenAt: now() };
    try { await store.write(next); } catch { return status(); }
    record = next; ended = null; feedbackDismissed = false; reason = 'License validated.';
    return status();
  }
  // End-of-beta feedback: only with an ended (or still active) private-beta licence, only through
  // the provider (server-side delivery to support), never touching entitlement.
  async function feedback(responses, client) {
    const key = ended?.key || (record?.licenseType === 'private_beta' ? record.key : null);
    if (!key) throw new LicenseRejected('Feedback is available to GRAFT private beta testers.');
    const result = await provider.feedback(key, { responses, client });
    if (result?.sent !== true) throw new LicenseUnavailable('Feedback could not be delivered right now. Your answers are kept; try again.');
    if (ended) {
      ended = { ...ended, feedbackSubmittedAt: now() };
      try { await store.write(ended); } catch { /* remembered for this process; asked again next launch */ }
    }
    try { await store.clearDraft?.(); } catch { /* best effort */ }
    return status();
  }
  return {
    status, canUse: usable,
    initialize: () => serialize(async () => {
      try { record = await store.read(); } catch { record = null; reason = 'Saved license could not be read. Unlock macOS Keychain or restore storage access, then reopen GRAFT.'; }
      if (record?.revoked === true) { record = null; reason = 'This activation was revoked. Activate a valid license to continue.'; }
      if (record?.betaEnded === true) { ended = record; record = null; reason = 'Your GRAFT private beta access has ended.'; return resumeIfExtended(); }
      return validate();
    }),
    validate: () => serialize(() => (ended ? resumeIfExtended() : validate())),
    feedback: (responses, client) => serialize(() => feedback(responses, client)),
    dismissFeedback: () => { feedbackDismissed = true; return status(); },
    readDraft: () => store.readDraft?.() ?? null,
    writeDraft: (draft) => store.writeDraft?.(draft),
    clearDraft: () => store.clearDraft?.(),
    activate: (key) => serialize(async () => {
      if (!configured) throw new LicenseRejected('GRAFT license product is not configured.');
      if (record) throw new LicenseRejected('Deactivate this installation before replacing its license.');
      if (typeof key !== 'string' || key.trim().length < 8 || key.length > 256) throw new LicenseRejected('Enter a valid license key.');
      key = key.trim();
      // Check product identity before consuming an activation slot.
      verify(await provider.validate(key, null), key, 'valid');
      // A new or extended licence supersedes the ended state (an expired key never gets this far).
      const previouslyEnded = ended;
      let installation;
      try { installation = await installationId(); } catch (cause) {
        throw new LicenseRejected('Activation could not be saved. Check macOS Keychain and available storage. No project files were changed.', { cause });
      }
      const result = await provider.activate(key, { installationId: installation, name: installationName });
      const checked = verify(result, key, 'activated');
      const next = { schema: 1, key, instanceId: result.instance.id, meta: checked.meta, expiresAt: checked.expiry, licenseType: checked.licenseType, issuedAt: checked.issuedAt, verifiedAt: now(), lastSeenAt: now() };
      try { await store.write(next); } catch (cause) {
        if (previouslyEnded) { try { await store.write(previouslyEnded); } catch { /* the ended state is re-derived on the next validation */ } }
        try { await provider.deactivate(key, next.instanceId); } catch { /* Customer can recover the unused slot through the vendor. */ }
        throw new LicenseRejected('Activation could not be saved. Check macOS Keychain and available storage. No project files were changed.', { cause });
      }
      record = next; ended = null; feedbackDismissed = false; reason = 'License activated.'; return status();
    }),
    deactivate: () => serialize(async () => {
      if (!record) return status();
      const response = await provider.deactivate(record.key, record.instanceId);
      if (response.deactivated !== true || response.error) throw new LicenseRejected('Deactivation was not confirmed. Your activation was retained; try again online.');
      await revoke('License deactivated on this computer.'); return status();
    }),
  };
}
