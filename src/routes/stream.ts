import { Router, Request, Response } from 'express';
import {
  resolveAudioStream,
  diagnoseAudioStream,
  getSessionInfo,
  getProxyPoolStatus,
  type ResolvedStream,
} from '../services/innertubeService.js';
import { cacheGet, cacheSet, cacheDelete } from '../services/cache.js';
import { summarizeResolutions } from '../services/resolutionStats.js';

export const streamRouter = Router();

/**
 * Google firma la URL de googlevideo con la IP exacta que la pidió
 * (parámetro `ip=` visible en la propia URL) y su edge de CDN la rechaza con
 * 403 si el siguiente hop viene de una IP distinta — confirmado con un test
 * aislado: la misma URL responde 403 sin proxy y 206 a través del mismo
 * proxy que la resolvió. Por eso este servidor ya no puede limitarse a
 * devolver un 302 con la URL cruda (el navegador/APK del usuario final
 * jamás va a compartir IP con nuestro pool de proxies) — tiene que buscar
 * los bytes él mismo, con el `fetch` global que ya está enrutado al proxy
 * activo (ver innertubeService.ts), y reenviarlos.
 */
async function relayAudioBytes(req: Request, res: Response, resolved: ResolvedStream): Promise<boolean> {
  const requestHeaders: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Sin Range, Google throttla brutalmente la descarga (anti-scraping) —
    // si el cliente no pidió un rango concreto, forzamos uno abierto.
    'Range': req.headers.range || 'bytes=0-',
  };

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(resolved.url, { headers: requestHeaders });
  } catch (err) {
    console.error(`[Stream] Error de red reenviando audio: ${err instanceof Error ? err.message : err}`);
    return false;
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.error(`[Stream] Upstream googlevideo devolvió ${upstream.status} al reenviar audio.`);
    return false;
  }

  // Google a veces responde 200 con un cuerpo HTML/JSON (captcha, rate-limit,
  // URL caducada) en vez del binario — reenviarlo tal cual rompe el <audio>
  // del cliente con "Format error". Detectarlo aquí permite tratarlo como
  // fallo y reintentar con una resolución fresca antes de que el cliente
  // vea ningún byte.
  const ct = upstream.headers.get('content-type');
  if (ct && !ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream')) {
    console.error(`[Stream] Upstream devolvió content-type no-audio "${ct}" al reenviar.`);
    return false;
  }

  const responseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=1800',
    'Content-Type': ct || resolved.mimeType || 'audio/mp4',
  };
  const cl = upstream.headers.get('content-length');
  if (cl) responseHeaders['Content-Length'] = cl;
  const clientWantedRange = Boolean(req.headers.range);
  const cr = upstream.headers.get('content-range');
  if (cr && clientWantedRange) responseHeaders['Content-Range'] = cr;

  res.writeHead(upstream.status === 206 && clientWantedRange ? 206 : 200, responseHeaders);

  if (!upstream.body) {
    res.end();
    return true;
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    console.error(`[Stream] Error de red a mitad de reenvío: ${err instanceof Error ? err.message : err}`);
    if (!res.writableEnded) res.end();
    return true; // ya se enviaron cabeceras + parte del cuerpo, no se puede reintentar
  }
  res.end();
  return true;
}

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
    return res.json({ ...info, proxyPool: getProxyPoolStatus() });
  } catch (err) {
    console.error('[stream/_session/info] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno obteniendo info de sesión.' });
  }
});

/**
 * GET /api/stream/_session/resolution-stats?hours=24
 * Tasa de éxito real de resolveAudioStream en producción — qué cliente
 * gana normalmente, cuántas resoluciones fallan del todo, latencia media.
 * Pensado para decidir con datos reales cuántas IPs residenciales hacen
 * falta en la próxima renovación, en vez de estimarlo a ojo.
 */
streamRouter.get('/_session/resolution-stats', (req, res) => {
  const hours = Number(req.query.hours) || 24;
  return res.json(summarizeResolutions(hours));
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
 * Endpoint principal: reenvía los bytes de audio (no un 302 a la URL cruda).
 *
 * Antes hacía 302 a la URL de googlevideo directamente — funcionaba mientras
 * el único problema era la reputación de la IP de datacenter. Ahora la URL
 * viene firmada con la IP exacta del proxy que la pidió (`ip=` en la propia
 * URL) y el CDN de Google la rechaza con 403 desde cualquier otra IP —
 * confirmado con un test aislado (misma URL: 403 sin proxy, 206 con el mismo
 * proxy). El navegador o la app móvil del usuario final nunca va a compartir
 * IP con nuestro pool de proxies residenciales, así que ya no hay 302 posible:
 * este servidor tiene que buscar los bytes él mismo (con el fetch global ya
 * enrutado al proxy activo) y reenviarlos. Un reintento con resolución fresca
 * si el primero falla — el proxy pudo rotar, o la URL cacheada quedar vieja.
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

  let relayed = await relayAudioBytes(req, res, resolved);

  if (!relayed && !res.headersSent) {
    console.warn(`[stream] Reenvío falló para ${videoId} — purgando caché y reintentando con resolución fresca.`);
    cacheDelete(videoId);
    try {
      resolved = await resolveAudioStream(videoId);
    } catch (err) {
      resolved = null;
    }
    if (resolved) {
      cacheSet(videoId, resolved, resolved.expiresAt);
      relayed = await relayAudioBytes(req, res, resolved);
    }
  }

  if (!relayed && !res.headersSent) {
    return res.status(502).json({ error: 'No se pudo reenviar el stream de audio.', videoId });
  }
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
