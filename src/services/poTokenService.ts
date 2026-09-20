import { JSDOM } from 'jsdom';
import { BotGuardClient } from 'bgutils-js/botguard';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { buildURL, getHeaders, USER_AGENT } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import type { Innertube } from 'youtubei.js';

/**
 * YouTube dejó de devolver `streamingData` para prácticamente cualquier
 * canción "real" (ver diagnóstico: 0/5 en búsquedas de Bad Bunny, Quevedo,
 * Rauw Alejandro, Jay Wheeler, Young Cister — solo vídeos de referencia
 * antiguos como el de Rick Astley resuelven sin esto). Desde 2024-2025 exige
 * un PO Token (Proof of Origin) firmado por BotGuard para confirmar que la
 * petición viene de un cliente real, no de un scraper — independientemente
 * de la reputación de la IP, que es lo que arreglamos con el pool de
 * proxies. Sin esto, ninguna cantidad de proxies buenos soluciona el
 * problema: YouTube ni siquiera incluye los formatos en la respuesta.
 *
 * Referencia oficial (ejemplo verificado contra bgutils-js 4.0.3):
 * https://github.com/LuanRT/BgUtils/blob/main/examples/index.ts
 *
 * El challenge de BotGuard se pide a través de InnerTube
 * (`yt.getAttestationChallenge()`, endpoint `/att/get`) en vez de llamar
 * directo a la API privada de Web Anti-Abuse (`jnn-pa.googleapis.com/.../Waa/Create`).
 * El propio maintainer de BgUtils señaló que ese camino directo puede dar un
 * PO Token que ya no vale para clientes que migraron a solo-SABR (p. ej.
 * MWEB) si la versión de youtubei.js va un poco por detrás de YouTube:
 * https://github.com/LuanRT/BgUtils/issues/48
 */

// Constante pública usada por el cliente WEB de YouTube para pedir el
// challenge de BotGuard — no es un secreto nuestro, es la misma que usa
// cualquier sesión web de YouTube y la que documentan todos los proyectos
// de este ecosistema (yt-dlp, Piped, Invidious, BgUtils).
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';

// Margen de seguridad: refrescar el "minter" un poco antes de que expire de
// verdad el integrity token, para no arriesgarnos a mintar con uno caducado
// justo en medio de una resolución.
const REFRESH_MARGIN_MS = 30 * 60 * 1000;
const FALLBACK_TTL_SECS = 6 * 60 * 60;

let domInstalled = false;

/**
 * BotGuard corre código pensado para un navegador real (referencia a
 * `window`/`document`/`navigator` como parte de la huella que firma). En
 * Node no existe nada de eso — lo simulamos una única vez por proceso con
 * jsdom, igual que hace el ejemplo oficial.
 */
function ensureBotGuardDom(): void {
  if (domInstalled) return;

  const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    resources: { userAgent: USER_AGENT },
  });

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });

  if (!Reflect.has(globalThis, 'navigator')) {
    Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator });
  }

  domInstalled = true;
}

interface MinterBundle {
  minter: WebPoMinter;
  expiresAt: number;
}

let cachedMinter: MinterBundle | null = null;
let mintingPromise: Promise<MinterBundle> | null = null;

/**
 * Descarga el intérprete de BotGuard cuando el challenge de InnerTube solo
 * trae la URL (`interpreter_url`) y no el script inline
 * (`private_do_not_access_or_else_safe_script_wrapped_value`) — a veces
 * viene uno, a veces el otro, según cómo YouTube arme la respuesta de
 * `/att/get` en ese momento.
 */
async function resolveInterpreterJavascript(bgChallenge: NonNullable<Awaited<ReturnType<Innertube['getAttestationChallenge']>>['bg_challenge']>): Promise<string> {
  const inline = bgChallenge.interpreter_url.private_do_not_access_or_else_safe_script_wrapped_value;
  if (inline) return inline;

  const resourceUrl = bgChallenge.interpreter_url.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  if (!resourceUrl) {
    throw new Error('BotGuard: el challenge no trae ni script inline ni URL de intérprete.');
  }
  const fullUrl = resourceUrl.startsWith('http') ? resourceUrl : `https:${resourceUrl}`;
  const scriptRes = await fetch(fullUrl);
  if (!scriptRes.ok) {
    throw new Error(`BotGuard: no se pudo descargar el intérprete (HTTP ${scriptRes.status}).`);
  }
  return scriptRes.text();
}

