# ReleaseGuard

Стенд релизной инженерии вокруг небольшого API заказов цифровых товаров: canary-выкатка с автоматическим откатом по метрикам, откат Helm, совместимость миграций PostgreSQL со старой версией приложения, отказы Redis, Kafka и API-подов, а также рекомендательный LLM-анализ merge request перед релизом.

> **Авторский демонстрационный проект.** Это не сервис для реальных пользователей: данные синтетические, платежей, учётных записей и персональных данных нет. Проверки выполнялись на локальном стенде (kind и Docker Compose). Приведённые цифры — результаты этих прогонов, а не production-SLO и не оценка нагрузочной способности.

## Архитектура

```text
loadgen (в mesh) ──► Service releaseguard ─┐                    ┌─► releaseguard-stable ─► API v1 ─┐
                                           ├─► waypoint (Envoy) ┤   веса в HTTPRoute               │
loadgen ──► ingress Gateway (istio) ───────┘   ambient: ztunnel  └─► releaseguard-canary ─► API v2 ─┤
                                                                                                    ▼
           Redis (кеш каталога) ◄── API ──► PostgreSQL ── outbox ──► Kafka ──► consumer (идемпотентно)

Argo Rollouts + Gateway API plugin: шаги 10 → 30 → 60 → 100 %, AnalysisTemplate на каждом шаге
Prometheus ◄── метрики waypoint (istio_*, reporter="waypoint") и приложения (rg_*)
```

- **Приложение:** NestJS, PostgreSQL с transactional outbox, Kafka с идемпотентным consumer, Redis как кеш с запасным путём в PostgreSQL.
- **Режим Helm rollback:** чарт `charts/releaseguard` разворачивает Deployment. CLI `cli/rg.py` выполняет `helm upgrade`, бизнес-проверку и откат на записанную ревизию.
- **Режим canary:** `progressiveDelivery.enabled=true`. Вместо Deployment создаются следующие объекты:
  - Rollout;
  - Service stable и canary;
  - waypoint (Gateway класса `istio-waypoint`);
  - HTTPRoute с весами stable/canary;
  - ingress Gateway;
  - AnalysisTemplate.

  Namespace работает в Istio ambient: sidecar в подах нет, L4 обслуживает ztunnel, L7-маршрут исполняет waypoint. Веса в HTTPRoute меняет Argo Rollouts через Gateway API traffic-router plugin. Решение принимает Prometheus по метрикам waypoint, отдельно для stable и canary.
- **Наблюдаемость:** Prometheus, Alertmanager и Grafana в Compose; отдельный Prometheus в kind (`deploy/kind/prometheus.yaml`).

Подробнее: [docs/architecture.md](docs/architecture.md), [docs/progressive-delivery.md](docs/progressive-delivery.md).

## Сценарии проверок

