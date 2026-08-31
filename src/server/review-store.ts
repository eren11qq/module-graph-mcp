import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AiReview, AiReviewEntry, AiVerdict, ModuleNode } from '../shared/types.js';

/**
 * Persistent AI-review store（常驻，2026-09-01）。
 *
 * 用户痛点：弹窗 dashboard 页面一关（会话/进程结束），小球上的评审痕迹
 * （绿环 = 全 confident、黄环 = 有 unsure、红环 = 有 error）就随内存清空。
 * 本模块把 end_review 落地的「已检查」结论持久化到被监视根目录下的
 * `.module-graph/reviews.json`，下次冷启动 fullScan 之后重新挂回节点——
 * 检查过的痕迹常驻，跨重启、跨会话、跨弹窗页面保留。
 *
 * 语义边界（写进契约）：
 * - 只持久化 **done** 结论（end_review 的产出）。checking 中间态是瞬态
 *   （约 10 分钟无人收尾自动回落），持久化它只会让重启后恢复一个没有
 *   定时器的死脉冲——load 时一律丢弃。
 * - begin/update 不触碰磁盘：中断的复查（begin 后进程死掉）保留上一次
 *   end_review 的结论，而不是把「已检查」抹掉。
 * - 文件被 unlink（watcher 窗口）或重启后不再存在（attach 剪枝）时删除
 *   对应条目——结论跟着文件走，文件没了结论也不该复活。
 * - 并发写安全：同根多会话（secondary 转发 + primary 各自 end）各自持
 *   有内存副本，每次写前重读磁盘合并（不同文件并集、同文件后写覆盖；
 *   本地墓碑集合保证删除意图不被磁盘残留复活），原子 tmp+rename，
 *   坏文件/只读盘降级为仅内存（告警一次，绝不抛出）。
 */

const STORE_DIR = '.module-graph';
const STORE_FILE = 'reviews.json';
const SCHEMA_VERSION = 1;

/** 挂载目标：IncrementalGraph 结构性满足；测试用字面量 fake。 */
export interface ReviewGraph {
  node(id: string): ModuleNode | undefined;
  setReview(id: string, review: AiReview | undefined): boolean;
}

export interface ReviewStoreOptions {
  rootPath: string;
  log?(msg: string): void;
}

export interface ReviewStore {
  /**
   * 把磁盘上的 done 评审挂回现有节点（跳过 checking 与已不存在的文件，
   * 并顺手剪掉这两类残留条目）。返回恢复的评审数。
   */
  attachInto(graph: ReviewGraph): number;
  /** 持久化一条结论（end_review 的产出）；undefined 清除该条目。 */
  set(id: string, review: AiReview | undefined): void;
  /** 批量删除（文件 unlink 时由 live-reload 调用）。 */
  remove(ids: readonly string[]): void;
}

interface PersistedFile {
  version?: unknown;
  reviews?: unknown;
}

const AI_VERDICTS: readonly AiVerdict[] = ['confident', 'unsure', 'error'];

