import { decodeEvidence } from './evidence.js';
const panel = document.querySelector('#panel');
const stages = [...document.querySelectorAll('[data-view]')];
// All evidence strings are rendered as text nodes, never executable markup.
function el(tag, value, className) {
  const n = document.createElement(tag); if (value !== undefined) n.textContent = value;
  if (className) n.className = className; return n;
}
function section(title, ...children) { const n = el('section', undefined, 'card'); n.append(el('h3', title), ...children); return n; }
function list(values) { const n = el('ul'); values.forEach((v) => n.append(el('li', v))); return n; }
function facts(values) { const n = el('dl'); for (const [k, v] of Object.entries(values)) n.append(el('dt', k), el('dd', v)); return n; }
function code(s) { return el('pre', s, 'code'); }
function details(title, child) { const n = el('details'); n.append(el('summary', title), child); return n; }
function grid(...children) { const n = el('div', undefined, 'grid'); n.append(...children); return n; }
function verification(title, r) {
  const tests = el('div', undefined, 'tests');
  for (const t of r.tests) {
    const body = el('div'); body.append(el('p', t.description));
    for (const s of t.steps) body.append(el('p', s.status === null ? 'Application restart' : `${s.request} → HTTP ${s.status}`), list(s.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} · ${c.name}`)));
    const row = details(`${t.outcome.toUpperCase()} · ${t.required ? 'required' : 'optional'} · ${t.id}`, body);
    row.className = t.outcome; tests.append(row);
  }
  return section(title, el('p', r.verdict, `verdict ${r.verdict === 'VERIFIED' ? 'passed' : 'failed'}`),
    el('p', `${r.summary.passed} / ${r.summary.required} required cases passed. ${r.tests.length} total cases recorded.`), tests);
}
export function renderView(view, d) {
  panel.replaceChildren();
  const titles = { find: 'Find the behavior worth keeping.', fit: 'Adapt to the host. Inspect the changes.', prove: 'The result is only as strong as its evidence.', evidence: 'Trace the result back to its local run.' };
  panel.append(el('h2', titles[view]));
  if (view === 'find') {
    panel.append(grid(section('Source project', facts({ Project: d.source.name, Fixture: d.source.fixture, Modules: d.source.shape.moduleSystem, Handlers: d.source.shape.handlerContract, Persistence: d.source.shape.persistence }), code(d.source.revision)),
      section('Discovered capability', el('h4', d.capability.name), list(d.source.discovery.map((c) => `${c.displayName} · ${c.harvestable ? 'harvestable' : 'discovery only'} — ${c.summary}`)))));
    panel.append(section('Behavior captured for harvest', list(d.capability.behaviors.map((b) => b.text)), details('Discovery signals', list(d.source.signals.map((s) => `${s.id} — ${s.evidence}`)))), verification('Source verification', d.source.verification));
  } else if (view === 'fit') {
    panel.append(grid(section('Destination project', facts({ Project: d.destination.name, Modules: d.destination.shape.moduleSystem, Handlers: d.destination.shape.handlerContract, Persistence: d.destination.shape.persistence, Entrypoint: d.destination.entrypoint })),
      section('Transplant plan', el('p', d.plan.adaptation), list(d.plan.steps.map((s) => `${s.order}. ${s.description}`)))));
    panel.append(section('Compatibility and conflicts', list(d.plan.checks.map((c) => `${c.status.toUpperCase()} · ${c.title} — ${c.detail}`)), el('p', `Conflict resolution explicitly approved in the local fixture run: ${d.plan.conflictResolutionApproved ? 'yes' : 'no'}.`)));
    const diff = section('Actual destination diff', el('p', 'Select the entrypoint or a generated file. This is the recorded Git patch, not a reconstruction.'));
    const label = el('label', 'Changed file'); label.htmlFor = 'diff-file';
    const select = el('select'); select.id = 'diff-file';
    const chunks = d.diff.split(/(?=^diff --git )/m).filter(Boolean);
    chunks.forEach((chunk, i) => { const option = el('option', chunk.split('\n')[0].split(' b/')[1]); option.value = String(i); select.append(option); });
    const pre = code(chunks[0]); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Recorded destination patch');
    select.addEventListener('change', () => { pre.textContent = chunks[Number(select.value)]; });
    diff.append(label, select, pre); panel.append(diff);
  } else if (view === 'prove') {
    panel.append(el('p', 'GRAFT booted each fixture locally and exercised its behavior over HTTP. Open a case to inspect requests, status codes, and assertions.'), grid(verification('Source', d.source.verification), verification('Destination', d.destination.verification)),
      section('Read the boundary of VERIFIED', el('p', 'VERIFIED means the required acceptance cases passed. The optional session-after-restart case failed in both fixtures: sessions are held in memory. These results do not establish production authentication security, durable storage, or support for arbitrary architectures.')));
  } else {
    panel.append(section('Recorded run', facts({ Recorded: d.recordedAt, 'GRAFT revision': d.generator.graftRevision, 'Source revision': d.source.revision, 'Destination before transplant': d.destination.baseRevision, 'Destination verified revision': d.destination.revision, Regenerate: d.generator.command })),
      section('Evidence identifiers', facts({ 'Source proof envelope digest': d.source.verification.envelopeDigest, 'Destination proof envelope digest': d.destination.verification.envelopeDigest }), el('p', 'These identifiers refer to the original local proof envelopes. This public projection omits raw envelopes, response bodies, environment values, and recovery receipts. Its download checksum detects corruption; it is not a signature or independent attestation.')),
      section('Generated file SHA-256', facts(Object.fromEntries(d.plan.files.map((f) => [f.path, f.sha256])))));
    const a = el('a', 'Download sanitized evidence JSON ↧', 'button'); a.href = './evidence.json'; a.download = 'graft-recorded-evidence.json'; panel.append(a);
  }
  stages.forEach((b) => { if (b.dataset.view === view) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
}

try {
  const response = await fetch('./evidence.json');
  if (!response.ok) throw new Error('Evidence unavailable');
  const data = await decodeEvidence(await response.json());
  document.querySelector('#load-status').textContent = 'Recorded evidence loaded; integrity and schema checks passed. No new verification was run.';
  document.querySelector('#explorer').hidden = false;
  renderView('find', data);
  stages.forEach((b) => b.addEventListener('click', () => { renderView(b.dataset.view, data); panel.focus(); }));
} catch {
  document.querySelector('#explorer').hidden = true;
  const status = document.querySelector('#load-status'); status.setAttribute('role', 'alert');
  status.textContent = 'Recorded evidence is unavailable or invalid. No verification result can be shown. Reload to retry, or read the technical documentation.';
}
