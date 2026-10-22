// Aggregates scenario reports into artifacts/report.json, report.md and a JUnit file for GitLab.
// Steps that crashed before writing their own report are taken from artifacts/steps.json.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function collect(scenarioReports, steps, helmRollback) {
  const byName = new Map(scenarioReports.map(r => [r.scenario, r]));
  const results = steps.map(step => {
    const own = byName.get(step.name);
    if (step.name === 'stand-setup') {
      return { name: step.name, passed: step.status === 'passed', durationSeconds: step.durationSeconds, summary: step.status === 'passed' ? 'kind, Istio, Argo Rollouts, Prometheus and app ready' : 'stand setup failed',
        failedChecks: step.status === 'passed' ? [] : ['stand setup failed'], measured: {} };
    }
    if (step.name === 'helm-rollback') {
      return { name: step.name, passed: step.status === 'passed' && helmRollback?.rollback === 'verified' && helmRollback?.result === 'failed',
        durationSeconds: step.durationSeconds, summary: helmRollback ? `release ${helmRollback.result}, rollback ${helmRollback.rollback}, ${helmRollback.durationSeconds}s` : 'no release evidence',
        failedChecks: step.status === 'passed' ? [] : ['step exited non-zero'], measured: helmRollback ?? {} };
    }
    if (!own) return { name: step.name, passed: false, durationSeconds: step.durationSeconds, summary: 'no scenario report written', failedChecks: [`step ${step.status}`], measured: {} };
    return { name: step.name, passed: own.passed && step.status === 'passed', durationSeconds: own.durationSeconds, summary: summarize(own), failedChecks: own.failedChecks ?? [], measured: own.measured, checks: own.checks };
  });
  return { generatedAt: new Date().toISOString(), passed: results.length > 0 && results.every(r => r.passed), results };
}

export function summarize(report) {
  const m = report.measured ?? {};
  switch (report.scenario) {
    case 'canary-promote':
      return `promoted ${m.canaryVersion} in ${m.secondsToDecision}s; client errors ${m.clientTrafficDuringCanary?.errors}/${m.clientTrafficDuringCanary?.total}`;
    case 'canary-errors':
    case 'canary-latency':
      return `aborted after ${m.secondsToDecision}s on ${m.rollbackReason?.failedMetrics?.map(f => `${f.name}=${f.lastValue}`).join(', ') || 'n/a'}; responses from canary after abort: ${m.clientTrafficAfterAbort?.byVersion?.[m.canaryVersion] ?? 0}`;
    case 'pod-kill':
      return `recovery ${m.recoverySeconds}s; client errors ${m.clientTraffic?.errors}/${m.clientTraffic?.total}`;
    case 'migration-compat':
      return `new migrations: ${m.newMigrations?.length ?? 0}; old image ${m.oldImage}${m.sameImage ? ' (same as candidate)' : ''}`;
    default:
      return '';
  }
}

export function toJunit(summary) {
  const failures = summary.results.filter(r => !r.passed).length;
  const cases = summary.results.map(r => {
    const failure = r.passed ? '' : `<failure message="${xml(r.failedChecks.join('; ') || 'failed')}">${xml(JSON.stringify(r.checks ?? r.failedChecks, null, 2))}</failure>`;
    return `  <testcase classname="kind.scenarios" name="${xml(r.name)}" file="scripts/scenarios" time="${r.durationSeconds ?? 0}">${failure}<system-out>${xml(r.summary)}</system-out></testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="kind-scenarios" tests="${summary.results.length}" failures="${failures}">\n${cases.join('\n')}\n</testsuite>\n`;
}

export function toMarkdown(summary) {
  const rows = summary.results.map(r => `| ${r.name} | ${r.passed ? 'passed' : '**failed**'} | ${r.durationSeconds ?? '—'} | ${r.summary.replace(/\|/g, '/')} |`);
  return [`# Kind scenarios — ${summary.passed ? 'passed' : 'FAILED'}`, '', `Generated ${summary.generatedAt}`, '',
    '| Scenario | Result | Duration, s | Measured |', '|---|---|---|---|', ...rows, ''].join('\n');
}

function main() {
  const root = resolve(process.env.RG_ARTIFACTS ?? 'artifacts');
  const dir = resolve(root, 'scenarios');
  const reports = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.metrics.json')).map(f => JSON.parse(readFileSync(resolve(dir, f), 'utf8'))) : [];
  const steps = existsSync(resolve(root, 'steps.json')) ? JSON.parse(readFileSync(resolve(root, 'steps.json'), 'utf8')) : reports.map(r => ({ name: r.scenario, status: r.passed ? 'passed' : 'failed', durationSeconds: r.durationSeconds }));
  const releases = resolve(root, 'releases');
  const latestRelease = existsSync(releases) ? readdirSync(releases).sort().at(-1) : undefined;
  const helmRollback = latestRelease ? JSON.parse(readFileSync(resolve(releases, latestRelease), 'utf8')) : undefined;
  const summary = collect(reports, steps, helmRollback);
  for (const [name, content] of [['report.json', JSON.stringify(summary, null, 2)], ['report.md', toMarkdown(summary)], ['junit-scenarios.xml', toJunit(summary)]]) {
    writeFileSync(resolve(root, name), content);
  }
  console.log(toMarkdown(summary));
  process.exitCode = summary.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
