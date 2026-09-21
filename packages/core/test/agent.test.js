import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCOPES, DEFAULT_SCOPES, createGrant, requireScopes, escalationFor, PermissionError } from '../src/agent/permissions.js';
import { TASKS, projectResponse, taskPrompt, isAuthorityField, AUTHORITY_FIELDS, AuthorityViolation } from '../src/agent/tasks.js';
import { ADAPTERS, validateEndpoint, extractJson, adapterFor, PROVIDER_IDS } from '../src/agent/providers.js';
import { createAgentRuntime, applyRanking, filtersFromAdvice } from '../src/agent/runtime.js';
import { projectContext, capabilityContext, candidateContext, assertSendable, relativisePath, redact, sourceExcerpt } from '../src/agent/sanitize.js';
import { loadAgentConfig, saveAgentConfig, clearAgentConfig, describeAgentConfig, resolveApiKey, KEY_ENVIRONMENT } from '../src/agent/config.js';
import { discoverCapabilityCandidates } from '../src/workspace/discover.js';

const KEY = 'sk-ant-test-not-a-real-key-000000000000';
/** A provider stand-in: records what was sent, replies with whatever the test wants. */
function fakeProvider(reply) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    const text = typeof reply === 'function' ? reply(sent.length) : reply;
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(JSON.stringify({ content: [{ type: 'text', text }], model: 'test-model', usage: { input_tokens: 10, output_tokens: 5 } })); })() };
  };
  return { fetchImpl, sent };
}
const runtimeWith = (reply, options = {}) => {
  const provider = fakeProvider(reply);
  return { provider, agent: createAgentRuntime({ provider: 'anthropic', apiKey: KEY, fetchImpl: provider.fetchImpl, ...options }) };
};

test('scopes default to metadata, and command/write scopes can never be granted', () => {
  assert.deepEqual([...DEFAULT_SCOPES].sort(), ['capability:explain', 'capability:metadata', 'capability:rank', 'workspace:metadata'].sort());
  assert.equal(SCOPES['source:file'].default, false);
  assert.equal(SCOPES['source:snippet'].default, false);
  assert.equal(SCOPES['command:run'].grantable, false);
  assert.equal(SCOPES['destination:write'].grantable, false);
  assert.throws(() => createGrant([...DEFAULT_SCOPES, 'command:run']), /never be granted/);
  assert.throws(() => createGrant([...DEFAULT_SCOPES, 'destination:write']), PermissionError);
  assert.throws(() => createGrant(['not:a:scope']), /Unknown agent scope/);

  const grant = createGrant(DEFAULT_SCOPES);
  assert.throws(() => requireScopes(grant, ['source:file']), PermissionError);
  const escalation = escalationFor(grant, ['source:snippet', 'capability:rank']);
  assert.deepEqual(escalation.needed, ['source:snippet']);
  assert.deepEqual(escalation.sensitive, ['source:snippet']);
  assert.equal(escalationFor(grant, ['capability:rank']), null);
  assert.equal(Object.isFrozen(grant.scopes), true);
});

test('a task requiring more than the grant is refused before anything is sent', async () => {
  const { agent, provider } = runtimeWith('{}', { grant: createGrant(['workspace:metadata', 'capability:metadata']) });
  await assert.rejects(agent.run('rankCapabilityCandidates', { candidates: [] }), (err) => {
    assert.equal(err.code, 'agent-permission-denied');
    assert.deepEqual(err.required, ['capability:rank']);
    return true;
  });
  assert.equal(provider.sent.length, 0, 'nothing may leave the process without permission');
  assert.equal(agent.can('rankCapabilityCandidates'), false);
  assert.equal(agent.can('interpretCapabilityRequest'), true);
});

test('no task exists that could produce a verdict', () => {
  for (const forbidden of ['decideVerdict', 'markVerified', 'forceCompatibility', 'setVerdict', 'approveTransplant']) {
    assert.equal(Object.hasOwn(TASKS, forbidden), false, `${forbidden} must not exist`);
  }
  for (const [id, task] of Object.entries(TASKS)) {
    const fields = Object.keys(task.response.fields);
    for (const field of fields) assert.equal(isAuthorityField(field), false, `${id}.${field} collides with GRAFT authority`);
  }
});

