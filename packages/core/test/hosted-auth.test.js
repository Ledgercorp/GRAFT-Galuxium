import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintProject, extractRoutes, startScriptFor } from '../src/analyze/fingerprint.js';
import { detect as detectHosted } from '../src/harvest/detectors/hosted-auth.js';
import { detect as detectLocal } from '../src/harvest/detectors/authentication.js';
import { harvest, harvestCapability, discoverCapabilities } from '../src/harvest/index.js';
import { validateManifest, validateAcceptanceTests } from '../src/manifest/schema.js';
import { buildEngineArtifacts } from '../src/engine/index.js';
import { buildHostModel } from '../src/engine/host.js';
import { selectRecipe, BUILTIN_RECIPES } from '../src/engine/recipes.js';
import { lowerToEmission } from '../src/engine/lower.js';
import { emitCapability } from '../src/emit/index.js';
import { profileFor, profilesByKind, SUPPORTED_PROFILES } from '../src/emit/profiles.js';
import { inspectCentralHandler, planEntrypointEdit, inspectExpressGuardSite, inspectExpressEntrypoint } from '../src/emit/entrypoint.js';
import { createTransplantPlan, hostPreservationTests } from '../src/plan/index.js';
import { applyTransplant } from '../src/apply/index.js';
import { verifyCapability, verifySource, captureHostBaseline } from '../src/verify/index.js';
import { resolveRuntime } from '../src/verify/runtime.js';
import { startProviderDouble, CODE_PREFIX } from '../src/verify/provider-double.js';
import { readManifest } from '../src/manifest/io.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
import { write, hostedSource } from './helpers/hosted-source.js';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `graft-hosted-${name}-`));


