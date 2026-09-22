const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  bank: '<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  branch: '<path d="M6 5v14m0-7h7a5 5 0 0 0 5-5V5"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  refresh: '<path d="M20 8a9 9 0 1 0 1 7M20 3v6h-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 14h.01M15 14h.01"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.code}</svg>`;
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
// Three different questions, three different looks: verification (VERIFIED good / FAILED bad /
// NEEDS REVIEW warn), continuity (CURRENT current / STALE stale) and proof integrity (neutral).
const ledgerTone = (state) => (state === 'CURRENT' ? 'current' : state === 'STALE' ? 'stale' : state === 'INVALIDATED' ? 'bad' : 'neutral');
const date = (value) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
let desktopVersion = '';
if (window.graftDesktop) { const info = await window.graftDesktop.version(); desktopVersion = info.version + (info.testBuild ? ' · TEST FIXTURE' : ''); }
let data = { projects: [], bank: [], jobs: [], transplants: [] };
let discovery = null;
let discoveryQuery = '';
// Transplant workflow state: what the person chose, what GRAFT prepared, what it proved.
let wf = { slug: '', destinations: null, destination: null, transplant: null, proof: null };
let view = location.hash.slice(1) || 'workspace';
let plan = null;
let selectedJob = null;
let lab = { home: null, blueprint: null, tab: 'overview', plan: null, plans: [], planFor: null, execution: null, assembly: null };
const PLAN_TONE = { DRAFT: 'neutral', BLOCKED_BLUEPRINT: 'bad', NEEDS_HOST: 'warn', UNSUPPORTED_HOST: 'bad', BLOCKED_DEPENDENCIES: 'bad', BLOCKED_CAPABILITY_SUPPORT: 'bad', READY_TO_ASSEMBLE: 'good' };
const PLAN_LABEL = { DRAFT: 'Draft', BLOCKED_BLUEPRINT: 'Blocked by the blueprint', NEEDS_HOST: 'Needs a host', UNSUPPORTED_HOST: 'Unsupported host', BLOCKED_DEPENDENCIES: 'Blocked: dependency cycle', BLOCKED_CAPABILITY_SUPPORT: 'Blocked: capability support', READY_TO_ASSEMBLE: 'Ready to assemble' };
const READINESS_TONE = { DRAFT: 'neutral', NEEDS_SELECTIONS: 'warn', MISSING_CAPABILITIES: 'warn', HAS_CONFLICTS: 'bad', READY_FOR_ASSEMBLY_PLANNING: 'good' };
const READINESS_LABEL = { DRAFT: 'Draft', NEEDS_SELECTIONS: 'Needs selections', MISSING_CAPABILITIES: 'Missing capabilities', HAS_CONFLICTS: 'Has conflicts', READY_FOR_ASSEMBLY_PLANNING: 'Ready for assembly planning' };
const TIER_LABEL = { 'best-evidence': ['Best evidence', 'good'], strong: ['Strong candidate', 'good'], possible: ['Possible candidate', 'neutral'], unproven: ['Unproven', 'warn'] };
// Implementation form, in the words a person uses: what the capability IS, not how well it is proven.
const FORM_LABEL = { service: 'Service', library: 'Library' };
let formState = { slug: '', projectId: '', resolveConflicts: false };
let busy = false;
let connectionError = '';
let timer;

