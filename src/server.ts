import express from 'express';
import { streamRouter } from './routes/stream.js';
import { searchRouter } from './routes/search.js';
import { cacheStats } from './services/cache.js';
import { getSessionInfo } from './services/innertubeService.js';

const app = express();

// Hugging Face Spaces expone el puerto 7860 por defecto en Docker Spaces.
const PORT = process.env.PORT ? Number(process.env.PORT) : 7860;

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: cacheStats(),
  });
});

/**
 * GET /api/session
 * Verifica sin ambigüedad si la cookie de YOUTUBE_COOKIE se aplicó y si la
 * sesión de InnerTube quedó autenticada. NO devuelve la cookie en sí,
 * solo si está configurada y su longitud (para detectar copias truncadas).
 */
app.get('/api/session', async (_req, res) => {
  try {
    const info = await getSessionInfo();
    res.json(info);
  } catch (err) {
    console.error('[session] error inesperado:', err);
    res.status(500).json({ error: 'Error obteniendo info de sesión.' });
  }
});

app.use('/api/stream', streamRouter);
app.use('/api/search', searchRouter);

app.listen(PORT, () => {
  console.log(`KokoMusic-lite (solo InnerTube, sin yt-dlp) escuchando en :${PORT}`);
});
