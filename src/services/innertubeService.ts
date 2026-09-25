import { Innertube, Platform } from 'youtubei.js';
import type { Types } from 'youtubei.js';
import { cacheGet, cacheSet } from './cache.js';
import { logResolution } from './resolutionStats.js';
import { getPoToken, resetPoTokenMinter } from './poTokenService.js';

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

/**
 * Enruta las peticiones de youtubei.js hacia YouTube a través de un POOL de
 * proxies (residenciales u otros), con fallback automático al siguiente si
 * el actual empieza a dar errores de CONEXIÓN (no de contenido — un video
 * que no existe no es culpa del proxy).
 *
 * Configuración: PROXY_URLS con varias URLs separadas por coma
 * ("http://user:pass@host1:port1,http://user:pass@host2:port2,..."), o
 * PROXY_URL con una sola (se sigue soportando por compatibilidad).
 *
 * Motivo: YouTube penaliza fuertemente las IPs de datacenter (como la de
 * Render) con 403 en /youtubei/v1/player — ver docs/README para el
 * historial de diagnóstico. Y una sola IP residencial también puede
 * degradarse con el tiempo/uso — con un pool, cuando eso pase, el sistema
 * salta sola a la siguiente en vez de quedar todo el servicio bloqueado
 * hasta que alguien cambie la variable de entorno a mano.
 */
function loadProxyPool(): string[] {
  const multi = process.env.PROXY_URLS;
  if (multi) return multi.split(',').map((s) => s.trim()).filter(Boolean);
  const single = process.env.PROXY_URL;
  return single ? [single] : [];
}

const proxyPool = loadProxyPool();
let currentProxyIndex = -1; // -1 = sin proxy activo todavía

/** Aplica el proxy en `index` como dispatcher global. No mezclamos el fetch
 * de `undici` con los Request nativos de youtubei.js (da "Failed to parse
 * URL from [object Request]") — en vez de eso mutamos el dispatcher GLOBAL,
 * que el fetch nativo de Node ya respeta sin más cambios. */
async function applyProxyAt(index: number): Promise<boolean> {
  if (index < 0 || index >= proxyPool.length) return false;
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new ProxyAgent(proxyPool[index]));
  currentProxyIndex = index;
  console.log(`[Innertube] Usando proxy ${index + 1}/${proxyPool.length} del pool.`);
  return true;
}

/**
 * Distingue un fallo de CONEXIÓN (el proxy en sí está caído/inalcanzable) de
 * un fallo normal de contenido (video bloqueado, no encontrado, etc. — eso
 * significa que el proxy SÍ conectó bien, solo que YouTube respondió con un
 * rechazo). Solo lo primero justifica saltar al siguiente proxy del pool.
 */
function isProxyConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EPROTO|socket disconnected|proxy.*(connect|auth)/i.test(message);
}

/**
 * Si `err` es un fallo de conexión del proxy actual, promueve el pool al
 * siguiente. Devuelve true si se pudo cambiar (había otro proxy disponible).
 * Las llamadas que fallen DESPUÉS de esto en el mismo ciclo de reintentos ya
 * usan el nuevo proxy automáticamente (el dispatcher es global).
 */
async function handlePotentialProxyFailure(err: unknown): Promise<void> {
  if (!isProxyConnectionError(err)) return;
  const next = currentProxyIndex + 1;
  if (next < proxyPool.length) {
    console.warn(`[Innertube] Proxy ${currentProxyIndex + 1} parece caído (${err instanceof Error ? err.message : err}) — pasando al siguiente del pool.`);
    await applyProxyAt(next);
  } else {
    console.error(`[Innertube] Proxy ${currentProxyIndex + 1} parece caído y no quedan más en el pool (${proxyPool.length} configurados).`);
  }
}

export function getProxyPoolStatus() {
  return {
    poolSize: proxyPool.length,
    currentProxyIndex,
    usingProxy: currentProxyIndex >= 0,
    cookieDisabled: isCookieDisabled(),
    cookieDisabledUntil: isCookieDisabled() ? cookieDisabledUntil : null,
    blockStreak,
  };
}

