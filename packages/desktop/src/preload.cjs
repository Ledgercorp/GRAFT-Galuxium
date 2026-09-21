const { contextBridge, ipcRenderer } = require('electron');
const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).then((result) => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
});
contextBridge.exposeInMainWorld('graftDesktop', Object.freeze({
  version: () => call('graft:version'),
  chooseProject: () => call('graft:choose-project'),
  chooseFolder: (purpose) => call('graft:choose-folder', purpose),
  openPath: (value) => call('graft:open-path', value),
  revealPath: (value) => call('graft:reveal-path', value),
  chooseSavePath: (suggestion) => call('graft:choose-save-path', suggestion),
  licenseStatus: () => call('graft:license-status'),
  activate: (key) => call('graft:activate', key),
  validate: () => call('graft:validate'),
  deactivate: () => call('graft:deactivate'),
  buy: () => call('graft:buy'),
  // Private Beta Program: end-of-beta feedback (answers only), its local draft, support, and quitting.
  feedback: (answers) => call('graft:feedback', answers),
  dismissFeedback: () => call('graft:feedback-dismiss'),
  feedbackDraft: () => call('graft:feedback-draft'),
  saveFeedbackDraft: (answers) => call('graft:feedback-draft-save', answers),
  clearFeedbackDraft: () => call('graft:feedback-draft-clear'),
  contactSupport: () => call('graft:contact-support'),
  quit: () => call('graft:quit'),
}));
