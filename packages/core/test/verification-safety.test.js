import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintProject } from '../src/analyze/fingerprint.js';
import { bootServer } from '../src/verify/http-runner.js';
import { nodeCommand, resolveRuntime } from '../src/verify/runtime.js';
import { runAcceptanceSuite, verifyCapability, verifySource } from '../src/verify/index.js';

const FAST = { timeoutMs: 3000, stepTimeoutMs: 500 };
const BASIC_SERVER = `require('node:http').createServer((req, res) => res.end('{}')).listen(process.env.PORT, '127.0.0.1');`;
const behavior = { statements: [{ id: 'responds', text: 'Responds to HTTP requests.' }] };
const acceptanceTests = { tests: [{ id: 'http.responds', kind: 'http', required: true, provesBehavior: 'responds',
  steps: [{ name: 'request', method: 'GET', path: '/', expect: { status: 200 } }] }] };
const manifest = { identity: { slug: 'test-capability' }, behavior, acceptanceTests };

function project(source = BASIC_SERVER) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-verification-'));
  const root = path.join(work, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'verification-fixture', main: 'server.cjs', scripts: { start: 'node server.cjs' } }));
  fs.writeFileSync(path.join(root, 'server.cjs'), source);
  return { work, root, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('destination verification refuses escaped and symlinked entrypoints without executing them', async () => {
  const fixture = project();
  try {
    const marker = path.join(fixture.work, 'executed');
    const outside = path.join(fixture.work, 'outside.cjs');
    fs.writeFileSync(outside, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); ${BASIC_SERVER}`);
    fs.symlinkSync(outside, path.join(fixture.root, 'linked.cjs'));
    for (const entrypoint of ['../outside.cjs', outside, 'linked.cjs']) {
      const report = await verifyCapability(manifest, fixture.root, { ...FAST, entrypoint });
      assert.equal(report.verdict, 'NEEDS_REVIEW');
      assert.equal(report.diagnostics.reason, 'runtime-unresolved');
      assert.match(report.rationale, /outside the project/);
      assert.equal(fs.existsSync(marker), false);
    }
  } finally { fixture.cleanup(); }
});

test('destination runtime uses project metadata and validates an explicit entrypoint override', async () => {
  const fixture = project();
  try {
    const report = await verifyCapability(manifest, fixture.root, FAST);
    assert.equal(report.verdict, 'VERIFIED', report.rationale);
    assert.equal(report.entrypoint, 'server.cjs');
    fs.writeFileSync(path.join(fixture.root, 'alternate.cjs'), BASIC_SERVER.replace("res.end('{}')", "res.writeHead(201).end('{}')"));
    const overridden = await verifyCapability(manifest, fixture.root, { ...FAST, entrypoint: 'alternate.cjs' });
    assert.equal(overridden.verdict, 'FAILED');
    assert.equal(overridden.results[0].steps[0].status, 201);
    fs.writeFileSync(path.join(fixture.root, 'package.json'), JSON.stringify({ main: 'server.cjs', scripts: { start: 'node server.cjs && echo unsafe' } }));
    const unsafe = await verifyCapability(manifest, fixture.root, FAST);
    assert.equal(unsafe.verdict, 'NEEDS_REVIEW');
    assert.match(unsafe.rationale, /not a plain/);
  } finally { fixture.cleanup(); }
});

test('invalid or empty assertions cannot boot an application or become passing evidence', async () => {
  const fixture = project();
  try {
    const marker = path.join(fixture.root, 'executed');
    fs.writeFileSync(path.join(fixture.root, 'server.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); ${BASIC_SERVER}`);
    const runtime = resolveRuntime(fingerprintProject(fixture.root));
    for (const expect of [{}, { unsupported: true }, { bodyMatches: {} }]) {
      const tests = structuredClone(acceptanceTests.tests);
      tests[0].steps[0].expect = expect;
      const report = await runAcceptanceSuite({ runtime, tests, ...FAST });
      assert.equal(report.verdict, 'NEEDS_REVIEW');
      assert.equal(report.diagnostics.reason, 'invalid-acceptance-tests');
      assert.equal(report.results.length, 0);
      assert.equal(fs.existsSync(marker), false);
    }
    for (const tests of [null, [], [null]]) {
      const report = await runAcceptanceSuite({ runtime, tests, ...FAST });
      assert.equal(report.verdict, 'NEEDS_REVIEW');
      assert.equal(fs.existsSync(marker), false);
    }
  } finally { fixture.cleanup(); }
});

