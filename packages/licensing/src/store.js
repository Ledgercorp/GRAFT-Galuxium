// Persistence for issued licenses. The server-side store is the single source of truth
// about who paid and which activations exist; the desktop client can never write here.
//
// Two implementations share one contract:
//   load()        -> the whole document { licenses: {key: record}, sessions: {id: key}, deadLetters: {sessionId: entry},
//                    holds: {paymentIntent: pre-issuance state} }
//   save(document) -> persist it atomically
// The registry serializes its operations in-process; the file store additionally offers an
// advisory cross-process lock (lock() -> release) so the operator CLI, which runs beside the
// server against the same file, never interleaves a read/modify/write with it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const empty = () => ({ licenses: {}, sessions: {}, deadLetters: {}, holds: {} });

export function memoryStore(initial) {
  let document = initial ? structuredClone(initial) : empty();
  return {
    async load() { return structuredClone(document); },
    async save(next) { document = structuredClone(next); },
  };
}

export function fileStore(filePath) {
  const directory = path.dirname(filePath);
  return {
    async load() {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return { licenses: parsed.licenses || {}, sessions: parsed.sessions || {}, deadLetters: parsed.deadLetters || {}, holds: parsed.holds || {} };
      } catch (err) {
        if (err.code === 'ENOENT') return empty();
        throw err;
      }
    },
    // Exclusive-create lock file; a lock older than 30 s belongs to a dead process and is reclaimed.
    async lock({ timeoutMs = 5000, staleMs = 30000 } = {}) {
      const lockPath = `${filePath}.lock`;
      const deadline = Date.now() + timeoutMs;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (;;) {
        try { fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => fs.rmSync(lockPath, { force: true }); }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          try { if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) { fs.rmSync(lockPath, { force: true }); continue; } } catch { /* raced away */ }
          if (Date.now() > deadline) throw new Error('The license store is busy; try again.');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    },
    async save(document) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.licenses-${crypto.randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}