| Сценарий | Что проверяется | Где | Критерий успеха |
|---|---|---|---|
| `ambient-metrics` | Ambient без sidecar, ztunnel и waypoint готовы; метрики waypoint разделяются по backend Service; оба входа идут через waypoint | kind | Пробный split 50/50 даёт по 25–75 % на каждый backend в `destination_service_name`; на waypoint видны оба источника трафика; метки анализа существуют |
| `canary-promote` | Исправная версия проходит все шаги canary | kind | Вес HTTPRoute прошёл 10 → 30 → 60; фактическая доля canary на каждом входе соответствует весу; каждый AnalysisRun успешен; ошибки клиентов ≤ 2 %; после промоута оба входа получают только новую версию |
| `canary-errors` | Версия с ошибкой каталога (`catalog-500`) | kind | AnalysisRun провален по `canary-error-ratio` при достаточном трафике; rollout прерван; HTTPRoute 100/0; оба входа получают только stable; причина сохранена |
| `canary-latency` | Версия с задержкой каталога 900 мс (`catalog-slow`) | kind | Анализ провален по `canary-p95-latency-ms`; те же требования к откату |
| `pod-kill` | Принудительное удаление API-пода под трафиком (25 запросов/с на каждый вход) | kind | Ошибки клиентов на каждом входе ≤ 1 % за 60 с; замена готова за ≤ 120 с; не меньше 500 запросов в окне |
| `migration-compat` | Старая версия приложения на схеме после миграций кандидата | kind | Старые поды работают и перезапускаются; заказы, созданные до миграции, читаются; негативный контроль (переименование столбца) обнаруживается |
| `helm-rollback` | Релиз с ошибкой проходит readiness, но не бизнес-проверку | kind | Helm откатывается на записанную ревизию; заказ после отката доходит до `completed`; команда релиза завершается ошибкой |
| `integration` | Заказ, идемпотентность, конфликт ключа, валидация | Compose | 40 одинаковых запросов дают 1 заказ; конфликт возвращает 409; лишнее поле — 400 |
| `broker-contract`, `consumer-recovery` | Некорректные и повторные сообщения Kafka; падение обработчика | Compose | Карантин без дублей; consumer восстанавливается |
| `drill-redis`, `drill-kafka` | Остановка Redis и Kafka | Compose | Инцидент открыт и закрыт; заказы сохраняются и завершаются после восстановления |
| `drill-rate-limit` | Всплеск запросов через Nginx | Compose | Есть ответы 200 и 429, нет 5xx; `/metrics` и `/health` снаружи недоступны |
| `migration-drill` | DDL под блокировкой и индекс `CONCURRENTLY` под записью | Compose | DDL падает по `lock_timeout`; невалидных индексов 0 |

Пороги kind-сценариев заданы в `deploy/kind/scenarios.json`, пороги canary-анализа — в `charts/releaseguard/values.yaml`.

## Canary: условия анализа

| Параметр | Значение |
|---|---|
| Шаги веса canary | 10 %, 30 %, 60 %, затем 100 % |
| Анализ на каждом шаге | начало через 30 с, 4 измерения с интервалом 20 с, окно PromQL 1 мин |
| Допуск | 1 неуспешное измерение на метрику (`failureLimit: 1`), 2 ошибки запроса подряд |
| Минимум запросов к canary | 40 за окно (`canary-request-volume`) |
| Доля 5xx у canary | ≤ 2 % (`canary-error-ratio`) |
| Доля 5xx canary минус stable | ≤ 1 п. п. (`canary-error-ratio-vs-stable`) |
| p95 задержки canary | ≤ 400 мс (`canary-p95-latency-ms`) |
| p95 canary минус p95 stable | ≤ 200 мс (`canary-p95-latency-vs-stable-ms`) |
| Источник метрик | `istio_requests_total` и `istio_request_duration_milliseconds` waypoint (`reporter="waypoint"`), отдельно по `destination_service_name` = `releaseguard-canary` и `releaseguard-stable`; разделимость проверяется сценарием `ambient-metrics` |

При провале любой метрики Argo Rollouts прерывает rollout, и плагин выставляет в HTTPRoute 100 % на stable. Причина фиксируется в трёх местах:

- **AnalysisRun:** проваленный AnalysisRun остаётся в namespace (хранятся последние 10).
- **Аннотация Rollout:** `releaseguard.io/last-abort-reason` с проваленными метриками и их последними значениями.
- **Отчёт сценария:** `artifacts/scenarios/<сценарий>.json`, рядом временные ряды Prometheus в `<сценарий>.metrics.json`.

## Запуск

### Версии инструментов

