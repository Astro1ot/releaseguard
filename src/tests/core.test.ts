import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, Conflict, ProductNotFound } from '../store';
import { CatalogCache } from '../cache';
import { StatusTracker } from '../status';

test('same idempotency key returns the same order under concurrency', async () => {
  const store = new Store(true);
  const orders = await Promise.all(Array.from({ length: 50 }, () => store.create('asset-01', 'same-key')));
  assert.equal(new Set(orders.map(o => o.id)).size, 1);
  await assert.rejects(() => store.create('asset-02', 'same-key'), Conflict);
});

test('store validates product itself and preserves conflict semantics without catalog cache', async () => {
  const store=new Store(true);
  await assert.rejects(store.create('missing','fresh-key'),ProductNotFound);
  const order=await store.create('asset-01','existing-key');
  await assert.rejects(store.create('missing','existing-key'),Conflict);
  assert.equal((await store.create('asset-01','existing-key')).id,order.id);
});
test('cold cache coalesces concurrent origin reads', async () => {
  const cache = new CatalogCache<number>(); let calls = 0;
  const loader = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return 42; };
  assert.deepEqual(await Promise.all(Array.from({ length: 100 }, () => cache.get(loader))), Array(100).fill(42));
  assert.equal(calls, 1); await cache.get(loader); assert.equal(calls, 1);
});
test('failed origin is retryable and not cached', async () => {
  const cache = new CatalogCache<number>();
  await assert.rejects(() => cache.get(async () => { throw new Error('DB down'); }));
  assert.equal(await cache.get(async () => 7), 7);
});
test('status debounces failure and recovery and closes the same incident', () => {
  const tracker = new StatusTracker(3);
  for (let i = 0; i < 3; i++) tracker.record('Redis', true);
  tracker.record('Redis', false); tracker.record('Redis', false);
  assert.equal(tracker.snapshot().state, 'operational');
  tracker.record('Redis', false); assert.equal(tracker.snapshot().state, 'degraded');
  tracker.record('Redis', false); assert.equal(tracker.snapshot().incidents.length, 1);
  tracker.record('Redis', true); tracker.record('Redis', true); assert.equal(tracker.snapshot().state, 'degraded');
  tracker.record('Redis', true); assert.ok(tracker.snapshot().incidents[0].resolvedAt);
  assert.equal(tracker.snapshot().state, 'operational');
});
test('unknown is not presented as healthy', () => { const tracker = new StatusTracker(); tracker.record('PostgreSQL', true); assert.equal(tracker.snapshot().state, 'unknown'); });

test('expired checks lose green status and require a fresh confirmation window', () => {
  const tracker = new StatusTracker(3, 20000);
  const at = (ms: number) => new Date(ms).toISOString();
  for (const ms of [0, 5000, 10000]) tracker.record('Redis', true, at(ms));
  assert.equal(tracker.snapshot(30000).state, 'operational');
  assert.equal(tracker.snapshot(30001).state, 'unknown');
  assert.equal(tracker.snapshot(30001).components[0].stale, true);
  tracker.record('Redis', true, at(35000));
  assert.equal(tracker.snapshot(35000).state, 'unknown');
  tracker.record('Redis', true, at(40000));
  tracker.record('Redis', true, at(45000));
  assert.equal(tracker.snapshot(45000).state, 'operational');
});

test('a stale incident is neither duplicated nor silently resolved', () => {
  const tracker = new StatusTracker(1, 20000);
  tracker.record('Kafka', false, new Date(0).toISOString());
  assert.equal(tracker.snapshot(21000).state, 'unknown');
  tracker.record('Kafka', false, new Date(25000).toISOString());
  assert.equal(tracker.snapshot(25000).incidents.length, 1);
  assert.equal(tracker.snapshot(25000).incidents[0].resolvedAt, undefined);
  tracker.record('Kafka', true, new Date(30000).toISOString());
  assert.ok(tracker.snapshot(30000).incidents[0].resolvedAt);
});
