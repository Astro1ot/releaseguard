import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export interface Product { id: string; name: string; category: string; price: number }
export interface Order { id: string; productId: string; status: string; createdAt: string }
export const products: Product[] = [
  { id: 'asset-01', name: 'Orbital icon pack', category: 'Design assets', price: 1200 },
  { id: 'asset-02', name: 'Neon world textures', category: 'Game assets', price: 2400 },
  { id: 'asset-03', name: 'Ambient sound library', category: 'Audio', price: 1800 },
];
export class Conflict extends Error {}
export class ProductNotFound extends Error {}
export class Store {
  readonly pool?: Pool;
  private orders = new Map<string, Order>();
  private keys = new Map<string, string>();
  constructor(readonly demo: boolean) {
    if (!demo) {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required outside demo mode');
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 1000, statement_timeout: 2000, idleTimeoutMillis: 10000 });
      this.pool.on('error', () => { console.warn(JSON.stringify({ level: 'warn', event: 'postgres_idle_connection_error' })); });
    }
  }
  async ping() { if (this.pool) await this.pool.query('SELECT 1 FROM orders LIMIT 1'); }
  async catalog(): Promise<Product[]> {
    if (!this.pool) return products;
    const result = await this.pool.query('SELECT id, name, category, price FROM products ORDER BY id LIMIT 100');
    return result.rows;
  }
  async create(productId: string, key: string): Promise<Order> {
    if (!this.pool) {
      const existing = this.keys.get(key);
      if (existing) { const order = this.orders.get(existing)!; if (order.productId !== productId) throw new Conflict('Idempotency key reused with different payload'); return order; }
      if (!products.some(p => p.id === productId)) throw new ProductNotFound('Product not found');
      const order = { id: randomUUID(), productId, status: 'completed', createdAt: new Date().toISOString() };
      this.orders.set(order.id, order); this.keys.set(key, order.id); return order;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query('INSERT INTO orders(id, product_id, idempotency_key) SELECT $1,id,$3 FROM products WHERE id=$2 ON CONFLICT(idempotency_key) DO NOTHING RETURNING *', [randomUUID(), productId, key]);
      const row = inserted.rows[0] ?? (await client.query('SELECT * FROM orders WHERE idempotency_key=$1', [key])).rows[0];
      if (!row) throw new ProductNotFound('Product not found');
      if (row.product_id !== productId) throw new Conflict('Idempotency key reused with different payload');
      if (inserted.rowCount) await client.query('INSERT INTO outbox(id, order_id, payload) VALUES($1,$2,$3)', [randomUUID(), row.id, JSON.stringify({ orderId: row.id })]);
      await client.query('COMMIT');
      return { id: row.id, productId: row.product_id, status: row.status, createdAt: row.created_at.toISOString() };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async find(id: string): Promise<Order | undefined> {
    if (!this.pool) return this.orders.get(id);
    const row = (await this.pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    return row && { id: row.id, productId: row.product_id, status: row.status, createdAt: row.created_at.toISOString() };
  }
  async close() { await this.pool?.end(); }
}
