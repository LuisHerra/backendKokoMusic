import { Router } from 'express';
import {
  resolveAudioStream,
  diagnoseAudioStream,
  getSessionInfo,
  type ResolvedStream,
} from '../services/innertubeService.js';
import { cacheGet, cacheSet, cacheDelete } from '../services/cache.js';

export const streamRouter = Router();

/**
 * GET /api/stream/_session/info
 * Diagnóstico de si YOUTUBE_COOKIE cargó de verdad — sin esto, la única
 * forma de saberlo era inferirlo indirectamente por si un video con
 * restricción de edad resolvía o no, lo cual falla por mil motivos
 * distintos a "la cookie no cargó". Ruta de 2 segmentos ("_session/info"),
 * no puede colisionar con /:videoId (1 segmento) ni con /:videoId/diagnose
 * (un videoId real de YouTube nunca es "_session").
 */
streamRouter.get('/_session/info', async (_req, res) => {
  try {
    const info = await getSessionInfo();
    return res.json(info);
  } catch (err) {
    console.error('[stream/_session/info] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno obteniendo info de sesión.' });
  }
});

/**
 * GET /api/stream/:videoId/diagnose
 * Prueba TODOS los clientes InnerTube (no corta en el primer éxito) y
 * devuelve el resultado de cada uno. Sirve para medir si depender de un
 * solo cliente (p. ej. IOS) es viable, o si hace falta la redundancia real
 * de varios.
 */
streamRouter.get('/:videoId/diagnose', async (req, res) => {
  const { videoId } = req.params;

  try {
    const results = await diagnoseAudioStream(videoId);
    return res.json({ videoId, results });
  } catch (err) {
    console.error('[stream/diagnose] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno en el diagnóstico.' });
  }
});

/**
 * GET /api/stream/:videoId/resolve
 * Devuelve el JSON de resolución (para APK/ExoPlayer o depuración).
 * Nunca hace proxy de bytes de audio.
 */
streamRouter.get('/:videoId/resolve', async (req, res) => {
  const { videoId } = req.params;

  const cached = cacheGet<ResolvedStream>(videoId);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const resolved = await resolveAudioStream(videoId);

    if (!resolved) {
      return res.status(404).json({
        error: 'No se pudo resolver el stream de audio para este video.',
        videoId,
      });
    }

    cacheSet(videoId, resolved, resolved.expiresAt);
    return res.json({ ...resolved, cached: false });
  } catch (err) {
    console.error('[stream/resolve] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno resolviendo el stream.' });
  }
});

/**
 * GET /api/stream/:videoId
 * Endpoint principal para el reproductor web: 302 a la URL directa.
 * El servidor nunca transporta bytes de audio.
 */
streamRouter.get('/:videoId', async (req, res) => {
  const { videoId } = req.params;

  let resolved = cacheGet<ResolvedStream>(videoId);

  if (!resolved) {
    try {
      resolved = await resolveAudioStream(videoId);
    } catch (err) {
      console.error('[stream] error inesperado:', err);
      return res.status(500).json({ error: 'Error interno resolviendo el stream.' });
    }

    if (resolved) {
      cacheSet(videoId, resolved, resolved.expiresAt);
    }
  }

  if (!resolved) {
    return res.status(404).json({
      error: 'No se pudo resolver el stream de audio para este video.',
      videoId,
    });
  }

  return res.redirect(302, resolved.url);
});

/**
 * DELETE /api/stream/:videoId/cache
 * Purga una entrada cacheada (p. ej. si el cliente detecta una URL rota / 403).
 */
streamRouter.delete('/:videoId/cache', (req, res) => {
  const { videoId } = req.params;
  const deleted = cacheDelete(videoId);
  return res.json({ videoId, deleted });
});