// ── Recuperación ante bloqueos ───────────────────────────────────────────────
// handlePotentialProxyFailure solo salta de proxy con errores de CONEXIÓN. Pero
// cuando YouTube quema la IP o la sesión, el proxy conecta perfectamente y lo
// que llega es:
//   - un 403 en /player, /search y /att/get para cualquier vídeo, o
//   - LOGIN_REQUIRED ("confirma que no eres un bot"), que youtubei.js acaba
//     reportando como "Streaming data not available".
// Eso no es "este vídeo no existe", es un bloqueo, y antes nos quedábamos
// pegados a él indefinidamente.
//
// Escalado (cada bloqueo seguido sube un escalón; un acierto lo resetea):
//   1. Rotar al siguiente proxy del pool (circular), manteniendo la cookie:
//      la sesión con cuenta es justo lo que ayuda a pasar la verificación
//      antibots desde IPs de proxy.
//   2. Si tras COOKIE_DISABLE_AFTER_BLOCKS rotaciones sigue bloqueado, puede
//      que la cookie esté quemada: se desactiva temporalmente
//      (COOKIE_DISABLE_MS) y se vuelve a activar sola después. Antes se
//      desactivaba al primer 403 y para siempre (hasta reiniciar), lo que dejó
//      fuera una cookie recién renovada.
// En cada paso se recrea la sesión InnerTube y el minter de PoToken, que
// quedan atados a la sesión/IP anterior.

const COOKIE_DISABLE_AFTER_BLOCKS = 3;
const COOKIE_DISABLE_MS = 30 * 60 * 1000;
let cookieDisabledUntil = 0;
let blockStreak = 0;
let lastRecoveryAt = 0;
const RECOVERY_DEBOUNCE_MS = 5000;

function isCookieDisabled(): boolean {
  return Date.now() < cookieDisabledUntil;
}

/** Si la sesión actual se creó con o sin cookie — para recrearla cuando eso deba cambiar. */
let sessionUsesCookie: boolean | null = null;

function wantsCookie(): boolean {
  return Boolean(process.env.YOUTUBE_COOKIE) && !isCookieDisabled();
}

class BotCheckError extends Error {
  constructor(status: string, reason?: string) {
    super(`Playability ${status}${reason ? `: ${reason}` : ''}`);
    this.name = 'BotCheckError';
  }
}

