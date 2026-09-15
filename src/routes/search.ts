import { Router } from 'express';
import { searchTracks } from '../services/innertubeService.js';

export const searchRouter = Router();

/**
 * GET /api/search?q=...
 */
searchRouter.get('/', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';

  if (!q.trim()) {
    return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q".' });
  }

  try {
    const results = await searchTracks(q);
    return res.json({ query: q, count: results.length, results });
  } catch (err) {
    console.error('[search] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno en la búsqueda.' });
  }
});