| Инструмент | Версия | Где задана |
|---|---|---|
| kind / узел Kubernetes | v0.33.0 / `kindest/node:v1.36.4` (по digest) | `infra/versions.env` |
| kubectl | v1.36.4 | `infra/versions.env` |
| Helm | v3.22.1 | `infra/versions.env` |
| Istio (istioctl, профиль `ambient`: istiod, istio-cni, ztunnel) | 1.31.2 | `infra/versions.env`, `deploy/kind/istio-ambient.yaml` |
| Gateway API CRD (standard) | v1.6.3 | `infra/versions.env` |
| Argo Rollouts | v1.10.1 | `infra/versions.env` |
| Argo Rollouts Gateway API plugin | v0.17.0 (sha256 закреплён) | `infra/versions.env` |
| Prometheus | v3.5.0 | `deploy/kind/prometheus.yaml`, `compose.yaml` |
| PostgreSQL / Redis / Kafka | 17.6 / 7.4.5 / 3.9.1 | чарт и `compose.yaml` |
| Node.js / Python | 22 (образ), 22+ локально / 3.11+ | `Dockerfile`, `package.json` |

`scripts/ci/install-tools.sh` скачивает kind, kubectl, Helm и istioctl этих версий в `.tools/` и сверяет SHA-256 с опубликованными контрольными суммами. Скрипт рассчитан на Linux (amd64/arm64), на Windows — через WSL2.

### Демо без инфраструктуры

```sh
npm ci && npm run build && npm run demo     # http://127.0.0.1:3000, хранилище в памяти
python cli/rg.py smoke
npm test && python -m unittest discover -s tests -v
```

### Compose: зависимости и отказы

```sh
python cli/rg.py init-env
docker compose up -d --build --wait --wait-timeout 240
python scripts/integration.py
python scripts/drill.py redis      # также: kafka, rate-limit
python scripts/migration_drill.py
```

Тот же набор с журналами и JUnit-отчётом: `bash scripts/ci/compose-regression.sh`.

### kind: полный прогон

Нужны Docker и Linux/WSL2. Отдельный кластер `releaseguard` создаётся автоматически.

```sh
bash scripts/ci/install-tools.sh
RG_BASE_REF=origin/main bash scripts/kind/run-all.sh    # предыдущая версия для migration-compat
cat artifacts/report.md
kind delete cluster --name releaseguard
```

`run-all.sh` поднимает стенд (`scripts/kind/up.sh`) и выполняет сценарии по очереди. Сбой одного сценария не останавливает остальные. Перед удалением каждого namespace снимаются манифесты, логи, события и состояние Argo Rollouts (`scripts/kind/collect.sh`). Итог пишется в `artifacts/report.md`, `artifacts/report.json` и `artifacts/junit-scenarios.xml`.

Отдельный сценарий на уже поднятом стенде:

```sh
bash scripts/kind/up.sh
node scripts/scenarios/ambient_metrics.mjs
node scripts/scenarios/canary.mjs --case errors      # promote | errors | latency
node scripts/scenarios/pod_kill.mjs
```

## GitLab CI

`.gitlab-ci.yml` собирает pipeline из следующих стадий:

| Стадия | Job | Содержание |
|---|---|---|
| verify | `unit` | Тесты Node (JUnit и lcov), Python, Ansible, проверка миграций, `helm lint` в обоих режимах, офлайн-проверка guard LLM-анализа |
| regression | `compose-regression` | Существующие сценарии Kafka, Redis, PostgreSQL, rate limit, мониторинг |
| kind | `kind-scenarios` | Изолированный kind-стенд, все kind-сценарии, включая Helm rollback |
| review | `llm-review`, `llm-eval-live` | Необязательный LLM-анализ MR и ручная проверка анализа на демонстрационных PR |
| gate | `release-gate` | Детерминированная проверка обязательных отчётов (`scripts/ci/release-rules.json`) |
| release | `release-image` | Публикация образа в GitLab Registry только после `release-gate` |

Job’ы с Docker-in-Docker требуют runner с privileged-контейнерами. Внутри dind сценарии выполняются в toolbox-контейнере (`ci/toolbox.Dockerfile`) с сетью и путями dind-хоста. Поэтому bind-mount’ы Compose, порты на `127.0.0.1` и адрес API kind работают так же, как на рабочей станции.

