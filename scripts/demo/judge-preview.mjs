// Preview only the public allowlist; never mount the repository or local workspace server.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
export const publicFiles = {
  'index.html': 'text/html', 'docs.html': 'text/html', 'style.css': 'text/css',
  'app.js': 'text/javascript', 'evidence.js': 'text/javascript',
  'evidence.json': 'application/json', 'brand-icon.png': 'image/png',
};
export function previewServer() {
  return http.createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || !Object.hasOwn(publicFiles, name)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', publicFiles[name]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try { const data = fs.readFileSync(new URL(`../../packages/web/judge/${name}`, import.meta.url)); res.end(req.method === 'HEAD' ? undefined : data); }
    catch { res.writeHead(404); res.end(); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  previewServer().listen(4173, '127.0.0.1', () => console.log('GRAFT judge preview: http://127.0.0.1:4173'));
}
