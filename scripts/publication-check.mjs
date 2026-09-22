#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const posix = (value) => value.split(path.sep).join('/');

function filesUnder(directory) {
  if (fs.existsSync(path.join(directory, '.git'))) {
    return execFileSync('git', ['-C', directory, 'ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  }

  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(posix(path.relative(directory, absolute)));
    }
  };
  visit(directory);
  return files.sort();
}

const deniedPaths = [
  /^bench\/compatibility-perturbations\.mjs$/,
  /^HANDOFF\.md$/,
  /^docs\/GALUXIUM-AUDIT\.md$/,
  /^docs\/GALUXIUM-PUBLICATION-AUDIT\.md$/,
  /^docs\/commercial-beta-readiness-0\.1(?:-discovery\.md|\/)/,
  /^docs\/demo\//,
  /^docs\/evidence\//,
  /^docs\/library-host-adaptation-0\.1b\//,
  /^docs\/.*checkpoint.*\.txt$/,
  /^docs\/real-multicapability-composition-0\.1\//,
  /^packages\/desktop\/config\/product\.private-beta\.json$/,
  /^packages\/licensing\/(?:DEPLOY\.md|fly\.toml)$/,
  /^scripts\/private-beta\.mjs$/,
];

const signatures = {
  privateKey: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  stripe: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/g,
  github: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g,
  aws: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  resend: /\bre_[A-Za-z0-9]{16,}\b/g,
  slack: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  bearer: /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/gi,
};

const reviewedFixtures = new Map(Object.entries({
  'privateKey:packages/core/test/export.test.js': 1,
  'privateKey:packages/web/test/judge.test.js': 1,
  'stripe:packages/core/test/agent.test.js': 7,
  'stripe:packages/core/test/dogfood.test.js': 1,
  'stripe:packages/core/test/export.test.js': 1,
  'stripe:packages/core/test/workspace.test.js': 3,
  'stripe:packages/licensing/.env.example': 1,
  'stripe:packages/licensing/test/stripe-signature.test.js': 3,
  'github:packages/core/test/apply.test.js': 1,
  'aws:packages/core/test/manifest.test.js': 1,
  'bearer:packages/licensing/src/server.js': 1,
  'bearer:packages/licensing/test/stripe-signature.test.js': 1,
}));

const findings = [];
const observedFixtures = new Map();
const files = filesUnder(root);
const home = posix(os.homedir());

for (const relative of files) {
  const normalized = posix(relative);
  const absolute = path.join(root, relative);
  const stat = fs.statSync(absolute);

  if (deniedPaths.some((pattern) => pattern.test(normalized))) findings.push(`${normalized}: private publication path`);
  if (/^\.env(?:\.|$)/.test(path.basename(normalized)) && !/\.env(?:\.[^.]+)*\.example$/.test(normalized) && path.basename(normalized) !== '.env.example') {
    findings.push(`${normalized}: environment file`);
  }
  if (/\.(?:dmg|zip|tar|tgz|gz|7z|mp4|mov|webm|log|sqlite|db)$/i.test(normalized)) findings.push(`${normalized}: generated/binary artifact`);
  if (stat.size > 2 * 1024 * 1024) findings.push(`${normalized}: oversized file (${stat.size} bytes)`);
  if (stat.size > 2 * 1024 * 1024) continue;

  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');

  if (text.includes(`${home}/`)) findings.push(`${normalized}: local home path`);
  if (/@(?:gmail|yahoo|hotmail|outlook|icloud)\.(?:com|net|org)\b/i.test(text)) findings.push(`${normalized}: personal mailbox domain`);

  for (const [category, pattern] of Object.entries(signatures)) {
    const count = [...text.matchAll(pattern)].length;
    if (!count) continue;
    const key = `${category}:${normalized}`;
    if (reviewedFixtures.get(key) === count) observedFixtures.set(key, count);
    else findings.push(`${normalized}: ${category} signature (${count})`);
  }
}

for (const [key, count] of reviewedFixtures) {
  if (files.includes(key.slice(key.indexOf(':') + 1)) && observedFixtures.get(key) !== count) {
    findings.push(`${key.slice(key.indexOf(':') + 1)}: reviewed fixture signature count changed`);
  }
}

if (findings.length) {
  console.error(`Publication check failed with ${findings.length} finding(s):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Publication check passed: ${files.length} files; reviewed test sentinels unchanged.`);
}
