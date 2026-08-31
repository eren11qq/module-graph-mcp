/**
 * 功能模块表 (ADR 0002 / MODULE-DESIGN §7.1) — 模板模式的顶层分组单元与
 * 改动核对（§7.2）的单一事实源，服务端核对器与 get_dashboard_info 共用。
 *
 * 条目两种形态：目录前缀（以 '/' 结尾，命中整棵子树）或显式文件（精确
 * 匹配）。一个文件命中多个功能类 = 表冲突，测试红。表外文件不属于任何
 * 模块：不进模块视图，声明编辑范围时只能显式点名。
 *
 * v1 写死本仓库的路径前缀（同 region 表先例，零协议改动）；任意仓库支持
 * 留作配置文件升级路径（ADR 0002 后果·权衡）。
 */

export type FunctionalModuleId =
  | 'mcp-service'
  | 'graph-engine'
  | 'dashboard'
  | 'shared-contract'
  | 'trust-probes'
  | 'tests-samples';

export interface FunctionalModule {
  id: FunctionalModuleId;
  /** 中文标签（pile 题注 / get_dashboard_info 的 agent 可见名）。 */
  label: string;
  /** 目录前缀（尾 '/'）或显式文件（POSIX 相对路径），匹配顺序即优先级。 */
  entries: readonly string[];
}

export const FUNCTIONAL_MODULES: readonly FunctionalModule[] = [
  {
    id: 'mcp-service',
    label: 'MCP 服务',
    entries: [
      'src/server/mcp.ts',
      'src/server/index.ts',
      'src/server/http.ts',
      'src/server/report-page.ts',
      'src/server/open-browser.ts',
      'src/server/review-lifecycle.ts',
      'src/server/review-store.ts',
      'src/server/health-report.ts',
      'src/server/impact.ts',
      'src/server/response-budget.ts',
      'src/server/version.ts'
    ]
  },
  {
    id: 'graph-engine',
    label: '依赖图引擎',
    entries: [
      'src/server/incremental-graph.ts',
      'src/server/file-watcher.ts',
      'src/server/live-reload.ts',
      'src/server/recent-changes.ts',
      'src/server/coverage.ts',
      'src/server/source-reader.ts',
      'src/server/path-conventions.ts',
      'src/server/state-pipeline.ts',
      'src/server/typecheck.ts',
      'src/server/gitignore.ts'
    ]
  },
  {
    id: 'dashboard',
    label: 'Dashboard 渲染',
    entries: ['src/web/']
  },
  {
    id: 'shared-contract',
    label: '共享契约',
    entries: ['src/shared/']
  },
  {
    id: 'trust-probes',
    label: '信任探针',
    entries: ['src/evals/']
  },
  {
    id: 'tests-samples',
    label: '测试与样例',
    entries: ['tests/', 'test-fixtures/']
  }
];

export const MODULE_IDS: readonly FunctionalModuleId[] = FUNCTIONAL_MODULES.map((m) => m.id);

export function labelOf(moduleId: FunctionalModuleId): string {
  const m = FUNCTIONAL_MODULES.find((x) => x.id === moduleId);
  return m?.label ?? moduleId;
}

/**
 * Entry match: a trailing-slash entry is a directory prefix (the whole
 * subtree), anything else is an exact explicit-file match.
 */
export function moduleMatches(entries: readonly string[], id: string): boolean {
  for (const entry of entries) {
    if (entry.endsWith('/')) {
      if (id.length > entry.length && id.startsWith(entry)) return true;
    } else if (id === entry) {
      return true;
    }
  }
  return false;
}

/** Every functional module the id matches (table conflicts surface here). */
export function modulesOf(id: string): readonly FunctionalModuleId[] {
  const out: FunctionalModuleId[] = [];
  for (const m of FUNCTIONAL_MODULES) {
    if (moduleMatches(m.entries, id)) out.push(m.id);
  }
  return out;
}

/** First match wins — the classification the views and verifier use. */
export function moduleIdOf(id: string): FunctionalModuleId | null {
  return modulesOf(id)[0] ?? null;
}

/** Files of one module, in input order. */
export function filesInModule(ids: readonly string[], moduleId: FunctionalModuleId): string[] {
  return ids.filter((id) => moduleIdOf(id) === moduleId);
}
