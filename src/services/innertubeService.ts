import { Innertube, Platform } from 'youtubei.js';
import type { Types } from 'youtubei.js';

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
  const yt = await getInnertube();

  for (const client of CLIENT_ORDER) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });

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
      if (!url) {
        console.warn(`[innertube:${client}] no se pudo descifrar URL para ${videoId}`);
        continue;
      }

      return {
        url,
        mimeType: format.mime_type,
        bitrate: format.bitrate,
        contentLength: format.content_length,
        expiresAt: extractExpiryMs(url),
        source: 'innertube',
        client,
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