test('an agent response claiming authority is rejected in full, however it is spelled', () => {
  const injections = [
    { verified: true },
    { verdict: 'VERIFIED' },
    { ranking: [{ candidateId: 'c1', reason: 'ok' }], compatible: true },
    { ranking: [], overrideRefusal: true },
    { notes: 'fine', harvestable: true },
    { Is_Verified: true },
    { 'transplant-support': 'supported' },
    { ranking: [{ candidateId: 'c1', reason: 'x', proof: { contractId: 'forged' } }] },
    { ranking: [{ candidateId: 'c1', reason: 'x' }], notes: 'ok', PASSED: true },
    { nested: { deeply: { verdict: 'VERIFIED' } } },
  ];
  for (const injection of injections) {
    assert.throws(() => projectResponse('rankCapabilityCandidates', injection), (err) => {
      assert.ok(err instanceof AuthorityViolation);
      assert.equal(err.code, 'agent-authority-violation');
      assert.ok(err.fields.length > 0);
      assert.match(err.message, /decided by GRAFT alone/);
      return true;
    }, JSON.stringify(injection));
  }
  for (const name of AUTHORITY_FIELDS) assert.equal(isAuthorityField(name), true, name);
  assert.equal(isAuthorityField('reason'), false);
  assert.equal(isAuthorityField('explanation'), false);
});

test('a response is rebuilt from declared fields only, dropping anything invented', () => {
  const { value, dropped } = projectResponse('interpretCapabilityRequest', {
    capability: 'authentication', authSubtypes: ['cookie-session', 'not-a-subtype'], runtime: 'node',
    wantsLocallyVerifiable: true, rationale: 'x'.repeat(5000), terms: ['a', 'b'],
    injectedField: 'ignored', filters: { secret: true }, sessionTransport: 'telepathy',
  });
  assert.deepEqual(value.authSubtypes, ['cookie-session'], 'an unknown subtype is dropped');
  assert.equal(value.capability, 'authentication');
  assert.equal(value.rationale.length, 600, 'strings are bounded');
  assert.equal(value.injectedField, undefined);
  assert.equal(value.filters, undefined);
  assert.equal(value.sessionTransport, undefined, 'an invalid enum is dropped, not passed through');
  assert.ok(dropped.some((d) => d.includes('injectedField')));
  assert.ok(dropped.some((d) => d.includes('sessionTransport')));
});

test('agent rankings can only reorder GRAFT results, never alter or invent them', () => {
  const results = [
    { projectId: 'p1', capability: 'authentication', harvestable: true, transplantSupport: 'supported', state: 'TRANSPLANTABLE', score: 40 },
    { projectId: 'p2', capability: 'authentication', harvestable: false, transplantSupport: 'unsupported', state: 'OBSERVED', score: 10 },
  ];
  const applied = applyRanking(results, { value: { ranking: [
    { candidateId: 'c2', reason: 'better fit' },
    { candidateId: 'c99', reason: 'does not exist' },
    { candidateId: 'c2', reason: 'duplicate' },
  ], notes: 'reordered' } });
  assert.equal(applied.results.length, 2, 'no candidate is added or removed');
  assert.equal(applied.results[0].projectId, 'p2');
  assert.equal(applied.results[0].agentReason, 'better fit');
  assert.equal(applied.results[1].projectId, 'p1', 'an unranked candidate keeps its place at the end');
  assert.deepEqual(applied.ignoredCandidateIds, ['c99', 'c2']);
  // Authoritative fields are untouched by the agent's involvement.
  assert.equal(applied.results[0].harvestable, false);
  assert.equal(applied.results[0].transplantSupport, 'unsupported');
  assert.equal(applied.results[1].harvestable, true);
  assert.equal(applied.rankedByAgent, true);

  const untouched = applyRanking(results, { value: {} });
  assert.deepEqual(untouched.results.map((r) => r.projectId), ['p1', 'p2']);
  assert.equal(untouched.rankedByAgent, false);
});

