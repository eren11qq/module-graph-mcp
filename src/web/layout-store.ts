import { CHROME } from './theme.js';

/**
 * 布局存档 (Code-review 2026-08-29): the LAST STABLE layout is the single
 * authority on where balls sit across sessions and server restarts. Obsidian's
 * Persistent Graph made native: every archived position is a post-compass-
 * translation drift base (physics.bases()), so a reload replays fcose from the
 * previous resting spots (randomize:false) and the region pass re-aligns to
 * ≈ the same poster — no from-scratch re-solve, no cross-session drift.
 *
 * The archive is keyed by GraphSnapshot.rootPath (one browser may host several
 * repos), versioned so a format change invalidates silently, and degrades to
 * memory-only under private mode / quota errors (the deleted mg-theme storage
 * used to take the same posture; review #5, 2026-09-05).
 *
 * ADR 0003: 单一海报视图 = 单档存档 —— rootPath 即全部键（曾经的
 * rootPath + 视图模式分档随模块视图一起退役）。
 */

export interface LayoutPoint {
  x: number;
  y: number;
}

/**
 * 排列模式（ADR 0004）：regions = 现行区域罗盘海报，cluster = 确定性螺旋
 * 聚类海报。两模式共用同一份「最后稳定布局」存档（D5 单档 write-through），
 * 模式本身按 rootPath 另存一份标注（D1），跨重载持久。
 */
export type LayoutMode = 'regions' | 'cluster';

export interface LayoutStore {
  /** Archived positions for a root; empty map when nothing is on file. */
  load(rootPath: string): Map<string, LayoutPoint>;
  /** Replace one root's archive wholesale (drops entries for gone nodes). */
  save(rootPath: string, positions: ReadonlyMap<string, LayoutPoint>): void;
  /** Upsert one ball — the drag-free path (drag = user intent = authoritative). */
  update(rootPath: string, id: string, point: LayoutPoint): void;
  /** Forget a root's archive (重置布局全清). */
  clear(rootPath: string): void;
  /** 该 root 的排列模式；无记录 / 脏值一律回落 'cluster'（D1 翻转：2026-09-01 用户裁定 R2）。 */
  getMode(rootPath: string): LayoutMode;
  /** 记住该 root 的排列模式（与位置存档同文件、并列顶层字段）。 */
  setMode(rootPath: string, mode: LayoutMode): void;
}

interface ArchiveFile {
  v: number;
  roots: Record<string, Record<string, LayoutPoint>>;
  /**
   * 聚类排列模式 2026-09-01 (ADR 0004/D1): 可选顶层字段——旧档缺它照常有效，
   * 所以 **不升 ARCHIVE_VERSION**（升版本 = 全档作废，违背向后兼容）。
   */
  modes?: Record<string, LayoutMode>;
}

// 2026-08-31 间距参数换代 (fcose 等空隙 idealEdgeLength + 四力重调):v 1→2,
// 旧档一次性作废、按新参数从头重解(手摆球位随之重置一次,之后照常存档)。
// 同日二次换代 (大球间距:尺寸感知 nodeRepulsion):v 2→3,再作废一次。
// ADR 0002 模板模式 (按模式分档):v 3→4,旧单档档案整体作废。
// 模板位 v2 (六堆二维展开):v 4→5,旧档球网格挂在旧锚点旁,锚点搬家后一次性
// 作废、重解一次(手摆球位随之重置),否则球会脱离堆。
// ADR 0003 模块视图退役 (存档收敛回 rootPath 单档):v 5→6,旧分档档案整体
// 作废、不迁移——海报重解一次,之后照常存档。
// 2026-09-01 聚类排列模式 (ADR 0004/D1): modes 为新增可选顶层字段,旧档缺它
// 照常有效——故不升版本,升版本 = 全档作废。同日修正 (用户裁定 R2): 缺省翻转为
// 'cluster' (旧档无 modes 首次以聚类海报呈现,切回区域时位置存档照常回放)。
const ARCHIVE_VERSION = 6;

function emptyArchive(): ArchiveFile {
  return { v: ARCHIVE_VERSION, roots: {} };
}

function readArchive(): ArchiveFile {
  try {
    const raw = localStorage.getItem(CHROME.layoutStorageKey);
    if (raw === null) return emptyArchive();
    const parsed = JSON.parse(raw) as ArchiveFile;
    // 版本不符或结构损坏 → 整档作废,从头解一次是可接受的代价。
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.v !== ARCHIVE_VERSION ||
      typeof parsed.roots !== 'object' ||
      parsed.roots === null
    ) {
      return emptyArchive();
    }
    return parsed;
  } catch {
    return emptyArchive(); // 隐私模式或损坏 JSON
  }
}

export function createLayoutStore(): LayoutStore {
  let archive = readArchive();

  function persist(): void {
    try {
      localStorage.setItem(CHROME.layoutStorageKey, JSON.stringify(archive));
    } catch {
      /* private mode: 存档只在内存存活,布局行为不变 */
    }
  }

  return {
    load(rootPath: string): Map<string, LayoutPoint> {
      const out = new Map<string, LayoutPoint>();
      const bucket = archive.roots[rootPath];
      if (bucket === undefined) return out;
      for (const [id, p] of Object.entries(bucket)) {
        // 逐点校验:手工编辑 localStorage 打出的NaN不该进渲染管线。
        if (typeof p?.x === 'number' && Number.isFinite(p.x) && typeof p?.y === 'number' && Number.isFinite(p.y)) {
          out.set(id, { x: p.x, y: p.y });
        }
      }
      return out;
    },
    save(rootPath: string, positions: ReadonlyMap<string, LayoutPoint>): void {
      const bucket: Record<string, LayoutPoint> = {};
      for (const [id, p] of positions) bucket[id] = { x: p.x, y: p.y };
      archive.roots[rootPath] = bucket;
      persist();
    },
    update(rootPath: string, id: string, point: LayoutPoint): void {
      const bucket = archive.roots[rootPath] ?? (archive.roots[rootPath] = {});
      bucket[id] = { x: point.x, y: point.y };
      persist();
    },
    clear(rootPath: string): void {
      delete archive.roots[rootPath];
      // 重置布局只清位置档案；排列模式是用户选择，不随布局一起清。
      persist();
    },
    getMode(rootPath: string): LayoutMode {
      // 2026-09-01 用户裁定 R2 (D1 翻转): 只认显式 'regions',其余
      // (缺省 / 手改脏值) 一律 'cluster'——聚类海报是新的开场默认。
      return archive.modes?.[rootPath] === 'regions' ? 'regions' : 'cluster';
    },
    setMode(rootPath: string, mode: LayoutMode): void {
      const sanitized: LayoutMode = mode === 'regions' ? 'regions' : 'cluster';
      archive.modes = { ...archive.modes, [rootPath]: sanitized };
      persist();
    }
  };
}
