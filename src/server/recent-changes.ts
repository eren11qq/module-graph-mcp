/**
 * Bounded record of recently changed files (GitNexus port, plan step 3): the
 * evidence chain get_change_impact replays and report_edits cross-checks.
 * The watcher window records the RAW event paths (root-normalised, filtered
 * to source extensions — non-source files like the coverage report are
 * watched for remap but never enter the evidence chain) — recording only
 * the GraphDelta would miss the most common case, a pure content edit of
 * an already-known file, which produces an empty delta.
 *
 * Ticket 13 修法 B（证据灭失加固）：给 rootPath 即落盘
 * `<root>/.module-graph/recent-changes.json`，与 reviews.json 同目录同卫生
 * （.gitignore 自举、坏文件即空、启动回灌 newest-first 截到容量、原子
 * tmp+rename、写失败仅内存）。server 重启不再清空证据链——「声明范围 →
 * 真改越界文件 → 重启 → report_edits 看不见那笔越界」的假绿路径被堵住。
 * 残余已知缺口：单会话内连改 >RECENT_CHANGES_CAP 个文件时最旧记录仍会从
 * 核对窗口里滑走（容量语义不变，故意保守）。不给 rootPath → 纯内存（测试
 * 与裸管线保持旧行为）。
 */

import { createDotModuleStore, DOT_MODULE_DIR, errText, type DotModuleStore } from './dot-module-store.js';
import { SOURCE_EXTENSIONS } from './path-conventions.js';

/** Only source-extension ids enter the evidence chain: the coverage report
 * (watched via extraWatchFiles) is a real file event but never a module id —
 * recording it would put "I never touched this" noise into get_change_impact. */
function isSourceId(id: string): boolean {
  const dot = id.lastIndexOf('.');
  const slash = id.lastIndexOf('/');
  return dot > slash && (SOURCE_EXTENSIONS as readonly string[]).includes(id.slice(dot));
}

export interface RecentChange {
  /** Root-relative module id (same vocabulary as GraphSnapshot node ids). */
  id: string;
  /** Wall-clock ms of the most recent recording of this path. */
  changedAt: number;
}

/** Newest-wins capacity: recording past the cap evicts the OLDEST entry. */
export const RECENT_CHANGES_CAP = 100;

export interface RecentChanges {
  /**
   * Record root-relative ids (or null/undefined for outside-root paths —
   * skipped). Re-recording a path refreshes its timestamp.
   */
  record(paths: ReadonlyArray<string | null | undefined>): void;
  /** Newest first; same-millisecond ties break by id ascending. */
  list(): RecentChange[];
  clear(): void;
}

export interface RecentChangesOptions {
  /** Persist under `<rootPath>/.module-graph/`; omitted → memory-only (legacy). */
  rootPath?: string;
  log?(msg: string): void;
}

const STORE_FILE = 'recent-changes.json';
const SCHEMA_VERSION = 1;

interface PersistedFile {
  version?: unknown;
  changes?: unknown;
}

export function createRecentChanges(opts: RecentChangesOptions = {}): RecentChanges {
  // Insertion order = recency order: re-recording a path deletes + re-inserts
  // it, so the OLDEST entry is always the Map's first key and eviction is O(1)
  // without scanning for a minimum.
  const entries = new Map<string, number>();
  const log = opts.log ?? (() => {});

  const store: DotModuleStore | null = opts.rootPath
    ? createDotModuleStore({
        rootPath: opts.rootPath,
        fileName: STORE_FILE,
        version: SCHEMA_VERSION,
        log: (m) => log(`changes      : ${m}`)
      })
    : null;

  /** Disk view: valid entries oldest-first, truncated to the cap. No file / corrupt / unreadable → empty. */
  function readDisk(): RecentChange[] {
    if (store === null) return [];
    const r = store.loadRaw();
    if (r.status === 'empty') {
      if (r.reason === 'corrupt') {
        store.warn(`ignoring corrupt ${DOT_MODULE_DIR}/${STORE_FILE} (treating as empty)`);
      }
      return [];
    }
    const body = r.body as PersistedFile;
    if (!Array.isArray(body.changes)) return [];
    const out: RecentChange[] = [];
    for (const item of body.changes) {
      if (typeof item !== 'object' || item === null) continue;
      const c = item as Record<string, unknown>;
      if (typeof c.id !== 'string' || c.id.length === 0 || !isSourceId(c.id)) continue;
      if (typeof c.changedAt !== 'number' || !Number.isFinite(c.changedAt)) continue;
      out.push({ id: c.id, changedAt: c.changedAt });
    }
    out.sort((a, b) => a.changedAt - b.changedAt || a.id.localeCompare(b.id));
    return out.slice(-RECENT_CHANGES_CAP);
  }

  if (store !== null) {
    const disk = readDisk();
    if (disk.length > 0) {
      for (const c of disk) entries.set(c.id, c.changedAt);
      log(`changes      : restored ${disk.length} recent change${disk.length === 1 ? '' : 's'} from ${DOT_MODULE_DIR}/${STORE_FILE}`);
    }
  }

  /**
   * Mirror memory to disk, merged with the current disk view so a same-root
   * sibling process' records survive (newest wins per id, total capped); the
   * store writes it atomically (tmp → rename). Sync write: watcher windows
   * are debounced bursts of a small file; no shutdown flush hook needed.
   */
  function persist(): void {
    if (store === null) return;
    const merged = new Map<string, number>();
    for (const c of readDisk()) merged.set(c.id, c.changedAt);
    for (const [id, changedAt] of entries) {
      const known = merged.get(id);
      if (known === undefined || known <= changedAt) merged.set(id, changedAt);
    }
    const retained = [...merged.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(-RECENT_CHANGES_CAP);
    const body: PersistedFile = {
      version: SCHEMA_VERSION,
      changes: retained.map(([id, changedAt]) => ({ id, changedAt }))
    };
    const r = store.saveRaw(body);
    if (!r.ok) {
      store.warn(`persist failed (${errText(r.err)}), keeping changes in memory only`);
    }
  }

  return {
    record(paths) {
      let touched = false;
      for (const p of paths) {
        if (typeof p !== 'string' || p.length === 0 || !isSourceId(p)) continue;
        entries.delete(p);
        entries.set(p, Date.now());
        touched = true;
      }
      while (entries.size > RECENT_CHANGES_CAP) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      if (touched) persist();
    },
    list() {
      return [...entries.entries()]
        .map(([id, changedAt]) => ({ id, changedAt }))
        .sort((a, b) => b.changedAt - a.changedAt || a.id.localeCompare(b.id));
    },
    clear() {
      entries.clear();
      // 无文件 = 无可清（收编前如此）；有文件则经 store 原子写空——clear
      // 曾是目录里唯一的非原子写手,现与 persist 同路(tmp → rename)。
      if (store === null) return;
      const r0 = store.loadRaw();
      if (r0.status === 'empty' && r0.reason === 'missing') return;
      const r = store.saveRaw({ version: SCHEMA_VERSION, changes: [] });
      if (!r.ok) store.warn(`clear failed (${errText(r.err)})`);
    }
  };
}
