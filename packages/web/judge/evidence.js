// Shared, dependency-free public-data contract: unknown fields fail closed.
const require = (ok) => { if (!ok) throw new Error('Invalid or unsafe recorded evidence'); };
const object = (v, keys) => {
  require(v && typeof v === 'object' && !Array.isArray(v));
  require(Object.keys(v).every((k) => keys.includes(k)) && keys.every((k) => Object.hasOwn(v, k)));
};
const text = (s) => require(typeof s === 'string' && s.length > 0 && s.length < 100000);
const revision = (s) => require(/^[a-f0-9]{40}$/.test(s));
const digest = (s) => require(/^[a-f0-9]{64}$/.test(s));
const items = (a, check) => { require(Array.isArray(a) && a.length > 0 && a.length < 100); a.forEach(check); };
const bool = (b) => require(typeof b === 'boolean');
const date = (s) => { text(s); require(Number.isFinite(Date.parse(s))); };
const relative = (s) => { text(s); require(/^[a-zA-Z0-9_./-]+$/.test(s) && !s.startsWith('/') && !s.split('/').includes('..')); };
function report(r) {
  object(r, ['verdict', 'startedAt', 'finishedAt', 'summary', 'envelopeDigest', 'tests']);
  require(['VERIFIED', 'FAILED', 'NEEDS_REVIEW'].includes(r.verdict));
  date(r.startedAt); date(r.finishedAt); require(Date.parse(r.finishedAt) >= Date.parse(r.startedAt));
  digest(r.envelopeDigest);
  object(r.summary, ['required', 'passed', 'failed', 'inconclusive']);
  Object.values(r.summary).forEach((n) => require(Number.isInteger(n) && n >= 0));
  items(r.tests, (t) => {
    object(t, ['id', 'description', 'required', 'outcome', 'steps']);
    text(t.id); text(t.description); bool(t.required);
    require(['passed', 'failed', 'inconclusive'].includes(t.outcome));
    items(t.steps, (s) => {
      object(s, ['name', 'request', 'status', 'ok', 'checks']); text(s.name); text(s.request); bool(s.ok);
      require((s.request === 'restart' && s.status === null) || (Number.isInteger(s.status) && s.status >= 100 && s.status <= 599));
      items(s.checks, (c) => { object(c, ['name', 'ok']); text(c.name); bool(c.ok); });
      require(s.ok === s.checks.every((c) => c.ok));
    });
    require((t.outcome === 'passed') === t.steps.every((s) => s.ok));
  });
  require(new Set(r.tests.map((t) => t.id)).size === r.tests.length);
  const required = r.tests.filter((t) => t.required);
  require(required.length === r.summary.required);
  for (const outcome of ['passed', 'failed', 'inconclusive']) require(required.filter((t) => t.outcome === outcome).length === r.summary[outcome]);
  if (r.verdict === 'VERIFIED') require(required.length > 0 && r.summary.passed === required.length);
}

export function validateEvidence(d) {
  object(d, ['schemaVersion', 'recordedAt', 'generator', 'capability', 'source', 'destination', 'plan', 'diff']);
  require(d.schemaVersion === 1); date(d.recordedAt);
  object(d.generator, ['command', 'graftRevision']);
  require(d.generator.command === 'node scripts/demo/judge-evidence.mjs'); revision(d.generator.graftRevision);
  object(d.capability, ['name', 'slug', 'behaviors']); text(d.capability.name); text(d.capability.slug);
  items(d.capability.behaviors, (b) => { object(b, ['id', 'text']); text(b.id); text(b.text); });
  for (const [key, fixture] of [['source', 'old-saas-project'], ['destination', 'new-startup']]) {
    const p = d[key];
    object(p, ['name', 'fixture', 'shape', 'revision', 'verification', ...(key === 'source' ? ['discovery', 'signals'] : ['baseRevision', 'entrypoint'])]);
    require(p.name === fixture && p.fixture === `fixtures/${fixture}`); revision(p.revision);
    object(p.shape, ['moduleSystem', 'handlerContract', 'framework', 'persistence']); Object.values(p.shape).forEach(text);
    report(p.verification);
  }
  items(d.source.discovery, (c) => { object(c, ['id', 'displayName', 'harvestable', 'summary']); text(c.id); text(c.displayName); bool(c.harvestable); text(c.summary); });
  items(d.source.signals, (s) => { object(s, ['id', 'evidence']); text(s.id); text(s.evidence); });
  revision(d.destination.baseRevision); relative(d.destination.entrypoint);
  object(d.plan, ['status', 'adaptation', 'checks', 'conflictResolutionApproved', 'steps', 'files']);
  text(d.plan.status); text(d.plan.adaptation); bool(d.plan.conflictResolutionApproved);
  items(d.plan.checks, (c) => { object(c, ['id', 'status', 'title', 'detail']); text(c.id); text(c.title); text(c.detail); require(['ok', 'warn', 'block'].includes(c.status)); });
  items(d.plan.steps, (s) => { object(s, ['order', 'kind', 'description']); require(Number.isInteger(s.order)); text(s.kind); text(s.description); });
  items(d.plan.files, (f) => { object(f, ['path', 'sha256']); relative(f.path); digest(f.sha256); });
  text(d.diff); require(d.diff.startsWith('diff --git '));
  // Defense in depth in addition to explicit projection. Never export raw reports or receipts.
  const serialized = JSON.stringify(d);
  require(!/(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Z]:\\\\|\.graft\/|sk_(?:live|test)_|rk_live_|AKIA[0-9A-Z]{16}|gh[pousr]_|github_pat_|xox[baprs]-|re_[A-Za-z0-9]{20}|Bearer\s+[A-Za-z0-9]|-----BEGIN .*PRIVATE KEY|licenseKey|apiKey|customerEmail|receiptPath|fly\.dev|tigris\.dev|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(serialized));
  return d;
}

export async function decodeEvidence(envelope) {
  object(envelope, ['sha256', 'payload']); digest(envelope.sha256);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(envelope.payload)));
  const actual = Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  require(actual === envelope.sha256);
  return validateEvidence(envelope.payload);
}
