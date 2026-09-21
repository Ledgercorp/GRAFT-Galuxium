// Agent context sanitization.
//
// An external model sees a *structural* description of the workspace and nothing else. The
// rule is allow-list, not deny-list: context objects are rebuilt field by field from known
// safe values, so a field nobody thought about cannot leak by default. Raw source text,
// environment values, secrets, absolute home paths and repository contents are never part
// of a default request, and the sanitizer is the only door they could come through.
import os from 'node:os';
import path from 'node:path';

export const SANITIZER_VERSION = '1.0.0';

/** Things that must never reach a provider, whatever the caller believes. */
const SECRET_PATTERN = /\b(sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;
// Exact field names that ARE the secret. Matched whole, so classification fields that merely
// contain the word — credentialAuthority, environmentVariableNames, cookieFlags — stay sendable.
const SECRET_NAME = /^(password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|credentials?|cookie|cookies|authorization|auth[_-]?token|session[_-]?id|access[_-]?token|refresh[_-]?token)$/i;

/** Replace the user's home directory with ~ so absolute layout never leaves the machine. */
export function relativisePath(value) {
  if (typeof value !== 'string') return value;
  const home = os.homedir();
  return home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

/** Redact anything that looks like a credential. Used as a last line of defence, not the first. */
export function redact(value) {
  return typeof value === 'string' ? value.replace(SECRET_PATTERN, '[redacted]') : value;
}

const text = (value, max = 300) => {
  if (typeof value !== 'string') return undefined;
  const clean = redact(relativisePath(value));
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};
const bounded = (list, map, max = 40) => (Array.isArray(list) ? list.slice(0, max).map(map).filter((v) => v !== undefined) : []);

/**
 * Default-safe context for one indexed project. Rebuilt from named fields only: the project
 * record's other contents (file lists, read closures, raw evidence strings) never travel.
 */
export function projectContext(project) {
  if (!project || project.error) return null;
  return {
    projectId: text(project.projectId, 120),
    name: text(project.name, 80),
    repository: text(project.repository?.name, 80),
    relativeRoot: text(project.relativeRoot, 120),
    branch: text(project.repository?.branch, 80),
    language: text(project.language, 40),
    runtime: text(project.runtime, 40),
    runtimeVersion: text(project.runtimeVersion, 40),
    moduleSystem: text(project.moduleSystem, 40),
    framework: text(project.framework, 40),
    packageManager: text(project.packageManager, 40),
    isCompiled: project.isCompiled === true,
    hasHttpServer: project.hasHttpServer === true,
    handlerContract: text(project.handlerContract, 40),
    routeIdioms: bounded(project.routeIdioms, (v) => text(v, 40), 10),
    // Route shapes only: method and path, never handler bodies.
    routes: bounded(project.routes, (r) => ({ method: text(r.method, 10), path: text(r.path, 120), idiom: text(r.idiom, 40) }), 40),
    entrypoint: project.entrypoint ? { source: text(project.entrypoint.source, 160), generated: project.entrypoint.generated === true, confidence: text(project.entrypoint.confidence, 20) } : null,
    dependencies: bounded(project.dependencies, (d) => ({ name: text(d.name, 80), range: text(d.range, 40) }), 60),
    // Names only. Values are never read by the index and never sent by the sanitizer.
    environmentVariableNames: bounded(project.environmentVariables, (v) => text(v, 80), 60),
    externalHosts: bounded(project.externalHosts, (h) => text(h, 120), 20),
    storage: bounded(project.storage, (s) => text(s.kind, 40), 10),
    deployTargets: bounded(project.deployTargets, (d) => text(d, 40), 10),
    testCommandNames: bounded(project.testCommands, (t) => text(t.name, 40), 10),
    fileCount: Number.isInteger(project.fileCount) ? project.fileCount : null,
  };
}

/** Default-safe context for one capability observation: classification and evidence ids. */
export function capabilityContext(capability) {
  if (!capability) return null;
  return {
    capability: text(capability.capability, 40),
    state: text(capability.state, 40),
    subtypes: bounded(capability.subtypes, (s) => text(s, 60), 20),
    confidence: text(capability.confidence, 20),
    auth: capability.auth ? {
      credentialAuthority: text(capability.auth.credentialAuthority?.kind, 40),
      credentialAuthorityDetail: text(capability.auth.credentialAuthority?.detail, 200),
      sessionTransport: text(capability.auth.sessionTransport, 40),
      sessionCustody: text(capability.auth.sessionCustody, 40),
      sessionStore: text(capability.auth.sessionStore, 40),
      sessionDurableAcrossRestart: typeof capability.auth.sessionDurableAcrossRestart === 'boolean' ? capability.auth.sessionDurableAcrossRestart : null,
      // Flags, never the cookie value or name-value pair.
      cookieFlags: capability.auth.cookieFlags ? { httpOnly: capability.auth.cookieFlags.httpOnly === true, secure: capability.auth.cookieFlags.secure === true,
        sameSite: text(capability.auth.cookieFlags.sameSite, 20), hostPrefix: capability.auth.cookieFlags.hostPrefix === true } : null,
      hashAlgorithm: text(capability.auth.hashAlgorithm, 40),
      providers: bounded(capability.auth.providers, (p) => text(p, 40), 10),
      routeRoles: bounded(capability.auth.routeRoles, (r) => text(r, 40), 12),
    } : null,
    flags: capability.flags ? { source: text(capability.flags.source, 40), scope: text(capability.flags.scope, 40) } : null,
    // Signal ids and their short evidence strings — which are detector phrases, not source text.
    signals: bounded(capability.signals, (s) => ({ id: text(s.id, 60), evidence: text(s.evidence, 160), file: text(s.file, 160) }), 30),
    missingSignals: bounded(capability.missingSignals, (m) => ({ id: text(m.id, 60), requiredFor: text(m.requiredFor, 40), why: text(m.why, 240) }), 10),
    harvestable: capability.harvestable === true,
    transplantSupport: text(capability.transplantSupport, 20),
    blockers: bounded(capability.blockers, (b) => ({ id: text(b.id, 60), detail: text(b.detail, 200) }), 10),
    localVerificationFeasible: capability.localVerification?.feasible === true,
  };
}

/** A search result as the agent sees it: identity, classification, evidence — no source. */
export function candidateContext(result, ordinal) {
  return {
    candidateId: `c${ordinal}`,
    projectId: text(result.projectId, 120),
    project: text(result.project?.name, 80),
    relativeRoot: text(result.project?.relativeRoot, 120),
    language: text(result.project?.language, 40),
    runtime: text(result.project?.runtime, 40),
    framework: text(result.project?.framework, 40),
    moduleSystem: text(result.project?.moduleSystem, 40),
    hasHttpServer: result.project?.hasHttpServer === true,
    externalHosts: bounded(result.project?.externalHosts, (h) => text(h, 120), 10),
    capability: text(result.capability, 40),
    state: text(result.state, 40),
    subtypes: bounded(result.subtypes, (s) => text(s, 60), 20),
    audience: text(result.audience, 20),
    auth: result.auth ? { credentialAuthority: text(result.auth.credentialAuthority?.kind, 40), sessionTransport: text(result.auth.sessionTransport, 40),
      sessionCustody: text(result.auth.sessionCustody, 40), sessionStore: text(result.auth.sessionStore, 40) } : null,
    evidence: bounded(result.evidence, (s) => text(s.id, 60), 20),
    matchedBecause: bounded(result.matchedBecause, (w) => text(w.detail, 160), 10),
    harvestable: result.harvestable === true,
    transplantSupport: text(result.transplantSupport, 20),
    localVerificationFeasible: result.localVerification?.feasible === true,
    blockers: bounded(result.blockers, (b) => text(b.id, 60), 10),
  };
}

/**
 * Final gate before a request leaves the process. Walks the whole payload and refuses it if
 * anything that looks like a secret, a home path or a source-bearing field survived. Being
 * refused here is a bug in the caller, not a reason to strip and continue quietly.
 */
export function assertSendable(payload, { allowPaths = false } = {}) {
  const problems = [];
  const walk = (value, trail) => {
    if (trail.length > 12) return;
    if (typeof value === 'string') {
      if (SECRET_PATTERN.test(value)) problems.push(`${trail.join('.')}: looks like a credential`);
      if (!allowPaths && os.homedir() && value.includes(os.homedir())) problems.push(`${trail.join('.')}: contains an absolute home path`);
      if (value.includes('\n') && value.length > 400) problems.push(`${trail.join('.')}: looks like source text (${value.length} characters)`);
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, [...trail, i])); return; }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (SECRET_NAME.test(key) && typeof child === 'string' && child.length > 0) problems.push(`${trail.concat(key).join('.')}: sensitive field name carries a value`);
        walk(child, [...trail, key]);
      }
    }
  };
  SECRET_PATTERN.lastIndex = 0;
  walk(payload, []);
  if (problems.length) throw Object.assign(new Error(`Refusing to send agent context: ${problems.slice(0, 4).join('; ')}`), { code: 'unsafe-agent-context', problems });
  return payload;
}

/**
 * Source excerpts, only ever reached through an explicit grant. Bounded to the named file
 * and line window the grant describes, secrets redacted, and always marked as excerpted.
 */
export function sourceExcerpt({ file, contents, startLine = 1, maxLines = 80, maxChars = 4000 }) {
  const lines = String(contents || '').split('\n');
  const slice = lines.slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + maxLines);
  let body = slice.join('\n');
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n…`;
  return { file: relativisePath(file), startLine, lineCount: slice.length, truncated: slice.length < lines.length, excerpt: redact(body) };
}
