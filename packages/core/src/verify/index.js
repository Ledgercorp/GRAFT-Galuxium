import fs from 'node:fs';
import path from 'node:path';
import { bootServer, CookieJar, setCookieNames } from './http-runner.js';
import { execFileSync } from 'node:child_process';
import { resolveRuntime } from './runtime.js';
import { fingerprintProject } from '../analyze/fingerprint.js';
import { redactSecrets, validateAcceptanceTests, SAFE_VALUE_PATTERN } from '../manifest/schema.js';
import { recordCompatibilityObservation, buildCompatibilityObservation } from '../capability/knowledge.js';
import { decideHttpSuite } from '../../../proof-adapter/src/index.js';
import { buildEngineArtifacts } from '../engine/index.js';
import { evaluateVerificationContract } from '../engine/verification-contract.js';
import { buildAtlasEntry, recordAtlasEntry } from '../engine/atlas.js';
import { buildVerificationContract } from '../engine/verification-contract.js';
import { recipeById } from '../engine/recipes.js';
import { architectureSignature } from '../capability/contract.js';
import { startProviderDouble, DEFAULT_PROVIDER_ENV } from './provider-double.js';
import { finishReport, revisionAuthority, sourceRevisionOf } from './proof-envelope.js';

export const VERIFIED = 'VERIFIED';
export const FAILED = 'FAILED';
export const NEEDS_REVIEW = 'NEEDS_REVIEW';

