// Everything the desktop knows about the host operating system lives here, so the rest of
// the application stays one codebase with the same contracts on every platform.
//
// Supported commercial targets: Apple Silicon macOS and 64-bit Windows. Each ships the same
// GRAFT, the same licence key, the same seat pool and the same bundled Node runtime pinned in
// scripts/desktop/prepare.mjs.

export const SUPPORTED = Object.freeze({ 'darwin-arm64': true, 'win32-x64': true });

export function describePlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED[key]) throw new Error(`GRAFT supports Apple Silicon macOS and 64-bit Windows; this is ${key}.`);
  const windows = platform === 'win32';
  return Object.freeze({
    key, platform, arch, windows, macos: !windows,
    label: windows ? 'Windows' : 'macOS',
    // The activation's descriptive name (never its identity — that is the installation id).
    installationName: `GRAFT desktop (${windows ? 'Windows' : 'macOS'})`,
    // Bundled standalone Node runtime inside application resources.
    nodeExecutable: windows ? ['node.exe'] : ['bin', 'node'],
    // Git is a product requirement (repository recovery branches and receipts), not a dev
    // dependency. macOS resolves the Command Line Tools shim explicitly; Windows uses Git for
    // Windows from PATH, which is how its installer exposes git.exe.
    git: windows ? 'git' : '/usr/bin/git',
    gitHint: windows
      ? 'GRAFT needs Git for Windows to work with repositories. Install it from git-scm.com, then reopen GRAFT.'
      : 'GRAFT needs Apple Command Line Tools (Git) to work with repositories. Install them before using this candidate.',
    secureStorageName: windows ? 'Windows DPAPI' : 'macOS Keychain',
  });
}

// The native application menu differs only where the OS conventions do.
export function applicationMenu({ windows }, { license, download, downloadEnabled }) {
  const appMenu = windows
    ? [{ role: 'about' }, { label: 'License…', click: license }, { type: 'separator' }, { role: 'quit' }]
    : [{ role: 'about' }, { label: 'License…', click: license }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }];
  return [
    { label: 'GRAFT', submenu: appMenu },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: windows ? [{ role: 'minimize' }, { role: 'close' }] : [{ role: 'minimize' }, { role: 'zoom' }] },
    { label: 'Help', submenu: [{ label: 'Download updates…', enabled: downloadEnabled, click: download }] },
  ];
}
