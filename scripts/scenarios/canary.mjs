// Canary release through Argo Rollouts (Gateway API plugin) and the Istio ambient waypoint, judged by Prometheus.
//   --case promote : healthy version must pass every step and become stable
//   --case errors  : catalog-500 regression must be aborted, traffic returned to stable
//   --case latency : catalog-slow regression must be aborted on the p95 latency threshold
// For every step the HTTPRoute weight is recorded, and the share of responses actually served by the
// canary is measured separately for both entry points (in-mesh client and ingress gateway).
import {
  ENTRIES, THRESHOLDS, analysisRunsFor, args, check, diffEntries, entryStats, helm, kjson, kubectl, now,
  rolloutState, routeWeights, saveScenarioMetrics, scenario, sleep, versionShare, waitFor,
} from './lib.mjs';

const CASES = {
  promote: { fault: 'none', expectAbort: false },
  errors: { fault: 'catalog-500', expectAbort: true, expectedMetric: 'canary-error-ratio' },
  latency: { fault: 'catalog-slow', expectAbort: true, expectedMetric: 'canary-p95-latency-ms' },
};

const opts = args();
const ns = opts.namespace ?? 'rg-canary';
const release = opts.release ?? 'releaseguard';
const kase = CASES[opts.case];
if (!kase) throw new Error(`--case must be one of ${Object.keys(CASES).join(', ')}`);
const version = opts.version ?? `canary-${opts.case}-${Date.now().toString(36)}`;
const limits = THRESHOLDS.canary;

const upgrade = (appVersion, fault) => helm(ns, ['upgrade', release, 'charts/releaseguard', '-f', 'environments/kind-progressive.yaml',
  '--set-string', `app.version=${appVersion}`, '--set-string', `app.fault=${fault}`]);
const weights = () => routeWeights(kjson(ns, ['get', 'httproutes.gateway.networking.k8s.io', release]), release);
// Observed canary share must be within max(5 pp, 30 % of the weight) of the configured weight.
const shareOk = (share, weight) => share !== null && Math.abs(share - weight) <= Math.max(5, 0.3 * weight);

function checkStepShares(report, windows) {
  report.measured.stepWindows = windows.map(w => ({ weight: w.weight, from: w.startedAt, to: w.endedAt,
    entries: Object.fromEntries(Object.entries(w.traffic).map(([e, d]) => [e, { responses: d.total, canarySharePercent: versionShare(d, version), errors: d.errors }])) }));
  for (const w of windows) {
    for (const entry of Object.keys(ENTRIES)) {
      const d = w.traffic[entry];
      const share = versionShare(d, version);
      check(report, `step ${w.weight} %: ${entry} entry receives the routed canary share`, `${w.weight} % ± ${Math.max(5, 0.3 * w.weight)} pp over >= ${limits.minResponsesPerStepWindow} responses`,
        { sharePercent: share === null ? null : Math.round(share * 10) / 10, responses: d.total }, d.total >= limits.minResponsesPerStepWindow && shareOk(share, w.weight));
    }
  }
}