Артефакты (`when: always`, 30 дней) сохраняются и при падении job:

- **Отчёты:** JUnit, покрытие, отчёты сценариев.
- **Метрики:** временные ряды Prometheus по каждому сценарию.
- **Манифесты:** `helm get manifest/values` и живые объекты.
- **Журналы:** логи подов и контроллеров, события, `kind export logs`, логи Compose.

## LLM-анализ merge request

Job `llm-review` — необязательный и рекомендательный. Он включается переменной `RG_LLM_REVIEW=true` при заданном `ANTHROPIC_API_KEY`.

На вход модели (`claude-opus-5-5`) передаются:

- diff MR;
- описание задачи и раздел «Критерии приёмки»;
- перечень существующих тестов и сценариев;
- JUnit-результаты этого pipeline;
- покрытие изменённых строк.

Модель формирует:

- риски;
- план бизнес- и технических проверок;
- сопоставление каждого критерия с тестами;
- непокрытые сценарии;
- доработки с указанием файлов.

Результат сохраняется в `artifacts/llm-review/` и публикуется одним обновляемым комментарием к MR, если задан `RG_GITLAB_TOKEN` — project access token с ролью Reporter.

Ограничения, заложенные в реализацию:

- **Модель не принимает решение о релизе.** В схеме ответа нет поля для такого решения. `release-gate` не читает результат анализа, `release-image` от него не зависит.
- **Модель не меняет код.** Job не имеет прав на запись в репозиторий; токен используется только для комментария.
- **Покрытие без доказательств не принимается.** Guard (`scripts/llm/guard.mjs`) засчитывает покрытие критерия, только если тест существует в репозитории и прошёл в этом pipeline. Иначе статус понижается до «не подтверждено» или «не покрыто», а исправление выводится в отчёте.
- **Недоступность LLM не роняет CI.** Отсутствие ключа, сетевая ошибка, отказ модели или обрезанный ответ дают отчёт «LLM-анализ недоступен». Скрипт завершается с кодом 0, job помечен `allow_failure`.

Демонстрационные PR лежат в `examples/pr-review/`:

- **`destructive-migration`:** миграция удаляет столбец, который читает старая версия.
- **`idempotency-key-relaxed`:** при рефакторинге потеряна проверка конфликта ключа, два теста падают.
- **`canary-threshold-weakened`:** пороги анализа ослаблены вопреки критерию приёмки.

```sh
node scripts/llm/eval.mjs           # без модели: guard исправляет заложенные ложные заявления о покрытии
node scripts/llm/eval.mjs --live    # с моделью: плюс проверка, что найдены ожидаемые риски
```

Подробнее: [docs/llm-review.md](docs/llm-review.md).

## Проверка релиза перед выкладкой

`release-gate` (`scripts/ci/release_gate.mjs`, правила в `scripts/ci/release-rules.json`) не пропускает релиз, если нарушено любое из условий:

- **JUnit-отчёты.** `node.xml`, `python.xml` и `junit-scenarios.xml` существуют, содержат тесты и не содержат `failure` или `error`.
- **Отчёты Compose-регрессии.** Присутствуют и успешны: интеграция заказов, некорректные и повторные сообщения Kafka, восстановление consumer, отказ Redis, отказ Kafka, лимит запросов Nginx, миграция под записью, интеграция мониторинга.
- **Сценарии kind.** Успешны все восемь: `stand-setup`, `ambient-metrics`, `canary-promote`, `canary-errors`, `canary-latency`, `pod-kill`, `migration-compat`, `helm-rollback`.

`release-image` зависит только от `release-gate`, поэтому образ не публикуется без прохождения проверок. LLM-анализ в gate не участвует. Gate читает отчёты из `artifacts/` и не сверяет их с коммитом: в pipeline это каталог свежего запуска, при локальном запуске нужно следить за тем, чтобы там не лежали старые отчёты.

## Восстановление после сбоев

