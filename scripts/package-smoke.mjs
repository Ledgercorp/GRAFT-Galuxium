import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-package-'));
let demoWork;
let ui;
// Node refuses to spawn .cmd/.bat shims without a shell (CVE-2024-27980 hardening), and a shell
// would need quoting for temp paths with spaces. So on Windows npm and the installed CLI are run
// as plain Node programs: npm via the npm_execpath that `npm run` provides, the CLI via its entry.
const npm = process.platform === 'win32'
  ? [process.execPath, process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  : ['npm'];
// npm install/pack and the git-driven demo are markedly slower on Windows CI; give each command
// a generous ceiling so a loaded runner is not mistaken for a hang.
const COMMAND_TIMEOUT = process.platform === 'win32' ? 300000 : 120000;
const run = (command, args, cwd = work) => execFileSync(command[0], [...command.slice(1), ...args], {
  cwd, encoding: 'utf8', timeout: COMMAND_TIMEOUT, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GRAFT_HOME: path.join(work, 'home'), NO_COLOR: '1' },
});
try {
  const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', work], repo));
  const names = new Set(packed.files.map((file) => file.path));
  for (const file of ['packages/cli/src/index.js', 'packages/core/src/index.js', 'packages/web/src/server.js', 'packages/web/public/index.html', 'packages/web/public/app.js', 'packages/web/public/style.css', 'fixtures/old-saas-project/server.js', 'fixtures/new-startup/src/main.js',
    // The proof path: core's verifier imports the proof adapter by relative path, and the adapter reads
    // the vendored kernel's provenance and hashes the vendored files at runtime. All of it must ship.
    'packages/proof-adapter/src/index.js', 'packages/proof-adapter/package.json', 'packages/cuf-kernel/src/index.js', 'packages/cuf-kernel/package.json', 'packages/cuf-kernel/PROVENANCE.json']) {
    assert.ok(names.has(file), `distribution missing ${file}`);
  }
  assert.ok(![...names].some((name) => /(?:^|\/)(?:node_modules|\.git|\.env)(?:\/|$)/.test(name)), 'distribution contains local state');
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"graft-install-smoke","private":true}');
  run(npm, ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(work, packed.filename)]);
  // POSIX exercises the installed bin shim; Windows runs the installed entry with Node (see above).
  const cli = process.platform === 'win32'
    ? [process.execPath, path.join(work, 'node_modules', 'graft', 'packages', 'cli', 'src', 'index.js')]
    : [path.join(work, 'node_modules/.bin/graft')];
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version;
  assert.match(run(cli, ['--version']), new RegExp(version.replaceAll('.', '\\.')));
  assert.match(run(cli, ['--help']), /harvest/);
  // The proof path, executed from the isolated install (never from the checkout): the installed
  // adapter must resolve its vendored kernel, decide a suite through it, build a proof envelope,
  // verify it from a file, and report the SAME kernel identity the checkout computes — proving the
  // vendored bytes shipped intact, not merely that the file names exist.
  const installedProof = JSON.parse(run([process.execPath], ['--input-type=module', '-e', `
    import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
    const adapter = await import(pathToFileURL(${JSON.stringify(path.join(work, 'node_modules/graft/packages/proof-adapter/src/index.js'))}).href);
    const results = [0, 1].map((i) => ({ id: 'case-' + i, required: true, outcome: 'passed', steps: [{ name: 'probe', request: 'GET /x', status: 200, checks: [{ name: 'status', ok: true }] }] }));
    const d = adapter.decideHttpSuite({ results });
    const report = { verdict: d.verdict, proofRoot: d.proofRoot, proofEvidence: d.evidence, proofAuthority: { ...d.authority, cufVerdict: d.cufVerdict }, results: results.map((r) => ({ id: r.id, kind: 'http', required: true, outcome: r.outcome })) };
    const { envelope, reason } = adapter.buildProofEnvelope({ report, capability: { id: 'sha256:' + 'a'.repeat(64), slug: 'smoke', kind: 'session-auth', form: 'service', genomeId: null, irId: null }, contract: { id: null, version: null }, source: { revision: '2'.repeat(40) }, destination: { revision: '1'.repeat(40), hostProfile: 'esm-node-http-central' }, verifier: { core: '0.0.0' } });
    if (!envelope) throw new Error('no envelope: ' + reason);
    const file = path.join(${JSON.stringify(work)}, 'smoke-proof.json'); fs.writeFileSync(file, JSON.stringify(envelope));
    const verified = adapter.verifyProofFile(file);
    console.log(JSON.stringify({ verdict: d.verdict, cufVerdict: d.cufVerdict, intact: verified.intact, reasons: verified.reasons, digest: envelope.digest, kernel: adapter.proofKernelIdentity(), adapterVersion: adapter.proofAdapterVersion() }));
  `]));
  const { proofKernelIdentity, proofAdapterVersion } = await import(pathToFileURL(path.join(repo, 'packages/proof-adapter/src/index.js')).href);
  assert.deepEqual([installedProof.verdict, installedProof.cufVerdict, installedProof.intact, installedProof.reasons], ['VERIFIED', 'PASS', true, []], JSON.stringify(installedProof));
  assert.match(installedProof.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(installedProof.kernel, proofKernelIdentity(), 'the installed vendored kernel is byte-identical to the checkout\'s (same source commit, same digest over the vendored files)');
  assert.equal(installedProof.adapterVersion, proofAdapterVersion());
  const output = run(cli, ['demo']);
  demoWork = /workspace: ([^\r\n]+)/.exec(output)?.[1]?.trim();
  assert.ok(demoWork, 'demo must report its disposable workspace');
  assert.ok((output.match(/VERIFIED/g) || []).length >= 2, output);
  const receiptDir = path.join(demoWork, 'new-startup/.graft/transplants');
  const receipts = fs.readdirSync(receiptDir).filter((name) => name.endsWith('.json'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(fs.readFileSync(path.join(receiptDir, receipts[0]), 'utf8'));
  assert.equal(receipt.verification.verdict, 'VERIFIED');
  assert.equal(receipt.verification.summary.passed, 6);
  ui = spawn(cli[0], [...cli.slice(1), 'ui', '--port', '0'], { cwd: work, env: { ...process.env, GRAFT_HOME: path.join(work, 'ui-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Installed dashboard did not start')), 15000);
    ui.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ui.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Installed dashboard exited: ${code}`)); });
    ui.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /GRAFT workspace: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const html = await (await fetch(origin)).text();
  assert.match(html, /GRAFT — Workspace/);
  const token = /name="graft-token" content="([a-f0-9]+)"/.exec(html)?.[1];
  assert.ok(token);
  const state = await fetch(`${origin}/api/state`, { headers: { 'X-Graft-Token': token } });
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).projects, []);
  for (const file of ['app.js', 'style.css', 'brand-icon.png']) assert.equal((await fetch(`${origin}/${file}`)).status, 200);
  console.log(`Installed ${packed.filename} outside the checkout; CLI help/version, source → transplant → HTTP verification, and packaged browser workspace passed.`);
} finally {
  if (ui && ui.exitCode === null) {
    const exited = new Promise((resolve) => ui.once('exit', resolve));
    ui.kill('SIGTERM');
    await exited;
  }
  if (demoWork && path.dirname(demoWork) === os.tmpdir() && path.basename(demoWork).startsWith('graft-demo-')) fs.rmSync(demoWork, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
