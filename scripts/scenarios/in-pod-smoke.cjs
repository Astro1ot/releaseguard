// Runs inside an API container (`node - <ids>` via kubectl exec). Business smoke against the local
// process: catalog, idempotent order, fulfillment, and re-reading orders created earlier.
const { randomUUID } = require('node:crypto');
const base = 'http://127.0.0.1:3000';
const earlier = process.argv.slice(2);

async function call(path, init = {}) {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(5000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}`);
  return body;
}

(async () => {
  const result = { passed: false, at: new Date().toISOString() };
  try {
    const { products } = await call('/api/catalog');
    if (!products.length) throw new Error('empty catalog');
    const key = randomUUID();
    const post = () => call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ productId: products[0].id }) });
    const first = await post(), second = await post();
    if (first.id !== second.id) throw new Error('idempotency violated');
    const deadline = Date.now() + Number(process.env.SMOKE_TIMEOUT_MS ?? 45000);
    let order = await call('/api/orders/' + first.id);
    while (order.status !== 'completed') {
      if (Date.now() > deadline) throw new Error('order not fulfilled before deadline');
      await new Promise(r => setTimeout(r, 1000));
      order = await call('/api/orders/' + first.id);
    }
    for (const id of earlier) await call('/api/orders/' + id);
    Object.assign(result, { passed: true, orderId: first.id, earlierOrdersRead: earlier.length });
  } catch (error) {
    result.error = error.message;
  }
  console.log(JSON.stringify(result));
})();
