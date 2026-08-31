import { describe, expect, it } from 'vitest';
import { buildHealthReport } from '../src/server/health-report.js';
import { renderReportPage } from '../src/server/report-page.js';
import type { Edge, ModuleNode } from '../src/shared/types.js';

/**
 * Trust-loop roadmap PR-4: the report page is a pure server-side HTML
 * assembly over the health report — these tests pin the escaping contract
 * (module ids come from the filesystem), the ?focus= deep link and the key
 * section text the probe asserts.
 */

function node(overrides: Partial<ModuleNode> & { id: string }): ModuleNode {
  return {
    path: overrides.id,
    language: 'ts',
    testState: 'untested',
    coveredBy: [],
    typeErrors: [],
    ...overrides
  };
}

function reportOf(ids: string[], edges: Edge[] = []) {
  return buildHealthReport({ rootPath: '/fixture', generatedAt: 42, nodes: ids.map((id) => node({ id })), edges });
}

describe('renderReportPage', () => {
  it('renders the key sections and one anchor per module', () => {
    const html = renderReportPage(reportOf(['a.ts', 'b.ts']), null);
    expect(html).toContain('<h1>模块健康报告</h1>');
    expect(html).toContain('权重表');
    expect(html).toContain('排名（风险降序，同分按 id 字典序）');
    expect(html).toContain('id="module-a.ts"');
    expect(html).toContain('id="module-b.ts"');
    expect(html).toContain('共 2 个模块');
  });

  it('escapes every filesystem-derived string (ids must never be raw HTML)', () => {
    const evil = '<script>alert(1)</script>';
    const html = renderReportPage(reportOf([evil]), null);
    expect(html).not.toContain('<script>');
    expect(html).toContain('id="module-&lt;script&gt;alert(1)&lt;/script&gt;"');
  });

  it('escapes the watched root too', () => {
    const report = { ...reportOf(['a.ts']), rootPath: '/x"onmouseover="y' };
    const html = renderReportPage(report, null);
    expect(html).toContain('<code>/x&quot;onmouseover=&quot;y</code>');
  });

  it('?focus= highlights exactly the target row, server-side', () => {
    const html = renderReportPage(reportOf(['a.ts', 'b.ts']), 'b.ts');
    expect(html).toContain('<li id="module-b.ts" class="report-item report-focus">');
    expect(html).toContain('<li id="module-a.ts" class="report-item">');
    expect(html).toContain('聚焦模块：<code>b.ts</code>');
  });

  it('an unknown focus id highlights nothing and still renders the page', () => {
    const html = renderReportPage(reportOf(['a.ts']), 'ghost.ts');
    expect(html).not.toContain('class="report-item report-focus"');
    expect(html).toContain('聚焦模块：<code>ghost.ts</code>');
    expect(html).toContain('<h1>模块健康报告</h1>');
  });

  it('the weights table mirrors the fixed integer table', () => {
    const html = renderReportPage(reportOf(['a.ts']), null);
    expect(html).toContain('<td>高中心度</td><td>3</td>');
    expect(html).toContain('<td>未测</td><td>2</td>');
    expect(html).toContain('<td>类型错误</td><td>2</td>');
    expect(html).toContain('<td>在环上</td><td>1</td>');
    expect(html).toContain('<td>评审error</td><td>2</td>');
  });
});
