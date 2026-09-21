import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDemo } from '../src/demo.js';

test('demo isolates both projects, restores GRAFT_HOME, and persists the observed verdict', async (t) => {
  t.mock.method(console, 'log', () => {});
  const previous = process.env.GRAFT_HOME;
  process.env.GRAFT_HOME = '/graft-demo-caller-home';
  let result;
  try {
    result = await runDemo();
    assert.equal(process.env.GRAFT_HOME, '/graft-demo-caller-home');
    assert.equal(path.dirname(result.work), os.tmpdir());
    assert.equal(path.dirname(result.sourceRoot), result.work);
    assert.equal(path.dirname(result.destRoot), result.work);
    assert.equal(result.manifest.sourceVerificationReport.source.root, result.sourceRoot);
    assert.equal(result.report.verdict, 'VERIFIED');
    const receiptPath = path.join(result.destRoot, '.graft/transplants', `${result.plan.id}.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath));
    assert.equal(receipt.verification.verdict, result.report.verdict);
    assert.equal(receipt.verification.summary.passed, result.report.summary.passed);
    if (process.platform !== 'win32') assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous;
    if (result) fs.rmSync(result.work, { recursive: true, force: true });
  }
});
