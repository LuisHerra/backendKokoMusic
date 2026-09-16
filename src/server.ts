import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { streamRouter } from './routes/stream.js';
import { searchRouter } from './routes/search.js';
import { artistRouter } from './routes/artist.js';
import { cacheStats } from './services/cache.js';
import { getSessionInfo } from './services/innertubeService.js';

const app = express();

// Hugging Face Spaces expone el puerto 7860 por defecto en Docker Spaces.
const PORT = process.env.PORT ? Number(process.env.PORT) : 7860;

/**
 * Protección propia por API key (independiente de si el hosting es
 * público o privado). Se manda como ?key=... en la URL — a propósito,
 * NO como header — porque un query param sí viaja en un <audio src="...">
 * o en una redirección 302, que es exactamente cómo vas a consumir esto
 * desde un reproductor real (a diferencia de un header Authorization,
 * que no podés poner en el src de un <audio>).
 *
 * Si no configurás API_KEY, no exige nada — pensado para desarrollo local
 * cómodo. En cloud, configurala siempre.
 */
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const configuredKey = process.env.API_KEY;
  if (!configuredKey) {
    return next(); // sin API_KEY seteada, no exigimos nada (modo dev local)
  }

  const providedKey =
    (req.query.key as string | undefined) ?? req.header('x-api-key') ?? undefined;

  if (providedKey !== configuredKey) {
    return res.status(401).json({ error: 'API key inválida o faltante.' });
  }

  return next();
}

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: cacheStats(),
  });
});

// Todo lo que cuelga de /api requiere la key (si está configurada).
app.use('/api', requireApiKey);

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
app.use('/api/artist', artistRouter);

app.listen(PORT, () => {
  console.log(`KokoMusic-lite (solo InnerTube, sin yt-dlp) escuchando en :${PORT}`);
});
