import fs from 'node:fs';
import path from 'node:path';
import { nodeExecutable } from './executable.js';
import { writeFactoryHarness } from './harness.js';

/**
 * How to run a project so its behavior can be observed.
 *
 * A runtime profile is the boundary between "GRAFT knows how to start this" and "GRAFT
 * does not". One profile exists in this version: a Node application started from an
 * entrypoint file that listens on $PORT. A project outside that shape is reported as
 * unrunnable with the reason, which the verdict engine turns into NEEDS_REVIEW; it is
 * never guessed at.
 */
/**
 * The only command GRAFT ever runs: node, options terminated, then the script. The `--`
 * means an entrypoint named like a flag is a filename, never an option.
 */
export function nodeCommand(entrypoint) {
  return [nodeExecutable(), '--', entrypoint];
}

function containedIn(root, rel) {
  const abs = path.resolve(root, rel);
  const realRoot = fs.realpathSync(root);
  let realAbs;
  try { realAbs = fs.realpathSync(abs); } catch { return false; }
  return realAbs === realRoot || realAbs.startsWith(realRoot + path.sep);
}

export const RUNTIME_PROFILES = [
  {
    id: 'node-entrypoint',
    description: 'node <entrypoint>, listens on $PORT',
    resolve(fp) {
      if (typeof fp.entrypoint !== 'string' || !fp.entrypoint) return { ok: false, reason: 'no entrypoint found (set "main" or a "start" script in package.json)' };
      if (fp.entrypoint.startsWith('-')) return { ok: false, reason: `entrypoint "${fp.entrypoint}" looks like a command-line option` };
      const abs = path.resolve(fp.root, fp.entrypoint);
      if (!fs.existsSync(abs)) return { ok: false, reason: `entrypoint ${fp.entrypoint} does not exist` };
      if (!containedIn(fp.root, fp.entrypoint)) return { ok: false, reason: `entrypoint ${fp.entrypoint} resolves outside the project` };
      if (!fs.statSync(abs).isFile()) return { ok: false, reason: `entrypoint ${fp.entrypoint} is not a file` };

      // A start script, when present, must be a plain "node <file>": nothing else is ever run. An
      // explicit entrypoint override from a trusted caller (the plan) is honoured as before.
      const start = fp.packageJson?.scripts?.start;
      if (start && !/^\s*node\s+(?:--[\w-]+(?:=\S+)?\s+)*[^\s&|;]+\s*$/.test(start)) {
        return { ok: false, reason: `start script is "${start}", which is not a plain "node <file>" and cannot be run safely` };
      }
      if (!fp.environmentVariables.includes('PORT')) {
        return { ok: false, reason: 'the application does not read process.env.PORT, so GRAFT cannot tell it where to listen' };
      }
      return {
        ok: true,
        profile: 'node-entrypoint',
        entrypoint: fp.entrypoint,
        command: nodeCommand(fp.entrypoint),
        cwd: fp.root,
        // Names only. Values are chosen by GRAFT at boot time; nothing comes from the host.
        env: {},
        readiness: 'tcp-connect',
      };
    },
  },
];

/**
 * Engine 1.2: a hosted-provider capability is booted through its own factory seam with the
 * provider double substituted for the credential authority. Without a seam there is nothing
 * GRAFT can honestly run, and the reason names exactly that.
 */
export function resolveHarnessRuntime(fp, manifest, { doubleOrigin, doubleAudience }) {
  const seam = manifest?.architecture?.capabilityModel?.providerSeam;
  if (!seam) return { ok: false, profile: null, reason: 'the capability declares no provider seam' };
  if (seam.verification?.kind !== 'factory-injection') {
    return { ok: false, profile: null, reason: `provider-seam-unavailable: hosted-provider authentication is understood, but no verification seam is available in the source (${seam.verification?.reason || seam.verification?.kind}); GRAFT will not run it against a live provider` };
  }
  try {
    const harness = writeFactoryHarness({ sourceRoot: fp.root, manifest, doubleOrigin, doubleAudience });
    return { ok: true, profile: 'factory-injection-harness', entrypoint: harness.file, command: [nodeExecutable(), ...harness.nodeArgs], cwd: fp.root, env: harness.env, readiness: 'tcp-connect',
      harness: { file: harness.file, seam: harness.seam, typescript: harness.typescript }, cleanup: harness.cleanup };
  } catch (err) {
    return { ok: false, profile: null, reason: `provider-seam-unavailable: ${err.message}` };
  }
}

export function resolveRuntime(fp, { manifest = null, double = null } = {}) {
  const model = manifest?.architecture?.capabilityModel;
  const hosted = model?.kind === 'hosted-session-auth';
  // Source side of a hosted capability: the factory seam, never the production entrypoint.
  if (hosted && double && model.providerSeam?.verification?.kind !== 'endpoint-configuration' && manifest?.identity?.sourceProjectRoot && path.resolve(manifest.identity.sourceProjectRoot) === path.resolve(fp.root)) {
    return resolveHarnessRuntime(fp, manifest, { doubleOrigin: double.origin, doubleAudience: double.audience });
  }
  const reasons = [];
  for (const profile of RUNTIME_PROFILES) {
    const result = profile.resolve(fp);
    if (result.ok) return result;
    reasons.push(`${profile.id}: ${result.reason}`);
  }
  return { ok: false, profile: null, reason: reasons.join('; ') };
}