async function api(route, body) {
  const response = await fetch(`/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Graft-Token': $('meta[name="graft-token"]').content, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The operation could not be completed.');
  return result;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(timer); timer = setTimeout(() => $('#toast').classList.remove('show'), 5000);
}
function dialog(title, contents, wide = false) {
  const el = $('#dialog');
  el.className = wide ? 'wide' : '';
  el.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="icon-button" data-action="close" aria-label="Close dialog">${icon('close')}</button></div>${contents}`;
  if (!el.open) el.showModal();
}
function close() { $('#dialog').close(); selectedJob = null; }
// Commercial Beta 0.1: the truthful boundary, from what the packaged product has actually proven.
function supportedView() {
  const row = (label, items) => `<dt>${label}</dt><dd>${items.map((x) => `<span>${esc(x)}</span>`).join('<br>')}</dd>`;
  return `<dl class="export-facts supported">
    ${row('Supported', ['Hosted sign-in (session auth backed by an identity provider) as a service', 'Email/password session auth as a service', 'Feature flags as a library (the proven SwivelJS-style adaptation)', 'Destinations: a new bare node:http application (the Laboratory target), custom ESM node:http hosts, direct-route ESM Express for session-auth transplants'])}
    ${row('Experimental', ['Express ESM hosts for hosted sign-in', 'The repair loop', 'Compatibility learning across your own transplants'])}
    ${row('Not yet', ['CommonJS hosts', 'Non-Node stacks, Next.js, NestJS, Fastify, Koa', 'Other capability kinds', 'Windows and Intel Macs', 'Capabilities that need a live third-party provider to verify'])}</dl>
    <p class="fine">Outside this boundary GRAFT refuses with a reason rather than guessing. Nothing experimental is presented as supported.</p>`;
}
function empty(title, body, action = '') {
  return `<div class="empty"><div class="empty-icon">${icon('branch')}</div><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
}
const disabled = () => busy || data.activeJob || connectionError ? 'disabled' : '';
function projectCards(limit) {
  return data.projects.slice(0, limit).map((p) => `<article class="project-card">
    <div class="card-top"><span class="project-icon">${icon('folder')}</span>${badge(p.error ? 'Unavailable' : p.moduleSystem?.toUpperCase() || 'Project', p.error ? 'bad' : 'neutral')}</div>
    <h3>${esc(p.name)}</h3><p class="path" title="${esc(p.root)}">${esc(p.root)}</p>
    <div class="project-meta"><span>${esc(p.framework || 'Unavailable')}</span><span>${p.routes ?? 0} routes</span></div>
    <div class="card-bottom"><span>${p.capabilities.filter((c) => c.harvestable).length} harvestable</span><button class="text-button" data-action="inspect" data-id="${esc(p.id)}">Explore ${icon('arrow')}</button></div>
    ${p.error ? `<p class="error-text">${esc(p.error)}</p>` : ''}
  </article>`).join('');
}
function activeStrip() {
  const job = data.jobs.find((j) => j.id === data.activeJob);
  return job ? `<button class="active-strip" data-action="job" data-id="${esc(job.id)}"><span class="spinner"></span><span><strong>${esc(job.label)}</strong><small>${esc(job.phase)}</small></span><span class="text-button">View progress ${icon('arrow')}</span></button>` : '';
}
function workspace() {
  const verified = data.bank.filter((b) => b.verification?.verdict === 'VERIFIED').length;
  return `<div class="page-heading"><div><p class="eyebrow">YOU ALREADY BUILT IT</p><h1>Your workspace<span class="heading-dot">.</span></h1><p class="subtitle">Working capabilities. Ready for their next project.</p></div><button class="button primary" data-action="onboard-folder" ${disabled()}>${icon('folder')} Choose software folder</button><button class="button" data-action="add" ${disabled()}>${icon('plus')} Add project</button></div>
  <div class="stats"><div><span class="stat-icon">${icon('folder')}</span><div><span class="stat-label">Connected projects</span><strong>${data.projects.length.toString().padStart(2, '0')}</strong></div></div><div><span class="stat-icon">${icon('bank')}</span><div><span class="stat-label">Verified capabilities</span><strong>${verified.toString().padStart(2, '0')}</strong></div></div><div><span class="stat-icon">${icon('branch')}</span><div><span class="stat-label">Recorded transplants</span><strong>${data.transplants.length.toString().padStart(2, '0')}</strong></div></div></div>
  <section class="journey"><div class="journey-copy"><span class="eyebrow">THE GRAFT WORKFLOW</span><h2>A fresh start.<br>A proven foundation.</h2><p>Bring a capability from a working project into a new one, with its behavior intact.</p><button class="button lime" data-action="navigate" data-view="transplant">Plan a transplant ${icon('arrow')}</button></div><div class="journey-map"><div class="map-node source">${icon('folder')}<span>Source project</span><small>Discover & harvest</small></div><div class="connector"><span></span>${icon('arrow')}</div><div class="map-node organ">${icon('bank')}<span>Organ bank</span><small>Verified behavior</small></div><div class="connector"><span></span>${icon('arrow')}</div><div class="map-node destination">${icon('branch')}<span>New project</span><small>Transplant & verify</small></div><p class="map-caption">REGENERATED FOR THE DESTINATION. CHECKED OVER HTTP.</p></div></section>
  ${activeStrip()}
  <div class="section-heading"><h2>Your projects <span class="count">${data.projects.length}</span></h2><button class="text-button" data-action="navigate" data-view="projects">View all projects ${icon('arrow')}</button></div>
  ${data.projects.length ? `<div class="project-grid">${projectCards(3)}</div>` : (data.workspace?.roots?.length) ? empty('Your software is indexed', 'Search what you have already built, then reuse it.', `<button class="button primary" data-action="navigate" data-view="discover">Open Discover ${icon('arrow')}</button>`) : `<section class="onboard"><span class="eyebrow">START HERE</span><h2>You already built it.</h2><p>Point GRAFT at software you’ve already made. It will find reusable capabilities, determine where they fit, and prove them again in their new home.</p><div class="wf-actions"><button class="button primary" data-action="onboard-folder" ${disabled()}>${icon('folder')} Choose software folder</button><button class="button" data-action="samples" ${disabled()}>${icon('plus')} Create sample workspace</button><button class="text-button" data-action="supported">What’s supported in this beta ${icon('arrow')}</button></div></section>`}
  <div class="bottom-note">${icon('shield')}<span>Your projects stay on this machine. Changes are reviewed before they’re applied.</span><button class="text-button" data-action="about">How GRAFT works ${icon('arrow')}</button></div>`;
}
function projects() {
  return `<div class="page-heading"><div><p class="eyebrow">START WITH WORKING CODE</p><h1>Projects</h1><p class="subtitle">Explore local projects and discover what can be reused.</p></div><button class="button primary" data-action="add" ${disabled()}>${icon('plus')} Add project</button></div>${activeStrip()}
  <div class="toolbar"><span>${data.projects.length} connected projects</span><button class="text-button" data-action="samples" ${disabled()}>${icon('plus')} Create sample workspace</button></div>
  ${data.projects.length ? `<div class="project-grid">${projectCards()}</div>` : empty('No projects connected', 'Add an absolute folder path to start discovering capabilities.')}`;
}
function bank() {
  return `<div class="page-heading"><div><p class="eyebrow">BEHAVIOR WORTH KEEPING</p><h1>Organ bank</h1><p class="subtitle">Capabilities harvested from your projects, with their source evidence.</p>${(data.capabilityMemory || []).length ? `<p class="fine">${data.capabilityMemory.length} capability record(s) remembered locally.</p>` : ''}</div></div>${activeStrip()}
  ${data.bank.length ? `<div class="bank-grid">${data.bank.map((b) => `<article class="bank-card"><div class="card-top"><span class="bank-icon">${icon('shield')}</span>${badge(b.error ? 'Needs recovery' : b.verification?.verdict === 'VERIFIED' ? 'Source verified' : 'Unverified', b.error ? 'bad' : b.verification?.verdict === 'VERIFIED' ? 'good' : 'warn')}${b.implementationForm ? badge(b.implementationForm === 'library' ? 'Library' : 'Service', 'neutral') : ''}</div><h2>${esc(b.name || b.slug)}</h2>${b.implementationForm === 'library' ? `<p class="fine">Form: <strong>Library</strong>${b.library?.packageName ? ` · ${esc(b.library.packageName)}${b.library.packageVersion ? `@${esc(b.library.packageVersion)}` : ''}` : ''}<br>Source verification: <strong>${esc(b.verification?.verdict || 'unverified')}</strong> · Destination integration: <strong>${b.integration?.supported ? esc((b.integration.targets || []).map((t) => `${t.runtime} / ${t.moduleSystem} ${t.profile}`).join(' or ') || 'supported') : 'Not yet proven'}</strong><br><small>${esc(b.integration?.reason || '')}</small></p>` : ''}<p class="subtitle">From ${esc(b.source || 'an unreadable package')}</p>${b.error ? `<p class="error-text">${esc(b.error)}</p>` : `<ul class="behavior-list">${b.statements.slice(0, 3).map((s) => `<li>${icon('check')}<span>${esc(s.text)}</span></li>`).join('')}</ul><div class="bank-foot"><span>${b.tests.length} acceptance tests</span><button class="text-button" data-action="capability" data-slug="${esc(b.slug)}">View contract ${icon('arrow')}</button></div>${capabilityExits(b.slug)}`}</article>`).join('')}</div>` : empty('Your bank is ready for its first capability', 'Explore a source project and harvest authentication. GRAFT tests the source before saving it.', '<button class="button primary" data-action="navigate" data-view="projects">Explore projects</button>')}`;
}
/** The three things a person can do with a harvested capability. Only the first two exist today. */
function capabilityExits(slug) {
  return `<div class="capability-exits">
    <button class="button full" data-action="export-capability" data-slug="${esc(slug)}" ${disabled()}>Download capability ${icon('arrow')}</button><p class="fine">Get the reusable code and everything needed to integrate it yourself.</p>
    <button class="button full" data-action="wf-start" data-slug="${esc(slug)}" ${disabled()}>Add to a project ${icon('arrow')}</button><p class="fine">Let GRAFT adapt it to another project and verify the result.</p>
    <button class="button full" data-action="lab-use" data-slug="${esc(slug)}" ${disabled()}>Use in Laboratory ${icon('arrow')}</button><p class="fine">Build new software with this capability: add it to a blueprint.</p>
  </div>`;
}
function exportSuccess(result) {
  const r = result.receipt; const lic = r.licence || {};
  return `<div class="notice success"><strong>Package created.</strong></div>
  <dl class="export-facts">
    <dt>Package</dt><dd class="path">${esc(r.destination)}</dd>
    <dt>Capability</dt><dd>${esc(r.capability)} · ${esc(r.profile)}</dd>
    <dt>Source verification</dt><dd>${esc(r.verification?.source || 'UNVERIFIED')}${(r.verification?.transplantEvidence || []).length ? ` · transplant evidence: ${esc(r.verification.transplantEvidence.map((e) => `${e.destination} ${e.verified} verified`).join(', '))}` : ''} · universal compatibility not claimed</dd>
    <dt>Source implementation</dt><dd>${esc(r.sourceProject || '')}${r.sourceRevision ? ` @ ${esc(r.sourceRevision.slice(0, 12))}` : ''}</dd>
    <dt>Files</dt><dd>${r.exportedFileCount}</dd>
    <dt>Configuration names</dt><dd>${(r.configurationNames || []).map((n) => `<code>${esc(n)}</code>`).join(' ') || 'none'}</dd>
    <dt>Licence</dt><dd>${esc(lic.declared || lic.state || 'unknown')}${lic.warning ? `<br><span class="warn-text">⚠ ${esc(lic.warning)}</span>` : ''}</dd>
    <dt>Package hash</dt><dd class="path">${esc(r.packageHash)}</dd>
  </dl>
  <div class="wf-actions">${window.graftDesktop ? `<button class="text-button" data-action="wf-reveal" data-root="${esc(r.destination)}">Reveal in Finder ${icon('arrow')}</button>` : ''}<button class="text-button" data-action="wf-copy" data-root="${esc(r.destination)}">Copy path</button><button class="button primary" data-action="close">Done</button></div>`;
}
// ---------------------------------------------------------------------------------------------
// Laboratory 0.1: capability blueprints. Every fact shown comes from the blueprint's deterministic
// analysis; agent advice is labelled advisory and changes nothing until the person accepts it.
// ---------------------------------------------------------------------------------------------
function laboratory() {
  if (lab.blueprint) return blueprintView(lab.blueprint);
  const home = lab.home;
  if (!home) { loadLaboratoryHome(); return `<div class="page-heading"><div><p class="eyebrow">BUILD FROM WHAT YOU HAVE</p><h1>Laboratory</h1><p class="subtitle">What are you building?</p></div></div><p class="muted">Loading…</p>`; }
  return `<div class="page-heading"><div><p class="eyebrow">BUILD FROM WHAT YOU HAVE</p><h1>Laboratory</h1><p class="subtitle">What are you building? Describe it, tick what it needs, and GRAFT will show which capabilities you already have, what depends on what, and what is missing.</p></div></div>
  <section class="panel"><div class="panel-title"><span class="step-number">01</span><h2>New blueprint</h2></div>
  <form id="lab-create-form"><label for="lab-name">Name</label><input id="lab-name" name="name" placeholder="Client portal" required maxlength="80" ${disabled()}>
  <label for="lab-description">Describe the idea (optional)</label><textarea id="lab-description" name="description" rows="3" maxlength="4000" placeholder="Customers sign in, upload documents, pay invoices and see their account." ${disabled()}></textarea>
  <p class="fine">Do people need to…</p><div class="lab-checklist">${home.questions.map((q) => `<label class="checkbox"><input type="checkbox" name="categories" value="${esc(q.category)}"><span>${esc(q.question)}</span></label>`).join('')}</div>
  <label for="lab-host">What are you starting from?</label><select id="lab-host" name="hostIntent"><option value="decide-later">Decide later</option><option value="new-application">A new blank application</option><option value="existing-project">An existing project</option></select>
  <button class="button primary full" ${disabled()}>Create blueprint ${icon('arrow')}</button>
  <p class="fine">${home.agentConfigured ? 'An agent is configured: inside the blueprint you can ask it to help design; its suggestions stay suggestions until you accept them.' : 'No agent is configured. Laboratory works without one: your words and the checklist drive it.'}</p></form></section>
  <section class="panel"><div class="section-heading"><h2>Saved blueprints</h2>${badge(`${home.blueprints.length}`, 'neutral')}</div>${home.blueprints.length ? home.blueprints.map((b) => `<div class="history-row">${icon('plus')}<div><strong>${esc(b.name)}</strong><small>${b.goals} goal(s) · ${b.selected} selected · ${date(b.updatedAt)}</small></div><button class="text-button" data-action="lab-open" data-id="${esc(b.blueprintId)}">Open ${icon('arrow')}</button><button class="text-button" data-action="lab-delete" data-id="${esc(b.blueprintId)}">Delete</button></div>`).join('') : '<p class="muted">No blueprints yet.</p>'}</section>`;
}
async function loadLaboratoryHome() { try { lab.home = await api('laboratory', {}); render(); } catch (err) { toast(err.message); } }
function blueprintView(b) {
  const a = b.analysis; const tone = READINESS_TONE[a.readiness] || 'neutral';
  const tabs = [['overview', 'Overview'], ['capabilities', 'Capabilities'], ['dependencies', 'Dependencies'], ['conflicts', 'Conflicts'], ['evidence', 'Evidence'], ['plan', 'Assembly Plan']];
  const goalTree = a.goals.map((g) => `<li class="bp-node"><strong>${esc(g.label)}</strong>${g.required ? '' : badge('optional', 'neutral')} ${badge(g.status === 'matched' ? 'selected' : g.status === 'missing' ? 'MISSING' : g.status === 'source-unavailable' ? 'SOURCE UNAVAILABLE' : 'needs a selection', g.status === 'matched' ? 'good' : g.status === 'missing' || g.status === 'source-unavailable' ? 'bad' : 'warn')}
    ${g.selected ? `<ul><li>└── ${esc(g.selected.name)}${g.selected.verification ? ` · ${esc(g.selected.verification.source === 'VERIFIED' ? 'VERIFIED source' : g.selected.verification.source)}` : ''}${(g.selected.verification?.families || []).filter((f) => f.verified).length ? ` · ${g.selected.verification.families.filter((f) => f.verified).length} verified host famil${g.selected.verification.families.filter((f) => f.verified).length === 1 ? 'y' : 'ies'}` : ''}</li>${a.dependencies.filter((d) => d.from === g.goalId && d.needs && d.level === 'DECLARED').map((d) => `<li class="fine">depends on: ${esc(d.needsLabel)} ${d.satisfied ? '✓' : '✗'}</li>`).join('')}</ul>` : g.status === 'missing' ? `<ul><li>└── ${esc(g.searched ? 'No suitable capability was found in Capability Memory.' : g.searchReason || 'not found')}</li></ul>` : `<ul><li>└── ${g.candidates.length} candidate(s) — choose one under Capabilities</li></ul>`}</li>`).join('');
  const overview = `<div class="bp-readiness">${badge(READINESS_LABEL[a.readiness] || a.readiness, tone)}<p class="fine">${esc(a.readinessReason)}</p>${a.readiness === 'READY_FOR_ASSEMBLY_PLANNING' ? '<p class="notice">Assembly coming next. Nothing has been built or verified; this blueprint is a design GRAFT can plan from.</p>' : ''}</div>
    <ul class="bp-tree">${goalTree || '<li class="muted">No goals yet — add some under Capabilities.</li>'}</ul>
    <h3 class="small-heading">Starting from</h3><select data-action="lab-host" ${disabled()}><option value="decide-later" ${b.hostIntent.kind === 'decide-later' ? 'selected' : ''}>Decide later</option><option value="new-application" ${b.hostIntent.kind === 'new-application' ? 'selected' : ''}>A new blank application</option><option value="existing-project" ${b.hostIntent.kind === 'existing-project' ? 'selected' : ''}>An existing project</option></select>
    ${b.agentAdvice ? `<h3 class="small-heading">Agent advice ${badge('advisory', 'neutral')}</h3><p class="fine">${esc(b.agentAdvice.provider || '')}${b.agentAdvice.value?.notes ? ` — ${esc(b.agentAdvice.value.notes)}` : ''}</p>${(b.agentAdvice.value?.goals || []).map((g) => `<div class="history-row"><div><strong>${esc(g.label)}</strong><small>${esc(g.category)} · ${g.required ? 'required' : 'optional'}${g.rationale ? ` · ${esc(g.rationale)}` : ''}</small></div>${b.goals.some((x) => x.category === g.category) ? badge('already a goal', 'neutral') : `<button class="text-button" data-action="lab-accept" data-slug="${esc(g.category)}" data-root="${esc(g.label)}" data-index="${g.required ? 1 : 0}">Accept as a goal</button>`}</div>`).join('')}${(b.agentAdvice.value?.questions || []).length ? `<p class="fine">Questions the agent suggests: ${b.agentAdvice.value.questions.map((q) => esc(q)).join(' · ')}</p>` : ''}` : ''}
    ${lab.home?.agentConfigured ? `<button class="text-button" data-action="lab-advise" ${disabled()}>Help me design this ${icon('robot')}</button>` : ''}`;
  const capabilities = `<div class="lab-add"><select data-role="lab-add-category">${(lab.home?.categories || []).map((c) => `<option value="${esc(c.id)}">${esc(c.label)}${c.searchable ? '' : ' (no detector yet)'}</option>`).join('')}</select><button class="text-button" data-action="lab-add-goal">Add goal</button></div>
    ${a.goals.map((g) => `<section class="panel bp-goal"><div class="section-heading"><h2>${esc(g.label)}</h2><span>${g.required ? badge('required', 'neutral') : badge('optional', 'neutral')} <button class="text-button" data-action="lab-required" data-id="${esc(g.goalId)}" data-index="${g.required ? 0 : 1}">${g.required ? 'Make optional' : 'Make required'}</button> <button class="text-button" data-action="lab-remove-goal" data-id="${esc(g.goalId)}">Remove</button></span></div>
      ${g.status === 'missing' ? `<div class="notice"><strong>NOT FOUND</strong><p>${esc(g.searched ? 'No suitable capability was found in Capability Memory.' : g.searchReason)}</p><p class="fine">Future action: create a new capability — coming in a later Laboratory phase. You can leave it unresolved, remove it, make it optional, or authorize another workspace under Discover.</p></div>` : ''}
      ${g.status === 'source-unavailable' ? `<div class="notice error-text"><strong>SOURCE UNAVAILABLE</strong><p>${esc(g.selected.unavailableReason)}</p><button class="text-button" data-action="lab-select" data-id="${esc(g.goalId)}" data-index="-1">Clear selection</button></div>` : ''}
      ${g.candidates.length ? `<div class="wf-choices">${g.candidates.slice(0, 8).map((c, i) => `<button class="wf-choice ${g.selected && ((c.kind === 'organ' && g.selected.slug === c.slug) || (c.kind === 'observation' && g.selected.projectId === c.projectId && g.selected.capability === c.capability)) ? 'selected' : ''}" data-action="lab-select" data-id="${esc(g.goalId)}" data-index="${i}" ${disabled()}><strong>${esc(c.name)}</strong><small>${badge(TIER_LABEL[c.tier][0], TIER_LABEL[c.tier][1])} ${esc(c.tierReason)}</small><small>Origin: ${esc(c.origin.kind === 'open-source' ? `Open source · ${c.origin.licence.declared}` : c.origin.kind === 'your-project' ? `Your project${c.origin.licence.declared ? ` · ${c.origin.licence.declared}` : ''}` : 'Workspace observation')}${c.origin.licence.state === 'not-detected' ? ' · licence unknown' : c.origin.licence.state === 'private-unspecified' ? ' · licence unspecified' : c.origin.licence.state === 'not-inspected' ? ' · licence not inspected yet' : ''}</small>${c.implementationForm ? `<small>Form: ${esc(FORM_LABEL[c.implementationForm] || c.implementationForm)}${c.verification?.source ? ` · source ${esc(c.verification.source)}${c.verification.summary ? ` ${c.verification.summary.passed}/${c.verification.summary.required}` : ''}` : ''}</small>` : ''}${c.integration ? `<small>${c.integration.supported ? `Destination integration: ${esc((c.integration.targets || []).map((t) => `${t.runtime} / ${t.moduleSystem} ${t.profile}`).join(' or ') || 'supported')}` : `Destination integration: none yet`}</small>` : ''}</button>`).join('')}${g.candidates.length > 8 ? `<p class="fine">${g.candidates.length - 8} more candidate(s) with weaker evidence are not shown.</p>` : ''}</div>` : ''}
    </section>`).join('')}`;
  const dependencies = a.dependencies.length ? `<table class="bp-table"><thead><tr><th>Goal</th><th>Needs</th><th>Level</th><th>State</th><th>Detail</th></tr></thead><tbody>${a.dependencies.map((d) => `<tr><td>${esc(d.fromLabel || '—')}</td><td>${esc(d.needsLabel || d.needs || '—')}</td><td>${badge(d.level, d.level === 'PROVEN' ? 'good' : d.level === 'DECLARED' ? 'neutral' : d.level === 'ADVISORY' ? 'warn' : 'neutral')}</td><td>${d.satisfied === true ? badge('satisfied', 'good') : d.satisfied === false ? badge(d.blocking ? 'unmet · blocking' : 'unmet', d.blocking ? 'bad' : 'warn') : badge('n/a', 'neutral')}</td><td class="fine">${esc(d.detail)}</td></tr>`).join('')}</tbody></table><p class="fine">PROVEN dependencies would come from Atlas observations of capabilities verified together; none exist yet. DECLARED comes from GRAFT's own vocabulary, INFERRED from a harvested capability's artifacts, ADVISORY from an agent and is never a fact.</p>` : '<p class="muted">No dependencies to show.</p>';
  const conflicts = a.conflicts.length ? a.conflicts.map((c) => `<div class="notice ${c.blocking === false ? '' : 'error-text'}"><strong>${esc(c.kind.replace(/-/g, ' ').toUpperCase())}</strong> — ${esc(c.labels.join(' ↔ '))}<p>${esc(c.detail)}</p>${c.options.length ? `<p class="fine">Options: ${c.options.map((o) => esc(o)).join(' · ')}</p>` : ''}</div>`).join('') : '<p class="muted">No structural conflicts are known.</p>';
  const evidence = a.goals.filter((g) => g.selected).map((g) => { const s = g.selected; return `<section class="panel"><div class="section-heading"><h2>${esc(g.label)}: ${esc(s.name)}</h2>${badge(s.status === 'AVAILABLE' ? 'available' : 'source unavailable', s.status === 'AVAILABLE' ? 'good' : 'bad')}</div>
      <dl class="export-facts"><dt>Origin</dt><dd>${esc(s.origin?.project || '')} · ${esc(s.origin?.kind || '')}${s.origin?.licence ? ` · licence ${esc(s.origin.licence.declared || s.origin.licence.state)}${s.origin.licence.warning ? ` <span class="warn-text">⚠ ${esc(s.origin.licence.warning)}</span>` : ''}` : ''}</dd>
      ${s.implementationForm ? `<dt>Form</dt><dd>${esc(FORM_LABEL[s.implementationForm] || s.implementationForm)}${s.implementationForm === 'library' ? ' — a library a program loads, not a service that serves routes' : ''}</dd>` : ''}
      <dt>Source verification</dt><dd>${esc(s.verification?.source || 'UNKNOWN')}${s.verification?.summary ? ` (${s.verification.summary.passed}/${s.verification.summary.required} required)` : ''}<br><small>What the capability does in its own project. Whether it can be added to a particular host is a separate question, below.</small></dd>
      ${s.integration ? `<dt>Destination integration</dt><dd>${s.integration.supported ? `${badge('supported', 'good')} ${esc((s.integration.targets || []).map((t) => `${t.runtime} / ${t.moduleSystem} · ${t.profile}`).join(' or '))}` : badge('none yet', 'warn')}<br><small>${esc(s.integration.reason || '')}</small></dd>` : ''}
      ${s.genomeId || s.capabilityId ? `<dt>Technical details</dt><dd><details class="tech"><summary>Identifiers</summary>${s.capabilityId ? `<small>capability id</small><br><span class="path">${esc(s.capabilityId)}</span><br>` : ''}${s.genomeId ? `<small>genome id</small><br><span class="path">${esc(s.genomeId)}</span>` : ''}</details></dd>` : ''}
      ${s.architecture ? `<dt>Architecture</dt><dd>${esc([s.architecture.runtime?.family, s.architecture.moduleSystem, s.architecture.framework, s.architecture.handlerContract].filter(Boolean).join(' / '))}${s.model?.credentialAuthority ? ` · credentials: ${esc(s.model.credentialAuthority)}` : ''}${s.model?.session ? ` · sessions: ${esc([s.model.session.transport, s.model.session.custody, s.model.session.store].filter(Boolean).join('/'))}` : ''}</dd>` : ''}
      <dt>Transplant history on this machine</dt><dd>${(s.verification?.families || []).length ? s.verification.families.map((f) => `${esc(f.destination)}: ${f.verified} verified${f.failed ? `, ${f.failed} failed` : ''}`).join(' · ') : 'no transplant observations recorded on this machine'}</dd>
      <dt>Host evidence</dt><dd>${(s.verification?.hostEvidence || []).length ? s.verification.hostEvidence.map((h) => `${h.status === 'verified-evidence' ? '✓' : '·'} ${esc(h.profile)} — ${h.status === 'verified-evidence' ? `${h.verified} verified` : 'verified evidence unavailable (requires future compatibility analysis)'}`).join('<br>') : 'n/a'}</dd>
      <dt>Depends on</dt><dd>${a.dependencies.filter((d) => d.from === g.goalId && d.needs).map((d) => `${esc(d.needsLabel || d.needs)} [${esc(d.level)}]`).join(' · ') || 'nothing declared'}</dd>
      <dt>Configuration names</dt><dd>${(s.configurationNames || []).map((n) => `<code>${esc(n)}</code>`).join(' ') || 'none'}</dd>
      ${s.dependencies?.services?.length ? `<dt>External services</dt><dd>${s.dependencies.services.map((x) => `${esc(x.name)} (${esc(x.role)})`).join(', ')}</dd>` : ''}</dl></section>`; }).join('') || '<p class="muted">Select implementations to see their evidence.</p>';
  const plan = assemblyPlanView(b);
  const body = { overview, capabilities, dependencies, conflicts, evidence, plan }[lab.tab] || overview;
  return `<div class="page-heading"><div><p class="eyebrow">LABORATORY · BLUEPRINT</p><h1>${esc(b.name)}</h1><p class="subtitle">${esc(b.description || 'No description.')}</p></div>${badge(READINESS_LABEL[a.readiness] || a.readiness, tone)}</div>
  <div class="wf-steps"><button class="text-button" data-action="lab-back">← All blueprints</button>${tabs.map(([id, label]) => `<button class="wf-step ${lab.tab === id ? 'current' : ''}" data-action="lab-tab" data-id="${id}">${label}${id === 'conflicts' && a.conflicts.length ? ` (${a.conflicts.length})` : ''}</button>`).join('')}</div>
  <section class="panel">${body}</section>`;
}
// Plain words for plan steps and execution stages. The goal label ("User authentication") comes
// from the plan's own order; the step type stays visible beside it. Nothing here decides anything.
const STEP_WORDS = { CREATE_HOST: 'Create application', REINDEX_HOST: 'Re-index host', CHECK_DEPENDENCIES: 'Check capability requirements', VERIFY_SOURCE_ARTIFACT_IDENTITY: 'Verify source artifact identity', TRANSPLANT_CAPABILITY: 'Transplant capability', ADAPT_LIBRARY_CAPABILITY: 'Adapt library capability', VERIFY_CAPABILITY: 'Verify capability', REVERIFY_CAPABILITY: 'Re-verify capability', CHECK_HOST_PRESERVATION: 'Check host preservation', FINAL_VERIFICATION: 'Final verification' };
const goalLabel = (p, goalId) => p?.order?.find((o) => o.goalId === goalId)?.label || null;
const capabilityLabel = (p, capabilityId, fallback) => p?.expectedCapabilities?.find((c) => c.capabilityId === capabilityId)?.label || fallback;
function planStepLabel(p, s) {
  const goal = s.goalId ? goalLabel(p, s.goalId) : null;
  if (s.type === 'CHECK_HOST_PRESERVATION' && !s.goalId && p.composition) return 'Check final host preservation';
  if (s.type === 'REINDEX_HOST' && p.composition && s.stepId === [...p.steps].reverse().find((x) => x.type === 'REINDEX_HOST')?.stepId) return 'Re-index the composed application';
  return goal ? `${STEP_WORDS[s.type] || s.type} — ${goal}` : STEP_WORDS[s.type] || s.type;
}
// Execution stages, from the execution's own step record joined to the plan step it came from.
function executionStageLabel(e, p, s) {
  const planStep = p?.steps?.find((x) => x.stepId === s.stepId) || {};
  const goal = planStep.goalId ? goalLabel(p, planStep.goalId) : null;
  const reindexes = e.steps.filter((x) => x.type === 'REINDEX_HOST');
  switch (s.type) {
    case 'CREATE_HOST': return 'Creating application';
    case 'REINDEX_HOST': return reindexes[0]?.stepId === s.stepId ? 'Indexing host' : reindexes.at(-1)?.stepId === s.stepId ? 'Re-indexing application' : 'Re-indexing host';
    case 'CHECK_DEPENDENCIES': return 'Checking capability requirements';
    case 'VERIFY_SOURCE_ARTIFACT_IDENTITY': return goal ? `Verifying ${goal} artifact` : 'Checking the verified artifact';
    case 'TRANSPLANT_CAPABILITY': return goal ? `Adding ${goal}` : 'Applying capability';
    case 'ADAPT_LIBRARY_CAPABILITY': return goal ? `Adapting ${goal}` : 'Adding the library capability';
    case 'VERIFY_CAPABILITY': return goal ? `Verifying ${goal}` : 'Verifying the capability';
    case 'REVERIFY_CAPABILITY': return goal ? `Re-verifying ${goal}` : 'Re-verifying the capability';
    case 'CHECK_HOST_PRESERVATION': return planStep.goalId || !e.composition ? 'Checking host preservation' : 'Checking final host preservation';
    case 'FINAL_VERIFICATION': return e.composition ? 'Final verification' : 'Final check';
    default: return s.type;
  }
}
// Assembly Plan tab: the person chooses a host; GRAFT describes, in order, what it would do with
// its existing operations. Nothing here executes. Readiness comes from the deterministic planner.
function assemblyPlanView(b) {
  const hosts = lab.home?.hosts || { architectures: [], projects: [] };
  const intent = b.hostIntent?.kind || 'decide-later';
  const chooser = `<h3 class="small-heading">Host</h3><div class="asm-host">
    <label class="checkbox"><input type="radio" name="lab-host-kind" value="new-application" ${intent !== 'existing-project' ? 'checked' : ''}><span>A new blank application</span></label>
    <select id="lab-arch" aria-label="Starting architecture">${hosts.architectures.map((a) => `<option value="${esc(a.id)}">${esc(a.label)} — writes ${a.kinds.join(', ')}</option>`).join('')}</select>
    <label class="checkbox"><input type="radio" name="lab-host-kind" value="existing-project" ${intent === 'existing-project' ? 'checked' : ''}><span>An existing project (its Host Model decides what fits)</span></label>
    <select id="lab-project" aria-label="Existing project">${hosts.projects.length ? hosts.projects.map((p) => `<option value="${esc(p.projectId)}">${esc(p.name)}</option>`).join('') : '<option value="">No registered projects</option>'}</select>
    <button class="button primary" data-action="lab-plan-build" ${disabled()}>Build assembly plan ${icon('arrow')}</button>
    <p class="fine">Planning reads the organ bank, the Host Model and the Atlas. It creates no folder, no repository, no worktree, and writes nothing into any project.</p></div>`;
  const p = lab.plan;
  if (lab.planFor !== b.blueprintId) { loadAssemblyPlan(b.blueprintId); return `${chooser}<p class="muted">Loading plans…</p>`; }
  if (!p) return `${chooser}<p class="muted">No assembly plan yet for this blueprint.</p>`;
  const tone = PLAN_TONE[p.readiness] || 'neutral';
  const host = p.host || {};
  const hostBlock = host.kind === 'new-application' ? `<dl class="asm-spec"><dt>Host</dt><dd>NEW APPLICATION — ${esc(host.label)} ${badge('specified, not created', 'neutral')}</dd><dt>Runtime</dt><dd>${esc(host.runtime?.family)} ${esc(host.runtime?.range || '')}</dd><dt>Module system</dt><dd>${esc(host.moduleSystem)}</dd><dt>HTTP architecture</dt><dd>${esc(host.framework)} / ${esc(host.handlerContract)}</dd><dt>Persistence</dt><dd>${esc(host.persistence === 'none' ? 'None selected' : host.persistence)}</dd><dt>Compatibility profile</dt><dd><code>${esc(host.profile)}</code><details class="tech"><summary>Technical details</summary><small>proven by ${esc(host.provenBy)}</small></details></dd></dl>`
    : host.kind === 'existing-project' ? `<dl class="asm-spec"><dt>Host</dt><dd>EXISTING PROJECT — ${esc(host.name)} ${badge('inspected', 'neutral')}</dd><dt>Shape</dt><dd>${esc(host.moduleSystem)} / ${esc(host.framework)} / ${esc(host.handlerContract)}${host.entrypoint ? ` · entrypoint <code>${esc(host.entrypoint)}</code>` : ''}</dd><dt>Persistence</dt><dd>${esc(host.persistence || 'unknown')}</dd><dt>Compatibility profile</dt><dd>${host.profile ? `<code>${esc(host.profile)}</code>` : `none — ${esc(host.unsupportedReason || 'unsupported shape')}`}</dd><dt>Existing capabilities</dt><dd>${(host.existingCapabilities || []).join(', ') || 'none detected'}</dd></dl>`
    : `<p class="notice">No host chosen yet. ${esc(p.readinessReason)}</p>`;
  // Plain language for the operation the steps describe, so the person does not have to read a
  // table to understand what will happen to their application.
  const adaptStep = p.steps.find((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY');
  const adaptCopy = adaptStep ? `<div class="notice"><strong>Add ${esc(adaptStep.capability?.name || 'the capability')}</strong>
    <p>GRAFT will carry the verified library artifact into the new application unchanged, and generate a small ESM adapter beside it.</p>
    <p class="fine">No package installation. No source build. No HTTP routes added.${adaptStep.integration?.artifact ? ` The artifact <code>${esc(adaptStep.integration.artifact)}</code> is copied verbatim; the adapter <code>${esc(adaptStep.integration.adapter || '')}</code> is written by GRAFT.` : ''}</p></div>` : '';
  const steps = `<table class="asm-steps"><thead><tr><th>#</th><th>Step</th><th>What GRAFT will do</th><th>Why</th><th>Support</th></tr></thead><tbody>${p.steps.map((s) => `<tr><td class="n">${s.order}</td><td><strong>${esc(planStepLabel(p, s))}</strong>${s.operation.exists ? '' : '<br><small>operation not built yet</small>'}<details class="tech"><summary>Technical details</summary><small>${esc(s.type)}</small><br><code>${esc(s.operation.function)}</code></details></td><td>${esc(s.what)}${s.configurationNames?.length ? `<br><small>configuration: ${s.configurationNames.map((n) => `<code>${esc(n)}</code>`).join(' ')}</small>` : ''}</td><td class="fine">${esc(s.why)}</td><td>${badge(s.supported ? 'supported' : 'not supported', s.supported ? 'good' : 'bad')}<br><small>${esc(s.supportReason)}</small></td></tr>`).join('')}</tbody></table>`;
  const list = (items, render, empty) => items.length ? items.map(render).join('') : `<p class="muted">${empty}</p>`;
  return `${chooser}
    ${p.status === 'STALE' ? `<div class="asm-stale"><strong>STALE</strong> — this plan no longer matches the blueprint: ${p.freshness.reasons.map((r) => esc(r)).join('; ')}. Build a fresh plan.</div>` : ''}
    <div class="bp-readiness">${badge(PLAN_LABEL[p.readiness] || p.readiness, tone)}<p class="fine">${esc(p.readinessReason)}</p></div>
    ${hostBlock}
    ${adaptCopy}
    ${p.order?.length > 1 ? `<h3 class="small-heading">Execution order</h3><ol class="asm-order">${p.order.map((o) => `<li><strong>${esc(o.label)}</strong>${o.implementation ? ` — ${esc(o.implementation)}` : ''}${o.decidedBy === 'declared-dependency' ? ' <small>(after what it depends on)</small>' : ''}</li>`).join('')}</ol>
      <p class="fine">${p.ordering?.rule === 'blueprint-declared-order' ? 'Capabilities are added in the order the blueprint lists them; a capability that depends on another comes after it.' : esc(p.ordering?.detail || '')}${p.composition ? ` After the last one is added, every earlier capability is verified again on the combined application, and one final revision carries them all.` : ''}</p>` : ''}
    <h3 class="small-heading">Ordered steps</h3>${steps}
    <h3 class="small-heading">Capabilities involved</h3>${list(p.expectedCapabilities, (c) => `<div class="history-row"><div><strong>${esc(c.label)}: ${esc(c.name)}</strong><small>${esc(c.kind || '')} · ${esc(c.origin?.kind === 'open-source' ? `Open source · ${c.origin.licence.declared}` : c.origin?.kind === 'your-project' ? `Your project · ${c.origin.licence?.declared || c.origin.licence?.state}` : 'origin unknown')} · <code>${esc((c.capabilityId || '').slice(0, 23))}…</code></small></div></div>`, 'No capability is ready to be applied.')}
    <h3 class="small-heading">Blockers ${badge(`${p.blockers.length}`, p.blockers.length ? 'bad' : 'good')}</h3>${list(p.blockers, (x) => `<div class="notice error-text"><strong>${esc(x.kind.replace(/[-:]/g, ' ').toUpperCase())}</strong>${x.label ? ` — ${esc(x.label)}` : ''}<p>${esc(x.detail)}</p>${x.options?.length ? `<p class="fine">Options: ${x.options.map((o) => esc(o)).join(' · ')}</p>` : ''}</div>`, 'No blockers.')}
    <h3 class="small-heading">Warnings ${badge(`${p.warnings.length}`, p.warnings.length ? 'warn' : 'neutral')}</h3>${list(p.warnings, (x) => `<div class="notice"><strong>${esc(x.kind.replace(/-/g, ' ').toUpperCase())}</strong><p>${esc(x.detail)}</p></div>`, 'No warnings.')}
    <h3 class="small-heading">Dependencies</h3>${list(p.dependencies, (d) => `<div class="history-row"><div><strong>${esc(d.from)} → ${esc(d.needs)}</strong><small>${esc(d.level)} · ${d.satisfied === true ? 'satisfied' : d.satisfied === false ? (d.blocking ? 'unmet, blocking' : 'unmet') : 'n/a'}</small></div></div>`, 'No dependencies.')}
    <h3 class="small-heading">Prior evidence ${badge('evidence only', 'neutral')}</h3>${list(p.evidence, (e) => `<div class="history-row"><div><strong>${esc(e.name)}</strong><small>source ${esc(e.sourceVerdict || 'unknown')} · ${e.atlasFamilies.length ? e.atlasFamilies.map((f) => `${f.verified ? '✓' : '·'} ${esc(f.destination)} (${f.verified} verified${f.failed ? `, ${f.failed} failed` : ''})`).join(' · ') : 'no transplant observations on this machine'}${e.chosenProfile ? ` · chosen profile ${esc(e.chosenProfile)}: ${esc(e.chosenProfileEvidence)}` : ''}</small></div></div>`, 'No selected capability to show evidence for.')}
    ${p.agentAdvice ? `<h3 class="small-heading">Agent explanation ${badge('advisory', 'neutral')}</h3><p class="fine">${esc(p.agentAdvice.value?.explanation || '')}${p.agentAdvice.value?.orderingRationale ? ` — ${esc(p.agentAdvice.value.orderingRationale)}` : ''}</p>${(p.agentAdvice.value?.blockerExplanations || []).map((x) => `<p class="fine"><strong>${esc(x.blocker)}</strong>: ${esc(x.explanation)}${x.suggestion ? ` (${esc(x.suggestion)})` : ''}</p>`).join('')}` : ''}
    ${assemblyExecutionView(p)}
    <div class="capability-exits">${p.readiness === 'READY_TO_ASSEMBLE' && p.status === 'CURRENT' && p.host?.architectureId === 'node-esm-http-central' ? `<button class="button primary full" data-action="lab-assemble" data-id="${esc(p.planId)}" ${disabled()}>Assemble application ${icon('arrow')}</button><p class="fine">GRAFT will create the application in a folder you choose, add the capability in an isolated worktree and verify it.</p>` : `<button class="button full" disabled aria-disabled="true" title="${p.readiness === 'READY_TO_ASSEMBLE' ? 'This phase assembles only new bare node:http applications' : 'The plan is not ready to assemble'}">Assemble application ${badge(p.readiness === 'READY_TO_ASSEMBLE' ? 'node:http hosts only' : 'not ready', 'neutral')}</button><p class="fine">${esc(p.readiness === 'READY_TO_ASSEMBLE' ? 'Assembly for other hosts comes later. Build the plan for a new Node / ESM / bare node:http application to assemble it now.' : 'Resolve the blockers above; a plan that is not READY_TO_ASSEMBLE cannot be executed.')}</p>`}${lab.home?.agentConfigured ? `<button class="text-button" data-action="lab-plan-explain" data-id="${esc(p.planId)}" ${disabled()}>Explain this plan ${icon('robot')}</button>` : ''}${lab.plans.length > 1 ? `<p class="fine">${lab.plans.length} plans saved for this blueprint; the newest is shown.</p>` : ''}</div>`;
}
// Execution progress and result come from the execution record the product keeps; nothing here narrates ahead of it.
function assemblyExecutionView(p) {
  const active = data.jobs.find((j) => j.id === data.activeJob && j.kind === 'assembly');
  if (active) lab.executionCheckedFor = null;
  else if (!lab.execution && lab.executionCheckedFor !== p.planId && data.jobs.some((j) => j.kind === 'assembly')) { lab.executionCheckedFor = p.planId; loadAssemblyPlan(p.blueprintId); }
  const e = active?.execution || lab.execution;
  if (!e || e.planId !== p.planId) return '';
  // The re-index that reads the assembled result is the LAST one, whatever the plan's length is.
  const lastReindex = [...e.steps].reverse().find((s) => s.type === 'REINDEX_HOST')?.stepId || null;
  const tone = { COMPLETED: 'good', FAILED: 'bad', INCONCLUSIVE: 'warn', BLOCKED: 'bad', STALE: 'warn' }[e.status] || 'neutral';
  const rows = e.steps.map((s) => `<div class="checks"><div><span class="check-symbol ${s.status === 'FAILED' ? 'bad' : ''}">${s.status === 'DONE' ? '✓' : s.status === 'RUNNING' ? '<span class="spinner"></span>' : s.status === 'FAILED' ? '✕' : s.status === 'SKIPPED' ? '–' : '·'}</span><div><strong>${esc(executionStageLabel(e, p, s))}${!e.composition && s.type === 'REINDEX_HOST' && s.stepId === lastReindex && e.steps.filter((x) => x.type === 'REINDEX_HOST').length > 1 ? ' (assembled result)' : ''}</strong><small>${esc(s.status === 'RUNNING' && e.phase ? e.phase : s.what)}${s.error ? ` — ${esc(s.error)}` : ''}</small></div></div></div>`).join('');
  const done = ['COMPLETED', 'FAILED', 'INCONCLUSIVE', 'BLOCKED', 'STALE'].includes(e.status);
  const v = e.verification;
  const result = done ? `<div class="report-banner ${e.status === 'COMPLETED' ? 'success' : 'failure'}"><div><strong>Assembly ${esc(e.status)}</strong><br><span>${esc(e.finalSummary?.wording || '')}</span></div></div>
    ${e.composition ? `${compositionResultView(e, p)}${assembledApplicationView(e)}` : v ? `<dl class="export-facts"><dt>Capability</dt><dd>${esc(v.capability)} — ${badge(v.verdict, v.verdict === 'VERIFIED' ? 'good' : v.verdict === 'FAILED' ? 'bad' : 'warn')} ${v.summary ? `${v.summary.passed}/${v.summary.required} required` : ''}${v.attempts > 1 ? ` · ${v.attempts} attempt(s)` : ''}</dd>
      <dt>Host preservation</dt><dd>${e.hostPreservation ? (e.hostPreservation.captured ? `${e.hostPreservation.passed}/${e.hostPreservation.tests} passed` : `not captured — ${esc(e.hostPreservation.reason || '')}`) : 'n/a'}</dd>
      <dt>Final assembly verification</dt><dd>${esc(e.finalSummary?.finalAssemblyVerification || '')}</dd>
      ${e.reindex ? `<dt>Re-index</dt><dd>${e.reindex.detectorObservation === 'NOT_OBSERVED' ? 'The workspace detector does not independently recognise this capability in the assembled application' : e.reindex.detectorObservation === 'OBSERVED' ? 'The workspace detector independently recognises this capability in the assembled application' : e.reindex.authenticationObserved ? 'Capability Memory now observes authentication in the assembled application' : 'Capability Memory does not observe an authentication capability (detector support)'} · ${e.reindex.routes} route(s)</dd>` : ''}
      <dt>Where it lives</dt><dd>${e.worktree ? `<span class="path">${esc(e.worktree.path)}</span><br><small>The verified application is in this GRAFT-managed worktree on branch <code>${esc(e.worktree.branch)}</code>. The created repository at <span class="path">${esc(e.createdProject?.root || '')}</span> still holds only the blank host on <code>main</code> until you finalize below.</small>` : e.createdProject ? `<span class="path">${esc(e.createdProject.root)}</span>` : 'nothing was created'}</dd></dl>
    ${libraryEvidenceView(e)}
    ${assembledApplicationView(e)}` : e.createdProject ? `<dl class="export-facts"><dt>Created</dt><dd><span class="path">${esc(e.createdProject.root)}</span></dd></dl>` : ''}` : '';
  return `<h3 class="small-heading">Assembly execution ${badge(e.status, tone)}</h3><p class="fine">Execution <code>${esc(e.executionId)}</code></p>${rows}${recoveryView(e)}${result}`;
}
// Commercial Beta 0.1: when an assembly failed or did not finish, the person is never left staring at
// raw state. What happened, in their words; what to do now (Retry a fresh run, Discard, save a
// diagnostic bundle); the technical detail kept, collapsed. Nothing here changes a verdict or a record.
function recoveryView(e) {
  const r = e.recovery;
  if (!r) return '';
  const f = r.failure || {};
  return `<div class="recovery" data-execution="${esc(e.executionId)}"><div class="report-banner failure"><div><strong>${esc(r.interrupted ? 'This assembly did not finish.' : f.title || 'This assembly did not complete.')}</strong><br><span>${esc(f.next || '')}</span></div></div>
    <div class="wf-actions">${r.retry?.available ? `<button class="button primary" data-action="lab-retry" data-id="${esc(e.executionId)}" data-root="${esc(r.retry.suggestedProjectName || '')}" ${disabled()}>Retry ${icon('arrow')}</button>` : ''}${r.discard?.available ? `<button class="button" data-action="lab-discard" data-id="${esc(e.executionId)}" ${disabled()}>Discard</button>` : `<span class="badge neutral">discarded</span>`}<button class="text-button" data-action="diagnostics" data-id="${esc(e.executionId)}" data-root="${esc(e.assemblyWorkspaceId || '')}">Save diagnostic bundle ${icon('arrow')}</button></div>
    ${r.retry?.available ? `<p class="fine">Retry starts a fresh assembly from the same plan${r.retry.suggestedProjectName ? ` as <code>${esc(r.retry.suggestedProjectName)}</code>` : ''}; this run stays in your history as it is. Discard removes GRAFT's own working copy for this run — never your repositories, never what was already recorded.</p>` : ''}
    ${f.technical || f.code ? `<details class="tech"><summary>Technical details</summary><small>${esc(f.code || '')}</small><br><span class="path">${esc(f.technical || '')}</span></details>` : ''}</div>`;
}
// A composition, rendered from the execution's own composition record and the ledger the product
// keeps: one composition-level answer (the kernel's final state, never inferred from badges), then
// each capability's evidence as separate claims, then the one revision they are all verified at.
function compositionResultView(e, p) {
  const c = e.composition;
  const verified = e.status === 'COMPLETED' && c.finalState === 'ALL_SELECTED_CAPABILITIES_VERIFIED';
  const ledger = lab.assembly && lab.assembly.assemblyWorkspaceId === e.assemblyWorkspaceId ? lab.assembly : null;
  const recordOf = (cap) => ledger?.capabilities?.find((r) => r.capabilityId === cap.capabilityId) || null;
  const presenceOf = (cap) => ledger?.presence?.find((x) => x.capabilityId === cap.capabilityId) || null;
  const label = (cap) => goalLabel(p, cap.goalId) || capabilityLabel(p, cap.capabilityId, cap.capability);
  const verdictTone = (x) => (x === 'VERIFIED' ? 'good' : x === 'FAILED' ? 'bad' : x ? 'warn' : 'neutral');
  const cases = (sum) => (sum && sum.required != null ? ` ${sum.passed}/${sum.required} required cases` : '');
  const claim = (name, value, tone, detail) => `<div class="history-row"><div><strong>${esc(name)}</strong> ${badge(value, tone)}<small>${detail}</small></div></div>`;
  const R = c.finalRevision;
  const banner = verified
    ? `<div class="report-banner success"><div><strong>COMPOSITION VERIFIED</strong><br><span>${c.capabilities.map(label).map(esc).join(' and ')} were each verified by their own contracts on the same final application revision, and the application still behaves as it did before either was added.</span></div></div>`
    : `<div class="report-banner failure"><div><strong>COMPOSITION ${esc(c.finalState === 'NOT_PROMOTABLE' ? 'NOT VERIFIED' : c.finalState)}</strong><br><span>${esc(e.error?.message || 'Not every capability is verified on one final revision; nothing was recorded as current and the created project was not changed.')}</span></div></div>`;
  const sameRevision = R ? `<h3 class="small-heading">Final application revision</h3><dl class="export-facts"><dt>Revision</dt><dd><code>${esc(R.slice(0, 12))}</code><br><small>One commit carries everything below. Every proof here was run against this exact revision.</small></dd>
    ${c.capabilities.map((cap) => { const r = recordOf(cap); const at = r ? r.state === 'CURRENT' && r.currentVerifiedRevision === R : null; return `<dt>${esc(label(cap))}</dt><dd>${badge(at === true ? 'VERIFIED AT THIS REVISION' : at === false ? `${r.state} — NOT AT THIS REVISION` : cap.finalVerdict === 'VERIFIED' ? 'VERIFIED' : cap.finalVerdict || 'not verified', at === true ? 'good' : 'warn')}${cap.reverifiedVerdict ? `<br><small>Verified when added (revision <code>${esc((cap.appliedRevision || '').slice(0, 12))}</code>), then verified again on the final revision.</small>` : ''}</dd>`; }).join('')}</dl>` : '';
  const evidence = c.capabilities.map((cap) => {
    const r = recordOf(cap); const pr = presenceOf(cap);
    const detector = e.reindex?.detectorObservation?.[cap.capability] || null;
    const src = cap.sourceVerification || r?.sourceVerification || null;
    const later = c.reverifications.find((x) => x.capabilityId === cap.capabilityId) || null;
    const common = `<dl class="export-facts"><dt>Capability</dt><dd>${esc(label(cap))}</dd><dt>Implementation</dt><dd>${esc(cap.name || cap.capability)} · ${esc(FORM_LABEL[cap.form] || cap.form)}</dd>
      ${cap.adaptation?.upstream ? `<dt>Source</dt><dd>${esc(cap.adaptation.upstream.repository || '')}${cap.adaptation.upstream.revision ? ` @ <code>${esc(cap.adaptation.upstream.revision.slice(0, 12))}</code>` : ''}${cap.adaptation.licence?.declared ? ` · licence ${esc(cap.adaptation.licence.declared)}` : ''}</dd>` : cap.sourceProject ? `<dt>Source</dt><dd>${esc(cap.sourceProject)}${cap.sourceRevision ? ` @ <code>${esc(String(cap.sourceRevision).slice(0, 12))}</code>` : ''}</dd>` : ''}</dl>`;
    const claims = cap.form === 'library'
      ? `${claim('Source', src?.verdict || 'not recorded', verdictTone(src?.verdict), `The library's own behaviour, exercised in its own project${cases(src?.summary)}.`)}
        ${claim('Artifact identity', cap.artifactIdentity ? (cap.artifactIdentity.matched ? 'MATCHED' : 'MISMATCH') : 'not checked', cap.artifactIdentity?.matched ? 'good' : 'bad', cap.artifactIdentity ? `<code>${esc(cap.artifactIdentity.entry || '')}</code> is byte-for-byte the file GRAFT verified${cap.adaptation?.artifactSha256 ? ` — <code>${esc(cap.adaptation.artifactSha256.replace('sha256:', '').slice(0, 16))}…</code>` : ''}.` : 'The identity check did not run.')}
        ${claim('Destination', cap.initialVerdict || 'not run', verdictTone(cap.initialVerdict), `The generated adapter and the carried artifact, exercised inside this application${cases(cap.initialSummary)}.`)}`
      : `${claim('Source', src?.verdict || 'not recorded', verdictTone(src?.verdict), `Verified where it came from${cases(src?.summary)}.`)}
        ${claim('Destination, when added', cap.initialVerdict || 'not run', verdictTone(cap.initialVerdict), `Verified against the capability's ${esc(cap.kind || 'own')} contract in this application${cases(cap.initialSummary)}, with a deterministic stand-in for the identity provider — no external provider was contacted, and this is not production sign-in.`)}
        ${later || cap.reverifiedVerdict ? claim('Destination, after the later capabilities', cap.reverifiedVerdict || 'not run', verdictTone(cap.reverifiedVerdict), `The same contract, run again on the final revision after ${esc((later?.alongside || []).map((slug) => capabilityLabel(p, c.capabilities.find((x) => x.capability === slug)?.capabilityId, slug)).join(', ') || 'the later capabilities')} were added${cases(cap.reverifiedSummary)}.`) : ''}`;
    const presence = pr ? claim('Presence', pr.presence === 'PRESENT_BY_ASSEMBLY_EVIDENCE' ? 'ADDED AND VERIFIED BY GRAFT' : pr.presence.replace(/_/g, ' '), pr.presence === 'PRESENT_BY_ASSEMBLY_EVIDENCE' ? 'good' : 'warn', esc(pr.explanation || '')) : '';
    const detect = detector ? claim('Independent detector', detector === 'OBSERVED' ? 'OBSERVED' : 'NOT OBSERVED', 'neutral', detector === 'OBSERVED' ? 'The workspace detector also recognises this capability.' : `The independent detector did not identify this capability in the assembled application${cap.form === 'library' ? ': it looks for a standalone library package, and this is an application with the library embedded in it' : ''}. GRAFT knows it is present from the verified assembly evidence above. That is not a failure and does not weaken the evidence.`) : '';
    return `<section class="panel"><div class="section-heading"><h2>${esc(label(cap))}</h2>${badge(cap.finalVerdict || 'not verified', verdictTone(cap.finalVerdict))}</div>${common}${claims}${presence}${detect}</section>`;
  }).join('');
  const preservation = c.finalPreservation ? claim('Host preservation', c.finalPreservation.failed === 0 && c.finalPreservation.tests > 0 ? 'PASSED' : 'FAILED', c.finalPreservation.failed === 0 && c.finalPreservation.tests > 0 ? 'good' : 'bad', `The composed application still answers as the host did before anything was added — ${c.finalPreservation.passed}/${c.finalPreservation.tests} checks against what it actually answered beforehand.`) : claim('Host preservation', 'NOT REACHED', 'warn', 'The final preservation check did not run.');
  return `${banner}${sameRevision}<h3 class="small-heading">What was proven, capability by capability</h3>${evidence}${preservation}
    <p class="fine">Each capability's source proof, destination proof and re-verification answer different questions. There is no combined score.</p>
    <dl class="export-facts"><dt>Where it lives</dt><dd>${e.worktree ? `<span class="path">${esc(e.worktree.path)}</span><br><small>The composed application is in this GRAFT-managed worktree on branch <code>${esc(e.worktree.branch)}</code>. The created repository at <span class="path">${esc(e.createdProject?.root || '')}</span> still holds only the blank host on <code>main</code> until you finalize below.</small>` : esc(e.createdProject?.root || '')}</dd></dl>`;
}
// Evidence for an adapted library capability, as SEPARATE claims. Source verification and
// destination verification answer different questions and are never added together; the detector's
// silence is reported as a fact about the detector, not as a problem with the proof.
function libraryEvidenceView(e) {
  const a = e.adaptation;
  if (!a) return '';
  const src = e.capabilitySource?.sourceVerification || null;
  const dest = a.destinationContract || null;
  const preserved = e.hostPreservation && e.hostPreservation.captured && e.hostPreservation.failed === 0;
  const detectorObserved = e.reindex?.detectorObservation === 'OBSERVED';
  const claim = (label, value, tone, detail) => `<div class="history-row"><div><strong>${esc(label)}</strong> ${badge(value, tone)}<small>${detail}</small></div></div>`;
  return `<h3 class="small-heading">What was proven</h3>
    ${claim('Source', src ? src.verdict : 'not recorded', src?.verdict === 'VERIFIED' ? 'good' : 'warn',
      `The library's own behaviour, exercised in its own project${src?.summary ? ` — ${src.summary.passed}/${src.summary.required} required cases` : ''}.`)}
    ${claim('Artifact identity', 'MATCHED', 'good',
      `The file that was carried across is byte-for-byte the one GRAFT verified — <code>${esc((a.artifactSha256 || '').replace('sha256:', '').slice(0, 16))}…</code>`)}
    ${claim('Destination', dest ? dest.verdict : 'not recorded', dest?.verdict === 'VERIFIED' ? 'good' : 'warn',
      `The generated adapter and the carried artifact, exercised inside this application${dest ? ` — ${dest.passed}/${dest.cases} required cases` : ''}.`)}
    ${claim('Host preservation', preserved ? 'PASSED' : e.hostPreservation?.captured === false ? 'NOT CAPTURED' : 'FAILED', preserved ? 'good' : 'bad',
      e.hostPreservation?.captured ? `The application still answers as it did before — ${e.hostPreservation.passed}/${e.hostPreservation.tests} checks, measured against what it actually answered beforehand.` : `The application's own behaviour could not be recorded beforehand, so preservation is not proven.`)}
    ${claim('Presence', 'ADDED AND VERIFIED BY GRAFT', 'good', 'GRAFT applied this capability itself and verified it at this exact revision.')}
    ${claim('Independent detector', detectorObserved ? 'OBSERVED' : 'NOT OBSERVED', 'neutral',
      detectorObserved ? 'The workspace detector also recognises this capability.' : `The workspace detector looks for a standalone library package; this is an application with the library embedded inside it, so it does not recognise it. That is not a failure and does not weaken the evidence above.`)}
    <p class="fine">These are four different questions with four different answers. There is no combined score: the source proof covers the library on its own, the destination proof covers it inside this application.</p>
    <dl class="export-facts"><dt>How it was added</dt><dd>The verified library artifact was carried in unchanged as <code>${esc(a.artifact || '')}</code> and GRAFT generated <code>${esc(a.adapter || '')}</code> beside it. No package was installed, nothing was built, and no HTTP route was added.</dd>
      ${a.upstream ? `<dt>Upstream</dt><dd>${esc(a.upstream.repository || 'unknown')}${a.upstream.revision ? ` @ <code>${esc(a.upstream.revision.slice(0, 12))}</code>` : ''}${a.licence?.declared ? ` · licence ${esc(a.licence.declared)}` : ''}<br><small>GRAFT did not author or modify this library.</small></dd>` : ''}</dl>`;
}

// The assembled application: what GRAFT itself applied and verified (the ledger), what the
// workspace detector independently sees, and the one explicit action that moves the person's project.
function assembledApplicationView(e) {
  if (!e.assemblyWorkspaceId) return '';
  const a = lab.assembly;
  if (!a || a.assemblyWorkspaceId !== e.assemblyWorkspaceId) { loadAssembly(e.assemblyWorkspaceId); return '<p class="muted">Reading the assembly ledger…</p>'; }
  const finalized = a.status === 'FINALIZED';
  const where = a.observed?.location === 'primary' ? a.locations.primary : a.locations.worktree;
  const name = (capabilityId, fallback) => capabilityLabel(lab.plan, capabilityId, fallback);
  const multi = (a.capabilities || []).length > 1;
  const rows = a.presence.map((p) => `<div class="history-row"><div><strong>${esc(name(p.capabilityId, p.capability))}</strong> ${badge(p.assemblyEvidence.verdict, p.assemblyEvidence.verdict === 'VERIFIED' ? 'good' : 'warn')} ${badge(p.presence === 'PRESENT_BY_ASSEMBLY_EVIDENCE' ? 'present by assembly evidence' : p.presence === 'OBSERVED_BY_DETECTOR' ? 'observed by detector only' : 'not present', p.presence === 'PRESENT_BY_ASSEMBLY_EVIDENCE' ? 'good' : 'warn')}
    <small>Evidence: added and verified by GRAFT — ${esc(p.assemblyEvidence.summary ? `${p.assemblyEvidence.summary.passed}/${p.assemblyEvidence.summary.required} required` : p.assemblyEvidence.verdict)}, at revision <code>${esc((p.assemblyEvidence.revision || '').slice(0, 12))}</code>${p.assemblyEvidence.contractId ? ` · contract <code>${esc(p.assemblyEvidence.contractId.slice(0, 19))}…</code>` : ''}</small>
    <small>Independent detector: ${esc(p.independentDetection)}${p.assemblyEvidence.state !== 'CURRENT' ? ` · assembly evidence ${esc(p.assemblyEvidence.state)}: ${esc(p.assemblyEvidence.reason)}` : ''}</small>
    <small>${esc(p.explanation)}</small></div></div>`).join('');
  // The ledger's own facts about each capability: what it is, where it came from, how it was added
  // and the exact revision it is verified at. Not the whole internal record.
  // One ledger record per capability, each with its own facts. Two records are never flattened
  // into one: what is shared is the revision they are both verified at, shown on each.
  const revision = a.currentRevision || a.observed?.revision || '';
  const ledgerFacts = (a.capabilities || []).filter((c) => c.adaptation || multi).map((c) => { const ad = c.adaptation || null; const history = c.verificationHistory || []; const later = history.find((h) => h.event === 're-verified-with'); const at = (c.currentVerifiedRevision || c.destinationRevisionAfter) === revision && c.state === 'CURRENT'; return `<dl class="export-facts">
    <dt>Capability</dt><dd>${esc(name(c.capabilityId, c.capability))} ${badge(c.state, ledgerTone(c.state))}${multi ? ` <small>record ${(a.capabilities || []).indexOf(c) + 1} of ${a.capabilities.length}</small>` : ''}</dd>
    <dt>Source form</dt><dd>${esc(FORM_LABEL[c.implementationForm] || c.implementationForm || 'service')}${c.kind ? ` · ${esc(c.kind)}` : ''}</dd>
    ${ad?.upstream ? `<dt>Source</dt><dd>${esc(ad.upstream.repository || '')}${ad.upstream.revision ? ` @ <code>${esc(ad.upstream.revision.slice(0, 12))}</code>` : ''}</dd>` : c.sourceProject ? `<dt>Source</dt><dd>${esc(c.sourceProject)}${c.sourceRevision ? ` @ <code>${esc(String(c.sourceRevision).slice(0, 12))}</code>` : ''}</dd>` : ''}
    ${ad?.licence?.declared ? `<dt>Licence</dt><dd>${esc(ad.licence.declared)}</dd>` : ''}
    <dt>Destination verification</dt><dd>${badge(ad?.destinationContract?.verdict || c.verificationVerdict || 'unknown', (ad?.destinationContract?.verdict || c.verificationVerdict) === 'VERIFIED' ? 'good' : 'warn')}${ad?.destinationContract ? ` ${ad.destinationContract.passed}/${ad.destinationContract.cases} required cases` : c.verificationSummary ? ` ${c.verificationSummary.passed}/${c.verificationSummary.required} required cases` : ''}${later ? `<br><small>Verified when added at <code>${esc((c.appliedRevision || '').slice(0, 12))}</code>, then verified again at <code>${esc((later.revision || '').slice(0, 12))}</code> after ${esc(later.alongside || 'the later capabilities')}.</small>` : ''}</dd>
    ${c.sourceVerification ? `<dt>Source verification</dt><dd>${badge(c.sourceVerification.verdict, c.sourceVerification.verdict === 'VERIFIED' ? 'good' : 'warn')}${c.sourceVerification.summary ? ` ${c.sourceVerification.summary.passed}/${c.sourceVerification.summary.required} required cases` : ''}<br><small>A different question from the destination proof above; the two are never combined.</small></dd>` : ''}
    <dt>How it was added</dt><dd>${ad ? `${esc(ad.artifact || '')} carried in unchanged · adapter ${esc(ad.adapter || '')} generated by GRAFT` : `emitted by GRAFT from the capability's verified genome${c.filesWritten?.length ? ` — ${c.filesWritten.length} file(s)` : ''}`}</dd>
    <dt>Current verified revision</dt><dd><code>${esc((c.currentVerifiedRevision || c.destinationRevisionAfter || '').slice(0, 12))}</code>${multi ? ` ${badge(at ? 'same revision as the whole application' : 'not the application\'s current revision', at ? 'good' : 'warn')}` : ''}</dd>
    ${c.proofIntegrity ? `<dt>Proof integrity</dt><dd>${badge(c.proofIntegrity.status === 'INTACT' ? 'Intact' : c.proofIntegrity.status === 'MISSING' ? 'Missing' : c.proofIntegrity.status === 'MISMATCH' ? 'Mismatch' : 'No proof recorded', c.proofIntegrity.status === 'INTACT' ? 'neutral' : 'warn')}${c.proofIntegrity.digest ? ` <code>${esc(c.proofIntegrity.digest.slice(0, 12))}</code>` : ''}<br><small>Whether the stored proof artifact is unmodified — separate from the capability's state above and from its recorded verdict.${c.state === 'STALE' && c.proofIntegrity.status === 'INTACT' ? ' The original proof stays intact after drift; it describes the earlier revision.' : ''}</small></dd>` : ''}
    ${ad ? `<dt>Independent detector</dt><dd>${ad.detectorObservation === 'OBSERVED' ? 'observed' : 'not observed'}${ad.detectorObservation === 'NOT_OBSERVED' ? ' — the detector looks for a standalone library package, not one embedded in an application' : ''}</dd>` : ''}</dl>`; }).join('');
  const exportable = (a.capabilities || []).filter((c) => c.state === 'CURRENT' && c.proofIntegrity?.status === 'INTACT').length;
  return `<h3 class="small-heading" id="assembled-application">Assembled application ${badge(a.status, finalized ? 'good' : a.status === 'STALE' ? 'stale' : 'neutral')}</h3>
    <div class="wf-actions">${exportable ? `<button class="button" data-action="export-proofs" data-id="${esc(a.assemblyWorkspaceId)}" ${disabled()}>Export proofs ${icon('arrow')}</button><span class="fine">Exports the tamper-evident proof files for this assembly (${exportable}).</span>${lastProofExport && lastProofExport.assemblyWorkspaceId !== a.assemblyWorkspaceId && lastProofExport.count && lastProofExport.folder === undefined ? '' : ''}${lastProofExport?.count && lastProofExport.exported ? `<span class="fine">${lastProofExport.count} proof file${lastProofExport.count === 1 ? '' : 's'} exported to <span class="path">${esc(lastProofExport.folder)}</span>.</span>` : ''}` : `<span class="fine">No exportable proof: ${(a.capabilities || []).some((c) => c.proofIntegrity && c.proofIntegrity.status !== 'INTACT') ? 'a stored proof did not pass its integrity check.' : 'no current capability carries a stored proof.'}</span>`}<button class="text-button" data-action="diagnostics" data-id="" data-root="${esc(a.assemblyWorkspaceId)}">Save diagnostic bundle ${icon('arrow')}</button></div>
    ${multi ? `<p class="fine">${a.capabilities.length} capabilities, ${a.capabilities.filter((c) => c.state === 'CURRENT').length} current — one application revision, one ledger record each.</p>` : ''}
    ${rows}
    ${ledgerFacts}
    <dl class="export-facts"><dt>Current revision</dt><dd><code>${esc((a.observed?.revision || a.currentRevision || '').slice(0, 12))}</code>${a.observed?.dirty ? ' · uncommitted changes present' : ''}</dd>
      <dt>Where it lives</dt><dd><span class="path">${esc(where || '')}</span><br><small>${finalized ? 'Finalized. Your project now points to the verified assembled revision; the blank host commit remains in its history.' : 'The verified application is in the GRAFT-managed worktree. Your created project still holds the blank host until you finalize.'}</small></dd></dl>
    ${window.graftDesktop ? `<button class="text-button" data-action="wf-open" data-root="${esc(where || '')}">Open assembled project ${icon('folder')}</button> <button class="text-button" data-action="wf-reveal" data-root="${esc(where || '')}">Reveal in Finder</button>` : ''}
    ${finalized ? `<div class="notice success"><strong>Finalized</strong><p>Primary project now points to the verified assembled revision (<code>${esc((a.finalization?.toRevision || '').slice(0, 12))}</code>, fast-forward from <code>${esc((a.finalization?.fromRevision || '').slice(0, 12))}</code>). Nothing was pushed anywhere.</p></div>`
      : a.promotion?.ok ? `<button class="button primary full" data-action="lab-finalize" data-id="${esc(a.assemblyWorkspaceId)}" ${disabled()}>Finalize assembled project ${icon('arrow')}</button>`
        : `<button class="button full" disabled aria-disabled="true">Finalize assembled project</button><p class="fine">${esc((a.promotion?.problems || []).join('; '))}</p>`}`;
}
async function loadAssembly(assemblyWorkspaceId) {
  try { const r = await api('laboratory/assembly', { assemblyWorkspaceId }); lab.assembly = r.assembly; render(); } catch (err) { toast(err.message); }
}
async function loadAssemblyPlan(blueprintId) {
  try {
    const { plans } = await api('laboratory/plans', { blueprintId });
    lab.execution = null;
    lab.plans = plans; lab.planFor = blueprintId;
    lab.plan = plans.length ? (await api('laboratory/plan/view', { planId: plans[0].planId })).plan : null;
    if (lab.plan) { const { executions } = await api('laboratory/executions', { planId: lab.plan.planId }); if (executions.length) lab.execution = (await api('laboratory/execution', { executionId: executions[0].executionId })).execution; }
    render();
  } catch (err) { lab.planFor = blueprintId; lab.plan = null; toast(err.message); render(); }
}
function transplant() {
  const banks = data.bank.filter((b) => !b.error);
  const managed = (data.managedTransplants || []).filter((t) => t.state !== 'CLEANED');
  const current = wf.transplant ? managed.find((t) => t.id === wf.transplant.id) || wf.transplant : null;
  const step = wf.proof ? 6 : plan && current ? 5 : current ? 4 : wf.destination ? 3 : wf.slug ? 2 : 1;
  const stepBadge = (n, label) => `<span class="wf-step ${step > n ? 'done' : step === n ? 'current' : ''}"><span class="step-number">${String(n).padStart(2, '0')}</span>${label}</span>`;
  return `<div class="page-heading"><div><p class="eyebrow">A REVIEWABLE NEXT STEP</p><h1>Transplant</h1><p class="subtitle">Choose a capability and a destination, review every planned change, then let GRAFT prove it in an isolated worktree.</p></div>${current ? badge(current.state, current.state === 'VERIFIED' ? 'good' : ['FAILED', 'STALE'].includes(current.state) ? 'bad' : 'neutral') : ''}</div>${activeStrip()}
  <div class="wf-steps">${stepBadge(1, 'Capability')}${stepBadge(2, 'Destination')}${stepBadge(3, 'Isolated worktree')}${stepBadge(4, 'Review plan')}${stepBadge(5, 'Apply & verify')}${stepBadge(6, 'Proof')}</div>
  <section class="panel"><div class="panel-title"><span class="step-number">01</span><h2>Source capability</h2></div>
    ${banks.length ? `<div class="wf-choices">${banks.map((b) => `<button class="wf-choice ${wf.slug === b.slug ? 'selected' : ''}" data-action="wf-source" data-slug="${esc(b.slug)}" ${disabled()}><strong>${esc(b.name)}</strong><small>from ${esc(b.source)} · ${b.verification?.verdict === 'VERIFIED' ? 'verified in source' : 'unverified'} · ${b.tests.length} acceptance tests</small></button>`).join('')}</div>` : empty('No capability banked yet', 'Discover a capability and harvest it as a source first.', '<button class="button primary" data-action="navigate" data-view="discover">Open Discover</button>')}
  </section>
  ${wf.slug ? `<section class="panel"><div class="panel-title"><span class="step-number">02</span><h2>Destination</h2>${wf.destinations ? badge(`${wf.destinations.filter((d) => d.supported).length} of ${wf.destinations.length} supported`, 'neutral') : ''}</div>
    ${wf.destinations ? (wf.destinations.length ? `<div class="wf-choices">${wf.destinations.map((d) => `<button class="wf-choice ${wf.destination?.root === d.root ? 'selected' : ''} ${d.supported ? '' : 'unsupported'}" data-action="wf-destination" data-root="${esc(d.root)}" ${d.supported ? disabled() : 'disabled'}><strong>${esc(d.name)}</strong><small>${esc(d.language || '')}/${esc(d.runtime || '')} · ${esc(d.architecture?.moduleSystem || '?')} · ${esc(d.architecture?.framework || '?')}${d.architecture?.central ? ' · central handler' : ''}${d.entrypoint ? ` · ${esc(d.entrypoint)}` : ''}</small><small>${d.repository?.head ? `HEAD ${esc(d.repository.head.slice(0, 12))}${d.repository.dirty ? ` · ${d.repository.dirtyFiles} uncommitted change(s)` : ' · clean'}` : 'not a Git repository'}</small><span class="wf-support">${d.supported ? badge(`Supported · ${esc(d.profile)}`, 'good') : badge('Not supported', 'warn')}</span>${d.blockers?.length ? `<small class="blocker-line">${esc(d.blockers.map((b) => b.detail).join('; '))}</small>` : ''}</button>`).join('')}</div>` : empty('No destination candidates', 'Index a workspace folder in Discover, or add a project.', '')) : `<p class="muted">Finding destinations for this capability…</p>`}
  </section>` : ''}
  ${wf.destination ? `<section class="panel"><div class="panel-title"><span class="step-number">03</span><h2>Isolated worktree</h2>${current ? badge(current.state, current.state === 'VERIFIED' ? 'good' : 'neutral') : ''}</div>
    ${current ? `<p><strong>${esc(current.worktree.branch)}</strong> in <span class="path">${esc(current.worktree.path)}</span></p><p class="fine">Cut from ${esc(current.destination.name)} @ ${esc(current.baseHead.slice(0, 12))}${current.destination.dirtyAtPreparation ? ' (the destination had uncommitted changes; they are not part of this transplant)' : ''}. Your ${esc(current.destination.branchBefore || 'main')} checkout is untouched. Nothing is pushed or deployed.</p>
      <div class="wf-actions">${window.graftDesktop ? `<button class="text-button" data-action="wf-open" data-root="${esc(current.worktree.path)}">Open worktree ${icon('arrow')}</button><button class="text-button" data-action="wf-reveal" data-root="${esc(current.worktree.path)}">Reveal in Finder ${icon('arrow')}</button>` : ''}<button class="text-button" data-action="wf-copy" data-root="${esc(current.worktree.path)}">Copy path</button><button class="text-button" data-action="wf-cleanup" data-id="${esc(current.id)}" ${disabled()}>Clean up worktree</button></div>`
      : `<p class="fine">GRAFT will create a dedicated worktree beneath its own folder, on a new local branch cut from the destination's current HEAD. Your checkout is never modified.</p><button class="button primary" data-action="wf-prepare" ${disabled()}>Prepare isolated transplant ${icon('arrow')}</button>`}
  </section>` : ''}
  ${current && ['READY', 'APPLIED', 'VERIFIED', 'FAILED', 'INCONCLUSIVE'].includes(current.state) ? `<section class="panel plan-panel"><div class="panel-title"><span class="step-number">04</span><h2>Review plan</h2></div>${plan ? renderPlan() + (plan.plan.conflicts?.routes?.length && !plan.plan.conflicts.resolutionApproved ? `<div class="notice"><strong>${plan.plan.conflicts.routes.length} route(s) already exist in the destination.</strong><p>${esc(plan.plan.conflicts.routes.map((r) => `${r.method} ${r.path}`).join(', '))}. GRAFT will not replace them without your approval.</p><button class="button" data-action="wf-plan-resolve" ${disabled()}>Rebuild the plan, replacing those routes ${icon('arrow')}</button></div>` : '')  : `<button class="button" data-action="wf-plan" ${disabled()}>Build plan ${icon('arrow')}</button><p class="fine">Planning reads the worktree; it does not run or modify it.</p>`}</section>` : ''}
  ${wf.proof ? `<section class="panel"><div class="panel-title"><span class="step-number">06</span><h2>Proof</h2>${badge(wf.proof.verdict, wf.proof.verdict === 'VERIFIED' ? 'good' : 'bad')}</div>${renderProof(wf.proof)}</section>` : ''}
  ${managed.length ? `<section class="panel history-panel"><div class="section-heading"><h2>Isolated transplants</h2>${badge(`${managed.length} worktree(s)`, 'neutral')}</div>${managed.slice().reverse().map((t) => `<div class="history-row">${icon('branch')}<div><strong>${esc(t.destination.name)} · ${esc((t.capabilities || [t.capabilitySlug]).length > 1 ? `${t.capabilities.length} capabilities: ${t.capabilities.join(' + ')}` : t.capabilitySlug)}</strong><p class="path">${esc(t.worktree.path)}</p><small>${esc(t.worktree.branch)} · from ${esc(t.baseHead.slice(0, 12))} · ${date(t.updatedAt)}</small></div>${badge(t.state, t.state === 'VERIFIED' ? 'good' : ['FAILED', 'STALE'].includes(t.state) ? 'bad' : 'neutral')}<button class="text-button" data-action="wf-changes" data-id="${esc(t.id)}">Changed files ${icon('arrow')}</button><button class="text-button" data-action="wf-cleanup" data-id="${esc(t.id)}" ${disabled()}>Clean up</button></div>`).join('')}<p class="fine">Cleaning up removes the worktree and its branch. Changes are discarded only after you confirm.</p></section>` : ''}
  <details class="panel advanced-panel" ${plan && !current ? 'open' : ''}><summary class="text-button">Advanced: plan directly against a registered project (no isolated worktree)</summary>
  <p class="fine">GRAFT writes into the chosen checkout on a new recovery branch instead of a managed worktree. Prefer the guided flow above.</p>
  <form id="plan-form"><label for="capability">Capability</label><select id="capability" name="slug" required ${disabled()}><option value="">Select from your organ bank</option>${banks.map((b) => `<option value="${esc(b.slug)}" ${formState.slug === b.slug ? 'selected' : ''}>${esc(b.name)} — ${esc(b.source)}</option>`).join('')}</select>
  <label for="destination">Destination project</label><select id="destination" name="projectId" required ${disabled()}><option value="">Choose a project</option>${data.projects.filter((p) => !p.error).map((p) => `<option value="${esc(p.id)}" ${formState.projectId === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(p.root)}</option>`).join('')}</select>
  <label class="checkbox"><input type="checkbox" name="resolveConflicts" ${formState.resolveConflicts ? 'checked' : ''} ${disabled()}><span>Allow existing conflicting routes to be commented out.<small>The preview will show which registrations change.</small></span></label>
  <button class="button" ${disabled()}>Build preview ${icon('arrow')}</button><p class="fine">Previewing does not run or modify the destination.</p></form>
  ${plan && !current ? `<div class="plan-panel">${renderPlan()}</div>` : ''}</details>`;
}
function renderProof(p) {
  const inv = p.invariants;
  return `<div class="proof-grid">
    <div><span class="stat-label">Required cases</span><strong>${p.required.passed} / ${p.required.total}</strong></div>
    <div><span class="stat-label">Invariants</span><strong>${inv.held} held</strong><small>${inv.violated} violated · ${inv.unobserved} unobserved</small></div>
    <div><span class="stat-label">Counterfactuals</span><strong>${p.counterfactuals ? `${p.counterfactuals.passed} / ${p.counterfactuals.total}` : '—'}</strong></div>
    <div><span class="stat-label">Host preservation</span><strong>${p.hostPreservation.length ? (p.hostPreservation.every((h) => h.outcome === 'passed') ? 'passed' : 'failed') : 'n/a'}</strong></div>
    <div><span class="stat-label">Repairs</span><strong>${p.repairs.attempts}</strong></div>
    <div><span class="stat-label">Provider boundary</span><strong>${p.providerBoundary ? esc(p.providerBoundary.kind) : 'none'}</strong><small>${p.providerBoundary ? `${esc(p.providerBoundary.injectedThrough)} · no live provider` : ''}</small></div>
    <div><span class="stat-label">Atlas</span><strong>${p.atlas.recorded ? 'observation recorded' : 'not recorded'}</strong></div>
  </div>
  ${p.typedEvidence?.length ? `<p class="fine">Typed evidence: ${[...new Set(p.typedEvidence.map((e) => e.type))].map((type) => esc(type.replace(/_/g, ' '))).join(' · ')}.</p>` : ''}
  <p class="fine">${esc(p.rationale)} Every number above is copied from the verifier's report; nothing here is an opinion.</p>
  ${(p.attempts || []).length > 1 ? `<h3 class="small-heading">Verification attempts</h3><ol class="attempt-list">${p.attempts.map((a) => `<li><strong>${esc(a.verdict)}</strong> — ${esc(a.classification === 'transport-timeout' ? `process/transport timeout${a.detail ? ` (${a.detail})` : ''}` : a.classification)}${a.summary ? ` · ${a.summary.passed} / ${a.summary.required} required` : ''}</li>`).join('')}</ol><p class="fine">The first attempt learned nothing (a stall, not a failure); one fresh process was started and its evidence alone decided the verdict. Nothing was changed between attempts.</p>` : ''}
  ${p.changeset ? `<h3 class="small-heading">Changed files</h3><div class="file-list">${p.changeset.created.map((f) => `<button data-action="noop">${icon('code')}<span>${esc(f)}</span>${badge('Created', 'good')}</button>`).join('')}${p.changeset.modified.map((f) => `<button data-action="noop">${icon('code')}<span>${esc(f)}</span>${badge('Modified', 'warn')}</button>`).join('')}</div>` : ''}
  <details><summary class="text-button">Inspect evidence (${p.results.length} cases)</summary><div class="test-results">${p.results.map((r) => `<div><span class="check-symbol ${r.outcome === 'passed' ? '' : 'bad'}">${r.outcome === 'passed' ? '✓' : r.outcome === 'failed' ? '!' : '?'}</span><span><strong>${esc(r.id)}</strong><small>${esc(r.description || '')}${r.reason ? ` — ${esc(r.reason)}` : ''}</small><small>${r.steps.map((s) => `${esc(s.request)} → ${s.status === null ? '' : s.status} ${s.checks.filter((c) => !c.ok).map((c) => `✗ ${esc(c.name)}: ${esc(c.detail)}`).join(' ') || '✓'}`).join(' · ')}</small></span></div>`).join('')}</div></details>
  <details><summary class="text-button">Invariants (${inv.list.length})</summary><ul>${inv.list.map((i) => `<li><strong>${esc(i.id)}</strong> — ${esc(i.status)}${i.checkedBy?.length ? ` <small>(${esc(i.checkedBy.join(', '))})</small>` : ''}</li>`).join('')}</ul></details>`;
}
function renderReview(r) {
  return `<div class="review-grid">
    <div><h3 class="small-heading">Will be created</h3><ul>${r.filesToCreate.map((f) => `<li><span class="path">${esc(f.path)}</span> <small>${f.bytes} B</small></li>`).join('') || '<li class="muted">nothing</li>'}</ul></div>
    <div><h3 class="small-heading">Will be edited</h3><ul>${r.filesToEdit.map((f) => `<li><span class="path">${esc(f.path)}</span> <small>${esc(f.change)}</small></li>`).join('') || '<li class="muted">nothing</li>'}</ul></div>
    <div><h3 class="small-heading">Dependencies</h3><ul>${r.dependencies.added.length ? r.dependencies.added.map((d) => `<li>${esc(d)}</li>`).join('') : '<li class="muted">none added</li>'}</ul></div>
    <div><h3 class="small-heading">Routes</h3><ul>${r.routes.map((x) => `<li><span class="path">${esc(x)}</span></li>`).join('')}</ul>${r.registration ? `<p class="fine">${esc(r.registration.strategy)}</p>` : ''}</div>
  </div>
  <h3 class="small-heading">Security-sensitive changes</h3><ul class="behavior-list">${r.securitySensitive.map((x) => `<li>${icon('shield')}<span>${esc(x)}</span></li>`).join('')}</ul>
  ${r.configuration.length ? `<h3 class="small-heading">Configuration this capability introduces</h3><p class="fine">Names only — GRAFT never stores or displays values. Verification supplies them for a deterministic provider double; production needs real values.</p><ul>${r.configuration.map((c) => `<li><span class="path">${esc(c.name)}</span> ${c.required ? badge('required', 'warn') : badge('optional', 'neutral')}</li>`).join('')}</ul>` : ''}
  ${r.verification ? `<h3 class="small-heading">Verification contract</h3><p class="fine">${r.verification.success} success case(s), ${r.verification.counterfactual} counterfactual(s), ${r.verification.invariants} invariant(s)${r.verification.hostPreservation ? `, ${r.verification.hostPreservation} host-preservation probe(s)` : ''}${r.verification.providerDouble ? ' · provider reached only through a deterministic double' : ''}.${r.verification.unobserved.length ? ` Not observable by this contract: ${esc(r.verification.unobserved.join(', '))}.` : ' Every declared invariant has a witness.'}</p>` : ''}`;
}
function renderPlan() {
  const p = plan.plan;
  const preview = p.compatibility.preview;
  const incompatible = preview?.state === 'INCOMPATIBLE';
  return `<div class="plan-status">${badge(plan.safety.ok ? 'Ready to transplant' : 'Needs attention', plan.safety.ok ? 'good' : 'warn')}<span>${esc(p.destination.project)}</span></div>
  ${preview ? `<div class="notice ${incompatible ? 'error-text' : ''}"><strong>${esc(preview.state)}</strong><p>${incompatible ? 'GRAFT refuses this transplant before adaptation or execution.' : preview.state === 'ADAPTABLE' ? 'GRAFT can proceed only with the listed adaptation or explicit conflict resolution.' : 'The current host satisfies the deterministic compatibility checks.'}</p>${preview.reasons.map((reason) => `<p class="fine">${esc(reason.title)} — ${esc(reason.detail)}</p>`).join('')}</div>` : ''}
  ${plan.review ? renderReview(plan.review) : ''}
  <div class="checks">${p.compatibility.checks.map((c) => `<div><span class="check-symbol ${c.status === 'block' ? 'bad' : ''}">${c.status === 'block' ? '!' : c.status === 'warn' ? '·' : '✓'}</span><span><strong>${esc(c.title)}</strong><small>${esc(c.detail)}</small></span></div>`).join('')}</div>
  ${plan.safety.problems.length ? `<div class="notice"><strong>Before you can apply</strong>${plan.safety.problems.map((p) => `<p>${esc(p.message)}</p><p class="fine">${esc(p.remedy)}</p>`).join('')}</div>` : ''}
  ${p.semantic ? `<h3 class="small-heading">What GRAFT understands</h3><div class="engine-summary"><p><strong>${esc(p.semantic.capability.name)}</strong> · ${esc(p.semantic.capability.kind)} · ${p.semantic.dependentComponents.endpoints.length} endpoints, ${p.semantic.dependentComponents.entities.length} stores, ${p.semantic.dependentComponents.middleware.length} middleware</p>
  ${p.semantic.targetMismatches.map((m) => `<p class="fine">${esc(m.dimension)}: ${esc(m.source)} → ${esc(m.destination)} <em>${esc(m.severity)}${m.adaptation ? ` · ${esc(m.adaptation.kind)}` : ''}</em></p>`).join('')}
  ${p.semantic.verificationContract ? `<p class="fine">Verification will prove ${p.semantic.verificationContract.successCases} success case(s) and ${p.semantic.verificationContract.counterfactualCases} counterfactual(s); ${p.semantic.verificationContract.invariants} invariant(s) declared.</p>` : ''}
  ${p.semantic.risks.slice(0, 6).map((r) => `<p class="fine engine-risk">Risk (${esc(r.level)}): ${esc(r.text)}</p>`).join('')}
  ${p.semantic.unknowns.length ? `<p class="fine engine-unknowns">${p.semantic.unknowns.length} unknown(s): ${esc(p.semantic.unknowns[0])}${p.semantic.unknowns.length > 1 ? ' …' : ''}</p>` : ''}
  ${p.semantic.result.recipe ? `<p class="fine engine-recipe">Recipe: ${esc(p.semantic.result.recipe)}</p>` : ''}
  ${p.semantic.priorObservations?.observations ? `<p class="fine engine-atlas">Atlas: ${p.semantic.priorObservations.observations} prior observation(s) — ${p.semantic.priorObservations.verdicts.VERIFIED} verified, ${p.semantic.priorObservations.verdicts.FAILED} failed</p>` : ''}</div>` : ''}
  <h3 class="small-heading">Planned changes</h3><div class="file-list">${p.files.map((f, i) => `<button data-action="file" data-index="${i}">${icon('code')}<span>${esc(f.path)}</span>${badge('New', 'good')}</button>`).join('')}${plan.entrypoint ? `<button data-action="entrypoint">${icon('code')}<span>${esc(plan.entrypoint.path)}</span>${badge('Edit', 'warn')}</button>` : ''}</div>
  <p class="fine">A separate Git branch and recovery receipt will be created. Acceptance tests run after the changes are applied.</p>
  <div class="wf-actions"><button class="text-button" data-action="wf-agents-preview" ${disabled()}>Preview AGENTS.md handoff</button><button class="text-button" data-action="wf-agents-export" ${disabled()}>Export AGENTS.md handoff</button></div>
  <button class="button primary full" data-action="confirm-apply" ${!plan.safety.ok || incompatible || disabled() ? 'disabled' : ''}>Apply & verify ${icon('arrow')}</button>`;
}
function stateTone(state) {
  return ({ TRANSPLANTABLE: 'good', HARVESTABLE: 'good', STRONGLY_DETECTED: 'neutral', OBSERVED: 'neutral', AMBIGUOUS: 'warn', UNSUPPORTED: 'warn' })[state] || 'neutral';
}
function candidateCard(c) {
  const auth = c.auth || {};
  return `<article class="discovery-card">
    <div class="discovery-head"><div><strong>${esc(c.project.name)}</strong>${c.project.relativeRoot && c.project.relativeRoot !== '.' ? `<span class="path">${esc(c.project.relativeRoot)}</span>` : ''}</div>${badge(c.state, stateTone(c.state))}</div>
    <p class="discovery-subtypes">${esc(c.capability)}${c.subtypes.length ? ` · ${esc(c.subtypes.join(', '))}` : ''}</p>
    ${c.implementationForm === 'library' ? `<p class="fine">Why GRAFT thinks this: ${esc((c.evidence || []).map((e) => ({ 'library-entry': 'the package declares an executable library artifact', 'no-http-surface': 'it serves no HTTP routes of its own', 'feature-predicate': 'it exposes a function asking whether a named feature is on', 'feature-selection': 'it exposes a function choosing between outcomes for a named feature', 'feature-registry': 'it builds a lookup from a map of features' })[e.id] || e.id).join('; '))}.</p>` : ''}
    <p class="fine">${esc(c.project.language)}/${esc(c.project.runtime)} · ${esc(c.project.framework)} · ${c.project.hasHttpServer ? 'HTTP server' : 'no HTTP server'}${c.project.entrypoint ? ` · entry ${esc(c.project.entrypoint.source || c.project.entrypoint.runtime)}` : ''}</p>
    ${auth.credentialAuthority ? `<p class="fine discovery-axes">credentials: <strong>${esc(auth.credentialAuthority.kind)}</strong> · session: <strong>${esc(auth.sessionTransport)}</strong> · custody: <strong>${esc(auth.sessionCustody)}</strong> · store: <strong>${esc(auth.sessionStore)}</strong></p>` : ''}
    <p class="fine">Matched because: ${esc((c.matchedBecause || []).map((w) => w.detail).join('; ') || 'text match')}</p>
    ${c.agentReason ? `<p class="fine agent-reason">${icon('robot')} Agent: ${esc(c.agentReason)} <span class="advisory">advisory</span></p>` : ''}
    <div class="discovery-status">${c.implementationForm === 'library' ? badge('Library', 'neutral') : ''}${badge(c.harvestable ? 'Harvestable' : 'Not harvestable', c.harvestable ? 'good' : 'warn')}${badge(c.transplantSupport === 'supported' ? 'Transplantable' : 'Not yet transplantable', c.transplantSupport === 'supported' ? 'good' : 'warn')}${badge(c.localVerification?.feasible ? 'Locally verifiable' : 'Needs external setup', c.localVerification?.feasible ? 'good' : 'neutral')}</div>
    ${c.blockers?.length ? `<p class="fine blocker-line">Blocked by: ${esc(c.blockers.map((b) => b.detail).join('; '))}</p>` : ''}
    <div class="card-bottom"><span>${c.evidence?.length || 0} signals</span><span>${c.harvestable ? `<button class="text-button" data-action="harvest-candidate" data-id="${esc(c.projectId)}" data-slug="${esc(c.capability)}" ${disabled()}>Harvest as source ${icon('arrow')}</button> ` : ''}<button class="text-button" data-action="capability-detail" data-id="${esc(c.projectId)}" data-slug="${esc(c.capability)}">Why GRAFT thinks this ${icon('arrow')}</button></span></div>
  </article>`;
}
function discover() {
  const w = data.workspace || {};
  const agent = data.agent || { configured: false };
  const roots = w.roots || [];
  return `<div class="page-heading"><div><p class="eyebrow">WHAT HAVE I ALREADY BUILT?</p><h1>Discover<span class="heading-dot">.</span></h1><p class="subtitle">Search your own workspace for capabilities you have already written.</p></div><button class="button primary" data-action="index-workspace" ${disabled()}>${icon('refresh')} ${w.projects ? 'Re-index' : 'Index workspace'}</button></div>
  ${activeStrip()}
  <section class="panel"><div class="section-heading"><h2>Authorized folders</h2>${badge(`${roots.length} root${roots.length === 1 ? '' : 's'}`, 'neutral')}</div>
    ${roots.length ? `<div class="root-list">${roots.map((r) => `<div class="history-row">${icon('folder')}<div><strong>${esc(r.path)}</strong><small>added ${date(r.addedAt)}</small></div><button class="text-button" data-action="remove-root" data-root="${esc(r.path)}">Remove</button></div>`).join('')}</div>` : '<p class="muted">No folders are authorized yet. GRAFT only ever scans folders you add here.</p>'}
    <button class="text-button" data-action="add-root" ${disabled()}>${icon('plus')} Add a workspace folder</button>
    ${w.projects ? `<p class="fine">${w.projects} projects · ${w.repositories} repositories${w.worktrees ? ` (+${w.worktrees} alternate worktrees)` : ''} · ${w.capabilities} capabilities · ${w.harvestable} harvestable · ${w.transplantable} transplantable${w.stale ? ` · ${w.stale} stale` : ''}${w.updatedAt ? ` · indexed ${date(w.updatedAt)}` : ''}</p>` : ''}
  </section>
  <section class="panel"><div class="section-heading"><h2>Find a capability</h2>${agent.configured && agent.ready ? badge(`Agent: ${esc(agent.label)}`, 'neutral') : badge('No agent — deterministic search', 'neutral')}</div>
    <form id="discover-form"><label for="discover-text">Ask in your own words</label><input id="discover-text" name="text" placeholder="find something that keeps users logged in" value="${esc(discoveryQuery)}" autocomplete="off" required><button class="button primary full" ${disabled()}>${icon('search')} Search my workspace</button></form>
    <p class="fine">GRAFT decides what exists and whether it can be used. An agent, if connected, only interprets your wording and suggests an order.</p>
  </section>
  ${discovery ? `<section class="panel"><div class="section-heading"><h2>${discovery.total} candidate${discovery.total === 1 ? '' : 's'}</h2><span class="fine">${esc(discovery.interpretation?.source === 'agent' ? 'interpreted by agent' : 'interpreted deterministically')}${discovery.ranking?.rankedByAgent ? ' · ordered by agent' : ''}</span></div>
    ${discovery.candidates.length ? `<div class="discovery-grid">${discovery.candidates.map(candidateCard).join('')}</div>` : '<p class="muted">Nothing in the index matches that request.</p>'}
    <p class="fine authority-note">${icon('shield')} ${esc(discovery.authority)}</p></section>` : ''}
  <section class="panel"><div class="section-heading"><h2>Connect your own agent</h2>${agent.configured ? badge(agent.ready ? 'Ready' : 'Key missing', agent.ready ? 'good' : 'warn') : badge('Optional', 'neutral')}</div>
    ${agent.configured ? `<p>${esc(agent.label)} · ${esc(agent.model || 'default model')}</p><p class="fine">Key source: ${esc(agent.keySource || 'not available')} · scopes: ${esc((agent.scopes || []).join(', '))}</p><p class="fine">GRAFT never stores your API key in its config file. Discovery works without an agent.</p><button class="text-button" data-action="clear-agent">Disconnect agent</button>`
      : `<p class="fine">Optional. Bring your own provider and key; GRAFT reads the key from an environment variable and never writes it to disk.</p><form id="agent-form"><label for="agent-provider">Provider</label><select id="agent-provider" name="provider">${(agent.providers || []).map((p) => `<option value="${esc(p.id)}">${esc(p.label)} · key from ${esc(p.keyEnvironment)}</option>`).join('')}</select><label for="agent-model">Model (optional)</label><input id="agent-model" name="model" placeholder="leave blank for the default" autocomplete="off"><label for="agent-endpoint">Endpoint (required for OpenAI-compatible)</label><input id="agent-endpoint" name="endpoint" placeholder="https://…" autocomplete="off"><button class="button full">Connect agent</button></form>`}
  </section>`;
}
function activity() {
  return `<div class="page-heading"><div><p class="eyebrow">EVIDENCE, NOT ASSUMPTIONS</p><h1>Activity</h1><p class="subtitle">Live operations from this session and your saved transplant history.</p></div></div>
  <section class="panel history-panel"><div class="section-heading"><h2>Capability custody</h2>${badge(`${(data.custody || []).length} recorded`, 'neutral')}</div>${(data.custody || []).length ? data.custody.map((event) => `<div class="history-row"><div><strong>${esc(event.operation)}</strong><small>${esc(event.provider)} · ${esc(event.executionLocation)} · ${esc(event.dataClass)} · source-derived: ${event.sourceDerived ? 'yes' : 'no'}</small><small>${esc(event.reason)}</small></div>${badge(event.decision, event.decision === 'ALLOW' ? 'good' : 'bad')}</div>`).join('') : '<p class="muted">No external provider operation has been recorded in this local workspace.</p>'}<p class="fine">Custody records contain policy metadata and an input fingerprint; they never retain raw prompts or credentials.</p></section>
  <section class="panel"><div class="section-heading"><h2>This session</h2>${badge(`${data.jobs.length} operations`, 'neutral')}</div>${data.jobs.length ? `<div class="activity-list">${data.jobs.map((j) => `<button class="activity-row" data-action="job" data-id="${esc(j.id)}"><span class="event-icon ${j.status}">${j.status === 'running' ? '<span class="spinner"></span>' : icon(j.status === 'completed' ? 'check' : 'activity')}</span><span class="event-label"><strong>${esc(j.label)}</strong><small>${esc(j.phase)} · ${date(j.startedAt)}</small></span>${badge(j.result?.report?.verdict || j.status, j.status === 'completed' ? 'good' : j.status === 'failed' ? 'bad' : 'neutral')}${icon('arrow')}</button>`).join('')}</div>` : empty('Nothing has run yet', 'Source checks, harvesting, and transplant verification will appear here.')}</section>
  <section class="panel history-panel"><div class="section-heading"><h2>Saved transplants</h2>${badge(`${data.transplants.length} recorded`, 'neutral')}</div>${data.transplants.length ? (data.savedResults || data.transplants).slice().reverse().map((t) => `<div class="history-row">${icon('branch')}<div><strong>${esc(t.capability)}</strong><p class="path">${esc(t.destination)}</p><small>${esc(t.branch)} · ${date(t.appliedAt)}</small></div>${t.verification ? badge(t.verification.verdict, t.verification.verdict === 'VERIFIED' ? 'good' : 'bad') : badge('No saved result', 'neutral')}<button class="text-button" data-action="receipt" data-id="${esc(t.planId)}">View receipt</button><button class="text-button" data-action="reverify" data-slug="${esc(t.capability)}" data-root="${esc(t.destination)}" ${disabled()}>Verify again ${icon('arrow')}</button></div>`).join('') : '<p class="muted">No transplants have been recorded yet.</p>'}<p class="fine">Saved results show the initial transplant verification. Later verification runs appear in this session.</p></section>`;
}
function render() {
  pageDiagnostics.renders += 1;
  try { renderPage(); } catch (err) { pageDiagnostics.lastRenderError = `${new Date().toISOString()} ${err.message}`; throw err; }
  // A result the person should land on (after Finalize): scroll there once the page is painted, then forget it.
  if (landOn) { const target = document.querySelector(landOn); if (target) { target.scrollIntoView({ block: 'start' }); landOn = null; } }
}
let landOn = null;
function renderPage() {
  const tabs = [['workspace', 'grid', 'Workspace'], ['discover', 'search', 'Discover'], ['projects', 'folder', 'Projects'], ['bank', 'bank', 'Organ bank'], ['transplant', 'branch', 'Transplant'], ['laboratory', 'plus', 'Laboratory'], ['activity', 'activity', 'Activity']];
  if (!tabs.some(([id]) => id === view)) view = 'workspace';
  document.title = `GRAFT — ${tabs.find(([id]) => id === view)[2]}`;
  $('#app').innerHTML = `<aside class="sidebar"><a class="brand" href="#workspace" aria-label="GRAFT workspace"><img src="/brand-icon.png" alt="" width="34" height="34"><span>GRAFT</span></a><div class="workspace-label"><span class="workspace-avatar">L</span><span>Local workspace<small>On your machine</small></span><span class="local-dot"></span></div><div class="nav-label">WORKSPACE</div><nav aria-label="Main navigation">${tabs.map(([id, symbol, label]) => `<a href="#${id}" aria-label="${label}" title="${label}" class="nav-item ${view === id ? 'selected' : ''}" ${view === id ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${label}</span>${id === 'bank' && data.bank.length ? `<span class="nav-count">${data.bank.length}</span>` : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="local-card">${icon('shield')}<strong>Local by design</strong><p>Your code stays yours.<br>Your workspace stays here.</p></div><button class="nav-item about-button" data-action="about">${icon('code')}<span>About GRAFT</span></button><span class="version">GRAFT / ${esc(desktopVersion || 'frontend preview')}</span></div></aside>
  <div class="main-shell"><header class="topbar"><span>Workspace <span class="slash">/</span> <strong>${tabs.find(([id]) => id === view)[2]}</strong></span><div><span class="connection ${connectionError ? 'offline' : ''}"><span class="local-dot"></span>${connectionError ? 'Disconnected' : 'Local engine connected'}</span><button class="icon-button" data-action="refresh" aria-label="Refresh workspace">${icon('refresh')}</button></div></header><main id="main" tabindex="-1">${connectionError ? `<div class="notice error-text" role="alert">${esc(connectionError)} <button class="text-button" data-action="refresh">Retry connection</button></div>` : ''}${({ workspace, discover, projects, bank, transplant, laboratory, activity })[view]()}</main><footer>GRAFT <span>Good code, carried forward.</span><span>Local workspace · No telemetry</span>${data.dogfood ? `<span class="dogfood-badge">Dogfood record: ${esc(data.dogfood)} (local file, never uploaded)</span>` : ''}</footer></div>`;
}
// A small diagnostic surface for the desktop harness (no logging): how the page's polling is doing.
const pageDiagnostics = { polls: 0, lastPollStartedAt: null, lastPollFinishedAt: null, lastPollMs: null, lastError: null, renders: 0, lastRenderError: null };
window.graftPage = pageDiagnostics;
async function refresh(silent = false) {
  pageDiagnostics.polls += 1; pageDiagnostics.lastPollStartedAt = Date.now();
  try {
    const next = await api('state');
    pageDiagnostics.lastPollFinishedAt = Date.now(); pageDiagnostics.lastPollMs = pageDiagnostics.lastPollFinishedAt - pageDiagnostics.lastPollStartedAt;
    const changed = JSON.stringify(next) !== JSON.stringify(data) || connectionError;
    data = next; connectionError = ''; for (const job of [...(next.jobs || [])].reverse()) absorbJob(job);
    if (!silent || changed) render();
    if (selectedJob && changed) jobDialog(selectedJob);
  } catch (err) { pageDiagnostics.lastError = `${new Date().toISOString()} ${err.message}`; connectionError = err.message; render(); }
}
// Each finished job is absorbed into the workflow state exactly once, oldest first, so an
// earlier job can never undo what a later one established (a completed prepare must not clear
// the proof of the transplant that followed it).
const absorbedJobs = new Set();
function absorbJob(job) {
  if (!job || job.status === 'running' || absorbedJobs.has(job.id)) return;
  absorbedJobs.add(job.id);
  if (job.kind === 'prepare' && job.result?.transplant) { wf.transplant = job.result.transplant; wf.proof = null; plan = null; }
  if (job.kind === 'transplant' && job.result?.proof && job.result.transplantId) { wf.proof = job.result.proof; plan = null; }
}
async function exportProofsTo(assemblyWorkspaceId, folder) {
  try {
    const r = await api('laboratory/assembly/proofs/export', { assemblyWorkspaceId, destination: folder });
    lastProofExport = { ...r, at: new Date().toISOString() };
    render();
    return toast(`${r.count} proof file${r.count === 1 ? '' : 's'} exported.`);
  } catch (err) {
    lastProofExport = { error: err.message, at: new Date().toISOString(), assemblyWorkspaceId };
    render();
    return dialog('Proof could not be exported', `<p>${esc(err.message)}</p><p class="fine">The capability itself is unchanged; proof integrity is a separate question from its verification and its state.</p><div class="wf-actions"><button class="button" data-action="export-proofs" data-id="${esc(assemblyWorkspaceId)}">Retry ${icon('arrow')}</button><button class="text-button" data-action="diagnostics" data-id="" data-root="${esc(assemblyWorkspaceId)}">Save diagnostic bundle ${icon('arrow')}</button></div>`);
  }
}
async function saveDiagnosticsTo(situation, folder) {
  const r = await api('diagnostics/bundle', { ...situation, destination: folder });
  return dialog('Diagnostic bundle saved', `<p><strong>${esc(r.file)}</strong> was saved in the folder you chose (${esc(String(r.bytes))} bytes).</p><p class="fine">It holds support facts only — assembly status and steps, the ledger, verification summaries, proof integrity and intact proof files. No secrets, no source code, and GRAFT never uploads it. Send it to LeftSock Labs if you want help.</p>${r.failure ? `<p class="notice"><strong>${esc(r.failure.title)}</strong> ${esc(r.failure.next)}</p>` : ''}`);
}
let lastProofExport = null;
async function operation(route, body) {
  busy = true;
  try {
    const result = await api(route, body);
    if (route === 'apply') plan = null;
    close();
    if (result.job) selectedJob = result.job.id;
    await refresh();
    return result;
  } finally { busy = false; render(); }
}
function reportHTML(report) {
  if (!report) return '';
  return `<div class="report-banner ${report.verdict === 'VERIFIED' ? 'success' : 'failure'}"><strong>${esc(report.verdict)}</strong><span>${report.summary.passed} / ${report.summary.required} required tests passed</span></div><p>${esc(report.rationale)}</p><div class="test-results">${report.results.map((r) => `<div><span class="check-symbol ${r.outcome === 'failed' ? 'bad' : ''}">${r.outcome === 'passed' ? '✓' : '!'}</span><span><strong>${esc(r.description || r.id)}</strong><small>${esc(r.id)} · ${esc(r.outcome)}</small>${r.reason ? `<p class="error-text">${esc(r.reason)}</p>` : ''}</span></div>`).join('')}</div>`;
}
function jobDialog(id) {
  const j = data.jobs.find((j) => j.id === id);
  if (!j) return;
  selectedJob = id;
  const applied = j.applied || j.result;
  dialog(j.label, `<div class="job-phase">${j.status === 'running' ? '<span class="spinner"></span>' : icon(j.status === 'completed' ? 'check' : 'activity')}<strong>${esc(j.phase)}</strong>${badge(j.status, j.status === 'failed' ? 'bad' : 'neutral')}</div>
  ${j.status === 'running' ? '<p class="muted">GRAFT is checking the actual project. You can close this window; the operation will continue.</p>' : ''}
  ${j.error ? `<div class="notice error-text" role="alert">${esc(j.error)}</div>` : ''}${reportHTML(j.result?.report)}
  ${j.result?.banked ? `<p class="notice success">The verified capability is now in your organ bank.</p>${j.result.slug ? capabilityExits(j.result.slug) : ''}` : ''}
  ${applied?.receiptPath ? `<div class="notice"><strong>Files applied to ${esc(applied.branch)}</strong><p class="path">Receipt: ${esc(applied.receiptPath)}</p><p class="fine">${esc(applied.rollback)}</p></div>` : ''}
  ${j.result?.workspace ? `<div class="notice"><strong>Two sample projects are ready.</strong><p>Explore old-saas-project and harvest authentication. Then use new-startup as the destination.</p><p class="path">${esc(j.result.workspace)}</p></div><button class="button primary" data-action="navigate" data-view="projects">Explore sample projects ${icon('arrow')}</button>` : ''}`, true);
}
function inspect(id) {
  const p = data.projects.find((p) => p.id === id);
  dialog(p.name, `<p class="path">${esc(p.root)}</p><div class="project-meta"><span>${esc(p.framework)}</span><span>${esc(p.moduleSystem)}</span><span>${p.routes || 0} routes</span></div><h3>Discovered capabilities</h3>${p.capabilities.length ? p.capabilities.map((c) => `<div class="capability-row"><div><h3>${esc(c.displayName)}</h3><p>${esc(c.summary)}</p>${!c.harvestable ? `<small>${esc(c.notHarvestableReason)}</small>` : ''}</div>${c.harvestable ? `<button class="button primary" data-action="confirm-harvest" data-id="${esc(p.id)}" ${disabled()}>Harvest ${icon('arrow')}</button>` : badge('Discovery only', 'neutral')}</div>`).join('') : '<p class="muted">No supported capabilities found. Authentication harvesting requires the documented source profile.</p>'}`, true);
}
function confirmRun(title, message, route, body, button = 'Run verification') {
  dialog(title, `<p>${esc(message)}</p><div class="notice">This runs project code with your user permissions. Only continue with a project you trust.</div><form id="confirm-form"><label class="checkbox"><input type="checkbox" name="trusted" required><span>I trust this project and approve this operation.</span></label><button class="button primary full">${esc(button)} ${icon('arrow')}</button></form>`);
  $('#confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try { await operation(route, { ...body, trusted: true }); } catch (err) { toast(err.message); button.disabled = false; }
  });
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const { action, id, slug, root, index } = button.dataset;
  try {
    if (action === 'close') return close();
    if (action === 'navigate') { close(); location.hash = button.dataset.view; return; }
    if (action === 'refresh') return await refresh();
    if (action === 'job') return jobDialog(id);
    if (action === 'inspect') return inspect(id);
    if (action === 'add' && window.graftDesktop) { const selected = await window.graftDesktop.chooseProject(); if (selected) { await operation('projects', { path: selected }); toast('Project connected.'); } return; }
    if (action === 'add') return dialog('Add a local project', '<p>Connect a folder on this machine. Adding it only reads its structure; it does not run the project.</p><form id="add-form"><label for="project-path">Absolute folder path</label><input id="project-path" name="path" placeholder="/Users/you/Projects/my-project" autocomplete="off" required><p class="fine">You can drag a folder into your terminal to find its full path.</p><button class="button primary full">Add project</button></form>');
    if (action === 'samples') { button.disabled = true; return await operation('samples', {}); }
    if (action === 'confirm-harvest') {
      const p = data.projects.find((p) => p.id === id);
      return confirmRun('Harvest authentication', `GRAFT will start ${p.name}, test authentication over HTTP, and save the capability only if those checks pass. An existing package with the same name will be replaced using the bank’s recovery mechanism.`, 'harvest', { projectId: id, capability: 'authentication' }, 'Verify source & harvest');
    }
    if (action === 'use') { formState.slug = slug; plan = null; close(); location.hash = 'transplant'; return; }
    if (action === 'capability') {
      const b = data.bank.find((b) => b.slug === slug);
      return dialog(b.name, `${badge(b.verification?.verdict || 'Unverified', b.verification?.verdict === 'VERIFIED' ? 'good' : 'warn')}<p>Source: ${esc(b.source)}</p><h3>Behavior contract</h3><ul class="behavior-list">${b.statements.map((s) => `<li>${icon('check')}<span>${esc(s.text)}</span></li>`).join('')}</ul><h3>Acceptance tests</h3><ul>${b.tests.map((t) => `<li>${esc(t.description || t.id)}</li>`).join('')}</ul>${b.notFound.length ? `<p class="fine">Not included: ${esc(b.notFound.join(', '))}</p>` : ''}<button class="button primary" data-action="use" data-slug="${esc(slug)}">Plan transplant ${icon('arrow')}</button>`, true);
    }
    if (action === 'file') { const f = plan.plan.files[Number(index)]; return dialog(f.path, `<p class="fine">New file · Generated for ${esc(plan.plan.destination.project)}</p><pre>${esc(f.contents)}</pre>`, true); }
    if (action === 'entrypoint') return dialog(plan.entrypoint.path, `<h3>Before</h3><pre>${esc(plan.entrypoint.before)}</pre><h3>After</h3><pre>${esc(plan.entrypoint.after)}</pre>`, true);
    if (action === 'confirm-apply') return confirmRun('Apply this transplant', `Apply the reviewed ${plan.plan.files.length} new files and entrypoint edits to ${plan.plan.destination.project}, then run its acceptance tests. A branch and recovery receipt will preserve the recovery information.`, 'apply', { planId: plan.id }, 'Apply changes & verify');
    if (action === 'receipt') {
      const t = (data.savedResults || []).find((t) => t.planId === id);
      if (!t) throw new Error('Receipt is not available. Refresh the workspace.');
      return dialog('Transplant receipt', `<p class="path">${esc(t.receiptPath || t.destination)}</p>${t.receiptError ? `<p class="error-text">${esc(t.receiptError)}</p>` : ''}${t.report ? reportHTML(t.report) : `<p>${esc(t.verification?.verdict || 'No saved verification result.')}</p>`}<div class="notice"><strong>Recovery</strong><p>${esc(t.rollback || 'Inspect the receipt in the destination project before reversing any changes.')}</p></div>`, true);
    }
    if (action === 'reverify') {
      const p = data.projects.find((p) => p.root === root);
      if (!p) throw new Error('Register this destination project again before verifying it.');
      return confirmRun('Verify destination', `Run the saved ${slug} acceptance tests against ${p.name}.`, 'verify', { slug, projectId: p.id });
    }
    if (action === 'index-workspace') { button.disabled = true; return await operation('workspace/index', {}); }
    if (action === 'onboard-folder') {
      if (!window.graftDesktop) { button.dataset.action = 'add-root'; button.click(); button.dataset.action = 'onboard-folder'; return; }
      const selected = await window.graftDesktop.chooseProject();
      if (!selected) return;
      await api('workspace/roots', { path: selected });
      await refresh(); location.hash = 'discover'; render();
      toast('Folder chosen. Indexing what you already built…');
      return await operation('workspace/index', {});
    }
    if (action === 'add-root' && window.graftDesktop) { const selected = await window.graftDesktop.chooseProject(); if (selected) { await api('workspace/roots', { path: selected }); await refresh(); toast('Workspace folder authorized.'); } return; }
    if (action === 'add-root') return dialog('Authorize a workspace folder', '<p>GRAFT indexes only the folders you list here. It reads structure; it never runs your projects and never uploads anything.</p><form id="root-form"><label for="root-path">Absolute folder path</label><input id="root-path" name="path" placeholder="/Users/you/Developer" autocomplete="off" required><button class="button primary full">Authorize folder</button></form>');
    if (action === 'remove-root') { await api('workspace/roots', { path: root, remove: true }); await refresh(); return toast('Folder removed from the index.'); }
    if (action === 'clear-agent') { await api('agent', { clear: true }); await refresh(); return toast('Agent disconnected.'); }
    if (action === 'lab-open') { const r = await api('laboratory/blueprint', { blueprintId: id }); lab.blueprint = r.blueprint; lab.tab = 'overview'; lab.planFor = null; lab.plan = null; if (!lab.home) lab.home = await api('laboratory', {}); location.hash = 'laboratory'; return render(); }
    if (action === 'lab-back') { lab.blueprint = null; lab.home = await api('laboratory', {}); return render(); }
    if (action === 'lab-tab') { lab.tab = id; if (id === 'plan') { lab.planFor = null; } return render(); }
    if (action === 'lab-delete') { await api('laboratory/delete', { blueprintId: id }); lab.home = await api('laboratory', {}); return render(); }
    if (action === 'lab-add-goal') { const category = document.querySelector('[data-role="lab-add-category"]').value; const r = await api('laboratory/goal', { blueprintId: lab.blueprint.blueprintId, add: { category } }); lab.blueprint = r.blueprint; return render(); }
    if (action === 'lab-remove-goal') { const r = await api('laboratory/goal', { blueprintId: lab.blueprint.blueprintId, remove: id }); lab.blueprint = r.blueprint; return render(); }
    if (action === 'lab-required') { const r = await api('laboratory/goal', { blueprintId: lab.blueprint.blueprintId, update: { goalId: id, required: index === '1' } }); lab.blueprint = r.blueprint; return render(); }
    if (action === 'lab-select') {
      const goal = lab.blueprint.analysis.goals.find((g) => g.goalId === id); const c = Number(index) >= 0 ? goal.candidates[Number(index)] : null;
      const already = c && goal.selected && ((c.kind === 'organ' && goal.selected.slug === c.slug) || (c.kind === 'observation' && goal.selected.projectId === c.projectId));
      const selection = !c || already ? null : c.kind === 'organ' ? { kind: 'organ', slug: c.slug, capabilityId: c.capabilityId, name: c.name } : { kind: 'observation', projectId: c.projectId, capability: c.capability, name: c.name };
      const r = await api('laboratory/select', { blueprintId: lab.blueprint.blueprintId, goalId: id, selection }); lab.blueprint = r.blueprint; return render();
    }
    if (action === 'lab-plan-build') {
      const kind = document.querySelector('input[name="lab-host-kind"]:checked')?.value;
      const host = kind === 'existing-project' ? { kind, projectId: document.querySelector('#lab-project').value } : { kind: 'new-application', architectureId: document.querySelector('#lab-arch').value };
      if (host.kind === 'existing-project' && !host.projectId) return toast('Register a project first, or plan for a new application.');
      const r = await api('laboratory/plan', { blueprintId: lab.blueprint.blueprintId, host });
      lab.plan = r.plan; lab.planFor = lab.blueprint.blueprintId; lab.plans = (await api('laboratory/plans', { blueprintId: lab.blueprint.blueprintId })).plans;
      return render();
    }
    if (action === 'lab-assemble') {
      const p = lab.plan;
      // The confirmation describes the operation that will actually run: a library is carried in and
      // adapted, a service is transplanted. Saying the wrong one here would be a lie to the person.
      const applying = p.steps.filter((s) => s.type === 'ADAPT_LIBRARY_CAPABILITY' || s.type === 'TRANSPLANT_CAPABILITY');
      const nameOf = (s) => esc(`${goalLabel(p, s.goalId) || s.capability?.name || 'the capability'}${s.capability?.name && goalLabel(p, s.goalId) ? ` (${s.capability.name})` : ''}`);
      const addStep = applying.map((s) => (s.type === 'ADAPT_LIBRARY_CAPABILITY'
        ? `<li><strong>Add ${nameOf(s)}</strong><p>The verified library artifact is carried into the new application unchanged and a small ESM adapter is generated beside it, in a GRAFT-managed worktree. No package installation. No source build. No HTTP routes added.</p></li><li><strong>Verify ${nameOf(s)} in the new application</strong><p>The generated adapter and the carried artifact are exercised against the destination contract.</p></li>`
        : `<li><strong>Add ${nameOf(s)}</strong><p>in a GRAFT-managed worktree, through the normal transplant path.</p></li><li><strong>Verify ${nameOf(s)}</strong><p>with its own verification contract and a deterministic provider double.</p></li>`)).join('')
        + (p.composition ? p.steps.filter((s) => s.type === 'REVERIFY_CAPABILITY').map((s) => `<li><strong>Verify ${nameOf(s)} again</strong><p>on the combined application, after ${esc((s.alongside || []).join(', '))} — a later capability can break an earlier one, so the earlier proof is run again.</p></li>`).join('') : '');
      return dialog('Assemble application', `<p>GRAFT will:</p><ol class="about-steps"><li><strong>Create a new Node application</strong><p>${esc(p.host.label)} — package.json, server.mjs, README, .gitignore; a local git repository with one commit; no remote.</p></li>${addStep}<li><strong>Confirm the application still behaves as it did</strong><p>against what it answered before anything was added${p.composition ? ', then bind every capability to one final revision' : ''}, and re-index the assembled result.</p></li></ol>
        <label for="asm-name">Application name</label><input id="asm-name" value="${esc(p.blueprintName)}" maxlength="63">
        <label for="asm-parent">Destination folder (a new child folder is created inside it)</label><div class="lab-add"><input id="asm-parent" placeholder="${window.graftDesktop ? 'Choose a folder' : 'Absolute path to an existing folder'}" ${window.graftDesktop ? 'readonly' : ''}>${window.graftDesktop ? `<button class="text-button" data-action="lab-assemble-choose">Choose folder</button>` : ''}</div>
        <p class="notice">No deployment will occur. Nothing is pushed anywhere. The source capability is read only.</p>
        <button class="button primary full" data-action="lab-assemble-run" data-id="${esc(p.planId)}">Assemble ${icon('arrow')}</button>`, true);
    }
    if (action === 'lab-assemble-choose') { const selected = await window.graftDesktop.chooseProject(); if (selected) document.querySelector('#asm-parent').value = selected; return; }
    if (action === 'lab-assemble-run') {
      const destinationParent = document.querySelector('#asm-parent').value.trim(); const projectName = document.querySelector('#asm-name').value.trim();
      if (!destinationParent) return toast('Choose the folder to create the application in.');
      close();
      const r = await api('laboratory/execute', { planId: id, destinationParent, projectName });
      lab.execution = null; lab.executionCheckedFor = null; lab.assembly = null; await refresh(); return render();
    }
    if (action === 'lab-finalize') {
      const a = lab.assembly;
      return dialog('Finalize assembled project', `<p>GRAFT will move your project to the verified assembled revision:</p>
        <ul><li>confirm the assembly is still current and verified</li><li>confirm your checkout has not changed and has no uncommitted work</li><li>fast-forward <code>${esc(a.primaryBranch || 'main')}</code> to <code>${esc((a.currentRevision || '').slice(0, 12))}</code></li><li>keep the blank host commit in history</li></ul>
        <p class="notice">No force, no reset, nothing pushed anywhere. If anything has changed, GRAFT refuses and leaves your project alone.</p>
        <label class="checkbox"><input type="checkbox" id="finalize-confirm"><span>Move my project to the verified assembled revision.</span></label>
        <button class="button primary full" data-action="lab-finalize-run" data-id="${esc(id)}">Finalize ${icon('arrow')}</button>`);
    }
    if (action === 'lab-finalize-run') {
      if (!document.querySelector('#finalize-confirm').checked) return toast('Confirm the move first.');
      close();
      const r = await api('laboratory/assembly/finalize', { assemblyWorkspaceId: id, confirmed: true });
      // Land on the result, not the setup: the assembled application's ledger, state and proofs.
      landOn = '#assembled-application';
      lab.assembly = r.assembly; await refresh(); render();
      return toast('Finalized. Your project now points to the verified assembled revision.');
    }
    // Commercial Beta 0.1 — recovery and access.
    if (action === 'lab-retry') {
      const suggested = root || '';
      return dialog('Retry this assembly', `<p>GRAFT will start a fresh assembly from the same plan. The run that did not finish stays in your history exactly as it is; nothing it recorded is changed.</p>
        <label for="retry-name">Application name</label><div class="lab-add"><input id="retry-name" value="${esc(suggested)}" placeholder="application name"></div><p class="fine">A free name is suggested because the previous run's folder is left where it is.</p>
        <button class="button primary full" data-action="lab-retry-run" data-id="${esc(id)}">Retry ${icon('arrow')}</button>`);
    }
    if (action === 'lab-retry-run') {
      const projectName = document.querySelector('#retry-name').value.trim();
      if (!projectName) return toast('Give the application a name.');
      close();
      await api('laboratory/execution/retry', { executionId: id, projectName });
      lab.execution = null; lab.executionCheckedFor = null; lab.assembly = null; await refresh(); return render();
    }
    if (action === 'lab-discard') {
      return dialog('Discard this assembly', `<p>GRAFT will remove its own working copy for this run (the isolated worktree and its branch). Your repositories, the donor projects, everything already recorded and every proof stay exactly as they are.</p>
        <button class="button primary full" data-action="lab-discard-run" data-id="${esc(id)}">Discard ${icon('arrow')}</button>`);
    }
    if (action === 'lab-discard-run') {
      close();
      const r = await api('laboratory/execution/discard', { executionId: id });
      lab.execution = r.execution; await refresh(); render();
      return toast('Discarded. Nothing you own was changed.');
    }
    if (action === 'export-proofs') {
      if (!window.graftDesktop) return dialog('Export proofs', `<p>Choose a folder to export the tamper-evident proof files into.</p><form id="proofs-form"><label for="proofs-path">Absolute folder path</label><input id="proofs-path" placeholder="/path/to/folder"></form><button class="button primary full" data-action="export-proofs-run" data-id="${esc(id)}">Export ${icon('arrow')}</button>`);
      const folder = await window.graftDesktop.chooseFolder('proofs');
      if (!folder) return;
      return exportProofsTo(id, folder);
    }
    if (action === 'export-proofs-run') { const folder = document.querySelector('#proofs-path').value.trim(); if (!folder) return toast('Choose a folder.'); close(); return exportProofsTo(id, folder); }
    if (action === 'diagnostics') {
      const situation = { ...(id ? { executionId: id } : {}), ...(root ? { assemblyWorkspaceId: root } : {}) };
      if (!window.graftDesktop) return dialog('Save diagnostic bundle', `<p>GRAFT saves one local file with support facts only — no secrets, no source code, no upload. Send it to LeftSock Labs if you want help.</p><form id="diag-form"><label for="diag-path">Absolute folder path</label><input id="diag-path" placeholder="/path/to/folder"></form><button class="button primary full" data-action="diagnostics-run" data-id="${esc(id || '')}" data-root="${esc(root || '')}">Save ${icon('arrow')}</button>`);
      const folder = await window.graftDesktop.chooseFolder('diagnostics');
      if (!folder) return;
      return saveDiagnosticsTo(situation, folder);
    }
    if (action === 'diagnostics-run') { const folder = document.querySelector('#diag-path').value.trim(); if (!folder) return toast('Choose a folder.'); close(); return saveDiagnosticsTo({ ...(id ? { executionId: id } : {}), ...(root ? { assemblyWorkspaceId: root } : {}) }, folder); }
    if (action === 'lab-plan-explain') { button.disabled = true; try { const r = await api('laboratory/plan/explain', { planId: id }); lab.plan = r.plan; } finally { render(); } return; }
    if (action === 'lab-advise') { button.disabled = true; try { const r = await api('laboratory/advise', { blueprintId: lab.blueprint.blueprintId }); lab.blueprint = r.blueprint; } finally { render(); } return; }
    if (action === 'lab-accept') { const r = await api('laboratory/goal', { blueprintId: lab.blueprint.blueprintId, add: { category: slug, label: root, required: index === '1', source: 'agent-advisory', derivedFrom: 'agent-suggestion' } }); lab.blueprint = r.blueprint; return render(); }
    if (action === 'lab-use') {
      const home = await api('laboratory', {});
      const choices = home.blueprints.map((b) => `<button class="wf-choice" data-action="lab-use-into" data-slug="${esc(slug)}" data-id="${esc(b.blueprintId)}"><strong>${esc(b.name)}</strong><small>${b.goals} goal(s) · ${b.selected} selected</small></button>`).join('');
      return dialog('Use in Laboratory', `<p>Add this capability to a blueprint as the selected implementation of its goal.</p><div class="wf-choices">${choices}<button class="wf-choice" data-action="lab-use-into" data-slug="${esc(slug)}" data-id=""><strong>New blueprint</strong><small>Start a new application design with this capability</small></button></div>`);
    }
    if (action === 'lab-use-into') { close(); const r = await api('laboratory/use', { slug, ...(id ? { blueprintId: id } : {}) }); lab.blueprint = r.blueprint; lab.tab = 'overview'; lab.home = await api('laboratory', {}); location.hash = 'laboratory'; render(); return toast(r.note || 'Added to the blueprint as the selected implementation.'); }
    if (action === 'wf-start') { wf = { slug, destinations: null, destination: null, transplant: null, proof: null }; plan = null; close(); location.hash = 'transplant'; render(); const found = await api('destinations', { slug }); wf.destinations = found.candidates; render(); return; }
    if (action === 'export-capability') {
      // Desktop: the native save dialog picks the destination. Browser: GRAFT's exports folder.
      let destination;
      if (window.graftDesktop) { destination = await window.graftDesktop.chooseSavePath(`${slug}.zip`); if (!destination) return; }
      const request = destination ? { slug, destination } : { slug };
      let result;
      try { result = await api('capabilities/export', request); }
      catch (err) {
        if (!/already exists/.test(err.message)) throw err;
        return dialog('That file already exists', `<p>${esc(err.message)}</p><div class="wf-actions"><button class="button" data-action="export-capability-alternate" data-slug="${esc(slug)}" data-root="${esc(destination || '')}">Save with a new name</button><button class="button" data-action="export-capability-overwrite" data-slug="${esc(slug)}" data-root="${esc(destination || '')}">Replace it</button><button class="text-button" data-action="close">Cancel</button></div>`);
      }
      return dialog('Capability downloaded', exportSuccess(result));
    }
    if (action === 'export-capability-alternate' || action === 'export-capability-overwrite') {
      const result = await api('capabilities/export', { slug, ...(root ? { destination: root } : {}), ...(action.endsWith('alternate') ? { alternate: true } : { overwrite: true }) });
      return dialog('Capability downloaded', exportSuccess(result));
    }
    if (action === 'wf-source') { wf = { slug, destinations: null, destination: null, transplant: null, proof: null }; plan = null; render(); const found = await api('destinations', { slug }); wf.destinations = found.candidates; render(); return; }
    if (action === 'wf-destination') { wf.destination = (wf.destinations || []).find((d) => d.root === root) || null; wf.transplant = null; wf.proof = null; plan = null; return render(); }
    if (action === 'wf-prepare') {
      return confirmRun('Prepare isolated transplant', `GRAFT will create a dedicated worktree for ${wf.destination.name} beneath its own folder, on a new branch cut from ${wf.destination.repository?.head?.slice(0, 12) || 'HEAD'}. Your checkout stays untouched; nothing is pushed.`, 'transplants/prepare', { slug: wf.slug, destinationRoot: wf.destination.root, ...(wf.destination.repository?.dirty ? { allowDirty: true } : {}) }, 'Create worktree');
    }
    if (action === 'wf-plan') { const t = wf.transplant; plan = await api('plan', { slug: wf.slug, transplantId: t.id }); return render(); }
    if (action === 'wf-plan-resolve') { const t = wf.transplant; plan = await api('plan', { slug: wf.slug, transplantId: t.id, resolveConflicts: true }); return render(); }
    if (action === 'wf-agents-preview') { const result = await api('plan/agents-preview', { planId: plan.id }); return dialog('Portable AGENTS.md handoff', `<pre class="code-preview">${esc(result.content)}</pre>`); }
    if (action === 'wf-agents-export') { const result = await api('plan/agents-export', { planId: plan.id }); return dialog('AGENTS.md handoff exported', `<p class="path">${esc(result.path)}</p>${result.alternate ? `<p class="fine">${esc(result.mergeGuidance)}</p>` : ''}`); }
    if (action === 'wf-open') { if (!window.graftDesktop) throw new Error('Open the worktree from the desktop app.'); await window.graftDesktop.openPath(root); return toast('Opened the worktree.'); }
    if (action === 'wf-reveal') { if (!window.graftDesktop) throw new Error('Reveal is available in the desktop app.'); await window.graftDesktop.revealPath(root); return toast('Revealed in Finder.'); }
    if (action === 'wf-copy') { await navigator.clipboard.writeText(root); return toast('Worktree path copied.'); }
    if (action === 'wf-changes') {
      const c = await api('transplants/changes', { transplantId: id });
      return dialog('Changed files', `<h3>Created</h3><ul>${c.created.map((f) => `<li><span class="path">${esc(f)}</span></li>`).join('') || '<li class="muted">none</li>'}</ul><h3>Modified</h3><ul>${c.modified.map((f) => `<li><span class="path">${esc(f)}</span></li>`).join('') || '<li class="muted">none</li>'}</ul>${c.diff ? `<h3>Diff preview</h3><pre>${esc(c.diff)}</pre>` : ''}<p class="fine">Worktree: ${esc(c.worktree || '')} · ${esc(c.branch || '')}</p>`, true);
    }
    if (action === 'wf-cleanup') {
      const t = (data.managedTransplants || []).find((x) => x.id === id);
      const changed = t?.live?.dirty === true || ['APPLIED', 'VERIFIED', 'FAILED', 'INCONCLUSIVE'].includes(t?.state);
      return dialog('Clean up worktree', `<p>Remove <span class="path">${esc(t?.worktree.path || '')}</span> and its branch ${esc(t?.worktree.branch || '')}.</p>${changed ? '<div class="notice"><strong>This worktree contains changes.</strong><p>Cleaning up discards the transplanted files. Nothing was pushed, so they cannot be recovered afterwards.</p></div>' : ''}<button class="button ${changed ? '' : 'primary'} full" data-action="wf-cleanup-confirm" data-id="${esc(id)}">${changed ? 'Discard changes and clean up' : 'Clean up'}</button>`);
    }
    if (action === 'wf-cleanup-confirm') { const t = (data.managedTransplants || []).find((x) => x.id === id); close(); await api('transplants/cleanup', { transplantId: id, confirmDiscard: true }); if (wf.transplant?.id === id) { wf.transplant = null; wf.proof = null; plan = null; } await refresh(); return toast(`Worktree ${t?.worktree.branch || ''} cleaned up.`); }
    if (action === 'harvest-candidate') {
      const detail = await api('workspace/capability', { projectId: id, capability: slug });
      const kind = detail.capability.harvestCategory || slug;
      return confirmRun('Harvest this capability', `GRAFT will register ${detail.capability.harvestRoot || detail.project.root}, start it through ${detail.capability.providerSeam?.kind === 'factory-injection' ? 'its own factory seam with a deterministic provider double (no live provider, no credentials)' : 'its entrypoint'}, verify the ${kind} behaviour over HTTP, and bank it only if every required check passes.`, 'workspace/harvest', { projectId: id, capability: slug }, 'Verify source & harvest');
    }
    if (action === 'capability-detail') {
      const detail = await api('workspace/capability', { projectId: id, capability: slug });
      const c = detail.capability;
      return dialog(`${detail.project.name} · ${c.capability}`, `${badge(c.state, stateTone(c.state))}${badge(c.harvestable ? 'Harvestable' : 'Not harvestable', c.harvestable ? 'good' : 'warn')}${badge(c.transplantSupport === 'supported' ? 'Transplantable' : 'Not yet transplantable', c.transplantSupport === 'supported' ? 'good' : 'warn')}
        <p class="fine">${esc(detail.project.language)}/${esc(detail.project.runtime)} · ${esc(detail.project.moduleSystem)} · ${esc(detail.project.framework)} · entry ${esc(detail.project.entrypoint?.source || detail.project.entrypoint?.runtime || 'none found')}</p>
        ${c.auth ? `<h3>Classification</h3><ul class="behavior-list"><li>${icon('check')}<span>Credential authority: <strong>${esc(c.auth.credentialAuthority.kind)}</strong> — ${esc(c.auth.credentialAuthority.detail)}</span></li><li>${icon('check')}<span>Session transport: <strong>${esc(c.auth.sessionTransport)}</strong>, custody <strong>${esc(c.auth.sessionCustody)}</strong>, store <strong>${esc(c.auth.sessionStore)}</strong>${c.auth.sessionDurableAcrossRestart === false ? ' (not durable across restart)' : ''}</span></li>${c.auth.providers?.length ? `<li>${icon('check')}<span>Identity provider: ${esc(c.auth.providers.join(', '))}</span></li>` : ''}</ul>` : ''}
        <h3>Why GRAFT detected this</h3><ul class="behavior-list">${c.signals.map((sig) => `<li>${icon('check')}<span><strong>${esc(sig.id)}</strong> — ${esc(sig.evidence)}${sig.file ? ` <span class="path">${esc(sig.file)}</span>` : ''}</span></li>`).join('')}</ul>
        ${c.missingSignals?.length ? `<h3>Why it is not harvestable yet</h3><ul>${c.missingSignals.map((m) => `<li><strong>${esc(m.id)}</strong>: ${esc(m.why)}</li>`).join('')}</ul>` : ''}
        ${c.blockers?.length ? `<div class="notice"><strong>Current engine blockers</strong><ul>${c.blockers.map((b) => `<li>${esc(b.detail)}</li>`).join('')}</ul></div>` : ''}
        ${c.localVerification?.reasons?.length ? `<p class="fine">Local verification: ${esc(c.localVerification.reasons.join('; '))}</p>` : '<p class="fine">Local verification looks feasible.</p>'}`, true);
    }
    if (action === 'about') return dialog('You already built it.', `<p>GRAFT finds the capabilities in software you have already made, works out where they fit, and proves them again in their new home. Your software remembers; GRAFT reads that memory.</p><div class="about-steps"><p><strong>1. Find it</strong><br>Point GRAFT at a folder of your own projects. It indexes them locally and shows the capabilities it can reuse.</p><p><strong>2. Fit it</strong><br>Choose a destination. GRAFT says whether the capability fits, adapts it, and refuses honestly when it does not.</p><p><strong>3. Prove it</strong><br>Every reuse is verified by the capability's own contract, recorded at an exact revision, and bound to a tamper-evident proof you can export.</p></div>${supportedView()}<p class="fine">Everything runs on this machine; nothing is uploaded. Project code runs with your own privileges and is not sandboxed. Passing verification does not make a capability production-ready.</p><div class="wf-actions"><button class="text-button" data-action="diagnostics" data-id="" data-root="">Save diagnostic bundle ${icon('arrow')}</button></div>`, true);
    if (action === 'supported') return dialog('What’s supported in this beta', supportedView(), true);
  } catch (err) { toast(err.message); }
});
document.addEventListener('submit', async (event) => {
  if (event.target.id === 'lab-create-form') {
    event.preventDefault();
    const form = event.target; const categories = [...form.querySelectorAll('input[name="categories"]:checked')].map((i) => i.value);
    try { const r = await api('laboratory/create', { name: form.name.value, description: form.description.value, categories, hostIntent: form.hostIntent.value }); lab.blueprint = r.blueprint; lab.tab = 'overview'; lab.home = await api('laboratory', {}); render(); } catch (err) { toast(err.message); }
    return;
  }
  if (!['add-form', 'plan-form', 'discover-form', 'root-form', 'agent-form'].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target, button = form.querySelector('button[type="submit"], button');
  const values = Object.fromEntries(new FormData(form));
  button.disabled = true;
  try {
    if (form.id === 'add-form') { await operation('projects', values); toast('Project connected.'); }
    else if (form.id === 'root-form') { await api('workspace/roots', values); close(); await refresh(); toast('Workspace folder authorized. Index it to discover capabilities.'); }
    else if (form.id === 'agent-form') { await api('agent', { provider: values.provider, model: values.model || undefined, endpoint: values.endpoint || undefined }); await refresh(); toast('Agent connected. GRAFT still decides every outcome.'); }
    else if (form.id === 'discover-form') { discoveryQuery = values.text; discovery = await api('workspace/discover', { text: values.text }); render(); }
    else {
      formState = { slug: values.slug, projectId: values.projectId, resolveConflicts: values.resolveConflicts === 'on' };
      plan = await api('plan', formState); render();
    }
  } catch (err) { toast(err.message); button.disabled = false; }
});
document.addEventListener('change', async (event) => {
  if (event.target.dataset.action === 'lab-host' && lab.blueprint) {
    try { const r = await api('laboratory/host', { blueprintId: lab.blueprint.blueprintId, kind: event.target.value }); lab.blueprint = r.blueprint; render(); } catch (err) { toast(err.message); }
    return;
  }
  if (event.target.closest('#plan-form')) {
    formState = { slug: $('#capability').value, projectId: $('#destination').value, resolveConflicts: $('#plan-form [name="resolveConflicts"]').checked };
    if (plan) { plan = null; render(); }
  }
});
$('#dialog').addEventListener('cancel', () => { selectedJob = null; });
window.addEventListener('hashchange', () => { if (location.hash !== '#main') { view = location.hash.slice(1) || 'workspace'; render(); } $('#main').focus(); });
await refresh();
setInterval(() => { if (data.activeJob) refresh(true); }, 1800);
