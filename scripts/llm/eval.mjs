// Demo merge requests in examples/pr-review/ with known risks.
//   default : runs each case's guard-fixture.json (synthetic model output) through the guard —
//             checks that unsupported coverage claims are corrected. No model call, no cost.
//   --live  : calls the model for every case and also checks that the expected risks are found.
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildContext, parseJunit } from './context.mjs';
import { applyGuard } from './guard.mjs';
import { runReview } from './review.mjs';

export const CASES_DIR = 'examples/pr-review';

export async function loadCase(root, name) {
  const dir = resolve(root, CASES_DIR, name);
  const read = f => readFileSync(resolve(dir, f), 'utf8');
  const description = read('description.md');
  const context = await buildContext({
    root, env: {}, diffText: read('diff.patch'),
    mr: { title: description.match(/^#\s+(.+)$/m)?.[1] ?? name, description, source: 'example' },
    results: existsSync(resolve(dir, 'junit.xml')) ? parseJunit(read('junit.xml')).map(r => ({ ...r, report: `${CASES_DIR}/${name}/junit.xml` })) : [],
    lcovText: existsSync(resolve(dir, 'lcov.info')) ? read('lcov.info') : '',
  });
  return { name, dir, context, expected: JSON.parse(read('expected.json')), fixture: JSON.parse(read('guard-fixture.json')) };
}

export function evaluateCase(c, review, { live }) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  for (const r of review.requirements) {
    if (r.status === 'covered' || r.status === 'partial') {
      add(`${r.id}: coverage claim backed by a passing test`, r.tests.some(t => t.verification === 'passed'), r.tests);
    }
  }
  for (const id of c.expected.mustNotBeCovered) {
    const r = review.requirements.find(x => x.id === id);
    add(`${id} is not reported as covered`, r && !['covered', 'partial'].includes(r.status), r?.status);
  }
  add('every acceptance criterion is assessed', review.requirements.length === c.context.acceptanceCriteria.length, review.requirements.map(r => r.id));
  if (live) {
    const text = review.risks.map(r => `${r.title}. ${r.evidence}`).join('\n') + '\n' + review.uncoveredScenarios.map(u => `${u.title}. ${u.why}`).join('\n');
    for (const risk of c.expected.expectedRisks) add(`risk found: ${risk.description}`, new RegExp(risk.pattern, 'i').test(text), null);
  } else {
    add('guard corrected the planted unsupported claim', review.corrections.length >= c.expected.minCorrectionsRecorded, review.corrections);
  }
  return { case: c.name, mode: live ? 'live' : 'guard-fixture', passed: checks.every(x => x.passed), checks };
}

async function main() {
  const live = process.argv.includes('--live');
  const root = process.cwd();
  const names = readdirSync(resolve(root, CASES_DIR), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const client = live ? new Anthropic({ timeout: 10 * 60 * 1000, maxRetries: 2 }) : undefined;
  const results = [];
  for (const name of names) {
    const c = await loadCase(root, name);
    let review;
    if (live) {
      const out = await runReview({ context: c.context, client, env: process.env, root, outDir: `artifacts/llm-eval/${name}` });
      if (out.status !== 'ok') { results.push({ case: name, mode: 'live', passed: false, checks: [{ name: 'model call', passed: false, detail: out.meta.error }] }); continue; }
      review = out.review;
    } else {
      review = applyGuard(c.fixture, c.context, { root });
    }
    results.push(evaluateCase(c, review, { live }));
  }
  mkdirSync(resolve(root, 'artifacts/llm-eval'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/llm-eval/summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), live, results }, null, 2));
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} ${r.case} (${r.mode})`);
    for (const x of r.checks.filter(x => !x.passed)) console.log(`   ✗ ${x.name}: ${JSON.stringify(x.detail)}`);
  }
  process.exitCode = results.every(r => r.passed) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
