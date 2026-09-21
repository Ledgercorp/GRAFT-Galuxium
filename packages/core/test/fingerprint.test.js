import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprintProject, startScriptFor, reachableProductionFiles } from '../src/analyze/fingerprint.js';
import { isProductionPath, NON_PRODUCTION_PATH } from '../src/analyze/production-paths.js';
import { detectProject } from '../src/workspace/detect.js';

const write = (root, files) => { for (const [file, contents] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), contents); } return root; };
const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-fp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const EXPRESS_APP = `import express from 'express';\nconst app = express();\napp.use(express.json());\napp.get('/health', (req, res) => res.json({ ok: true }));\napp.listen(process.env.PORT);\n`;
const HTTP_APP = `import { createServer } from 'node:http';\ncreateServer(async (req, res) => { res.writeHead(200); res.end('ok'); }).listen(process.env.PORT);\n`;

test('the production-path policy is one policy, shared by the detector and the fingerprint', () => {
  for (const p of ['bench/fixtures/x/main.js', 'fixtures/app/server.js', 'test/a.js', 'tests/a.js', 'src/__tests__/a.js', 'coverage/lcov.js', 'src/a.test.js', 'src/a.spec.ts', 'spec/a.js']) assert.equal(isProductionPath(p), false, p);
  for (const p of ['src/main.js', 'app/server.js', 'packages/web/src/server.js', 'src/testing-helpers.js', 'src/contest/index.js']) assert.equal(isProductionPath(p), true, p);
  assert.ok(NON_PRODUCTION_PATH instanceof RegExp);
});

test('an Express fixture under bench/ does not make the parent node:http application Express', (t) => {
  const root = write(tmp(t), {
    'package.json': JSON.stringify({ name: 'parent', type: 'module', scripts: { start: 'node src/server.js' }, devDependencies: { express: '5.2.1' } }),
    'src/server.js': HTTP_APP,
    'bench/fixtures/express-mounted-router/main.js': EXPRESS_APP + "app.get('/bench', (req, res) => res.status(200).send('x'));\n",
    'fixtures/express-app/src/main.js': EXPRESS_APP,
    'test/express.test.js': "import express from 'express'; const app = express(); app.get('/t', (req, res) => res.json({}));\n",
  });
  const fp = fingerprintProject(root);
  assert.equal(fp.entrypoint, 'src/server.js');
  assert.equal(fp.framework.value, 'node-http', fp.framework.evidence);
  assert.equal(fp.handlerContract.value, 'node-res', JSON.stringify(fp.handlerContract));
  assert.equal(fp.central?.supported, true);
  assert.equal(fp.express, undefined, 'no Express inspection for a non-Express server');
  assert.deepEqual(fp.routes.map((r) => r.file), [], 'routes from bench, fixtures and tests are not the application\'s');
  // The workspace detector agrees, with the same exclusion policy.
  const detected = detectProject(root);
  assert.equal(detected.framework, 'node-http');
  assert.equal(detected.routes.some((r) => /bench|fixtures|test/.test(r.file)), false);
});

test('a real Express production entrypoint classifies as Express with the express-req-res contract', (t) => {
  const root = write(tmp(t), {
    'package.json': JSON.stringify({ name: 'real', type: 'module', scripts: { start: 'node app/server' }, dependencies: { express: '^5.0.0' } }),
    'app/server.js': "import express from 'express';\nimport { AuthorController } from './controllers/index.js';\nexport const app = express();\napp.use(express.json());\napp.get('/', (req, res) => res.json({ ok: true }));\napp.use('/author', AuthorController);\napp.use((req, res) => res.status(404).json({ message: 'No route found' }));\nexport const server = app.listen(process.env.PORT || 3000);\n",
    'app/controllers/index.js': "export { AuthorController } from './author.controller.js';\n",
    'app/controllers/author.controller.js': "import { Router } from 'express';\nconst router = Router();\nrouter.get('/', (req, res) => res.json([]));\nrouter.get('/:id', (req, res) => res.status(404).json({}));\nexport const AuthorController = router;\n",
    'app/controllers/author.controller.spec.js': "import { createServer } from 'node:http'; createServer((req, res) => res.end());\n",
  });
  assert.deepEqual(startScriptFor({ scripts: { start: 'node app/server' } }), { name: 'start', file: 'app/server', command: 'node app/server' });
  const fp = fingerprintProject(root);
  assert.equal(fp.entrypoint, 'app/server.js', 'an extensionless start script resolves to the file Node would run');
  assert.equal(fp.framework.value, 'express');
  assert.equal(fp.framework.version, '^5.0.0');
  assert.match(fp.framework.evidence, /imported by app\/server\.js/);
  assert.equal(fp.handlerContract.value, 'express-req-res');
  assert.ok(fp.express, 'an Express server is inspected');
  assert.deepEqual(reachableProductionFiles(fp.files, fp.readFile, fp.entrypoint), ['app/server.js', 'app/controllers/index.js', 'app/controllers/author.controller.js']);
  assert.equal(fp.routes.some((r) => r.file.endsWith('.spec.js')), false);
});

test('a bare node:http production entrypoint stays node:http even when Express is used elsewhere in the repository', (t) => {
  const root = write(tmp(t), {
    'package.json': JSON.stringify({ name: 'mixed', type: 'module', scripts: { start: 'node server.mjs' }, dependencies: { express: '5.2.1' } }),
    'server.mjs': HTTP_APP,
    'tools/admin.js': EXPRESS_APP,
    'src/emit/template.js': "export const template = `import express from 'express';\\nconst app = express();`;\n",
  });
  const fp = fingerprintProject(root);
  assert.equal(fp.framework.value, 'node-http', fp.framework.evidence);
  assert.match(fp.framework.evidence, /server\.mjs/);
  assert.equal(fp.handlerContract.value, 'node-res');
  // A dependency alone proves nothing: with no production import of any framework, the answer is honest.
  const bare = write(tmp(t), { 'package.json': JSON.stringify({ name: 'bare', type: 'module', dependencies: { express: '5.2.1' } }), 'src/lib.js': 'export const x = 1;\n' });
  assert.equal(fingerprintProject(bare).framework.value, 'unknown');
});

test('the handler contract follows the production server shape, not test handlers', (t) => {
  const root = write(tmp(t), {
    'package.json': JSON.stringify({ name: 'rr', type: 'module', scripts: { start: 'node src/main.js' } }),
    'src/main.js': "import { createServer } from 'node:http';\nimport { handle } from './handler.js';\ncreateServer((req, res) => { const r = handle(req); res.writeHead(r.status); res.end(r.body); }).listen(process.env.PORT);\n",
    'src/handler.js': "import { notFound } from './errors.js';\nexport function handle(req) { if (req.url === '/') return { status: 200, body: 'ok' }; return notFound(); }\n",
    'src/errors.js': "export const notFound = () => ({ status: 404, body: '' });\n",
    'tests/handler.test.js': "res.writeHead(200); res.end(); res.writeHead(200); res.end(); res.writeHead(200); res.end();\n",
    'bench/x.js': "res.writeHead(200); res.end(); res.writeHead(200); res.end();\n",
  });
  const fp = fingerprintProject(root);
  assert.equal(fp.handlerContract.value, 'return-response', JSON.stringify(fp.handlerContract));
  assert.ok(fp.handlerContract.evidence.every((e) => !/tests\/|bench\//.test(e)));
});
