export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Agrega ?key=... a una URL si hay API_KEY configurada en el entorno del
 * script (misma variable que configurás como Secret en el Space). Si no
 * hay API_KEY, devuelve la URL tal cual — para uso local sin protección.
 */
export function withKey(url) {
  const key = process.env.API_KEY;
  if (!key) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}key=${encodeURIComponent(key)}`;
}

/**
 * Fuerza a que la instancia perezosa de Innertube.create() del backend
 * termine de inicializarse ANTES de empezar a medir nada.
 *
 * Sin esto, el primer request real de la corrida carga con el costo de
 * arranque (llamada de red para traer el reproductor de YouTube) y
 * contamina la primera medición — o directamente falla, como pasó con
 * el "fetch failed" en el primer track de la corrida anterior.
 */
export async function warmup(baseUrl) {
  console.log('Calentando el servidor (esperando a que InnerTube termine de inicializar)...');
  try {
    await fetch(withKey(`${baseUrl}/api/search?q=warmup+ping+test`));
  } catch {
    // si el warmup en sí falla, seguimos igual — el bucle real ya maneja errores
  }
  await sleep(2000); // buffer extra de cortesía
  console.log('Listo.\n');
}

export async function searchFirstResult(baseUrl, query) {
  const res = await fetch(withKey(`${baseUrl}/api/search?q=${encodeURIComponent(query)}`));
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const first = body?.results?.[0];
  return first ? { id: first.id, matchedTitle: first.title } : null;
}

export async function purgeCache(baseUrl, id) {
  try {
    await fetch(withKey(`${baseUrl}/api/stream/${id}/cache`), { method: 'DELETE' });
  } catch {
    // no es crítico si la purga falla
  }
}
