import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { budgetDiff, changedLineCoverage, parseAcceptanceCriteria, parseDiff, parseJunit, parseLcov } from '../scripts/llm/context.mjs';
import { applyGuard, verifyTest } from '../scripts/llm/guard.mjs';
import { MARKER } from '../scripts/llm/render.mjs';
import { buildPrompt, runReview } from '../scripts/llm/review.mjs';
import { upsertMergeRequestNote } from '../scripts/llm/gitlab.mjs';
import { evaluateCase, loadCase } from '../scripts/llm/eval.mjs';

const tests = {
  inventory: [
    { file: 'src/tests/core.test.ts', name: 'same idempotency key returns the same order under concurrency', kind: 'unit' },
    { file: 'tests/test_http.py', name: 'test_same_key_different_payload_returns_conflict', kind: 'unit' },
    { file: 'scripts/scenarios', name: 'canary-errors', kind: 'kind-scenario' },
  ],
  results: [
    { name: 'same idempotency key returns the same order under concurrency', status: 'passed' },
    { name: 'test_same_key_different_payload_returns_conflict', status: 'failed' },
  ],
};
const context = (overrides = {}) => ({
  mergeRequest: { title: 't', description: '' },
  acceptanceCriteria: [{ id: 'AC-1', text: 'одна' }, { id: 'AC-2', text: 'две' }, { id: 'AC-3', text: 'три' }],
  diff: { files: [{ file: 'src/store.ts', status: 'modified', addedLines: 1, removedLines: 1 }], text: 'diff', omittedFiles: [] },
  tests, coverage: { available: false, changedLines: [] }, ...overrides,
});
const review = requirements => ({ summary: 's', riskLevel: 'medium', risks: [], checkPlan: [], requirements, uncoveredScenarios: [], suggestions: [] });

test('acceptance criteria are read from a Russian or English section and numbered', () => {
  const ru = '# Задача\n\nтекст\n\n## Критерии приёмки\n- первый\n* [x] второй\n1. третий\n\n## Прочее\n- не критерий';
  assert.deepEqual(parseAcceptanceCriteria(ru), [{ id: 'AC-1', text: 'первый' }, { id: 'AC-2', text: 'второй' }, { id: 'AC-3', text: 'третий' }]);
  assert.equal(parseAcceptanceCriteria('### Acceptance criteria:\n- one').length, 1);
  assert.deepEqual(parseAcceptanceCriteria('no section\n- item'), []);
});

test('diff parser tracks added line numbers per file and new/deleted status', () => {
  const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +10,4 @@ x\n ctx\n-old\n+new1\n+new2\n ctx\ndiff --git a/n.sql b/n.sql\nnew file mode 100644\n--- /dev/null\n+++ b/n.sql\n@@ -0,0 +1,1 @@\n+CREATE\n';
  const files = parseDiff(diff);
  assert.deepEqual(files.map(f => [f.file, f.status, f.added, f.removedCount]), [['a.ts', 'modified', [11, 12], 1], ['n.sql', 'added', [1], 0]]);
  const lcov = parseLcov('SF:/repo/a.ts\nDA:11,3\nDA:12,0\nend_of_record\n');
  const cov = changedLineCoverage(files, lcov);
  assert.deepEqual(cov[0], { file: 'a.ts', addedLines: 2, instrumented: 2, covered: 1, ratio: 0.5, inCoverageReport: true });
  assert.equal(cov[1].ratio, null, 'not instrumented is n/a, not covered');
});

test('oversized diffs are cut per file and the omitted files are named', () => {
  const diff = 'diff --git a/a b/a\n+1\n' + 'diff --git a/b b/b\n+' + 'x'.repeat(100) + '\n';
  const out = budgetDiff(diff, 30);
  assert.deepEqual(out.omittedFiles, ['b']);
  assert.ok(out.text.startsWith('diff --git a/a'));
});

test('JUnit parser reads node and python reports including failures and skips', () => {
  const xml = '<testsuites><testsuite><testcase name="a &amp; b" classname="x"/><testcase name="c"><failure message="m"/></testcase><testcase name="d"><skipped/></testcase></testsuite></testsuites>';
  assert.deepEqual(parseJunit(xml).map(c => [c.name, c.status]), [['a & b', 'passed'], ['c', 'failed'], ['d', 'skipped']]);
});

test('a test reference is evidence only if it exists and passed in this pipeline', () => {
  assert.equal(verifyTest({ file: 'src/tests/core.test.ts', name: 'same idempotency key returns the same order under concurrency' }, tests).verification, 'passed');
  assert.equal(verifyTest({ file: 'tests/test_http.py', name: 'test_same_key_different_payload_returns_conflict' }, tests).verification, 'failed');
  assert.equal(verifyTest({ file: 'scripts/scenarios', name: 'canary-errors' }, tests).verification, 'not-run');
  assert.equal(verifyTest({ file: 'tests/test_x.py', name: 'test_invented' }, tests).verification, 'no-such-test');
});

