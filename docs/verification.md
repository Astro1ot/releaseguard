# Verification record

Date: 2026-10-06. Windows host, Docker Desktop Linux engine, Node.js 24.19.0 (host) / Node 22 (image), Python 3.13, Helm 3.19.0, kind 0.30.0, Kubernetes 1.34.0.

## Actual infrastructure tests

| Check | Observed result | Evidence |
|---|---|---|
| Container image / full Compose startup | Passed; PostgreSQL, Redis, Kafka, API, edge and monitoring running | Local Docker execution |
| Business integration with real stores | Order completed; 40 concurrent repeats produced one order; payload conflict returned 409; unexpected field returned 400 | [integration.json](evidence/integration.json) |
| Redis outage | Detected in 14.91s; order completed with Redis stopped; incident recovered | [redis.json](evidence/redis.json) |
| Kafka outage | Detected in 24.34s; order stayed pending, then completed; total recovery exercise 63.48s | [kafka.json](evidence/kafka.json) |
| Edge rate limit | 23 responses 200; 177 responses 429; no 5xx; metrics/health paths and case variants returned 404 | [rate-limit.json](evidence/rate-limit.json) |
| PostgreSQL migration | Held lock caused DDL failure in ~0.99s; 150 concurrent writes; p95 ~54ms; zero invalid indexes | [migration.json](evidence/migration.json) |
| Observability | Prometheus scrape up, all 5 rule evaluations healthy, Grafana datasource OK, Alertmanager reachable | [observability.json](evidence/observability.json) |
| Kubernetes install | Real two-node kind cluster, dedicated namespace and lab dependencies | Local Helm install |
| Bad release / rollback | Business gate rejected the release; restored recorded revision; recovery order completed; release command remained failed as intended | [rollback.json](evidence/rollback.json) |

Measurements describe this local synthetic workload, not production SLOs or capacity. Kafka evidence includes a separate read of the same order after recovery to make pending-to-completed explicit.

## Application and source checks

- TypeScript compilation and 5 Node tests passed.
- 16 Python tests passed: 7 release-gate tests with controlled Helm results, 4 actual HTTP process tests in demo mode, 5 local presentation-console boundary tests.
- Both Helm overlays lint/render successfully. Misspelled values are rejected.
- All 29 rendered resources (local and staging with TLS ingress) passed strict Kubernetes 1.33 schema validation. Runtime cluster uses 1.34.
- GitHub workflows passed actionlint; shellcheck was disabled.
- Compose config, migration source review gate and Python bytecode compilation passed.
- npm audit reported zero vulnerabilities for the installed lockfile at check time.
- The browser presentation completed purchase, Redis, Kafka, rate-limit, migration and rollback scenarios through the local console.
- Optional Python integrations passed in a clean Linux/Python 3.12 container: Ansible Vault encryption/decryption, wrong-password rejection and the actual ansible-runner CLI wrapper.

## Defects found and fixed during the full run

1. An old demo process occupied the full stack API port. Stopped it and made the integration script refuse in-memory mode unless --allow-demo is explicitly passed.
2. Docker Desktop exported incomplete multi-architecture references. The preload script now exports only the current architecture before importing into kind.
3. The Helm lab lacked a Kafka Service. Added it and a broker port readiness check; re-ran the business flow and rollback successfully.
4. Initial Kubernetes business checks could retry for too long. Added an overall deadline.

The corrected Kubernetes rehearsal is now part of normal push/PR verification, not only a manual workflow.

## Scope not claimed

[GitHub-hosted verification](https://github.com/Astro1ot/releaseguard/actions/runs/37509813832) passed on 2026-10-06 for commit `cd4eb00`: application/chart tests, full Compose failure drills and the Kubernetes rollback rehearsal all succeeded. GHCR publication remains a separate manual action. NetworkPolicy enforcement, production TLS/DNS-01 automation, persistent independent incident storage, distributed tracing and HA/backup recovery are not claimed as verified features. See architecture.md and roadmap.md.

## Status freshness regression, 2026-10-06

Observations expire after 20 seconds. A stalled probe can no longer leave a
green component indefinitely; returning probes need a new confirmation window.
An unresolved incident survives a monitoring gap without duplication. The UI
shows the oldest actual observation time, labels stale components, and avoids
overlapping status requests. On feed failure it also removes old green signals.

Validation: TypeScript build; 7 Node tests including expiry-boundary and incident
continuity cases; 16 Python HTTP/release-gate/presenter tests; real Compose
integration (fulfillment, concurrent idempotency, conflict and validation).
API image rebuilt and healthy; browser confirmed operational status and actual
observation timestamp. Remote CI for this change is a separate verification.

## Recovery and broker audit, 2026-10-06

- 14 Node tests: order recovery, response matching, Web Locks, store validation, event decoding, quarantine failure rollback and existing status/cache checks.
- 16 Python HTTP/release-gate/presenter tests passed.
- Real Compose integration passed with PostgreSQL, Redis and Kafka.
- `python scripts/broker_contract.py`: malformed and forged events were quarantined, two duplicate deliveries had one business receipt, and the consumer committed past those offsets.
- Six Prometheus rules passed promtool.
- Browser: confirmed order survived reload; PostgreSQL was stopped, a new request remained unknown across reload with product selection disabled, then recovered using the same key after PostgreSQL restarted. The resulting order completed.
- Browser persistence is scoped to one origin/profile. Use the same address consistently. No cross-device deduplication claim is made.

## Broker recovery follow-up

The earlier GitHub run fed5747 failed backlog recovery. Run c7f520d later passed
all GitHub jobs, showing the issue was intermittent. Additional local outage
work exposed connection-acquisition timeouts. Transport retries are now bounded,
the PostgreSQL pool retains warm connections, consumer crashes are observable,
and terminal crashes have supervised recovery. This does not prove a single
root cause for the earlier remote failure.

`python scripts/consumer_recovery.py` observed an actual handler crash under a
processed_events lock and completion after release. `python scripts/drill.py kafka`
then passed: detection 15.96s, total 45.78s, order pending during outage and completed
after recovery. Malformed/duplicate delivery regression also passed again.