/**
 * Resuelve un challenge completo de BotGuard (VM + 2 peticiones de red) y
 * construye el WebPoMinter resultante. Esto es lo caro — el minter, una vez
 * creado, puede generar tokens para cualquier videoId localmente (sin red)
 * hasta que el integrity token subyacente expire.
 *
 * El challenge se pide vía InnerTube (`yt.getAttestationChallenge`) en vez
 * de la API privada de WAA directamente — ver comentario de cabecera del
 * archivo (issue #48 de BgUtils, clientes migrados a solo-SABR como MWEB).
 */
async function createMinter(yt: Innertube): Promise<MinterBundle> {
  ensureBotGuardDom();

  const challengeResponse = await yt.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND');
  const bgChallenge = challengeResponse.bg_challenge;
  if (!bgChallenge) {
    throw new Error('BotGuard: InnerTube no devolvió bg_challenge en /att/get.');
  }

  const interpreterJavascript = await resolveInterpreterJavascript(bgChallenge);
  // Mismo mecanismo que el descifrado de firmas en innertubeService.ts: es
  // código de YouTube ejecutado vía Function() a propósito, no eval de datos
  // de usuario.
  // eslint-disable-next-line no-new-func
  new Function(interpreterJavascript)();

  const botGuardClient = await BotGuardClient.create({
    program: bgChallenge.program,
    globalName: bgChallenge.global_name,
    globalObject: globalThis,
  });

  const webPoSignalOutput: WebPoSignalOutput = [];
  const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });

  const integrityRes = await fetch(buildURL('GenerateIT', true), {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });

  if (!integrityRes.ok) {
    throw new Error(`BotGuard: GenerateIT devolvió HTTP ${integrityRes.status}`);
  }

  const integrityTokenJson = (await integrityRes.json()) as [string, number, number, string];
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold] = integrityTokenJson;

  if (!integrityToken) {
    throw new Error('BotGuard: GenerateIT no devolvió integrityToken.');
  }

  const minter = await WebPoMinter.create({ integrityToken, estimatedTtlSecs, mintRefreshThreshold }, webPoSignalOutput);

  const ttlSecs = mintRefreshThreshold || estimatedTtlSecs || FALLBACK_TTL_SECS;
  const expiresAt = Date.now() + Math.max(ttlSecs * 1000 - REFRESH_MARGIN_MS, 5 * 60 * 1000);

  console.log(
    `[PoToken] Minter de BotGuard generado (TTL≈${estimatedTtlSecs}s, ` +
    `refresco en ${Math.round((expiresAt - Date.now()) / 60000)} min).`
  );

  return { minter, expiresAt };
}

async function ensureMinter(yt: Innertube): Promise<WebPoMinter> {
  if (cachedMinter && Date.now() < cachedMinter.expiresAt) {
    return cachedMinter.minter;
  }
  if (mintingPromise) {
    return (await mintingPromise).minter;
  }

  mintingPromise = createMinter(yt);
  try {
    cachedMinter = await mintingPromise;
    return cachedMinter.minter;
  } finally {
    mintingPromise = null;
  }
}

/**
 * Devuelve un PO Token atado a `contentBinding` (normalmente el videoId que
 * se va a resolver — YouTube los ata al vídeo concreto para el player/GVS
 * token). Mintar es barato una vez existe el minter; null si BotGuard falló
 * del todo (el caller debe seguir intentando sin PoToken en vez de romperse).
 */
export async function getPoToken(yt: Innertube, contentBinding: string): Promise<string | null> {
  try {
    const minter = await ensureMinter(yt);
    return await minter.mintAsWebsafeString(contentBinding);
  } catch (err) {
    console.error('[PoToken] No se pudo generar PoToken vía BotGuard:', err instanceof Error ? err.message : err);
    return null;
  }
}
