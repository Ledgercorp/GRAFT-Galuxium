import express from 'express';

const app = express();

// Ordinary application middleware must continue to run after a transplant.
app.use((req, res, next) => {
  res.set('x-destination', 'express-app');
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, framework: 'express' });
});

// This deliberately spans several lines: replacing just its first line is unsafe.
app.post(
  '/auth/login',
  (req, res) => {
    res.status(501).json({ error: 'auth_not_implemented' });
  },
);

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, '127.0.0.1', () => console.log(`express-app listening on ${port}`));
