'use strict';
const crypto = require('node:crypto');
const { json } = require('../lib/router');

const files = new Map();

function register(router) {
  router.add('POST', '/uploads', (req, res) => {
    const { filename, content } = req.body || {};
    if (!filename) return json(res, 400, { error: 'filename_required' });
    const id = crypto.randomUUID();
    files.set(id, { id, filename, size: String(content || '').length, uploadedAt: new Date().toISOString() });
    return json(res, 201, { file: files.get(id) });
  });

  router.add('GET', '/uploads', (req, res) => json(res, 200, { files: [...files.values()] }));
}

module.exports = register;
