import express from 'express';
const app = express();
const router = express.Router();
router.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', router);
app.listen(Number(process.env.PORT || 4000), '127.0.0.1');
