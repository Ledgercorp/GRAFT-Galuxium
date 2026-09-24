// The GRAFT licensing HTTP service.
//
// Browser leg (customer):   GET  /buy            -> create a Checkout Session, redirect to Stripe
//                           GET  /success        -> confirm payment server-side, reveal key + download
//                           GET  /cancel         -> canceled page
// Stripe leg (server truth): POST /webhook        -> signature-verified issuance / revocation
// Desktop leg (client):     POST /licenses/activate|validate|deactivate
//                           POST /licenses/feedback  -> end-of-beta feedback, relayed to support only
// Operator leg (server-to-server): POST /internal/private-beta/issue -> bearer GRAFT_BETA_APPROVAL_TOKEN; issue + invite
//                           GET  /download        -> entitlement check, redirect to the artifact
//
// The stripe client and license registry are injected so the whole surface is testable
// offline with a fake Stripe and an in-memory store — no credentials, no network.

import http from 'node:http';
import crypto from 'node:crypto';
import { verifyWebhookSignature, SignatureError, StripeError } from './stripe.js';
import { LicenseError, isValidInstallationId, maskKey, normalizeEmail } from './licenses.js';
import { issueAndInvite } from './private-beta.js';
import { DEFAULT_PRICE_USD_CENTS, MANAGED_PAYMENTS_SOFTWARE_TAX_CODES } from './catalog.js';
import { successPage, pendingPage, reviewPage, unavailablePage, cancelPage, errorPage } from './pages.js';
import { isLoopback } from './config.js';

const MAX_BODY = 1 << 20; // 1 MiB

// End-of-beta feedback: the fields the desktop form collects, their limits, and the shape rules.
// Everything else in the body is ignored; nothing here can address an email or pick a recipient.
export const FEEDBACK_TEXT_LIMIT = 2000;
export const FEEDBACK_REQUIRED = ['usedFor', 'workedWell', 'frustrated'];
export const FEEDBACK_OPTIONAL = ['worthPaying', 'missingFeature', 'anythingElse'];
export const FEEDBACK_AGAIN = new Set(['yes', 'maybe', 'no']);
// Control characters other than newline/tab are dropped; text is trimmed and bounded.
const cleanText = (value) => String(value).replace(/[^\P{Cc}\n\t]/gu, '').trim();
export function parseFeedback(body) {
  const responses = body?.responses;
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) throw new HttpError(400, 'Missing "responses".');
  const rating = responses.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Rating must be a whole number from 1 to 5.');
  if (!FEEDBACK_AGAIN.has(responses.wouldUseAgain)) throw new HttpError(400, 'Answer whether you would use GRAFT again: yes, maybe or no.');
  const out = { rating, wouldUseAgain: responses.wouldUseAgain };
  for (const name of FEEDBACK_REQUIRED.concat(FEEDBACK_OPTIONAL)) {
    const raw = responses[name];
    if (raw === undefined || raw === null || raw === '') { if (FEEDBACK_REQUIRED.includes(name)) throw new HttpError(400, `"${name}" is required.`); continue; }
    if (typeof raw !== 'string') throw new HttpError(400, `"${name}" must be text.`);
    const text = cleanText(raw);
    if (!text.length && FEEDBACK_REQUIRED.includes(name)) throw new HttpError(400, `"${name}" is required.`);
    if (text.length > FEEDBACK_TEXT_LIMIT) throw new HttpError(400, `"${name}" is longer than ${FEEDBACK_TEXT_LIMIT} characters.`);
    if (text.length) out[name] = text;
  }
  // Safe product metadata only: short identifiers, never paths, logs or environment.
  const client = {};
  for (const name of ['version', 'os', 'arch']) {
    const raw = body?.client?.[name];
    if (typeof raw === 'string' && raw.length) client[name] = cleanText(raw).replace(/[^A-Za-z0-9 ._+()-]/g, '').slice(0, 64);
  }
  return { responses: out, client };
}
/** Sliding-window counter keyed by an arbitrary string; refuses beyond `limit` hits per `windowMs`. */
export function createRateLimiter({ limit, windowMs, now = Date.now, maxKeys = 10000 }) {
  const hits = new Map();
  return {
    take(key) {
      const at = now();
      const kept = (hits.get(key) || []).filter((t) => at - t < windowMs);
      if (kept.length >= limit) { hits.set(key, kept); return false; }
      kept.push(at); hits.set(key, kept);
      if (hits.size > maxKeys) { for (const [k, v] of hits) { if (!v.some((t) => at - t < windowMs)) hits.delete(k); if (hits.size <= maxKeys) break; } }
      return true;
    },
  };
}

