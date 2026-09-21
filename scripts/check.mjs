import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let count = 0;
function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(?:js|mjs|cjs)$/.test(file)) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      count += 1;
    }
  }
}
for (const directory of ['packages', 'fixtures', 'scripts', 'bench']) check(directory);
console.log(`Syntax checked ${count} JavaScript files.`);
