'use strict';
const http = require('node:http');
const { Router } = require('./lib/router');
const registerFlagRoutes = require('./routes/flags');

const router = new Router();
registerFlagRoutes(router);

const server = http.createServer((req, res) => router.handle(req, res));

if (require.main === module) {
  const port = Number(process.env.PORT || 3100);
  server.listen(port, () => console.log(`config-service listening on ${port}`));
}

module.exports = { server, router };
