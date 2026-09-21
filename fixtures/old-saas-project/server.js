'use strict';
const http = require('node:http');
const { Router } = require('./lib/router');
const registerAuthRoutes = require('./routes/auth');
const registerUploadRoutes = require('./routes/uploads');

const router = new Router();
registerAuthRoutes(router);
registerUploadRoutes(router);

const server = http.createServer((req, res) => router.handle(req, res));

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`old-saas-project listening on ${port}`));
}

module.exports = { server, router };
