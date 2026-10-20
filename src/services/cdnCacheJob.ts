/**
 * Cacheo de un track en el CDN (R2) hecho aquí mismo, en vez de en el backend
 * principal.
 *
 * Antes, la primera reproducción de un track hacía que el backend principal
 * descargara el audio completo a través de NUESTRO /api/stream (bytes que
 * salían de este servicio), lo transcodeara y lo subiera a R2 (bytes que
 * salían del principal). Ahora el principal nos manda una URL de subida
 * firmada (presigned PUT) y nosotros:
 *   1. descargamos de googlevideo por el mismo proxy que resolvió la URL
 *      (tráfico entrante, no cuenta como ancho de banda de salida),
 *   2. transcodeamos a Opus con los mismos parámetros que usaba el principal,
 *   3. subimos directo a R2 — sin pasar por el proxy residencial.
 * Así el audio sale una sola vez (ya comprimido) en lugar de dos.
 * Este servicio nunca ve las credenciales de R2: solo una URL de un único uso.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Dispatcher } from 'undici';
import {
  resolveAudioStream,
  getStreamDispatcher,
  reportRelayBlocked,
  type ResolvedStream,
} from './innertubeService.js';
import { cacheGet, cacheSet, cacheDelete } from './cache.js';

export type CdnCacheResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'busy' | 'unresolvable' | 'download_failed' | 'transcode_failed' | 'too_large' | 'upload_failed' };

export interface CdnCacheRequest {
  putUrl: string;
  contentType: string;
  cacheControl: string;
  maxBytes: number;
}

const AUDIO_BITRATE = process.env.AUDIO_BITRATE ?? '96k';
const MAX_CONCURRENT = Number(process.env.CDN_CACHE_MAX_CONCURRENT ?? 2);
const DOWNLOAD_TIMEOUT_MS = 120_000;
const TRANSCODE_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 60_000;

let running = 0;

/** Solo se aceptan URLs firmadas de R2: evita que el endpoint sirva para subir datos a cualquier sitio. */
export function isAllowedPutUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname.endsWith('.r2.cloudflarestorage.com');
  } catch {
    return false;
  }
}

/** Conexión directa (sin el proxy residencial global) para hablar con R2. */
let directAgent: Dispatcher | null = null;
async function getDirectAgent(): Promise<Dispatcher> {
  if (!directAgent) {
    const { Agent } = await import('undici');
    directAgent = new Agent();
  }
  return directAgent;
}

async function getResolved(videoId: string, forceFresh: boolean): Promise<{ resolved: ResolvedStream | null; fresh: boolean }> {
  if (forceFresh) cacheDelete(videoId);
  const cached = forceFresh ? null : cacheGet<ResolvedStream>(videoId);
  if (cached) return { resolved: cached, fresh: false };
  const resolved = await resolveAudioStream(videoId);
  if (resolved) cacheSet(videoId, resolved, resolved.expiresAt);
  return { resolved, fresh: true };
}

/** Descarga el audio completo a `dest`. Devuelve el status de googlevideo (0 = error de red). */
async function downloadTo(resolved: ResolvedStream, dest: string): Promise<number> {
  const dispatcher = await getStreamDispatcher(resolved.proxyIndex ?? -1);
  try {
    const res = await fetch(resolved.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        // Sin Range, Google throttla la descarga (ver relayAudioBytes).
        'Range': 'bytes=0-',
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    if (!res.ok && res.status !== 206) {
      res.body?.cancel().catch(() => {});
      return res.status;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!res.body || (ct && !ct.startsWith('audio/') && !ct.startsWith('video/') && !ct.includes('octet-stream'))) {
      res.body?.cancel().catch(() => {});
      return 502;
    }
    const out = fs.createWriteStream(dest);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    return res.status;
  } catch (err) {
    console.error(`[CdnCache] Error de red descargando: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}

/** Mismos parámetros que el auto-cacheo del backend principal (cdnAutoCacheService.ts). */
function transcodeToOpus(input: string, output: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', input,
      '-vn',
      '-c:a', 'libopus',
      '-b:a', AUDIO_BITRATE,
      '-vbr', 'on',
      '-compression_level', '10',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'ogg',
      '-y', output,
    ]);
    const timer = setTimeout(() => ff.kill('SIGKILL'), TRANSCODE_TIMEOUT_MS);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d; });
    ff.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[CdnCache] No se pudo lanzar ffmpeg: ${err.message}`);
      resolve(false);
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) console.error(`[CdnCache] ffmpeg terminó con código ${code}: ${stderr.slice(0, 300)}`);
      resolve(code === 0);
    });
  });
}

export async function cacheTrackToCdn(videoId: string, req: CdnCacheRequest): Promise<CdnCacheResult> {
  if (running >= MAX_CONCURRENT) return { ok: false, reason: 'busy' };
  running++;

  const base = path.join(os.tmpdir(), `kokolite_${videoId}_${Date.now()}`);
  const rawPath = `${base}.raw`;
  const opusPath = `${base}.opus`;

  try {
    // Hasta 2 intentos: el segundo con resolución fresca (URL cacheada vieja
    // o proxy rotado), igual que el reenvío normal de /api/stream.
    let { resolved, fresh } = await getResolved(videoId, false);
    if (!resolved) return { ok: false, reason: 'unresolvable' };
    let status = await downloadTo(resolved, rawPath);
    if (status !== 200 && status !== 206) {
      // Una URL recién resuelta rechazada con 401/403 = IP del proxy vetada en
      // googlevideo → rotar antes de reintentar (mismo criterio que /api/stream).
      if (fresh && (status === 401 || status === 403) && !(await reportRelayBlocked(videoId, resolved.proxyIndex))) {
        return { ok: false, reason: 'download_failed' };
      }
      ({ resolved } = await getResolved(videoId, true));
      if (!resolved) return { ok: false, reason: 'unresolvable' };
      status = await downloadTo(resolved, rawPath);
      if (status !== 200 && status !== 206) return { ok: false, reason: 'download_failed' };
    }

    if (!(await transcodeToOpus(rawPath, opusPath))) return { ok: false, reason: 'transcode_failed' };

    const body = fs.readFileSync(opusPath);
    if (body.length > req.maxBytes) return { ok: false, reason: 'too_large' };

    const put = await fetch(req.putUrl, {
      method: 'PUT',
      headers: {
        // Deben coincidir con las cabeceras firmadas en la URL.
        'Content-Type': req.contentType,
        'Cache-Control': req.cacheControl,
      },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      dispatcher: await getDirectAgent(),
    } as RequestInit);
    if (!put.ok) {
      console.error(`[CdnCache] R2 rechazó la subida de ${videoId}: HTTP ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);
      return { ok: false, reason: 'upload_failed' };
    }

    console.log(`[CdnCache] ✅ ${videoId} subido a R2 (${(body.length / 1048576).toFixed(1)} MB)`);
    return { ok: true, bytes: body.length };
  } catch (err) {
    console.error(`[CdnCache] Error inesperado con ${videoId}:`, err);
    return { ok: false, reason: 'upload_failed' };
  } finally {
    running--;
    for (const p of [rawPath, opusPath]) fs.rm(p, { force: true }, () => {});
  }
}
