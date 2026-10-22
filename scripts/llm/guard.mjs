// Post-checks on the model output. The model may only claim coverage that a real, passing test
// supports; anything else is downgraded and listed as a correction in the report.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const norm = s => String(s ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
const sameName = (a, b) => norm(a).toLowerCase() === norm(b).toLowerCase();

export function verifyTest(ref, tests) {
  const known = tests.inventory.find(t => norm(t.file) === norm(ref.file) && sameName(t.name, ref.name))
    ?? tests.inventory.find(t => sameName(t.name, ref.name) && norm(ref.file).endsWith(norm(t.file).split('/').at(-1)));
  if (!known) return { ...ref, verification: 'no-such-test' };
  const runs = tests.results.filter(r => sameName(r.name, known.name));
  if (!runs.length) return { file: known.file, name: known.name, verification: 'not-run' };
  if (runs.some(r => r.status === 'failed')) return { file: known.file, name: known.name, verification: 'failed' };
  if (runs.every(r => r.status === 'skipped')) return { file: known.file, name: known.name, verification: 'not-run' };
  return { file: known.file, name: known.name, verification: 'passed' };
}

const REASON = {
  'no-such-test': 'тест не найден в репозитории',
  'not-run': 'тест существует, но его результата нет в отчётах pipeline',
  failed: 'тест падает в этом pipeline',
};

export function applyGuard(analysis, context, { root = process.cwd() } = {}) {
  const corrections = [];
  const criteria = context.acceptanceCriteria;
  const byId = new Map(analysis.requirements.map(r => [r.id, r]));

  const requirements = criteria.map(ac => {
    const claimed = byId.get(ac.id);
    if (!claimed) {
      corrections.push({ requirement: ac.id, issue: 'модель не оценила критерий', action: 'помечен как не покрытый' });
      return { id: ac.id, text: ac.text, claimedStatus: null, status: 'not_covered', tests: [], rationale: '' };
    }
    const tests = claimed.tests.map(t => verifyTest(t, context.tests));
    const passing = tests.filter(t => t.verification === 'passed');
    let status = claimed.status;
    if (claimed.status !== 'not_covered' && !passing.length) {
      status = tests.some(t => t.verification === 'not-run') ? 'unverified' : 'not_covered';
      const why = tests.length ? [...new Set(tests.map(t => REASON[t.verification]))].join('; ') : 'не указан ни один тест';
      corrections.push({ requirement: ac.id, issue: `заявлено «${claimed.status}», но ${why}`, action: `статус → ${status}` });
    }
    for (const t of tests.filter(t => t.verification !== 'passed' && status !== 'not_covered')) {
      corrections.push({ requirement: ac.id, issue: `ссылка на тест ${t.file} › ${t.name}: ${REASON[t.verification]}`, action: 'не учитывается как доказательство' });
    }
    return { id: ac.id, text: ac.text, claimedStatus: claimed.status, status, tests, rationale: claimed.rationale };
  });
  for (const extra of analysis.requirements.filter(r => !criteria.some(ac => ac.id === r.id))) {
    corrections.push({ requirement: extra.id, issue: 'идентификатор отсутствует в критериях приёмки', action: 'отброшен' });
  }

  const changed = new Set(context.diff.files.map(f => norm(f.file)));
  const fileStatus = f => changed.has(norm(f)) ? 'changed' : existsSync(join(root, norm(f))) ? 'existing' : 'new';
  const suggestions = analysis.suggestions.map(s => ({ ...s, files: s.files.map(f => ({ path: norm(f), status: fileStatus(f) })) }));
  const checkPlan = analysis.checkPlan.map(c => ({ ...c, existingTests: c.existingTests.map(t => verifyTest(t, context.tests)) }));

  return { ...analysis, requirements, suggestions, checkPlan, corrections };
}
