import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, Conflict } from '../store';
import { CatalogCache } from '../cache';
import { StatusTracker } from '../status';

test('same idempotency key returns the same order under concurrency', async () => {
  const store = new Store(true);
  const orders = await Promise.all(Array.from({ length: 50 }, () => store.create('asset-01', 'same-key')));
  assert.equal(new Set(orders.map(o => o.id)).size, 1);
  await assert.rejects(() => store.create('asset-02', 'same-key'), Conflict);
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
