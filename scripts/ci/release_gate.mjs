// Deterministic release gate: every mandatory test report and scenario must be present and green.
// Rules live in scripts/ci/release-rules.json. The LLM review is deliberately not an input.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function junitTotals(xmlText) {
  const tests = (xmlText.match(/<testcase\b/g) ?? []).length;
  const failures = (xmlText.match(/<failure\b/g) ?? []).length + (xmlText.match(/<error\b/g) ?? []).length;
  return { tests, failures };
}

export function matches(pattern, files) {
  const [prefix, suffix] = basename(pattern).split('*');
  return files.filter(f => suffix === undefined ? f === basename(pattern) : f.startsWith(prefix) && f.endsWith(suffix));
}

export function evidenceChecks(rules, fs) {
  return rules.evidence.map(item => {
    const dir = dirname(item.pattern);
    const latest = (fs.exists(dir) ? matches(item.pattern, fs.list(dir)) : []).sort().at(-1);
    if (!latest) return { name: item.name, test: item.test, file: item.file, passed: false, detail: 'missing' };
    const data = JSON.parse(fs.read(`${dir}/${latest}`));
    // Scripts without a "passed" field write their evidence only after every assertion succeeded.
    return { name: item.name, test: item.test, file: item.file, passed: data.passed === undefined || data.passed === true, detail: `${dir}/${latest}` };
  });
}

export function evaluateGate(rules, fs) {
  const checks = [];
  for (const path of rules.junit) {
    if (!fs.exists(path)) { checks.push({ name: `JUnit ${path}`, passed: false, detail: 'missing' }); continue; }
    const totals = junitTotals(fs.read(path));
    checks.push({ name: `JUnit ${path}`, passed: totals.tests > 0 && totals.failures === 0, detail: totals });
  }
  checks.push(...evidenceChecks(rules, fs));
  const report = fs.exists('artifacts/report.json') ? JSON.parse(fs.read('artifacts/report.json')) : { results: [] };
  for (const name of rules.kindScenarios) {
    const result = report.results.find(r => r.name === name);
    checks.push({ name: `kind scenario ${name}`, passed: Boolean(result?.passed), detail: result ? result.summary : 'missing' });
  }
  return { passed: checks.every(c => c.passed), checks, advisoryInputsIgnored: ['artifacts/llm-review'] };
}

function main() {
  const rules = JSON.parse(readFileSync('scripts/ci/release-rules.json', 'utf8'));
  const fs = { exists: p => existsSync(resolve(p)), read: p => readFileSync(resolve(p), 'utf8'), list: p => readdirSync(resolve(p)) };
  const result = { evaluatedAt: new Date().toISOString(), commit: process.env.CI_COMMIT_SHA ?? null, ...evaluateGate(rules, fs) };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync('artifacts/release-gate.json', JSON.stringify(result, null, 2));
  for (const c of result.checks) console.log(`${c.passed ? 'PASS' : 'FAIL'} ${c.name} — ${typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)}`);
  console.log(result.passed ? 'Release gate passed.' : 'Release gate FAILED: release is blocked.');
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