for (const mode of ['ready-parent-exits-on-term', 'ready-parent-ignores-term', 'parent-exits-before-ready']) {
  test(`teardown kills TERM-resistant descendants when ${mode}`, { skip: process.platform === 'win32' }, async () => {
    const fixture = project();
    let server;
    let descendant;
    try {
      const childSource = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('descendant.pid', String(process.pid)); process.send('ready'); setInterval(() => {}, 1000);`;
      fs.writeFileSync(path.join(fixture.root, 'server.cjs'), `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        ${mode === 'ready-parent-ignores-term' ? "process.on('SIGTERM', () => {});" : ''}
        child.once('message', () => { ${mode === 'parent-exits-before-ready' ? 'process.exit(0);' : BASIC_SERVER} });
      `);
      server = await bootServer(fixture.root, 'server.cjs', { timeoutMs: 3000, command: nodeCommand('server.cjs') });
      descendant = Number(fs.readFileSync(path.join(fixture.root, 'descendant.pid'), 'utf8'));
      assert.equal(server.ready, mode !== 'parent-exits-before-ready');
      const stopped = await server.stop();
      const deadline = Date.now() + 2000;
      while (alive(descendant) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(alive(descendant), false, `descendant ${descendant} survived teardown`);
      assert.equal(alive(server.pid), false, 'parent must be stopped');
      assert.equal(stopped.alive, false, 'reported teardown must include the descendant process group');
    } finally {
      if (server) await server.stop();
      if (alive(descendant)) process.kill(descendant, 'SIGKILL');
      fixture.cleanup();
    }
  });
}

test('source and destination reports redact secrets in assertion details and stderr', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuv123456';
  const fixture = project(`console.error(${JSON.stringify(secret)}); require('node:http').createServer((req, res) => res.end(JSON.stringify({ token: ${JSON.stringify(secret)} }))).listen(process.env.PORT, '127.0.0.1');`);
  try {
    const evidence = structuredClone(manifest);
    evidence.acceptanceTests.tests[0].steps[0].expect = { bodyMatches: { token: 'expected public value' } };
    for (const report of [await verifyCapability(evidence, fixture.root, FAST), await verifySource(fingerprintProject(fixture.root), evidence, FAST)]) {
      assert.equal(report.verdict, 'FAILED');
      assert.equal(JSON.stringify(report).includes(secret), false);
      assert.match(report.results[0].steps[0].checks[0].detail, /\[redacted\]/);
      assert.match(report.diagnostics.stderr, /\[redacted\]/);
    }
    fs.writeFileSync(path.join(fixture.root, 'server.cjs'), `throw new Error(${JSON.stringify(secret)}); // process.env.PORT`);
    const crash = await verifyCapability(evidence, fixture.root, FAST);
    assert.equal(crash.verdict, 'NEEDS_REVIEW');
    assert.equal(JSON.stringify(crash).includes(secret), false);
    assert.match(crash.diagnostics.stderr, /\[redacted\]/);
  } finally { fixture.cleanup(); }
});

test('oversized response bodies produce bounded inconclusive evidence and stop the server', async () => {
  const fixture = project(`require('node:http').createServer((req, res) => res.end('x'.repeat(2 * 1024 * 1024))).listen(process.env.PORT, '127.0.0.1');`);
  try {
    const report = await verifyCapability(manifest, fixture.root, FAST);
    assert.equal(report.verdict, 'NEEDS_REVIEW');
    assert.equal(report.results[0].outcome, 'inconclusive');
    assert.match(report.results[0].reason, /response body exceeds.*verification limit/);
    assert.equal(alive(report.process.pid), false);
    assert.ok(JSON.stringify(report).length < 10000, 'oversized response must not be captured in the report');
  } finally { fixture.cleanup(); }
});

test('a response stream that never finishes still obeys the step timeout', async () => {
  const fixture = project(`require('node:http').createServer((req, res) => { res.writeHead(200); res.write('{'); }).listen(process.env.PORT, '127.0.0.1');`);
  try {
    const report = await verifyCapability(manifest, fixture.root, FAST);
    assert.equal(report.verdict, 'NEEDS_REVIEW');
    assert.equal(report.results[0].outcome, 'inconclusive');
    assert.match(report.results[0].reason, /abort|timeout/i);
    assert.equal(alive(report.process.pid), false);
  } finally { fixture.cleanup(); }
});