- **Redis.** Каталог читается из кеша. Если Redis недоступен, приложение считает обращение сбоем кеша, увеличивает счётчик `cacheFallbacks` и читает каталог из PostgreSQL. Сценарий `drill-redis` останавливает Redis и проверяет: инцидент открыт, `/health/ready` остаётся `ready`, заказ выполняется, после запуска Redis статус возвращается в `operational`.
- **Kafka.** Заказ и событие в таблице `outbox` создаются в одной транзакции PostgreSQL. Пока Kafka недоступна, заказ остаётся `pending`, а событие ждёт в `outbox`. Сценарий `drill-kafka` проверяет статус `pending` во время отказа и затем ожидает перехода заказа в `completed` после восстановления брокера.
- **Незавершённая операция на клиенте.** Страница сохраняет неподтверждённый заказ вместе с исходным ключом идемпотентности и товаром, чтобы после перезагрузки повторный запрос с тем же ключом не создал второй заказ; повреждённое хранилище не превращается в новый заказ молча (`public/order-recovery.mjs`, `tests/order-recovery.test.mjs`).

## Обработка сообщений Kafka

- **Гарантия доставки: at-least-once.** Событие отправляется в Kafka до того, как в `outbox` фиксируется `published_at`. После сбоя в этот момент событие может быть отправлено повторно. Безопасность обеспечивает дедупликация в consumer. Exactly-once не заявляется.
- **Дедупликация.** Идентификатор события записывается в `processed_events` с `ON CONFLICT DO NOTHING`. Повторная доставка не меняет заказ. Сценарий `broker-contract` отправляет событие дважды и проверяет одну запись.
- **Карантин некорректных сообщений.** Невалидный JSON, лишние поля, неверный UUID, размер больше 4096 байт и событие, которого нет в `outbox` (подделка), записываются в `rejected_events` с причиной `invalid_payload` или `unrecognized_event`. Содержимое сообщения не сохраняется. Только после записи offset двигается дальше, поэтому такое сообщение не блокирует поток.
- **Восстановление consumer.** При падении consumer увеличиваются счётчики `consumerCrashes` и `consumerRestarts`, перезапуск выполняется через 2 с. Сценарий `consumer-recovery` блокирует `processed_events`, добивается реального падения и проверяет, что заказ затем доходит до `completed`.

## Что проверено автоматически

Это стенд проекта, а не промышленная система. Проверки двух видов:

- **Автотесты без инфраструктуры:** `npm test` и `python -m unittest discover -s tests`. На момент прогона 2026-10-22: 37 тестов Node и 20 тестов Python, все успешны. Туда же входят `helm lint` в обоих режимах, проверка миграций и офлайн-оценка guard LLM-анализа.
- **Интеграционные сценарии на стенде:** Compose (`scripts/integration.py`, `drill.py`, `migration_drill.py`, `broker_contract`, `consumer_recovery`) и kind (`scripts/kind/run-all.sh`). Им нужны Docker, а для kind ещё Linux или WSL2. Результаты зависят от окружения, поэтому в разделе ниже приведены с датой и условиями прогона.

## Измеренные результаты

### Прогон 2026-10-06

Хост Windows, Docker Desktop (Linux engine), kind 0.30.0, Kubernetes 1.34.0, Helm 3.19.0. Детали — в [docs/verification.md](docs/verification.md).

| Проверка | Стенд | Результат |
|---|---|---|
| Откат релиза с ошибкой на записанную ревизию | kind | 8,36 с, проверка восстановления 2,11 с |
| Отказ Redis | Compose | обнаружен за 14,91 с, заказ выполнен без Redis |
| Отказ Kafka | Compose | обнаружен за 24,34 с, заказ завершён после восстановления, полный цикл 63,48 с |
| DDL под блокировкой | Compose | ошибка `lock_timeout` за 0,99 с |
| 150 записей во время `CREATE INDEX CONCURRENTLY` | Compose | p95 54 мс, невалидных индексов 0 |
| 40 одинаковых запросов на заказ | Compose | 1 заказ |
| Всплеск 200 запросов через Nginx | Compose | 23 ответа 200, 177 ответов 429, 5xx нет |

