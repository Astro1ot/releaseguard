// Canary release through Argo Rollouts + Istio, judged by Prometheus.
//   --case promote : healthy version must pass every step and become stable
//   --case errors  : catalog-500 regression must be aborted, traffic returned to stable
//   --case latency : catalog-slow regression must be aborted on the p95 latency threshold
import {
  THRESHOLDS, analysisRunsFor, args, check, diffCounts, helm, kjson, kubectl, loadgenStats, now,
  rolloutState, routeWeights, saveScenarioMetrics, scenario, sleep, waitFor,
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
const weights = () => routeWeights(kjson(ns, ['get', 'virtualservice', release]), release);

await scenario(`canary-${opts.case}`, { ...limits }, async report => {
  // Record the exact analysis definition (thresholds, window, period) used for this verdict.
  report.thresholds.analysis = kjson(ns, ['get', 'analysistemplate', `${release}-canary-health`]).spec.metrics.map(m => ({
    name: m.name, successCondition: m.successCondition, initialDelay: m.initialDelay, interval: m.interval, count: m.count, failureLimit: m.failureLimit, query: m.provider.prometheus.query,
  }));
  report.thresholds.canarySteps = kjson(ns, ['get', 'rollout', release]).spec.strategy.canary.steps;
  const initial = await waitFor('rollout Healthy before the drill', () => { const s = rolloutState(ns, release); return s.phase === 'Healthy' && !s.abort && s; }, { timeoutMs: 300_000 });
  const stableVersion = initial.specVersion;
  report.measured.stableVersion = stableVersion;
  report.measured.canaryVersion = version;
  report.measured.fault = kase.fault;
  check(report, 'traffic starts fully on stable', 'stable=100, canary=0', weights(), weights().stable === 100 && weights().canary === 0);

  const before = loadgenStats(ns);
  const started = Date.now();
  upgrade(version, kase.fault);
  report.timeline.push({ at: now(), event: 'helm upgrade', version, fault: kase.fault });

  let last = '';
  const final = await waitFor(kase.expectAbort ? 'rollout abort' : 'canary promotion', () => {
    const s = rolloutState(ns, release);
    const w = weights();
    const line = `${s.phase}|${s.currentStepIndex}|${w.canary}|${s.abort}|${s.message}`;
    if (line !== last) { last = line; report.timeline.push({ at: now(), phase: s.phase, step: s.currentStepIndex, canaryWeight: w.canary, abort: s.abort, message: s.message }); }
    if (s.abort) return s;
    if (s.phase === 'Healthy' && s.currentPodHash === s.stableRS && s.stableRS !== initial.stableRS) return s;
    return false;
  }, { timeoutMs: limits.maxRolloutMinutes * 60_000, intervalMs: 3000 });
  report.measured.secondsToDecision = Math.round((Date.now() - started) / 1000);
  const duringCanary = diffCounts(before, loadgenStats(ns));
  report.measured.clientTrafficDuringCanary = duringCanary;

  const runs = analysisRunsFor(ns, final.currentPodHash);
  report.evidence.analysisRuns = runs;
  const canaryHash = final.currentPodHash;

  if (!kase.expectAbort) {
    check(report, 'rollout promoted without abort', 'abort=false, phase=Healthy', { abort: final.abort, phase: final.phase }, !final.abort && final.phase === 'Healthy');
    check(report, 'every canary step passed Prometheus analysis', `${kjson(ns, ['get', 'rollout', release]).spec.strategy.canary.steps.filter(s => s.analysis).length} successful runs`,
      runs.map(r => `${r.stepIndex}:${r.phase}`), runs.length > 0 && runs.every(r => r.phase === 'Successful'));
    check(report, 'client error ratio during promotion within limit', `<= ${limits.maxClientErrorRatioDuringPromotion}`, duringCanary.errorRatio,
      duringCanary.errorRatio !== null && duringCanary.errorRatio <= limits.maxClientErrorRatioDuringPromotion);
    const w = weights();
    check(report, 'promoted version receives all traffic via stable service', 'stable=100, canary=0', w, w.stable === 100 && w.canary === 0);
    const windowStart = loadgenStats(ns);
    await sleep(limits.postAbortObservationSeconds * 1000);
    const after = diffCounts(windowStart, loadgenStats(ns));
    report.measured.clientTrafficAfterPromotion = after;
    check(report, 'clients are served only by the promoted version', `only ${version}`, after.byVersion, Object.keys(after.byVersion).every(v => v === version || v === 'none') && (after.byVersion[version] ?? 0) > 0);
  } else {
    check(report, 'rollout aborted by analysis', 'abort=true, phase=Degraded', { abort: final.abort, phase: final.phase, message: final.message }, final.abort && final.phase === 'Degraded');
    const failed = runs.filter(r => r.phase === 'Failed' || r.phase === 'Error');
    const failedMetrics = [...new Set(failed.flatMap(r => r.failedMetrics))];
    check(report, `analysis failed on ${kase.expectedMetric}`, `failed metrics include ${kase.expectedMetric}`, failedMetrics, failedMetrics.includes(kase.expectedMetric));
    const w = await waitFor('canary weight returned to 0', () => { const x = weights(); return x.canary === 0 && x; }, { timeoutMs: 60_000, intervalMs: 2000 });
    check(report, 'all traffic returned to stable', 'stable=100, canary=0', w, w.stable === 100 && w.canary === 0);
    check(report, 'stable ReplicaSet unchanged', initial.stableRS, final.stableRS, final.stableRS === initial.stableRS);

    // Persist the reason in the cluster as well as in the artifacts.
    const reason = { at: now(), canaryVersion: version, canaryPodTemplateHash: canaryHash, rolloutMessage: final.message,
      analysisRun: failed[0]?.name ?? null, failedMetrics: failed.flatMap(r => r.metrics.filter(m => r.failedMetrics.includes(m.name)).map(m => ({ name: m.name, lastValue: m.lastValue, failed: m.failed }))) };
    report.measured.rollbackReason = reason;
    kubectl(ns, ['annotate', 'rollout', release, '--overwrite', `releaseguard.io/last-abort-reason=${JSON.stringify(reason)}`]);
    const stored = kjson(ns, ['get', 'rollout', release]).metadata.annotations?.['releaseguard.io/last-abort-reason'];
    check(report, 'rollback reason stored on the Rollout and failed AnalysisRun retained', 'annotation + AnalysisRun present', { annotation: Boolean(stored), analysisRun: reason.analysisRun }, Boolean(stored) && Boolean(reason.analysisRun));

    await sleep(5000); // in-flight requests started before the weight change
    const windowStart = loadgenStats(ns);
    await sleep(limits.postAbortObservationSeconds * 1000);
    const after = diffCounts(windowStart, loadgenStats(ns));
    report.measured.clientTrafficAfterAbort = after;
    check(report, 'after abort clients reach only the stable version', `0 responses from ${version}`, after.byVersion, (after.byVersion[version] ?? 0) === 0 && (after.byVersion[stableVersion] ?? 0) > 0);
    report.measured.clientErrorsBeforeAbort = { errors: duringCanary.errors, total: duringCanary.total };

    // Return the release definition to the stable version; Argo Rollouts skips analysis for it.
    upgrade(stableVersion, initial.specFault ?? 'none');
    const restored = await waitFor('rollout restored to stable spec', () => { const s = rolloutState(ns, release); return s.phase === 'Healthy' && !s.abort && s.currentPodHash === initial.stableRS && s; }, { timeoutMs: 300_000, intervalMs: 3000 });
    report.timeline.push({ at: now(), event: 'release definition restored', version: restored.specVersion });
    check(report, 'release definition restored to stable', stableVersion, restored.specVersion, restored.specVersion === stableVersion);
  }
  report.evidence.helmHistory = JSON.parse(helm(ns, ['history', release, '-o', 'json']).stdout);
  saveScenarioMetrics(`canary-${opts.case}`, ns, new Date(started - 60_000).toISOString());
});
