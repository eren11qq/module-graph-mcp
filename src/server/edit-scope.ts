/**
 * 改动核对 (ADR 0002 / MODULE-DESIGN §7.2) — declare_edit_scope /
 * report_edits 背后的纯判定。核对不靠 AI 自觉：声明范围 + 上报改动 +
 * watcher 磁盘事实（recent-changes）三方交叉，范围外与漏报都判红。
 *
 * 纯函数 seam（verifyEdits / normalizeFilePath）由 tests/edit-scope.test.ts
 * 覆盖；会话状态（createEditScopeStore）挂在 buildTools 实例里，重启即清。
 *
 * Ticket 13 修法 A（scope epoch）：核对从「全量滚动记录 vs 当前 scope」升级
 * 为「声明时刻之后的记录 vs 当前 scope」。每次成功声明盖 declaredAt 基线，
 * watcher 证据 changedAt < declaredAt → 归 preexisting（给人看的历史残留，
 * 不算红、不影响 ok）；未声明 → 不设下界（一切照旧判越界，保守方向不变）。
 * 已知权衡（ADR 0002）：声明之后落盘的人工改动仍会被算进 agent 代——单
 * agent 场景下可接受的保守方向。同一秒的竞态按 ≥ 归入代内。
 */

import { MODULE_IDS, moduleIdOf } from '../shared/module-table.js';

/** Agent 声明的改动边界：modules（功能模块 id）+ files（显式文件，POSIX 相对路径）。 */
export interface DeclaredEditScope {
  modules: readonly string[];
  files: readonly string[];
  /** 声明时刻（ms，store 盖章）；watcher 证据早于此 → preexisting。手工构造可缺省 = 不设下界。 */
  declaredAt?: number;
}

/** 一条带时间的 watcher 磁盘事实（结构上兼容 RecentChange）。 */
export interface WatcherFact {
  id: string;
  /** 裸 id（字符串入参）视为无时间信息 → 永不豁免，保守方向。 */
  changedAt: number;
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
  /**
   * watcher 有、但 changedAt 早于 declaredAt 基线的记录（上一代残留）：
   * 在/不在范围都列进来。不算越界、不算漏报、不影响 ok。
   */
  preexisting: string[];
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
 * 核对：watcher 证据先按 declaredAt 基线过滤——changedAt < declaredAt 的
 * 记录归 preexisting（不算红）；代内事实再做判定：越界 = (上报 ∪ watcher)
 * ∖ 范围，来源标签去重（reported 优先）；漏报 = watcher 有而上报无。范围
 * 未声明（或声明无基线）时不设下界，一切 watcher 改动皆参与判定。
 * 上报侧不受基线豁免——自己上报的越界永远有罪。
 */
export function verifyEdits(
  scope: DeclaredEditScope | null,
  reported: readonly string[],
  watcherRecorded: readonly (string | WatcherFact)[]
): EditVerification {
  const baseline = scope?.declaredAt;
  const watcher: string[] = [];
  const preexisting = new Set<string>();
  for (const entry of watcherRecorded) {
    // 裸 id = 无时间信息 → 永不豁免（保守方向），即使设了基线也参与判定。
    const id = typeof entry === 'string' ? entry : entry.id;
    const changedAt = typeof entry === 'string' ? null : entry.changedAt;
    if (baseline !== undefined && changedAt !== null && changedAt < baseline) preexisting.add(id);
    else if (!watcher.includes(id)) watcher.push(id);
  }

  const outOfScope: OutOfScopeEdit[] = [];
  const seen = new Set<string>();
  const push = (id: string, source: OutOfScopeEdit['source']): void => {
    if (seen.has(id)) return;
    seen.add(id);
    outOfScope.push({ id, source });
  };
  for (const id of reported) if (!isInScope(id, scope)) push(id, 'reported');
  for (const id of watcher) if (!isInScope(id, scope)) push(id, 'watcher');

  const reportedSet = new Set(reported);
  const unreported = watcher.filter((id) => !reportedSet.has(id));

  return {
    scopeDeclared: scope !== null,
    declaredModules: scope?.modules ?? [],
    declaredFiles: scope?.files ?? [],
    outOfScope,
    unreported,
    preexisting: [...preexisting],
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
      scope =
        next.modules.length === 0 && next.files.length === 0
          ? null
          : { ...next, declaredAt: Date.now() };
    },
    current(): DeclaredEditScope | null {
      return scope;
    }
  };
}

/** 声明里合法的模块 id 清单（declare_edit_scope 校验用）——直接引用模块表，单一事实源。 */
export const VALID_MODULE_IDS: readonly string[] = MODULE_IDS;