function isBlockError(err: unknown): boolean {
  if (err instanceof BotCheckError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /status code 403/.test(message);
}

function resetSession(): void {
  innertubeInstance = null;
  innertubeInitPromise = null;
  sessionUsesCookie = null;
  resetPoTokenMinter();
}

/** Recrea la sesión si la cookie debe (des)activarse respecto a como se creó — p. ej. al acabar la desactivación temporal. */
function syncSessionCookieState(): void {
  if (innertubeInstance && sessionUsesCookie !== null && sessionUsesCookie !== wantsCookie()) {
    console.log(`[Innertube] ${wantsCookie() ? 'Reactivando' : 'Desactivando'} YOUTUBE_COOKIE — recreando sesión.`);
    resetSession();
  }
}

function recordUnblocked(): void {
  blockStreak = 0;
}

/**
 * Devuelve true si el caller debe reintentar (se cambió algo, o otra petición
 * concurrente acaba de hacerlo), false si no queda nada que probar.
 */
async function recoverFromBlock(context: string): Promise<boolean> {
  // Varias peticiones concurrentes detectan el mismo bloqueo a la vez — solo
  // la primera escala; el resto reintenta con lo que esa haya cambiado.
  if (Date.now() - lastRecoveryAt < RECOVERY_DEBOUNCE_MS) return true;
  lastRecoveryAt = Date.now();
  blockStreak++;

  const canRotate = proxyPool.length > 1;
  const shouldDropCookie = wantsCookie() && (blockStreak > COOKIE_DISABLE_AFTER_BLOCKS || !canRotate);

  if (shouldDropCookie) {
    cookieDisabledUntil = Date.now() + COOKIE_DISABLE_MS;
    console.error(
      `[Innertube] 🔴 Bloqueo en ${context} (${blockStreak} seguidos) — desactivando YOUTUBE_COOKIE ${COOKIE_DISABLE_MS / 60000} min. ` +
      `Si se repite a menudo, la cookie puede estar caducada: renuévala.`
    );
  } else if (canRotate) {
    const next = (currentProxyIndex + 1) % proxyPool.length;
    console.error(`[Innertube] 🔴 Bloqueo en ${context} con proxy ${currentProxyIndex + 1} (${blockStreak} seguidos) — rotando al ${next + 1}/${proxyPool.length}.`);
    await applyProxyAt(next);
  } else {
    return false;
  }

  resetSession();
  return true;
}

if (proxyPool.length > 0) {
  await applyProxyAt(0);
} else {
  console.log('[Innertube] Sin proxies configurados (PROXY_URLS/PROXY_URL) — peticiones directas.');
}

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

/** Cookie opcional de una cuenta real de YouTube (formato estándar de header
 * Cookie: "name1=value1; name2=value2"). Ver README para cómo obtenerla. Sin
 * esto, la sesión es anónima — la mayoría del contenido resuelve igual, pero
 * lo que requiere login (algunos casos de restricción de edad) seguirá
 * fallando.
 *
 * Quitamos comillas envolventes por si el valor se pegó tal cual desde el
 * navegador/gestor de variables (p.ej. "name1=value1; name2=value2" con las
 * comillas incluidas como caracteres reales) — eso corrompe la cabecera
 * Cookie entera y YouTube la trata como sesión anónima/inválida sin dar
 * ningún error explícito, solo fallos silenciosos en contenido que requiere
 * login. */
function loadYoutubeCookie(): string | undefined {
  let cookie = process.env.YOUTUBE_COOKIE || undefined;
  if (cookie && cookie.length >= 2) {
    const first = cookie[0];
    const last = cookie[cookie.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      cookie = cookie.slice(1, -1);
      console.warn('[Innertube] YOUTUBE_COOKIE tenía comillas envolventes — se han quitado automáticamente.');
    }
  }
  return cookie;
}

/**
 * Instancia única y reutilizada de Innertube (evita recrear sesión/cliente
 * en cada request — equivalente a mantener el "daemon" caliente).
 *
 * Innertube.create() ya hace peticiones de red (descarga el player.js para
 * poder descifrar firmas) — si el proxy activo está caído, esto fallaba con
 * una excepción SIN CAPTURAR que tumbaba el proceso entero, sin pasar nunca
 * por handlePotentialProxyFailure (que solo cubre los reintentos DENTRO de
 * resolveAudioStream/searchTracks, ejecutados después de que ya existe una
 * sesión). Aquí se prueba cada proxy del pool hasta que uno consiga crear la
 * sesión, o hasta agotarlos.
 */
async function getInnertube(): Promise<Innertube> {
  if (innertubeInstance) return innertubeInstance;
  if (innertubeInitPromise) return innertubeInitPromise;

  const useCookie = wantsCookie();
  const cookie = useCookie ? loadYoutubeCookie() : undefined;

  innertubeInitPromise = (async () => {
    let lastErr: unknown;
    // +1: además de los proxies del pool, un último intento sin proxy si se agotan todos
    const maxAttempts = Math.max(1, proxyPool.length) + (proxyPool.length > 0 ? 1 : 0);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const yt = await Innertube.create({
          lang: 'es',
          // Sin `location` fijo: el pool de proxies actual reparte IPs entre
          // EE.UU./Italia/Francia/Reino Unido/Colombia, ninguna en España —
          // declarar location:'ES' contra una IP de otro país es una señal
          // de anomalía extra para el anti-abuso de Google, autoinfligida.
          // Sin el campo, InnerTube infiere la región a partir de la IP real
          // del proxy activo, que es justo lo que sí queremos que vea.
          retrieve_player: true, // necesario para descifrar firmas (n-token)
          cookie,
        });
        innertubeInstance = yt;
        sessionUsesCookie = useCookie;
        return yt;
      } catch (err) {
        lastErr = err;
        console.error(`[Innertube] Fallo creando la sesión (intento ${attempt + 1}/${maxAttempts}):`, err instanceof Error ? err.message : err);
        if (isProxyConnectionError(err) && currentProxyIndex + 1 < proxyPool.length) {
          await applyProxyAt(currentProxyIndex + 1);
          continue;
        }
        break;
      }
    }

    // Se agotaron los proxies (o el error no era de conexión) — dejar que la
    // próxima llamada reintente desde cero en vez de quedar con una promesa
    // rechazada cacheada para siempre.
    innertubeInitPromise = null;
    throw lastErr;
  })();

  return innertubeInitPromise;
}

