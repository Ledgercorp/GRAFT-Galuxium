#!/usr/bin/env node
// Private Beta Program — operator commands. Runs beside the licensing service against the same
// durable store (cross-process locked) and the same Resend configuration; nothing here is
// reachable over HTTP. Full license keys are never printed by default: the tester receives the
// key by email, the operator sees a masked form.
//
//   node src/beta-cli.js issue   --email tester@example.com [--days 30] [--reissue]
//   node src/beta-cli.js inspect --email tester@example.com | --key GRAFT-…
//   node src/beta-cli.js extend  --email tester@example.com | --key GRAFT-… --days 14
//   node src/beta-cli.js revoke  --email tester@example.com | --key GRAFT-… [--reason "…"]
//
// Every command prints one line per fact and exits non-zero on refusal. --json prints the same
// facts as one JSON object (still masked).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { fileStore } from './store.js';
import { createLicenseRegistry, maskKey, normalizeEmail, PRIVATE_BETA_DEFAULT_DAYS, PRIVATE_BETA_MAX_DAYS, LicenseError } from './licenses.js';
import { createLicenseMailer } from './mail.js';
import { issueAndInvite } from './private-beta.js';

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { days: null, reissue: false, json: false, email: null, key: null, reason: null, revealKey: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => { const v = rest[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value.`); i += 1; return v; };
    if (arg === '--email') options.email = value();
    else if (arg === '--key') options.key = value();
    else if (arg === '--days') { const n = Number(value()); if (!Number.isSafeInteger(n)) throw new Error('--days must be a whole number.'); options.days = n; }
    else if (arg === '--reason') options.reason = value();
    else if (arg === '--reissue') options.reissue = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--reveal-key') options.revealKey = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  if (!['issue', 'inspect', 'extend', 'revoke'].includes(command)) throw new Error('Command must be one of: issue, inspect, extend, revoke.');
  if (command === 'issue' && !options.email) throw new Error('issue needs --email.');
  if (command !== 'issue' && !options.email && !options.key) throw new Error(`${command} needs --email or --key.`);
  if (command === 'extend' && options.days === null) throw new Error('extend needs --days.');
  return { command, options };
}

const longDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '—');
const facts = (record, now) => ({
  email: record.customerEmail,
  license: maskKey(record.key),
  status: record.status !== 'active' ? record.status : (Date.parse(record.expiresAt) <= now ? 'expired' : 'active'),
  issued: longDate(record.issuedAt),
  expires: longDate(record.expiresAt),
  expiresAt: record.expiresAt,
  seats: `${record.instances.length} of ${record.maxActivations} in use`,
  activations: record.instances.map((i) => ({ name: i.name, activatedAt: i.activatedAt })),
  delivery: record.delivery ? `${record.delivery.status}${record.delivery.error ? ` (${record.delivery.error})` : ''} at ${record.delivery.at}` : 'not sent',
  feedback: record.feedback ? `${record.feedback.count} submission(s), last ${record.feedback.lastRating}/5 at ${record.feedback.lastAt}` : 'none',
});

/** The command's work, separated from process I/O so it is testable with an in-memory registry and a fake mailer. */
export async function run({ command, options }, { registry, mailer, now = Date.now }) {
  if (command === 'issue') {
    const result = await issueAndInvite({ registry, mailer, email: options.email, days: options.days ?? PRIVATE_BETA_DEFAULT_DAYS, reissue: options.reissue, now });
    if (!result.issued) {
      const existing = await registry.findPrivateBeta({ email: options.email });
      return { ok: false, title: 'Private beta license NOT issued: this tester already has a current one', ...facts(existing, now()), hint: 'Use --reissue to revoke it and issue a fresh license, or extend it instead.' };
    }
    const record = await registry.findPrivateBeta({ email: options.email });
    const out = { ok: result.ok, title: result.ok ? 'Private beta license issued' : 'Private beta license issued but the invitation email was NOT sent', ...facts(record, now()) };
    if (result.replaced) out.replaced = result.replaced;
    if (!result.ok) { out.hint = `Delivery ${result.reason.replace('delivery-', '')}${result.deliveryError ? `: ${result.deliveryError}` : ''}. Re-run with --reissue after fixing mail, or send the key manually with --json --reveal-key.`; }
    if (!result.ok && options.revealKey) out.key = result.key;
    return out;
  }
  const record = await registry.findPrivateBeta({ key: options.key, email: options.key ? null : options.email });
  if (!record) return { ok: false, title: 'No private beta license found' };
  if (command === 'inspect') return { ok: true, title: 'Private beta license', ...facts(record, now()) };
  if (command === 'extend') {
    const result = await registry.extendPrivateBeta(record.key, options.days);
    return { ok: true, title: 'Private beta license extended', previous: longDate(result.previous), ...facts(result.record, now()) };
  }
  if (command === 'revoke') {
    const result = await registry.revokePrivateBeta(record.key, options.reason || 'revoked by operator');
    return { ok: true, title: result.revoked ? 'Private beta license revoked' : 'Private beta license was already revoked', ...facts(result.record, now()) };
  }
  throw new Error('unreachable');
}

/** The store belongs to the service's user. Run as root, this command would leave a root-owned file the
 * service can no longer read (it then fails closed for every tester), so root drops to the owner first
 * and refuses if it cannot. */
export function dropToStoreOwner(storePath, { fs: fsImpl = fs, proc = process } = {}) {
  if (typeof proc.getuid !== 'function' || proc.getuid() !== 0) return { dropped: false };
  let stat = null;
  try { stat = fsImpl.statSync(storePath); } catch { try { stat = fsImpl.statSync(path.dirname(storePath)); } catch { stat = null; } }
  if (!stat || stat.uid === 0) throw new Error('Refusing to run as root: the license store must be operated as the service user (run with `fly ssh console -u node`).');
  proc.setgid(stat.gid); proc.setuid(stat.uid);
  return { dropped: true, uid: stat.uid };
}

export function format(out) {
  const lines = [out.title];
  for (const [k, v] of Object.entries(out)) {
    if (['ok', 'title', 'activations', 'expiresAt'].includes(k)) continue;
    lines.push(`${k[0].toUpperCase()}${k.slice(1)}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const config = loadConfig();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const storePath = config.storePath || path.join(here, '../.data/licenses.json');
    dropToStoreOwner(storePath);
    const registry = createLicenseRegistry({ store: fileStore(storePath), product: config.product, maxActivations: config.maxActivations });
    const mailer = createLicenseMailer({ ...config.mail, downloadUrl: config.downloadUrl });
    const out = await run(parsed, { registry, mailer });
    console.log(parsed.options.json ? JSON.stringify(out, null, 2) : format(out));
    process.exit(out.ok ? 0 : 2);
  } catch (err) {
    console.error(err instanceof LicenseError ? err.message : err.message);
    console.error(`Usage: beta-cli.js issue --email <address> [--days 1..${PRIVATE_BETA_MAX_DAYS}] [--reissue] | inspect|extend|revoke (--email <address> | --key <key>) [--days N] [--reason "…"] [--json]`);
    process.exit(1);
  }
}