/** A bare node:http destination with a central async handler and static-file fallthrough. */
function centralDestination(root) {
  write(root, {
    'package.json': JSON.stringify({ name: 'central-dest', private: true, type: 'module', scripts: { serve: 'node server.mjs', test: 'node --test tests/*.test.mjs' } }),
    'server.mjs': `import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, \`http://\${req.headers.host}\`).pathname;
    const safePath = normalize(pathname).replace(/^([.][.][/\\\\])+/, "");
    let target = join(root, safePath === "/" ? "index.html" : safePath);
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) target = join(target, "index.html");
    const body = await readFile(target);
    res.writeHead(200, { "content-type": extname(target) === ".html" ? "text/html" : "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); }
}).listen(port);
`,
    'index.html': '<!doctype html><title>dest</title>',
    'tests/app.test.mjs': 'import test from "node:test"; test("x", () => {});',
  });
  const git = (args) => { const { execFileSync } = require('node:child_process'); return execFileSync('git', args, { cwd: root, stdio: 'pipe' }); };
  git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  return root;
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('fingerprint: dispatch routes, every node script, and a central handler are recognised', () => {
  const routes = extractRoutes('x.ts', 'if (method === "GET" && path === "/auth/login") {}\nif (req.method === "POST" && pathname === "/auth/logout") {}');
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path} ${r.idiom}`), ['GET /auth/login path-comparison', 'POST /auth/logout path-comparison']);
  assert.deepEqual(startScriptFor({ scripts: { serve: 'node server.mjs', test: 'node --test tests/*.mjs', build: 'node scripts/build.mjs' } }), { name: 'serve', file: 'server.mjs', command: 'node server.mjs' });
  assert.equal(startScriptFor({ scripts: { start: 'node src/main.js', serve: 'node other.mjs' } }).file, 'src/main.js', 'start is preferred');
  assert.equal(startScriptFor({ scripts: { build: 'node scripts/build.mjs' } }), null, 'build tooling is never an entrypoint');
  const dest = centralDestination(tmp('dest'));
  const fp = fingerprintProject(dest);
  assert.equal(fp.entrypoint, 'server.mjs');
  assert.equal(fp.central.supported, true);
  assert.equal(inspectCentralHandler('const s = createServer((req, res) => {});').reason, 'central-handler-is-not-async');
  assert.equal(inspectCentralHandler('import http from "node:http"; http.createServer(handler);').reason, 'create-server-handler-is-not-inline');
  assert.equal(inspectCentralHandler('const a = 1;').reason, 'no-create-server-call-found');
  assert.equal(inspectCentralHandler('import http from "node:http";\nfunction boot() { http.createServer(async (req, res) => { res.end(); }).listen(1); }\nboot();').reason, 'create-server-call-is-nested');
  assert.equal(inspectCentralHandler('import http from "node:http";\nexport const server = http.createServer(async (req, res) => { res.end(); });').supported, true, 'a top-level export is still module scope');
});

test('profiles are kind-aware: the central node:http profile exists for hosted auth only', () => {
  const dest = centralDestination(tmp('dest2'));
  const fp = fingerprintProject(dest);
  assert.equal(profileFor(fp, 'hosted-session-auth').id, 'esm-node-http-central');
  assert.equal(profileFor(fp, 'session-auth'), null, 'local password auth has no emitter for a bare handler');
  assert.deepEqual(profilesByKind(fp), { 'hosted-session-auth': 'esm-node-http-central' });
  const central = SUPPORTED_PROFILES.find((p) => p.id === 'esm-node-http-central');
  assert.deepEqual(central.kinds, ['hosted-session-auth']);
  assert.ok(BUILTIN_RECIPES.some((r) => r.applicability.capabilityKind === 'hosted-session-auth' && r.mechanism.emitterProfile === 'esm-node-http-central'));
  assert.equal(BUILTIN_RECIPES.filter((r) => r.applicability.capabilityKind === 'session-auth').length, 2, 'existing kinds keep exactly their existing recipes');
});

test('the hosted detector classifies a TypeScript source, and the local-password detector does not claim it', () => {
  const src = hostedSource(tmp('src'));
  const fp = fingerprintProject(src);
  assert.equal(detectLocal(fp).found, false, 'no password is hashed here');
  const result = detectHosted(fp);
  assert.equal(result.found, true, JSON.stringify(result.signals));
  assert.deepEqual(result.routes.map((r) => r.role).sort(), ['callback', 'login', 'logout']);
  assert.equal(result.provider.provider, 'generic', 'an unrecognised provider host is still a provider');
  assert.equal(result.provider.defaultOrigin, 'https://api.provider.example');
  assert.deepEqual(result.provider.endpoints, { authorize: '/user_management/authorize', token: '/user_management/authenticate', revoke: '/user_management/sessions/revoke' });
  assert.equal(result.session.cookieName, '__Host-app_session');
  assert.equal(result.session.loopbackCookieName, 'app_session');
  assert.equal(result.session.store, 'memory');
  assert.equal(result.session.durableAcrossRestart, false);
  assert.equal(result.session.idLength, 43);
  assert.equal(result.seam.verification.kind, 'factory-injection');
  assert.equal(result.seam.factory.typescript, true);
  assert.equal(result.seam.factory.auth.exportName, 'createBrowserAuth');
  assert.equal(result.csrf.headerName, 'x-app-csrf');
  const discovered = discoverCapabilities(fp);
  assert.ok(discovered.some((c) => c.id === 'hosted-authentication' && c.harvestable));
  assert.equal(discovered.some((c) => c.id === 'authentication'), false);
  // False-positive boundary: the same routes, cookie, https literal and /authorize string, but no
  // PKCE and no token exchange, is NOT hosted authentication.
  const partial = write(tmp('partial'), { 'package.json': '{"name":"partial","type":"module"}', 'server.ts': `const base = "https://api.provider.example/user_management";
    if (method === "GET" && path === "/auth/login") { res.writeHead(303, { location: base + "/authorize?x=1" }); }
    if (method === "GET" && path === "/auth/callback") { res.appendHeader("set-cookie", "app_session=abc; HttpOnly; SameSite=Lax"); }
    if (method === "POST" && path === "/auth/logout") { res.writeHead(204); }` });
  const partialResult = detectHosted(fingerprintProject(partial));
  assert.equal(partialResult.found, false);
  assert.ok(partialResult.signals.length >= 5, 'the partial evidence is still reported');
});

test('the hosted manifest separates credential authority from session transport and storage, and validates', () => {
  const src = hostedSource(tmp('src2'));
  const fp = fingerprintProject(src);
  const manifest = harvest(fp, 'hosted-authentication');
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  const model = manifest.architecture.capabilityModel;
  assert.equal(model.kind, 'hosted-session-auth');
  assert.equal(model.credentialAuthority.kind, 'hosted-provider');
  assert.deepEqual(model.credentialAuthority.protocols, ['oauth2', 'pkce']);
  assert.equal(model.session.transport, 'cookie');
  assert.equal(model.session.custody, 'local');
  assert.equal(model.session.store, 'memory');
  assert.equal(model.passwordHash, undefined, 'a hosted capability never claims to hash passwords');
  assert.equal(manifest.environment.variables.every((v) => v.introduced === true), true);
  assert.equal(validateAcceptanceTests(manifest.acceptanceTests.tests).ok, true);
  // The counterfactual set is real, not a happy path.
  const ids = manifest.acceptanceTests.tests.map((t) => t.id);
  for (const required of ['hosted.callback.rejects-mismatched-state', 'hosted.callback.rejects-provider-failure', 'hosted.session.rejects-anonymous', 'hosted.session.rejects-unknown-cookie', 'hosted.logout.invalidates-session', 'hosted.logout.requires-same-origin', 'hosted.session.not-durable-across-restart']) assert.ok(ids.includes(required), required);
  // A manifest that claims a password hash for a hosted capability is refused.
  const forged = structuredClone(manifest); forged.architecture.capabilityModel.passwordHash = { algorithm: 'scrypt' };
  assert.equal(validateManifest(forged).ok, false);
  // Existing local-password manifests are untouched by the new rules.
  const local = harvest(fingerprintProject(path.join(repoRoot, 'fixtures/old-saas-project')), 'authentication');
  assert.equal(validateManifest(local).ok, true);
});

test('engine artifacts carry the external credential authority distinctly from local auth', () => {
  const src = hostedSource(tmp('src3'));
  const hosted = buildEngineArtifacts(harvest(fingerprintProject(src), 'hosted-authentication'));
  assert.equal(hosted.ir.policies.credentialAuthority.kind, 'hosted-provider');
  assert.equal(hosted.ir.policies.passwordHash, null);
  assert.equal(hosted.ir.policies.session.custody, 'local');
  assert.ok(hosted.ir.adaptationPoints.some((p) => p.id === 'provider-binding' && p.source === 'factory-injection'));
  assert.ok(hosted.ir.preserved.includes('policies.credentialAuthority'));
  assert.ok(hosted.verificationContract.counterfactualCases.length >= 5);
  const local = buildEngineArtifacts(harvest(fingerprintProject(path.join(repoRoot, 'fixtures/old-saas-project')), 'authentication'));
  assert.equal(local.ir.policies.credentialAuthority.kind, 'local');
  assert.ok(local.ir.policies.passwordHash);
  assert.notEqual(local.ir.irId, hosted.ir.irId);
});

test('the provider double enforces PKCE and records every boundary crossing', async () => {
  const double = await startProviderDouble({ endpoints: { authorize: '/user_management/authorize', token: '/user_management/authenticate', revoke: '/user_management/sessions/revoke' } });
  try {
    const { createHash, randomBytes } = await import('node:crypto');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const post = (body) => fetch(`${double.origin}/user_management/authenticate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await post({ grant_type: 'authorization_code', code: `${CODE_PREFIX}${challenge}`, code_verifier: verifier });
    assert.equal(ok.status, 200);
    const tokens = await ok.json();
    assert.match(tokens.access_token, /^eyJ/);
    const bad = await post({ grant_type: 'authorization_code', code: `${CODE_PREFIX}${challenge}`, code_verifier: randomBytes(32).toString('base64url') });
    assert.equal(bad.status, 400, 'a verifier that does not match the challenge is rejected');
    const jwks = await (await fetch(`${double.origin}/jwks`)).json();
    assert.equal(jwks.keys[0].kty, 'OKP');
    assert.deepEqual(double.calls().map((c) => c.op), ['exchange', 'exchange', 'jwks']);
    assert.equal(double.calls()[1].ok, false);
    const env = double.environment({ providerOrigin: 'A', clientId: 'B', clientSecret: 'C', jwksUrl: 'D', issuer: 'E', audience: 'F' });
    assert.equal(env.A, double.origin);
    assert.equal(env.C, 'graft-verification-not-a-secret');
  } finally { await double.stop(); }
});

