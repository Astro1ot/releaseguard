# Progressive delivery: Argo Rollouts + Istio + Prometheus

## Почему эта связка

- **Argo Rollouts** управляет шагами canary, запускает анализ на каждом шаге и сам выполняет abort с возвратом трафика. Логику отката не нужно писать в CI-скриптах.
- **Istio** в режиме sidecar делит трафик по весам на уровне HTTP-запросов, а не по числу подов. Уже на шаге 10 % canary получает ровно 10 % запросов при 3 репликах.
- **Метрики Envoy** (`istio_requests_total`, `istio_request_duration_milliseconds`) снимаются на стороне клиента (`reporter="source"`). Поэтому в анализ попадают и ответы, которых приложение не успело записать в свои метрики: обрывы соединений, 503 от прокси.
- **Prometheus** хранит одинаковые ряды для `releaseguard-stable` и `releaseguard-canary`. Анализ сравнивает canary с порогом и со stable в одном окне.

## Как устроено в чарте

`progressiveDelivery.enabled=true` (`environments/kind-progressive.yaml`) включает следующие объекты:

| Объект | Назначение |
|---|---|
| `Rollout releaseguard` | Шаблон пода тот же, что у Deployment (`templates/_pod.tpl`). Шаги задаются в `canarySteps`, после каждого `setWeight` идёт `analysis` |
| `Service releaseguard-stable`, `releaseguard-canary` | Argo Rollouts дописывает в селектор `rollouts-pod-template-hash` |
| `VirtualService releaseguard` | Маршрут `primary` с весами stable/canary. Повторы только для транспортных ошибок, чтобы 5xx приложения оставались видимыми анализу |
| `AnalysisTemplate releaseguard-canary-health` | Пять метрик: объём запросов, доля 5xx, доля 5xx относительно stable, p95, p95 относительно stable |
| `NetworkPolicy` | Дополнительно разрешает Prometheus из namespace `monitoring` на порт 15020 |

Зависимости (PostgreSQL, Redis, Kafka) исключены из mesh меткой `sidecar.istio.io/inject: 'false'`. Порты 5432, 6379 и 9092 исключены из перехвата sidecar приложения, иначе init-контейнер миграций стартовал бы до готовности istio-proxy.

## Что происходит при провале

1. Метрика превышает порог больше `failureLimit` раз, или запрос к Prometheus ошибается больше `consecutiveErrorLimit` раз подряд. AnalysisRun получает статус Failed или Error.
2. Argo Rollouts ставит `status.abort=true`, устанавливает вес canary 0 и через `abortScaleDownDelaySeconds` (30 с) масштабирует canary до нуля. Rollout переходит в `Degraded`.
3. Сценарий проверяет, что вес canary 0, stable 100, stable ReplicaSet не изменился и за 30 с после отката ни один ответ не пришёл от canary-версии (по `X-App-Version` в генераторе трафика).
4. Причина записывается в аннотацию `releaseguard.io/last-abort-reason`, в отчёт `artifacts/scenarios/canary-*.json` и в оставшийся в namespace AnalysisRun.
5. Определение релиза возвращается к stable-версии через `helm upgrade`. Argo Rollouts распознаёт шаблон stable и применяет его без шагов анализа.

## Генератор трафика

`deploy/kind/loadgen.mjs` работает внутри mesh (25 запросов/с, 20 % — создание заказа). Он считает ответы по маршруту, коду и версии (`/stats`, `/metrics`). Это клиентская точка зрения для сценариев: сколько ошибок увидели пользователи и какая версия их обслуживала.

## Известные ограничения

- **Чувствительность порогов.** Сценарий `canary-errors` вводит около 80 % ошибок и подтверждает срабатывание отката, но не чувствительность порога 2 %. Ошибку в 3–5 % при 2,5 запроса/с на шаге 10 % статистически трудно отличить от шума за одну минуту.
- **Профиль трафика.** Пороги и окна подобраны под синтетическую нагрузку стенда.
- **Grafana в kind.** В kind нет Grafana, временные ряды сохраняются в артефакты сценариев.