/**
 * Orden de clientes a probar (valores válidos de InnerTubeClient en
 * youtubei.js 17.x).
 *
 * ACTUALIZADO tras medir con datos reales (diagnose-result-*.json, 27 tracks):
 * IOS y ANDROID fallan con HTTP 400 en el 100% de los casos — YouTube parece
 * haber roto algo del lado de esos dos clientes en youtubei.js recientemente
 * (contradice el comentario original de arriba, que asumía que IOS ganaba
 * siempre). YTMUSIC/MWEB/WEB_CREATOR resolvieron el 100% de los tracks
 * probados. Los dejamos al final en vez de quitarlos del todo — no cuestan
 * nada si nunca se llega a ellos, y si YouTube/youtubei.js lo arregla más
 * adelante, se benefician automáticamente sin tocar código. Antes, CADA
 * resolución (incluso las que acababan bien) perdía varios segundos
 * probando dos clientes muertos antes de llegar a uno que funciona.
 */
const CLIENT_ORDER: InnerTubeClient[] = ['YTMUSIC', 'MWEB', 'WEB_CREATOR', 'IOS', 'ANDROID'];

/** Tiempo máximo por cliente antes de darlo por perdido y probar el siguiente. */
const PER_CLIENT_TIMEOUT_MS = 7000;

class ClientTimeoutError extends Error {
  constructor(client: string) {
    super(`Timeout tras ${PER_CLIENT_TIMEOUT_MS}ms esperando a ${client}`);
    this.name = 'ClientTimeoutError';
  }
}

/** Corre `fn` con un límite de tiempo — si se agota, sigue con el siguiente cliente en vez de colgar la resolución entera esperando a uno lento. */
function withTimeout<T>(promise: Promise<T>, client: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClientTimeoutError(client)), PER_CLIENT_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Adjunta un PoToken atado a `videoId` a la sesión ANTES de pedir
 * getBasicInfo() — sin esto YouTube responde "OK" pero sin `streamingData`
 * en absoluto para prácticamente cualquier canción actual (ver comentario en
 * poTokenService.ts). Se aplica tanto a `session.po_token` (va en el cuerpo
 * de la petición del player, es lo que desbloquea streamingData) como a
 * `session.player.po_token` (se usa al descifrar la URL final, evita
 * throttling/403 de googlevideo). Si falla, seguimos sin PoToken en vez de
 * abortar — algunos vídeos aún resuelven sin él.
 */
async function attachPoToken(yt: Innertube, videoId: string): Promise<void> {
  const poToken = await getPoToken(yt, videoId);
  if (!poToken) return;
  yt.session.po_token = poToken;
  if (yt.session.player) {
    yt.session.player.po_token = poToken;
  }
}

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
 * Máximo de escalados (quitar cookie / rotar proxy) por petición. Acotado
 * para no pasar del timeout de 15s del backend principal: con la detección
 * temprana de bloqueo cada intento fallido cuesta ~1-2s.
 */
const MAX_BLOCK_RECOVERIES = 3;

/** Si los N primeros clientes dan 403, es un bloqueo de sesión/IP, no del vídeo — no gastar tiempo en el resto. */
const EARLY_BLOCK_THRESHOLD = 2;

/**
 * Intenta resolver el stream de audio de un video de YouTube probando
 * varios clientes InnerTube en orden hasta que uno funcione.
 * Devuelve null si todos fallan (candidato a fallback en la arquitectura híbrida).
 */
export async function resolveAudioStream(
  videoId: string
): Promise<ResolvedStream | null> {
  syncSessionCookieState();
  for (let attempt = 0; ; attempt++) {
    const { result, blocked } = await resolveAudioStreamOnce(videoId);
    if (result) return result;
    if (!blocked || attempt >= MAX_BLOCK_RECOVERIES) return null;
    if (!(await recoverFromBlock(`resolve(${videoId})`))) return null;
  }
}