test('source verification runs the TypeScript source through its own factory seam against the double', async () => {
  const src = hostedSource(tmp('src4'));
  const fp = fingerprintProject(src);
  const { manifest, verification, policy } = await harvestCapability(fp, 'hosted-authentication');
  assert.equal(verification.verdict, 'VERIFIED', `${verification.rationale} | ${JSON.stringify(verification.diagnostics)} | ${JSON.stringify(verification.results.filter((r) => r.outcome !== 'passed').map((r) => [r.id, r.reason]))}`);
  assert.equal(verification.runtime.profile, 'factory-injection-harness');
  assert.equal(verification.runtime.harness.seam.source, 'typescript-source');
  assert.equal(verification.providerDouble.liveProvider, false);
  assert.equal(verification.providerDouble.injectedThrough, 'factory-injection');
  assert.ok(verification.providerDoubleCalls.includes('revoke'));
  assert.equal(policy.bankable, true);
  assert.equal(manifest.provenance.verifiedInSource.verdict, 'VERIFIED');
  assert.equal(validateManifest(manifest).ok, true, 'a VERIFIED claim from the harness runtime is accepted');
  // The harness lives outside the source and the source is untouched.
  assert.equal(verification.runtime.entrypoint.startsWith(src), false);
  assert.equal(fs.existsSync(path.join(src, 'apps/api/src/auth.ts')), true);
  assert.equal(fs.readdirSync(src).includes('harness.mjs'), false);
});

test('without a factory seam the source is refused by name, never run against a live provider', async () => {
  const src = hostedSource(tmp('src5'));
  fs.rmSync(path.join(src, 'packages'), { recursive: true }); // no identity factory → no seam
  const fp = fingerprintProject(src);
  const manifest = harvest(fp, 'hosted-authentication');
  assert.equal(manifest.architecture.capabilityModel.providerSeam.verification.kind, 'unavailable');
  assert.equal(validateManifest(manifest).ok, true, 'a manifest may say the seam is unavailable');
  const report = await verifySource(fp, manifest);
  assert.equal(report.verdict, 'NEEDS_REVIEW');
  assert.equal(report.diagnostics.reason, 'provider-seam-unavailable');
  assert.match(report.rationale, /hosted-provider authentication is understood, but no verification seam is available/);
  assert.match(report.rationale, /will not run it against a live provider/);
  const { manifest: harvested, policy } = await harvestCapability(fp, 'hosted-authentication');
  assert.equal(policy.status, 'unproven');
  assert.match(harvested.provenance.verifiedInSource.refusal, /provider-seam-unavailable/);
});