test('default agent context carries structure, never source text, secrets or home paths', () => {
  const home = os.homedir();
  const project = {
    projectId: 'git:abc#root', name: 'app', relativeRoot: '.', language: 'javascript', runtime: 'node', framework: 'node-http',
    moduleSystem: 'esm', isCompiled: false, hasHttpServer: true, handlerContract: 'node-res', routeIdioms: ['path-comparison'],
    routes: [{ method: 'GET', path: '/auth/login', idiom: 'path-comparison', file: 'src/auth.js' }],
    entrypoint: { source: 'server.mjs', runtime: 'server.mjs', generated: false, confidence: 'high' },
    dependencies: [{ name: 'express', range: '5.0.0' }], environmentVariables: ['API_TOKEN', 'DATABASE_URL'],
    externalHosts: ['api.workos.com'], storage: [{ kind: 'postgres', evidence: 'dependency pg' }], deployTargets: ['vercel'],
    testCommands: [{ name: 'test', command: 'node --test' }], fileCount: 12,
    repository: { name: 'app', branch: 'main' },
    // None of the following are declared by the sanitizer, so none may travel.
    files: ['src/auth.js'], read: () => 'secret source', root: path.join(home, 'Developer', 'app'),
    apiKey: 'sk_live_51NotARealKeyButLooksLikeOne', sourceText: 'const PASSWORD = "hunter2";\n'.repeat(50),
  };
  const context = projectContext(project);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('sk_live_51NotARealKey'), false);
  assert.equal(serialized.includes('hunter2'), false);
  assert.equal(serialized.includes('secret source'), false);
  assert.equal(serialized.includes(home), false, 'absolute home paths never travel');
  assert.equal(context.root, undefined);
  assert.equal(context.files, undefined);
  assert.equal(context.read, undefined);
  assert.equal(context.apiKey, undefined);
  assert.deepEqual(context.environmentVariableNames, ['API_TOKEN', 'DATABASE_URL'], 'names only');
  assert.equal(context.routes[0].path, '/auth/login');
  assert.equal(relativisePath(path.join(home, 'x')), '~/x');
  assert.equal(redact('token sk_live_51NotARealKeyButLooksLikeOne here'), 'token [redacted] here');

  const capability = capabilityContext({
    capability: 'authentication', state: 'STRONGLY_DETECTED', subtypes: ['cookie-session'], confidence: 'high',
    auth: { credentialAuthority: { kind: 'hosted-provider', detail: 'workos' }, sessionTransport: 'cookie', sessionCustody: 'local',
      sessionStore: 'memory', sessionDurableAcrossRestart: false, cookieName: '__Host-app_session', cookieFlags: { httpOnly: true, secure: true, sameSite: 'Lax', hostPrefix: true }, providers: ['workos'] },
    signals: [{ id: 'pkce', evidence: 'PKCE code_challenge', file: 'src/auth.js' }], missingSignals: [], harvestable: false,
    transplantSupport: 'unsupported', blockers: [], localVerification: { feasible: false, reasons: [] },
  });
  assert.equal(capability.auth.cookieFlags.httpOnly, true);
  assert.equal(capability.auth.cookieName, undefined, 'a cookie name is not part of default context');
  assert.equal(capability.harvestable, false);
});

test('the sanitizer refuses to send a payload that still carries a secret or source', () => {
  assert.throws(() => assertSendable({ note: 'key sk_live_51NotARealKeyButLooksLikeOne' }), /unsafe|credential/i);
  assert.throws(() => assertSendable({ path: path.join(os.homedir(), 'Developer/app') }), /absolute home path/);
  assert.throws(() => assertSendable({ file: 'x'.repeat(401) + '\n' + 'y'.repeat(200) }), /source text/);
  assert.throws(() => assertSendable({ password: 'hunter2' }), /sensitive field name/);
  assert.throws(() => assertSendable({ headers: { authorization: 'Bearer abcdefghijklmnop' } }), /credential|sensitive/);
  const safe = assertSendable({ project: 'app', routes: [{ method: 'GET', path: '/me' }], environmentVariableNames: ['API_TOKEN'] });
  assert.equal(safe.project, 'app');
  const excerpt = sourceExcerpt({ file: path.join(os.homedir(), 'a.js'), contents: 'line1\nkey=sk_live_51NotARealKeyButLooksLikeOne\nline3\nline4', startLine: 1, maxLines: 2 });
  assert.equal(excerpt.file.startsWith('~'), true);
  assert.equal(excerpt.excerpt.includes('sk_live_51NotARealKey'), false, 'even a granted excerpt is redacted');
  assert.equal(excerpt.truncated, true);
});

