import { Router } from 'express';
import { getMusicLyrics } from '../services/innertubeService.js';

export const lyricsRouter = Router();

/**
 * GET /api/lyrics?artist=...&title=...
 * Letra (texto plano, sin sincronizar) desde YouTube Music — la misma que
 * enseña la pestaña "Letra" de la app, con licencia de Musixmatch/LyricFind.
 * El backend principal la usa como respaldo cuando LRCLIB no tiene la canción.
 */
lyricsRouter.get('/', async (req, res) => {
  const artist = typeof req.query.artist === 'string' ? req.query.artist : '';
  const title = typeof req.query.title === 'string' ? req.query.title : '';

  if (!title.trim()) {
    return res.status(400).json({ error: 'Falta el parámetro "title".' });
  }

  try {
    const result = await getMusicLyrics(artist, title);
    if (!result) {
      return res.status(404).json({ error: 'Letra no disponible.' });
    }
    return res.json(result);
  } catch (err) {
    console.error('[lyrics] error inesperado:', err);
    return res.status(500).json({ error: 'Error interno obteniendo la letra.' });
  }
});
