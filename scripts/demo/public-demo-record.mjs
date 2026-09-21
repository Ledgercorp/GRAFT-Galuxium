// Produces the public GRAFT demo video from the product itself: the packaged fixture app is driven
// through the real workflow on the isolated demo fixtures (scripts/demo/public-demo-setup.mjs), the
// harness captures the app's own page at each scene (in-app captures — never the desktop, never
// another window), and ffmpeg assembles those frames into a 1080p 16:9 video with captions and the
// opening/closing cards. Every frame is the real product state at that moment; nothing is staged.
//
//   node scripts/demo/public-demo-record.mjs             run the demo + assemble docs/demo/GRAFT-demo.mp4
//   node scripts/demo/public-demo-record.mjs --cut-only  re-assemble from the last run's frames
//
// Needs: ffmpeg; the fixture desktop build (`npm run desktop:package -- --fixture`); optionally a
// chrome-headless-shell for the "working result" scene (GRAFT_DEMO_BROWSER, auto-detected from the
// Playwright cache). Wall clock ≈ 3 minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setup, SOURCES, NEW_SOFTWARE, DEMO_HOME } from './public-demo-setup.mjs';

const OUT_DIR = path.resolve('docs/demo');
const WORK = path.join(os.homedir(), '.graft-demo', 'public-demo-recording');
const FRAMES = path.join(WORK, 'evidence');
const FINAL = path.join(OUT_DIR, 'GRAFT-demo.mp4');
const PACE_MS = Number(process.env.GRAFT_DEMO_PACE_MS || 1500);
const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const FONT_REGULAR = '/System/Library/Fonts/Supplemental/Arial.ttf';
const cutOnly = process.argv.includes('--cut-only');
const browser = process.env.GRAFT_DEMO_BROWSER || [path.join(os.homedir(), 'Library/Caches/ms-playwright'), ...[]].flatMap((dir) => { try { return fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell')).map((d) => path.join(dir, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')); } catch { return []; } }).find((p) => fs.existsSync(p)) || '';
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(OUT_DIR, { recursive: true });

if (!cutOnly) {
  console.log(JSON.stringify(setup({ reset: true })));
  fs.rmSync(FRAMES, { recursive: true, force: true });
  const env = { ...process.env, GRAFT_DEMO_HOME: DEMO_HOME, GRAFT_DEMO_EVIDENCE_DIR: FRAMES, GRAFT_DEMO_PACE_MS: String(PACE_MS), GRAFT_DEMO_SHOW_RESULT: '1', GRAFT_DEMO_BROWSER: browser,
    GRAFT_DEMO_COMPOSE_NAME: 'Client portal', GRAFT_DEMO_ASSEMBLE_NAME: 'Client portal', GRAFT_DEMO_COMPOSE_TEXT: 'People sign in, and features can be turned on for some of them.' };
  const log = fs.openSync(path.join(WORK, 'driver.log'), 'w');
  const driver = spawn(process.execPath, ['scripts/desktop/real-demo.mjs', '--workspace', SOURCES, '--source', 'cuf', '--second-source', path.join(SOURCES, 'swiveljs'), '--assemble', NEW_SOFTWARE, '--compose', '--finalize', '--session', 'public-demo'], { env, stdio: ['ignore', log, log] });
  const code = await new Promise((r) => driver.once('exit', r));
  if (code !== 0) { console.error(`driver exited ${code}; see ${path.join(WORK, 'driver.log')}`); process.exit(code); }
}

