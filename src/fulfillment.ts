import { Pool } from 'pg';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function decodeEvent(key: string | null, raw: string | null): {eventId:string; orderId:string} | undefined {
  if (!key || !uuid.test(key) || raw === null || raw.length > 4096) return;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== 'orderId' ||
        typeof value.orderId !== 'string' || !uuid.test(value.orderId)) return;
    return {eventId:key, orderId:value.orderId};
  } catch { return; }
}

export async function fulfill(pool: Pool, source: {topic:string; partition:number; offset:string}, key: string | null, raw: string | null) {
  const event = decodeEvent(key, raw);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const known = event && (await client.query('SELECT id FROM outbox WHERE id=$1 AND order_id=$2', [event.eventId,event.orderId])).rowCount;
    if (!known) {
      // Persist a bounded diagnostic before allowing Kafka to advance the offset.
      // Payloads and credentials are deliberately not copied to diagnostics.
      await client.query('INSERT INTO rejected_events(topic,partition_id,event_offset,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [source.topic,source.partition,source.offset,event ? 'unrecognized_event' : 'invalid_payload']);
      await client.query('COMMIT');
      return 'rejected';
    }
    const inserted = await client.query('INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id', [event.eventId]);
    if (inserted.rowCount) await client.query("UPDATE orders SET status='completed' WHERE id=$1 AND status='pending'", [event.orderId]);
    await client.query('COMMIT');
    return inserted.rowCount ? 'completed' : 'duplicate';
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
