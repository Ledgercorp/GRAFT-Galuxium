const api = window.graftDesktop;
const $ = (selector) => document.querySelector(selector);
const status = $('#status');
let purchaseEnabled = false, inviteOnly = false, supportEnabled = false;
let current = null; // the latest licence status from the main process
function buttons(state) {
  $('#deactivate').disabled = !state.activated;
  $('#validate').disabled = !state.activated;
  // Buy opens the checkout the build was configured with, in the default browser; nothing else.
  $('#buy').disabled = !purchaseEnabled;
  $('#buy').hidden = inviteOnly;
  $('#purchase').hidden = !purchaseEnabled || inviteOnly;
  $('#intro').hidden = inviteOnly;
  $('#invite').hidden = !inviteOnly;
}
const longDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null);
async function show(state) {
  current = state;
  status.textContent = state.message;
  buttons(state);
  $('#activation').hidden = state.activated;
  // Private Beta Program: an ended beta shows the end-of-beta experience instead of the licence form.
  const ended = state.betaEnded;
  $('#beta-view').hidden = !ended;
  $('#license-view').hidden = Boolean(ended);
  $('#contact-support').hidden = !supportEnabled;
  if (!ended) return;
  const term = [ended.issuedAt && `Beta started ${longDate(ended.issuedAt)}`, ended.expiresAt && `ended ${longDate(ended.expiresAt)}`].filter(Boolean).join(' · ');
  $('#beta-term').textContent = term;
  if (ended.askForFeedback) { await showForm(); return; }
  $('#feedback').hidden = true;
  $('#beta-done').hidden = false;
  $('#beta-title').textContent = 'GRAFT Private Beta Complete';
  $('#beta-lead').textContent = 'Your GRAFT private beta access has ended.';
  $('#beta-done-message').textContent = ended.feedbackSubmitted ? 'Thanks. Your feedback was sent.' : 'Thanks for taking part.';
  $('#more-feedback').textContent = ended.feedbackSubmitted ? 'Send more feedback' : 'Send feedback';
}
const answers = () => {
  const data = new FormData($('#feedback'));
  const out = {};
  for (const name of ['usedFor', 'workedWell', 'frustrated', 'worthPaying', 'missingFeature', 'anythingElse']) { const v = String(data.get(name) || ''); if (v.trim()) out[name] = v; }
  if (data.get('rating')) out.rating = Number(data.get('rating'));
  if (data.get('wouldUseAgain')) out.wouldUseAgain = String(data.get('wouldUseAgain'));
  return out;
};
function fill(draft) {
  if (!draft || typeof draft !== 'object') return;
  for (const name of ['usedFor', 'workedWell', 'frustrated', 'worthPaying', 'missingFeature', 'anythingElse']) if (typeof draft[name] === 'string') $(`#${name}`).value = draft[name];
  if (draft.rating) { const r = document.querySelector(`input[name="rating"][value="${draft.rating}"]`); if (r) r.checked = true; }
  if (draft.wouldUseAgain) { const r = document.querySelector(`input[name="wouldUseAgain"][value="${draft.wouldUseAgain}"]`); if (r) r.checked = true; }
}
async function showForm() {
  $('#beta-done').hidden = true;
  $('#feedback').hidden = false;
  $('#beta-title').textContent = 'GRAFT Private Beta Complete';
  $('#beta-lead').textContent = 'Your GRAFT private beta access has ended. Thanks for putting it through its paces.';
  const draft = await api.feedbackDraft().catch(() => null);
  if (draft) { fill(draft); $('#feedback-status').textContent = 'Your earlier answers were kept. Retry when you are ready.'; $('#retry-feedback').hidden = false; }
}
async function run(action) {
  document.querySelectorAll('#license-view button').forEach((button) => { button.disabled = true; });
  try { const result = await action(); if (result) await show(result); }
  catch (err) { status.textContent = err.message; }
  finally { const latest = await api.licenseStatus(); document.querySelectorAll('#license-view button').forEach((button) => { button.disabled = false; }); buttons(latest); }
}
$('#activation').addEventListener('submit', (event) => { event.preventDefault(); const key = $('#license-key').value; $('#license-key').value = ''; run(() => api.activate(key)); });
$('#validate').addEventListener('click', () => run(() => api.validate()));
$('#deactivate').addEventListener('click', () => run(() => api.deactivate()));
$('#buy').addEventListener('click', () => run(() => api.buy()));

// ---- End-of-beta feedback ----
async function sendFeedback() {
  const form = $('#feedback');
  if (!form.reportValidity()) return; // required answers and the 1–5 rating are enforced here and again server-side
  const payload = answers();
  const feedbackStatus = $('#feedback-status');
  form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  feedbackStatus.textContent = 'Sending…';
  try {
    const result = await api.feedback(payload);
    await api.clearFeedbackDraft().catch(() => null);
    await show(result);
    $('#beta-done-message').textContent = 'Thanks. Your feedback was sent.';
  } catch (err) {
    // Nothing typed is lost: the draft is kept (encrypted, locally) and Retry is offered.
    await api.saveFeedbackDraft(payload).catch(() => null);
    feedbackStatus.textContent = `${err.message} Your answers were kept.`;
    $('#retry-feedback').hidden = false;
  } finally { form.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
}
$('#feedback').addEventListener('submit', (event) => { event.preventDefault(); sendFeedback(); });
$('#retry-feedback').addEventListener('click', () => sendFeedback());
$('#not-now').addEventListener('click', async () => { await api.saveFeedbackDraft(answers()).catch(() => null); await show(await api.dismissFeedback()); });
$('#more-feedback').addEventListener('click', () => showForm());
$('#contact-support').addEventListener('click', () => api.contactSupport().catch((err) => { $('#feedback-status').textContent = err.message; }));
$('#close-graft').addEventListener('click', () => api.quit());
$('#new-license').addEventListener('click', (event) => { event.preventDefault(); $('#beta-view').hidden = true; $('#license-view').hidden = false; $('#activation').hidden = false; });

const version = await api.version();
purchaseEnabled = version.purchaseEnabled === true;
inviteOnly = version.inviteOnly === true;
supportEnabled = version.supportEnabled === true;
$('#version').textContent = `GRAFT ${version.version}${version.testBuild ? ' · TEST FIXTURE — not for distribution' : ''}`;
await show(await api.licenseStatus());
