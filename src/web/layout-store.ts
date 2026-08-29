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
 */

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutStore {
  /** Archived positions for a root; empty map when nothing is on file. */
  load(rootPath: string): Map<string, LayoutPoint>;
  /** Replace one root's archive wholesale (drops entries for gone nodes). */
  save(rootPath: string, positions: ReadonlyMap<string, LayoutPoint>): void;
  /** Upsert one ball — the drag-free path (drag = user intent = authoritative). */
  update(rootPath: string, id: string, point: LayoutPoint): void;
  /** Forget a root's archive (重置布局 re-solves from scratch). */
  clear(rootPath: string): void;
}

interface ArchiveFile {
  v: number;
  roots: Record<string, Record<string, LayoutPoint>>;
}

const ARCHIVE_VERSION = 1;

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
      const root = archive.roots[rootPath];
      if (root === undefined) return out;
      for (const [id, p] of Object.entries(root)) {
        // 逐点校验:手工编辑 localStorage 打出的NaN不该进渲染管线。
        if (typeof p?.x === 'number' && Number.isFinite(p.x) && typeof p?.y === 'number' && Number.isFinite(p.y)) {
          out.set(id, { x: p.x, y: p.y });
        }
      }
      return out;
    },
    save(rootPath: string, positions: ReadonlyMap<string, LayoutPoint>): void {
      const root: Record<string, LayoutPoint> = {};
      for (const [id, p] of positions) root[id] = { x: p.x, y: p.y };
      archive.roots[rootPath] = root;
      persist();
    },
    update(rootPath: string, id: string, point: LayoutPoint): void {
      const root = archive.roots[rootPath] ?? (archive.roots[rootPath] = {});
      root[id] = { x: point.x, y: point.y };
      persist();
    },
    clear(rootPath: string): void {
      delete archive.roots[rootPath];
      persist();
    }
  };
}
