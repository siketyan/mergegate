import type { Cache } from "../../core/ports.ts";

interface Entry {
  readonly value: string;
  readonly expiresAt: number;
}

/**
 * A cache that lives as long as the process does. Losing it is always safe: it
 * only ever holds a copy of what GitHub can be asked for again.
 */
export function createMemoryCache(now: () => number = Date.now): Cache {
  const entries = new Map<string, Entry>();

  return {
    get: async (key) => {
      const entry = entries.get(key);
      if (entry === undefined) {
        return null;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    put: async (key, value, ttlSeconds) => {
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    delete: async (key) => {
      entries.delete(key);
    },
  };
}
