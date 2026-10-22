import test from 'node:test';
import assert from 'node:assert/strict';
import { diffCounts, routeWeights, summarizeAnalysisRun, summarizeRollout, scalarFromVector } from '../scripts/scenarios/lib.mjs';
import { collect, toJunit, toMarkdown } from '../scripts/scenarios/report.mjs';
import { evaluateGate, junitTotals, matches } from '../scripts/ci/release_gate.mjs';
import { Tally } from '../deploy/kind/loadgen.mjs';

test('client window counts only new responses and treats 5xx and connection failures as errors', () => {
  const before = { at: 't0', counts: { '/api/catalog|200|v1': 10, '/api/orders|201|v1': 2 } };
  const after = { at: 't1', counts: { '/api/catalog|200|v1': 30, '/api/orders|201|v1': 2, '/api/catalog|503|v2': 3, '/api/catalog|0|none': 1 } };
  const d = diffCounts(before, after);
  assert.equal(d.total, 24);
  assert.equal(d.errors, 4);
  assert.deepEqual(d.byVersion, { v1: 20, v2: 3, none: 1 });
  assert.equal(diffCounts(after, after).errorRatio, null);
});

test('load generator exposes per-version counters for Prometheus and snapshots', () => {
  const t = new Tally();
  t.record('/api/catalog', '200', 'v1', 3); t.record('/api/catalog', '200', 'v1', 4); t.record('/api/orders', '503', 'v2', 9);
  assert.deepEqual(t.snapshot().counts, { '/api/catalog|200|v1': 2, '/api/orders|503|v2': 1 });
  assert.match(t.metrics(), /rg_loadgen_responses_total\{route="\/api\/orders",status="503",version="v2"\} 1/);
});

test('rollout and VirtualService state are read from Argo Rollouts and Istio objects', () => {
  const rollout = { spec: { replicas: 3, template: { spec: { containers: [{ name: 'api', env: [{ name: 'APP_VERSION', value: 'v2' }, { name: 'RELEASE_FAULT', value: 'none' }] }] } } },
    status: { phase: 'Degraded', abort: true, stableRS: 'aaa', currentPodHash: 'bbb', message: 'RolloutAborted: metric failed', availableReplicas: 3 } };
  assert.deepEqual(summarizeRollout(rollout), { phase: 'Degraded', message: 'RolloutAborted: metric failed', abort: true, stableRS: 'aaa', currentPodHash: 'bbb',
    currentStepIndex: null, replicas: 3, availableReplicas: 3, specVersion: 'v2', specFault: 'none' });
  const vs = { spec: { http: [{ name: 'primary', route: [{ destination: { host: 'releaseguard-stable' }, weight: 90 }, { destination: { host: 'releaseguard-canary' }, weight: 10 }] }] } };
  assert.deepEqual(routeWeights(vs, 'releaseguard'), { stable: 90, canary: 10 });
});

test('failed AnalysisRun is reduced to the metrics that caused the abort', () => {
  const run = { metadata: { name: 'releaseguard-bbb-2-1', labels: { 'rollouts-pod-template-hash': 'bbb', 'step-index': '1' } },
    status: { phase: 'Failed', message: 'Metric "canary-error-ratio" assessed Failed due to failed (2) > failureLimit (1)', metricResults: [
      { name: 'canary-request-volume', phase: 'Successful', successful: 3, measurements: [{ value: '[63]' }] },
      { name: 'canary-error-ratio', phase: 'Failed', failed: 2, successful: 0, measurements: [{ value: '[0.81]' }, { value: '[0.79]' }] },
    ] } };
  const s = summarizeAnalysisRun(run);
  assert.deepEqual(s.failedMetrics, ['canary-error-ratio']);
  assert.equal(s.metrics[1].lastValue, '[0.79]');
  assert.equal(s.podTemplateHash, 'bbb');
});

