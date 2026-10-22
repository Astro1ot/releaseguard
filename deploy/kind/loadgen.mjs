// In-mesh traffic generator for canary and pod-failure drills. Its Envoy sidecar applies the
// VirtualService split, so each response is attributed to stable or canary by X-App-Version.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export class Tally {
  constructor() { this.counts = new Map(); this.latencyMs = []; }
  record(route, status, version, ms) {
    const key = `${route}|${status}|${version}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.latencyMs.push(ms); if (this.latencyMs.length > 5000) this.latencyMs.shift();
  }
  snapshot() {
    return { at: new Date().toISOString(), counts: Object.fromEntries(this.counts) };
  }
  metrics() {
    const lines = ['# TYPE rg_loadgen_responses_total counter'];
    for (const [key, value] of this.counts) {
      const [route, status, version] = key.split('|');
      lines.push(`rg_loadgen_responses_total{route="${route}",status="${status}",version="${version}"} ${value}`);
    }
    return lines.join('\n') + '\n';
  }
}

async function hit(tally, target, orderShare) {
  const order = Math.random() < orderShare;
  const route = order ? '/api/orders' : '/api/catalog';
  const started = performance.now();
  let status = '0', version = 'none';
  try {
    const response = await fetch(target + route, order
      ? { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ productId: 'asset-01' }), signal: AbortSignal.timeout(5000) }
      : { signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    status = String(response.status); version = response.headers.get('x-app-version') ?? 'none';
  } catch { /* status 0: connection failure or timeout, as seen by the client */ }
  tally.record(route, status, version, performance.now() - started);
}

function main() {
  const target = process.env.TARGET ?? 'http://releaseguard:3000';
  const rps = Number(process.env.RPS ?? 25);
  const orderShare = Number(process.env.ORDER_SHARE ?? 0.2);
  const tally = new Tally();
  setInterval(() => { void hit(tally, target, orderShare); }, 1000 / rps);
  createServer((req, res) => {
    if (req.url === '/stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(tally.snapshot())); }
    else if (req.url === '/metrics') { res.setHeader('content-type', 'text/plain; version=0.0.4'); res.end(tally.metrics()); }
    else { res.statusCode = 404; res.end(); }
  }).listen(9100);
  console.log(JSON.stringify({ event: 'loadgen_started', target, rps, orderShare }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
