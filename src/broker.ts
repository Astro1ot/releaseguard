import { Kafka, Admin, Consumer, Producer, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import { consumerLag, outbox } from './metrics';

export const topic = 'rg.orders';
export const groupId = 'rg.fulfillment';
export class Broker {
  private producer: Producer;
  private consumer: Consumer;
  private admin: Admin;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private closed = false;
  private online = false;
  constructor(private pool: Pool, brokers: string[]) {
    const kafka = new Kafka({ clientId: 'releaseguard', brokers, logLevel: logLevel.NOTHING, connectionTimeout: 1000, requestTimeout: 3000, retry: { retries: 2, initialRetryTime: 300 } });
    this.producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    this.consumer = kafka.consumer({ groupId });
    this.admin = kafka.admin();
  }
  async start() {
    await this.admin.connect();
    await this.admin.createTopics({ topics: [{ topic, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic, fromBeginning: true });
    await this.consumer.run({ eachMessage: async ({ message }) => {
      const event = JSON.parse(message.value!.toString()) as { orderId: string };
      // The business effect and deduplication record commit together.
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query('INSERT INTO processed_events(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id', [message.key!.toString()]);
        if (inserted.rowCount) await client.query("UPDATE orders SET status='completed' WHERE id=$1 AND status='pending'", [event.orderId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } });
    this.online = true;
    this.timer = setInterval(() => { void this.flush(); }, 1000);
  }
  async ping() { if (!this.online) throw new Error('Broker not initialized'); await this.admin.fetchTopicMetadata({ topics: [topic] }); }
  private async flush() {
    if (this.busy || this.closed) return;
    this.busy = true;
    const client = await this.pool.connect().catch(() => undefined);
    if (!client) { this.busy = false; return; }
    try {
      // Measure the durable queue even when publishing to Kafka is failing.
      outbox.set(Number((await client.query('SELECT count(*) FROM outbox WHERE published_at IS NULL')).rows[0].count));
      await client.query('BEGIN');
      const events = await client.query('SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED');
      for (const row of events.rows) {
        await this.producer.send({ topic, messages: [{ key: row.id, value: JSON.stringify(row.payload) }] });
        await client.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
      }
      await client.query('COMMIT');
      outbox.set(Number((await client.query('SELECT count(*) FROM outbox WHERE published_at IS NULL')).rows[0].count));
      const ends = await this.admin.fetchTopicOffsets(topic);
      const committed = (await this.admin.fetchOffsets({ groupId, topics: [topic] }))[0]?.partitions ?? [];
      consumerLag.set(ends.reduce((sum, p) => sum + Math.max(0, Number(p.offset) - Math.max(0, Number(committed.find(c => c.partition === p.partition)?.offset ?? 0))), 0));
    } catch { await client.query('ROLLBACK').catch(() => {}); }
    finally { client.release(); this.busy = false; }
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled([this.consumer.disconnect(), this.producer.disconnect(), this.admin.disconnect()]); }
}
