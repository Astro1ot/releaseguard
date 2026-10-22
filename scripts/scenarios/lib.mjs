// Shared helpers for kind scenarios: kubectl/helm calls, Prometheus queries through the
// API server proxy, and a report format every scenario writes to artifacts/scenarios/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ARTIFACTS = resolve(ROOT, process.env.RG_ARTIFACTS ?? 'artifacts');
export const CONTEXT = process.env.RG_KUBE_CONTEXT ?? 'kind-releaseguard';
export const THRESHOLDS = JSON.parse(readFileSync(resolve(ROOT, 'deploy/kind/scenarios.json'), 'utf8'));

export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) throw new Error(`Unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return out;
}

export function run(command, commandArgs, { input, allowFailure = false, timeoutMs = 600_000 } = {}) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${commandArgs.slice(0, 4).join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim().slice(-1500)}`);
  }
  return result;
}

export const kubectl = (namespace, kubeArgs, options) => run('kubectl', ['--context', CONTEXT, ...(namespace ? ['-n', namespace] : []), ...kubeArgs], options);
export const kjson = (namespace, kubeArgs) => JSON.parse(kubectl(namespace, [...kubeArgs, '-o', 'json']).stdout);
export const helm = (namespace, helmArgs, options) => run('helm', [...helmArgs, '--namespace', namespace, '--kube-context', CONTEXT], options);

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const now = () => new Date().toISOString();

