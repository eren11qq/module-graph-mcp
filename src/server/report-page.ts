import { HEALTH_FLAG_LABELS, type HealthFlags, type HealthReport } from './health-report.js';

/**
 * The /api/report acceptance page (trust-loop roadmap PR-4): a standalone
 * HTML document assembled on the server — no build step, no framework, no
 * scripts (the CSP of the dashboard forbids them anyway). Reuses the health
 * report's deterministic items, so the page ranks exactly like the MCP tool.
 *
 * `focus` deep link (?focus=<module-id>): the matching row gets the
 * `report-focus` class, computed SERVER-side — no JS needed to highlight.
 * Module ids come from the filesystem, so every interpolation is escaped.
 */

/** Minimal HTML escaping for text and attribute positions. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const FLAG_ORDER: Array<keyof HealthFlags> = Object.keys(HEALTH_FLAG_LABELS) as Array<keyof HealthFlags>;

export function renderReportPage(report: HealthReport, focus: string | null): string {
  const rows = report.items
    .map((item, index) => {
      const focused = focus !== null && focus === item.id;
      const activeFlags = FLAG_ORDER.filter((f) => item.flags[f]).map((f) => HEALTH_FLAG_LABELS[f]);
      const reason = activeFlags.length > 0 ? activeFlags.map(escapeHtml).join(' · ') : '无风险信号';
      const classes = focused ? 'report-item report-focus' : 'report-item';
      return [
        `      <li id="module-${escapeHtml(item.id)}" class="${classes}">`,
        `        <span class="rank">${index + 1}</span>`,
        `        <span class="score">${item.score}</span>`,
        `        <code class="module-id">${escapeHtml(item.id)}</code>`,
        `        <span class="flags">${reason}</span>`,
        '      </li>'
      ].join('\n');
    })
    .join('\n');

  const weightCells = FLAG_ORDER.map((f) => `        <tr><td>${HEALTH_FLAG_LABELS[f]}</td><td>${report.weights[f]}</td></tr>`).join('\n');
  const focusNote = focus !== null ? `\n  <p class="focus-note">聚焦模块：<code>${escapeHtml(focus)}</code></p>` : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>模块健康报告</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 42rem; color: #1d1a17; background: #faf7f2; }
    code { background: #efe9df; padding: 0.1em 0.4em; border-radius: 4px; }
    .meta { color: #6b6259; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid #d9d0c3; padding: 0.25rem 0.8rem; text-align: left; }
    ol.report-list { list-style: none; padding: 0; }
    .report-item { display: flex; gap: 0.75rem; align-items: baseline; padding: 0.35rem 0.5rem; border-radius: 6px; }
    .rank { color: #6b6259; min-width: 1.5rem; }
    .score { font-weight: 700; min-width: 1.5rem; text-align: right; }
    .flags { color: #6b6259; }
    .report-focus { background: #ffe9a8; outline: 2px solid #e0a400; }
    .focus-note { font-weight: 600; }
  </style>
</head>
<body>
  <h1>模块健康报告</h1>
  <p class="meta">监视根：<code>${escapeHtml(report.rootPath)}</code> · 共 ${report.totalModules} 个模块 · 生成于 ${new Date(report.generatedAt).toISOString()}</p>${focusNote}
  <h2>权重表</h2>
  <table>
    <tbody>
${weightCells}
    </tbody>
  </table>
  <h2>排名（风险降序，同分按 id 字典序）</h2>
  <ol class="report-list">
${rows}
  </ol>
</body>
</html>
`;
}
