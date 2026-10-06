import { Kafka, Admin, Consumer, Producer, logLevel } from 'kafkajs';
import { Pool } from 'pg';
import { fulfill } from './fulfillment';
import { consumerLag, outbox, rejectedEvents, consumerRestarts, consumerCrashes } from './metrics';

export const topic = 'rg.orders';
export const groupId = 'rg.fulfillment';
export class Broker {
  private producer: Producer;
  private consumer: Consumer;
  private admin: Admin;
  private timer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private recovering = false;
  private busy = false;
  private closed = false;
  private online = false;
  constructor(private pool: Pool, brokers: string[]) {
    const kafka = new Kafka({ clientId: 'releaseguard', brokers, logLevel: logLevel.NOTHING, connectionTimeout: 1000, requestTimeout: 3000, retry: { retries: 2, initialRetryTime: 300 } });
    // Durable outbox + consumer deduplication provide the business guarantee.
    // Bound transport retries so an outage cannot hold a DB transaction indefinitely.
    this.producer = kafka.producer({ maxInFlightRequests: 1, retry: {retries:2, initialRetryTime:300, maxRetryTime:1000} });
    this.consumer = kafka.consumer({ groupId, sessionTimeout:10000, heartbeatInterval:3000 });
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => { this.online = true; });
    this.consumer.on(this.consumer.events.CRASH, event => {
      consumerCrashes.inc();
      this.online = false;
      console.warn(JSON.stringify({event:'consumer_crash',type:event.payload.error.name,automaticRestart:event.payload.restart}));
      if (!event.payload.restart) this.scheduleRecovery();
    });
    this.admin = kafka.admin();
  }
  async start() {
    await this.admin.connect();
    await this.admin.createTopics({ topics: [{ topic, numPartitions: 3, replicationFactor: 1 }], waitForLeaders: true });
    await this.producer.connect();
    await this.startConsumer();
    this.timer = setInterval(() => { void this.flush(); }, 1000);
  }
  private async startConsumer() {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic, fromBeginning: true });
    await this.consumer.run({ eachMessage: async ({ topic, partition, message }) => {
      const result = await fulfill(this.pool, {topic, partition, offset:message.offset}, message.key?.toString() ?? null, message.value?.toString() ?? null);
      if (result === 'rejected') rejectedEvents.inc();
    } });
  }
  private scheduleRecovery() {
    if (this.closed || this.recoveryTimer || this.recovering) return;
    this.recoveryTimer = setTimeout(async () => {
      this.recoveryTimer = undefined;
      if (this.closed) return;
      this.recovering = true;
      consumerRestarts.inc();
      try { await this.startConsumer(); }
      catch { this.online = false; }
      finally { this.recovering = false; if (!this.online) this.scheduleRecovery(); }
    }, 2000);
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
        await this.producer.send({ topic, timeout:3000, messages: [{ key: row.id, value: JSON.stringify(row.payload) }] });
        await client.query('UPDATE outbox SET published_at=now() WHERE id=$1', [row.id]);
      }
      await client.query('COMMIT');
      outbox.set(Number((await client.query('SELECT count(*) FROM outbox WHERE published_at IS NULL')).rows[0].count));
      const ends = await this.admin.fetchTopicOffsets(topic);
      const committed = (await this.admin.fetchOffsets({ groupId, topics: [topic] }))[0]?.partitions ?? [];
      consumerLag.set(ends.reduce((sum, p) => sum + Math.max(0, Number(p.offset) - Math.max(0, Number(committed.find(c => c.partition === p.partition)?.offset ?? 0))), 0));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn(JSON.stringify({event:'outbox_retry',type:error instanceof Error ? error.name : 'unknown'}));
    }
    finally { client.release(); this.busy = false; }
  }
  async close() { this.closed = true; this.online = false; clearInterval(this.timer); clearTimeout(this.recoveryTimer); await Promise.allSettled([this.consumer.disconnect(), this.producer.disconnect(), this.admin.disconnect()]); }
}
