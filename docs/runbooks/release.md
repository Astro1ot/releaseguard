# Release regression

Owner: platform. Alerts: `ReleaseGuardErrors`, `ReleaseGuardUnavailable`.

1. Run a synthetic catalog request and inspect status, recent release revision, pod events and business metrics. A successful readiness probe is insufficient.
2. Compare the error onset with the rollout. Check dependencies before blaming the image. Preserve release evidence from `artifacts/releases/`.
3. Confirm that the schema changes are additive and the old image is compatible. Do not blindly roll back across a contract migration.
4. `rg.py deploy` automatically restores the previous known deployed revision after a failed business gate. For a manual recovery, inspect `helm history`, then `helm rollback RELEASE REVISION --namespace NS --kube-context CONTEXT --wait --timeout 300s`.
5. Run `python cli/rg.py smoke --url URL`. Confirm error ratio and fulfillment recovery; do not close on pod readiness alone.
6. If rollback verification fails, leave the incident open. Investigate dependency health and schema compatibility; another blind deploy can worsen the situation.

First-install failures have no safe previous release. The CLI reports this instead of inventing a rollback. Inspect the namespace and choose whether to fix forward or uninstall the isolated lab.

Detection target for this exercise: dependency confirmation in roughly 15–25 seconds; release gate failure on the first failed business request. These are design targets, not measured production SLOs.

## Canary mode (Argo Rollouts + Istio)

1. `kubectl -n NS get rollout releaseguard -o jsonpath='{.status.phase} {.status.abort} {.status.message}'` shows whether analysis aborted the release.
2. The reason is in the annotation `releaseguard.io/last-abort-reason` and in the failed AnalysisRun: `kubectl -n NS get analysisruns`, then `-o yaml` for the measurements.
3. After an abort, traffic is already on stable (VirtualService weight canary 0). Do not promote manually. Fix the version, or return the release definition to the stable values with `helm upgrade`; Argo Rollouts then applies it without analysis.
4. Thresholds and the analysis period are in `charts/releaseguard/values.yaml` under `progressiveDelivery.analysis`; changing them is a release-safety change and needs review.
