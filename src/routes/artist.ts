import { Router } from 'express';
import {
  searchArtists,
  getArtistProfileCached,
  lookupArtist,
  lookupArtistCandidate,
} from '../services/innertubeService.js';

export const artistRouter = Router();

/**
 * GET /api/artist/search?q=...
 * Devuelve candidatos de artista (para armar un selector si hay varios
 * con nombre parecido) sin traer el perfil completo de cada uno.
 */
artistRouter.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) {
    return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q".' });
  }

  try {
    const results = await searchArtists(q);
    return res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error('[artist/search] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno buscando artistas.' });
  }
});

/**
 * GET /api/artist/lookup/stream?q=...
 * Igual que /lookup, pero como Server-Sent Events en dos tiempos:
 *   1. Evento "candidate" apenas termina la búsqueda (nombre + foto, ya
 *      vienen ahí, no hace falta esperar el perfil completo).
 *   2. Evento "profile" cuando termina getArtist (con caché de 24h detrás,
 *      así que en una búsqueda repetida este evento llega casi al toque).
 *
 * Nota: EventSource (el cliente nativo de SSE en el navegador) no puede
 * mandar headers custom, por eso la autenticación acá también es por
 * query param ?key=..., igual que el resto de la API.
 */
artistRouter.get('/lookup/stream', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) {
    return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q".' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const candidate = await lookupArtistCandidate(q);
    if (!candidate) {
      send('error', { error: 'No se encontró ningún artista para esa búsqueda.' });
      return res.end();
    }

    send('candidate', candidate);

    const profile = await getArtistProfileCached(candidate.id);
    send('profile', profile);
  } catch (err) {
    console.error('[artist/lookup/stream] error inesperado:', err);
    send('error', { error: 'Error interno buscando el artista.' });
  } finally {
    res.end();
  }
});

/**
 * GET /api/artist/lookup?q=...
 * El atajo directo, versión no-streaming: busca, toma el primer candidato,
 * y devuelve el perfil completo en una sola respuesta JSON.
 */
artistRouter.get('/lookup', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q.trim()) {
    return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q".' });
  }

  try {
    const profile = await lookupArtist(q);
    if (!profile) {
      return res.status(404).json({ error: 'No se encontró ningún artista para esa búsqueda.', query: q });
    }
    return res.json(profile);
  } catch (err) {
    console.error('[artist/lookup] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno buscando el artista.' });
  }
});

/**
 * GET /api/artist/:artistId
 * Perfil completo por ID directo (cuando ya sabés el id, por ejemplo
 * porque el usuario eligió uno de varios candidatos de /search).
 */
artistRouter.get('/:artistId', async (req, res) => {
  const { artistId } = req.params;

  try {
    const profile = await getArtistProfileCached(artistId);
    return res.json(profile);
  } catch (err) {
    console.error('[artist/:id] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno obteniendo el perfil del artista.' });
  }
});
