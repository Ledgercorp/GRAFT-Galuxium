import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const cli = path.join(repo, 'packages/cli/src/index.js');

function sandbox(t) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graft-cli-test-')));
  const home = path.join(work, 'home');
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  function run(args, expectedStatus = 0) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: work, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GRAFT_HOME: home, NO_COLOR: '1' },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI terminated with ${result.signal}`);
    assert.equal(result.status, expectedStatus, `graft ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  }
  return { work, home, run };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('help and version work without creating a registry', (t) => {
  const { home, run } = sandbox(t);
  for (const args of [[], ['--help'], ['-h'], ['help']]) {
    const { stdout } = run(args);
    assert.match(stdout, /graft transplant/);
    assert.match(stdout, /GRAFT_HOME/);
    assert.doesNotMatch(stdout, /\x1b\[/);
  }
  for (const args of [['transplant', '--help'], ['help', 'transplant']]) {
    const { stdout } = run(args);
    assert.match(stdout, /--dry-run/);
    assert.match(stdout, /--allow-no-git/);
    assert.match(stdout, /--no-verify/);
  }
  assert.match(run(['harvest', '-h']).stdout, /--bank-unverified/);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'packages/cli/package.json'), 'utf8'));
  assert.equal(run(['--version']).stdout.trim(), pkg.version);
  assert.equal(run(['-v']).stdout.trim(), pkg.version);
  assert.equal(fs.existsSync(home), false);
});

test('invalid commands and options fail before any project or bank mutation', (t) => {
  const { home, run } = sandbox(t);
  const cases = [
    [['transplat'], /unknown command/],
    [['constructor'], /unknown command/],
    [['help', 'transplat'], /unknown command/],
    [['projects', '--typo'], /unknown option/],
    [['projects', '--__proto__'], /unknown option/],
    [['bank', '-x'], /unknown option/],
    [['harvest', 'source', '--capability'], /requires a value/],
    [['plan', 'authentication', '--to', '--json'], /--to requires a value/],
    [['plan', 'authentication', '--to='], /non-empty value/],
    [['transplant', 'authentication', '--allow-no-git=false'], /does not accept a value/],
    [['transplant', 'authentication', '--resolve-conflicts=false'], /does not accept a value/],
    [['transplant', 'authentication', '--no-verify=false'], /does not accept a value/],
    [['transplant', 'authentication', '--dry-run', '--dry-run'], /more than once/],
    [['verify', 'authentication', '--in=first', '--in=second'], /more than once/],
    [['plan', 'authentication', 'extra', '--to=destination'], /too many arguments/],
    [['projects', 'extra'], /too many arguments/],
    [['--version', 'extra'], /does not accept arguments/],
    [['add'], /usage: graft add/],
    [['harvest'], /usage: graft harvest/],
    [['plan', 'authentication'], /usage: graft plan/],
    [['transplant', 'authentication'], /usage: graft transplant/],
    [['verify', 'authentication'], /usage: graft verify/],
  ];
  for (const [args, expected] of cases) assert.match(run(args, 1).stderr, expected);
  assert.equal(fs.existsSync(home), false);
});

test('registering invalid projects leaves the registry untouched and -- permits dashed paths', (t) => {
  const { work, home, run } = sandbox(t);
  fs.writeFileSync(path.join(work, 'file.txt'), 'not a project');
  assert.match(run(['add', 'file.txt'], 1).stderr, /must be a directory/);
  assert.equal(fs.existsSync(home), false);
  fs.mkdirSync(path.join(work, '-project'));
  assert.match(run(['add', '--', '-project']).stdout, /added -project/);
  assert.match(run(['add', '--', '-project']).stdout, /already known/);
  const registry = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].root, path.join(work, '-project'));
});

test('bank capability names cannot escape the organ bank', (t) => {
  const { run } = sandbox(t);
  assert.match(run(['plan', '../outside', '--to', '.'], 1).stderr, /capability must be a bank name/);
  assert.match(run(['verify', '/outside', '--in', '.'], 1).stderr, /capability must be a bank name/);
});

test('boolean flags preserve following positional project paths', (t) => {
  const { home, run } = sandbox(t);
  const source = path.join(repo, 'fixtures/old-saas-project');
  const result = run(['harvest', '--no-verify-source', source, '--capability=authentication']);
  assert.match(result.stdout, /source verification skipped/);
  const provenance = JSON.parse(fs.readFileSync(path.join(home, 'organ-bank/authentication.graft/provenance.json'), 'utf8'));
  assert.notEqual(provenance.verifiedInSource?.verdict, 'VERIFIED');
});

