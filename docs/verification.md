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

## Presentation audit

Presenter regression checks now cover invalid JSON shapes/duplicate keys, report
redaction, a second-command launch failure after a successful first command, and
history write failure. A command-launch exception cannot inherit exit code zero
from the previous command. History is replaced atomically and new entries carry
UTC timestamps. Frontend polls have deadlines and cannot overlap; stale states
disable command buttons.

The new `proof-tour` was started through the browser panel and passed all three
real checks: integration, malformed/duplicate Kafka deliveries, and consumer
recovery after database handler failure. See presentation-report.json for the
exported historical result. The report is not a current health guarantee.

## Canary, kind scenarios, GitLab CI and LLM review, 2026-10-22

Environment of this check: Windows host without Docker, kind or kubectl; Node.js 24.19.0; portable Python 3.12.10; Helm 3.19.0 (Windows binary, checksum verified).

Verified locally:

- TypeScript build and 35 Node tests: existing tests plus scenario/report/release-gate logic, load generator counters, LLM context parsing, guard rules, fallback when the model is unavailable, MR note upsert and the three demo merge requests.
- `npm run test:ci` writes `artifacts/junit/node.xml` (35 test cases) and `artifacts/coverage/lcov.info` mapped back to `src/*.ts`.
- 20 Python tests through `scripts/ci/unittest_junit.py`; the runner records failures, errors and skips and exits non-zero on failure.
- `helm lint --strict` for `environments/local.yaml` and `environments/kind-progressive.yaml`; `helm template` for staging and canary mode; a misspelled value is still rejected.
- YAML parsing of `.gitlab-ci.yml` and the kind manifests; every job's stage and `needs` reference exists. `bash -n` for all shell scripts.
- Demo-mode API: `scripts/scenarios/in-pod-smoke.cjs` passed, responses carry `X-App-Version`, `catalog-slow` adds about 0.9 s, the load generator counts responses per version.
- `node scripts/llm/eval.mjs`: the guard corrects every planted unsupported coverage claim in the three demo cases. Writing the cases exposed a defect (the acceptance-criteria heading regex used ASCII-only `\b` and missed «Критерии приёмки»); fixed and covered by a test.
- `scripts/llm/review.mjs` without an API key produces the "unavailable" report and exits 0.

Not executed in this environment: the kind stand (Istio, Argo Rollouts, Prometheus) and all kind scenarios, the Compose regression, the GitLab pipeline itself, and the live LLM review/evaluation. No measured values are claimed for them; see `artifacts/report.md` after a run.

## Migration to Istio ambient + waypoint + Gateway API, 2026-10-22

Sources checked before the change (no cluster available here):

- **Versions:** GitHub release API for Istio (1.31.2), Gateway API (v1.6.3), Argo Rollouts (v1.10.1), the Gateway API plugin (v0.17.0) and kind (v0.33.0, node v1.36.4 digest from the release notes).
- **Plugin checksums:** the plugin release ships no checksums; the SHA-256 of the linux-amd64 and linux-arm64 assets was computed from the downloaded binaries and pinned in `infra/versions.env`.
- **Istio docs:**
  - Istio 1.31 supports Kubernetes 1.32–1.37 (supported-releases page).
  - Waypoint deployment and `istio.io/use-waypoint`; `istio.io/ingress-use-waypoint` requires `ENABLE_INGRESS_WAYPOINT_ROUTING` in istiod, which defaults to false (waypoint usage page).
  - NetworkPolicy in ambient must allow port 15008 and the kubelet probe source `169.254.7.127/32`.
- **Metric labels:** waypoint metrics use `reporter="waypoint"` and carry `destination_service_name` ([istio/istio#51313](https://github.com/istio/istio/issues/51313), maintainer comment). Whether `destination_service_name` names the backend Service of an HTTPRoute split was not confirmed by any source; `scripts/scenarios/ambient_metrics.mjs` now verifies it on the stand before the canary drills.

Verified locally:

- `helm lint --strict` for both overlays.
- `helm template` of the canary overlay renders Rollout (plugin `argoproj-labs/gatewayAPI`), stable/canary Services, the waypoint Gateway, the Service-parent HTTPRoute, the ingress Gateway and its HTTPRoute, and the ambient NetworkPolicy rules.
- YAML parsing of all kind manifests.
- 37 Node tests, including HTTPRoute weight reading, per-entry canary share and the backend-attribution check.

The ambient kind stand and all kind scenarios have not been executed; no results are claimed.
