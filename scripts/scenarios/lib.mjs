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

export function scalarFromVector(body) {
  if (body.status !== 'success') throw new Error(`Prometheus query failed: ${body.error ?? 'unknown error'}`);
  const value = body.data.result[0]?.value?.[1];
  return value === undefined ? null : Number(value);
}

// Keeps the time series behind a scenario's verdict next to its report.
export function saveScenarioMetrics(name, namespace, startedAt) {
  const end = now();
  const sel = `reporter="source",destination_service_namespace="${namespace}"`;
  const queries = {
    requestRateByServiceAndCode: `sum by (destination_service_name, response_code) (rate(istio_requests_total{${sel}}[30s]))`,
    p95LatencyMsByService: `histogram_quantile(0.95, sum by (destination_service_name, le) (rate(istio_request_duration_milliseconds_bucket{${sel}}[30s])))`,
    clientResponsesByVersionAndStatus: `sum by (version, status) (rate(rg_loadgen_responses_total{namespace="${namespace}"}[30s]))`,
  };
  const series = {};
  for (const [key, query] of Object.entries(queries)) {
    try { series[key] = { query, result: promRange(query, startedAt, end) }; }
    catch (error) { series[key] = { query, error: error.message }; }
  }
  writeArtifact(`scenarios/${name}.metrics.json`, { namespace, start: startedAt, end, series });
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

export function routeWeights(virtualService, release) {
  const route = virtualService.spec.http.find(r => r.name === 'primary')?.route ?? [];
  const weightOf = host => route.find(r => r.destination.host === host)?.weight ?? 0;
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

// --- Client-side view from the in-mesh load generator

export function loadgenStats(namespace) {
  const script = "fetch('http://127.0.0.1:9100/stats').then(r=>r.text()).then(t=>console.log(t))";
  return JSON.parse(kubectl(namespace, ['exec', 'deploy/releaseguard-loadgen', '-c', 'loadgen', '--', 'node', '-e', script]).stdout.trim());
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
