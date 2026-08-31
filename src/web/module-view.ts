/**
 * 模板模式 web 侧纯函数 (ADR 0002 / MODULE-DESIGN §7.1+§7.2)：模块视图的
 * 数据变换与改动标记派生。无 DOM、无 cytoscape —— graph-view 渲染管线在
 * 这里取到「谁进哪个堆、堆与堆之间连什么线、每颗球带什么标记」。
 */

import type { Edge, EditScopeDecl, ModuleNode } from '../shared/types.js';
import { FUNCTIONAL_MODULES, moduleIdOf, type FunctionalModuleId } from '../shared/module-table.js';

export interface ScopeMarks {
  /** 范围内 → 常驻紫环（与 viewing 紫脉冲——瞬时 3s——区分）。 */
  inScope: boolean;
  /** 已改 → 整球紫（填充）。 */
  edited: boolean;
  /** 越界 → 红警示角标 + tooltip 文案。 */
  outOfScope: boolean;
}

/** 模块级边 / 堆题注节点的 id 前缀。 */
export const PILE_PREFIX = 'pile:';

/**
 * 模块视图固定模板位（ADR 0002 §7.1「固定模板位」）：六堆锚点（图坐标；
 * cy.fit 取景）。行 1 左→右：Dashboard / 共享契约 / MCP 服务 / 依赖图引擎；
 * 行 2：信任探针 / 测试与样例。
 */
export const PILE_ANCHOR: Record<FunctionalModuleId, { x: number; y: number }> = {
  dashboard: { x: -430, y: -150 },
  'shared-contract': { x: -130, y: -150 },
  'mcp-service': { x: 170, y: -150 },
  'graph-engine': { x: 470, y: -150 },
  'trust-probes': { x: -130, y: 180 },
  'tests-samples': { x: 170, y: 180 }
};

/** 堆内网格：每行 PILE_GRID_COLS 球，题注下方 PILE_CAPTION_OFFSET_Y 起排。 */
export const PILE_GRID_COLS = 3;
export const PILE_GRID_SPACING_X = 86;
export const PILE_GRID_SPACING_Y = 74;
export const PILE_CAPTION_OFFSET_Y = 42;

/** 堆内第 index 个球的网格落点（确定性；存档位置优先于它）。 */
export function pileBallPosition(moduleId: FunctionalModuleId, index: number): { x: number; y: number } {
  const anchor = PILE_ANCHOR[moduleId];
  const col = index % PILE_GRID_COLS;
  const row = Math.floor(index / PILE_GRID_COLS);
  return {
    x: anchor.x + col * PILE_GRID_SPACING_X,
    y: anchor.y + PILE_CAPTION_OFFSET_Y + row * PILE_GRID_SPACING_Y
  };
}

export function pileIdOf(moduleId: FunctionalModuleId): string {
  return PILE_PREFIX + moduleId;
}

export function moduleIdFromPile(id: string): FunctionalModuleId | null {
  if (!id.startsWith(PILE_PREFIX)) return null;
  const rest = id.slice(PILE_PREFIX.length);
  return FUNCTIONAL_MODULES.some((m) => m.id === rest) ? (rest as FunctionalModuleId) : null;
}

/**
 * 小模块球按功能类成堆：表内文件进其模块的堆，表外文件不进任何堆（模块
 * 视图不画「未分组」球）。堆的顺序 = 模块表顺序。
 */
export function groupByModule(nodes: readonly ModuleNode[]): Map<FunctionalModuleId, ModuleNode[]> {
  const groups = new Map<FunctionalModuleId, ModuleNode[]>();
  for (const m of FUNCTIONAL_MODULES) groups.set(m.id, []);
  for (const n of nodes) {
    const mod = moduleIdOf(n.id);
    if (mod === null) continue;
    groups.get(mod)!.push(n);
  }
  for (const [k, v] of groups) if (v.length === 0) groups.delete(k);
  return groups;
}

/**
 * 模块级边：跨模块的文件边聚合重连成堆对堆的边（复用目录折叠的 rewire
 * 语义：两端都映射到堆端点、同堆内边丢弃、坍缩到同对的去重）。跨模块环
 * 保留——模块图上仍是环，cycle 样式照常点亮。
 */
export function aggregateModuleEdges(
  edges: readonly Edge[],
  moduleOf: ReadonlyMap<string, FunctionalModuleId>
): Edge[] {
  const out = new Map<string, Edge>();
  for (const e of edges) {
    const mf = moduleOf.get(e.from);
    const mt = moduleOf.get(e.to);
    if (mf === undefined || mt === undefined || mf === mt) continue;
    const rewire: Edge = { from: pileIdOf(mf), to: pileIdOf(mt) };
    out.set(`${rewire.from}->${rewire.to}`, rewire);
  }
  return [...out.values()];
}

/**
 * 标记派生：范围环（声明模块 ∪ 显式文件，表外文件只能显式点名）、已改
 * 紫、越界红角标三条独立通道。
 */
export function deriveScopeMarks(
  nodes: readonly ModuleNode[],
  scope: EditScopeDecl | null,
  edited: ReadonlySet<string>,
  outOfScope: ReadonlySet<string>
): Map<string, ScopeMarks> {
  const out = new Map<string, ScopeMarks>();
  for (const n of nodes) {
    const mod = moduleIdOf(n.id);
    const inScope =
      scope !== null && (scope.files.includes(n.id) || (mod !== null && scope.modules.includes(mod)));
    out.set(n.id, {
      inScope,
      edited: edited.has(n.id),
      outOfScope: outOfScope.has(n.id)
    });
  }
  return out;
}