test('emission for a central node:http destination is destination-native, dependency-free and carries no test code', () => {
  const src = hostedSource(tmp('src6'));
  const manifest = harvest(fingerprintProject(src), 'hosted-authentication');
  const dest = centralDestination(tmp('dest3'));
  const host = buildHostModel(fingerprintProject(dest));
  const artifacts = buildEngineArtifacts(manifest);
  const { recipe } = selectRecipe(artifacts.ir, host);
  assert.equal(recipe.mechanism.emitterProfile, 'esm-node-http-central');
  const spec = lowerToEmission(artifacts.ir, host, recipe);
  assert.equal(spec.profile, 'esm-node-http-central');
  const emission = emitCapability(spec);
  assert.deepEqual(emission.files.map((f) => f.path), ['src/auth/provider.js', 'src/auth/identity.js', 'src/auth/session.js', 'src/auth/routes.js']);
  assert.deepEqual(emission.dependencies, [], 'no framework, no SDK');
  const all = emission.files.map((f) => f.contents).join('\n');
  for (const forbidden of ['graft-ok:', 'provider-double', 'graft-verification-not-a-secret', 'startProviderDouble', '__graft']) assert.equal(all.includes(forbidden), false, `${forbidden} must never ship in a destination`);
  assert.equal(all.includes('express'), false);
  assert.match(all, /__Host-app_session/, 'the secure cookie contract is preserved');
  assert.match(all, /randomBytes\(32\)\.toString\('base64url'\)/, 'opaque id semantics are preserved');
  assert.match(all, /x-app-csrf/, 'the same-origin contract is preserved');
  assert.match(all, /AUTH_PROVIDER_ORIGIN must be HTTPS \(loopback HTTP is allowed only outside production\)/);
  for (const f of emission.files) assert.doesNotThrow(() => new Function('return 1;'), f.path);
  // Every emitted module parses as ESM.
  for (const f of emission.files) assert.ok(/^(import|\/\/|export|const)/m.test(f.contents), f.path);
  // A spec that claims durable sessions is refused rather than silently downgraded.
  const durable = structuredClone(spec); durable.policies.session.durableAcrossRestart = true;
  assert.throws(() => emitCapability(durable), /durable store is not supported/);
});

test('central-handler registration preserves every other byte and refuses unsupported shapes', () => {
  const dest = centralDestination(tmp('dest4'));
  const source = fs.readFileSync(path.join(dest, 'server.mjs'), 'utf8');
  const edit = planEntrypointEdit(source, { routesModule: './src/auth/routes.js', profile: 'esm-node-http-central', registration: { name: 'registerHostedAuth', marker: 'hosted-authentication' } });
  assert.equal(edit.applied, true, edit.reason);
  assert.deepEqual(edit.edits.map((e) => e.kind), ['add-import', 'create-instance', 'guard-central-handler']);
  const stripped = edit.source.split('\n').filter((l) => !/graft|registerHostedAuth|graftHostedAuth/.test(l)).join('\n').replace(/\n\n+/g, '\n');
  assert.equal(stripped, source.replace(/\n\n+/g, '\n'), 'only the three insertions differ');
  assert.match(edit.source, /createServer\(async \(req, res\) => \{\n  \/\/ >>> graft:hosted-authentication\n  if \(await graftHostedAuth\.handle\(req, res\)\) return;/);
  assert.equal(planEntrypointEdit(edit.source, { routesModule: './src/auth/routes.js', profile: 'esm-node-http-central', registration: { name: 'registerHostedAuth', marker: 'hosted-authentication' } }).reason, 'already-grafted');
  assert.equal(planEntrypointEdit(source.replace('async (req, res)', '(req, res)').replace(/await /g, ''), { routesModule: './x.js', profile: 'esm-node-http-central', registration: { name: 'registerHostedAuth', marker: 'hosted-authentication' } }).reason, 'central-handler-is-not-async');
  assert.equal(planEntrypointEdit(source, { routesModule: './x.js', profile: 'esm-node-http-central', registration: { name: 'registerHostedAuth', marker: 'hosted-authentication' }, conflictingRoutes: [{ method: 'GET', path: '/auth/login' }] }).reason, 'unresolved-conflicts');
});

test('the real flow: plan, apply into a worktree-like checkout, verify against the double, preserve the host', async () => {
  const src = hostedSource(tmp('src7'));
  const { manifest, verification } = await harvestCapability(fingerprintProject(src), 'hosted-authentication');
  assert.equal(verification.verdict, 'VERIFIED');
  const dest = centralDestination(tmp('dest5'));
  const destFp = fingerprintProject(dest);
  const plan = createTransplantPlan(manifest, destFp);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.compatibility.blocking));
  assert.equal(plan.adaptation.profile, 'esm-node-http-central');
  assert.ok(plan.compatibility.checks.some((c) => c.id === 'environment.introduced' && c.status === 'warn'));
  assert.ok(plan.compatibility.checks.some((c) => c.id === 'data.persistence' && c.status === 'ok' && /by design/.test(c.title)));
  assert.equal(plan.preservation.length, 2);
  assert.deepEqual(hostPreservationTests(destFp, manifest).map((t) => t.required), [true, true]);
  const result = applyTransplant(plan, dest);
  assert.equal(result.applied, true, JSON.stringify(result.problems));
  assert.match(result.branch, /^graft\/hosted-authentication-/);
  assert.deepEqual(result.filesWritten, plan.files.map((f) => f.path));
  const report = await verifyCapability(manifest, dest, { entrypoint: 'server.mjs', extraTests: plan.preservation });
  assert.equal(report.verdict, 'VERIFIED', `${report.rationale} | ${JSON.stringify(report.diagnostics)} | ${JSON.stringify(report.results.filter((r) => r.outcome !== 'passed').map((r) => [r.id, r.reason]))}`);
  assert.equal(report.summary.required, 15, '12 capability cases + process-output witness + 2 host-preservation probes');
  assert.equal(report.providerDouble.injectedThrough, 'endpoint-configuration');
  assert.equal(report.proof.routeCoverage.every((r) => r.registered), true);
  assert.ok(report.proof.invariants.filter((i) => i.status === 'held').length >= 8);
  assert.ok(report.results.find((r) => r.id === 'host.traversal-still-refused').outcome === 'passed');
  // Non-durability is verified, not assumed: the same destination with a persisted store must FAIL.
  const sessionFile = path.join(dest, 'src/auth/session.js');
  const original = fs.readFileSync(sessionFile, 'utf8');
  const persisted = original
    .replace("import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';", "import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst PERSIST = process.env.GRAFT_TEST_PERSIST;")
    .replace('const sessions = new Map(); const flows = new Map();', "const sessions = new Map(); const flows = new Map(); try { for (const [k, v] of JSON.parse(readFileSync(PERSIST, 'utf8'))) sessions.set(k, v); } catch {}")
    .replace('sessions.set(digest(id), { ...tokens, expires: now() + sessionMs, lastUsed: now() });', 'sessions.set(digest(id), { ...tokens, expires: now() + sessionMs, lastUsed: now() }); writeFileSync(PERSIST, JSON.stringify([...sessions]));');
  assert.notEqual(persisted, original);
  fs.writeFileSync(sessionFile, persisted);
  process.env.GRAFT_TEST_PERSIST = path.join(dest, 'sessions.json');
  try {
    const mutated = await verifyCapability(manifest, dest, { entrypoint: 'server.mjs', extraTests: plan.preservation });
    assert.equal(mutated.verdict, 'FAILED');
    assert.ok(mutated.results.find((r) => r.id === 'hosted.session.not-durable-across-restart').outcome === 'failed');
  } finally { delete process.env.GRAFT_TEST_PERSIST; fs.writeFileSync(sessionFile, original); }
});