function readPath(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Evaluates one step's expectations against a real response.
 * Returns every check it made, so a pass is as inspectable as a failure.
 */
function evaluate(expect = {}, response, { bodies = new Map(), providerCalls = null, providerEndpoints = null, sentinels = [] } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  // Negative-output witness: values the verifier injected as secrets must not appear anywhere in
  // this response — status line aside, that is the body text, every header and every Set-Cookie.
  if (expect.noSecretsInOutput) {
    if (!sentinels.length) add('noSecretsInOutput', false, 'no secret sentinel is attached to this run, so absence cannot be witnessed');
    else {
      const observable = [response.rawBody || '', ...(response.rawHeaders || []), ...response.setCookies.map((c) => c.raw || '')].join('\n');
      const leaked = sentinels.filter((s) => observable.includes(s.value)).map((s) => s.name);
      add('noSecretsInOutput', leaked.length === 0, leaked.length ? `secret ${leaked.join(', ')} appeared in observable output` : `${sentinels.length} sentinel secret(s) absent from body, headers and cookies`);
    }
  }
  // Engine 1.2 witnesses: where a redirect went, and what the provider boundary saw.
  const location = response.location ? (() => { try { return new URL(response.location, 'http://verification.invalid'); } catch { return null; } })() : null;
  if (expect.redirectPath !== undefined) add('redirectPath', Boolean(location) && location.host === 'verification.invalid' && location.pathname + (location.search === '?' ? '' : location.search) === expect.redirectPath, location ? `redirected to ${response.location}` : 'no Location header');
  if (expect.redirectPathStartsWith !== undefined) add('redirectPathStartsWith', Boolean(location) && location.host === 'verification.invalid' && (location.pathname + location.search).startsWith(expect.redirectPathStartsWith), location ? `redirected to ${response.location}` : 'no Location header');
  if (expect.redirectToProvider !== undefined) {
    const providerPath = typeof expect.redirectToProvider === 'string' ? expect.redirectToProvider : providerEndpoints?.authorize || null;
    const ok = Boolean(location) && location.host !== 'verification.invalid' && (!providerPath || location.pathname === providerPath);
    add('redirectToProvider', ok, location ? `redirected to ${location.origin}${location.pathname}` : 'no Location header');
  }
  if (expect.redirectQueryHas) for (const key of expect.redirectQueryHas) add(`redirect.query.${key}`, Boolean(location?.searchParams.get(key)), location?.searchParams.has(key) ? `${key} present` : `${key} missing from the redirect`);
  if (expect.providerCalled !== undefined) {
    // "Called" means the provider boundary was crossed — a rejected exchange still crossed it.
    const seen = providerCalls ? providerCalls().some((c) => c.op === expect.providerCalled) : null;
    add(`provider.${expect.providerCalled}`, seen === true, seen === null ? 'no provider double is attached to this run' : seen ? `provider ${expect.providerCalled} was called through the provider boundary (${providerCalls().filter((c) => c.op === expect.providerCalled).map((c) => c.ok === false ? 'rejected' : 'accepted').join(',')})` : `provider ${expect.providerCalled} was not called`);
  }
  if (expect.providerNotCalled !== undefined) {
    const seen = providerCalls ? providerCalls().some((c) => c.op === expect.providerNotCalled) : null;
    add(`provider.not.${expect.providerNotCalled}`, seen === false, seen === null ? 'no provider double is attached to this run' : seen ? `provider ${expect.providerNotCalled} was called but must not have been` : `provider ${expect.providerNotCalled} correctly not called`);
  }

  if (expect.status) {
    const want = Array.isArray(expect.status) ? expect.status : [expect.status];
    add('status', want.includes(response.status), `expected one of ${want.join('/')}, got ${response.status}`);
  }
  if (expect.setsCookie) {
    const hit = response.setCookies.find((c) => c.name === expect.setsCookie && c.value !== '');
    add('setsCookie', Boolean(hit), hit ? `${expect.setsCookie} set` : `${expect.setsCookie} was not set (set-cookie: ${response.setCookies.map((c) => c.name).join(',') || 'none'})`);
  }
  if (expect.notSetsCookie) {
    const hit = response.setCookies.find((c) => c.name === expect.notSetsCookie && c.value !== '');
    add('notSetsCookie', !hit, hit ? `${expect.notSetsCookie} was set but must not be` : `${expect.notSetsCookie} correctly not set`);
  }
  if (expect.bodyMatches) {
    for (const [dotted, want] of Object.entries(expect.bodyMatches)) {
      const got = readPath(response.body, dotted);
      add(`body.${dotted}`, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  // Witnesses for the ABSENCE of side effects and for cookie attributes.
  if (expect.noSetCookie) {
    add('noSetCookie', response.setCookies.length === 0, response.setCookies.length ? `set-cookie present: ${response.setCookies.map((c) => c.name).join(',')}` : 'no cookie issued');
  }
  if (expect.sameBodyAs) {
    const earlier = bodies.get(expect.sameBodyAs);
    const same = earlier !== undefined && JSON.stringify(earlier) === JSON.stringify(response.body);
    add('sameBodyAs', same, same ? `identical to step "${expect.sameBodyAs}"` : `differs from step "${expect.sameBodyAs}"`);
  }
  if (expect.cookieFlags || expect.cookieValuePattern) {
    const name = expect.setsCookie || response.setCookies[0]?.name;
    const raw = response.setCookies.find((c) => c.name === name)?.raw || '';
    const attrs = Object.fromEntries(raw.split(';').slice(1).map((a) => a.trim()).filter(Boolean).map((a) => { const i = a.indexOf('='); return i < 0 ? [a.toLowerCase(), true] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()]; }));
    for (const [flag, want] of Object.entries(expect.cookieFlags || {})) {
      const got = attrs[flag.toLowerCase()];
      const ok = typeof want === 'boolean' ? Boolean(got) === want : String(got).toLowerCase() === String(want).toLowerCase();
      add(`cookie.${flag}`, ok, `expected ${flag}=${want}, got ${got === undefined ? 'absent' : got}`);
    }
    if (expect.cookieValuePattern) {
      const value = response.setCookies.find((c) => c.name === name)?.value || '';
      // Defense in depth: only the schema's safe grammar is ever compiled; anything else fails closed.
      let ok = false; try { ok = SAFE_VALUE_PATTERN.test(expect.cookieValuePattern) && new RegExp(expect.cookieValuePattern).test(value); } catch { ok = false; }
      add('cookie.value', ok, ok ? 'cookie value matches the expected shape' : `cookie value does not match /${expect.cookieValuePattern}/`);
    }
  }
  return checks;
}

const STEP_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

async function readResponseBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error(`response body exceeds the ${MAX_RESPONSE_BYTES}-byte verification limit`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

async function runTest(test, baseUrl, { stepTimeoutMs = STEP_TIMEOUT_MS, restart = null, double = null } = {}) {
  // A fresh jar per test: one test must never inherit another test's session.
  const jar = new CookieJar();
  // Values captured from a redirect (state, PKCE challenge) for later steps of the same test.
  const captures = new Map();
  // Named cookie snapshots let a test re-present a credential the server has since
  // asked the client to drop. Without this, "log out" tests only prove the browser
  // was told to forget the cookie, not that the server stopped honouring it.
  const snapshots = new Map();
  const bodies = new Map();
  const steps = [];

  for (const step of test.steps) {
    // A restart step stops and reboots the application in place, keeping the client's
    // cookies, so durability across process restarts can be observed rather than assumed.
    if (step.restart === true) {
      const rebooted = restart ? await restart() : null;
      if (!rebooted) return { id: test.id, outcome: 'inconclusive', required: test.required, provesBehavior: test.provesBehavior, description: test.description, reason: `step "${step.name}" could not restart the application`, steps };
      baseUrl = rebooted;
      steps.push({ name: step.name, request: 'restart', status: null, checks: [{ name: 'restart', ok: true, detail: 'application restarted' }], ok: true });
      continue;
    }
    let url = `${baseUrl}${step.path}`;
    if (step.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(step.query)) {
        if (typeof value === 'string') params.set(key, value);
        else if (value && typeof value === 'object' && captures.has(value.capture)) params.set(key, `${value.prefix || ''}${captures.get(value.capture)}`);
        else return { id: test.id, outcome: 'inconclusive', required: test.required, provesBehavior: test.provesBehavior, description: test.description, reason: `step "${step.name}" needs capture "${value?.capture}", which no earlier step captured`, steps };
      }
      url += `?${params.toString()}`;
    }
    const headers = { accept: 'application/json' };
    if (step.body !== undefined) headers['content-type'] = 'application/json';
    // Fixed request headers (same-origin/CSRF witnesses); `${origin}` is the application's own origin.
    for (const [name, value] of Object.entries(step.headers || {})) headers[name.toLowerCase()] = value.replaceAll('${origin}', baseUrl);
    const providerCallsBefore = double ? double.calls().length : 0;
    // Verification-only provider control (short-lived tokens, refresh identity change), applied
    // before this step and reset after the test.
    if (step.providerControl && double) { try { await double.control(step.providerControl); } catch (err) { return { id: test.id, outcome: 'inconclusive', required: test.required, provesBehavior: test.provesBehavior, description: test.description, reason: `step "${step.name}" could not configure the provider double: ${err.message}`, steps }; } }
    if (step.useCookieSnapshot) {
      const snapshot = snapshots.get(step.useCookieSnapshot);
      if (!snapshot) {
        return { id: test.id, outcome: 'inconclusive', required: test.required, provesBehavior: test.provesBehavior,
          description: test.description, reason: `step "${step.name}" wants cookie snapshot "${step.useCookieSnapshot}", which no earlier step captured`, steps };
      }
      headers.cookie = snapshot;
    } else if (step.useCookies !== false) {
      const cookie = jar.header();
      if (cookie) headers.cookie = cookie;
    }

    let response;
    try {
      // A server that accepts the connection and then never answers must not hang
      // verification; an unanswered request is inconclusive evidence, not a pass.
      const res = await fetch(url, {
        method: step.method,
        headers,
        body: step.body === undefined ? undefined : JSON.stringify(step.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(stepTimeoutMs),
      });
      const text = await readResponseBody(res);
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text }; }
      const setCookies = setCookieNames(res.headers);
      jar.ingest(setCookies.map((c) => c.raw));
      const rawHeaders = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`);
      response = { status: res.status, body, rawBody: text, rawHeaders, setCookies, location: res.headers.get('location') || null };
    } catch (err) {
      // A transport failure is not a failed assertion; we learned nothing about the behavior.
      return { id: test.id, outcome: 'inconclusive', required: test.required, provesBehavior: test.provesBehavior,
        description: test.description, reason: `transport error on step "${step.name}": ${err.message}`, steps };
    }

    if (step.snapshotCookies) snapshots.set(step.snapshotCookies, jar.header() || '');
    if (step.captureQuery && response.location) {
      try { const target = new URL(response.location, baseUrl); for (const [name, param] of Object.entries(step.captureQuery)) if (target.searchParams.has(param)) captures.set(name, target.searchParams.get(param)); } catch { /* not a URL; captures stay empty and a later step reports it */ }
    }

    // Provider expectations are judged on the calls this step caused, not the whole run.
    const providerCalls = double ? () => double.calls().slice(providerCallsBefore) : null;
    const checks = evaluate(step.expect, response, { bodies, providerCalls, providerEndpoints: double?.endpoints || null, sentinels: double?.sentinels?.() || [] });
    bodies.set(step.name, response.body);
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    steps.push({ name: step.name, request: `${step.method} ${step.path}`, status: response.status, checks, ok });
    if (!ok) {
      return { id: test.id, outcome: 'failed', required: test.required, provesBehavior: test.provesBehavior,
        description: test.description,
        reason: `step "${step.name}" failed: ${checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`,
        steps };
    }
  }

  return { id: test.id, outcome: 'passed', required: test.required, provesBehavior: test.provesBehavior,
    description: test.description, steps };
}

/**
 * Decides the verdict from the results and nothing else.
 *
 * This function is the only thing in GRAFT allowed to say VERIFIED. It takes no model
 * output, no confidence score and no opinion — only what the acceptance tests actually
 * did. An absence of evidence produces NEEDS_REVIEW, never a pass.
 */
/**
 * `subject` names what was exercised, so a library's rationale does not describe a running server.
 * It changes wording only: the verdict rules, and what VERIFIED means, are identical for every form.
 */
export function decideVerdict(results, { serverReady = true, reason = null, subject = 'the running application' } = {}) {
  const required = results.filter((r) => r.required);
  const verdict = !serverReady ? NEEDS_REVIEW
    : required.length === 0 ? NEEDS_REVIEW
      : required.some((r) => r.outcome === 'failed') ? FAILED
        : required.some((r) => r.outcome === 'inconclusive') ? NEEDS_REVIEW
          : required.filter((r) => r.outcome === 'passed').length !== required.length ? NEEDS_REVIEW
            : VERIFIED;
  return { verdict, rationale: verdictRationale(verdict, results, { serverReady, reason, subject }) };
}
/**
 * The HTTP acceptance family's verdict: the runner's per-case outcomes are GRAFT's; the aggregate
 * verdict and the proof root over the HTTP evidence are the proof kernel's, through the proof
 * adapter, worded here. Any failure to decide is NEEDS_REVIEW, never a native verdict.
 */
export function decideHttpVerdict(results, { serverReady = true, reason = null, subject = 'the running application' } = {}) {
  try {
    const proof = decideHttpSuite({ results, serverReady });
    return { verdict: proof.verdict, rationale: verdictRationale(proof.verdict, results, { serverReady, reason, subject }), proofRoot: proof.proofRoot, proofEvidence: proof.evidence, proofAuthority: { ...proof.authority, cufVerdict: proof.cufVerdict, cases: proof.cases.length, evidenceItems: proof.evidenceItems } };
  } catch (error) {
    return { verdict: NEEDS_REVIEW, rationale: `The proof could not be decided, so no verdict could be established (${error.message}).`, proofRoot: null, proofEvidence: null, proofAuthority: { perCase: 'graft-http-runner', aggregation: 'proof-kernel', error: error.message } };
  }
}
/**
 * The wording for a verdict, from the same facts. Shared by the native engine above and by the
 * verifier families whose verdict is aggregated by the vendored proof kernel (see packages/proof-adapter), so the
 * rationale a person reads is identical whichever authority produced the verdict.
 */
export function verdictRationale(verdict, results, { serverReady = true, reason = null, subject = 'the running application' } = {}) {
  const required = results.filter((r) => r.required);
  if (verdict === VERIFIED) return `All ${required.length} required acceptance test(s) passed against ${subject}.`;
  if (verdict === FAILED) { const failed = required.filter((r) => r.outcome === 'failed'); return `${failed.length} of ${required.length} required acceptance test(s) failed: ${failed.map((f) => f.id).join(', ')}.`; }
  if (!serverReady) {
    return subject === 'the running application'
      ? `The destination application did not become ready, so no behavior could be observed (${reason}).`
      : `${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not be exercised, so no behavior could be observed (${reason}).`;
  }
  if (required.length === 0) return 'No required acceptance tests were present, so there is nothing that could prove the capability works.';
  const inconclusive = required.filter((r) => r.outcome === 'inconclusive');
  if (inconclusive.length) return `${inconclusive.length} required acceptance test(s) produced no usable evidence: ${inconclusive.map((f) => f.id).join(', ')}.`;
  return 'Required acceptance test results were incomplete.';
}

/**
 * Boots an application from a resolved runtime and runs acceptance tests against it.
 *
 * Shared by source verification (before harvest) and destination verification (after
 * transplant). There is one verdict engine; the two sides differ only in what is booted.
 * The report never says more than what was observed.
 */
async function runAcceptanceSuiteRaw({ runtime, tests, behavior = [], timeoutMs = 15000, stepTimeoutMs = STEP_TIMEOUT_MS, double = null, onProgress = null }) {
  const progress = (event) => { try { onProgress?.(event); } catch { /* progress is descriptive only */ } };
  const startedAt = new Date().toISOString();
  const base = { startedAt, runtime: runtime.ok ? { profile: runtime.profile, entrypoint: runtime.entrypoint, command: runtime.command, ...(runtime.harness ? { harness: runtime.harness } : {}) } : { profile: null, ...(runtime.reason?.startsWith('provider-seam-unavailable') ? { refusal: runtime.reason } : {}) },
    ...(double ? { providerDouble: { version: double.providerDoubleVersion, origin: 'loopback', endpoints: double.endpoints, subject: double.subject, injectedThrough: runtime.harness ? 'factory-injection' : 'endpoint-configuration', liveProvider: false } } : {}) };

  const validation = validateAcceptanceTests(tests);
  if (!validation.ok) {
    return { verdict: NEEDS_REVIEW, rationale: `Acceptance tests are invalid, so no behavior could be observed: ${validation.errors.join('; ')}.`,
      ...base, finishedAt: new Date().toISOString(), results: [],
      summary: { required: 0, passed: 0, failed: 0, inconclusive: 0 },
      diagnostics: { reason: 'invalid-acceptance-tests', errors: validation.errors, stderr: '' } };
  }

  if (!runtime.ok) {
    const decision = decideHttpVerdict([], { serverReady: false, reason: runtime.reason });
    return { ...decision, ...base, finishedAt: new Date().toISOString(), results: [],
      summary: { required: 0, passed: 0, failed: 0, inconclusive: 0 },
      diagnostics: { reason: runtime.reason?.startsWith('provider-seam-unavailable') ? 'provider-seam-unavailable' : 'runtime-unresolved', detail: runtime.reason, stderr: '' } };
  }

  progress({ stage: 'boot', profile: runtime.profile });
  const server = await bootServer(runtime.cwd, runtime.entrypoint, { timeoutMs, env: runtime.env, command: runtime.command });
  if (!server.ready) {
    const decision = decideHttpVerdict([], { serverReady: false, reason: server.reason });
    return { ...decision, ...base, finishedAt: new Date().toISOString(), results: [],
      summary: { required: 0, passed: 0, failed: 0, inconclusive: 0 },
      process: { pid: server.pid, exit: server.exit },
      diagnostics: { reason: server.reason, exit: server.exit, stdout: (server.stdout || '').slice(-2000), stderr: (server.stderr || '').slice(-2000) } };
  }

  let baseUrl = `http://127.0.0.1:${server.port}`;
  let current = server;
  const results = [];
  let logs = null;
  const providerOps = [];
  const restart = async () => {
    await current.stop();
    const next = await bootServer(runtime.cwd, runtime.entrypoint, { timeoutMs, env: runtime.env, command: runtime.command });
    if (!next.ready) { current = next; return null; }
    current = next; baseUrl = `http://127.0.0.1:${next.port}`;
    return baseUrl;
  };
  try {
    for (const [index, test] of tests.entries()) {
      progress({ stage: 'test', id: test.id, index: index + 1, total: tests.length });
      results.push(await runTest(test, baseUrl, { stepTimeoutMs, restart, double }));
      if (double) { providerOps.push(...double.calls().map((c) => c.op)); try { await double.reset(); } catch { /* the next test's provider expectations will report it */ } }
    }
  } finally {
    logs = await current.stop();
    runtime.cleanup?.();
  }
  // The same sentinel witness over the process's own output: a secret printed to a log is
  // observable too. Reported as a required result only when sentinels exist, so it can never be
  // satisfied vacuously and never applies to kinds that inject no secret.
  const sentinels = double?.sentinels?.() || [];
  if (sentinels.length) {
    const output = `${logs?.stdout || ''}\n${logs?.stderr || ''}`;
    const leaked = sentinels.filter((s) => output.includes(s.value)).map((s) => s.name);
    results.push({ id: 'output.no-secret-in-process-output', outcome: leaked.length ? 'failed' : 'passed', required: true, provesBehavior: 'sec.no-provider-secret-in-output', description: 'The application\'s stdout/stderr never contain an injected secret.',
      ...(leaked.length ? { reason: `secret ${leaked.join(', ')} appeared in process output` } : {}), steps: [{ name: 'process-output', request: 'stdout+stderr', status: null, checks: [{ name: 'noSecretsInProcessOutput', ok: !leaked.length, detail: leaked.length ? `leaked: ${leaked.join(', ')}` : `${sentinels.length} sentinel(s) absent from ${output.length} bytes of process output` }], ok: !leaked.length }] });
  }
  progress({ stage: 'decide' });

  const decision = decideHttpVerdict(results, { serverReady: true });
  const required = results.filter((r) => r.required);
  return {
    ...decision, ...base,
    finishedAt: new Date().toISOString(),
    behaviorCoverage: behavior.map((s) => ({
      id: s.id, text: s.text,
      provenBy: results.filter((r) => r.provesBehavior === s.id).map((r) => ({ id: r.id, outcome: r.outcome })),
    })),
    results,
    summary: {
      required: required.length,
      passed: required.filter((r) => r.outcome === 'passed').length,
      failed: required.filter((r) => r.outcome === 'failed').length,
      inconclusive: required.filter((r) => r.outcome === 'inconclusive').length,
    },
    process: { pid: server.pid, exit: logs?.exit ?? null, aliveAfterStop: logs?.alive ?? null },
    diagnostics: { stderr: (logs?.stderr || '').slice(-2000) },
    ...(double ? { providerDoubleCalls: providerOps } : {}),
  };
}

/** Whether a manifest's capability is verified against a provider double rather than a live provider. */
const needsDouble = (manifest) => manifest?.architecture?.capabilityModel?.kind === 'hosted-session-auth';

/** Run a suite with a provider double attached for the duration of the run, when the kind needs one. */
/**
 * Run `run(double, env)` with the capability's provider double started (when the capability needs
 * one) and the environment names the destination adapter reads. Exported so a host-preservation
 * check on an application that now HOLDS such a capability can boot it the way its verifier does.
 */
export async function withDouble(manifest, run) {
  if (!needsDouble(manifest)) return run(null, {});
  const model = manifest.architecture.capabilityModel;
  const double = await startProviderDouble({ endpoints: model.provider.endpoints });
  try {
    // Destination adapters read the provider through these names; the double fills them in.
    return await run(double, double.environment(DEFAULT_PROVIDER_ENV));
  } finally { await double.stop(); }
}

/**
 * A stall is not evidence. When the only thing an attempt learned is that something timed out —
 * the process never listened, or a step's transport timed out — and *nothing* was observed to
 * fail, the attempt is classified `transport-timeout` and exactly one more attempt is made with a
 * completely fresh process tree (the first is stopped, and its stop result is kept as evidence).
 * Any failed assertion, counterfactual, invariant witness or host-preservation probe means the
 * attempt is authoritative and is never retried. Nothing is written between attempts, the
 * verdict still comes only from decideVerdict on the evidence of the attempt that produced it,
 * and both attempts are reported.
 */
export const MAX_VERIFICATION_ATTEMPTS = 2;
const TIMEOUT_REASONS = new Set(['timeout-waiting-for-listen']);
export function classifyAttempt(report) {
  if (report.verdict !== NEEDS_REVIEW) return { retryable: false, classification: report.verdict === VERIFIED ? 'verified' : 'failed' };
  const results = report.results || [];
  if (results.some((r) => r.outcome === 'failed')) return { retryable: false, classification: 'failed-assertion' };
  if (results.length === 0) {
    if (TIMEOUT_REASONS.has(report.diagnostics?.reason)) return { retryable: true, classification: 'transport-timeout', detail: report.diagnostics.reason };
    return { retryable: false, classification: report.diagnostics?.reason || 'no-evidence' };
  }
  const inconclusive = results.filter((r) => r.outcome === 'inconclusive');
  const timeouts = inconclusive.filter((r) => /transport error .*(timeout|aborted)/i.test(r.reason || ''));
  if (inconclusive.length && timeouts.length === inconclusive.length) return { retryable: true, classification: 'transport-timeout', detail: `${timeouts.length} step timeout(s)` };
  return { retryable: false, classification: 'inconclusive' };
}

/** Captured application output and assertion details are portable evidence, never a secret store. */
export async function runAcceptanceSuite(options) {
  const attempts = [];
  let report = null;
  for (let attempt = 1; attempt <= MAX_VERIFICATION_ATTEMPTS; attempt += 1) {
    report = await runAcceptanceSuiteRaw(options);
    const classified = classifyAttempt(report);
    attempts.push({ attempt, verdict: report.verdict, classification: classified.classification, detail: classified.detail || null, summary: report.summary,
      startedAt: report.startedAt, finishedAt: report.finishedAt, process: report.process || null, rationale: report.rationale });
    if (!classified.retryable || attempt === MAX_VERIFICATION_ATTEMPTS) break;
    options.onProgress?.({ stage: 'retry', attempt: attempt + 1, reason: classified.classification });
  }
  return redactSecrets({ ...report, attempts, ...(attempts.length > 1 ? { retried: { count: attempts.length - 1, firstClassification: attempts[0].classification } } : {}) });
}

/**
 * Destination-side verification: boots the transplanted application and runs the
 * manifest's acceptance tests against it. Kept as the M1 entrypoint.
 */
// `atlas`: null (default) records nothing under GRAFT_HOME; 'local' or a directory records the
// observation in the Compatibility Atlas. Project-local compatibility history is always recorded.
/**
 * Host preservation, honestly: boot the destination exactly as it is before any file is written
 * and record what each preservation probe answers. The probes then expect *that* answer after
 * the transplant, not a generic list — a route the host already answered with 500 (no schema,
 * no database) is preserved when it still answers 500, and a route that answered 200 must
 * still answer 200. A destination that cannot boot yields no baseline; the probes keep their
 * generic expectations and the report says the baseline was not captured.
 */
export async function captureHostBaseline(destRoot, { entrypoint, tests = [], timeoutMs = 15000, stepTimeoutMs = STEP_TIMEOUT_MS } = {}) {
  const probes = tests.filter((t) => t.provesBehavior === 'host.preserved');
  if (!probes.length) return { captured: false, reason: 'no host-preservation probes', tests, observed: [] };
  const abs = path.resolve(destRoot);
  const fp = fingerprintProject(abs);
  const runtime = resolveRuntime({ ...fp, entrypoint: entrypoint ?? fp.entrypoint });
  if (!runtime.ok) return { captured: false, reason: runtime.reason, tests, observed: [] };
  // Booting an application can create files in its working directory (a local database, a
  // cache). They are the application's, not the transplant's: anything the boot creates that was
  // not there before is removed again, so the destination is byte-for-byte as it was.
  const before = untrackedFiles(abs);
  const server = await bootServer(runtime.cwd, runtime.entrypoint, { timeoutMs, env: runtime.env, command: runtime.command });
  if (!server.ready) { await server.stop(); removeBootArtefacts(abs, before); return { captured: false, reason: server.reason, tests, observed: [] }; }
  const observed = [];
  try {
    for (const t of probes) for (const step of t.steps) {
      if (step.method !== 'GET') continue;
      let status = null;
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}${step.path}`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(stepTimeoutMs) });
        status = res.status; await res.arrayBuffer().catch(() => null);
      } catch (err) { status = null; observed.push({ test: t.id, step: step.name, path: step.path, status: null, error: err.message }); continue; }
      observed.push({ test: t.id, step: step.name, path: step.path, status });
    }
  } finally { await server.stop(); }
  const artefacts = removeBootArtefacts(abs, before);
  const byKey = new Map(observed.filter((o) => o.status !== null).map((o) => [`${o.test}:${o.step}`, o.status]));
  const adjusted = tests.map((t) => (t.provesBehavior !== 'host.preserved' ? t : { ...t,
    description: `${t.description} (compared with the destination's own answers before the transplant)`,
    steps: t.steps.map((step) => { const status = byKey.get(`${t.id}:${step.name}`); return status === undefined ? step : { ...step, expect: { ...step.expect, status: [status] }, baseline: { status } }; }) }));
  return { captured: true, reason: null, tests: adjusted, observed, artefacts };
}

/** Untracked files in a git checkout (empty when not a checkout): the boot-artefact baseline. */
function untrackedFiles(root) {
  try { return new Set(execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--ignored=no'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 }).split('\n').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3).trim())); }
  catch { return null; }
}
/** Remove files the boot created (untracked now, absent before). Returns what was removed. */
function removeBootArtefacts(root, before) {
  if (!before) return [];
  const after = untrackedFiles(root) || new Set();
  const removed = [];
  for (const rel of after) {
    if (before.has(rel)) continue;
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
    // Only a regular file the boot created, reached without following any symlink: a link (or a
    // path through one) is never removed, so nothing outside the checkout can be touched.
    try {
      const real = fs.realpathSync(abs);
      if (real !== abs || fs.lstatSync(abs).isSymbolicLink() || !fs.lstatSync(abs).isFile()) continue;
      fs.rmSync(abs); removed.push(rel);
    } catch { /* already gone */ }
  }
  return removed;
}

/**
 * `recordKnowledge: false` computes the project-local compatibility observation but does not write it
 * into the destination: for a RE-verification of a revision that is already committed, the tree
 * must stay exactly what was verified, and the observation is kept by the caller's evidence instead.
 */
export async function verifyCapability(manifest, destRoot, { entrypoint, timeoutMs = 15000, stepTimeoutMs = STEP_TIMEOUT_MS, atlas = null, repair = null, extraTests = [], onProgress = null, recordKnowledge = true, provenance = null } = {}) {
  const abs = path.resolve(destRoot);
  const fp = fingerprintProject(abs);
  const entry = entrypoint ?? fp.entrypoint;
  // The destination revision this verification is about: the committed HEAD of a clean tree, read
  // BEFORE anything runs or is written. A dirty tree (an initial transplant, not yet committed) has
  // no revision authority and gets no proof envelope rather than a fabricated one.
  const destinationRevision = revisionAuthority(abs);
  const report = await withDouble(manifest, async (double, env) => {
    const runtime = resolveRuntime({ ...fp, entrypoint: entry });
    if (runtime.ok) runtime.env = { ...runtime.env, ...env };
    return runAcceptanceSuite({ runtime, tests: [...manifest.acceptanceTests.tests, ...extraTests], behavior: manifest.behavior.statements, timeoutMs, stepTimeoutMs, double, onProgress });
  });
  onProgress?.({ stage: 'record' });
  let compatibilityObservation = null, knowledgeRecordingError = null;
  try { compatibilityObservation = recordKnowledge ? recordCompatibilityObservation(manifest, fp, report) : (() => { const event = buildCompatibilityObservation(manifest, fp, report); return event ? { ...event, recorded: false } : null; })(); }
  catch (err) { knowledgeRecordingError = err.message; }
  // Engine 1.0 proof: project the report onto the capability's verification contract (the
  // verdict is decideVerdict's and is copied, never recomputed). Redact first, then bind: the
  // envelope commits to the persisted representation (proof-envelope.js). The Atlas entry is built
  // AFTER the envelope so it can cite the proof by digest; its own summary carries only ids.
  let proof = null;
  try {
    const artifacts = buildEngineArtifacts(manifest);
    // The recipe the plan applied is recorded in the transplant receipt (surfaced through the
    // compatibility observation); the proof contract carries it so the evidence names it.
    const applied = recipeById(compatibilityObservation?.recipeId || null);
    proof = evaluateVerificationContract(applied ? buildVerificationContract(manifest, artifacts.ir, { recipe: applied }) : artifacts.verificationContract, report);
  } catch { proof = null; }
  const sourceRevision = provenance?.sourceRevision ?? sourceRevisionOf(manifest);
  const finished = finishReport({ ...report, capability: manifest.identity.slug, destination: abs, entrypoint: entry, compatibilityObservation, ...(knowledgeRecordingError ? { knowledgeRecordingError } : {}), proof },
    { manifest, proof, provenance, source: { revision: sourceRevision }, destination: { ...destinationRevision, fingerprint: fp } });
  // Record the observation in the Compatibility Atlas, bound to the evidence it summarises.
  // Recording failures are reported, never treated as recorded.
  let atlasEntry = null, atlasRecordingError = null;
  try {
    if (atlas) {
      const artifacts = buildEngineArtifacts(manifest);
      const entry = buildAtlasEntry({ capabilityId: artifacts.genome.identity.capabilityId, capabilityCategory: manifest.identity.category, capabilityKind: artifacts.genome.identity.kind, genomeId: artifacts.genome.genomeId, recipeId: compatibilityObservation?.recipeId || null,
        sourceArchitecture: artifacts.genome.provenance.sourceArchitecture, destinationArchitecture: architectureSignature(fp),
        adaptations: structuralAdaptations(manifest, fp, { profile: compatibilityObservation?.adaptation || null, providerDouble: report.providerDouble?.injectedThrough || 'none' }),
        result: compatibilityObservation?.result || 'conditionally-supported',
        verification: { verdict: report.verdict, summary: report.summary, at: report.finishedAt },
        failureReasons: report.results.filter((r) => r.outcome !== 'passed').map((r) => `${r.id}:${r.outcome}`), repair: repair ? { ...repair, outcome: report.verdict } : null, at: report.finishedAt,
        sourceRevision, destinationRevision: destinationRevision.revision, proofEnvelopeDigest: finished.proofEnvelope?.digest ?? null,
        assumptions: compatibilityObservation?.reasons ? compatibilityObservation.reasons.map((c) => ({ id: c.code, status: c.status })) : null });
      atlasEntry = recordAtlasEntry(entry, typeof atlas === 'string' && atlas !== 'local' ? { directory: atlas } : {}).entry;
    }
  } catch (err) { atlasRecordingError = err.message; }
  return { ...finished, atlasEntry: atlasEntry ? { entryId: atlasEntry.entryId, result: atlasEntry.result } : null, ...(atlasRecordingError ? { atlasRecordingError } : {}) };
}

/**
 * The structural descriptors the Atlas records for how a capability was fitted into a host —
 * knowledge, never source. `profile` is the adaptation profile the plan applied. For a hosted
 * capability the Atlas also learns the credential-authority pattern, the session shape, the
 * registration strategy (first refusal inside a central handler, one guard middleware on an
 * Express app, or route registrations on a route table) and how verification reached the provider
 * double (`none` when no double stood in; omitted only when no verification ran at all). Shared by
 * destination verification and the Laboratory's assembly outcomes so the two never describe the
 * same adaptation in two vocabularies.
 */
export function structuralAdaptations(manifest, fp, { profile = null, providerDouble = null } = {}) {
  const model = manifest.architecture?.capabilityModel || {};
  return [...(profile ? [profile] : []),
    ...(model.kind === 'hosted-session-auth' ? [
      `credential-authority:${model.credentialAuthority.kind}`,
      `session:${model.session.transport}/${model.session.custody}/${model.session.store}`,
      `registration:${fp.central?.supported ? 'central-handler' : fp.expressGuard?.supported ? 'guard-middleware' : 'route-table'}`,
      ...(providerDouble ? [`verification:provider-double/${providerDouble}`] : []),
    ] : [])];
}

/**
 * Source-side verification: boots the project the capability is being harvested FROM
 * and runs the generated acceptance tests against it. This is what lets a manifest
 * truthfully say the organ worked before it was harvested.
 */
export async function verifySource(fp, manifest, { timeoutMs = 15000, stepTimeoutMs = STEP_TIMEOUT_MS } = {}) {
  const { acceptanceTests, behavior } = manifest;
  // The source revision this verification is about (a clean committed checkout), or null.
  const sourceRevision = revisionAuthority(fp.root);
  // A library has no server to boot: its acceptance suite runs against the artifact a consumer
  // loads. Same contract, same verdict authority, different way of observing behaviour.
  if (manifest.identity?.implementationForm === 'library') {
    const { runLibrarySuite } = await import('./library-runner.js');
    const report = await runLibrarySuite({ sourceRoot: fp.root, artifact: manifest.architecture.capabilityModel.artifact, tests: acceptanceTests.tests, behavior: behavior.statements, timeoutMs });
    let proof = null;
    try { proof = evaluateVerificationContract(buildEngineArtifacts(manifest).verificationContract, report); } catch { proof = null; }
    return finishReport({ ...report, source: { name: fp.name, root: fp.root }, proof }, { manifest, proof, source: { revision: sourceRevision.revision }, destination: null });
  }
  const report = await withDouble(manifest, async (double) => {
    const runtime = resolveRuntime(fp, { manifest, double });
    return runAcceptanceSuite({ runtime, tests: acceptanceTests.tests, behavior: behavior.statements, timeoutMs, stepTimeoutMs, double });
  });
  let proof = null;
  try { proof = evaluateVerificationContract(buildEngineArtifacts(manifest).verificationContract, report); } catch { proof = null; }
  return finishReport({ ...report, source: { name: fp.name, root: fp.root }, proof }, { manifest, proof, source: { revision: sourceRevision.revision }, destination: null });
}
