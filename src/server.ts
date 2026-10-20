import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { streamRouter } from './routes/stream.js';
import { searchRouter } from './routes/search.js';
import { artistRouter } from './routes/artist.js';
import { lyricsRouter } from './routes/lyrics.js';
import { cacheStats } from './services/cache.js';
import { getSessionInfo, warmUp } from './services/innertubeService.js';
import { cacheTrackToCdn, isAllowedPutUrl } from './services/cdnCacheJob.js';

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

/**
 * Funciones opcionales que el backend principal comprueba en /health antes de
 * usarlas — así da igual qué servicio se despliegue primero:
 * - 'cors-stream': /api/stream se puede pedir desde el navegador con CORS
 *   (EQ y descargas offline), así el principal redirige aquí en vez de
 *   reenviar él mismo los bytes.
 * - 'cdn-cache': POST /api/cdn-cache/:videoId sube el track a R2 desde aquí.
 */
const FEATURES = ['cors-stream', 'cdn-cache'];

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    features: FEATURES,
    cache: cacheStats(),
  });
});

// CORS solo para el audio: el <audio crossOrigin> del ecualizador y el fetch()
// de las descargas offline leen los bytes desde el navegador. La key ya viaja
// en la URL (?key=), así que no hace falta permitir credenciales. Va ANTES de
// requireApiKey para que un preflight OPTIONS (sin key) no reciba un 401.
app.use('/api/stream', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  return next();
});

// Todo lo que cuelga de /api requiere la key (si está configurada).
app.use('/api', requireApiKey);

/**
 * POST /api/cdn-cache/:videoId  { putUrl, contentType, cacheControl, maxBytes }
 * Descarga, transcodea a Opus y sube a R2 con la URL firmada que manda el
 * backend principal. Responde al terminar (lo llama en segundo plano).
 */
app.post('/api/cdn-cache/:videoId', express.json({ limit: '16kb' }), async (req, res) => {
  const { putUrl, contentType, cacheControl, maxBytes } = req.body ?? {};
  if (!isAllowedPutUrl(putUrl) || typeof contentType !== 'string' || typeof cacheControl !== 'string' || !(Number(maxBytes) > 0)) {
    return res.status(400).json({ ok: false, reason: 'bad_request' });
  }
  const result = await cacheTrackToCdn(req.params.videoId, { putUrl, contentType, cacheControl, maxBytes: Number(maxBytes) });
  return res.status(result.ok ? 200 : result.reason === 'busy' ? 503 : 422).json(result);
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
app.use('/api/artist', artistRouter);
app.use('/api/lyrics', lyricsRouter);

app.listen(PORT, () => {
  console.log(`KokoMusic-lite (solo InnerTube, sin yt-dlp) escuchando en :${PORT}`);
  void warmUp();
});
