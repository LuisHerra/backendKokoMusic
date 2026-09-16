import { Router } from 'express';
import { searchArtists, getArtistProfile, lookupArtist } from '../services/innertubeService.js';

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
 * GET /api/artist/lookup?q=...
 * El atajo directo: un texto de búsqueda → perfil del primer artista que
 * matchea, en una sola llamada. Es el que resuelve el caso "busco 'rnboi'
 * y me sale directamente su perfil".
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
    const profile = await getArtistProfile(artistId);
    return res.json(profile);
  } catch (err) {
    console.error('[artist/:id] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno obteniendo el perfil del artista.' });
  }
});
