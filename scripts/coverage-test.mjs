#!/usr/bin/env node
/**
 * Script de prueba de cobertura para KokoMusic-lite (solo InnerTube, sin yt-dlp).
 *
 * Busca cada track vía tu propio /api/search, purga caché, y resuelve en frío
 * vía /api/stream/:id/resolve. Reporta % de éxito global y por categoría, más
 * qué cliente ganó cada vez.
 *
 * Uso:
 *   node scripts/coverage-test.mjs
 *   BASE_URL=https://tu-usuario-tu-space.hf.space node scripts/coverage-test.mjs
 */

import { TRACKS } from './tracks.mjs';
import { sleep, warmup, searchFirstResult, purgeCache, withKey } from './lib.mjs';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7860';
const DELAY_MS = 400;

async function processTrack(track) {
  const start = performance.now();
  let id = track.id;
  let matchedTitle = track.query ? null : '(id fijo, sin búsqueda)';

  if (!id) {
    try {
      const found = await searchFirstResult(BASE_URL, track.query);
      if (!found) {
        return {
          ...track,
          success: false,
          stage: 'search',
          error: 'Búsqueda sin resultados',
          elapsedMs: Math.round(performance.now() - start),
        };
      }
      id = found.id;
      matchedTitle = found.matchedTitle;
    } catch (err) {
      return {
        ...track,
        success: false,
        stage: 'search',
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Math.round(performance.now() - start),
      };
    }
  }

  await purgeCache(BASE_URL, id);

  try {
    const res = await fetch(withKey(`${BASE_URL}/api/stream/${id}/resolve`));
    const elapsedMs = Math.round(performance.now() - start);
    const body = await res.json().catch(() => null);

    if (res.ok && body?.url) {
      return {
        ...track,
        id,
        matchedTitle,
        success: true,
        stage: 'resolve',
        httpStatus: res.status,
        client: body.client,
        mimeType: body.mimeType,
        bitrate: body.bitrate,
        elapsedMs,
      };
    }

    return {
      ...track,
      id,
      matchedTitle,
      success: false,
      stage: 'resolve',
      httpStatus: res.status,
      error: body?.error ?? `HTTP ${res.status}`,
      elapsedMs,
    };
  } catch (err) {
    return {
      ...track,
      id,
      matchedTitle,
      success: false,
      stage: 'resolve',
      httpStatus: null,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Math.round(performance.now() - start),
    };
  }
}

function printProgress(result, index, total) {
  const label = result.query ?? result.id;
  const status = result.success ? `✅ ${result.client}` : `❌ [${result.stage}] ${result.error}`;
  const matchNote = result.matchedTitle ? ` → "${result.matchedTitle}"` : '';
  console.log(`[${index + 1}/${total}] ${label} (${result.category})${matchNote} — ${status} — ${result.elapsedMs}ms`);
}

function summarize(results) {
  const total = results.length;
  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  console.log('\n' + '='.repeat(60));
  console.log('RESUMEN GLOBAL');
  console.log('='.repeat(60));
  console.log(`Total probados: ${total}`);
  console.log(`Éxito: ${successes.length} (${((successes.length / total) * 100).toFixed(1)}%)`);
  console.log(`Fallo:  ${failures.length} (${((failures.length / total) * 100).toFixed(1)}%)`);

  if (successes.length > 0) {
    const avgLatency = successes.reduce((sum, r) => sum + r.elapsedMs, 0) / successes.length;
    console.log(`Latencia promedio (éxitos, en frío, incluye búsqueda): ${avgLatency.toFixed(0)}ms`);
  }

  console.log('\n--- Éxito por categoría ---');
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const inCat = results.filter((r) => r.category === cat);
    const okInCat = inCat.filter((r) => r.success);
    console.log(
      `${cat.padEnd(10)}: ${okInCat.length}/${inCat.length} (${((okInCat.length / inCat.length) * 100).toFixed(0)}%)`
    );
  }

  if (successes.length > 0) {
    console.log('\n--- Qué cliente InnerTube ganó (solo éxitos) ---');
    const clientCounts = {};
    for (const r of successes) {
      clientCounts[r.client] = (clientCounts[r.client] ?? 0) + 1;
    }
    for (const [client, count] of Object.entries(clientCounts)) {
      console.log(`${client.padEnd(10)}: ${count} (${((count / successes.length) * 100).toFixed(0)}%)`);
    }
  }

  const searchFailures = failures.filter((f) => f.stage === 'search');
  const resolveFailures = failures.filter((f) => f.stage === 'resolve');

  if (searchFailures.length > 0) {
    console.log('\n--- Fallos en la BÚSQUEDA ---');
    for (const f of searchFailures) {
      console.log(`  - [${f.category}] "${f.query}": ${f.error}`);
    }
  }

  if (resolveFailures.length > 0) {
    console.log('\n--- Fallos en la RESOLUCIÓN ---');
    for (const f of resolveFailures) {
      console.log(`  - [${f.category}] "${f.matchedTitle ?? f.query}" (${f.id}): ${f.error}`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

async function main() {
  await warmup(BASE_URL);

  console.log(`Probando ${TRACKS.length} tracks contra ${BASE_URL} ...\n`);

  const results = [];
  for (let i = 0; i < TRACKS.length; i++) {
    const result = await processTrack(TRACKS[i]);
    results.push(result);
    printProgress(result, i, TRACKS.length);
    await sleep(DELAY_MS);
  }

  summarize(results);

  const fs = await import('node:fs/promises');
  const filename = `coverage-result-${Date.now()}.json`;
  await fs.writeFile(filename, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nResultado detallado guardado en: ${filename}`);
}

main();
