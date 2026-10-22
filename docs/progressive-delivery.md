# Progressive delivery: Argo Rollouts + Istio ambient + Gateway API

## Схема

```text
loadgen (in-mesh) ──► Service releaseguard ─┐                       ┌─► Service releaseguard-stable ─► pods v1
                                            ├─► waypoint (Envoy) ───┤   HTTPRoute releaseguard:
loadgen-ingress ──► Gateway releaseguard-   │   istio.io/use-waypoint   weights 100/0 → 90/10 → …
   ingress (istio)   → HTTPRoute → Service ─┘   ingress-use-waypoint └─► Service releaseguard-canary ─► pods v2
                                                                    ▲
Argo Rollouts ── Gateway API plugin (argoproj-labs/gatewayAPI) ─────┘ меняет weight в backendRefs
Prometheus ◄── istio_requests_total / istio_request_duration_milliseconds, reporter="waypoint"
```

- **Ambient.** Namespace `rg-canary` помечен `istio.io/dataplane-mode=ambient`. В подах приложения нет sidecar: L4 и mTLS обеспечивает ztunnel на узле, L7-маршрутизацию — waypoint.
- **Waypoint.** Это Gateway API `Gateway` класса `istio-waypoint` (`releaseguard-waypoint`). Сервис `releaseguard` подключён к нему меткой `istio.io/use-waypoint`.
- **Разделение трафика.** Stable и canary — отдельные Service `releaseguard-stable` и `releaseguard-canary`. Их веса задаются в `HTTPRoute releaseguard`, родитель маршрута — Service `releaseguard` (GAMMA). Маршрут исполняет waypoint для любого вызывающего.
- **Argo Rollouts.** Вместо `trafficRouting.istio` используется `trafficRouting.plugins.argoproj-labs/gatewayAPI`. Плагин меняет только веса `backendRefs` этого HTTPRoute.
- **Второй вход.** Ingress Gateway `releaseguard-ingress` (класс `istio`) направляет `/api/` в Service `releaseguard`. Метка `istio.io/ingress-use-waypoint=true` на Service (вместе с `ENABLE_INGRESS_WAYPOINT_ROUTING=true` у istiod) отправляет этот трафик через тот же waypoint и тот же HTTPRoute. Оба входа обслуживаются одним набором правил.
- **Зависимости вне mesh.** PostgreSQL, Redis и Kafka исключены из mesh меткой пода `istio.io/dataplane-mode: none`.

## Метрики waypoint

- **Reporter.** Waypoint публикует стандартные L7-метрики Istio с `reporter="waypoint"`, а не `source` или `destination`. Так задумано разработчиками Istio ([istio/istio#51313](https://github.com/istio/istio/issues/51313)), хотя в справочнике метрик указаны только `source` и `destination`. Ряды содержат `destination_service_name`, `destination_service_namespace`, `destination_workload`, `source_workload`, `response_code`.
- **Атрибуция при split.** Документация не говорит однозначно, какой сервис попадает в `destination_service_name` при split через HTTPRoute — родительский или backend. Поэтому перед canary-сценариями выполняется `scripts/scenarios/ambient_metrics.mjs`. Он создаёт пробный HTTPRoute 50/50 на два backend Service тех же подов, даёт 400 запросов и проверяет, что waypoint относит запросы к каждому backend. Если ряды достаются родительскому Service, сценарий проваливается: разделить stable и canary по этой метке нельзя, и анализ нужно перестраивать.
- **Остальные проверки.** Тот же сценарий проверяет, что оба входа видны на waypoint (`source_workload` = `releaseguard-loadgen` и `releaseguard-ingress-istio`), что нужные анализу метки существуют, что гистограмма задержки есть и что запросы со стороны stable возвращают значения.
- **Prometheus.** Waypoint и ingress gateway скрейпятся отдельным job (`:15020/stats/prometheus`, поды с меткой `gateway.networking.k8s.io/gateway-name`). Из job аннотаций они исключены, чтобы ряды `istio_*` не дублировались. Метрики приложения в ambient снимаются напрямую с порта 3000, потому что sidecar для объединения метрик нет.

## Анализ (без изменений порогов)

| Метрика | Условие |
|---|---|
| `canary-request-volume` | ≥ 40 запросов к canary за окно 1 мин |
| `canary-error-ratio` | доля 5xx canary ≤ 2 % |
| `canary-error-ratio-vs-stable` | доля 5xx canary − stable ≤ 1 п. п. |
| `canary-p95-latency-ms` | p95 canary ≤ 400 мс |
| `canary-p95-latency-vs-stable-ms` | p95 canary − p95 stable ≤ 200 мс |

Все метрики используют `reporter="waypoint"` (значение задаётся в `progressiveDelivery.analysis.reporter`). Период: старт через 30 с, 4 измерения через 20 с, `failureLimit: 1`, `consecutiveErrorLimit: 2`.

## Что проверяют сценарии canary

| Проверка | promote | errors / latency |
|---|---|---|
| Вес в HTTPRoute | прошёл 10 → 30 → 60, после промоута 100/0 | был 10 до решения, затем 100/0 |
| Фактическая доля canary по каждому входу | на каждой ступени в пределах ±max(5 п. п., 30 % веса) | на ступени 10 % — так же |
| Решение AnalysisRun | все AnalysisRun `Successful` | AnalysisRun `Failed` по `canary-error-ratio` / `canary-p95-latency-ms`, `canary-request-volume` не провален (решение принято по реальному трафику) |
| Возврат на stable | после промоута оба входа получают только новую версию | 30 с после abort ни одного ответа canary ни на одном входе; stable ReplicaSet не изменился |
| Причина | — | аннотация `releaseguard.io/last-abort-reason`, AnalysisRun, отчёт |

## Ограничения

- **Retry.** Политика повторов задаётся в mesh (`meshConfig.defaultHttpRetryPolicy`: только `connect-failure,refused-stream,reset`), потому что в стандартном канале Gateway API у HTTPRoute нет поля retry.
- **Чувствительность порога 2 %.** `canary-errors` подтверждает откат при ~80 % ошибок, но не чувствительность порога 2 %.
- **NetworkPolicy в ambient.** Нужно разрешать HBONE (порт 15008) и SNAT-адрес проб kubelet `169.254.7.127/32`. Это сделано в чарте.
- **Проверка на кластере.** Конфигурация проверена `helm lint/template` и юнит-тестами. Прогон на kind для ambient-схемы ещё не выполнялся.
