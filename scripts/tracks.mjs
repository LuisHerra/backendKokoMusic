/**
 * 30 canciones repartidas en 5 categorías, compartidas entre coverage-test.mjs
 * y diagnose-clients.mjs. Son consultas de texto, no IDs — cada script las
 * resuelve a un ID real vía tu propio /api/search.
 *
 * Categorías:
 *   - popular:  éxitos muy conocidos (control — deberían resolver casi siempre)
 *   - nicho:    artistas indie/underground, catálogo más chico
 *   - reciente: lanzamientos de 2026 (verificados como reales, no inventados)
 *   - viejo:    catálogo clásico, 1960s-1980s
 *   - riesgo:   contenido con historial de restricción de edad / letras explícitas
 */
export const TRACKS = [
  // popular
  { query: 'Rick Astley Never Gonna Give You Up official video', category: 'popular' },
  { query: 'Daft Punk Harder Better Faster Stronger official audio', category: 'popular' },
  { query: 'The Weeknd Blinding Lights official video', category: 'popular' },
  { query: 'Queen Bohemian Rhapsody official video', category: 'popular' },
  { query: 'Ed Sheeran Shape of You official video', category: 'popular' },
  { query: 'Billie Eilish bad guy official video', category: 'popular' },
  { query: 'Bad Bunny Titi Me Pregunto', category: 'popular' },

  // nicho (indie / underground, catálogo más chico)
  { query: 'Fontaines D.C. Boys in the Better Land', category: 'nicho' },
  { query: 'black midi Sugar/Tzu', category: 'nicho' },
  { query: 'Black Country New Road Sunglasses', category: 'nicho' },
  { query: 'Squid Narrator official video', category: 'nicho' },
  { query: 'Wet Leg Chaise Longue official video', category: 'nicho' },
  { query: 'Jockstrap Concrete Over Water', category: 'nicho' },

  // reciente (lanzamientos verificados de 2026)
  { query: 'benny blanco Selena Gomez Becky G Te Olvido La La', category: 'reciente' },
  { query: 'Cardi B AH HA official video', category: 'reciente' },
  { query: 'Ellie Goulding 4 Seasons official video', category: 'reciente' },
  { query: 'Olivia Rodrigo stupid song', category: 'reciente' },
  { query: 'Madonna Love Sensation 2026', category: 'reciente' },
  { query: 'Beyonce MORNING DEW DONK', category: 'reciente' },

  // viejo (catálogo clásico)
  { query: 'The Beatles Hey Jude official video', category: 'viejo' },
  { query: 'Fleetwood Mac Dreams official video', category: 'viejo' },
  { query: 'Michael Jackson Billie Jean official video', category: 'viejo' },
  { query: 'ABBA Dancing Queen official video', category: 'viejo' },
  { query: 'Nirvana Smells Like Teen Spirit official video', category: 'viejo' },
  { query: 'David Bowie Heroes official video', category: 'viejo' },

  // riesgo (historial de restricción de edad / contenido explícito)
  { query: 'Cardi B WAP official video', category: 'riesgo' },
  { query: 'Eminem Rap God official video', category: 'riesgo' },
  { query: 'Kendrick Lamar Not Like Us official video', category: 'riesgo' },
  { query: 'Rammstein Pussy official video', category: 'riesgo' },
  { query: 'Death Grips Guillotine full video', category: 'riesgo' },

  // francés (catálogo francófono — mezcla de mainstream, clásico y underground)
  { query: 'Stromae Alors on danse clip officiel', category: 'francés' },
  { query: 'Stromae Papaoutai clip officiel', category: 'francés' },
  { query: 'Angèle Balance ton quoi clip officiel', category: 'francés' },
  { query: 'Aya Nakamura Djadja clip officiel', category: 'francés' },
  { query: 'Édith Piaf Non je ne regrette rien', category: 'francés' },
  { query: 'Christine and the Queens Saint Claude clip officiel', category: 'francés' },
  { query: 'IAM Nés en 77 clip officiel', category: 'francés' },
  { query: 'PNL Au DD clip officiel', category: 'francés' },
];
