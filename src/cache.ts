import Redis from 'ioredis';
import { cacheFallbacks, cacheLoads } from './metrics';

// One origin request per process, even when Redis is down. A short local TTL
// bounds origin load during an outage. Cross-pod coalescing is not claimed.
export class CatalogCache<T> {
  private inflight?: Promise<T>;
  private local?: { value: T; expires: number };
  constructor(private redis?: Redis, private ttlMs = 3000) {}
  async get(loader: () => Promise<T>): Promise<T> {
    if (this.local && this.local.expires > Date.now()) return this.local.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.load(loader).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async load(loader: () => Promise<T>): Promise<T> {
    try {
      if (this.redis) {
        const cached = await this.redis.get('rg:catalog:v1');
        if (cached) { const value = JSON.parse(cached) as T; this.local = { value, expires: Date.now() + this.ttlMs }; return value; }
      }
    } catch { cacheFallbacks.inc(); }
    cacheLoads.inc();
    const value = await loader();
    this.local = { value, expires: Date.now() + this.ttlMs };
    try { await this.redis?.set('rg:catalog:v1', JSON.stringify(value), 'EX', 25 + Math.floor(Math.random() * 10)); } catch { cacheFallbacks.inc(); }
    return value;
  }
}
export function createRedis(): Redis | undefined {
  if (!process.env.REDIS_URL) return undefined;
  const redis = new Redis(process.env.REDIS_URL, { connectTimeout: 500, commandTimeout: 500, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: n => Math.min(2000, n * 200) + Math.floor(Math.random() * 200) });
  redis.on('error', () => {}); // Dependency monitor reports availability; no credential-bearing error dump.
  return redis;
}
