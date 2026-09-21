import net from 'node:net';
import { spawn } from 'node:child_process';
import { nodeCommand } from './runtime.js';

/** An ephemeral port the OS says is free right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let timer;
    const done = (ok) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    timer = setTimeout(() => done(false), 500);
  });
}

/**
 * The environment a verified application runs in. Nothing from the host environment is
 * inherited except what a process needs to start at all: the application under test is
 * someone else's code, and GRAFT has no business handing it the host's credentials.
 */
const PASSTHROUGH_ENV = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'SystemRoot'];

export function controlledEnv(extra = {}) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra, NODE_ENV: 'test' };
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function treeAlive(child) {
  return Boolean(child.pid) && isAlive(process.platform === 'win32' ? child.pid : -child.pid);
}

/** Kills the whole process group the child leads, so anything it spawned goes with it. */
function killTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/**
 * Boots an application as a real child process in its own process group.
 *
 * Verification talks to the application over HTTP exactly as a user's browser would.
 * Nothing is stubbed: if the code throws on startup, this fails to become ready and the
 * run is reported as inconclusive rather than as a pass. The child gets a controlled
 * environment, not the host's, and is torn down with its entire process tree.
 */
export async function bootServer(root, entrypoint, { timeoutMs = 15000, env = {}, command = null } = {}) {
  const port = await freePort();
  const argv = command || nodeCommand(entrypoint);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: root,
    env: controlledEnv({ ...env, PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  const cap = (s, d) => (s + d).slice(0, 64 * 1024);
  child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
  child.stderr.on('data', (d) => { stderr = cap(stderr, d); });

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.on('error', (err) => { exited ||= { code: null, signal: null, error: err.message }; });

  const waitForExit = () => new Promise((resolve) => {
    if (exited) return resolve();
    const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
    const timer = setTimeout(done, 2500);
    child.once('exit', done);
  });

  let stopping;
  const stop = () => stopping ||= (async () => {
    // Descendants retain the process group after its leader exits. Teardown must
    // signal that group even when the direct child has already exited, and must
    // escalate for descendants that ignore TERM after their parent accepts it.
    if (treeAlive(child)) {
      killTree(child, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 150));
      if (treeAlive(child)) killTree(child, 'SIGKILL');
      await waitForExit();
      // The leader's exit event says nothing about when the remaining group has
      // finished exiting. Wait briefly for that state before reporting teardown.
      const deadline = Date.now() + 2500;
      while (treeAlive(child) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    }
    return { stdout, stderr, exit: exited, alive: treeAlive(child) };
  })();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) {
      await stop();
      return { ready: false, reason: 'process-exited-before-ready', exit: exited, stdout, stderr, port, pid: child.pid, stop };
    }
    if (await canConnect(port)) {
      return { ready: true, port, pid: child.pid, stdout: () => stdout, stderr: () => stderr, stop };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  await stop();
  return { ready: false, reason: 'timeout-waiting-for-listen', exit: exited, stdout, stderr, port, pid: child.pid, stop };
}

/** Minimal cookie jar. Empty value means the server cleared the cookie. */
export class CookieJar {
  #jar = new Map();
  ingest(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const [pair] = header.split(';');
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '') this.#jar.delete(name); else this.#jar.set(name, value);
    }
  }
  header() {
    return this.#jar.size ? [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ') : undefined;
  }
  has(name) { return this.#jar.has(name); }
  clear() { this.#jar.clear(); }
}

export function setCookieNames(headers) {
  const raw = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return raw.map((h) => {
    const [pair] = h.split(';');
    const i = pair.indexOf('=');
    return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim(), raw: h };
  });
}
