// Minimal server-rendered pages for the browser leg of the purchase. No client scripts,
// no external assets, everything escaped. The success page is the customer's handoff:
// it shows the license key to paste into GRAFT and the download link.

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Entity-escaping does not neutralise a javascript:/data: scheme, so an href is rendered only
// for an http(s) URL. Config already refuses other schemes; this is the last line of defence.
export function safeHref(value) {
  try { const parsed = new URL(String(value)); return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null; }
  catch { return null; }
}

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f7f4;color:#12261a;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{max-width:34rem;margin:2rem;padding:2rem;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.08)}
h1{margin:0 0 .25rem;font-size:1.6rem}
.tag{display:inline-block;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:#3a5a42;background:#e8f5e2;padding:.2rem .5rem;border-radius:999px;margin-bottom:1rem}
.key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.15rem;font-weight:600;background:#f0f4ee;border:1px solid #d5e3cf;border-radius:10px;padding:.85rem 1rem;user-select:all;word-break:break-all}
.btn{display:inline-block;margin-top:1.25rem;padding:.7rem 1.2rem;background:#12261a;color:#d8f24f;text-decoration:none;border-radius:10px;font-weight:600}
.fine{color:#5a6b5f;font-size:.85rem;margin-top:1.5rem}
@media(prefers-color-scheme:dark){body{background:#0e130f;color:#e7efe6}main{background:#161d17;box-shadow:none}.key{background:#0e130f;border-color:#2a382b}.fine{color:#9fb2a4}}
</style></head><body><main>${body}</main></body></html>`;

export function successPage({ key, downloadUrl }) {
  return shell('GRAFT — Purchase complete', `
    <span class="tag">Payment complete · Stripe is Merchant of Record</span>
    <h1>Thank you for buying GRAFT.</h1>
    <p>Your license key — copy it, then paste it into GRAFT to activate:</p>
    <div class="key">${escape(key)}</div>
    ${safeHref(downloadUrl) ? `<a class="btn" href="${escape(safeHref(downloadUrl))}">Download GRAFT for macOS</a>` : ''}
    <p class="fine">Keep this key. You can activate GRAFT on up to a few of your own Macs. A confirmed refund disables the license. Tax, where applicable, was handled by Stripe as the merchant of record.</p>
  `);
}

export function pendingPage() {
  return shell('GRAFT — Confirming your payment', `
    <span class="tag">Confirming payment</span>
    <h1>Almost there.</h1>
    <p>We are confirming your payment with Stripe. Refresh this page in a few seconds to see your license key. It has also been recorded against your purchase.</p>
  `);
}

// A paid session Stripe reported without the data needed to issue safely: the purchase is
// preserved for manual review and the customer gets a reference, never a silent dead end.
export function reviewPage(reference) {
  return shell('GRAFT — Purchase under review', `
    <span class="tag">Payment received · manual review</span>
    <h1>Your payment went through.</h1>
    <p>Stripe confirmed the payment, but we could not issue your license automatically. It has been recorded for manual review and you will receive your key by email.</p>
    <p>Reference: <span class="key">${escape(reference)}</span></p>
    <p class="fine">Quote this reference if you contact support. No second charge will be made.</p>
  `);
}

// The purchase exists but its entitlement is withheld (refunded, reversed, or disputed).
// Neither the key nor the download is shown.
export function unavailablePage(status, reference) {
  const suspended = status === 'suspended';
  return shell(suspended ? 'GRAFT — Purchase under dispute' : 'GRAFT — License not active', `
    <span class="tag">${suspended ? 'Payment under dispute' : 'License not active'}</span>
    <h1>${suspended ? 'This purchase is on hold.' : 'This license is not active.'}</h1>
    <p>${suspended ? 'A payment dispute or bank inquiry is open on this purchase. The license is withheld until it is resolved.' : 'This purchase was refunded or its payment was reversed, so the license was disabled.'}</p>
    <p>Reference: <span class="key">${escape(reference)}</span></p>
    <p class="fine">Quote this reference if you contact support.</p>
  `);
}

export function cancelPage() {
  return shell('GRAFT — Checkout canceled', `
    <span class="tag">Checkout canceled</span>
    <h1>No charge was made.</h1>
    <p>Your checkout was canceled and you were not charged. You can start again from GRAFT whenever you are ready.</p>
  `);
}

export function errorPage(message) {
  return shell('GRAFT — Something went wrong', `
    <span class="tag">Error</span>
    <h1>We could not complete that.</h1>
    <p>${escape(message)}</p>
  `);
}