### Прогон kind 2026-10-22 (Istio ambient + Argo Rollouts)

Хост Windows, Docker Desktop, WSL2 (Ubuntu). Версии: kind v0.33.0, Kubernetes 1.36.4, Istio 1.31.2 (ambient), Gateway API v1.6.3, Argo Rollouts v1.10.1, плагин Gateway API v0.17.0, Helm 3.22.1. Значения взяты из `artifacts/report.md` этого прогона.

| Сценарий | Результат |
|---|---|
| ambient-metrics | пройден: пробный split 50/50 дал 49 % / 51 % по backend; на waypoint видны оба источника трафика (`releaseguard-loadgen`, `releaseguard-ingress-istio`) |
| canary-promote | пройден: promote за 395 с по весам 10/30/60; ошибки клиентов 0 из 9866 (mesh) и 0 из 9865 (ingress) |
| canary-errors | пройден: rollout прерван через 61 с; `canary-error-ratio` ≈ 0,75; после отката ответов canary 0 на обоих входах |
| canary-latency | пройден: rollout прерван через 61 с; p95 canary ≈ 970 мс; после отката ответов canary 0 на обоих входах |
| pod-kill | пройден: замена пода за 8,6 с; ошибки клиентов 0 из 1508 (mesh) и 0 из 1509 (ingress) |
| migration-compat | пройден: старый образ работает на схеме после миграций кандидата |
| helm-rollback | в этом прогоне не запускался (`scripts/setup_kube.py` привязан к кластеру `releaseguard`); результат 2026-10-06 выше получен до перехода на ambient |

Условия, которые нужно учитывать при чтении цифр:

- **Размер выборки.** Один прогон на локальной машине, а не статистика по многим запускам.
- **Медленная сеть.** Контроллер Argo Rollouts скачивает плагин (около 77 МБ) при старте и не отвечает на `/healthz`, пока загрузка не закончилась. При скорости около 0,7 МБ/с liveness-проба перезапускала контроллер по кругу. В этом прогоне задержка пробы была увеличена вручную. На быстром канале это не проверялось.
- **Откат canary.** `canary-errors` подтверждает откат при ~75 % ошибок, чувствительность порога 2 % им не проверяется.

## Структура

```text
src/                 API, кеш, outbox, consumer, статус
cli/                 Python-инструмент релиза: plan, deploy, smoke, bootstrap
charts/releaseguard  Helm-чарт: Deployment или Rollout + waypoint + HTTPRoute + AnalysisTemplate
deploy/kind/         Istio ambient, RBAC плагина, Prometheus, генераторы трафика и пороги сценариев
scripts/kind/        подъём стенда, полный прогон, сбор диагностики
scripts/scenarios/   kind-сценарии и сводный отчёт
scripts/ci/          установка инструментов, dind-обвязка, Compose-регрессия, release gate
scripts/llm/         LLM-анализ MR: контекст, guard, отчёт, комментарий, оценка на примерах
examples/pr-review/  демонстрационные PR с ожидаемыми рисками
migrations/          миграции PostgreSQL с контрольными суммами
observability/       правила Prometheus, Alertmanager, дашборд Grafana
docs/                архитектура, runbook, записи проверок
```

## Ограничения

- Один брокер Kafka без репликации и одна база без резервирования.
- Нет аутентификации.
- Kafka не сохраняет данные на диск.
- Статус-монитор работает внутри процесса приложения.

Перечень и планы — в [docs/architecture.md](docs/architecture.md) и [docs/roadmap.md](docs/roadmap.md). Принудительность NetworkPolicy зависит от CNI. Пороги canary подобраны под синтетическую нагрузку 25 запросов/с и требуют пересмотра для другого профиля трафика.
