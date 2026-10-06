CREATE TABLE products (id text PRIMARY KEY, name text NOT NULL, category text NOT NULL, price integer NOT NULL CHECK(price >= 0));
INSERT INTO products VALUES ('asset-01','Orbital icon pack','Design assets',1200),('asset-02','Neon world textures','Game assets',2400),('asset-03','Ambient sound library','Audio',1800);
CREATE TABLE orders (id uuid PRIMARY KEY, product_id text NOT NULL REFERENCES products(id), idempotency_key text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE outbox (id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders(id), payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz);
CREATE TABLE processed_events (event_id uuid PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
