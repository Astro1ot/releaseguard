// Deterministic input for the optional LLM review: MR text, acceptance criteria, diff, test
// inventory, test results and changed-line coverage. Nothing here calls a model.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export function parseAcceptanceCriteria(description = '') {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*#{1,6}\s*(критерии\s+приёмки|критерии\s+приемки|acceptance\s+criteria)(?=[\s:]|$)/i.test(l)); // \b is ASCII-only in JS regexes
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line)) break;
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/);
    if (m) items.push({ id: `AC-${items.length + 1}`, text: m[1] });
  }
  return items;
}

export function parseDiff(diffText) {
  const files = [];
  let current, line = 0;
  for (const raw of diffText.split('\n')) {
    const header = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) { current = { file: header[2], status: 'modified', added: [], removedCount: 0 }; files.push(current); continue; }
    if (!current) continue;
    if (raw.startsWith('new file mode')) current.status = 'added';
    else if (raw.startsWith('deleted file mode')) current.status = 'deleted';
    else if (raw.startsWith('rename from ')) current.status = 'renamed';
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) { current.added.push(line); line++; }
    else if (raw.startsWith('-')) current.removedCount++;
    else if (raw.startsWith(' ')) line++;
  }
  return files;
}

export function parseLcov(text) {
  const files = new Map();
  let current;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) { current = new Map(); files.set(raw.slice(3).replace(/\\/g, '/'), current); }
    else if (raw.startsWith('DA:') && current) { const [n, hits] = raw.slice(3).split(','); current.set(Number(n), Number(hits)); }
    else if (raw === 'end_of_record') current = undefined;
  }
  return files;
}

// Coverage of added lines per changed file. A file with no instrumented added lines is "n/a",
// never counted as covered.
export function changedLineCoverage(diffFiles, lcov) {
  const keys = [...lcov.keys()];
  return diffFiles.filter(f => f.status !== 'deleted').map(f => {
    const key = keys.find(k => k === f.file || k.endsWith('/' + f.file));
    const lines = key ? lcov.get(key) : undefined;
    const instrumented = lines ? f.added.filter(n => lines.has(n)) : [];
    const covered = instrumented.filter(n => lines.get(n) > 0);
    return { file: f.file, addedLines: f.added.length, instrumented: instrumented.length, covered: covered.length,
      ratio: instrumented.length ? covered.length / instrumented.length : null, inCoverageReport: Boolean(key) };
  });
}

export function parseJunit(xml) {
  const cases = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], a[2].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
    const body = m[3] ?? '';
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    cases.push({ name: attrs.name, classname: attrs.classname ?? null, file: attrs.file ?? null, status });
  }
  return cases;
}

const SCENARIO_TESTS = [
  ['scripts/scenarios', 'canary-promote'], ['scripts/scenarios', 'canary-errors'], ['scripts/scenarios', 'canary-latency'],
  ['scripts/scenarios', 'pod-kill'], ['scripts/scenarios', 'migration-compat'], ['scripts/scenarios', 'helm-rollback'],
];

export function testInventory(root) {
  const out = [];
  const scan = (dir, pattern, extract) => {
    if (!existsSync(join(root, dir))) return;
    for (const name of readdirSync(join(root, dir)).filter(n => pattern.test(n))) {
      const file = `${dir}/${name}`;
      for (const testName of extract(readFileSync(join(root, file), 'utf8'))) out.push({ file, name: testName, kind: 'unit' });
    }
  };
  const nodeTests = text => [...text.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)+)\1/g)].map(m => m[2]);
  scan('src/tests', /\.test\.ts$/, nodeTests);
  scan('tests', /\.test\.mjs$/, nodeTests);
  scan('tests', /^test_.*\.py$/, text => [...text.matchAll(/^\s*def (test_\w+)\(/gm)].map(m => m[1]));
  for (const [file, name] of SCENARIO_TESTS) out.push({ file, name, kind: 'kind-scenario' });
  const rules = join(root, 'scripts/ci/release-rules.json');
  if (existsSync(rules)) {
    for (const e of JSON.parse(readFileSync(rules, 'utf8')).evidence) out.push({ file: e.file, name: e.test, kind: 'compose-regression' });
  }
  return out;
}

