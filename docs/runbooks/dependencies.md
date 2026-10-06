# Redis and Kafka

Owner: platform. Alerts: `ReleaseGuardDependency`, `ReleaseGuardLag`.

## Redis

Check dependency probe, `rg_cache_fallback_total`, `rg_cache_load_total`, DB CPU/locks and business p95. Do not make all API pods unready. Verify catalog success while Redis is stopped with `python scripts/drill.py redis`.

The client disables the offline queue and bounds command time. During fallback, each process can load origin once per local TTL. If DB load still grows, cap traffic and scale deliberately; more API replicas can amplify origin load. Do not flush the entire cache to fix a hot key.

After restoring Redis, verify three successful status checks and falling fallback rate. Existing local cache entries may delay Redis reads by a few seconds.

## Kafka

Separate unpublished outbox backlog from consumer lag. An unavailable broker can accumulate events in PostgreSQL before Kafka ever sees them. A live broker with stalled consumers grows committed-offset lag.

Inspect the consumer group in the local container:

```sh
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --group rg.fulfillment --describe
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --topic rg.orders --from-beginning --max-messages 5
```

Do not reset group offsets to hide lag. Check rebalance frequency, partition ownership, DB errors and processing time. Stable event IDs and DB deduplication allow replay without repeating the order update. The lab consumer does not yet include a poison-message dead-letter policy.

The automated drill stops the broker, verifies pending durable orders, restarts it and waits for completion. This is a broker-outage drill, not a dedicated consumer-pause or rebalance benchmark.

## Linux/network diagnosis

Use `ss -lntp` for listeners, `dig SERVICE` for name resolution, and a narrow `tcpdump` filter for handshake/retransmission evidence. Use `strace` only on the relevant process and avoid capturing secrets. On a VM, inspect `systemctl status` and `journalctl -u`; inside Kubernetes inspect pod events and logs.

`REJECT` generally returns an immediate error; `DROP` typically waits for retry/timeouts. Both can look like dependency failure but produce different request latency and connection-pool pressure. Reproduce network faults only in a disposable namespace. No packet-filter changes are automated here.
