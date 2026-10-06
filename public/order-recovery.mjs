export const STORAGE_KEY = 'releaseguard.order.v1';
export function readOrder(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw Error('Saved order is damaged; do not clear storage before checking the order.'); }
  if (!value || !/^[A-Za-z0-9_-]{8,100}$/.test(value.key ?? '') || typeof value.key !== 'string' ||
      typeof value.productId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.productId) ||
      !['unknown', 'confirmed'].includes(value.status) ||
      (value.status === 'confirmed' && !validId(value.id))) throw Error('Saved order is invalid; check it before creating another.');
  return value;
}
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function confirmOrder(draft, response) {
  if (!response || !validId(response.id) || response.productId !== draft.productId ||
      !['pending', 'completed'].includes(response.status) ||
      (draft.id && draft.id !== response.id)) throw Error('Order response does not match the saved request.');
  return {...draft, id:response.id, status:'confirmed'};
}
export async function orderLock(locks, action) {
  if (!locks?.request) throw Error('This browser needs Web Locks on localhost to safely create orders.');
  return locks.request('releaseguard.order', {ifAvailable:true}, async lock => {
    if (!lock) throw Error('An order is running in another tab. Wait for its result.');
    return action();
  });
}
