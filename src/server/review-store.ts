import { createDotModuleStore, DOT_MODULE_DIR, errText } from './dot-module-store.js';
import { MAX_REVIEW_SUMMARY, normalizeVerdicts } from './review-lifecycle.js';
import type { AiReview, ModuleNode } from '../shared/types.js';

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
 *   本地墓碑集合保证删除意图不被磁盘残留复活）。fs 仪式（原子
 *   tmp+rename、gitignore 自举、坏文件/只读盘降级仅内存、告警一次）
 *   委托落盘卫生层 dot-module-store，本模块只留解码与墓碑合并。
 */

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

export function createReviewStore(opts: ReviewStoreOptions): ReviewStore {
  const store = createDotModuleStore({
    rootPath: opts.rootPath,
    fileName: STORE_FILE,
    version: SCHEMA_VERSION,
    log: (m) => (opts.log ?? (() => {}))(`reviews      : ${m}`)
  });

  /** 本进程持有的最新视图：id → done 评审（合并过磁盘，含其它会话的结论）。 */
  const reviews = new Map<string, AiReview>();
  /** 本进程删除过的 id —— 写合并时这些必须从磁盘残留中剔掉（墓碑）。 */
  const deleted = new Set<string>();

  function readDisk(): Map<string, AiReview> {
    const r = store.loadRaw();
    if (r.status === 'empty') {
      if (r.reason === 'corrupt') {
        store.warn(`ignoring corrupt ${DOT_MODULE_DIR}/${STORE_FILE} (treating as empty)`);
      }
      return new Map(); // missing/version → 静默空（收编前如此）
    }
    const body = r.body as PersistedFile;
    if (typeof body.reviews !== 'object' || body.reviews === null) {
      return new Map();
    }
    const out = new Map<string, AiReview>();
    for (const [id, value] of Object.entries(body.reviews)) {
      const review = cleanReview(value);
      if (review !== undefined) out.set(id, review);
    }
    return out;
  }

  /**
   * 只认 done 结论；其余（checking / 形状不对）一律丢弃。verdict 清洗
   * 委托生命周期的 normalizeVerdicts——磁盘复活必须与 end_review 活路径
   * 产出逐字节同形（行排序 / 每行最后一条生效 / 同一批上限截断），
   * 第二清洗器是已实证的漂移源（候选 #2，2026-09-05），本模块不再自持。
   */
  function cleanReview(value: unknown): AiReview | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (v.status !== 'done') return undefined;
    if (!Array.isArray(v.verdicts)) return undefined;
    const review: AiReview = { status: 'done', verdicts: normalizeVerdicts(v.verdicts) };
    if (typeof v.summary === 'string' && v.summary.trim().length > 0) {
      review.summary = v.summary.trim().slice(0, MAX_REVIEW_SUMMARY);
    }
    if (typeof v.reviewedAt === 'number' && Number.isFinite(v.reviewedAt)) {
      review.reviewedAt = v.reviewedAt;
    }
    return review;
  }

  /**
   * 合并磁盘当前内容（并发会话的并集）+ 本进程视图，交给 store 原子落盘
   * （tmp → rename）。同步写：end_review 低频（agent 每文件几次），小文件
   * 亚毫秒级；关停路径不需要 flush 钩子，这是「常驻」不丢的最后一道保证。
   */
  function persist(): void {
    const merged = readDisk();
    for (const id of deleted) merged.delete(id);
    for (const [id, review] of reviews) merged.set(id, review);
    const body: PersistedFile = {
      version: SCHEMA_VERSION,
      reviews: Object.fromEntries(
        [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, r]) => [id, r])
      )
    };
    const r = store.saveRaw(body);
    if (!r.ok) {
      store.warn(`persist failed (${errText(r.err)}), keeping reviews in memory only`);
      return;
    }
    // 本进程视图 = 写出的并集：下次写不会丢掉其它会话刚落的结论。
    reviews.clear();
    for (const [id, rev] of merged) reviews.set(id, rev);
    deleted.clear();
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
