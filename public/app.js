'use strict';
import {STORAGE_KEY, readOrder, confirmOrder, orderLock} from './order-recovery.mjs';
const $ = id => document.getElementById(id);
const names = { operational: 'Operational', degraded: 'Degraded', unknown: 'Observing' };
function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
async function json(path, options = {}) { const response = await fetch(path, { ...options, signal: AbortSignal.timeout(5000) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`); return data; }
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await json('/api/status');
    $('version').textContent = data.version; $('mode').textContent = data.mode;
    $('uptime').textContent = `${Math.floor(data.uptimeSeconds / 60)}m ${data.uptimeSeconds % 60}s`;
    const observations = data.components.map(c => Date.parse(c.checkedAt)).filter(Number.isFinite);
    $('checked').textContent = observations.length ? new Date(Math.min(...observations)).toLocaleTimeString() : 'No checks yet';
    $('banner').className = `status-banner ${data.state}`;
    $('symbol').textContent = data.state === 'operational' ? '✓' : data.state === 'degraded' ? '!' : '◌';
    $('overall').textContent = data.state === 'operational' ? 'Monitored services are operational' : data.state === 'degraded' ? 'A service needs attention' : 'Establishing the baseline';
    $('summary').textContent = data.state === 'operational' ? 'All enabled checks have passed their confirmation window.' : data.state === 'degraded' ? 'A dependency or business probe has failed consecutive checks.' : 'Three consecutive checks confirm a state change.';
    const stale = data.components.some(c => c.stale);
    $('live').textContent = stale ? 'STALE CHECKS' : '● LIVE';
    if (stale) $('summary').textContent = 'Some checks are older than 20 seconds. Waiting for fresh observations.';
    $('components').replaceChildren(...data.components.map(c => {
      const card = el('div', undefined, 'component'); const top = el('div', undefined, 'component-top');
      top.append(el('span', c.name, 'component-name'), el('span', c.name === 'Catalog API' ? '↗' : '◫', 'component-icon'));
      card.append(top, el('div', `● ${c.stale ? 'Stale check' : names[c.state]}`, `component-state ${c.state}`), el('div', undefined, `signal-line ${c.state}`)); return card;
    }));
    $('disabled').textContent = data.disabled.length ? `Not monitored in this mode: ${data.disabled.join(', ')}. No simulated green checks.` : 'Dependency checks are distinct from Kubernetes readiness.';
    $('incident-count').textContent = `${data.incidents.length} events`;
    $('incidents').replaceChildren(...(data.incidents.length ? data.incidents.slice(0, 6).map(i => {
      const item = el('div', undefined, 'incident'); item.append(el('strong', `${i.resolvedAt ? 'Resolved' : 'Investigating'} · ${i.component}`), el('p', i.message), el('time', new Date(i.openedAt).toLocaleString() + (i.resolvedAt ? ` → ${new Date(i.resolvedAt).toLocaleTimeString()}` : ''))); return item;
    }) : [el('div', 'No incidents recorded in this process. The next confirmed failure will appear here.', 'empty')]));
  } catch {
    $('banner').className = 'status-banner unknown'; $('overall').textContent = 'Status feed unavailable'; $('summary').textContent = 'The last observation is stale. Refreshing automatically.'; $('live').textContent = 'STALE'; $('symbol').textContent = '?';
    for (const node of $('components').querySelectorAll('.component-state')) { node.textContent = '● Stale observation'; node.className = 'component-state unknown'; }
    for (const node of $('components').querySelectorAll('.signal-line')) node.className = 'signal-line unknown';
  } finally { refreshing = false; }
}
let orderBusy = false, catalogReady = false, savedOrder = null, storageBroken = false;
function orderControls() {
  const blocked = orderBusy || storageBroken || !navigator.locks;
  $('order').disabled = blocked || (!catalogReady && savedOrder?.status !== 'unknown');
  $('product').disabled = blocked || savedOrder?.status === 'unknown';
  $('order').textContent = savedOrder?.status === 'unknown' ? 'Recover saved order' : 'Create test order ↗';
  $('check-order').disabled = blocked || !savedOrder?.id;
  $('saved-order').textContent = savedOrder ? `Saved: ${savedOrder.productId} · ${savedOrder.status} · key ${savedOrder.key}` : 'No saved order';
}
function syncOrder() {
  try { savedOrder = readOrder(localStorage); storageBroken = false; }
  catch (error) { storageBroken = true; $('order-result').textContent = error.message; }
  orderControls();
}
async function catalog() {
  try {
    const data = await json('/api/catalog');
    $('product').replaceChildren(...data.products.map(p => { const option = el('option', p.name); option.value = p.id; return option; }));
    catalogReady = data.products.length > 0;
  } catch { $('product').replaceChildren(el('option', 'Catalog unavailable — reload to retry')); }
  orderControls();
}
async function inspectOrder() {
  const current = await json(`/api/orders/${savedOrder.id}`);
  confirmOrder(savedOrder, current);
  $('order-result').textContent = `${current.status.toUpperCase()} · ${current.id}` + (current.status === 'pending' ? ' · Still processing. Check status; no new order is needed.' : '');
}
async function orderAction(action) {
  if (orderBusy) return;
  orderBusy = true; orderControls();
  try {
    await orderLock(navigator.locks, async () => {
      syncOrder();
      if (!storageBroken) await action();
    });
  } catch (error) { $('order-result').textContent = error.message + ' Saved requests retain their original key.'; }
  finally { orderBusy = false; syncOrder(); }
}
$('order').addEventListener('click', () => orderAction(async () => {
  if (savedOrder?.status !== 'unknown') {
    const productId = $('product').value;
    if (!catalogReady || !productId) return;
    const draft = {key:crypto.randomUUID(), productId, status:'unknown'};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    savedOrder = draft;
  }
  orderControls();
  $('order-result').textContent = 'Waiting for confirmation of the saved order…';
  const result = await json('/api/orders', {method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':savedOrder.key},body:JSON.stringify({productId:savedOrder.productId})});
  const confirmed = confirmOrder(savedOrder, result);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(confirmed));
  savedOrder = confirmed;
  $('order-result').textContent = `${result.status.toUpperCase()} · ${result.id}`;
  if (result.status === 'pending') {
    try { await inspectOrder(); }
    catch { $('order-result').textContent = `Order ${result.id} was created. Status temporarily unavailable; use Check order status.`; }
  }
}));
$('check-order').addEventListener('click', () => orderAction(async () => { if (savedOrder?.id) await inspectOrder(); }));
window.addEventListener('storage', event => { if (!orderBusy && (event.key === STORAGE_KEY || event.key === null)) syncOrder(); });
syncOrder();
void refresh(); void catalog(); setInterval(refresh, 5000);
