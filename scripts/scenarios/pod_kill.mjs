// An API pod is force-deleted (no graceful shutdown) while in-mesh traffic continues.
// Pass: client-observed error ratio and recovery time stay within deploy/kind/scenarios.json.
import { THRESHOLDS, args, check, diffCounts, kjson, kubectl, loadgenStats, now, promQuery, rolloutState, saveScenarioMetrics, scenario, sleep, waitFor } from './lib.mjs';

const opts = args();
const ns = opts.namespace ?? 'rg-canary';
const release = opts.release ?? 'releaseguard';
const limits = THRESHOLDS.podKill;

await scenario('pod-kill', limits, async report => {
  const startedAt = now();
  const initial = await waitFor('rollout Healthy', () => { const s = rolloutState(ns, release); return s.phase === 'Healthy' && !s.abort && s.availableReplicas === s.replicas && s; }, { timeoutMs: 300_000 });
  const pods = kjson(ns, ['get', 'pods', '-l', `app=${release}`]).items
    .filter(p => p.status.phase === 'Running' && p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
  if (pods.length < 2) throw new Error(`Need at least 2 ready API pods, found ${pods.length}`);
  const victim = pods[0].metadata.name;
  report.measured.replicas = initial.replicas;
  report.measured.victim = victim;

  const before = loadgenStats(ns);
  const killedAt = Date.now();
  kubectl(ns, ['delete', 'pod', victim, '--grace-period=0', '--force', '--wait=false']);
  report.timeline.push({ at: now(), event: 'pod force-deleted', pod: victim });

  await waitFor('replacement pod ready', () => {
    const s = rolloutState(ns, release);
    const names = kjson(ns, ['get', 'pods', '-l', `app=${release}`]).items.map(p => p.metadata.name);
    return !names.includes(victim) && s.availableReplicas === s.replicas;
  }, { timeoutMs: limits.maxRecoverySeconds * 1000 + 60_000, intervalMs: 2000 });
  const recoverySeconds = (Date.now() - killedAt) / 1000;
  report.timeline.push({ at: now(), event: 'all replicas available' });

  const remaining = limits.observationSeconds * 1000 - (Date.now() - killedAt);
  if (remaining > 0) await sleep(remaining);
  const window = diffCounts(before, loadgenStats(ns));
  report.measured.recoverySeconds = Math.round(recoverySeconds * 10) / 10;
  report.measured.clientTraffic = window;
  const seconds = Math.ceil((Date.now() - killedAt) / 1000) + 5;
  report.measured.server5xxInWindow = promQuery(`sum(increase(istio_requests_total{reporter="source",destination_service_namespace="${ns}",response_code=~"5.."}[${seconds}s])) or vector(0)`);

  check(report, 'enough client requests observed', `>= ${limits.minRequests}`, window.total, window.total >= limits.minRequests);
  check(report, 'client error ratio during pod failure', `<= ${limits.maxClientErrorRatio}`, window.errorRatio, window.errorRatio !== null && window.errorRatio <= limits.maxClientErrorRatio);
  check(report, 'replacement pod ready in time', `<= ${limits.maxRecoverySeconds}s`, report.measured.recoverySeconds, recoverySeconds <= limits.maxRecoverySeconds);
  saveScenarioMetrics('pod-kill', ns, startedAt);
});