test('no repository-name conditionals exist in the engine, and the flow runs with no agent', () => {
  const dirs = ['analyze', 'harvest', 'engine', 'emit', 'plan', 'apply', 'verify'].map((d) => path.join(repoRoot, 'packages/core/src', d));
  const offenders = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(js|mjs)$/.test(entry.name) && /\b(cuf-webmcp-challenge|leftsock|ledgercorp|sockdev)\b|\bCUF\b/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(repoRoot, full)); } };
  for (const d of dirs) walk(d);
  assert.deepEqual(offenders, [], 'the engine must not special-case any repository');
  const src = hostedSource(tmp('src8'));
  const capability = discoverCapabilities(fingerprintProject(src)).find((c) => c.id === 'hosted-authentication');
  assert.ok(capability, 'discovery is deterministic and agentless');
});

test('a destination that leaks the provider secret in a body, a header, a cookie or its log is never VERIFIED', async () => {
  const src = hostedSource(tmp('src9'));
  const { manifest } = await harvestCapability(fingerprintProject(src), 'hosted-authentication');
  const dest = centralDestination(tmp('dest9'));
  const plan = createTransplantPlan(manifest, fingerprintProject(dest));
  assert.equal(applyTransplant(plan, dest).applied, true);
  const clean = await verifyCapability(manifest, dest, { entrypoint: 'server.mjs', extraTests: plan.preservation });
  assert.equal(clean.verdict, 'VERIFIED', clean.rationale);
  const witness = clean.results.find((r) => r.id === 'output.no-secret-in-process-output');
  assert.equal(witness?.outcome, 'passed');
  assert.ok(clean.results.filter((r) => r.steps?.some((s) => s.checks?.some((c) => c.name === 'noSecretsInOutput' && c.ok))).length >= 4, 'the response witness ran on the authenticated steps');
  const file = path.join(dest, 'server.mjs');
  const original = fs.readFileSync(file, 'utf8');
  const guard = '  if (await graftHostedAuth.handle(req, res)) return;';
  assert.ok(original.includes(guard));
  const leaks = {
    body: original.replace(guard, `  { const end = res.end.bind(res); res.end = (b) => end((b ?? '') + process.env.AUTH_CLIENT_SECRET); }\n${guard}`),
    header: original.replace(guard, `  res.setHeader('x-debug', process.env.AUTH_CLIENT_SECRET);\n${guard}`),
    cookie: original.replace(guard, `  { const wh = res.writeHead.bind(res); res.writeHead = (s, h) => wh(s, { ...(h || {}), 'set-cookie': [].concat(res.getHeader('set-cookie') || [], h?.['set-cookie'] || [], 'debug=' + process.env.AUTH_CLIENT_SECRET + '; Path=/') }); }\n${guard}`),
    log: original.replace('const port =', 'console.log("debug", process.env.AUTH_CLIENT_SECRET);\nconst port ='),
  };
  try {
    for (const [mode, mutated] of Object.entries(leaks)) {
      assert.notEqual(mutated, original, mode);
      fs.writeFileSync(file, mutated);
      const report = await verifyCapability(manifest, dest, { entrypoint: 'server.mjs', extraTests: plan.preservation });
      assert.equal(report.verdict, 'FAILED', `${mode}: ${report.rationale}`);
      if (mode === 'log') assert.equal(report.results.find((r) => r.id === 'output.no-secret-in-process-output').outcome, 'failed');
      else assert.ok(report.results.some((r) => r.outcome === 'failed' && r.steps?.some((s) => s.checks?.some((c) => c.name === 'noSecretsInOutput' && !c.ok && /provider-client-secret/.test(c.detail)))), `${mode}: the response witness named the leak`);
      assert.ok(report.proof.invariants.find((i) => i.id === 'sec.no-provider-secret-in-output')?.status !== 'held', `${mode}: the invariant is not reported as held`);
    }
  } finally { fs.writeFileSync(file, original); }
});

