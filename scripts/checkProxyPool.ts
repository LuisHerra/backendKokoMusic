/**
 * checkProxyPool.ts — Salud del pool de proxies residenciales
 *
 * Prueba cada proxy de un archivo (formato "ip:puerto:usuario:contraseña",
 * una línea por proxy) contra un video de control, con concurrencia
 * limitada para no generar tráfico agresivo desde las propias IPs que
 * estamos midiendo. Pensado para correr manualmente de vez en cuando (no
 * como parte del servidor) y decidir con datos reales cuántas IPs hacen
 * falta de verdad en la próxima renovación.
 *
 * Uso: npx tsx scripts/checkProxyPool.ts "C:/ruta/al/archivo.txt"
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const TEST_VIDEO_ID = 'dQw4w9WgXcQ'; // video estable y siempre disponible, usado como referencia
const CONCURRENCY = 3;

const filePath = process.argv[2];
if (!filePath) {
  console.error('Uso: npx tsx scripts/checkProxyPool.ts <archivo-de-proxies.txt>');
  process.exit(1);
}

const lines = fs.readFileSync(filePath, 'utf-8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);

interface ProxyEntry {
  raw: string;
  url: string;
}

const proxies: ProxyEntry[] = lines.map((line) => {
  const [host, port, user, pass] = line.split(':');
  return { raw: `${host}:${port}`, url: `http://${user}:${pass}@${host}:${port}` };
});

interface Result {
  proxy: string;
  ok: boolean;
  client?: string;
  ms?: number;
  error?: string;
}

const innertubeServiceUrl = pathToFileURL(path.join(PROJECT_ROOT, 'src/services/innertubeService.ts')).href;
const WORKER_SCRIPT = `
import { resolveAudioStream } from '${innertubeServiceUrl}';
const t0 = Date.now();
try {
  const res = await resolveAudioStream(${JSON.stringify(TEST_VIDEO_ID)});
  console.log(JSON.stringify(res ? { ok: true, client: res.client, ms: Date.now() - t0 } : { ok: false, error: 'null' }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
}
process.exit(0);
`;
// Dentro del propio proyecto (no en os.tmpdir()) — tsx/esbuild decide CJS vs
// ESM según el package.json más cercano; fuera del proyecto no encuentra el
// "type": "module" y falla con "Top-level await is currently not supported
// with the cjs output format".
const scratchDir = path.join(PROJECT_ROOT, '.proxy-check-scratch');
fs.mkdirSync(scratchDir, { recursive: true });
const workerScriptPath = path.join(scratchDir, `worker-${process.pid}.ts`);
fs.writeFileSync(workerScriptPath, WORKER_SCRIPT, 'utf-8');
process.on('exit', () => {
  try { fs.unlinkSync(workerScriptPath); } catch {}
  try { fs.rmdirSync(scratchDir); } catch {}
});

/**
 * Cada proxy se prueba en un subproceso aislado — así cada uno arranca su
 * propia instancia de Innertube con su propio dispatcher global, sin
 * interferir entre sí (el dispatcher de undici es global por proceso).
 */
// Llamamos directamente al .mjs de tsx con node, no al wrapper .bin/tsx.cmd
// — en Windows, ejecutar un .cmd vía execFileSync da EINVAL sin shell:true,
// y shell:true trae su propio aviso de seguridad innecesario aquí.
const tsxCli = path.join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function testOneProxy(proxyUrl: string): Result {
  try {
    const out = execFileSync(process.execPath, [tsxCli, workerScriptPath], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PROXY_URL: proxyUrl },
      timeout: 25_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lastLine = out.trim().split('\n').filter(Boolean).pop() || '{}';
    const parsed = JSON.parse(lastLine);
    return { proxy: proxyUrl, ...parsed };
  } catch (err: any) {
    return { proxy: proxyUrl, ok: false, error: err.message?.slice(0, 100) || 'timeout/error' };
  }
}

async function main() {
  console.log(`Probando ${proxies.length} proxies (concurrencia ${CONCURRENCY}) contra ${TEST_VIDEO_ID}...\n`);
  const results: Result[] = [];
  let idx = 0;

  async function worker() {
    while (idx < proxies.length) {
      const p = proxies[idx++];
      const r = testOneProxy(p.url);
      results.push({ ...r, proxy: p.raw });
      console.log(`${r.ok ? '✅' : '❌'} ${p.raw} — ${r.ok ? `${r.client} (${r.ms}ms)` : r.error}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const working = results.filter((r) => r.ok).length;
  console.log(`\n${working}/${proxies.length} proxies funcionando ahora mismo.`);
}

main();