await scenario(`canary-${opts.case}`, { ...limits }, async report => {
  // Record the exact analysis definition (thresholds, window, period) used for this verdict.
  report.thresholds.analysis = kjson(ns, ['get', 'analysistemplate', `${release}-canary-health`]).spec.metrics.map(m => ({
    name: m.name, successCondition: m.successCondition, initialDelay: m.initialDelay, interval: m.interval, count: m.count, failureLimit: m.failureLimit, query: m.provider.prometheus.query,
  }));
  const steps = kjson(ns, ['get', 'rollout', release]).spec.strategy.canary.steps;
  report.thresholds.canarySteps = steps;
  const stepWeights = steps.filter(s => s.setWeight !== undefined).map(s => s.setWeight);

  const initial = await waitFor('rollout Healthy before the drill', () => { const s = rolloutState(ns, release); return s.phase === 'Healthy' && !s.abort && s; }, { timeoutMs: 300_000 });
  const stableVersion = initial.specVersion;
  Object.assign(report.measured, { stableVersion, canaryVersion: version, fault: kase.fault });
  const w0 = weights();
  check(report, 'HTTPRoute starts fully on stable', 'stable=100, canary=0', w0, w0.stable === 100 && w0.canary === 0);

  const before = entryStats(ns);
  const started = Date.now();
  upgrade(version, kase.fault);
  report.timeline.push({ at: now(), event: 'helm upgrade', version, fault: kase.fault });

  // Poll rollout and route; open a traffic window whenever the canary weight changes.
  const windows = [];
  let open = null, last = '', seenWeights = new Set();
  const closeWindow = () => {
    if (!open) return;
    windows.push({ ...open, endedAt: now(), traffic: diffEntries(open.start, entryStats(ns)) });
    open = null;
  };
  const final = await waitFor(kase.expectAbort ? 'rollout abort' : 'canary promotion', () => {
    const s = rolloutState(ns, release);
    const w = weights();
    const line = `${s.phase}|${s.currentStepIndex}|${w.canary}|${s.abort}|${s.message}`;
    if (line !== last) { last = line; report.timeline.push({ at: now(), phase: s.phase, step: s.currentStepIndex, routeWeights: w, abort: s.abort, message: s.message }); }
    if (w.canary > 0) seenWeights.add(w.canary);
    if (!open || open.weight !== w.canary) {
      closeWindow();
      if (w.canary > 0 && w.canary < 100 && !s.abort) open = { weight: w.canary, startedAt: now(), start: entryStats(ns) };
    }
    if (s.abort) { closeWindow(); return s; }
    if (s.phase === 'Healthy' && s.currentPodHash === s.stableRS && s.stableRS !== initial.stableRS) { closeWindow(); return s; }
    return false;
  }, { timeoutMs: limits.maxRolloutMinutes * 60_000, intervalMs: 3000 });
  report.measured.secondsToDecision = Math.round((Date.now() - started) / 1000);
  report.measured.routeWeightsObserved = [...seenWeights];
  report.measured.clientTrafficDuringCanary = diffEntries(before, entryStats(ns));

  const runs = analysisRunsFor(ns, final.currentPodHash);
  report.evidence.analysisRuns = runs;
  report.measured.analysisDecisions = runs.map(r => ({ run: r.name, step: r.stepIndex, phase: r.phase, failedMetrics: r.failedMetrics, lastValues: Object.fromEntries(r.metrics.map(m => [m.name, m.lastValue])) }));
  const fullWindows = windows.filter(w => Date.parse(w.endedAt) - Date.parse(w.startedAt) >= 30_000);

  if (!kase.expectAbort) {
    check(report, 'rollout promoted without abort', 'abort=false, phase=Healthy', { abort: final.abort, phase: final.phase }, !final.abort && final.phase === 'Healthy');
    check(report, 'HTTPRoute went through every configured canary weight', stepWeights.join(' → '), [...seenWeights], stepWeights.every(w => seenWeights.has(w)));
    check(report, 'AnalysisRun decision: every step Successful', `${stepWeights.length} Successful runs`, runs.map(r => `${r.stepIndex}:${r.phase}`),
      runs.length === stepWeights.length && runs.every(r => r.phase === 'Successful'));
    checkStepShares(report, fullWindows);
    for (const [entry, d] of Object.entries(report.measured.clientTrafficDuringCanary)) {
      check(report, `${entry} entry: client error ratio during promotion`, `<= ${limits.maxClientErrorRatioDuringPromotion}`, d.errorRatio,
        d.errorRatio !== null && d.errorRatio <= limits.maxClientErrorRatioDuringPromotion);
    }
    const w = weights();
    check(report, 'after promotion the HTTPRoute sends everything to the stable Service (now the new version)', 'stable=100, canary=0', w, w.stable === 100 && w.canary === 0);
    const windowStart = entryStats(ns);
    await sleep(limits.postDecisionObservationSeconds * 1000);
    const after = diffEntries(windowStart, entryStats(ns));
    report.measured.clientTrafficAfterPromotion = after;
    for (const [entry, d] of Object.entries(after)) {
      check(report, `${entry} entry served only by the promoted version`, `only ${version}`, d.byVersion,
        Object.keys(d.byVersion).every(v => v === version || v === 'none') && (d.byVersion[version] ?? 0) > 0);
    }
  } else {
    check(report, 'rollout aborted by analysis', 'abort=true, phase=Degraded', { abort: final.abort, phase: final.phase, message: final.message }, final.abort && final.phase === 'Degraded');
    check(report, 'canary received traffic before the decision', `HTTPRoute canary weight ${stepWeights[0]}`, [...seenWeights], seenWeights.has(stepWeights[0]));
    const failed = runs.filter(r => r.phase === 'Failed' || r.phase === 'Error');
    const failedMetrics = [...new Set(failed.flatMap(r => r.failedMetrics))];
    check(report, `AnalysisRun decision: Failed on ${kase.expectedMetric}`, `failed metrics include ${kase.expectedMetric}`, failedMetrics, failedMetrics.includes(kase.expectedMetric));
    const volume = failed[0]?.metrics.find(m => m.name === 'canary-request-volume');
    check(report, 'decision based on real canary traffic, not on missing data', 'canary-request-volume not failed', volume?.phase ?? null, Boolean(volume) && volume.phase !== 'Failed' && volume.phase !== 'Error');
    checkStepShares(report, fullWindows);

    const w = await waitFor('canary weight returned to 0', () => { const x = weights(); return x.canary === 0 && x; }, { timeoutMs: 60_000, intervalMs: 2000 });
    check(report, 'HTTPRoute returned all traffic to stable', 'stable=100, canary=0', w, w.stable === 100 && w.canary === 0);
    check(report, 'stable ReplicaSet unchanged', initial.stableRS, final.stableRS, final.stableRS === initial.stableRS);

    // Persist the reason in the cluster as well as in the artifacts.
    const reason = { at: now(), canaryVersion: version, canaryPodTemplateHash: final.currentPodHash, rolloutMessage: final.message,
      analysisRun: failed[0]?.name ?? null, failedMetrics: failed.flatMap(r => r.metrics.filter(m => r.failedMetrics.includes(m.name)).map(m => ({ name: m.name, lastValue: m.lastValue, failed: m.failed }))) };
    report.measured.rollbackReason = reason;
    kubectl(ns, ['annotate', 'rollout', release, '--overwrite', `releaseguard.io/last-abort-reason=${JSON.stringify(reason)}`]);
    const stored = kjson(ns, ['get', 'rollout', release]).metadata.annotations?.['releaseguard.io/last-abort-reason'];
    check(report, 'rollback reason stored on the Rollout and failed AnalysisRun retained', 'annotation + AnalysisRun present', { annotation: Boolean(stored), analysisRun: reason.analysisRun }, Boolean(stored) && Boolean(reason.analysisRun));

    await sleep(5000); // requests already in flight when the weight changed
    const windowStart = entryStats(ns);
    await sleep(limits.postDecisionObservationSeconds * 1000);
    const after = diffEntries(windowStart, entryStats(ns));
    report.measured.clientTrafficAfterAbort = after;
    for (const [entry, d] of Object.entries(after)) {
      check(report, `${entry} entry back on stable after abort`, `0 responses from ${version}`, d.byVersion, (d.byVersion[version] ?? 0) === 0 && (d.byVersion[stableVersion] ?? 0) > 0);
    }

    // Return the release definition to the stable version; Argo Rollouts applies it without analysis.
    upgrade(stableVersion, initial.specFault ?? 'none');
    const restored = await waitFor('rollout restored to stable spec', () => { const s = rolloutState(ns, release); return s.phase === 'Healthy' && !s.abort && s.currentPodHash === initial.stableRS && s; }, { timeoutMs: 300_000, intervalMs: 3000 });
    report.timeline.push({ at: now(), event: 'release definition restored', version: restored.specVersion });
    check(report, 'release definition restored to stable', stableVersion, restored.specVersion, restored.specVersion === stableVersion);
  }
  report.evidence.helmHistory = JSON.parse(helm(ns, ['history', release, '-o', 'json']).stdout);
  saveScenarioMetrics(`canary-${opts.case}`, ns, new Date(started - 60_000).toISOString());
});