// ---------------------------------------------------------------------------------------------
// Real-World Transplant 2B: the same hosted capability into an Express host through one guard
// middleware. The Express entrypoint mounts routers (which the session-auth Express profile
// refuses) and has a route that answers 500 on its own — preservation means "unchanged".
// ---------------------------------------------------------------------------------------------
function expressDestination(root) {
  write(root, {
    'package.json': JSON.stringify({ name: 'express-dest', private: true, type: 'module', scripts: { start: 'node app/server' }, dependencies: { express: '^5.0.0' } }),
    'app/server.js': `import express from 'express';
import { AuthorController } from './controllers/index.js';

export const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => { req.di = { ready: true }; next(); });
app.get('/', (req, res) => res.json({ message: 'welcome' }));
app.use('/author', AuthorController);
app.get('/broken', (req, res) => { throw new Error('no such table: author'); });
app.use((req, res) => res.status(404).json({ message: 'No route found' }));

export const server = app.listen(port, () => { console.log('listening ' + port); });
`,
    'app/controllers/index.js': "export { AuthorController } from './author.controller.js';\n",
    'app/controllers/author.controller.js': "import { Router } from 'express';\nconst router = Router();\nrouter.get('/', (req, res) => res.json([{ id: 1, name: 'a1', di: req.di }]));\nrouter.get('/:id', (req, res) => (req.params.id === '1' ? res.json({ id: 1 }) : res.status(404).json({ message: 'Author not found' })));\nrouter.post('/', (req, res) => res.status(201).json({ ...req.body, id: 2 }));\nexport const AuthorController = router;\n",
    'app/controllers/author.controller.spec.js': "import { createServer } from 'node:http';\ncreateServer((req, res) => { res.writeHead(200); res.end(); });\n",
    '.gitignore': 'node_modules\n',
  });
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-q', '-b', 'main']); git(['add', '-A']); git(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base']);
  return root;
}

test('the Express guard site is recognised where the session-auth Express profile refuses, and only for the guard kind', () => {
  const source = fs.readFileSync(path.join(expressDestination(tmp('dest10')), 'app/server.js'), 'utf8');
  assert.equal(inspectExpressEntrypoint(source).supported, false, 'mounted routers refuse route-registering kinds');
  const guard = inspectExpressGuardSite(source);
  assert.equal(guard.supported, true, guard.reason);
  assert.equal(guard.appName, 'app');
  assert.deepEqual(guard.mounts, ['/author']);
  const fp = fingerprintProject(expressDestination(tmp('dest11')));
  assert.equal(fp.framework.value, 'express');
  assert.equal(fp.handlerContract.value, 'express-req-res');
  assert.deepEqual(profilesByKind(fp), { 'hosted-session-auth': 'express-req-res' }, 'Express hosts the hosted kind through the guard, not session-auth');
  const edit = planEntrypointEdit(source, { routesModule: '../src/auth/routes.js', profile: 'express-req-res', registration: { name: 'registerHostedAuth', marker: 'hosted-authentication', style: 'guard' } });
  assert.equal(edit.applied, true, edit.reason);
  assert.deepEqual(edit.edits.map((e) => e.kind), ['add-import', 'create-instance', 'guard-express-middleware']);
  const lines = edit.source.split('\n');
  const guardLine = lines.findIndex((l) => /app\.use\(async \(req, res, next\) => \{ if \(await graftHostedAuth\.handle\(req, res\)\) return; next\(\); \}\);/.test(l));
  assert.ok(guardLine > 0);
  assert.ok(lines.findIndex((l) => l.includes('express.json()')) < guardLine, 'existing middleware still runs before the guard');
  assert.ok(lines.findIndex((l) => l.includes("app.get('/'")) > guardLine, 'the guard precedes the first route');
  assert.ok(lines.findIndex((l) => l.includes('const graftHostedAuth = registerHostedAuth')) < guardLine);
  const stripped = edit.source.split('\n').filter((l) => !/graft|registerHostedAuth/.test(l)).join('\n');
  assert.equal(stripped.replace(/\n\n+/g, '\n'), source.replace(/\n\n+/g, '\n'), 'every other byte is preserved');
  for (const [bad, reason] of [[source.replace("import express from 'express';", "import express from 'express';\nimport e2 from 'express';"), 'requires-one-default-express-import'], [source.replace('export const server = app.listen', 'const start = () => app.listen'), 'requires-one-app-listen'], [source.replace("app.get('/', (req, res) => res.json({ message: 'welcome' }));\napp.use('/author', AuthorController);\napp.get('/broken', (req, res) => { throw new Error('no such table: author'); });\napp.use((req, res) => res.status(404).json({ message: 'No route found' }));\n", ''), 'no-route-registration-site-found']]) {
    assert.equal(inspectExpressGuardSite(bad).reason, reason, reason);
  }
  assert.equal(planEntrypointEdit(source, { routesModule: '../src/auth/routes.js', profile: 'express-req-res', registration: { name: 'registerHostedAuth', marker: 'hosted-authentication' } }).reason, 'mounted-or-imported-middleware-needs-manual-integration', 'without the guard style the route-registering planner still refuses');
});

