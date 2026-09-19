/**
 * resolutionStats.ts — Registro histórico de resoluciones de InnerTube
 *
 * Cada llamada a resolveAudioStream() deja una línea en este log (formato
 * JSON Lines) con: qué cliente ganó (o null si fallaron los 5), cuánto
 * tardó, y si se usó proxy. Con esto, en vez de adivinar "cuántas IPs
 * residenciales hacen falta" a partir de una prueba puntual, se puede medir
 * la tasa de éxito real a lo largo del tiempo y ajustar el pool en
 * consecuencia en la próxima renovación.
 *
 * No usa una base de datos a propósito — es un microservicio personal de
 * bajo volumen, un archivo JSONL de apend-only es más que suficiente y no
 * añade dependencias.
 */
import fs from 'fs';
import path from 'path';

const LOG_PATH = path.join(process.cwd(), 'data', 'resolution-stats.jsonl');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB — rota (trunca a la mitad más reciente) si se pasa

export interface ResolutionLogEntry {
  ts: string;
  videoId: string;
  client: string | null; // null = los 5 clientes fallaron
  ms: number;
  proxyUsed: boolean;
}

function ensureDir(): void {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Si el log crece demasiado, nos quedamos solo con la mitad más reciente en vez de dejarlo crecer sin límite. */
function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size <= MAX_LOG_BYTES) return;
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
    const kept = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(LOG_PATH, kept.join('\n') + '\n', 'utf-8');
  } catch {
    // el archivo no existe todavía — nada que rotar
  }
}

export function logResolution(entry: Omit<ResolutionLogEntry, 'ts'>): void {
  try {
    ensureDir();
    rotateIfNeeded();
    const full: ResolutionLogEntry = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(LOG_PATH, JSON.stringify(full) + '\n', 'utf-8');
  } catch (err) {
    // Nunca debe romper una resolución real por un fallo de logging.
    console.warn('[ResolutionStats] No se pudo escribir el log:', err);
  }
}

export interface ResolutionSummary {
  totalAttempts: number;
  successRate: number; // 0-1
  byClient: Record<string, number>; // cuántas veces ganó cada cliente
  failedCount: number;
  avgMs: number;
  sinceHours: number;
}

/** Resumen de las últimas `sinceHours` horas — pensado para un endpoint de diagnóstico. */
export function summarizeResolutions(sinceHours = 24): ResolutionSummary {
  const empty: ResolutionSummary = { totalAttempts: 0, successRate: 0, byClient: {}, failedCount: 0, avgMs: 0, sinceHours };
  try {
    if (!fs.existsSync(LOG_PATH)) return empty;
    const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
    const entries: ResolutionLogEntry[] = lines
      .map((l) => { try { return JSON.parse(l) as ResolutionLogEntry; } catch { return null; } })
      .filter((e): e is ResolutionLogEntry => e !== null && new Date(e.ts).getTime() >= cutoff);

    if (entries.length === 0) return empty;

    const byClient: Record<string, number> = {};
    let failedCount = 0;
    let totalMs = 0;
    for (const e of entries) {
      totalMs += e.ms;
      if (e.client) byClient[e.client] = (byClient[e.client] || 0) + 1;
      else failedCount++;
    }

    return {
      totalAttempts: entries.length,
      successRate: (entries.length - failedCount) / entries.length,
      byClient,
      failedCount,
      avgMs: Math.round(totalMs / entries.length),
      sinceHours,
    };
  } catch (err) {
    console.warn('[ResolutionStats] No se pudo leer el log:', err);
    return empty;
  }
}
