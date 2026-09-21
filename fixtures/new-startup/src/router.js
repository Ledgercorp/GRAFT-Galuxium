function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ _raw: raw }); }
    });
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class App {
  constructor() { this.handlers = []; }
  get(path, handler) { this.handlers.push({ method: 'GET', path, handler }); }
  post(path, handler) { this.handlers.push({ method: 'POST', path, handler }); }
  find(method, path) { return this.handlers.find((h) => h.method === method && h.path === path) || null; }

  async dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const handler = this.find(req.method, url.pathname);
    if (!handler) return this.#send(res, { status: 404, body: { error: 'not_found' } });
    const ctx = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      body: await readBody(req),
      cookies: parseCookies(req.headers.cookie),
      headers: req.headers,
    };
    try {
      const result = await handler.handler(ctx);
      return this.#send(res, result || { status: 204, body: null });
    } catch (err) {
      return this.#send(res, { status: 500, body: { error: 'internal_error', message: String(err?.message) } });
    }
  }

  #send(res, { status = 200, body = null, headers = {} }) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === null ? '' : JSON.stringify(body));
  }
}
