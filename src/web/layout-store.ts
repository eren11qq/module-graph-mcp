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
 * memory-only under private mode / quota errors (same posture as mg-theme).
 *
 * ADR 0002 §7.1: 按视图模式分档 — 模块视图的模板位与文件视图的 fcose 存档
 * 分开记（rootPath + mode 双键）；「重置布局」两档全清。
 */

/** 存档分档：文件视图（fcose 海报）| 模块视图（固定模板位）。 */
export type LayoutMode = 'file' | 'module';

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutStore {
  /** Archived positions for a root + mode; empty map when nothing is on file. */
  load(rootPath: string, mode: LayoutMode): Map<string, LayoutPoint>;
  /** Replace one root+mode archive wholesale (drops entries for gone nodes). */
  save(rootPath: string, positions: ReadonlyMap<string, LayoutPoint>, mode: LayoutMode): void;
  /** Upsert one ball — the drag-free path (drag = user intent = authoritative). */
  update(rootPath: string, id: string, point: LayoutPoint, mode: LayoutMode): void;
  /** Forget a root's archive(s). mode omitted = both modes (重置布局两档全清). */
  clear(rootPath: string, mode?: LayoutMode): void;
}

interface ArchiveFile {
  v: number;
  roots: Record<string, { file?: Record<string, LayoutPoint>; module?: Record<string, LayoutPoint> }>;
}

// 2026-08-31 间距参数换代 (fcose 等空隙 idealEdgeLength + 四力重调):v 1→2,
// 旧档一次性作废、按新参数从头重解(手摆球位随之重置一次,之后照常存档)。
// 同日二次换代 (大球间距:尺寸感知 nodeRepulsion):v 2→3,再作废一次。
// ADR 0002 模板模式 (按模式分档):v 3→4,旧单档档案整体作废。
const ARCHIVE_VERSION = 4;

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
    load(rootPath: string, mode: LayoutMode): Map<string, LayoutPoint> {
      const out = new Map<string, LayoutPoint>();
      const root = archive.roots[rootPath];
      if (root === undefined) return out;
      const bucket = root[mode];
      if (bucket === undefined) return out;
      for (const [id, p] of Object.entries(bucket)) {
        // 逐点校验:手工编辑 localStorage 打出的NaN不该进渲染管线。
        if (typeof p?.x === 'number' && Number.isFinite(p.x) && typeof p?.y === 'number' && Number.isFinite(p.y)) {
          out.set(id, { x: p.x, y: p.y });
        }
      }
      return out;
    },
    save(rootPath: string, positions: ReadonlyMap<string, LayoutPoint>, mode: LayoutMode): void {
      const root = archive.roots[rootPath] ?? (archive.roots[rootPath] = {});
      const bucket: Record<string, LayoutPoint> = {};
      for (const [id, p] of positions) bucket[id] = { x: p.x, y: p.y };
      root[mode] = bucket;
      persist();
    },
    update(rootPath: string, id: string, point: LayoutPoint, mode: LayoutMode): void {
      const root = archive.roots[rootPath] ?? (archive.roots[rootPath] = {});
      const bucket = root[mode] ?? (root[mode] = {});
      bucket[id] = { x: point.x, y: point.y };
      persist();
    },
    clear(rootPath: string, mode?: LayoutMode): void {
      const root = archive.roots[rootPath];
      if (root === undefined) return;
      if (mode === undefined) {
        delete archive.roots[rootPath];
      } else {
        delete root[mode];
      }
      persist();
    }
  };
}