export function collectResults(root) {
  const results = [];
  for (const dir of ['artifacts/junit', 'artifacts']) {
    if (!existsSync(join(root, dir))) continue;
    for (const f of readdirSync(join(root, dir)).filter(n => n.endsWith('.xml'))) {
      for (const c of parseJunit(readFileSync(join(root, dir, f), 'utf8'))) results.push({ ...c, report: `${dir}/${f}` });
    }
  }
  return results;
}

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

export async function mergeRequestText(env) {
  const local = env.RG_MR_DESCRIPTION_FILE && existsSync(env.RG_MR_DESCRIPTION_FILE) ? readFileSync(env.RG_MR_DESCRIPTION_FILE, 'utf8') : null;
  if (local !== null) return { title: env.RG_MR_TITLE ?? '', description: local, source: 'file' };
  if (env.RG_GITLAB_TOKEN && env.CI_API_V4_URL && env.CI_PROJECT_ID && env.CI_MERGE_REQUEST_IID) {
    // The predefined CI variable can be truncated; the API returns the full description.
    try {
      const r = await fetch(`${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/merge_requests/${env.CI_MERGE_REQUEST_IID}`, { headers: { 'PRIVATE-TOKEN': env.RG_GITLAB_TOKEN }, signal: AbortSignal.timeout(15000) });
      if (r.ok) { const mr = await r.json(); return { title: mr.title, description: mr.description ?? '', source: 'gitlab-api' }; }
    } catch { /* fall back to CI variables */ }
  }
  return { title: env.CI_MERGE_REQUEST_TITLE ?? '', description: env.CI_MERGE_REQUEST_DESCRIPTION ?? '', source: 'ci-variables',
    truncated: env.CI_MERGE_REQUEST_DESCRIPTION_IS_TRUNCATED === 'true' };
}

// Large diffs are cut per file, and the omitted files are listed explicitly for the model and the report.
export function budgetDiff(diffText, maxChars) {
  if (diffText.length <= maxChars) return { text: diffText, omittedFiles: [] };
  const chunks = diffText.split(/(?=^diff --git )/m);
  let text = '';
  const omittedFiles = [];
  for (const chunk of chunks) {
    if (text.length + chunk.length <= maxChars) text += chunk;
    else omittedFiles.push(chunk.match(/^diff --git a\/.+? b\/(.+)$/m)?.[1] ?? '(unknown)');
  }
  return { text, omittedFiles };
}

export async function buildContext({ root = process.cwd(), env = process.env, diffText, mr, results, lcovText } = {}) {
  const base = env.RG_BASE_SHA ?? env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? 'origin/main';
  const head = env.RG_HEAD_SHA ?? 'HEAD';
  const fullDiff = diffText ?? git(root, ['diff', '--no-color', '--unified=3', `${base}...${head}`]);
  const diffFiles = parseDiff(fullDiff);
  const budget = budgetDiff(fullDiff, Number(env.RG_LLM_MAX_DIFF_CHARS ?? 400_000));
  const request = mr ?? await mergeRequestText(env);
  const lcovPath = join(root, env.RG_COVERAGE_LCOV ?? 'artifacts/coverage/lcov.info');
  const lcov = lcovText !== undefined ? parseLcov(lcovText) : existsSync(lcovPath) ? parseLcov(readFileSync(lcovPath, 'utf8')) : new Map();
  const coverage = changedLineCoverage(diffFiles, new Map([...lcov].map(([k, v]) => [relative(root, resolve(root, k)).replace(/\\/g, '/'), v])));
  return {
    mergeRequest: request,
    acceptanceCriteria: parseAcceptanceCriteria(request.description),
    diff: { base, head, files: diffFiles.map(({ file, status, added, removedCount }) => ({ file, status, addedLines: added.length, removedLines: removedCount })), text: budget.text, omittedFiles: budget.omittedFiles },
    tests: { inventory: testInventory(root), results: results ?? collectResults(root) },
    coverage: { available: lcov.size > 0, changedLines: coverage },
  };
}
