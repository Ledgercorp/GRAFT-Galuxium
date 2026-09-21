'use strict';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({ _raw: raw }); }
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function json(res, status, payload, headers) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers || {}));
  res.end(JSON.stringify(payload));
}

class Router {
  constructor() { this.routes = []; }
  add(method, path, handler) { this.routes.push({ method, path, handler }); }
  match(method, pathname) {
    return this.routes.find((r) => r.method === method && r.path === pathname) || null;
  }
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const route = this.match(req.method, url.pathname);
    if (!route) return json(res, 404, { error: 'not_found' });
    try {
      req.body = await readBody(req);
      req.cookies = parseCookies(req);
      req.query = url.searchParams;
      await route.handler(req, res);
    } catch (err) {
      json(res, 500, { error: 'internal_error', message: String(err && err.message) });
    }
  }
}

module.exports = { Router, json, readBody, parseCookies };