test('a real request carries only sanitized context and no credential in its body', async () => {
  const { agent, provider } = runtimeWith(JSON.stringify({ capability: 'authentication', rationale: 'asked for login' }));
  const advice = await agent.run('interpretCapabilityRequest', { request: 'find my login', workspace: [{ language: 'javascript', runtime: 'node' }] });
  assert.equal(advice.value.capability, 'authentication');
  assert.equal(advice.advisory, true);
  assert.equal(advice.authoritative, false);
  assert.equal(advice.usage.inputTokens, 10);
  const sent = provider.sent[0];
  assert.equal(sent.headers['x-api-key'], KEY, 'the key travels in the header only');
  const body = JSON.stringify(sent.body);
  assert.equal(body.includes(KEY), false, 'never in the body');
  assert.equal(body.includes(os.homedir()), false);
  assert.match(body, /advisory component inside GRAFT/);
  assert.match(body, /never decide outcomes/);
  // A hostile context is refused before the provider is called at all.
  await assert.rejects(agent.run('interpretCapabilityRequest', { request: 'x', leaked: 'sk_live_51NotARealKeyButLooksLikeOne' }), /Refusing to send/);
  assert.equal(provider.sent.length, 1);
});

test('provider adapters validate endpoints and require an explicit one where it matters', () => {
  assert.deepEqual(PROVIDER_IDS, ['anthropic', 'openai', 'openai-compatible']);
  assert.equal(adapterFor('openai').defaultModel, 'gpt-4o-mini');
  assert.throws(() => adapterFor('nope'), /Unknown agent provider/);
  assert.equal(validateEndpoint('https://api.openai.com/v1/chat/completions').protocol, 'https:');
  assert.equal(validateEndpoint('http://127.0.0.1:11434/v1/chat/completions').hostname, '127.0.0.1', 'a local model server may use loopback HTTP');
  assert.throws(() => validateEndpoint('http://example.com/v1'), /HTTPS/);
  assert.throws(() => validateEndpoint('https://user:pw@example.com/v1'), /must not carry credentials/);
  assert.throws(() => validateEndpoint('not a url'), /Invalid provider endpoint/);
  assert.throws(() => createAgentRuntime({ provider: 'openai-compatible' }), /needs an endpoint/);
  assert.throws(() => createAgentRuntime({ provider: 'anthropic' }), /needs an API key/);
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":2}'), { a: 2 });
  assert.throws(() => extractJson('no json here'), /did not return a JSON object/);
  for (const adapter of Object.values(ADAPTERS)) assert.equal(typeof adapter.complete, 'function');
});

test('agent configuration stores no key and reports where the key comes from', (t) => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-agent-')));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const file = path.join(work, 'agent.json');

  assert.equal(loadAgentConfig({ file }), null);
  assert.equal(describeAgentConfig(null).configured, false);
  const saved = saveAgentConfig({ provider: 'anthropic' }, { file });
  assert.equal(saved.apiKeyStored, false);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('sk-'), false);
  assert.match(raw, /"keySource": "environment:ANTHROPIC_API_KEY"/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const loaded = loadAgentConfig({ file });
  assert.equal(loaded.provider, 'anthropic');
  assert.equal(resolveApiKey(loaded, { env: {} }), null, 'no key is a normal state');
  assert.equal(resolveApiKey(loaded, { env: { [KEY_ENVIRONMENT.anthropic]: KEY } }), KEY);
  assert.equal(resolveApiKey(loaded, { env: {}, secureStore: { get: (k) => (k === 'agent:anthropic' ? 'from-keychain' : null) } }), 'from-keychain');
  const described = describeAgentConfig(loaded, { env: { [KEY_ENVIRONMENT.anthropic]: KEY } });
  assert.equal(described.keyAvailable, true);
  assert.equal(described.keyStoredInConfig, false);
  assert.equal(JSON.stringify(described).includes(KEY), false, 'the key itself is never described');

  // A key someone pasted into the config file is refused rather than used.
  fs.writeFileSync(file, JSON.stringify({ ...loaded, apiKey: KEY }));
  assert.throws(() => loadAgentConfig({ file }), /never stores keys in this file/);
  fs.writeFileSync(file, JSON.stringify(loaded));
  clearAgentConfig({ file });
  assert.equal(loadAgentConfig({ file }), null);
  assert.throws(() => saveAgentConfig({ provider: 'unknown-provider' }, { file }), /Unknown agent provider/);
});