// Dispute statuses that end a dispute in the merchant's favour (docs.stripe.com/api/disputes/object).
const DISPUTE_RESTORING = new Set(['won', 'warning_closed', 'prevented']);

const paymentIntentOf = (object) => (typeof object?.payment_intent === 'string' ? object.payment_intent : (typeof object?.payment_intent?.id === 'string' ? object.payment_intent.id : null));
const stripeIdOf = (object) => (typeof object === 'string' ? object : (typeof object?.id === 'string' ? object.id : null));

// Charge.refunded is true only when the charge is FULLY refunded; a partial refund leaves it
// false with amount_refunded < amount (docs.stripe.com/api/charges/object). Returns true for a
// full refund, false for a partial one, and null when the payload carries neither signal.
export function isFullRefund(charge) {
  if (charge?.refunded === true) return true;
  const { amount, amount_refunded: refunded } = charge || {};
  if (Number.isSafeInteger(amount) && Number.isSafeInteger(refunded) && amount > 0) return refunded >= amount;
  if (charge?.refunded === false) return false;
  return null;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readRaw(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createLicensingServer({ config, stripe, registry, mailer = null, now = Date.now, feedbackLimits = { perKey: { limit: 3, windowMs: 3600000 }, perAddress: { limit: 20, windowMs: 3600000 } } }) {
  const feedbackByKey = createRateLimiter({ ...feedbackLimits.perKey, now });
  const feedbackByAddress = createRateLimiter({ ...feedbackLimits.perAddress, now });
  const approvalByAddress = createRateLimiter({ limit: 60, windowMs: 3600000, now });
  // Constant-time bearer check against the dedicated approval credential.
  const approvalAuthorized = (req) => {
    const expected = config.betaApprovalToken;
    if (typeof expected !== 'string' || expected.length < 32) return false;
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7)); const want = Buffer.from(expected);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };
  // Secondary delivery: mail the issued key to the checkout address, once, and record the outcome
  // on the licence. Never part of issuance; a failure is recorded for support and retried by the
  // next fulfilment of the same session (success-page visit or webhook replay).
  async function deliver(record) {
    if (!mailer || !record || record.delivery?.status === 'sent') return record;
    const outcome = await mailer.send({ to: record.customerEmail, key: record.key });
    try { return await registry.recordDelivery(record.key, outcome); } catch { return record; }
  }
  const securityHeaders = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  function sendJson(res, status, value) {
    res.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  }
  function sendHtml(res, status, html) {
    res.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  function redirect(res, location) {
    res.writeHead(303, { ...securityHeaders, Location: location });
    res.end();
  }

  async function readJson(req) {
    if (req.headers['content-type'] !== 'application/json') throw new HttpError(415, 'Expected application/json.');
    const raw = await readRaw(req);
    try { return JSON.parse(raw.toString('utf8') || '{}'); }
    catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  const field = (body, name) => {
    const value = body?.[name];
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new HttpError(400, `Missing or invalid "${name}".`);
    return value;
  };

  // A paid session that cannot be issued safely. This must not happen; when it does, the
  // purchase is preserved for manual triage rather than lost. Logged without PII.
  async function quarantine(session, { eventId = null, type, reason }) {
    const entry = await registry.deadLetter({ sessionId: session.id, eventId, type, reason });
    console.error(`GRAFT licensing: INVARIANT BREACH ${type} session=${session.id}${eventId ? ` event=${eventId}` : ''}: ${reason}. Dead-lettered for manual review (seen ${entry.count}x). No license was issued.`);
    return entry;
  }

  // Issue for a PAID session, or dead-letter it if the payment intent is missing. Returns
  // { record } when issued, { quarantined } when preserved for review. Idempotent either way.
  async function issuePaidSession(session, { eventId = null, type }) {
    const existing = await registry.getBySession(session.id);
    if (existing) return { record: existing }; // already issued: a stale replay changes nothing
    const paymentIntent = paymentIntentOf(session);
    if (!paymentIntent) return { quarantined: await quarantine(session, { eventId, type, reason: 'paid session carried no payment_intent' }) };
    const email = session.customer_details?.email || session.customer_email || null;
    try { return { record: await registry.issue({ sessionId: session.id, paymentIntent, customerEmail: email }) }; }
    catch (err) {
      if (err instanceof LicenseError) return { quarantined: await quarantine(session, { eventId, type, reason: err.message }) };
      throw err;
    }
  }

  // Canonical Stripe state is the single entitlement authority for both /success and
  // webhooks. A signed event proves its source, not that its Checkout purchased GRAFT.
  async function verifyGraftPurchase(sessionId) {
    const rejected = (reason) => ({ verified: false, reason });
    if (typeof sessionId !== 'string' || !sessionId) return rejected('missing session id');

    // Both objects are retrieved server-side. Provider uncertainty throws and never issues;
    // a deterministic contract mismatch is acknowledged as a non-GRAFT purchase.
    const [session, expectedPrice] = await Promise.all([
      stripe.retrieveSession(sessionId),
      stripe.retrievePrice(config.priceId),
    ]);
    if (!session || session.id !== sessionId) return rejected('session identity mismatch');
    if (session.payment_status !== 'paid') return { verified: false, pending: true, reason: 'session is not paid' };
    if (session.mode !== 'payment') return rejected('session mode is not payment');
    if (session.currency !== 'usd') return rejected('session currency is not usd');

    const lines = session.line_items?.data;
    if (!Array.isArray(lines) || lines.length !== 1 || session.line_items?.has_more === true) return rejected('session does not contain exactly one line item');
    const line = lines[0];
    const linePrice = line?.price;
    if (line?.quantity !== 1) return rejected('line item quantity is not one');
    if (stripeIdOf(linePrice) !== config.priceId || expectedPrice?.id !== config.priceId) return rejected('line item does not use the configured price');

    const expectedProductId = stripeIdOf(expectedPrice.product);
    if (!expectedProductId || stripeIdOf(linePrice?.product) !== expectedProductId) return rejected('line item product does not match the configured price product');
    const expectedProduct = await stripe.retrieveProduct(expectedProductId);
    if (expectedProduct?.id !== expectedProductId || expectedProduct.name !== 'GRAFT' || expectedProduct.metadata?.graft !== 'desktop-onetime') return rejected('configured price is not attached to the GRAFT Product');
    if (!Object.hasOwn(MANAGED_PAYMENTS_SOFTWARE_TAX_CODES, expectedProduct.tax_code)) return rejected('GRAFT Product tax code is not eligible');
    if (expectedPrice.type !== 'one_time' || expectedPrice.recurring) return rejected('configured price is not one-time');
    if (linePrice?.type !== 'one_time' || linePrice?.recurring) return rejected('line item price is not one-time');
    if (expectedPrice.currency !== 'usd' || linePrice?.currency !== 'usd') return rejected('price currency is not usd');
    if (expectedPrice.unit_amount !== DEFAULT_PRICE_USD_CENTS || linePrice?.unit_amount !== DEFAULT_PRICE_USD_CENTS) return rejected('price is not the GRAFT launch price');
    if (line.amount_subtotal !== DEFAULT_PRICE_USD_CENTS || session.amount_subtotal !== DEFAULT_PRICE_USD_CENTS) return rejected('pre-tax subtotal is not the GRAFT launch price');
    return { verified: true, session, price: expectedPrice, productId: expectedProductId };
  }

  // Establish the exact GRAFT purchase server-side and issue idempotently.
  async function fulfillSession(sessionId, evidence) {
    const existing = await registry.getBySession(sessionId);
    if (existing) return { record: await deliver(existing) };
    const purchase = await verifyGraftPurchase(sessionId);
    if (!purchase.verified) return purchase.pending ? { pending: true } : { rejected: true };
    const issued = await issuePaidSession(purchase.session, evidence);
    return issued.record ? { record: await deliver(issued.record) } : issued;
  }

  async function route(req, res, url) {
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      // Dead-lettered purchases make the service report unhealthy so monitoring cannot miss them.
      const quarantined = (await registry.deadLetters()).length;
      return sendJson(res, quarantined ? 503 : 200, { service: 'graft-licensing', merchantOfRecord: config.merchantOfRecord, mode: config.mode, ok: quarantined === 0, deadLetters: quarantined });
    }

    if (req.method === 'GET' && path === '/buy') {
      if (!config.priceId) throw new HttpError(503, 'Purchasing is not configured.');
      // A configured Stripe Payment Link creates the Checkout Session on Stripe's side; its
      // completed session reaches /success and /webhook exactly like a server-created one and
      // is verified the same way before any licence is issued.
      if (config.paymentLinkUrl) return redirect(res, config.paymentLinkUrl);
      // Belt and braces with config.js: a live session must never carry loopback return URLs.
      if (config.mode === 'live' && (!config.publicUrl || isLoopback(config.publicUrl))) throw new HttpError(503, 'Purchasing is not configured for live mode.');
      const session = await stripe.createCheckoutSession({
        priceId: config.priceId,
        successUrl: `${config.publicUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${config.publicUrl}/cancel`,
        clientReferenceId: `graft-${now()}`,
      });
      if (!session?.url) throw new HttpError(502, 'Stripe did not return a checkout URL.');
      return redirect(res, session.url);
    }

    if (req.method === 'GET' && path === '/success') {
      const sessionId = url.searchParams.get('session_id');
      if (!sessionId) return sendHtml(res, 400, errorPage('Missing checkout session.'));
      let outcome;
      try { outcome = await fulfillSession(sessionId, { type: 'success-page' }); }
      catch { return sendHtml(res, 502, errorPage('We could not confirm your payment with Stripe. Your license is safe; refresh shortly.')); }
      if (outcome.rejected) return sendHtml(res, 200, errorPage('We could not confirm this GRAFT purchase.'));
      if (outcome.pending) return sendHtml(res, 200, pendingPage());
      if (outcome.quarantined) return sendHtml(res, 200, reviewPage(sessionId));
      if (!outcome.record) return sendHtml(res, 200, pendingPage());
      // A license born (or since) revoked/suspended is never handed out as usable.
      if (outcome.record.status !== 'active') return sendHtml(res, 200, unavailablePage(outcome.record.status, sessionId));
      return sendHtml(res, 200, successPage({ key: outcome.record.key, downloadUrl: config.downloadUrl }));
    }

    if (req.method === 'GET' && path === '/cancel') return sendHtml(res, 200, cancelPage());

    if (path === '/webhook') {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      const raw = await readRaw(req);
      let event;
      try {
        event = verifyWebhookSignature(raw, req.headers['stripe-signature'], config.webhookSecret, { toleranceSec: config.signatureToleranceSec, now });
      } catch (err) {
        if (err instanceof SignatureError) throw new HttpError(400, `Webhook signature error: ${err.message}`);
        throw err;
      }
      // Acknowledged means durably handled: issued, state changed, audited, or dead-lettered.
      // Stripe retries only non-2xx; an invariant breach is preserved, not retried forever.
      const outcome = await handleEvent(event);
      return sendJson(res, 200, outcome?.quarantined ? { received: true, quarantined: true, reference: outcome.quarantined.sessionId } : { received: true });
    }

    if (req.method === 'POST' && path === '/licenses/activate') {
      const body = await readJson(req);
      // Seats are keyed by the client's persistent installation id; the name is descriptive only.
      const installationId = field(body, 'installation_id');
      if (!isValidInstallationId(installationId)) throw new HttpError(400, 'Missing or invalid "installation_id".');
      const instanceName = typeof body.instance_name === 'string' ? body.instance_name.slice(0, 128) : 'GRAFT desktop';
      return sendJson(res, 200, await registry.activate(field(body, 'license_key'), { installationId, instanceName }));
    }
    if (req.method === 'POST' && path === '/licenses/validate') {
      const body = await readJson(req);
      const instanceId = typeof body.instance_id === 'string' && body.instance_id ? body.instance_id : null;
      return sendJson(res, 200, await registry.validate(field(body, 'license_key'), instanceId));
    }
    if (req.method === 'POST' && path === '/licenses/deactivate') {
      const body = await readJson(req);
      return sendJson(res, 200, await registry.deactivate(field(body, 'license_key'), field(body, 'instance_id')));
    }

    // Website approval → licence. The website resolves the tester's address from ITS stored
    // application; this route accepts only that address (normalised) and an audit reference, and
    // applies the program's fixed terms (30 days, one seat). The full key never leaves this service.
    if (req.method === 'POST' && path === '/internal/private-beta/issue') {
      if (!config.betaApprovalToken) throw new HttpError(503, 'Private-beta approval is not configured on this service.');
      const address = (typeof req.headers['fly-client-ip'] === 'string' && req.headers['fly-client-ip']) || req.socket?.remoteAddress || 'unknown';
      if (!approvalByAddress.take(address)) throw new HttpError(429, 'Too many approval requests; try again later.');
      if (!approvalAuthorized(req)) throw new HttpError(401, 'Unauthorized.');
      const body = await readJson(req);
      let email;
      try { email = normalizeEmail(field(body, 'email')); } catch (err) { throw new HttpError(400, err.message); }
      const reference = typeof body.reference === 'string' ? body.reference.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80) : null;
      if (!mailer || !mailer.enabled) throw new HttpError(503, 'Invitation email is not configured on this service; no license was issued.');
      const result = await issueAndInvite({ registry, mailer, email, reference, now });
      const { key, ...safe } = result; // never returned; ok=false with issued=true means the licence exists but the invitation failed
      return sendJson(res, 200, safe);
    }

    // End-of-beta feedback. Accepted only for a recognised private-beta licence (active or
    // expired — the beta having ended is the normal case; revoked is refused). Delivered by the
    // server to the fixed support address with the tester's own address as Reply-To. The desktop
    // sends answers and three short client facts; it cannot name a recipient or attach anything.
    if (req.method === 'POST' && path === '/licenses/feedback') {
      const body = await readJson(req);
      const key = field(body, 'license_key');
      // Behind Fly's proxy the socket peer is the proxy; Fly-Client-IP carries the real client.
      const address = (typeof req.headers['fly-client-ip'] === 'string' && req.headers['fly-client-ip']) || req.socket?.remoteAddress || 'unknown';
      if (!feedbackByAddress.take(address)) throw new HttpError(429, 'Too many feedback submissions; try again later.');
      const record = await registry.findPrivateBeta({ key });
      if (!record) throw new HttpError(403, 'Feedback is accepted from GRAFT private beta licenses only.');
      if (record.status !== 'active') throw new HttpError(403, 'This private beta license is no longer recognised.');
      const { responses, client } = parseFeedback(body);
      // Well-formed submissions are what cost an email: those are limited per licence.
      if (!feedbackByKey.take(key)) throw new HttpError(429, 'Too many feedback submissions for this license; try again later.');
      if (!mailer || !mailer.enabled) throw new HttpError(503, 'Feedback delivery is not configured; write to support instead.');
      const license = { masked: maskKey(record.key), issuedAt: record.issuedAt || null, expiresAt: record.expiresAt || null, status: typeof record.expiresAt === 'string' && now() >= Date.parse(record.expiresAt) ? 'expired' : 'active' };
      const outcome = await mailer.sendFeedback({ replyTo: record.customerEmail, rating: responses.rating, responses, tester: record.customerEmail, license, client });
      if (!outcome.sent) throw new HttpError(502, 'Feedback could not be delivered right now; your answers were not lost — try again.');
      try { await registry.recordFeedback(record.key, { rating: responses.rating, providerId: outcome.providerId || null }); } catch { /* delivery succeeded; the counter is advisory */ }
      return sendJson(res, 200, { sent: true });
    }

    // Download entitlement: a valid, active, activated license redirects to the artifact.
    if (req.method === 'GET' && path === '/download') {
      const key = url.searchParams.get('key');
      const instanceId = url.searchParams.get('instance');
      if (!key || !instanceId) throw new HttpError(400, 'A license key and activation are required to download.');
      const result = await registry.validate(key, instanceId).catch(() => ({ valid: false }));
      if (!result.valid) throw new HttpError(403, 'This license is not entitled to download GRAFT.');
      if (!config.downloadUrl) throw new HttpError(503, 'No download is configured.');
      return redirect(res, config.downloadUrl);
    }

    throw new HttpError(404, 'Not found.');
  }

  // Dispute lifecycle (docs.stripe.com/api/events/types, /api/disputes/object):
  //   created/updated                 -> suspend (an open dispute or inquiry withholds entitlement)
  //   funds_withdrawn, closed:lost    -> revoke (fail closed)
  //   funds_reinstated, closed:won|warning_closed|prevented -> restore, only if this dispute caused the current state
  async function applyDispute(type, dispute, paymentIntent, disputeId) {
    const status = typeof dispute.status === 'string' ? dispute.status : 'unknown';
    if (type === 'charge.dispute.funds_withdrawn') return registry.loseByPaymentIntent(paymentIntent, type, { disputeId, outcome: status === 'lost' ? 'lost' : 'open' });
    if (type === 'charge.dispute.funds_reinstated') return registry.restoreByPaymentIntent(paymentIntent, type, { disputeId, outcome: DISPUTE_RESTORING.has(status) ? status : 'won' });
    if (type === 'charge.dispute.closed') {
      if (status === 'lost') return registry.loseByPaymentIntent(paymentIntent, `${type}:lost`, { disputeId, outcome: 'lost' });
      if (DISPUTE_RESTORING.has(status)) return registry.restoreByPaymentIntent(paymentIntent, `${type}:${status}`, { disputeId, outcome: status });
      // A 'closed' with an unexpected status: stay suspended (fail closed) and record it.
      return registry.suspendByPaymentIntent(paymentIntent, `${type}:${status}`, { disputeId });
    }
    // created / updated: a dispute already lost stays revoked, one already won cannot re-suspend.
    if (status === 'lost') return registry.loseByPaymentIntent(paymentIntent, `${type}:lost`, { disputeId, outcome: 'lost' });
    if (DISPUTE_RESTORING.has(status)) return registry.restoreByPaymentIntent(paymentIntent, `${type}:${status}`, { disputeId, outcome: status });
    return registry.suspendByPaymentIntent(paymentIntent, `${type}:${status}`, { disputeId });
  }

  async function handleEvent(event) {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        return fulfillSession(session?.id, { eventId: event.id, type: event.type });
      }
      case 'charge.refunded': {
        // Stripe sends charge.refunded for partial refunds too; only a full refund ends
        // entitlement. An unreadable payload fails closed rather than leaving a fully
        // refunded license usable.
        const charge = event.data.object;
        const paymentIntent = paymentIntentOf(charge);
        if (!paymentIntent) { console.error(`GRAFT licensing: ${event.type} ${event.id} carried no payment_intent; no license was revoked. Investigate manually.`); return; }
        const full = isFullRefund(charge);
        if (full === false) { await registry.annotateByPaymentIntent(paymentIntent, event.type, `partial refund ${charge.amount_refunded}/${charge.amount}; entitlement retained`); return; }
        await registry.revokeByPaymentIntent(paymentIntent, full === null ? `${event.type} (ambiguous payload, failed closed)` : event.type);
        return;
      }
      case 'charge.dispute.created':
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
      case 'charge.dispute.funds_withdrawn':
      case 'charge.dispute.funds_reinstated': {
        const dispute = event.data.object;
        const paymentIntent = paymentIntentOf(dispute);
        const disputeId = typeof dispute?.id === 'string' ? dispute.id : null;
        if (!paymentIntent || !disputeId) { console.error(`GRAFT licensing: ${event.type} ${event.id} lacked payment_intent or dispute id; no license state changed. Investigate manually.`); return; }
        await applyDispute(event.type, dispute, paymentIntent, disputeId);
        return;
      }
      default:
        return; // Unhandled event types are acknowledged without action.
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Parse base only; a null publicUrl (live mode, unset) is refused by the routes that would use it.
      const url = new URL(req.url, config.publicUrl || 'http://127.0.0.1');
      await route(req, res, url);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof StripeError) return sendJson(res, 502, { error: 'Payment provider error.' });
      if (err instanceof LicenseError) return sendJson(res, 404, { error: err.message });
      return sendJson(res, 500, { error: 'Internal error.' });
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  return { server, fulfillSession, handleEvent };
}
