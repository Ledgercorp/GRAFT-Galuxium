// The desktop's client to the GRAFT licensing backend.
//
// It speaks the same activate/validate/deactivate contract the license service already
// expects, so the proven fail-closed state machine in license-service.js is reused
// unchanged. It carries no secret: the backend, not this client, holds the Stripe key
// and is the sole authority on whether a payment succeeded. A failed activation here can
// never fabricate a purchase — only a license the backend already issued can validate.
//
// Network, timeout, 5xx and 429 map to LicenseUnavailable (offline grace applies);
// any other rejection maps to LicenseRejected (fail closed).
//
// License keys travel in request bodies, so the endpoint must be HTTPS. Plain HTTP is
// accepted only for loopback and only when the caller opts in (test/development builds);
// a production build never opts in, so no configuration can downgrade it.

export class LicenseUnavailable extends Error {}
export class LicenseRejected extends Error {}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Resolve the license API base URL or explain why it is unusable. Returns { endpoint } or { error }.
export function resolveLicenseEndpoint(baseUrl, { allowInsecureLoopback = false } = {}) {
  if (baseUrl === undefined || baseUrl === null || baseUrl === '') return { error: 'The GRAFT license service is not configured in this build.' };
  let url;
  try { url = new URL(String(baseUrl)); } catch { return { error: 'The GRAFT license service URL is malformed.' }; }
  if (url.username || url.password) return { error: 'The GRAFT license service URL must not carry credentials.' };
  const secure = url.protocol === 'https:';
  const loopback = url.protocol === 'http:' && allowInsecureLoopback === true && LOOPBACK.has(url.hostname);
  if (!secure && !loopback) return { error: 'The GRAFT license service must use HTTPS.' };
  return { endpoint: url.toString().replace(/\/$/, '') };
}

export function graftLicenseProvider({ baseUrl, fetchImpl = fetch, timeoutMs = 10000, allowInsecureLoopback = false } = {}) {
  const { endpoint, error: configurationError } = resolveLicenseEndpoint(baseUrl, { allowInsecureLoopback });
  async function request(action, body) {
    // No usable backend means no license can be real: fail closed, not into offline grace.
    if (!endpoint) throw new LicenseRejected(configurationError);
    let response;
    try {
      response = await fetchImpl(`${endpoint}/licenses/${action}`, {
        method: 'POST',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw new LicenseUnavailable('License service unavailable. Check your connection and try again.'); }
    if (response.status >= 500 || response.status === 429) throw new LicenseUnavailable('License service is temporarily unavailable.');
    if (!response.ok) throw new LicenseRejected('The license service rejected this request. Check the key and activation limit.');
    // A transport failure while the body streams (timeout, socket reset) is an outage, not a
    // verdict: it must never wipe a cached activation. Only a COMPLETE body that is not JSON
    // is a rejection — over HTTPS that can only come from the license service itself.
    let text;
    try { text = await response.text(); } catch { throw new LicenseUnavailable('License service unavailable. Check your connection and try again.'); }
    let result;
    try { result = JSON.parse(text); } catch { throw new LicenseRejected('The license service returned an invalid response.'); }
    if (!result || typeof result !== 'object') throw new LicenseRejected('The license service returned an invalid response.');
    return result;
  }
  return {
    // The installation id is the seat identity; the name is descriptive only.
    activate: (key, { installationId, name } = {}) => request('activate', { license_key: key, installation_id: installationId, instance_name: name }),
    validate: (key, instanceId) => request('validate', { license_key: key, ...(instanceId ? { instance_id: instanceId } : {}) }),
    deactivate: (key, instanceId) => request('deactivate', { license_key: key, instance_id: instanceId }),
    // End-of-beta feedback: answers plus three client facts; the server addresses the email itself.
    feedback: (key, { responses, client }) => request('feedback', { license_key: key, responses, client }),
  };
}
