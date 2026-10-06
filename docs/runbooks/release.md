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
