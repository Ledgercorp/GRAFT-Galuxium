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
const array = (a, check) => { require(Array.isArray(a) && a.length < 100); a.forEach(check); };
const bool = (b) => require(typeof b === 'boolean');
const date = (s) => { text(s); require(Number.isFinite(Date.parse(s))); };
const relative = (s) => { text(s); require(/^[a-zA-Z0-9_./-]+$/.test(s) && !s.startsWith('/') && !s.split('/').includes('..')); };
const taggedDigest = (s) => require(/^sha256:[a-f0-9]{64}$/.test(s));
const compatibilityState = (s) => require(['COMPATIBLE', 'ADAPTABLE', 'INCOMPATIBLE'].includes(s));
const dataClass = (s) => require(['NONE', 'METADATA', 'STRUCTURE', 'SOURCE_EXCERPT', 'GENERATED_DERIVATIVE'].includes(s));
const reason = (r) => { object(r, ['id', 'status', 'title', 'detail']); text(r.id); text(r.title); text(r.detail); require(['warn', 'block'].includes(r.status)); };
function compatibilityPreview(p) {
  object(p, ['state', 'transplantAllowed', 'reasons']); compatibilityState(p.state); bool(p.transplantAllowed); array(p.reasons, reason);
  require(p.transplantAllowed === (p.state !== 'INCOMPATIBLE'));
}
function report(r) {
  object(r, ['verdict', 'startedAt', 'finishedAt', 'summary', 'envelopeDigest', 'tests']);
  require(['VERIFIED', 'FAILED', 'NEEDS_REVIEW'].includes(r.verdict));
  date(r.startedAt); date(r.finishedAt); require(Date.parse(r.finishedAt) >= Date.parse(r.startedAt));
  digest(r.envelopeDigest);
  object(r.summary, ['required', 'passed', 'failed', 'inconclusive']);
  Object.values(r.summary).forEach((n) => require(Number.isInteger(n) && n >= 0));
  items(r.tests, (t) => {
    object(t, ['id', 'description', 'required', 'outcome', 'evidenceType', 'steps']);
    text(t.id); text(t.description); bool(t.required);
    require(['passed', 'failed', 'inconclusive'].includes(t.outcome));
    require(['BUILD', 'UNIT', 'INTEGRATION', 'BEHAVIORAL_CONTRACT'].includes(t.evidenceType));
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
  object(d, ['schemaVersion', 'recordedAt', 'generator', 'capability', 'memory', 'source', 'compatibility', 'incompatibleRefusal', 'destination', 'blueprint', 'custody', 'plan', 'diff']);
  require(d.schemaVersion === 2); date(d.recordedAt);
  object(d.generator, ['command', 'graftRevision']);
  require(d.generator.command === 'node scripts/demo/judge-evidence.mjs'); revision(d.generator.graftRevision);
  object(d.capability, ['name', 'slug', 'behaviors']); text(d.capability.name); text(d.capability.slug);
  items(d.capability.behaviors, (b) => { object(b, ['id', 'text']); text(b.id); text(b.text); });
  object(d.memory, ['memoryId', 'capabilityId', 'sourceRevision', 'sourceFingerprint', 'verification', 'localOnly', 'persisted', 'observations']);
  taggedDigest(d.memory.memoryId); text(d.memory.capabilityId); revision(d.memory.sourceRevision); text(d.memory.sourceFingerprint);
  require(d.memory.verification === 'VERIFIED'); bool(d.memory.localOnly); bool(d.memory.persisted); require(d.memory.localOnly && d.memory.persisted);
  items(d.memory.observations, (o) => {
    object(o, ['kind', 'state', 'destination', 'at']);
    require(['compatibility', 'transplant', 'refusal'].includes(o.kind)); text(o.state); text(o.destination); date(o.at);
  });
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
  object(d.compatibility, ['compatible', 'adaptable', 'incompatible']);
  compatibilityPreview(d.compatibility.compatible); require(d.compatibility.compatible.state === 'COMPATIBLE');
  compatibilityPreview(d.compatibility.adaptable); require(d.compatibility.adaptable.state === 'ADAPTABLE');
  compatibilityPreview(d.compatibility.incompatible); require(d.compatibility.incompatible.state === 'INCOMPATIBLE');
  object(d.incompatibleRefusal, ['fixture', 'state', 'reasons', 'transplantAttempted', 'refused', 'destinationMutated', 'existingFilePreserved']);
  relative(d.incompatibleRefusal.fixture); require(d.incompatibleRefusal.state === 'INCOMPATIBLE'); items(d.incompatibleRefusal.reasons, reason);
  for (const key of ['transplantAttempted', 'refused', 'destinationMutated', 'existingFilePreserved']) bool(d.incompatibleRefusal[key]);
  require(d.incompatibleRefusal.transplantAttempted && d.incompatibleRefusal.refused && !d.incompatibleRefusal.destinationMutated && d.incompatibleRefusal.existingFilePreserved);
  object(d.blueprint, ['filename', 'alternate', 'existingAgentsProtected', 'deterministic', 'content']);
  relative(d.blueprint.filename); bool(d.blueprint.alternate); bool(d.blueprint.existingAgentsProtected); bool(d.blueprint.deterministic); text(d.blueprint.content);
  require(d.blueprint.alternate && d.blueprint.existingAgentsProtected && d.blueprint.deterministic && d.blueprint.content.startsWith('# GRAFT Blueprint Handoff'));
  object(d.custody, ['externalCallPerformed', 'sourceDerivedEgress', 'statement', 'events']);
  bool(d.custody.externalCallPerformed); bool(d.custody.sourceDerivedEgress); text(d.custody.statement);
  require(!d.custody.externalCallPerformed && !d.custody.sourceDerivedEgress);
  items(d.custody.events, (event) => {
    object(event, ['provider', 'operation', 'destination', 'executionLocation', 'sourceDerived', 'dataClass', 'decision', 'reason', 'inputFingerprint', 'timestamp', 'bytesOrItemCount', 'policy']);
    text(event.provider); text(event.operation); text(event.destination); require(event.executionLocation === 'local'); bool(event.sourceDerived); dataClass(event.dataClass);
    require(['ALLOW', 'DENY'].includes(event.decision)); text(event.reason); taggedDigest(event.inputFingerprint); date(event.timestamp);
    require(event.bytesOrItemCount === null || (Number.isInteger(event.bytesOrItemCount) && event.bytesOrItemCount >= 0));
    object(event.policy, ['allowedDataClasses']); items(event.policy.allowedDataClasses, dataClass);
  });
  require(d.custody.events.some((event) => event.dataClass === 'METADATA' && event.decision === 'ALLOW'));
  require(d.custody.events.some((event) => event.dataClass === 'SOURCE_EXCERPT' && event.decision === 'DENY'));
  object(d.plan, ['status', 'previewState', 'adaptation', 'checks', 'conflictResolutionApproved', 'steps', 'files']);
  text(d.plan.status); compatibilityState(d.plan.previewState); text(d.plan.adaptation); bool(d.plan.conflictResolutionApproved);
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
