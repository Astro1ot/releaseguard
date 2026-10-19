# ReleaseGuard

[English](README.md) · Русский

Учебный DevOps-стенд вокруг небольшого магазина цифровых товаров. Показывает путь от образа до проверенного релиза: бизнес-проверка после выката, откат Helm, миграции PostgreSQL, transactional outbox, запасной путь при отказе Redis и алерты.

Это лабораторный проект на синтетических данных, а не production-система. Платежей, пользователей и персональных данных в нём нет.

## Как это устроено

```text
Клиент ──► Nginx (rate limit) ──► API (NestJS) ──► PostgreSQL
                                       │               │
                                       │            outbox
                                       ▼               ▼
                                     Redis         Kafka ──► consumer ──► PostgreSQL
                                   (кеш каталога)    (идемпотентная обработка)

Prometheus ◄── метрики API      Alertmanager ◄── правила алертов      Grafana ◄── Prometheus
```

Релиз идёт так: сборка образа → Helm upgrade → проверка готовности подов → бизнес-проверка (smoke) → при ошибке откат на записанную ревизию.

## Быстрый старт (демо, без инфраструктуры)

Нужны Node.js 22+ и Python 3.11+.

```sh
npm ci
npm run build
npm run demo
```

Откройте http://127.0.0.1:3000. В другом терминале:

```sh
python cli/rg.py smoke
npm test
python -m unittest discover -s tests -v
```

Демо работает в памяти: PostgreSQL, Redis и Kafka отключены, заказы пропадают при перезапуске. Это проверка интерфейса и HTTP-контракта, а не отказоустойчивости.

## Полный стенд

Нужен Docker с Compose v2 (около 4–6 ГБ памяти). На Windows можно дважды нажать `Start-Lab.cmd`.

```sh
python cli/rg.py init-env
docker compose up -d --build --wait --wait-timeout 240
python scripts/integration.py
```

| Адрес | Что это |
|---|---|
| http://127.0.0.1:8080 | Nginx, API с лимитом запросов, страница статуса |
| http://127.0.0.1:3001 | Grafana (`admin`, пароль в `.env`) |
| http://127.0.0.1:9090 | Prometheus |
| http://127.0.0.1:9093 | Alertmanager (локальный получатель) |

## Проверки отказов

```sh
python scripts/drill.py redis
python scripts/drill.py kafka
python scripts/drill.py rate-limit
python scripts/migration_drill.py
```

- **Redis недоступен:** каталог отдаётся из PostgreSQL, готовность не падает, после возврата инцидент закрывается.
- **Kafka недоступна:** заказы сохраняются, после восстановления outbox публикует события, consumer завершает их без дублей.
- **Всплеск запросов:** Nginx отвечает и `200`, и `429`, ошибки API не растут.
- **Миграция PostgreSQL:** DDL под заблокированной таблицей быстро падает по `lock_timeout`, затем безопасно применяется индекс `CONCURRENTLY`.

Результаты пишутся в `artifacts/` в формате JSON.

## Kubernetes и откат

Нужны Docker, kind 0.30, Helm 3.19 и kubectl.

```sh
kind create cluster --name releaseguard --config infra/kind.yaml
docker build -t releaseguard:local .
kind load docker-image releaseguard:local --name releaseguard
python cli/rg.py bootstrap --context kind-releaseguard --namespace rg-local
python scripts/kube_rehearsal.py --context kind-releaseguard --namespace rg-local
```

Репетиция выкатывает релиз с ошибкой в каталоге, бизнес-проверка её ловит, и Helm откатывает релиз на предыдущую ревизию. Затем проверяется восстановление.

## Результаты замеров (лаборатория)

| Проверка | Результат |
|---|---|
| Откат на записанную ревизию | 8,36 с (проверка восстановления 2,11 с) |
| DDL под блокировкой | ошибка примерно за 0,99 с |
| 150 параллельных записей при создании индекса | p95 около 54 мс, невалидных индексов 0 |
| 40 одинаковых запросов на заказ | 1 заказ |
| Отказ Redis | обнаружен за 14,91 с |

Цифры относятся к одному локальному прогону и не являются показателем нагрузки или SLO. Подробности: [docs/verification.md](docs/verification.md).

## CI

GitHub Actions: `Verify` (тесты, проверка чарта, сценарии отказов, откат в kind) и ручной `Publish image` (образ в GHCR с provenance и SBOM). В workflow нет production-доступов.

## Структура

```text
src/            API, кеш, outbox, consumer, статус
cli/            Python-инструмент релиза (plan, deploy, smoke)
charts/         Helm-чарт и values.schema.json
migrations/     миграции PostgreSQL с контрольными суммами
observability/  правила Prometheus и дашборд Grafana
scripts/        проверки отказов и интеграционные тесты
docs/           архитектура, runbook, записи проверок
```

Лицензия: [MIT](LICENSE).
