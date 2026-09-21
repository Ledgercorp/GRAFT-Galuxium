// Provider adapters: bring-your-own model, behind one GRAFT-native interface.
//
// A provider's only job is to turn a prompt into text. It never sees GRAFT's authority
// surface, never receives raw source unless an explicit grant produced an excerpt upstream,
// and its answer is projected onto a task schema before anyone can read it.
//
// Credentials come from the caller at request time and are never stored here, never logged,
// and never included in an error message.
export const PROVIDER_VERSION = '1.0.0';

const HTTPS_ONLY = 'A provider endpoint must be HTTPS, or explicit loopback for a local model.';

/** Accept https:// anywhere, and http:// only on loopback (a local model server). */
export function validateEndpoint(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Invalid provider endpoint: ${String(url).slice(0, 80)}`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new Error(HTTPS_ONLY);
  if (parsed.username || parsed.password) throw new Error('A provider endpoint must not carry credentials in its URL.');
  return parsed;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

async function readBounded(response) {
  const chunks = [];
  let size = 0;
  if (!response.body) return '';
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error('The provider response was too large to process.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function post(url, { headers, body, timeoutMs, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const response = await doFetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await readBounded(response);
  if (!response.ok) {
    // The provider's own error body may echo the request; never surface it verbatim.
    throw Object.assign(new Error(`The model provider rejected the request (HTTP ${response.status}).`), { code: 'provider-rejected', status: response.status });
  }
  try { return JSON.parse(text); } catch { throw new Error('The model provider returned a response that was not JSON.'); }
}

/** Extract the first JSON object from a model's text answer. Models add prose; that is fine. */
export function extractJson(text) {
  const trimmed = String(text || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The model did not return a JSON object.');
  try { return JSON.parse(candidate.slice(start, end + 1)); }
  catch (err) { throw new Error(`The model returned malformed JSON (${err.message}).`); }
}

/**
 * Adapters. Each exposes { id, defaultModel, complete({ prompt, apiKey, model, endpoint }) }
 * and returns raw text. Shapes differ; the runtime above them does not.
 */
export const ADAPTERS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-5',
    keyHint: 'An Anthropic API key (sk-ant-…).',
    async complete({ prompt, apiKey, model, endpoint, timeoutMs = 30000, maxTokens = 2048, fetchImpl }) {
      const url = validateEndpoint(endpoint || this.defaultEndpoint);
      const data = await post(url, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model: model || this.defaultModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
        timeoutMs, fetchImpl,
      });
      const text = (data?.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
      if (!text) throw new Error('The Anthropic response contained no text.');
      return { text, usage: data?.usage ? { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens } : null, model: data?.model || model || this.defaultModel };
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'An OpenAI API key (sk-…).',
    async complete({ prompt, apiKey, model, endpoint, timeoutMs = 30000, maxTokens = 2048, fetchImpl }) {
      const url = validateEndpoint(endpoint || this.defaultEndpoint);
      const data = await post(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model: model || this.defaultModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } },
        timeoutMs, fetchImpl,
      });
      const text = data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('The OpenAI response contained no message content.');
      return { text, usage: data?.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : null, model: data?.model || model || this.defaultModel };
    },
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    defaultEndpoint: null,
    defaultModel: null,
    keyHint: 'Whatever key the endpoint expects; local model servers often need none.',
    requiresEndpoint: true,
    async complete({ prompt, apiKey, model, endpoint, timeoutMs = 30000, maxTokens = 2048, fetchImpl }) {
      if (!endpoint) throw new Error('An OpenAI-compatible provider needs an explicit endpoint URL.');
      const url = validateEndpoint(endpoint);
      const data = await post(url, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: { model: model || 'local-model', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
        timeoutMs, fetchImpl,
      });
      const text = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
      if (!text) throw new Error('The endpoint returned no message content.');
      return { text, usage: data?.usage ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } : null, model: data?.model || model || 'local-model' };
    },
  },
});

export const PROVIDER_IDS = Object.freeze(Object.keys(ADAPTERS));

export function adapterFor(providerId) {
  const adapter = ADAPTERS[providerId];
  if (!adapter) throw new Error(`Unknown agent provider "${providerId}". Available: ${PROVIDER_IDS.join(', ')}.`);
  return adapter;
}
