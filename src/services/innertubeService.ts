import { Innertube, Platform } from 'youtubei.js';
import type { Types } from 'youtubei.js';
import { cacheGet, cacheSet } from './cache.js';

type InnerTubeClient = Types.InnerTubeClient;

/**
 * youtubei.js NO trae por defecto un intérprete de JavaScript real — solo un
 * stub que siempre lanza "you must provide your own JavaScript evaluator".
 * Sin esto, cualquier formato que necesite descifrar el parámetro `n` de la
 * URL (la mayoría — YTMUSIC y ANDROID lo necesitan siempre) falla de forma
 * ESTRUCTURAL, no intermitente: no importa qué tan popular o nicho sea el
 * track, va a fallar siempre en esos clientes. Por eso en las pruebas de
 * cobertura solo ganaba IOS — sus formatos no pasan por este descifrado.
 *
 * Referencia oficial:
 * https://ytjs.dev/guide/getting-started.html#providing-a-custom-javascript-interpreter
 *
 * ⚠️ Nota de seguridad: esto ejecuta, vía el constructor `Function` (equivalente
 * a un eval), el código JS ofuscado que YouTube devuelve como parte del
 * reproductor. Es exactamente el mismo mecanismo que usa yt-dlp internamente
 * para lo mismo — no es una práctica insegura *nueva*, es como toda esta
 * clase de herramientas resuelve el descifrado. Para un proyecto personal es
 * un riesgo aceptado estándar en todo este ecosistema (yt-dlp, youtubei.js,
 * Piped e Invidious lo hacen igual). Si algún día esto sirviera a múltiples
 * usuarios desconocidos, valdría la pena aislarlo en un subproceso/VM aparte.
 */
Platform.shim.eval = async (data: { output: string }) => {
  // eslint-disable-next-line no-new-func
  return new Function(data.output)();
};

export interface ResolvedStream {
  url: string;
  mimeType: string;
  bitrate?: number;
  contentLength?: number;
  expiresAt: number; // Unix ms, extraído del parámetro `expire=` de la URL
  source: 'innertube';
  client: string; // qué cliente InnerTube resolvió (para depuración/métricas)
  /**
   * Desglose de tiempos en ms — TEMPORAL, para diagnosticar si la lentitud
   * viene de la espera de red a YouTube o del descifrado (CPU). No es parte
   * del contrato estable de la API, prefijo `_` a propósito.
   */
  _timing?: {
    innertubeReadyMs: number; // cuánto tardó tener la sesión InnerTube lista (0 si ya estaba caliente)
    getBasicInfoMs: number; // la llamada de red a InnerTube en sí
    decipherMs: number; // ejecución de la JS ofuscada (CPU) — 0 si el cliente no la necesitó
    totalMs: number;
  };
}

export interface SearchResultItem {
  id: string;
  title: string;
  author?: string;
  durationSeconds?: number;
  thumbnail?: string;
}

let innertubeInstance: Innertube | null = null;
let innertubeInitPromise: Promise<Innertube> | null = null;

/**
 * Instancia única y reutilizada de Innertube (evita recrear sesión/cliente
 * en cada request — equivalente a mantener el "daemon" caliente).
 */
async function getInnertube(): Promise<Innertube> {
  if (innertubeInstance) return innertubeInstance;

  if (!innertubeInitPromise) {
    // Cookie opcional de una cuenta real de YouTube (formato estándar de
    // header Cookie: "name1=value1; name2=value2"). Ver README para cómo
    // obtenerla. Sin esto, la sesión es anónima — la mayoría del contenido
    // resuelve igual, pero lo que requiere login (algunos casos de
    // restricción de edad) seguirá fallando.
    const cookie = process.env.YOUTUBE_COOKIE || undefined;

    innertubeInitPromise = Innertube.create({
      lang: 'es',
      location: 'ES',
      retrieve_player: true, // necesario para descifrar firmas (n-token)
      cookie,
    }).then((yt) => {
      innertubeInstance = yt;
      return yt;
    });
  }

  return innertubeInitPromise;
}

/**
 * Orden de clientes a probar (valores válidos de InnerTubeClient en
 * youtubei.js 17.x). IOS va primero por latencia (sus formatos no requieren
 * descifrado de `n`). WEB_CREATOR se agrega al final: según el historial de
 * mantenimiento de yt-dlp, es el cliente documentado como workaround para
 * el requisito de verificación de edad — no IOS ni ANDROID. No garantiza
 * nada sin cookie, pero vale la pena tenerlo en la cadena antes de rendirnos.
 */
