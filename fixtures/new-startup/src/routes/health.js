export function registerHealthRoutes(app) {
  app.get('/health', async () => ({ status: 200, body: { ok: true, service: 'new-startup' } }));
}
