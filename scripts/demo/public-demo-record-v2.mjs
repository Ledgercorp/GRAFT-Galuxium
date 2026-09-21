// Continuous public GRAFT demo recording (v2): one uninterrupted screen recording of the real packaged
// fixture app while the validated demo drives it (scripts/desktop/real-demo.mjs, DevTools automation).
// The capture region is the app window's own bounds, read from the renderer — nothing else on the
// desktop is recorded. The finalized application is shown in a plain browser window placed over the
// same region (scripts/demo/result-viewer.cjs). The edit only trims waiting time between real actions
// and adds an opening/closing card and short captions; no still images, no simulated cursor.
//
//   node scripts/demo/public-demo-record-v2.mjs            record + cut docs/demo/GRAFT-demo-v2.mp4
//   node scripts/demo/public-demo-record-v2.mjs --cut-only cut again from the last recording
//
// Needs: ffmpeg, the fixture desktop build, Screen Recording permission for the terminal, and a desk
// that is left alone for ~4 minutes (the app must stay frontmost). Do not run this from a terminal that
// overlaps the app window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setup, SOURCES, NEW_SOFTWARE, DEMO_HOME } from './public-demo-setup.mjs';

const OUT_DIR = path.resolve('docs/demo');
const WORK = path.join(os.homedir(), '.graft-demo', 'public-demo-recording-v2');
const RAW = path.join(WORK, 'raw.mov');
const BOUNDS = path.join(WORK, 'bounds.json');
const TIMING = path.join(WORK, 'timing.json');
const HOLD = path.join(WORK, 'capture-ended');
// screencapture's -V length is not exact (it stopped ~15% early here), so it is set well past the demo;
// the app holds its last scene until the capture ends, and the cut discards the surplus.
const CAPTURE_SECONDS = Number(process.env.GRAFT_DEMO_CAPTURE_SECONDS || 150);
const FINAL = path.join(OUT_DIR, 'GRAFT-demo-v2.mp4');
const PACE_MS = Number(process.env.GRAFT_DEMO_PACE_MS || 3500);
const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_REGULAR = '/System/Library/Fonts/Supplemental/Arial.ttf';
const cutOnly = process.argv.includes('--cut-only');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(OUT_DIR, { recursive: true });

if (!cutOnly) {
  console.log(JSON.stringify(setup({ reset: true })));
  for (const f of [RAW, BOUNDS, TIMING, HOLD, path.join(WORK, 'viewer-pages.json')]) fs.rmSync(f, { force: true });
  const env = { ...process.env, GRAFT_DEMO_HOME: DEMO_HOME, GRAFT_DEMO_PACE_MS: String(PACE_MS), GRAFT_DEMO_BOUNDS_FILE: BOUNDS, GRAFT_DEMO_HOLD_FILE: HOLD, GRAFT_DEMO_RESULT_VIEWER: path.resolve('scripts/demo/result-viewer.cjs'),
    GRAFT_DEMO_COMPOSE_NAME: 'Client portal', GRAFT_DEMO_ASSEMBLE_NAME: 'Client portal', GRAFT_DEMO_COMPOSE_TEXT: 'People sign in, and features can be turned on for some of them.' };
  delete env.GRAFT_DEMO_SHOW_RESULT;
  const log = fs.openSync(path.join(WORK, 'driver.log'), 'w');
  const driver = spawn(process.execPath, ['scripts/desktop/real-demo.mjs', '--workspace', SOURCES, '--source', 'cuf', '--second-source', path.join(SOURCES, 'swiveljs'), '--assemble', NEW_SOFTWARE, '--compose', '--finalize', '--session', 'public-demo'], { env, stdio: ['ignore', log, log] });
  const exited = new Promise((r) => driver.once('exit', r));
  // Wait for the driver to publish the real window bounds, then record exactly that region.
  const t0 = Date.now();
  while (!fs.existsSync(BOUNDS)) { if (Date.now() - t0 > 120000) { driver.kill(); throw new Error('driver never published window bounds'); } await sleep(100); }
  const b = JSON.parse(fs.readFileSync(BOUNDS, 'utf8'));
  // screencapture cannot be stopped early from a child process (a signal discards the file), so the
  // capture runs for a fixed length and the driver holds the app on its last scene until it ends.
  const rec = spawn('/usr/sbin/screencapture', ['-v', '-x', '-V', String(CAPTURE_SECONDS), '-R', `${b.x},${b.y},${b.w},${b.h}`, RAW], { stdio: 'ignore' });
  const captureStartedAt = new Date().toISOString();
  await new Promise((r) => rec.once('exit', r));
  fs.writeFileSync(HOLD, captureStartedAt);
  const code = await exited;
  fs.writeFileSync(TIMING, JSON.stringify({ captureStartedAt, bounds: b, driverExit: code }, null, 2));
  if (code !== 0) { console.error(`driver exited ${code}; see ${path.join(WORK, 'driver.log')}`); process.exit(code); }
}