test('guard downgrades unsupported coverage claims and fills in missing criteria', () => {
  const out = applyGuard(review([
    { id: 'AC-1', status: 'covered', tests: [{ file: 'src/tests/core.test.ts', name: 'same idempotency key returns the same order under concurrency' }], rationale: '' },
    { id: 'AC-2', status: 'covered', tests: [{ file: 'tests/test_http.py', name: 'test_same_key_different_payload_returns_conflict' }, { file: 'scripts/scenarios', name: 'canary-errors' }], rationale: '' },
    { id: 'AC-9', status: 'covered', tests: [], rationale: '' },
  ]), context());
  assert.deepEqual(out.requirements.map(r => [r.id, r.status]), [['AC-1', 'covered'], ['AC-2', 'unverified'], ['AC-3', 'not_covered']]);
  assert.ok(out.corrections.some(c => c.requirement === 'AC-9' && c.action === 'отброшен'));
  assert.ok(out.corrections.some(c => c.requirement === 'AC-3'));
  const noTests = applyGuard(review([{ id: 'AC-1', status: 'partial', tests: [], rationale: '' }]), context({ acceptanceCriteria: [{ id: 'AC-1', text: 'x' }] }));
  assert.equal(noTests.requirements[0].status, 'not_covered');
});

test('suggested files are marked as changed, existing or new', () => {
  const out = applyGuard({ ...review([]), suggestions: [{ kind: 'test', title: 't', details: 'd', files: ['src/store.ts', 'package.json', 'tests/test_new.py'] }] }, context({ acceptanceCriteria: [] }));
  assert.deepEqual(out.suggestions[0].files.map(f => f.status), ['changed', 'existing', 'new']);
});

test('prompt marks repository content as data and includes the omitted-file notice', () => {
  const prompt = buildPrompt(context({ diff: { files: [], text: 'diff --git a/x b/x', omittedFiles: ['big.sql'] } }));
  for (const tag of ['<merge_request>', '<diff>', '<test_inventory>', '<test_results>', '<coverage>']) assert.ok(prompt.includes(tag));
  assert.match(prompt, /Omitted for size, not reviewed: big\.sql/);
});

test('unavailable model produces an advisory report instead of failing the pipeline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rg-llm-'));
  const failing = { beta: { messages: { stream() { throw new Anthropic.APIConnectionError({ message: 'connect ECONNREFUSED' }); } } } };
  for (const client of [undefined, failing]) {
    const out = await runReview({ context: context(), client, env: {}, root });
    assert.equal(out.status, 'unavailable');
    assert.match(out.markdown, /LLM-анализ недоступен/);
    assert.ok(out.markdown.startsWith(MARKER));
    assert.equal(JSON.parse(readFileSync(join(root, 'artifacts/llm-review/review.json'), 'utf8')).status, 'unavailable');
  }
});

test('model output is parsed, guarded and rendered without a release verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rg-llm-'));
  let request;
  const answer = review([{ id: 'AC-1', status: 'covered', tests: [{ file: 'tests/test_x.py', name: 'test_invented' }], rationale: 'r' }]);
  const client = { beta: { messages: { stream(params) { request = params; return { finalMessage: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: JSON.stringify(answer) }] }) }; } } } };
  const out = await runReview({ context: context({ acceptanceCriteria: [{ id: 'AC-1', text: 'x' }] }), client, env: {}, root });
  assert.equal(out.status, 'ok');
  assert.equal(out.review.requirements[0].status, 'not_covered');
  assert.equal(request.fallbacks, 'default');
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal('release' in request.output_config.format.schema.properties || 'approved' in request.output_config.format.schema.properties, false);
  assert.match(out.markdown, /не разрешает выпуск/);
  assert.match(out.markdown, /Исправления автоматической проверки/);
});

test('refusal and truncated responses are reported as unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rg-llm-'));
  for (const stop_reason of ['refusal', 'max_tokens']) {
    const client = { beta: { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason, stop_details: null, content: [] }) }) } } };
    assert.equal((await runReview({ context: context(), client, env: {}, root })).status, 'unavailable');
  }
});

test('MR note is updated in place when the marker exists, otherwise created', async () => {
  const env = { CI_API_V4_URL: 'https://gitlab.example/api/v4', CI_PROJECT_ID: '7', CI_MERGE_REQUEST_IID: '3', RG_GITLAB_TOKEN: 't' };
  const calls = [];
  const fake = notes => async (url, init) => { calls.push([init?.method ?? 'GET', url]); return { ok: true, json: async () => (init?.method ? {} : notes) }; };
  assert.equal(await upsertMergeRequestNote(env, `${MARKER}\nnew`, fake([{ id: 5, system: false, body: `${MARKER}\nold` }])), 'updated');
  assert.deepEqual(calls.at(-1), ['PUT', 'https://gitlab.example/api/v4/projects/7/merge_requests/3/notes/5']);
  assert.equal(await upsertMergeRequestNote(env, `${MARKER}\nnew`, fake([{ id: 6, system: false, body: 'human comment' }])), 'created');
});

test('demo merge requests: guard corrects every planted unsupported claim', async () => {
  for (const name of ['destructive-migration', 'idempotency-key-relaxed', 'canary-threshold-weakened']) {
    const c = await loadCase(process.cwd(), name);
    const result = evaluateCase(c, applyGuard(c.fixture, c.context), { live: false });
    assert.ok(result.passed, `${name}: ${JSON.stringify(result.checks.filter(x => !x.passed))}`);
  }
});
