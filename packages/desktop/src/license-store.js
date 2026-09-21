import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Two encrypted files share one directory: activation.bin (the activation record, cleared on
// deactivate/revoke) and installation.bin (this installation's identity, which must outlive
// the activation record so re-activation reuses the same seat). Deleting the directory —
// a reinstall — resets both, which the backend treats as a new installation.
//
// Encryption is Electron safeStorage: the macOS Keychain or Windows DPAPI (user-scoped), so
// the files are only readable by the same OS user on the same machine. POSIX modes are
// applied where they exist; on Windows the per-user application-data ACL provides the
// equivalent, and links are refused by inspecting the path before it is opened.
export function encryptedLicenseStore(directory, encryption, { timeoutMs = 10000 } = {}) {
  const NOFOLLOW = fs.constants.O_NOFOLLOW || 0; // undefined on Windows
  const refuseLink = (file) => {
    let stat;
    try { stat = fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
    if (stat.isSymbolicLink()) throw new Error('Invalid license file.');
  };
  const filename = path.join(directory, 'activation.bin');
  const installationFile = path.join(directory, 'installation.bin');
  const draftFile = path.join(directory, 'feedback-draft.bin'); // an unsent end-of-beta feedback draft, same encryption
  async function secure(operation) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Secure license storage timed out. Unlock your system keychain (macOS Keychain or Windows account) and try again.')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function prepare() {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('License directory must not be a symlink.');
    fs.chmodSync(directory, 0o700);
  }
  async function readEncrypted(file) {
    prepare();
    let fd;
    try {
      if (!NOFOLLOW) refuseLink(file);
      fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768) throw new Error('Invalid license file.');
      if (!await secure(() => encryption.isAsyncEncryptionAvailable())) throw new Error('Secure license storage is unavailable.');
      const ciphertext = fs.readFileSync(fd);
      return JSON.parse((await secure(() => encryption.decryptStringAsync(ciphertext))).result);
    } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  async function writeEncrypted(file, value) {
    prepare();
    if (!await secure(() => encryption.isAsyncEncryptionAvailable())) throw new Error('Secure license storage is unavailable.');
    const temporary = path.join(directory, `.${path.basename(file, '.bin')}-${crypto.randomUUID()}`);
    try {
      const ciphertext = await secure(() => encryption.encryptStringAsync(JSON.stringify(value)));
      fs.writeFileSync(temporary, ciphertext, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return {
    read: () => readEncrypted(filename),
    write: (record) => writeEncrypted(filename, record),
    // Clearing the activation never touches the installation identity.
    async clear() { prepare(); fs.rmSync(filename, { force: true }); },
    readInstallation: () => readEncrypted(installationFile),
    writeInstallation: (id) => writeEncrypted(installationFile, id),
    readDraft: () => readEncrypted(draftFile),
    writeDraft: (draft) => writeEncrypted(draftFile, draft),
    async clearDraft() { prepare(); fs.rmSync(draftFile, { force: true }); },
  };
}