test('discovery works with no agent, and an agent failure never breaks it', async () => {
  const index = { indexVersion: '1.0.0', roots: [], updatedAt: '2026-09-11T00:00:00.000Z', projects: [
    { projectId: 'p1', name: 'classic', root: '/w/classic', relativeRoot: '.', repositoryId: 'git:1', repository: { name: 'classic', branch: 'main' },
      language: 'javascript', runtime: 'node', framework: 'node-http', moduleSystem: 'cjs', hasHttpServer: true, externalHosts: [],
      entrypoint: { runtime: 'server.js', source: 'server.js', generated: false, confidence: 'high' },
      capabilities: [{ capability: 'authentication', state: 'HARVESTABLE', subtypes: ['local-password', 'cookie-session'], confidence: 'high',
        auth: { credentialAuthority: { kind: 'local', detail: 'scrypt' }, sessionTransport: 'cookie', sessionCustody: 'local', sessionStore: 'memory', sessionDurableAcrossRestart: false, providers: [], routeRoles: ['login'] },
        signals: [{ id: 'password-hashing', evidence: 'scrypt hashing call', file: 'server.js' }], missingSignals: [], harvestable: true,
        transplantSupport: 'supported', blockers: [], asDestination: { supported: false, blockers: [] }, localVerification: { feasible: true, reasons: [] } }] },
    { projectId: 'p2', name: 'hosted', root: '/w/hosted', relativeRoot: '.', repositoryId: 'git:2', repository: { name: 'hosted', branch: 'main' },
      language: 'typescript', runtime: 'node', framework: 'node-http', moduleSystem: 'esm', hasHttpServer: true, externalHosts: ['api.workos.com'],
      entrypoint: { runtime: 'src/index.ts', source: 'src/index.ts', generated: false, confidence: 'medium' },
      capabilities: [{ capability: 'authentication', state: 'STRONGLY_DETECTED', subtypes: ['hosted-provider-oauth', 'cookie-session'], confidence: 'high',
        auth: { credentialAuthority: { kind: 'hosted-provider', detail: 'workos' }, sessionTransport: 'cookie', sessionCustody: 'local', sessionStore: 'memory', sessionDurableAcrossRestart: false, providers: ['workos'], routeRoles: ['login', 'callback'] },
        signals: [{ id: 'pkce', evidence: 'PKCE', file: 'src/auth.ts' }], missingSignals: [{ id: 'password-hashing', requiredFor: 'harvest', why: 'credentials live with workos' }],
        harvestable: false, transplantSupport: 'unsupported', blockers: [{ id: 'not-harvestable', detail: 'detector did not accept it' }], asDestination: { supported: false, blockers: [] }, localVerification: { feasible: false, reasons: ['needs live credentials'] } }] },
  ] };

  // No agent: full deterministic discovery.
  const plain = await discoverCapabilityCandidates('find something that keeps users logged in', { index, limit: 5 });
  assert.equal(plain.agentConfigured, false);
  assert.equal(plain.interpretation.source, 'deterministic');
  assert.equal(plain.total, 2);
  assert.equal(plain.candidates[0].project.name, 'classic');
  assert.equal(plain.ranking.rankedByAgent, false);
  assert.match(plain.authority, /determined by GRAFT/);

  // An agent that fails at every step leaves the deterministic answer intact.
  const broken = { describe: () => ({ provider: 'anthropic' }), run: async () => { throw new Error('provider unreachable'); } };
  const degraded = await discoverCapabilityCandidates('find my login', { index, agent: broken, limit: 5 });
  assert.equal(degraded.total, 2);
  assert.equal(degraded.candidates.length, 2);
  assert.equal(degraded.interpretation.source, 'deterministic');
  assert.ok(degraded.steps.some((s) => s.step === 'interpret' && s.ok === false));

  // An agent that tries to assert authority has its response rejected; results survive.
  const hostile = {
    describe: () => ({ provider: 'anthropic' }),
    run: async (taskId) => {
      if (taskId === 'interpretCapabilityRequest') return { value: { capability: 'authentication' }, droppedFields: [] };
      throw new AuthorityViolation(['verdict']);
    },
  };
  const defended = await discoverCapabilityCandidates('find my login', { index, agent: hostile, limit: 5 });
  assert.equal(defended.total, 2);
  assert.equal(defended.ranking.code, 'agent-authority-violation');
  assert.equal(defended.candidates[0].harvestable, true, 'GRAFT results are unchanged by a hostile agent');
  assert.equal(defended.candidates.every((c) => c.agentRank === undefined || c.agentRank === null), true);

  // A working agent may reorder — and only reorder.
  const helpful = {
    describe: () => ({ provider: 'anthropic', model: 'test' }),
    run: async (taskId, context) => {
      if (taskId === 'interpretCapabilityRequest') return { value: { capability: 'authentication' }, droppedFields: [] };
      assert.equal(JSON.stringify(context).includes('/w/'), false, 'absolute paths never reach the agent');
      return { value: { ranking: [{ candidateId: 'c2', reason: 'closest to the destination' }], notes: 'n' }, droppedFields: [] };
    },
  };
  const ranked = await discoverCapabilityCandidates('find my login', { index, agent: helpful, limit: 5 });
  assert.equal(ranked.ranking.rankedByAgent, true);
  assert.equal(ranked.candidates[0].project.name, 'hosted');
  assert.equal(ranked.candidates[0].harvestable, false, 'a promoted candidate does not become harvestable');
  assert.equal(ranked.candidates[0].transplantSupport, 'unsupported');
  assert.equal(ranked.candidates[0].agentReason, 'closest to the destination');
});

