// Verification for capabilities in LIBRARY form: a sibling of the HTTP runner, not a weaker path.
//
// The HTTP runner boots an application and observes it over the wire. A library has no wire, so
// this runner loads the library's own declared artifact in a separate process and calls its public
// operations. Everything after that is identical: structured per-case results, required/failed/
// inconclusive evidence, and one verdict authority — the vendored proof kernel's aggregation, through
// packages/proof-adapter, with GRAFT's own wording. There is no library-only verdict
// vocabulary — VERIFIED means here exactly what it means everywhere else.
//
// It never installs, builds, runs package lifecycle scripts, opens a network connection or writes
// to the source checkout.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { NEEDS_REVIEW, verdictRationale } from './index.js';
import { decideLibrarySuite } from '../../../proof-adapter/src/index.js';
import { nodeExecutable } from './executable.js';

const DRIVER = fileURLToPath(new URL('./library-driver.mjs', import.meta.url));
export const LIBRARY_TEST_KIND = 'library';

/** Run one library acceptance suite against the capability's declared artifact. */
export async function runLibrarySuite({ sourceRoot, artifact, tests, behavior = [], timeoutMs = 15000, now = () => new Date().toISOString() }) {
  const startedAt = now();
  const artifactPath = path.resolve(sourceRoot, artifact.entry);
  const inside = artifactPath === path.resolve(sourceRoot) || artifactPath.startsWith(path.resolve(sourceRoot) + path.sep);
  if (!inside) return report({ tests, startedAt, now, loaded: false, reason: 'the declared artifact is outside the source project', driver: null, artifact });
  if (!fs.existsSync(artifactPath)) return report({ tests, startedAt, now, loaded: false, reason: `the declared artifact ${artifact.entry} is not present`, driver: null, artifact });

  const plan = {
    artifact: { path: artifactPath, moduleSystem: artifact.moduleSystem === 'esm' ? 'esm' : 'commonjs', exportName: artifact.exportName || null },
    cases: tests.map((t) => ({ id: t.id, construct: t.construct || null, steps: t.steps })),
  };
  let driver;
  try { driver = await runDriver(plan, timeoutMs); }
  catch (error) { return report({ tests, startedAt, now, loaded: false, reason: error.message, driver: null, artifact }); }
  if (!driver.ok) return report({ tests, startedAt, now, loaded: false, reason: driver.message, driver: null, artifact });
  return report({ tests, startedAt, now, loaded: true, reason: null, driver, artifact, behavior });
}

/**
 * The authority path: the proof kernel decides every case from the contract's expectations and the
 * driver's raw observations, aggregates the required ones and roots the evidence; GRAFT words it.
 * Any failure to decide is NEEDS_REVIEW, never a native verdict.
 */
export function decideLibraryVerdict(tests, runs, { loaded, reason = null, artifact, capturedAt }) {
  const rationaleOptions = { serverReady: loaded, reason: reason || 'the library artifact could not be exercised', subject: `the library artifact ${artifact.entry}` };
  const results = (cases) => tests.map((t, index) => {
    const decided = cases?.[index] || null;
    const run = runs.find((r) => String(r.id) === String(t.id)) || null;
    return {
      id: t.id, kind: LIBRARY_TEST_KIND, required: t.required === true, provesBehavior: t.provesBehavior || null, description: t.description || null,
      // The per-case word is the kernel's verdict, mapped; the detail is the kernel's reason.
      outcome: decided ? decided.outcome : 'inconclusive',
      detail: decided ? decided.reason : reason || 'the capability was not exercised',
      observations: run?.observations || [],
    };
  });
  try {
    const proof = decideLibrarySuite({ tests, runs, loaded, capturedAt });
    const list = results(proof.cases);
    return { verdict: proof.verdict, rationale: verdictRationale(proof.verdict, list, rationaleOptions), results: list, proofRoot: proof.proofRoot, proofEvidence: proof.evidence, proofAuthority: { ...proof.authority, cufVerdict: proof.cufVerdict, cases: proof.cases.length, evidenceItems: proof.evidenceItems } };
  } catch (error) {
    const list = results(null).map((r) => ({ ...r, detail: `the proof could not be decided (${error.message})` }));
    return { verdict: NEEDS_REVIEW, rationale: `The proof could not be decided, so no verdict could be established (${error.message}).`, results: list, proofRoot: null, proofEvidence: null, proofAuthority: { perCase: 'proof-kernel', aggregation: 'proof-kernel', error: error.message } };
  }
}
function report({ tests, startedAt, now, loaded, reason, driver, artifact, behavior = [] }) {
  const decision = decideLibraryVerdict(tests, driver?.results || [], { loaded, reason, artifact });
  const { results } = decision;
  const required = results.filter((r) => r.required);
  return {
    ...decision,
    method: 'library-artifact', implementationForm: 'library',
    // The execution profile is what actually ran: the library's own artifact, loaded in a child
    // process. It is recorded so a VERIFIED claim always names how the behaviour was observed.
    runtime: { profile: 'library-artifact', entrypoint: artifact.entry, moduleSystem: artifact.moduleSystem || null },
    artifact: { entry: artifact.entry, moduleSystem: artifact.moduleSystem || null, exportName: artifact.exportName || null, loaded },
    results,
    summary: { required: required.length, passed: required.filter((r) => r.outcome === 'passed').length, failed: required.filter((r) => r.outcome === 'failed').length, inconclusive: required.filter((r) => r.outcome === 'inconclusive').length },
    behaviorCovered: [...new Set(results.filter((r) => r.outcome === 'passed').map((r) => r.provesBehavior).filter(Boolean))],
    startedAt, finishedAt: now(),
  };
}

/**
 * One short-lived child process, fed a plan on stdin, killed if it overruns.
 *
 * The driver is staged to a temporary file first: in a packaged build this module lives inside an
 * asar archive, which a plain Node child cannot read. Staging keeps the runner self-sufficient and
 * keeps the working directory well away from the source checkout.
 */
async function runDriver(plan, timeoutMs) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-library-verify-'));
  const driver = path.join(stage, 'library-driver.mjs');
  fs.writeFileSync(driver, fs.readFileSync(DRIVER));
  try { return await spawnDriver(driver, stage, plan, timeoutMs); }
  finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function spawnDriver(driver, stage, plan, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable(), ['--no-warnings', driver], {
      // The working directory is deliberately not the source checkout, and the environment carries
      // nothing from this process beyond what Node needs to start.
      cwd: stage,
      env: { PATH: process.env.PATH, NODE_OPTIONS: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`the library did not answer within ${timeoutMs} ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`the verification process could not start: ${error.message}`)); });
    child.on('close', () => {
      clearTimeout(timer);
      if (!out.trim()) return reject(new Error(`the library produced no result${err.trim() ? `: ${err.trim().split('\n')[0].slice(0, 200)}` : ''}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('the library verification produced an unreadable result')); }
    });
    child.stdin.end(JSON.stringify(plan));
  });
}
