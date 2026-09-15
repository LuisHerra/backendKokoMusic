/**
 * Cache L1 en memoria con TTL real (no fijo).
 * Una entrada solo se considera válida si `expiresAt` (Unix ms) es futuro.
 * Esto evita servir URLs de googlevideo.com ya caducadas (parámetro `expire=`).
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;

  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return null;
  }

  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, expiresAt: number): void {
  store.set(key, { value, expiresAt });
}

export function cacheDelete(key: string): boolean {
  return store.delete(key);
}

export function cacheStats() {
  return {
    size: store.size,
    keys: Array.from(store.keys()),
  };
}
