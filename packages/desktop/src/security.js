export function allowedPage(url, workspaceOrigin, licenseUrl) {
  try { const u = new URL(url); return (u.origin === workspaceOrigin && u.pathname === '/' && !u.search) || url === licenseUrl; }
  catch { return false; }
}
export function trustedSender(event, webContents, workspaceOrigin, licenseUrl) {
  return event.sender === webContents && event.senderFrame === webContents.mainFrame && allowedPage(event.senderFrame.url, workspaceOrigin, licenseUrl);
}
export function safeExternalUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && u.port === '' ? u.href : null; }
  catch { return null; }
}