async function resolveAudioStreamOnce(
  videoId: string
): Promise<{ result: ResolvedStream | null; blocked: boolean }> {
  const t0 = performance.now();
  let forbiddenCount = 0;
  const wasAlreadyWarm = innertubeInstance !== null;
  const yt = await getInnertube();
  const tInnertubeReady = performance.now();

  await attachPoToken(yt, videoId);

  for (const client of CLIENT_ORDER) {
    try {
      const tClientStart = performance.now();
      const info = await withTimeout(yt.getBasicInfo(videoId, { client }), client);
      const tInfo = performance.now();

      // La verificación antibots llega como LOGIN_REQUIRED sin streamingData;
      // sin esto solo veíamos "Streaming data not available" y no rotábamos.
      const playability = (info as { playability_status?: { status?: string; reason?: string } }).playability_status;
      if (playability?.status === 'LOGIN_REQUIRED') {
        throw new BotCheckError(playability.status, playability.reason);
      }

      const format = info.chooseFormat({
        type: 'audio',
        quality: 'best',
      });

      if (!format) {
        console.warn(`[innertube:${client}] sin formato de audio para ${videoId}`);
        continue;
      }

      // decipher() es async en youtubei.js 17.x
      const url = await withTimeout(format.decipher(yt.session.player), client);
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

      logResolution({ videoId, client, ms: timing.totalMs, proxyUsed: currentProxyIndex >= 0 });
      recordUnblocked();

      return {
        result: {
          url,
          mimeType: format.mime_type,
          bitrate: format.bitrate,
          contentLength: format.content_length,
          expiresAt: extractExpiryMs(url),
          source: 'innertube',
          client,
          _timing: timing,
        },
        blocked: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[innertube:${client}] falló para ${videoId}: ${message}`);
      await handlePotentialProxyFailure(err);
      if (isBlockError(err)) {
        forbiddenCount++;
        // Los primeros N clientes seguidos con 403 → bloqueo, cortar ya.
        if (forbiddenCount >= EARLY_BLOCK_THRESHOLD && forbiddenCount === CLIENT_ORDER.indexOf(client) + 1) {
          logResolution({ videoId, client: null, ms: Math.round(performance.now() - t0), proxyUsed: currentProxyIndex >= 0 });
          return { result: null, blocked: true };
        }
      }
      continue;
    }
  }

  logResolution({ videoId, client: null, ms: Math.round(performance.now() - t0), proxyUsed: currentProxyIndex >= 0 });
  return { result: null, blocked: forbiddenCount === CLIENT_ORDER.length };
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
  await attachPoToken(yt, videoId);
  const results: DiagnoseResult[] = [];

  for (const client of CLIENT_ORDER) {
    try {
      const info = await withTimeout(yt.getBasicInfo(videoId, { client }), client);
      const playability = (info as { playability_status?: { status?: string; reason?: string } }).playability_status;
      if (playability?.status && playability.status !== 'OK') {
        results.push({ client, success: false, error: `Playability ${playability.status}${playability.reason ? `: ${playability.reason}` : ''}` });
        continue;
      }
      const format = info.chooseFormat({ type: 'audio', quality: 'best' });

      if (!format) {
        results.push({ client, success: false, error: 'Sin formato de audio' });
        continue;
      }

      const url = await withTimeout(format.decipher(yt.session.player), client);
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
      await handlePotentialProxyFailure(err);
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

export async function searchTracks(query: string, allowRecovery = true): Promise<SearchResultItem[]> {
  const yt = await getInnertube();

  // Degradar a lista vacía en vez de propagar la excepción — un proxy caído
  // o un fallo de red puntual no debe tumbar la búsqueda con un 500; el
  // caller (KokoMusic backend) ya sabe tratar "sin resultados" como señal
  // para probar otra fuente, en vez de recibir un error duro.
  let results: Awaited<ReturnType<typeof yt.search>>;
  try {
    results = await withTimeout(yt.search(query, { type: 'video' }), 'search');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[innertube:search] falló para "${query}": ${message}`);
    await handlePotentialProxyFailure(err);
    // La búsqueda casi nunca da 403 por el contenido — si lo da, es bloqueo.
    if (allowRecovery && isBlockError(err) && (await recoverFromBlock('search'))) {
      return searchTracks(query, false);
    }
    return [];
  }

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
// Letras vía YouTube Music
// ─────────────────────────────────────────────────────────────────────────

export interface MusicLyricsResult {
  videoId: string;
  title?: string;
  artists: string[];
  lyrics: string;
  /** "Fuente: Musixmatch" / "Fuente: LyricFind", tal cual lo da YouTube Music. */
  source?: string;
}

const LYRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LYRICS_MISS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Busca la canción en YouTube Music (filtro "canciones", que devuelve la
 * versión de audio oficial — la que sí trae letra, los videoclips a menudo
 * no) y pide su letra. Probado: encuentra letras que LRCLIB no tiene
 * (p. ej. Young Cister), pero solo en texto plano, sin tiempos.
 */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function getMusicLyrics(artist: string, title: string): Promise<MusicLyricsResult | null> {
  const query = `${artist} ${title}`.trim();
  const key = `lyrics:${query.toLowerCase()}`;
  const cached = cacheGet<MusicLyricsResult | 'miss'>(key);
  if (cached) return cached === 'miss' ? null : cached;

  const yt = await getInnertube();
  let song: { id?: string; title?: unknown; artists?: Array<{ name?: string }> } | undefined;
  try {
    const search = await withTimeout(yt.music.search(query, { type: 'song' }), 'music-search');
    const shelf = (search.contents ?? []).find((c) => (c as { type?: string }).type === 'MusicShelf') as
      | { contents?: Array<typeof song> }
      | undefined;
    // El primer resultado no siempre es la canción pedida (p. ej. un remix de
    // otro artista con el mismo título) — exigimos que case el artista y que
    // el título contenga el buscado.
    const wantedArtist = normalizeForMatch(artist);
    const wantedTitle = normalizeForMatch(title);
    song = shelf?.contents?.find((item) => {
      if (typeof item?.id !== 'string') return false;
      const itemTitle = normalizeForMatch(String((item.title as { toString?: () => string })?.toString?.() ?? item.title ?? ''));
      const artistOk = !wantedArtist || (item.artists ?? []).some((a) => {
        const name = normalizeForMatch(a.name ?? '');
        return !!name && (name.includes(wantedArtist) || wantedArtist.includes(name));
      });
      const titleOk = !wantedTitle || itemTitle.includes(wantedTitle) || wantedTitle.includes(itemTitle);
      return artistOk && titleOk;
    });
  } catch (err) {
    console.warn(`[innertube:lyrics] búsqueda falló para "${query}":`, err instanceof Error ? err.message : err);
    await handlePotentialProxyFailure(err);
    return null; // error de red/bloqueo: no se cachea como "sin letra"
  }

  if (!song?.id) {
    cacheSet(key, 'miss', Date.now() + LYRICS_MISS_TTL_MS);
    return null;
  }

  try {
    const lyrics = await withTimeout(yt.music.getLyrics(song.id), 'lyrics');
    const text = lyrics?.description?.toString().trim() ?? '';
    if (text.length < 20) {
      cacheSet(key, 'miss', Date.now() + LYRICS_MISS_TTL_MS);
      return null;
    }
    const result: MusicLyricsResult = {
      videoId: song.id,
      title: typeof song.title === 'string' ? song.title : (song.title as { toString?: () => string })?.toString?.(),
      artists: (song.artists ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
      lyrics: text,
      source: lyrics?.footer?.toString(),
    };
    cacheSet(key, result, Date.now() + LYRICS_TTL_MS);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // youtubei.js lanza "La letra no está disponible" / "Lyrics not available" cuando no hay letra.
    if (/no est[aá] disponible|not available/i.test(message)) {
      cacheSet(key, 'miss', Date.now() + LYRICS_MISS_TTL_MS);
    } else {
      console.warn(`[innertube:lyrics] getLyrics falló para ${song.id}: ${message}`);
      await handlePotentialProxyFailure(err);
    }
    return null;
  }
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