export function createReviewStore(opts: ReviewStoreOptions): ReviewStore {
  const root = opts.rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = `${root}/${STORE_DIR}`;
  const file = `${dir}/${STORE_FILE}`;
  const log = opts.log ?? (() => {});
  let warned = false;
  const warnOnce = (msg: string): void => {
    if (warned) return;
    warned = true;
    log(`reviews      : ${msg}`);
  };

  /** 本进程持有的最新视图：id → done 评审（合并过磁盘，含其它会话的结论）。 */
  const reviews = new Map<string, AiReview>();
  /** 本进程删除过的 id —— 写合并时这些必须从磁盘残留中剔掉（墓碑）。 */
  const deleted = new Set<string>();

  function readDisk(): Map<string, AiReview> {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return new Map(); // 无文件 / 不可读 → 空
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnOnce(`ignoring corrupt ${STORE_DIR}/${STORE_FILE} (treating as empty)`);
      return new Map();
    }
    if (typeof parsed !== 'object' || parsed === null) return new Map();
    const body = parsed as PersistedFile;
    if (body.version !== SCHEMA_VERSION || typeof body.reviews !== 'object' || body.reviews === null) {
      return new Map();
    }
    const out = new Map<string, AiReview>();
    for (const [id, value] of Object.entries(body.reviews)) {
      const review = cleanReview(value);
      if (review !== undefined) out.set(id, review);
    }
    return out;
  }

  /** 只认 done 结论；其余（checking / 形状不对）一律丢弃。 */
  function cleanReview(value: unknown): AiReview | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (v.status !== 'done') return undefined;
    if (!Array.isArray(v.verdicts)) return undefined;
    const verdicts: AiReviewEntry[] = [];
    for (const item of v.verdicts) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      if (typeof e.line !== 'number' || !Number.isInteger(e.line) || e.line < 1) continue;
      if (typeof e.verdict !== 'string' || !AI_VERDICTS.includes(e.verdict as AiVerdict)) continue;
      const entry: AiReviewEntry = { line: e.line, verdict: e.verdict as AiVerdict };
      if (typeof e.message === 'string' && e.message.trim().length > 0) {
        entry.message = e.message.trim().slice(0, 200);
      }
      verdicts.push(entry);
    }
    const review: AiReview = { status: 'done', verdicts };
    if (typeof v.summary === 'string' && v.summary.trim().length > 0) {
      review.summary = v.summary.trim().slice(0, 500);
    }
    if (typeof v.reviewedAt === 'number' && Number.isFinite(v.reviewedAt)) {
      review.reviewedAt = v.reviewedAt;
    }
    return review;
  }

  /**
   * 原子写：合并磁盘当前内容（并发会话的并集）+ 本进程视图 → tmp → rename。
   * 同步写：end_review 低频（agent 每文件几次），小文件亚毫秒级；关停路径
   * 不需要 flush 钩子，这是「常驻」不丢的最后一道保证。
   */
  function persist(): void {
    const merged = readDisk();
    for (const id of deleted) merged.delete(id);
    for (const [id, review] of reviews) merged.set(id, review);
    try {
      mkdirSync(dir, { recursive: true });
      // 让 .module-graph/ 默认不进 git（评审数据不是源码；想提交可自行改）。
      // 只写一次，不覆盖用户已有的自定义 .gitignore。
      if (!existsSync(`${dir}/.gitignore`)) {
        writeFileSync(`${dir}/.gitignore`, `*\n!.gitignore\n`, 'utf8');
      }
      const body: PersistedFile = {
        version: SCHEMA_VERSION,
        reviews: Object.fromEntries(
          [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, r]) => [id, r])
        )
      };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
      // 本进程视图 = 写出的并集：下次写不会丢掉其它会话刚落的结论。
      reviews.clear();
      for (const [id, r] of merged) reviews.set(id, r);
      deleted.clear();
    } catch (err) {
      warnOnce(`persist failed (${err instanceof Error ? err.message : String(err)}), keeping reviews in memory only`);
    }
  }

  return {
    attachInto(graph: ReviewGraph): number {
      const disk = readDisk();
      let restored = 0;
      const stale: string[] = [];
      for (const [id, review] of disk) {
        if (graph.node(id) === undefined) {
          stale.push(id);
          continue;
        }
        graph.setReview(id, review);
        restored++;
      }
      // 内存视图 = 磁盘并集（后续 remove/set 基于它做合并）。
      reviews.clear();
      for (const [id, review] of disk) reviews.set(id, review);
      if (stale.length > 0) {
        for (const id of stale) {
          reviews.delete(id);
          deleted.add(id);
        }
        persist();
      }
      return restored;
    },

    set(id: string, review: AiReview | undefined): void {
      if (review === undefined) {
        reviews.delete(id);
        deleted.add(id);
      } else {
        reviews.set(id, review);
        deleted.delete(id);
      }
      persist();
    },

    remove(ids: readonly string[]): void {
      if (ids.length === 0) return;
      let touched = false;
      for (const id of ids) {
        if (reviews.delete(id)) touched = true;
        if (!deleted.has(id)) {
          deleted.add(id);
          touched = true;
        }
      }
      if (touched) persist();
    }
  };
}
