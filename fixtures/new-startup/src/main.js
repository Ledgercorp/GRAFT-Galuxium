import http from 'node:http';
import { App } from './router.js';
import { registerHealthRoutes } from './routes/health.js';

export const app = new App();

registerHealthRoutes(app);
app.post('/auth/login', async () => ({ status: 501, body: { error: 'auth_not_implemented' } }));

export const server = http.createServer((req, res) => app.dispatch(req, res));

if (process.argv[1] && process.argv[1].endsWith('main.js')) {
  const port = Number(process.env.PORT || 4000);
  server.listen(port, () => console.log(`new-startup listening on ${port}`));
}