const CLIENT_ORDER: InnerTubeClient[] = ['IOS', 'ANDROID', 'YTMUSIC', 'MWEB', 'WEB_CREATOR'];

function extractExpiryMs(url: string): number {
  try {
    const parsed = new URL(url);
    const expireParam = parsed.searchParams.get('expire');
    if (expireParam) {
      const seconds = parseInt(expireParam, 10);
      if (!Number.isNaN(seconds)) {
        return seconds * 1000;
      }
    }
  } catch {
    // URL inválida o sin el parámetro — usamos fallback abajo
  }
  // Fallback conservador si no se pudo extraer: 6 horas (TTL típico observado)
  return Date.now() + 6 * 60 * 60 * 1000;
}

/**
 * Intenta resolver el stream de audio de un video de YouTube probando
 * varios clientes InnerTube en orden hasta que uno funcione.
 * Devuelve null si todos fallan (candidato a fallback en la arquitectura híbrida).
 */
export async function resolveAudioStream(
  videoId: string
): Promise<ResolvedStream | null> {
  const t0 = performance.now();
  const wasAlreadyWarm = innertubeInstance !== null;
  const yt = await getInnertube();
  const tInnertubeReady = performance.now();

  for (const client of CLIENT_ORDER) {
    try {
      const tClientStart = performance.now();
      const info = await yt.getBasicInfo(videoId, { client });
      const tInfo = performance.now();

      const format = info.chooseFormat({
        type: 'audio',
        quality: 'best',
      });

      if (!format) {
        console.warn(`[innertube:${client}] sin formato de audio para ${videoId}`);
        continue;
      }

      // decipher() es async en youtubei.js 17.x
      const url = await format.decipher(yt.session.player);
      const tDecipher = performance.now();

      if (!url) {
        console.warn(`[innertube:${client}] no se pudo descifrar URL para ${videoId}`);
        continue;
      }

      const timing = {
        innertubeReadyMs: wasAlreadyWarm ? 0 : Math.round(tInnertubeReady - t0),
        getBasicInfoMs: Math.round(tInfo - tClientStart),
        decipherMs: Math.round(tDecipher - tInfo),
        totalMs: Math.round(tDecipher - t0),
      };

      console.log(
        `[timing] resolveAudioStream(${videoId}, ${client}): ` +
          `innertubeReady=${timing.innertubeReadyMs}ms getBasicInfo=${timing.getBasicInfoMs}ms ` +
          `decipher=${timing.decipherMs}ms total=${timing.totalMs}ms`
      );

      return {
        url,
        mimeType: format.mime_type,
        bitrate: format.bitrate,
        contentLength: format.content_length,
        expiresAt: extractExpiryMs(url),
        source: 'innertube',
        client,
        _timing: timing,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[innertube:${client}] falló para ${videoId}: ${message}`);
      continue;
    }
  }

  return null;
}

export interface DiagnoseResult {
  client: InnerTubeClient;
  success: boolean;
  error?: string;
  mimeType?: string;
  bitrate?: number;
}

/**
 * A diferencia de resolveAudioStream(), NO corta en el primer cliente que
 * funcione. Prueba TODOS los clientes de CLIENT_ORDER y devuelve el
 * resultado de cada uno. Esto es lo que hace falta para responder "¿es
 * viable depender solo de IOS?" con datos reales en vez de asumirlo —
 * porque en el flujo normal, si IOS gana siempre, nunca llegamos a
 * verificar si ANDROID/YTMUSIC/MWEB funcionarían también como respaldo.
 */
export async function diagnoseAudioStream(videoId: string): Promise<DiagnoseResult[]> {
  const yt = await getInnertube();
  const results: DiagnoseResult[] = [];

  for (const client of CLIENT_ORDER) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });

      if (!format) {
        results.push({ client, success: false, error: 'Sin formato de audio' });
        continue;
      }

      const url = await format.decipher(yt.session.player);
      if (!url) {
        results.push({ client, success: false, error: 'No se pudo descifrar la URL' });
        continue;
      }

      results.push({
        client,
        success: true,
        mimeType: format.mime_type,
        bitrate: format.bitrate,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ client, success: false, error: message });
    }
  }

  return results;
}

/**
 * Info de la sesión actual, para verificar SIN AMBIGÜEDAD si la cookie se
 * aplicó de verdad (en vez de inferirlo indirectamente por si un video
 * con restricción de edad resuelve o no — eso puede fallar por mil motivos
 * distintos a "la cookie no cargó").
 */
export async function getSessionInfo() {
  const yt = await getInnertube();
  return {
    loggedIn: yt.session.logged_in,
    cookieConfigured: Boolean(process.env.YOUTUBE_COOKIE),
    cookieLength: process.env.YOUTUBE_COOKIE?.length ?? 0,
  };
}

export async function searchTracks(query: string): Promise<SearchResultItem[]> {
  const yt = await getInnertube();
  const results = await yt.search(query, { type: 'video' });

  const videos = (results.videos ?? []) as Array<{
    id: string;
    title?: { text?: string } | string;
    author?: { name?: string };
    duration?: { seconds?: number };
    thumbnails?: Array<{ url: string }>;
  }>;

  return videos.slice(0, 15).map((v) => ({
    id: v.id,
    title:
      typeof v.title === 'string' ? v.title : v.title?.text ?? '(sin título)',
    author: v.author?.name,
    durationSeconds: v.duration?.seconds,
    thumbnail: v.thumbnails?.[0]?.url,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Perfil de artista (vía YouTube Music, no la búsqueda de video normal)
// ─────────────────────────────────────────────────────────────────────────

export interface ArtistSearchResult {
  id: string;
  name: string;
  thumbnail?: string;
  subscribers?: string;
}

export interface ArtistTrack {
  id: string;
  title: string;
  thumbnail?: string;
  durationSeconds?: number;
}

export interface ArtistAlbum {
  id?: string;
  title: string;
  year?: string;
  thumbnail?: string;
}

export interface ArtistProfile {
  id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  topSongs: ArtistTrack[];
  albums: ArtistAlbum[];
  relatedArtists: ArtistSearchResult[];
  /** Igual que en ResolvedStream — temporal, para diagnóstico. */
  _timing?: {
    searchMs: number;
    getArtistMs: number;
    totalMs: number;
  };
}

/**
 * Busca artistas específicamente (no videos/canciones sueltas) vía la API
 * de YouTube Music. Es lo que permite reconocer que "rnboi" es un artista
 * y no solo un texto de búsqueda de video.
 *
 * NOTA: la forma exacta de la respuesta de yt.music.search() puede variar
 * según cómo YouTube arme el shelf de resultados para un query dado — acá
 * se cubre el caso más común (un MusicShelf con MusicResponsiveListItem
 * adentro, filtrados por item_type === 'artist'). Si en tus pruebas reales
 * ves que search.contents viene vacío pero la búsqueda sí encontró algo,
 * hacé un console.log(JSON.stringify(search, null, 2)) una vez para ver la
 * forma real y ajustar la extracción — no lo pude verificar contra YouTube
 * real desde este entorno.
 */
export async function searchArtists(query: string): Promise<ArtistSearchResult[]> {
  const yt = await getInnertube();
  const search = await yt.music.search(query, { type: 'artist' });

  const items: Array<Record<string, unknown>> = [];
  for (const section of search.contents ?? []) {
    const contents = (section as unknown as { contents?: unknown[] }).contents;
    if (Array.isArray(contents)) {
      items.push(...(contents as Array<Record<string, unknown>>));
    }
  }

  return items
    .filter((item) => item.item_type === 'artist' && typeof item.id === 'string')
    .slice(0, 10)
    .map((item) => {
      const thumbs = (item as { thumbnails?: Array<{ url: string }> }).thumbnails;
      return {
        id: item.id as string,
        name: (item.name as string) ?? (item.title as string) ?? '(sin nombre)',
        thumbnail: thumbs?.[0]?.url,
        subscribers: item.subscribers as string | undefined,
      };
    });
}

/**
 * Trae el perfil completo de un artista: bio, foto, top canciones,
 * discografía y artistas relacionados. Clasifica el contenido de cada
 * "sección" del perfil por item_type ('song' | 'album' | 'artist') en vez
 * de por el texto del título de la sección — así no depende del idioma
 * ("Top songs" vs "Canciones principales" según el `lang` configurado).
 */
export async function getArtistProfile(artistId: string): Promise<ArtistProfile> {
  const yt = await getInnertube();
  const artist = await yt.music.getArtist(artistId);

  const header = artist.header as unknown as {
    title?: { text?: string };
    description?: { text?: string };
    thumbnail?: { contents?: Array<{ url: string }> };
  } | null;

  const topSongs: ArtistTrack[] = [];
  const albums: ArtistAlbum[] = [];
  const relatedArtists: ArtistSearchResult[] = [];

  for (const section of artist.sections ?? []) {
    const contents =
      (section as unknown as { contents?: Array<Record<string, unknown>> }).contents ?? [];

    for (const item of contents) {
      const itemType = item.item_type as string | undefined;
      const rawTitle = item.title as { text?: string } | string | undefined;
      const title =
        typeof rawTitle === 'string' ? rawTitle : rawTitle?.text ?? '(sin título)';
      const thumbUrl =
        (item as { thumbnails?: Array<{ url: string }> }).thumbnails?.[0]?.url ??
        (item as { thumbnail?: Array<{ url: string }> }).thumbnail?.[0]?.url;

      if (itemType === 'song' && topSongs.length < 10 && typeof item.id === 'string') {
        topSongs.push({
          id: item.id,
          title,
          thumbnail: thumbUrl,
          durationSeconds: (item.duration as { seconds?: number } | undefined)?.seconds,
        });
      } else if (itemType === 'album' && albums.length < 20) {
        albums.push({
          id: item.id as string | undefined,
          title,
          year: item.year as string | undefined,
          thumbnail: thumbUrl,
        });
      } else if (itemType === 'artist' && relatedArtists.length < 10 && typeof item.id === 'string') {
        relatedArtists.push({
          id: item.id,
          name: (item.name as string) ?? title,
          thumbnail: thumbUrl,
          subscribers: item.subscribers as string | undefined,
        });
      }
    }
  }

  return {
    id: artistId,
    name: header?.title?.text ?? '(desconocido)',
    description: header?.description?.text,
    thumbnail: header?.thumbnail?.contents?.[0]?.url,
    topSongs,
    albums,
    relatedArtists,
  };
}

/**
 * El atajo directo para el caso de uso que pediste: un query de texto tipo
 * "rnboi" → perfil del artista, en una sola llamada (busca + toma el
 * primer candidato + trae el perfil completo). Devuelve null si no
 * encuentra ningún artista que matchee.
 */
const ARTIST_PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — la bio/discografía no cambia minuto a minuto
const ARTIST_QUERY_TTL_MS = 24 * 60 * 60 * 1000; // 24h — mapeo query → artistId

function normalizeArtistQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Primer paso del lookup: resuelve el query a un candidato (id + nombre +
 * foto), usando caché de query→id si ya se buscó antes. Esto es justo lo
 * que se manda como evento "candidate" en el SSE — no espera al perfil
 * completo.
 */
export async function lookupArtistCandidate(query: string): Promise<ArtistSearchResult | null> {
  const normalized = normalizeArtistQuery(query);
  const cachedId = cacheGet<string>(`artistQuery:${normalized}`);

  if (cachedId) {
    const cachedProfile = cacheGet<ArtistProfile>(`artistProfile:${cachedId}`);
    if (cachedProfile) {
      return { id: cachedProfile.id, name: cachedProfile.name, thumbnail: cachedProfile.thumbnail };
    }
    // Tenemos el id pero el perfil ya venció o se purgó — no hay forma
    // barata de reconstruir nombre/foto sin buscar de nuevo, así que
    // caemos al camino normal de búsqueda (caso raro: ambos TTLs son
    // iguales, así que en la práctica casi siempre coinciden).
  }

  const candidates = await searchArtists(query);
  if (candidates.length === 0) return null;

  cacheSet(`artistQuery:${normalized}`, candidates[0].id, Date.now() + ARTIST_QUERY_TTL_MS);
  return candidates[0];
}

/**
 * Segundo paso: perfil completo por id, con caché de 24h. En un cache hit
 * esto es prácticamente instantáneo — elimina el getArtistMs por completo.
 */
export async function getArtistProfileCached(artistId: string): Promise<ArtistProfile> {
  const cached = cacheGet<ArtistProfile>(`artistProfile:${artistId}`);
  if (cached) return cached;

  const profile = await getArtistProfile(artistId);
  cacheSet(`artistProfile:${artistId}`, profile, Date.now() + ARTIST_PROFILE_TTL_MS);
  return profile;
}

export async function lookupArtist(query: string): Promise<ArtistProfile | null> {
  const t0 = performance.now();
  const candidate = await lookupArtistCandidate(query);
  const tSearch = performance.now();

  if (!candidate) return null;

  const profile = await getArtistProfileCached(candidate.id);
  const tProfile = performance.now();

  const timing = {
    searchMs: Math.round(tSearch - t0),
    getArtistMs: Math.round(tProfile - tSearch),
    totalMs: Math.round(tProfile - t0),
  };

  console.log(
    `[timing] lookupArtist("${query}"): search=${timing.searchMs}ms ` +
      `getArtist=${timing.getArtistMs}ms total=${timing.totalMs}ms`
  );

  return { ...profile, _timing: timing };
}
