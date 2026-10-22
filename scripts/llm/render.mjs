// Markdown for the MR note and the job artifact.
export const MARKER = '<!-- releaseguard:llm-review -->';

const STATUS = { covered: '✅ покрыто', partial: '🟡 частично', unverified: '⚪ не подтверждено', not_covered: '❌ не покрыто' };
const VERIFY = { passed: 'проходит', failed: 'падает', 'not-run': 'не запускался', 'no-such-test': 'не найден' };
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const pct = r => r === null ? 'n/a' : `${Math.round(r * 100)}%`;

function coverageTable(context) {
  if (!context.coverage.available) return ['Отчёт о покрытии в pipeline не найден.'];
  const rows = context.coverage.changedLines.filter(c => c.addedLines > 0);
  if (!rows.length) return ['Добавленных строк нет.'];
  return ['| Файл | Добавлено строк | Инструментировано | Покрыто | Доля |', '|---|---|---|---|---|',
    ...rows.map(c => `| ${cell(c.file)} | ${c.addedLines} | ${c.instrumented} | ${c.covered} | ${c.inCoverageReport ? pct(c.ratio) : 'нет в отчёте'} |`)];
}

export function renderReview({ status, review, context, meta }) {
  const out = [MARKER, '## LLM-анализ перед релизом (рекомендательный)', '',
    '> Анализ не меняет код и не разрешает выпуск. Релиз определяется только обязательными job’ами pipeline и `scripts/ci/release-rules.json`.', ''];
  if (status !== 'ok') {
    out.push(`**LLM-анализ недоступен:** ${cell(meta.error ?? status)}. Основной pipeline не зависит от этого шага.`, '');
  } else {
    out.push(`**Уровень риска:** ${review.riskLevel}. ${review.summary}`, '');
    out.push('### Риски', '', '| Серьёзность | Категория | Риск | Основание | Файлы |', '|---|---|---|---|---|',
      ...review.risks.map(r => `| ${r.severity} | ${r.category} | ${cell(r.title)} | ${cell(r.evidence)} | ${cell(r.files.join(', '))} |`), '');
    out.push('### Критерии приёмки и существующие тесты', '', '| Критерий | Статус | Тесты (результат в pipeline) | Обоснование |', '|---|---|---|---|',
      ...review.requirements.map(r => `| ${r.id}: ${cell(r.text)} | ${STATUS[r.status]} | ${cell(r.tests.map(t => `${t.file} › ${t.name} (${VERIFY[t.verification]})`).join('; ') || '—')} | ${cell(r.rationale)} |`), '');
    if (review.corrections.length) {
      out.push('### Исправления автоматической проверки', '', 'Заявления модели, не подтверждённые тестами и их результатами:', '',
        ...review.corrections.map(c => `- ${c.requirement}: ${c.issue} — ${c.action}`), '');
    }
    out.push('### План проверок', '');
    for (const kind of ['business', 'technical']) {
      const items = review.checkPlan.filter(c => c.kind === kind);
      if (!items.length) continue;
      out.push(`**${kind === 'business' ? 'Бизнес-проверки' : 'Технические проверки'}**`, '');
      for (const c of items) {
        const tests = c.existingTests.length ? ` Существующие тесты: ${c.existingTests.map(t => `${t.file} › ${t.name} (${VERIFY[t.verification]})`).join('; ')}.` : ' Автотеста нет.';
        out.push(`- ${c.title}${c.requirements.length ? ` (${c.requirements.join(', ')})` : ''}.${tests}`, ...c.steps.map(s => `  - ${s}`));
      }
      out.push('');
    }
    if (review.uncoveredScenarios.length) {
      out.push('### Непокрытые сценарии', '', ...review.uncoveredScenarios.map(u => `- **${u.title}**${u.requirements.length ? ` (${u.requirements.join(', ')})` : ''}: ${u.why}`), '');
    }
    if (review.suggestions.length) {
      out.push('### Предлагаемые доработки', '', ...review.suggestions.map(s => `- [${s.kind}] **${s.title}** — ${s.details} Файлы: ${s.files.map(f => `\`${f.path}\`${f.status === 'new' ? ' (новый)' : ''}`).join(', ') || '—'}`), '');
    }
  }
  out.push('### Покрытие изменённых строк (из отчёта pipeline)', '', ...coverageTable(context), '');
  if (context.diff.omittedFiles.length) out.push(`**Diff передан не полностью** (лимит размера). Не проанализированы: ${context.diff.omittedFiles.map(f => `\`${f}\``).join(', ')}.`, '');
  if (context.mergeRequest.truncated) out.push('**Описание MR было усечено GitLab** — для полного текста задайте `RG_GITLAB_TOKEN`.', '');
  out.push(`<sub>Модель: ${meta.model ?? '—'} · ${meta.servedBy && meta.servedBy !== meta.model ? `ответ сформирован ${meta.servedBy} · ` : ''}входных токенов: ${meta.usage?.input_tokens ?? '—'}, выходных: ${meta.usage?.output_tokens ?? '—'} · ${meta.generatedAt}</sub>`);
  return out.join('\n');
}
