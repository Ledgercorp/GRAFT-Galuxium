// Agent configuration — bring your own provider, keep your own key.
//
// What is stored: which provider, which model, which endpoint, which scopes were granted.
// What is never stored here: the API key. The key is read at request time from the
// environment, or from OS-backed secure storage in the desktop app (Keychain/DPAPI), and is
// held only for the duration of a request.
//
// GRAFT works with no agent configured. This file existing is not a requirement for anything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { graftHome } from '../registry/index.js';
import { PROVIDER_IDS, ADAPTERS } from './providers.js';
import { createGrant, DEFAULT_SCOPES } from './permissions.js';

export const AGENT_CONFIG_VERSION = '1.0.0';
export const agentConfigPath = () => path.join(graftHome(), 'agent.json');

/** Environment variable a provider's key is read from when no secure store is supplied. */
export const KEY_ENVIRONMENT = Object.freeze({ anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', 'openai-compatible': 'GRAFT_AGENT_API_KEY' });

export function loadAgentConfig({ file = agentConfigPath() } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.agentConfigVersion !== AGENT_CONFIG_VERSION || !PROVIDER_IDS.includes(parsed.provider)) return null;
    // Refuse to honour a config that somehow carries a key: storing one here is a mistake,
    // and silently using it would teach the wrong lesson.
    if (parsed.apiKey || parsed.key || parsed.secret) throw new Error(`${file} contains an API key. GRAFT never stores keys in this file; remove it and use ${KEY_ENVIRONMENT[parsed.provider] || 'secure storage'}.`);
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export function saveAgentConfig({ provider, model = null, endpoint = null, scopes = DEFAULT_SCOPES }, { file = agentConfigPath() } = {}) {
  if (!PROVIDER_IDS.includes(provider)) throw new Error(`Unknown agent provider "${provider}". Available: ${PROVIDER_IDS.join(', ')}.`);
  const grant = createGrant(scopes, { reason: 'configured by the user' });
  const config = { agentConfigVersion: AGENT_CONFIG_VERSION, provider, model: model || ADAPTERS[provider].defaultModel,
    endpoint: endpoint || ADAPTERS[provider].defaultEndpoint, scopes: [...grant.scopes], configuredAt: new Date().toISOString(),
    keySource: `environment:${KEY_ENVIRONMENT[provider]}`, apiKeyStored: false };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.agent-${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return config;
}

export function clearAgentConfig({ file = agentConfigPath() } = {}) {
  fs.rmSync(file, { force: true });
  return { cleared: true };
}

/**
 * Resolve a key for a configured provider. `secureStore` is the desktop's OS-backed store
 * (Keychain on macOS, DPAPI on Windows); without one the environment is the only source.
 * A missing key is a normal state, not an error: the product runs agentless.
 */
export function resolveApiKey(config, { secureStore = null, env = process.env } = {}) {
  if (!config) return null;
  const fromStore = secureStore?.get?.(`agent:${config.provider}`) || null;
  if (fromStore) return fromStore;
  const variable = KEY_ENVIRONMENT[config.provider];
  const value = variable ? env[variable] : null;
  return value && value.trim() ? value.trim() : null;
}

/** What the UI may display about the agent. Never the key, never a fragment of it. */
export function describeAgentConfig(config, { secureStore = null, env = process.env } = {}) {
  if (!config) return { configured: false, providers: PROVIDER_IDS.map((id) => ({ id, label: ADAPTERS[id].label, defaultModel: ADAPTERS[id].defaultModel, requiresEndpoint: Boolean(ADAPTERS[id].requiresEndpoint), keyHint: ADAPTERS[id].keyHint, keyEnvironment: KEY_ENVIRONMENT[id] })) };
  const key = resolveApiKey(config, { secureStore, env });
  return {
    configured: true, provider: config.provider, label: ADAPTERS[config.provider].label, model: config.model, endpoint: config.endpoint,
    scopes: config.scopes, configuredAt: config.configuredAt,
    keyAvailable: Boolean(key), keySource: key ? (secureStore?.get?.(`agent:${config.provider}`) ? 'secure storage' : `environment ${KEY_ENVIRONMENT[config.provider]}`) : null,
    keyStoredInConfig: false,
    ready: Boolean(key) || Boolean(ADAPTERS[config.provider].requiresEndpoint && config.endpoint),
  };
}