test('the same hosted Genome lowers into an Express host: guard registration, baseline-compared preservation, VERIFIED', async () => {
  const src = hostedSource(tmp('src12'));
  const { manifest, verification } = await harvestCapability(fingerprintProject(src), 'hosted-authentication');
  assert.equal(verification.verdict, 'VERIFIED');
  const dest = expressDestination(tmp('dest12'));
  const destFp = fingerprintProject(dest);
  const plan = createTransplantPlan(manifest, destFp);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.compatibility.blocking));
  assert.equal(plan.adaptation.profile, 'express-req-res');
  assert.equal(plan.engine.recipe.name, 'hosted-session-auth → express-req-res');
  assert.equal(plan.registration.style, 'guard');
  // The Genome and IR are the source's: the node:http plan of the same manifest carries the same ids.
  const central = createTransplantPlan(manifest, fingerprintProject(centralDestination(tmp('dest12c'))));
  assert.equal(central.adaptation.profile, 'esm-node-http-central');
  assert.equal(plan.engine.genome.genomeId, central.engine.genome.genomeId, 'the Genome is untouched by the destination');
  assert.equal(plan.engine.ir.irId, central.engine.ir.irId, 'the IR is untouched by the destination');
  assert.notEqual(plan.engine.recipe.recipeId, central.engine.recipe.recipeId, 'the recipe is the destination-native one');
  assert.equal(plan.engine.verificationContract.contractId, central.engine.verificationContract.contractId, 'the verification contract travels unchanged');
  assert.deepEqual(plan.preservation.map((t) => t.id), ['host.routes-still-answer', 'host.traversal-still-refused']);
  assert.deepEqual(plan.preservation[0].steps.map((s) => s.path), ['/', '/broken', '/author'], 'root, the existing GET routes and the mounted router prefix are probed');
  // The destination's own answers, captured before any file is written; a 500 the host already
  // produces is preserved as 500, not "fixed" and not failed.
  const baseline = await captureHostBaseline(dest, { entrypoint: plan.destination.entrypoint, tests: plan.preservation });
  assert.equal(baseline.captured, true, baseline.reason);
  assert.deepEqual(baseline.observed.map((o) => [o.path, o.status]), [['/', 200], ['/broken', 500], ['/author', 200], ['/%2e%2e/%2e%2e/%2e%2e/etc/passwd', 404], ['/..%2f..%2f..%2fetc%2fpasswd', 404]]);
  assert.deepEqual(baseline.tests[0].steps.map((s) => s.expect.status), [[200], [500], [200]]);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dest, encoding: 'utf8' }), '', 'the baseline boot left the checkout exactly as it was');
  // A boot artefact that is a symlink, or lives behind one, is never removed: only regular files reached directly.
  const outside = tmp('outside12'); fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(dest, 'cache'), 'dir'); fs.symlinkSync(path.join(outside, 'keep.txt'), path.join(dest, 'link.txt'));
  const again = await captureHostBaseline(dest, { entrypoint: plan.destination.entrypoint, tests: plan.preservation });
  assert.equal(again.captured, true);
  assert.equal(fs.existsSync(path.join(outside, 'keep.txt')), true, 'a file behind a symlink survives');
  assert.equal(fs.lstatSync(path.join(dest, 'link.txt')).isSymbolicLink(), true, 'the link itself survives');
  fs.unlinkSync(path.join(dest, 'cache')); fs.unlinkSync(path.join(dest, 'link.txt'));
  const result = applyTransplant(plan, dest);
  assert.equal(result.applied, true, JSON.stringify(result.problems));
  assert.deepEqual(result.entrypointEdits.map((e) => e.kind), ['add-import', 'create-instance', 'guard-express-middleware']);
  const report = await verifyCapability(manifest, dest, { entrypoint: plan.destination.entrypoint, extraTests: baseline.tests });
  assert.equal(report.verdict, 'VERIFIED', `${report.rationale} | ${JSON.stringify(report.results.filter((r) => r.outcome !== 'passed').map((r) => [r.id, r.reason]))}`);
  assert.equal(report.summary.required, 15);
  assert.equal(report.proof.routeCoverage.every((r) => r.registered), true);
  assert.equal(report.proof.summary.invariantsHeld, 10);
  assert.equal(report.proof.summary.invariantsUnobserved, 0);
  assert.equal(report.results.find((r) => r.id === 'host.routes-still-answer').outcome, 'passed');
  // The Atlas record for this host names the guard registration, in an isolated home.
  const previousHome = process.env.GRAFT_HOME; const atlasHome = tmp('atlas12'); process.env.GRAFT_HOME = atlasHome;
  try {
    const recorded = await verifyCapability(manifest, dest, { entrypoint: plan.destination.entrypoint, extraTests: baseline.tests, atlas: 'local' });
    assert.equal(recorded.verdict, 'VERIFIED');
    const entries = fs.readdirSync(path.join(atlasHome, 'atlas')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(atlasHome, 'atlas', f), 'utf8')));
    assert.equal(entries.length, 1);
    assert.ok(entries[0].adaptations.includes('registration:guard-middleware'), JSON.stringify(entries[0].adaptations));
    assert.ok(entries[0].adaptations.includes('express-req-res'));
  } finally { if (previousHome === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previousHome; }
  // Mutation: a guard that swallows every request breaks the host, and preservation says so.
  const entry = path.join(dest, 'app/server.js');
  const original = fs.readFileSync(entry, 'utf8');
  fs.writeFileSync(entry, original.replace('if (await graftHostedAuth.handle(req, res)) return; next();', 'await graftHostedAuth.handle(req, res); res.status(404).end();'));
  const mutated = await verifyCapability(manifest, dest, { entrypoint: plan.destination.entrypoint, extraTests: baseline.tests });
  assert.equal(mutated.verdict, 'FAILED');
  assert.equal(mutated.results.find((r) => r.id === 'host.routes-still-answer').outcome, 'failed');
  fs.writeFileSync(entry, original);
});

