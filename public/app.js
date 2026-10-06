'use strict';
const $ = id => document.getElementById(id);
const names = { operational: 'Operational', degraded: 'Degraded', unknown: 'Observing' };
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
async function json(path, options = {}) { const response = await fetch(path, { ...options, signal: AbortSignal.timeout(5000) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`); return data; }
async function refresh() {
  try {
    const data = await json('/api/status');
    $('version').textContent = data.version; $('mode').textContent = data.mode;
    $('uptime').textContent = `${Math.floor(data.uptimeSeconds / 60)}m ${data.uptimeSeconds % 60}s`;
    $('checked').textContent = new Date(data.checkedAt).toLocaleTimeString();
    $('banner').className = `status-banner ${data.state}`;
    $('symbol').textContent = data.state === 'operational' ? '✓' : data.state === 'degraded' ? '!' : '◌';
    $('overall').textContent = data.state === 'operational' ? 'Monitored services are operational' : data.state === 'degraded' ? 'A service needs attention' : 'Establishing the baseline';
    $('summary').textContent = data.state === 'operational' ? 'All enabled checks have passed their confirmation window.' : data.state === 'degraded' ? 'A dependency or business probe has failed consecutive checks.' : 'Three consecutive checks confirm a state change.';
    $('live').textContent = '● LIVE';
    $('components').replaceChildren(...data.components.map(c => {
      const card = el('div', undefined, 'component'); const top = el('div', undefined, 'component-top');
      top.append(el('span', c.name, 'component-name'), el('span', c.name === 'Catalog API' ? '↗' : '◫', 'component-icon'));
      card.append(top, el('div', `● ${names[c.state]}`, `component-state ${c.state}`), el('div', undefined, `signal-line ${c.state}`)); return card;
    }));
    $('disabled').textContent = data.disabled.length ? `Not monitored in this mode: ${data.disabled.join(', ')}. No simulated green checks.` : 'Dependency checks are distinct from Kubernetes readiness.';
    $('incident-count').textContent = `${data.incidents.length} events`;
    $('incidents').replaceChildren(...(data.incidents.length ? data.incidents.slice(0, 6).map(i => {
      const item = el('div', undefined, 'incident'); item.append(el('strong', `${i.resolvedAt ? 'Resolved' : 'Investigating'} · ${i.component}`), el('p', i.message), el('time', new Date(i.openedAt).toLocaleString() + (i.resolvedAt ? ` → ${new Date(i.resolvedAt).toLocaleTimeString()}` : ''))); return item;
    }) : [el('div', 'No incidents recorded in this process. The next confirmed failure will appear here.', 'empty')]));
  } catch {
    $('banner').className = 'status-banner unknown'; $('overall').textContent = 'Status feed unavailable'; $('summary').textContent = 'The last observation is stale. Refreshing automatically.'; $('live').textContent = 'STALE'; $('symbol').textContent = '?';
  }
}
async function catalog() { try { const data = await json('/api/catalog'); $('product').replaceChildren(...data.products.map(p => { const option = el('option', p.name); option.value = p.id; return option; })); $('order').disabled = false; } catch { $('product').replaceChildren(el('option', 'Catalog unavailable — reload to retry')); } }
let pendingKey;
let pendingProduct;
$('order').addEventListener('click', async () => {
  const productId = $('product').value; if (!productId) return;
  if (!pendingKey || pendingProduct !== productId) { pendingKey = crypto.randomUUID(); pendingProduct = productId; }
  $('order').disabled = true;
  try {
    const order = await json('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingKey }, body: JSON.stringify({ productId }) });
    $('order-result').textContent = `${order.status.toUpperCase()} · ${order.id}`; pendingKey = undefined;
    if (order.status === 'pending') {
      for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 1000)); const current = await json(`/api/orders/${order.id}`); $('order-result').textContent = `${current.status.toUpperCase()} · ${current.id}`; if (current.status === 'completed') break; }
    }
  } catch (error) { $('order-result').textContent = `${error.message}. Retry reuses the same key if creation was not confirmed.`; }
  finally { $('order').disabled = false; }
});
void refresh(); void catalog(); setInterval(refresh, 5000);