test('candidate context sent for ranking is opaque and structural', () => {
  const context = candidateContext({
    projectId: 'git:abc#root', project: { name: 'app', relativeRoot: '.', root: path.join(os.homedir(), 'Developer/app'), language: 'javascript',
      runtime: 'node', framework: 'express', moduleSystem: 'esm', hasHttpServer: true, externalHosts: ['api.workos.com'] },
    capability: 'authentication', state: 'HARVESTABLE', subtypes: ['local-password'],
    auth: { credentialAuthority: { kind: 'local', detail: 'scrypt in this project' }, sessionTransport: 'cookie', sessionCustody: 'local', sessionStore: 'memory' },
    evidence: [{ id: 'password-hashing', evidence: 'scrypt hashing call', file: 'server.js' }],
    matchedBecause: [{ signal: 'capability', detail: 'capability is authentication' }],
    harvestable: true, transplantSupport: 'supported', localVerification: { feasible: true }, blockers: [],
  }, 1);
  assert.equal(context.candidateId, 'c1');
  assert.equal(JSON.stringify(context).includes(os.homedir()), false);
  assert.deepEqual(context.evidence, ['password-hashing'], 'evidence is reduced to signal ids');
  assert.equal(context.auth.credentialAuthority, 'local');
  assertSendable(context);
});

test('filters proposed by an agent are re-validated before GRAFT uses them', () => {
  const filters = filtersFromAdvice({ value: { capability: 'authentication', authSubtypes: ['cookie-session'], sessionTransport: 'cookie',
    credentialAuthority: 'unknown', runtime: 'unknown', language: 'javascript', wantsLocallyVerifiable: true } });
  assert.deepEqual(filters, { capability: 'authentication', authSubtypes: ['cookie-session'], sessionTransport: 'cookie', language: 'javascript', localVerification: true });
  assert.deepEqual(filtersFromAdvice({ value: {} }), {});
  assert.deepEqual(filtersFromAdvice({}), {});
  assert.deepEqual(filtersFromAdvice({ value: { capability: 'unknown' } }), {});
});

test('the prompt tells the model it is advisory, and the code does not rely on it believing that', () => {
  const prompt = taskPrompt('rankCapabilityCandidates', { candidates: [] });
  assert.match(prompt, /GRAFT alone determines/);
  assert.match(prompt, /discarded in full/);
  assert.match(prompt, /"ranking"/);
  // The enforcement is structural regardless of the prompt's wording.
  assert.throws(() => projectResponse('rankCapabilityCandidates', { verdict: 'VERIFIED' }), AuthorityViolation);
});
