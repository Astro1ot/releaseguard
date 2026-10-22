#!/usr/bin/env bash
# Existing Compose regression scenarios (PostgreSQL, Redis, Kafka, edge, monitoring).
# Every scenario runs even after a failure; logs and evidence are always collected.
set -uo pipefail
cd "$(dirname "$0")/../.."
mkdir -p artifacts/compose
status=0
run() { echo "=== $*"; "$@" || { echo "=== FAILED: $*"; status=1; }; }

[ -f .env ] || python3 cli/rg.py init-env
if docker compose up -d --build --wait --wait-timeout 240; then
  run python3 scripts/integration.py
  run python3 scripts/broker_contract.py
  run python3 scripts/consumer_recovery.py
  run python3 scripts/drill.py redis
  run python3 scripts/drill.py kafka
  run python3 scripts/drill.py rate-limit
  run python3 scripts/migration_drill.py
  run docker compose exec -T prometheus promtool check rules /etc/prometheus/alerts.yml
  run python3 scripts/check_observability.py
else
  echo '=== FAILED: Compose stack did not become healthy'; status=1
fi

docker compose ps -a > artifacts/compose/ps.txt 2>&1
docker compose logs --no-color --timestamps > artifacts/compose/logs.txt 2>&1
docker compose config --no-interpolate > artifacts/compose/compose.resolved.yaml 2>&1
node scripts/ci/evidence_junit.mjs || status=1
docker compose down -v
exit $status