const timing = JSON.parse(fs.readFileSync(TIMING, 'utf8'));
const evidence = JSON.parse(fs.readFileSync(path.join(DEMO_HOME, 'evidence.json'), 'utf8'));
const start = Date.parse(timing.captureStartedAt) + Number(process.env.GRAFT_DEMO_CAPTURE_LATENCY_MS || 400);
const at = (name, nth = 0) => { const s = evidence.steps.filter((x) => x.name === name)[nth]; if (!s) throw new Error(`no step ${name}#${nth}`); return (Date.parse(s.at) - start) / 1000; };
if (process.argv.includes('--timeline')) { console.log(evidence.steps.map((s) => `${((Date.parse(s.at) - start) / 1000).toFixed(1).padStart(7)}  ${s.name}`).join('\n')); process.exit(0); }

// ---- The cut: trims between real actions only. Everything shown is the continuous recording. ----
// The capture is variable-frame-rate (only changed frames are stored) and keeps going after the demo's
// last scene, so it is first rendered once to a constant 30 fps intermediate covering the demo.
const CFR = path.join(WORK, 'raw-cfr.mp4');
const demoEnd = at('scene-ending') + 3.2;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', RAW, '-t', String(demoEnd.toFixed(2)), '-vf', 'fps=30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', CFR]);
// The app window on the frame: whole window, 85% of the frame height, centred, captions under it.
const H = 950, GROUND = '0xe7eae2';
const layout = `scale=-2:${H}:flags=lanczos,pad=1920:1080:(ow-iw)/2:28:color=${GROUND}`;
const esc = (t) => t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const caption = (text, from, to) => `drawtext=fontfile='${FONT_REGULAR}':text='${esc(text)}':fontsize=36:fontcolor=0x254c3c:x=(w-text_w)/2:y=1010:enable='between(t,${from.toFixed(2)},${to.toFixed(2)})'`;
const v = (name, nth = 0) => at(name, nth);
// [from, to, captions[[from, to, text]]] in recording seconds. Segments 1–5 are contiguous (no cut
// between them); the finalized-application pages are each trimmed to a short look; then the return.
const viewer = v('scene-result-viewer');
const pages = JSON.parse(fs.readFileSync(path.join(WORK, 'viewer-pages.json'), 'utf8')).map((p) => (Date.parse(p.loadedAt) - start) / 1000);
if (pages.length !== 3) throw new Error(`expected 3 result pages, got ${pages.length}`);
const look = (i, text) => [pages[i] + 0.4, pages[i] + 2.9, [[pages[i] + 0.4, pages[i] + 2.9, text]]];
const segments = [
  [1.0, v('search', 0), [[1.0, v('workspace-authorized') - 0.3, 'Point GRAFT at software you already built.'], [v('workspace-authorized') - 0.3, v('search', 0), 'It indexes what you wrote and remembers the capabilities.']]],
  [v('search', 0), v('search', 1), [[v('search', 0), v('@leftsock/cuf'), 'Find an existing capability: hosted sign-in.'], [v('@leftsock/cuf'), v('job-result-shown', 1), 'Harvest it — GRAFT runs the source’s own acceptance tests.'], [v('job-result-shown', 1), v('search', 1), 'Verified where it came from.']]],
  [v('search', 1), v('compose-blueprint-created'), [[v('search', 1), v('swiveljs'), 'Feature flags — also yours, also found.'], [v('swiveljs'), v('job-result-shown', 2), 'Harvest it.'], [v('job-result-shown', 2), v('compose-blueprint-created'), 'Verified where it came from.']]],
  [v('compose-blueprint-created'), v('compose-assembled'), [[v('compose-blueprint-created'), v('compose-assemble-confirmation'), 'Fit it: a new client portal that needs both.'], [v('compose-assemble-confirmation'), v('scene-progress'), 'Assemble — exactly what will be done, in an isolated candidate.'], [v('scene-progress'), v('compose-assembled'), 'Real verification runs: each capability against its own contract.']]],
  [v('compose-assembled'), viewer, [[v('compose-assembled'), v('compose-evidence-page'), 'Every stage verified.'], [v('compose-evidence-page'), v('scene-ledger'), 'COMPOSITION VERIFIED — both capabilities, one revision. What was proven, per capability.'], [v('scene-ledger'), v('compose-ledger-page'), 'Prove it: CURRENT at one revision, proof integrity INTACT — tamper-evident, exportable.'], [v('compose-ledger-page'), viewer, 'Finalize: point your project at the verified revision.']]],
  look(0, 'The finalized client portal, running on its own: no session yet → refused.'),
  look(1, 'Sign in through the identity-provider stand-in → back to the application.'),
  look(2, 'Session established — the transplanted capability works.'),
  [v('scene-result-viewer-done') + 0.1, demoEnd, [[v('scene-result-viewer-done') + 0.1, demoEnd, 'Find it. Fit it. Prove it.']]],
];
const card = (file, lines, seconds) => {
  const draw = lines.map(([text, size, y, color]) => `drawtext=fontfile='${FONT}':text='${esc(text)}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`).join(',');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${GROUND}:s=1920x1080:d=${seconds}:r=30`, '-vf', `${draw},fade=t=in:st=0:d=0.3,fade=t=out:st=${seconds - 0.3}:d=0.3`, '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', file]);
};
const parts = [];
card(path.join(WORK, 'card-open.mp4'), [['YOU ALREADY BUILT IT.', 104, 470, '0x254c3c']], 2);
parts.push(path.join(WORK, 'card-open.mp4'));
segments.forEach(([from, to, caps], i) => {
  const file = path.join(WORK, `seg-${String(i + 1).padStart(2, '0')}.mp4`);
  const draw = caps.map(([a, b, text]) => caption(text, a - from, b - from)).join(',');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', from.toFixed(3), '-to', to.toFixed(3), '-i', CFR, '-vf', `${layout},${draw}`, '-r', '30', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', file]);
  parts.push(file);
});
card(path.join(WORK, 'card-end.mp4'), [['YOU ALREADY BUILT IT.', 96, 380, '0x254c3c'], ['Your software remembers.', 52, 540, '0x254c3c'], ['Find it. Fit it. Prove it.', 44, 640, '0x5b665e']], 3);
parts.push(path.join(WORK, 'card-end.mp4'));
fs.writeFileSync(path.join(WORK, 'concat.txt'), parts.map((p) => `file '${p}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'concat.txt'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', FINAL]);
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,r_frame_rate:format=duration', '-of', 'json', FINAL], { encoding: 'utf8' }));
console.log(JSON.stringify({ video: FINAL, seconds: Number(probe.format.duration).toFixed(1), stream: probe.streams[0], segments: segments.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}`), raw: RAW }, null, 1));
