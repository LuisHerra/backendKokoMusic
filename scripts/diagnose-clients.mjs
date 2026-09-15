#!/usr/bin/env node
/**
 * Diagnóstico de clientes InnerTube para KokoMusic-lite.
 *
 * A diferencia de coverage-test.mjs (que reporta quién GANÓ primero),
 * este script prueba TODOS los clientes (IOS, ANDROID, YTMUSIC, MWEB,
 * WEB_CREATOR) en cada track vía /api/stream/:id/diagnose, sin cortar en
 * el primer éxito. Responde la pregunta real: "si IOS dejara de andar
 * mañana, ¿tengo un plan B que funciona, o dependo de un solo punto de
 * fallo disfrazado de 4 clientes en la lista?"
 *
 * Uso:
 *   node scripts/diagnose-clients.mjs
 *   BASE_URL=https://tu-usuario-tu-space.hf.space node scripts/diagnose-clients.mjs
 */

import { TRACKS } from './tracks.mjs';
import { sleep, warmup, searchFirstResult, purgeCache } from './lib.mjs';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:7860';
const DELAY_MS = 500; // cada diagnóstico ya dispara ~5 llamadas internas, dejamos más aire

async function diagnoseOne(track) {
  let found;
  try {
    found = await searchFirstResult(BASE_URL, track.query);
  } catch (err) {
    return { ...track, searchFailed: true, error: err instanceof Error ? err.message : String(err) };
  }

  if (!found) {
    return { ...track, searchFailed: true, error: 'Búsqueda sin resultados' };
  }

  await purgeCache(BASE_URL, found.id);

  try {
    const res = await fetch(`${BASE_URL}/api/stream/${found.id}/diagnose`);
    const body = await res.json().catch(() => null);
    return {
      ...track,
      id: found.id,
      matchedTitle: found.matchedTitle,
      results: body?.results ?? [],
    };
  } catch (err) {
    return {
      ...track,
      id: found.id,
      matchedTitle: found.matchedTitle,
      diagnoseFailed: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printTrack(d, index, total) {
  if (d.searchFailed) {
    console.log(`[${index + 1}/${total}] "${d.query}" — ❌ búsqueda falló: ${d.error}`);
    return;
  }
  if (d.diagnoseFailed) {
    console.log(`[${index + 1}/${total}] "${d.matchedTitle}" — ❌ diagnóstico falló: ${d.error}`);
    return;
  }
  const line = d.results.map((r) => `${r.client}:${r.success ? '✅' : '❌'}`).join('  ');
  console.log(`[${index + 1}/${total}] "${d.matchedTitle}" (${d.category}) — ${line}`);
}

function summarize(diagnoses) {
  const withResults = diagnoses.filter((d) => d.results && d.results.length > 0);

  console.log('\n' + '='.repeat(70));
  console.log('TASA DE ÉXITO INDEPENDIENTE POR CLIENTE');
  console.log('(cuántas veces habría resuelto ESE cliente solo, sin importar quién gana normalmente)');
  console.log('='.repeat(70));

  const clientTally = {};
  for (const d of withResults) {
    for (const r of d.results) {
      clientTally[r.client] ??= { success: 0, total: 0 };
      clientTally[r.client].total += 1;
      if (r.success) clientTally[r.client].success += 1;
    }
  }

  for (const [client, { success, total }] of Object.entries(clientTally)) {
    const pct = total > 0 ? ((success / total) * 100).toFixed(0) : '0';
    console.log(`${client.padEnd(12)}: ${success}/${total} (${pct}%)`);
  }

  // La pregunta que realmente importa: cuando IOS falla, ¿hay plan B?
  console.log('\n--- Cuando IOS falla, ¿hay plan B real? ---');
  const tracksWithIos = withResults.filter((d) => d.results.some((r) => r.client === 'IOS'));
  const iosFailures = tracksWithIos.filter((d) => {
    const iosResult = d.results.find((r) => r.client === 'IOS');
    return iosResult && !iosResult.success;
  });

  console.log(`IOS falló en ${iosFailures.length}/${tracksWithIos.length} tracks.`);

  if (iosFailures.length > 0) {
    const withBackup = iosFailures.filter((d) =>
      d.results.some((r) => r.client !== 'IOS' && r.success)
    );
    console.log(
      `De esos ${iosFailures.length}, ${withBackup.length} tuvieron al menos otro cliente que SÍ resolvió (plan B real).`
    );
    const noBackup = iosFailures.length - withBackup.length;
    if (noBackup > 0) {
      console.log(`⚠️  ${noBackup} track(s) fallaron en TODOS los clientes — ningún respaldo los salva.`);
    }
  } else {
    console.log('IOS no falló en ningún track de esta corrida — no hay datos para medir el plan B todavía.');
    console.log('(Esto no prueba que IOS sea 100% confiable, solo que en esta muestra no hubo oportunidad de verlo fallar.)');
  }

  console.log('\n' + '='.repeat(70));
}

async function main() {
  await warmup(BASE_URL);

  console.log(
    `Diagnosticando ${TRACKS.length} tracks contra ${BASE_URL} (probando TODOS los clientes en cada uno)...\n`
  );

  const diagnoses = [];
  for (let i = 0; i < TRACKS.length; i++) {
    const d = await diagnoseOne(TRACKS[i]);
    diagnoses.push(d);
    printTrack(d, i, TRACKS.length);
    await sleep(DELAY_MS);
  }

  summarize(diagnoses);

  const fs = await import('node:fs/promises');
  const filename = `diagnose-result-${Date.now()}.json`;
  await fs.writeFile(filename, JSON.stringify(diagnoses, null, 2), 'utf8');
  console.log(`\nResultado detallado guardado en: ${filename}`);
}

main();
