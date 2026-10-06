import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const requests = new Counter({ name: 'rg_http_requests_total', help: 'Business HTTP responses', labelNames: ['route', 'method', 'status'], registers: [registry] });
export const duration = new Histogram({ name: 'rg_http_duration_seconds', help: 'Business request latency', labelNames: ['route'], buckets: [.01,.025,.05,.1,.25,.5,1,2,5], registers: [registry] });
export const dependencies = new Gauge({ name: 'rg_dependency_up', help: 'Dependency probe result', labelNames: ['component'], registers: [registry] });
export const outbox = new Gauge({ name: 'rg_outbox_pending', help: 'Unpublished events', registers: [registry] });
export const consumerLag = new Gauge({ name: 'rg_consumer_lag', help: 'Broker end offset minus consumer committed offset', registers: [registry] });
export const cacheFallbacks = new Counter({ name: 'rg_cache_fallback_total', help: 'Cache calls using fallback', registers: [registry] });
export const cacheLoads = new Counter({ name: 'rg_cache_load_total', help: 'Cache origin loads', registers: [registry] });

export const rejectedEvents = new Counter({ name:'rg_events_rejected_total', help:'Rejected Kafka deliveries (redelivery may increment again)', registers:[registry] });
export const consumerRestarts = new Counter({name:'rg_consumer_restarts_total',help:'Supervised consumer restart attempts after a terminal crash',registers:[registry]});
export const consumerCrashes = new Counter({name:'rg_consumer_crashes_total',help:'Consumer crashes including automatic library recovery',registers:[registry]});