export async function waitFor(describe, probe, { timeoutMs, intervalMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for: ${describe}`);
    await sleep(intervalMs);
  }
}

// --- Prometheus (through the Kubernetes API server service proxy; no port-forward needed)

const PROM = '/api/v1/namespaces/monitoring/services/prometheus:9090/proxy/api/v1';

export function promQuery(query) {
  const body = JSON.parse(kubectl(null, ['get', '--raw', `${PROM}/query?${new URLSearchParams({ query })}`]).stdout);
  return scalarFromVector(body);
}

export function promRange(query, startIso, endIso, step = '5s') {
  const params = new URLSearchParams({ query, start: startIso, end: endIso, step });
  return JSON.parse(kubectl(null, ['get', '--raw', `${PROM}/query_range?${params}`]).stdout).data?.result ?? [];
}

export function promSeries(match) {
  const body = JSON.parse(kubectl(null, ['get', '--raw', `${PROM}/series?${new URLSearchParams({ 'match[]': match, start: String(Math.floor(Date.now() / 1000) - 600) })}`]).stdout);
  if (body.status !== 'success') throw new Error(`Prometheus series query failed: ${body.error ?? 'unknown error'}`);
  return body.data;
}

export function promVector(query) {
  const body = JSON.parse(kubectl(null, ['get', '--raw', `${PROM}/query?${new URLSearchParams({ query })}`]).stdout);
  if (body.status !== 'success') throw new Error(`Prometheus query failed: ${body.error ?? 'unknown error'}`);
  return body.data.result.map(r => ({ labels: r.metric, value: Number(r.value[1]) }));
}

export function scalarFromVector(body) {
  if (body.status !== 'success') throw new Error(`Prometheus query failed: ${body.error ?? 'unknown error'}`);
  const value = body.data.result[0]?.value?.[1];
  return value === undefined ? null : Number(value);
}

// Keeps the time series behind a scenario's verdict next to its report.
export function saveScenarioMetrics(name, namespace, startedAt) {
  const end = now();
  const sel = `reporter="waypoint",destination_service_namespace="${namespace}"`;
  const queries = {
    waypointRequestRateByServiceAndCode: `sum by (destination_service_name, response_code) (rate(istio_requests_total{${sel}}[30s]))`,
    waypointRequestRateBySource: `sum by (source_workload, destination_service_name) (rate(istio_requests_total{${sel}}[30s]))`,
    waypointP95LatencyMsByService: `histogram_quantile(0.95, sum by (destination_service_name, le) (rate(istio_request_duration_milliseconds_bucket{${sel}}[30s])))`,
    clientResponsesByEntryVersionAndStatus: `sum by (app, version, status) (rate(rg_loadgen_responses_total{namespace="${namespace}"}[30s]))`,
  };
  const series = {};
  for (const [key, query] of Object.entries(queries)) {
    try { series[key] = { query, result: promRange(query, startedAt, end) }; }
    catch (error) { series[key] = { query, error: error.message }; }
  }
  writeArtifact(`scenarios/${name}.metrics.json`, { namespace, start: startedAt, end, series });
}

// Share of waypoint requests per backend Service of a probe split; the parent Service must not absorb them.
export function evaluateProbeSplit(rows, parent, backends) {
  const byService = Object.fromEntries(rows.map(r => [r.labels.destination_service_name, r.value]));
  const total = backends.reduce((n, b) => n + (byService[b] ?? 0), 0);
  const shares = Object.fromEntries(backends.map(b => [b, total ? (100 * (byService[b] ?? 0)) / total : 0]));
  return { byService, total, shares, attributedToBackends: total > 0 && backends.every(b => shares[b] >= 25 && shares[b] <= 75), parentSeen: (byService[parent] ?? 0) > 0 };
}

// --- Cluster state readers

export function rolloutState(namespace, name) {
  const rollout = kjson(namespace, ['get', 'rollout', name]);
  return summarizeRollout(rollout);
}

export function summarizeRollout(rollout) {
  const status = rollout.status ?? {};
  const env = rollout.spec?.template?.spec?.containers?.find(c => c.name === 'api')?.env ?? [];
  return {
    phase: status.phase ?? 'Unknown',
    message: status.message ?? '',
    abort: Boolean(status.abort),
    stableRS: status.stableRS ?? null,
    currentPodHash: status.currentPodHash ?? null,
    currentStepIndex: status.currentStepIndex ?? null,
    replicas: rollout.spec?.replicas ?? null,
    availableReplicas: status.availableReplicas ?? 0,
    specVersion: env.find(e => e.name === 'APP_VERSION')?.value ?? null,
    specFault: env.find(e => e.name === 'RELEASE_FAULT')?.value ?? null,
  };
}

// Backend weights of the canary HTTPRoute, as set by the Argo Rollouts Gateway API plugin.
export function routeWeights(httpRoute, release) {
  const refs = (httpRoute.spec.rules ?? []).flatMap(r => r.backendRefs ?? []);
  const weightOf = name => refs.find(b => b.name === name)?.weight ?? 0;
  return { stable: weightOf(`${release}-stable`), canary: weightOf(`${release}-canary`) };
}

export function summarizeAnalysisRun(run) {
  const metrics = (run.status?.metricResults ?? []).map(m => {
    const last = m.measurements?.at(-1);
    return { name: m.name, phase: m.phase, successful: m.successful ?? 0, failed: m.failed ?? 0, errors: m.error ?? 0,
      lastValue: last?.value ?? null, message: m.message ?? last?.message ?? null };
  });
  return {
    name: run.metadata.name, phase: run.status?.phase ?? 'Unknown', message: run.status?.message ?? null,
    podTemplateHash: run.metadata.labels?.['rollouts-pod-template-hash'] ?? null,
    stepIndex: run.metadata.labels?.['step-index'] ?? null,
    failedMetrics: metrics.filter(m => m.phase === 'Failed' || m.phase === 'Error').map(m => m.name),
    metrics,
  };
}

export function analysisRunsFor(namespace, podTemplateHash) {
  const list = kjson(namespace, ['get', 'analysisruns']);
  return list.items
    .filter(r => r.metadata.labels?.['rollouts-pod-template-hash'] === podTemplateHash)
    .sort((a, b) => a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp))
    .map(summarizeAnalysisRun);
}

// --- Client-side view from the load generators (one per entry point)

export const ENTRIES = { mesh: 'releaseguard-loadgen', ingress: 'releaseguard-loadgen-ingress' };

export function loadgenStats(namespace, deployment = ENTRIES.mesh) {
  const script = "fetch('http://127.0.0.1:9100/stats').then(r=>r.text()).then(t=>console.log(t))";
  return JSON.parse(kubectl(namespace, ['exec', `deploy/${deployment}`, '-c', 'loadgen', '--', 'node', '-e', script]).stdout.trim());
}

export function entryStats(namespace) {
  return Object.fromEntries(Object.entries(ENTRIES).map(([entry, deployment]) => [entry, loadgenStats(namespace, deployment)]));
}

export function diffEntries(before, after) {
  return Object.fromEntries(Object.keys(after).map(entry => [entry, diffCounts(before[entry], after[entry])]));
}

// Share of an entry's responses served by the given version, in percent.
export function versionShare(window, version) {
  const served = Object.entries(window.byVersion).filter(([v]) => v !== 'none').reduce((n, [, c]) => n + c, 0);
  return served ? (100 * (window.byVersion[version] ?? 0)) / served : null;
}

export function diffCounts(before, after) {
  const byStatus = {}, byVersion = {};
  let total = 0, errors = 0;
  for (const [key, value] of Object.entries(after.counts)) {
    const delta = value - (before.counts[key] ?? 0);
    if (delta <= 0) continue;
    const [, status, version] = key.split('|');
    total += delta;
    byStatus[status] = (byStatus[status] ?? 0) + delta;
    byVersion[version] = (byVersion[version] ?? 0) + delta;
    if (status === '0' || status.startsWith('5')) errors += delta;
  }
  return { from: before.at, to: after.at, total, errors, errorRatio: total ? errors / total : null, byStatus, byVersion };
}

// --- Reports

export function writeArtifact(relative, data) {
  const path = resolve(ARTIFACTS, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return path;
}

export function check(report, name, expected, observed, passed) {
  report.checks.push({ name, expected, observed, passed: Boolean(passed) });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}: observed ${JSON.stringify(observed)}, expected ${expected}`);
  return Boolean(passed);
}

export function finalize(report) {
  report.finishedAt = now();
  report.durationSeconds = Math.round((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000);
  report.passed = report.checks.length > 0 && report.checks.every(c => c.passed);
  const failed = report.checks.filter(c => !c.passed).map(c => c.name);
  report.failedChecks = failed;
  return report;
}

export async function scenario(name, thresholds, body) {
  const report = { scenario: name, startedAt: now(), context: CONTEXT, thresholds, checks: [], timeline: [], measured: {}, evidence: {} };
  try {
    await body(report);
  } catch (error) {
    report.error = error.message;
    check(report, 'scenario finished without an execution error', 'no error', error.message, false);
  } finally {
    finalize(report);
    writeArtifact(`scenarios/${name}.json`, report);
    console.log(`${name}: ${report.passed ? 'PASSED' : 'FAILED'}${report.failedChecks.length ? ' — ' + report.failedChecks.join('; ') : ''}`);
    process.exitCode = report.passed ? 0 : 1;
  }
  return report;
}
