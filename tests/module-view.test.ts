import { describe, expect, it } from 'vitest';
import type { Edge, EditScopeDecl, ModuleNode } from '../src/shared/types.js';
import {
  aggregateModuleEdges,
  deriveScopeMarks,
  groupByModule,
  moduleIdFromPile,
  pileIdOf
} from '../src/web/module-view.js';

/**
 * ADR 0002 / MODULE-DESIGN §7.1+§7.2 web 侧纯函数：模块视图分组、模块级边
 * 聚合、范围/已改/越界标记派生。无 DOM、无 cytoscape —— graph-view 渲染
 * 管线的数据侧，由 tests/module-view.test.ts 覆盖。
 */

function file(id: string): ModuleNode {
  return { id, path: id, language: 'ts', testState: 'untested', coveredBy: [], typeErrors: [] };
}

describe('groupByModule — 小模块球按功能类成堆', () => {
  it('groups in-table files by functional module in table order; out-of-table files are dropped', () => {
    const nodes = [
      file('package.json'),
      file('src/server/mcp.ts'),
      file('src/web/main.ts'),
      file('src/server/incremental-graph.ts'),
      file('README.md'),
      file('src/shared/types.ts')
    ];
    const groups = groupByModule(nodes);
    expect([...groups.keys()]).toEqual(['mcp-service', 'graph-engine', 'dashboard', 'shared-contract']);
    expect(groups.get('mcp-service')!.map((n) => n.id)).toEqual(['src/server/mcp.ts']);
    expect(groups.get('graph-engine')!.map((n) => n.id)).toEqual(['src/server/incremental-graph.ts']);
    expect(groups.get('dashboard')!.map((n) => n.id)).toEqual(['src/web/main.ts']);
    // package.json / README.md 表外：无「未分组」球。
    expect(groups.size).toBe(4);
  });

  it('returns an empty map for all-out-of-table input', () => {
    expect(groupByModule([file('package.json'), file('docs/x.md')]).size).toBe(0);
  });
});

describe('aggregateModuleEdges — 模块级边', () => {
  const modOf = new Map<string, string>([
    ['src/server/mcp.ts', 'mcp-service'],
    ['src/web/main.ts', 'dashboard'],
    ['src/shared/types.ts', 'shared-contract'],
    ['src/server/incremental-graph.ts', 'graph-engine']
  ]);

  it('rewires cross-module file edges onto pile endpoints, deduped', () => {
    const edges: Edge[] = [
      { from: 'src/web/main.ts', to: 'src/shared/types.ts' },
      { from: 'src/web/main.ts', to: 'src/shared/types.ts' }, // duplicate
      { from: 'src/server/mcp.ts', to: 'src/web/main.ts' }
    ];
    expect(aggregateModuleEdges(edges, modOf as Map<string, any>)).toEqual([
      { from: 'pile:dashboard', to: 'pile:shared-contract' },
      { from: 'pile:mcp-service', to: 'pile:dashboard' }
    ]);
  });

  it('drops intra-module edges and edges touching out-of-table files', () => {
    const edges: Edge[] = [
      { from: 'src/server/mcp.ts', to: 'src/server/index.ts' }, // both mcp-service
      { from: 'src/web/main.ts', to: 'package.json' }, // out-of-table target
      { from: 'src/web/main.ts', to: 'src/shared/types.ts' }
    ];
    expect(aggregateModuleEdges(edges, modOf as Map<string, any>)).toEqual([
      { from: 'pile:dashboard', to: 'pile:shared-contract' }
    ]);
  });

  it('preserves cross-module cycles (they stay visible as module-level cycles)', () => {
    const edges: Edge[] = [
      { from: 'src/server/mcp.ts', to: 'src/web/main.ts' },
      { from: 'src/web/main.ts', to: 'src/server/mcp.ts' }
    ];
    expect(aggregateModuleEdges(edges, modOf as Map<string, any>)).toEqual([
      { from: 'pile:mcp-service', to: 'pile:dashboard' },
      { from: 'pile:dashboard', to: 'pile:mcp-service' }
    ]);
  });
});

describe('pile id vocabulary', () => {
  it('round-trips: pile:moduleId ↔ moduleId', () => {
    expect(pileIdOf('mcp-service')).toBe('pile:mcp-service');
    expect(moduleIdFromPile('pile:mcp-service')).toBe('mcp-service');
    expect(moduleIdFromPile('pile:no-such')).toBeNull();
    expect(moduleIdFromPile('src/server/mcp.ts')).toBeNull();
  });
});

describe('deriveScopeMarks — 范围环 / 已改紫 / 越界红角标', () => {
  const nodes = [
    file('src/server/mcp.ts'),
    file('src/web/main.ts'),
    file('package.json'),
    file('src/server/incremental-graph.ts')
  ];
  const scope: EditScopeDecl = { modules: ['mcp-service'], files: ['package.json'] };

  it('ring: files of declared modules plus explicit files; out-of-table only via explicit', () => {
    const marks = deriveScopeMarks(nodes, scope, new Set(), new Set());
    expect(marks.get('src/server/mcp.ts')!.inScope).toBe(true);
    expect(marks.get('package.json')!.inScope).toBe(true);
    expect(marks.get('src/web/main.ts')!.inScope).toBe(false);
    expect(marks.get('src/server/incremental-graph.ts')!.inScope).toBe(false);
  });

  it('no scope: nothing gets the ring', () => {
    const marks = deriveScopeMarks(nodes, null, new Set(), new Set());
    for (const m of marks.values()) expect(m.inScope).toBe(false);
  });

  it('edited and out-of-scope are independent channels', () => {
    const marks = deriveScopeMarks(
      nodes,
      scope,
      new Set(['src/server/mcp.ts', 'src/web/main.ts']),
      new Set(['src/web/main.ts'])
    );
    // in-scope AND edited: ring + purple fill.
    expect(marks.get('src/server/mcp.ts')).toEqual({ inScope: true, edited: true, outOfScope: false });
    // edited AND out-of-scope (越界也照实标记已改).
    expect(marks.get('src/web/main.ts')).toEqual({ inScope: false, edited: true, outOfScope: true });
    // untouched in-scope: ring only.
    expect(marks.get('package.json')).toEqual({ inScope: true, edited: false, outOfScope: false });
  });
});