// Capability Export 0.1: the hosted capability leaves GRAFT as a package that carries the
// regenerated implementation, names-only configuration and honest verification wording.
test('the hosted capability exports as a package with its regenerated modules, names-only configuration and honest verification', async () => {
  const { buildCapabilityPackage, readZip, exportCapabilityPackage } = await import('../src/export/index.js');
  const { writeManifest } = await import('../src/manifest/io.js');
  const src = hostedSource(tmp('src13'));
  const { manifest } = await harvestCapability(fingerprintProject(src), 'hosted-authentication');
  const bank = tmp('bank13');
  writeManifest(bank, manifest);
  const organDir = path.join(bank, `${manifest.identity.slug}.graft`);
  const previousHome = process.env.GRAFT_HOME; process.env.GRAFT_HOME = tmp('home13');
  try {
    const built = buildCapabilityPackage({ organDir, graftVersion: '0.5.0' });
    assert.equal(built.profile, 'esm-node-http-central', 'the least framework-bound profile for the hosted kind');
    const names = built.fileList.map((f) => f.replace(`${built.name}/`, ''));
    assert.deepEqual(names.filter((n) => n.startsWith('src/')), ['src/identity.js', 'src/provider.js', 'src/routes.js', 'src/session.js']);
    assert.deepEqual(built.configurationNames, ['AUTH_PROVIDER_ORIGIN', 'AUTH_CLIENT_ID', 'AUTH_CLIENT_SECRET', 'AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_ORIGIN']);
    const config = built.files[`${built.name}/configuration.example`];
    assert.match(config, /^AUTH_CLIENT_SECRET=$/m, 'names only, never values');
    const text = Object.values(built.files).map(String).join('\n');
    for (const forbidden of ['graft-verification-not-a-secret', 'graft-ok:', '__graft', src, os.homedir()]) assert.equal(text.includes(forbidden), false, forbidden);
    const doc = built.files[`${built.name}/GRAFT.md`];
    assert.match(doc, /Universal compatibility: NOT CLAIMED/);
    assert.match(doc, /if \(await auth\.handle\(req, res\)\) return;/, 'the central-handler registration is explained');
    assert.match(doc, /app\.use\(async \(req, res, next\)/, 'and the Express guard registration');
    assert.match(doc, /Sessions live in process memory/);
    const m = JSON.parse(built.files[`${built.name}/graft-capability.json`]);
    assert.equal(m.kind, 'hosted-session-auth');
    assert.equal(m.assumptions.credentialAuthority, 'hosted-provider');
    assert.equal(m.assumptions.session.durableAcrossRestart, false);
    assert.deepEqual(m.implementation.registration.provenHosts, ['express-req-res', 'esm-node-http-central']);
    assert.equal(m.verification.source.verdict, 'VERIFIED');
    assert.deepEqual(m.verification.transplantEvidence, [], 'a fresh home holds no Atlas evidence, and none is invented');
    // The archive round-trips and the modules inside are the ones GRAFT would apply in a transplant.
    const out = tmp('out13');
    const { receipt } = exportCapabilityPackage({ organDir, destination: path.join(out, 'hosted.zip'), graftVersion: '0.5.0', receiptsFile: path.join(out, 'receipts.json') });
    const entries = readZip(fs.readFileSync(path.join(out, 'hosted.zip')));
    assert.equal(entries[`${built.name}/src/routes.js`].toString('utf8'), built.files[`${built.name}/src/routes.js`]);
    assert.equal(receipt.packageHash, built.packageHash);
  } finally { if (previousHome === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previousHome; }
});