test('Prometheus scalar helper distinguishes no data from zero and rejects failed queries', () => {
  assert.equal(scalarFromVector({ status: 'success', data: { result: [] } }), null);
  assert.equal(scalarFromVector({ status: 'success', data: { result: [{ value: [1, '0'] }] } }), 0);
  assert.throws(() => scalarFromVector({ status: 'error', error: 'parse error' }), /parse error/);
});

test('scenario summary fails a step that crashed before writing its report and exports JUnit', () => {
  const reports = [{ scenario: 'pod-kill', passed: true, durationSeconds: 70, failedChecks: [], measured: { recoverySeconds: 21.5, clientTraffic: { errors: 0, total: 1510 } }, checks: [] }];
  const steps = [{ name: 'stand-setup', status: 'passed', durationSeconds: 300 }, { name: 'pod-kill', status: 'passed', durationSeconds: 71 }, { name: 'migration-compat', status: 'failed', durationSeconds: 12 },
    { name: 'helm-rollback', status: 'passed', durationSeconds: 90 }];
  const summary = collect(reports, steps, { result: 'failed', rollback: 'verified', durationSeconds: 8.4 });
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.results.map(r => r.passed), [true, true, false, true]);
  assert.match(toMarkdown(summary), /pod-kill \| passed \| 70 \| recovery 21.5s; client errors 0\/1510/);
  const junit = toJunit(summary);
  assert.deepEqual(junitTotals(junit), { tests: 4, failures: 1 });
});

test('Helm rollback step passes only when the bad release failed and rollback was verified', () => {
  const steps = [{ name: 'helm-rollback', status: 'passed', durationSeconds: 1 }];
  assert.equal(collect([], steps, { result: 'failed', rollback: 'verified' }).passed, true);
  assert.equal(collect([], steps, { result: 'failed', rollback: 'failed-verification' }).passed, false);
  assert.equal(collect([], steps, undefined).passed, false);
});

test('release gate requires every mandatory report and ignores the advisory LLM review', () => {
  const files = {
    'artifacts/junit/node.xml': '<testsuite><testcase name="a"/></testsuite>',
    'artifacts/junit/python.xml': '<testsuite><testcase name="b"/></testsuite>',
    'artifacts/junit-scenarios.xml': '<testsuite><testcase name="c"/></testsuite>',
    'artifacts/drills/redis-1.json': '{"passed":true}', 'artifacts/drills/redis-2.json': '{"passed":false}',
    'artifacts/report.json': JSON.stringify({ results: [{ name: 'canary-promote', passed: true, summary: '' }] }),
    'artifacts/llm-review/review.json': '{"status":"ok"}',
  };
  const dirs = { artifacts: ['report.json'], 'artifacts/drills': ['redis-1.json', 'redis-2.json'] };
  const fs = { exists: p => p in files || p in dirs, read: p => files[p], list: p => dirs[p] ?? [] };
  const rules = { junit: Object.keys(files).filter(f => f.endsWith('.xml')), evidence: [{ name: 'Redis', test: 'drill-redis', file: 'scripts/drill.py', pattern: 'artifacts/drills/redis-*.json' }],
    kindScenarios: ['canary-promote'] };
  const ok = evaluateGate(rules, fs);
  assert.equal(ok.checks.find(c => c.name === 'Redis').passed, false, 'latest evidence file wins');
  files['artifacts/drills/redis-2.json'] = '{"passed":true}';
  assert.equal(evaluateGate(rules, fs).passed, true);
  files['artifacts/junit/node.xml'] = '<testsuite><testcase name="a"><failure message="x"/></testcase></testsuite>';
  assert.equal(evaluateGate(rules, fs).passed, false);
  assert.deepEqual(evaluateGate({ ...rules, kindScenarios: ['pod-kill'] }, fs).checks.at(-1), { name: 'kind scenario pod-kill', passed: false, detail: 'missing' });
  assert.deepEqual(matches('artifacts/drills/kafka-*.json', ['kafka-1.json', 'redis-1.json', 'kafka.txt']), ['kafka-1.json']);
});
