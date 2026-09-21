import fs from 'node:fs';
import path from 'node:path';

/** Refuse traversal and links below a trusted root before touching project files. */
export function safeProjectPath(root, relative, { allowGit = false } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) {
    throw new Error(`unsafe project path: ${relative}`);
  }
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || (!allowGit && part.toLowerCase() === '.git'))) {
    throw new Error(`unsafe project path: ${relative}`);
  }
  let current = fs.realpathSync(root);
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    if (stat.isSymbolicLink()) throw new Error(`symbolic link in project path: ${relative}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`parent is not a directory: ${relative}`);
    if (i === parts.length - 1 && stat.isFile() && stat.nlink > 1) throw new Error(`hard-linked project file: ${relative}`);
  }
  return current;
}
