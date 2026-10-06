import 'reflect-metadata';
import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, Module, NotFoundException, Param, Post, Res, ServiceUnavailableException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Request, Response, NextFunction } from 'express';
import { resolve } from 'node:path';
import { CatalogCache, createRedis } from './cache';
import { Conflict, Product, ProductNotFound, Store } from './store';
import { StatusTracker } from './status';
import { Broker } from './broker';
import { dependencies, duration, registry, requests } from './metrics';

const demo = process.env.DEMO_MODE === 'true';
const store = new Store(demo);
const redis = demo ? undefined : createRedis();
const cache = new CatalogCache<Product[]>(redis);
const tracker = new StatusTracker();
const broker = !demo && process.env.KAFKA_BROKERS ? new Broker(store.pool!, process.env.KAFKA_BROKERS.split(',')) : undefined;
let draining = false;
let brokerRetry: NodeJS.Timeout | undefined;

@Controller()
class AppController {
  @Get('health/live') live() { return { status: 'alive' }; }
  @Get('health/ready') ready() { if (draining) throw new ServiceUnavailableException('Draining'); return { status: 'ready' }; }
  @Get('api/catalog') async catalog() {
    if (process.env.RELEASE_FAULT === 'catalog-500') throw new ServiceUnavailableException('Injected release regression');
    try { return { products: await cache.get(() => store.catalog()) }; } catch { throw new ServiceUnavailableException('Catalog temporarily unavailable'); }
  }
  @Post('api/orders') @HttpCode(201)
  async order(@Body() body: unknown, @Headers('idempotency-key') key?: string) {
    if (!key || !/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new BadRequestException('Idempotency-Key must contain 8–100 letters, digits, _ or -');
    if (!body || typeof body !== 'object' || !('productId' in body) || typeof body.productId !== 'string' || Object.keys(body).some(k => k !== 'productId')) throw new BadRequestException('Expected { productId: string }');
    try {
      return await store.create(body.productId, key);
    } catch (error) {
      if (error instanceof Conflict) throw new ConflictException(error.message);
      if (error instanceof ProductNotFound) throw new NotFoundException(error.message);
      throw new ServiceUnavailableException('Orders temporarily unavailable');
    }
  }
  @Get('api/orders/:id') async find(@Param('id') id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new BadRequestException('Invalid order ID');
    let order;
    try { order = await store.find(id); } catch { throw new ServiceUnavailableException('Orders temporarily unavailable'); }
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }
  @Get('api/status') status() { return { ...tracker.snapshot(), version: process.env.APP_VERSION ?? 'development', mode: demo ? 'demo / in-memory' : 'infrastructure lab', checkedAt: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), history: 'process-local; resets on restart', disabled: demo ? ['PostgreSQL', 'Redis', 'Kafka'] : [!redis && 'Redis', !broker && 'Kafka'].filter(Boolean) }; }
  @Get('metrics') async metrics(@Res() response: Response) { response.set('Content-Type', registry.contentType).send(await registry.metrics()); }
}
@Module({ controllers: [AppController] })
class AppModule {}

async function probe(name: string, action: () => Promise<unknown>) {
  let ok = true;
  try { await action(); } catch { ok = false; }
  dependencies.set({ component: name }, ok ? 1 : 0); tracker.record(name, ok);
}
async function main() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    const start = performance.now();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/') || req.path === '/api/status') return;
      const route = ['/api/catalog', '/api/orders'].includes(req.path) ? req.path : req.path.startsWith('/api/orders/') ? '/api/orders/:id' : '/api/other';
      requests.inc({ route, method: req.method, status: String(res.statusCode) });
      duration.observe({ route }, (performance.now() - start) / 1000);
      console.log(JSON.stringify({ level: 'info', event: 'http', route, method: req.method, status: res.statusCode, durationMs: Math.round(performance.now() - start) }));
    });
    next();
  });
  app.useStaticAssets(resolve(process.cwd(), 'public'));
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, process.env.HOST ?? '0.0.0.0');
  if (broker) {
    const connect = async () => { try { await broker.start(); } catch { if (!draining) brokerRetry = setTimeout(connect, 5000); } };
    void connect();
  }
  let monitoring = false;
  const monitor = async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      await Promise.all([
        probe('Catalog API', async () => { const r = await fetch(`http://127.0.0.1:${port}/api/catalog`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) throw new Error('Synthetic request failed'); }),
        ...(!demo ? [probe('PostgreSQL', () => store.ping())] : []),
        ...(redis ? [probe('Redis', () => redis.ping())] : []),
        ...(broker ? [probe('Kafka', () => broker.ping())] : []),
      ]);
    } finally { monitoring = false; }
  };
  void monitor(); const timer = setInterval(() => { void monitor(); }, 5000);
  console.log(JSON.stringify({ event: 'started', mode: demo ? 'demo' : 'lab', port }));
  const shutdown = async () => { if (draining) return; draining = true; clearInterval(timer); clearTimeout(brokerRetry); setTimeout(() => process.exit(1), 20000).unref(); await app.close(); await broker?.close(); redis?.disconnect(); await store.close(); };
  process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
}
void main();
