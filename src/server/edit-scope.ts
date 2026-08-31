/**
 * 改动核对 (ADR 0002 / MODULE-DESIGN §7.2) — declare_edit_scope /
 * report_edits 背后的纯判定。核对不靠 AI 自觉：声明范围 + 上报改动 +
 * watcher 磁盘事实（recent-changes）三方交叉，范围外与漏报都判红。
 *
 * 纯函数 seam（verifyEdits / normalizeFilePath）由 tests/edit-scope.test.ts
 * 覆盖；会话状态（createEditScopeStore）挂在 buildTools 实例里，重启即清。
 */

import { MODULE_IDS, moduleIdOf } from '../shared/module-table.js';

/** Agent 声明的改动边界：modules（功能模块 id）+ files（显式文件，POSIX 相对路径）。 */
export interface DeclaredEditScope {
  modules: readonly string[];
  files: readonly string[];
}

/** 一条越界改动：改动事实的来源决定判词。 */
export interface OutOfScopeEdit {
  id: string;
  /** reported = agent 自己上报；watcher = 磁盘事实（没上报也逃不掉）。 */
  source: 'reported' | 'watcher';
}

export interface EditVerification {
  scopeDeclared: boolean;
  declaredModules: readonly string[];
  declaredFiles: readonly string[];
  outOfScope: OutOfScopeEdit[];
  /** watcher 看见但 agent 没上报的改动（漏报）。 */
  unreported: string[];
  /** true 当且仅当没有越界也没有漏报。 */
  ok: boolean;
}

/**
 * 范围判定：文件在范围内 ⇔ 显式点名，或属于某个已声明的功能模块。表外
 * 文件（moduleIdOf === null）只能靠显式点名进入范围。
 */
/** 范围判定（mcp 工具与纯函数共用）：显式点名，或属于已声明的功能模块。 */
export function isInScope(id: string, scope: DeclaredEditScope | null): boolean {
  if (scope === null) return false;
  if (scope.files.includes(id)) return true;
  const mod = moduleIdOf(id);
  return mod !== null && scope.modules.includes(mod);
}

/**
 * 核对：越界 = (上报 ∪ watcher) ∖ 范围，来源标签去重（reported 优先）；
 * 漏报 = watcher 有而上报无。范围未声明时一切改动皆越界。
 */
export function verifyEdits(
  scope: DeclaredEditScope | null,
  reported: readonly string[],
  watcherRecorded: readonly string[]
): EditVerification {
  const outOfScope: OutOfScopeEdit[] = [];
  const seen = new Set<string>();
  const push = (id: string, source: OutOfScopeEdit['source']): void => {
    if (seen.has(id)) return;
    seen.add(id);
    outOfScope.push({ id, source });
  };
  for (const id of reported) if (!isInScope(id, scope)) push(id, 'reported');
  for (const id of watcherRecorded) if (!isInScope(id, scope)) push(id, 'watcher');

  const reportedSet = new Set(reported);
  const unreported = watcherRecorded.filter((id) => !reportedSet.has(id));

  return {
    scopeDeclared: scope !== null,
    declaredModules: scope?.modules ?? [],
    declaredFiles: scope?.files ?? [],
    outOfScope,
    unreported,
    ok: outOfScope.length === 0 && unreported.length === 0
  };
}

/** Agent 输入卫生：去空白、反斜杠转 POSIX、剥前导 ./；空输入返回 "". */
export function normalizeFilePath(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return p === './' || p === '/' ? '' : p;
}

export interface EditScopeStore {
  declare(scope: DeclaredEditScope): void;
  /** 当前范围；从未声明或声明过空范围 → null。 */
  current(): DeclaredEditScope | null;
}

export function createEditScopeStore(): EditScopeStore {
  let scope: DeclaredEditScope | null = null;
  return {
    declare(next: DeclaredEditScope): void {
      scope = next.modules.length === 0 && next.files.length === 0 ? null : next;
    },
    current(): DeclaredEditScope | null {
      return scope;
    }
  };
}

/** 声明里合法的模块 id 清单（declare_edit_scope 校验用）——直接引用模块表，单一事实源。 */
export const VALID_MODULE_IDS: readonly string[] = MODULE_IDS;
