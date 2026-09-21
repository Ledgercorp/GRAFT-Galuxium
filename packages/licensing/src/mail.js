// Transactional licence-key email (Commercial Beta 0.1, Checkpoint B).
//
// Secondary delivery only. The licence is issued by the registry from canonical Stripe state and
// shown on the success page; this mails the same key to the address Stripe collected at checkout.
// A mail failure changes nothing about issuance or payment — it is recorded on the licence record
// (`delivery`) so support can see it and a later fulfilment (success-page visit, webhook replay)
// retries once. No queue, no second licence, no second charge.
//
// Transport: Resend's HTTP API (https://resend.com), dependency-free through fetch. Configured by
// RESEND_API_KEY (secret, environment only), GRAFT_MAIL_FROM and GRAFT_SUPPORT_EMAIL. Unconfigured
// means disabled: issuance proceeds, `delivery.status` says `not-configured`.
const KEY = /^GRAFT-(?:[A-Z2-9]{4}-){4}[A-Z2-9]{4}$/; // the registry's format: five groups of four, no I/O/0/1
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function licenseEmailContent({ key, downloadUrl, supportEmail }) {
  const subject = 'Your GRAFT licence key';
  const text = [
    'Thank you for buying GRAFT.',
    '',
    `Your licence key: ${key}`,
    '',
    `Download GRAFT (macOS, Apple Silicon): ${downloadUrl}`,
    '',
    'To activate: open GRAFT, paste the key on the licence page, and choose Activate. One key works on up to three computers; use "Deactivate this computer" in GRAFT before moving it.',
    '',
    `Questions or something not working? Reply to this email or write to ${supportEmail}. Include the diagnostic bundle GRAFT can save for you (About GRAFT → Save diagnostic bundle); it contains no secrets or source code.`,
    '',
    '— LeftSock Labs',
  ].join('\n');
  return { subject, text };
}

const longDate = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** Private Beta Program invitation: the operator-issued key, its expiry, the one-device rule, the download. */
export function privateBetaEmailContent({ key, expiresAt, downloadUrl, supportEmail }) {
  const subject = 'Your GRAFT private beta license';
  const text = [
    'You’re in the GRAFT private beta.',
    '',
    'Your license is valid for a limited time and can be activated on one Apple Silicon Mac.',
    '',
    `License key: ${key}`,
    `Expires: ${longDate(expiresAt)}`,
    '',
    `Download GRAFT (macOS, Apple Silicon): ${downloadUrl}`,
    '',
    'To activate: open the disk image, drag GRAFT into Applications, open GRAFT, paste the key on the license page, and choose Activate. On first launch macOS may say it cannot verify GRAFT: close that dialog, then open System Settings → Privacy & Security and choose Open Anyway, once.',
    '',
    'When your beta access ends, GRAFT will ask how it went. That feedback is what the beta is for.',
    '',
    `Questions or something not working? Reply to this email or write to ${supportEmail}.`,
    '',
    '— LeftSock Labs',
  ].join('\n');
  return { subject, text };
}

/** End-of-beta feedback, addressed to support only; the tester's address is the Reply-To. */
export function feedbackEmailContent({ rating, responses, tester, license, client }) {
  const subject = `GRAFT Private Beta Feedback — ${rating}/5`;
  const section = (label, value) => (value ? [label, value, ''] : []);
  const text = [
    `Overall experience: ${rating}/5`,
    `Would use GRAFT again: ${responses.wouldUseAgain}`,
    `Tester: ${tester || 'unknown'}`,
    `License: ${license.masked} · issued ${license.issuedAt || '?'} · expires ${license.expiresAt || '?'} · ${license.status}`,
    `GRAFT ${client.version || '?'} · ${client.os || '?'} ${client.arch || '?'}`,
    '',
    ...section('What they used GRAFT for:', responses.usedFor),
    ...section('What worked well:', responses.workedWell),
    ...section('What frustrated them or got in the way:', responses.frustrated),
    ...section('What would make GRAFT worth paying for:', responses.worthPaying),
    ...section('Expected feature that was missing:', responses.missingFeature),
    ...section('Anything else:', responses.anythingElse),
  ].join('\n');
  return { subject, text };
}

/** A mailer over Resend, or a disabled one when not configured. `fetchImpl` is injectable for tests. */
export function createLicenseMailer({ apiKey = null, from = null, supportEmail = null, downloadUrl = null, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const enabled = Boolean(apiKey && from && supportEmail && downloadUrl);
  async function post({ to, replyTo, subject, text }) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error('mail timeout')), timeoutMs);
    try {
      const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text }) });
      if (response.status < 200 || response.status >= 300) return { sent: false, status: 'failed', error: `mail provider returned HTTP ${response.status}` };
      let id = null; try { id = (await response.json())?.id || null; } catch { id = null; }
      return { sent: true, status: 'sent', error: null, providerId: id };
    } catch (err) {
      return { sent: false, status: 'failed', error: `mail provider unreachable (${err?.name || 'error'})` };
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    enabled,
    supportEmail,
    async send({ to, key }) {
      if (!enabled) return { sent: false, status: 'not-configured', error: null };
      if (!EMAIL.test(String(to || ''))) return { sent: false, status: 'no-address', error: 'no valid customer email' };
      if (!KEY.test(String(key || ''))) return { sent: false, status: 'failed', error: 'refusing to mail a malformed key' };
      const { subject, text } = licenseEmailContent({ key, downloadUrl, supportEmail });
      return post({ to, replyTo: supportEmail, subject, text });
    },
    async sendPrivateBeta({ to, key, expiresAt }) {
      if (!enabled) return { sent: false, status: 'not-configured', error: null };
      if (!EMAIL.test(String(to || ''))) return { sent: false, status: 'no-address', error: 'no valid tester email' };
      if (!KEY.test(String(key || ''))) return { sent: false, status: 'failed', error: 'refusing to mail a malformed key' };
      if (!Number.isFinite(Date.parse(expiresAt))) return { sent: false, status: 'failed', error: 'refusing to mail a license without an expiry' };
      const { subject, text } = privateBetaEmailContent({ key, expiresAt, downloadUrl, supportEmail });
      return post({ to, replyTo: supportEmail, subject, text });
    },
    /** Always to support; Reply-To is the tester address the server holds (never the caller's choice). */
    async sendFeedback({ replyTo, rating, responses, tester, license, client }) {
      if (!enabled) return { sent: false, status: 'not-configured', error: null };
      const { subject, text } = feedbackEmailContent({ rating, responses, tester, license, client });
      return post({ to: supportEmail, replyTo: EMAIL.test(String(replyTo || '')) ? replyTo : supportEmail, subject, text });
    },
  });
}