test('CLI workflow harvests, previews, transplants, and verifies real HTTP behavior', { timeout: 60_000 }, (t) => {
  const { work, home, run } = sandbox(t);
  const source = path.join(repo, 'fixtures/old-saas-project');
  const dest = path.join(work, 'destination with spaces');
  fs.cpSync(path.join(repo, 'fixtures/new-startup'), dest, { recursive: true });
  git(dest, 'init', '-q');
  git(dest, 'add', '-A');
  git(dest, '-c', 'user.name=CLI Test', '-c', 'user.email=cli-test@graft.local', 'commit', '-qm', 'initial');
  const originalHead = git(dest, 'rev-parse', 'HEAD');
  const originalBranch = git(dest, 'branch', '--show-current');

  assert.match(run(['projects']).stdout, /none yet/);
  assert.match(run(['bank']).stdout, /empty/);
  run(['add', dest]);
  assert.match(run(['projects']).stdout, /destination with spaces/);
  assert.match(run(['harvest', source]).stdout, /authentication/i);
  assert.match(run(['harvest', source, '--capability', 'authentication']).stdout, /VERIFIED/);
  assert.match(run(['bank']).stdout, /verified/i);

  const noGit = path.join(work, 'no-git-project');
  fs.cpSync(path.join(repo, 'fixtures/new-startup'), noGit, { recursive: true });
  assert.match(run(['transplant', 'authentication', '--to', noGit, '--resolve-conflicts'], 1).stdout, /Refused/);
  assert.equal(fs.existsSync(path.join(noGit, 'src/auth')), false);

  const blockedFile = path.join(work, 'needs-resolution.json');
  const blocked = run(['plan', 'authentication', '--to', dest, `--json=${blockedFile}`], 1);
  assert.match(blocked.stdout, /needs-resolution/);
  assert.equal(JSON.parse(fs.readFileSync(blockedFile, 'utf8')).status, 'needs-resolution');
  run(['plan', 'authentication', '--to', dest, '--resolve-conflicts', '--json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(work, 'graft-plan.json'), 'utf8')).status, 'ready');

  const preview = run(['transplant', 'authentication', '--dry-run', dest, '--resolve-conflicts']);
  assert.match(preview.stdout, /Dry run/);
  assert.equal(git(dest, 'rev-parse', 'HEAD'), originalHead);
  assert.equal(git(dest, 'branch', '--show-current'), originalBranch);
  assert.equal(git(dest, 'status', '--porcelain'), '');

  const applied = run(['transplant', 'authentication', '--to', dest, '--resolve-conflicts']);
  assert.match(applied.stdout, /Transplanted/);
  assert.match(applied.stdout, /VERIFIED/);
  assert.notEqual(git(dest, 'branch', '--show-current'), originalBranch);
  assert.match(run(['verify', 'authentication', '--in', dest]).stdout, /VERIFIED/);
  const registry = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  assert.equal(registry.transplants.length, 1);
  assert.equal(registry.transplants[0].destination, dest);

  fs.appendFileSync(path.join(dest, 'src/main.js'), '\nthrow new Error("CLI verification test startup failure");\n');
  assert.match(run(['verify', 'authentication', '--in', dest], 1).stdout, /FAILED|NEEDS REVIEW/);
});

test('a package interrupted during replacement stays visible with recovery guidance', (t) => {
  const { home, run } = sandbox(t);
  const bank = path.join(home, 'organ-bank');
  fs.mkdirSync(bank, { recursive: true });
  fs.writeFileSync(path.join(bank, '.authentication.graft.lock'), JSON.stringify({ pid: 999999, target: 'authentication.graft' }));
  const listing = run(['bank']);
  assert.match(listing.stdout, /authentication\.graft.*unreadable/);
  assert.match(listing.stdout, /needs recovery/);
  const plan = run(['plan', 'authentication', '--to', 'destination'], 1);
  assert.match(plan.stderr, /needs recovery/);
  assert.doesNotMatch(plan.stderr, /no harvested capability/);
});

test('graft dogfood lists, annotates, shows and scores a local session and validates tags', (t) => {
  const { home, run } = sandbox(t);
  assert.match(run(['dogfood', 'list']).stdout, /No dogfood sessions/);
  run(['dogfood', 'note', 'cli-trial', 'route not recognised', '--tag', 'NOPE'], 1);
  run(['dogfood', 'note', 'cli-trial', '--tag', 'UX_FRICTION'], 1);
  run(['dogfood', 'note', 'cli-trial', 'had to rollback with git', '--tag', 'UX_FRICTION', '--stage', 'rollback', '--terminal', '--intervention']);
  run(['dogfood', 'note', 'cli-trial', 'harvest refused unrecognised auth', '--tag', 'EXPECTED_REFUSAL', '--stage', 'harvest', '--ref', '1']);
  const file = path.join(home, 'dogfood', 'cli-trial', 'events.jsonl');
  assert.ok(fs.existsSync(file));
  const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['session.open', 'observation', 'session.open', 'observation']);
  assert.equal(events[1].data.terminal, true);
  assert.equal(events[1].intervention, true);
  assert.equal(events[3].data.ref, 1);
  const shown = run(['dogfood', 'show', 'cli-trial']).stdout;
  assert.match(shown, /UX_FRICTION \[terminal\]: had to rollback with git/);
  assert.match(shown, /EXPECTED_REFUSAL \(re #1\)/);
  assert.match(run(['dogfood', 'list']).stdout, /cli-trial\s+4 event\(s\)/);
  const card = JSON.parse(run(['dogfood', 'score', 'cli-trial', '--json']).stdout);
  assert.equal(card.counts.uxFriction, 1);
  assert.equal(card.counts.expectedRefusals, 1);
  assert.equal(card.terminalUse.count, 1);
  assert.equal(card.manualIntervention.count, 1);
  assert.equal(card.transplant.finalState, 'NO_TRANSPLANT_ATTEMPTED'); // notes alone are not a failed transplant
  const text = run(['dogfood', 'score', 'cli-trial']).stdout;
  assert.match(text, /final state\s+NO_TRANSPLANT_ATTEMPTED/);
  assert.match(text, /no harvest, plan, apply or verify was recorded/);
  assert.match(text, /false VERIFIED\s+0/);
  run(['dogfood', 'score', 'missing'], 1);
  run(['dogfood', 'bogus', 'x'], 1);
  // A session name can never become a path outside GRAFT_HOME/dogfood, on the read paths too.
  fs.mkdirSync(path.join(home, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(home, 'outside', 'events.jsonl'), JSON.stringify({ seq: 1, type: 'observation', data: { tag: 'SUCCESS', text: 'planted' } }) + '\n');
  for (const name of ['../outside', '..', '/tmp', 'a/b', '.hidden']) {
    assert.doesNotMatch(run(['dogfood', 'show', name], 1).stdout, /planted/);
    assert.match(run(['dogfood', 'score', name], 1).stderr, /session names/);
    run(['dogfood', 'note', name, 'x', '--tag', 'SUCCESS'], 1);
  }
});

// ---------------------------------------------------------------------------------------------
// Proof Integrity 0.1, Checkpoint C: graft proof verify <file-or-digest> / graft proof export <digest>.
// The exit status is about integrity only; an intact proof of a FAILED verification exits 0.
// ---------------------------------------------------------------------------------------------
test('graft proof verify: file mode and stored-digest mode, integrity apart from the recorded verdict, exit codes about integrity only, --json, export as an exact copy', async (t) => {
  const { work, home, run } = sandbox(t);
  const { envelopeFor, decidedReport, httpResult } = await import('../../core/test/helpers/proof.js');
  const previous = process.env.GRAFT_HOME; process.env.GRAFT_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.GRAFT_HOME; else process.env.GRAFT_HOME = previous; });
  const { storeProof, proofFileName, proofArtifactPath } = await import('../../core/src/laboratory/proof-store.js');
  const R = 'a'.repeat(40);
  const verified = envelopeFor({ revision: R, capability: { slug: 'hosted-authentication' } });
  const failed = envelopeFor({ revision: R, capability: { slug: 'hosted-authentication' }, report: decidedReport([httpResult('a'), httpResult('b', 'failed')]) });
  storeProof(verified); storeProof(failed);
  const file = path.join(work, 'graft-proof.json'); fs.writeFileSync(file, JSON.stringify(verified, null, 2));

  // File mode: intact, human-readable, the three facts kept apart, exit 0.
  const ok = run(['proof', 'verify', file]);
  assert.match(ok.stdout, /Integrity\s+INTACT/); assert.match(ok.stdout, /Recorded GRAFT verdict\s+VERIFIED/); assert.match(ok.stdout, /Recorded kernel verdict\s+PASS/);
  assert.match(ok.stdout, new RegExp(`Destination revision\\s+${R}`)); assert.match(ok.stdout, /Capability\s+hosted-authentication/); assert.match(ok.stdout, /tamper-evident/i);
  assert.doesNotMatch(ok.stdout.replace('not signed', ''), /signed|attested|trusted|tamper-proof|\bVALID\b/i, 'no signing or attestation language'); assert.doesNotMatch(ok.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // An intact proof of a FAILED verification: integrity success, exit 0, verdict shown as recorded.
  const failedFile = path.join(work, 'failed.json'); fs.writeFileSync(failedFile, JSON.stringify(failed));
  const intactFailed = run(['proof', 'verify', failedFile]);
  assert.match(intactFailed.stdout, /Integrity\s+INTACT/); assert.match(intactFailed.stdout, /Recorded GRAFT verdict\s+FAILED/);
  // Tampered copy (one authoritative field): exit 1, reason printed, claim still shown as what the file says.
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8')); tampered.payload.destination.revision = 'b'.repeat(40);
  const tamperedFile = path.join(work, 'tampered.json'); fs.writeFileSync(tamperedFile, JSON.stringify(tampered));
  const bad = run(['proof', 'verify', tamperedFile], 1);
  assert.match(bad.stdout, /Integrity\s+NOT INTACT/); assert.match(bad.stdout, /payload does not re-derive to the digest/);
  // Malformed and missing files: exit 1, structured reason.
  fs.writeFileSync(path.join(work, 'broken.json'), '{ not json');
  assert.match(run(['proof', 'verify', path.join(work, 'broken.json')], 1).stdout, /not valid JSON/);
  assert.match(run(['proof', 'verify', path.join(work, 'absent.json')], 1).stdout, /Integrity\s+MISSING/);
  // --json separates integrity from claim.
  const j = JSON.parse(run(['proof', 'verify', file, '--json']).stdout);
  assert.deepEqual(Object.keys(j).sort(), ['claim', 'integrity']);
  assert.deepEqual([j.integrity.status, j.integrity.intact, j.integrity.source, j.integrity.digest], ['INTACT', true, 'file', verified.digest]);
  assert.deepEqual([j.claim.graftVerdict, j.claim.kernelVerdict, j.claim.destinationRevision], ['VERIFIED', 'PASS', R]);
  const jf = JSON.parse(run(['proof', 'verify', failedFile, '--json']).stdout); assert.equal(jf.integrity.intact, true); assert.equal(jf.claim.graftVerdict, 'FAILED');
  const jb = JSON.parse(run(['proof', 'verify', tamperedFile, '--json'], 1).stdout); assert.equal(jb.integrity.intact, false); assert.equal(jb.claim.destinationRevision, 'b'.repeat(40));
  // Digest mode resolves through the local proof store; both digest spellings; unknown digest exits 1.
  const stored = run(['proof', 'verify', `sha256:${verified.digest}`]);
  assert.match(stored.stdout, /Integrity\s+INTACT/); assert.equal(JSON.parse(run(['proof', 'verify', verified.digest, '--json']).stdout).integrity.source, 'proof-store');
  assert.match(run(['proof', 'verify', `sha256:${'0'.repeat(64)}`], 1).stdout, /Integrity\s+MISSING/);
  // A damaged stored artifact: exit 1 with the store's reasons.
  const storedFile = proofArtifactPath(failed.digest);
  fs.writeFileSync(storedFile, fs.readFileSync(storedFile, 'utf8').replace('"FAILED"', '"VERIFIED"'));
  assert.match(run(['proof', 'verify', failed.digest], 1).stdout, /NOT INTACT[\s\S]*payload does not re-derive/);
  // Export: an exact byte copy of the stored artifact, named by digest, verifiable on its own.
  const out = path.join(work, 'out'); fs.mkdirSync(out);
  const exported = run(['proof', 'export', `sha256:${verified.digest}`, '--out', out]);
  assert.match(exported.stdout, /exported graft-proof-[0-9a-f]{64}\.json/);
  const copy = path.join(out, proofFileName(verified.digest));
  assert.equal(Buffer.compare(fs.readFileSync(copy), fs.readFileSync(proofArtifactPath(verified.digest))), 0, 'byte-identical to the stored artifact');
  assert.match(run(['proof', 'verify', copy]).stdout, /Integrity\s+INTACT/);
  assert.match(run(['proof', 'export', failed.digest, '--out', out], 1).stderr, /does not verify/);
  assert.match(run(['proof', 'export', file, '--out', out], 1).stderr, /takes a stored proof digest/);
  assert.match(run(['proof', 'verify'], 1).stderr, /usage: graft proof/);
  run(['proof', 'verify', file, '--bogus'], 1);
});