// Scenes: a frame the product produced, a caption, and how long the viewer sees it.
const frame = (suffix) => { const f = fs.readdirSync(FRAMES).filter((n) => n.endsWith(`-${suffix}.png`)).sort(); return f.length ? path.join(FRAMES, f[0]) : null; };
const frameNth = (suffix, nth) => { const f = fs.readdirSync(FRAMES).filter((n) => n.endsWith(`-${suffix}.png`)).sort(); return f[nth] ? path.join(FRAMES, f[nth]) : null; };
const scenes = [
  [frame('scene-opening'), 'Your software remembers — point GRAFT at software you already built', 4],
  [frame('search-results'), 'Find it — capability memory, not files: hosted sign-in, found in your own code', 6],
  [frameNth('scene-harvested', 0), 'Verified where it came from — 13 / 13 required cases', 5],
  [frameNth('search-results', 1), 'Feature flags — also yours, also found', 4],
  [frameNth('scene-harvested', 1), 'Verified where it came from — 8 / 8', 4],
  [frame('compose-blueprint'), 'A new application that needs both', 5],
  [frame('scene-fit'), 'Fit it — GRAFT decides whether each implementation fits this host before touching it', 6],
  [frame('compose-assemble-confirmation'), 'Assemble — exactly what will be done, in an isolated candidate', 5],
  [frame('compose-progress'), 'Real verification runs: each capability against its own contract', 6],
  [frame('compose-result'), 'COMPOSITION VERIFIED — both capabilities, one revision', 6],
  [frame('compose-auth-evidence'), 'Prove it — evidence, not assertion: 13 / 13 again on the combined application', 6],
  [frame('scene-ledger'), 'CURRENT at one revision · proof integrity INTACT (tamper-evident, revision-bound)', 6],
  [frame('compose-finalized'), 'Finalized — your project now points at the verified revision', 4],
  [frame('scene-result-anonymous'), 'The result, in a browser: GET /api/session before sign-in → 401 (anonymous refused)', 3, 'crop'],
  [frame('scene-result-sign-in'), 'GET /auth/login → the identity-provider stand-in → back to the application', 3, 'crop'],
  [frame('scene-result-session'), 'GET /api/session after sign-in → the session — the transplanted capability works', 4, 'crop'],
  ['MEASURED', 'What the finalized application actually answered, and what the flags actually did', 5],
  [frame('scene-ending'), 'Find it. Fit it. Prove it.', 4],
].filter(([f]) => f);
// The measured-results card: values read from the run's own evidence, never typed in.
const evidence = JSON.parse(fs.readFileSync(path.join(DEMO_HOME, 'evidence.json'), 'utf8'));
const st = evidence.composeStandalone || {}; const flags = evidence.steps.find((x) => x.name === 'compose-finalized-flags-run') || {};
const measuredLines = [
  ['Finalized application, run on its own (real HTTP responses)', 40, 120, '0x254c3c'],
  [`GET /            ${st.root}     GET /health     ${st.health}     GET /no-such-route     ${st.unknown}`, 34, 220, '0x1f2a24'],
  [`GET /api/session (anonymous)   ${st.anonymousSession}`, 34, 290, '0x1f2a24'],
  [`GET /auth/login   ${st.login} → identity-provider stand-in (no external provider contacted)`, 34, 360, '0x1f2a24'],
  ['Feature flags, evaluated in the finalized application', 40, 500, '0x254c3c'],
  [`enabled → ${flags.enabled}     disabled → ${flags.disabled}     unknown → ${flags.unknown}`, 34, 600, '0x1f2a24'],
  [`choose(on/off) → ${JSON.stringify(flags.chooseOn)} / ${JSON.stringify(flags.chooseOff)}     branch → ${flags.branchOn} / ${flags.branchOff}     repeated → ${JSON.stringify(flags.repeated)}`, 30, 670, '0x1f2a24'],
  ['Verified by each capability’s own contract · bound to one revision · tamper-evident proof, not a signature', 28, 860, '0x747d73'],
];

const esc = (t) => t.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/%/g, '\\%');
const card = (file, lines, seconds) => {
  const draw = lines.map(([text, size, y, color]) => `drawtext=fontfile='${FONT}':text='${esc(text)}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`).join(',');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0xf6f7f3:s=1920x1080:d=${seconds}:r=30`, '-vf', draw, '-pix_fmt', 'yuv420p', file]);
};
const parts = [];
card(path.join(WORK, 'card-open.mp4'), [['YOU ALREADY BUILT IT.', 96, 420, '0x254c3c'], ['GRAFT · private capability memory and verified software reuse', 36, 560, '0x747d73']], 3.5);
parts.push(path.join(WORK, 'card-open.mp4'));
scenes.forEach(([image, caption, seconds, mode], i) => {
  const file = path.join(WORK, `scene-${String(i + 1).padStart(2, '0')}.mp4`);
  const bar = `drawbox=x=0:y=ih-84:w=iw:h=84:color=0x254c3c@0.94:t=fill,drawtext=fontfile='${FONT_REGULAR}':text='${esc(caption)}':fontsize=34:fontcolor=0xe0f39c:x=48:y=h-58`;
  if (image === 'MEASURED') {
    const draw = measuredLines.map(([text, size, y, color]) => `drawtext=fontfile='${FONT_REGULAR}':text='${esc(text)}':fontsize=${size}:fontcolor=${color}:x=120:y=${y}`).join(',');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0xf6f7f3:s=1920x1080:d=${seconds}:r=30`, '-vf', `${draw},${bar}`, '-pix_fmt', 'yuv420p', file]);
    parts.push(file); return;
  }
  // A browser frame is mostly empty page: show its top-left, legibly. Everything else: the whole frame on the brand ground.
  const fit = mode === 'crop' ? 'crop=1440:810:0:0,scale=1920:1080:flags=lanczos' : 'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0xf6f7f3';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-t', String(seconds), '-i', image, '-vf', `${fit},${bar}`, '-r', '30', '-an', '-pix_fmt', 'yuv420p', file]);
  parts.push(file);
});
card(path.join(WORK, 'card-end.mp4'), [['YOU ALREADY BUILT IT.', 96, 360, '0x254c3c'], ['Your software remembers.', 48, 520, '0x254c3c'], ['Find it. Fit it. Prove it.', 40, 610, '0x747d73'], ['GRAFT · leftsocklabs.com', 30, 760, '0x747d73']], 4);
parts.push(path.join(WORK, 'card-end.mp4'));
fs.writeFileSync(path.join(WORK, 'concat.txt'), parts.map((p) => `file '${p}'`).join('\n'));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'concat.txt'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', FINAL]);
const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', FINAL], { encoding: 'utf8' }));
console.log(JSON.stringify({ video: FINAL, frames: scenes.length, seconds: Number(probe.format.duration).toFixed(1), size: probe.streams[0], scenes: scenes.map(([f, c, s]) => ({ frame: path.basename(f), caption: c, seconds: s })) }, null, 1));
