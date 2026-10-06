# Scope and next steps

## v0.1 — implemented

- NestJS catalog/orders API, idempotency, PostgreSQL transactional outbox and Kafka consumer deduplication.
- Redis deadlines, disabled offline queue, jitter and per-process single-flight fallback.
- Live status UI with confirmed state transitions and an explicit demo mode.
- Helm chart, strict schema, local/staging overlays and lab dependencies.
- Python plan/deploy/smoke/bootstrap commands with verified rollback and evidence.
- Reusable GitHub workflow, Compose drills and Kubernetes rehearsal on pushes and PRs.
- Prometheus/Grafana/Alertmanager configuration; runbooks.
- Additive migrations, concurrent indexes, checksums and migration review gate.
- Optional ansible-runner wrapper and Vault API example.

See verification.md for which parts have actually run in the build environment.

## Next priorities

1. Extend the successful GitHub-hosted verification with versioned release evidence and image publication.
2. Move status aggregation into a separate service with durable incident storage, outside the application's failure domain.
3. Separate API/publisher/consumer, add a consumer-pause/rebalance drill and independent worker lifecycles. Poison-message quarantine is now implemented and covered by a real Kafka regression.
4. Add replicated persistent Kafka, database backup/restore rehearsal and retention jobs.
5. Add end-to-end tracing and distinguish synthetic traffic from customer SLOs.
6. Add a provider-specific Terraform/Deckhouse adapter, cert-manager DNS-01, expiry alerts and reviewed secret integration.

These are future work, not hidden prerequisites for the local demo.
