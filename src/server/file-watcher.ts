import { watch, type FSWatcher } from 'chokidar';
import { EXCLUDED_DIRECTORIES, SOURCE_EXTENSIONS } from './path-conventions.js';

/**
 * Ticket 04: debounced source-file watcher.
 *
 * Watches the repository root with chokidar and collapses bursts of
 * add/change/unlink events (editor save chains, renames = delete+create)
 * into a single onQuiesce() call after the quiet window. Output directories
 * (node_modules / dist / build / .git) are never watched, so build storms
 * cannot trigger rescans; only source extensions are reacted to.
 */

const WATCHED_EXTENSIONS = new Set<string>(SOURCE_EXTENSIONS);

/** Output directories are never watched, so build storms cannot trigger a rescan. */
const IGNORED_DIRECTORY_NAMES = EXCLUDED_DIRECTORIES;

export const DEFAULT_DEBOUNCE_MS = 400;

/** One observed source-file mutation inside a debounce window. */
export interface WatchedChange {
  path: string;
  kind: 'add' | 'change' | 'unlink';
}

export interface FileWatcherOptions {
  root: string;
  debounceMs?: number;
  /**
   * Root-relative NON-source files to react to as well (e.g. the coverage
   * report). chokidar already watches the whole tree; these paths simply
   * pass the source-extension filter.
   */
  extraWatchFiles?: readonly string[];
  /**
   * Called once per quiet window with the aggregated, ordered change list
   * (ticket 05: the incremental engine replays these events).
   */
  onQuiesce(changes: WatchedChange[]): void | Promise<void>;
  log?(msg: string): void;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: FileWatcherOptions) {}

  /** Starts watching; resolves once chokidar's initial scan is done. */
  start(): Promise<void> {
    if (this.watcher) return Promise.resolve();

    const root = this.opts.root.replace(/\\/g, '/').replace(/\/+$/, '');
    const isIgnored = (p: string): boolean => {
      const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
      const rel = norm.startsWith(root + '/') ? norm.slice(root.length + 1) : '';
      return rel.split('/').some((seg) => IGNORED_DIRECTORY_NAMES.has(seg));
    };

    const w = watch(this.opts.root, {
      ignoreInitial: true,
      ignored: (p) => isIgnored(p),
      // Editor save bursts must coalesce below the debounce window; chokidar's
      // awaitWriteFinish would double-buffer the delay, so it stays off.
      awaitWriteFinish: false
    });

    let pending: WatchedChange[] = [];
    const schedule = (change: WatchedChange): void => {
      pending.push(change);
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        const batch = pending;
        pending = [];
        void this.opts.onQuiesce(batch);
      }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    };

    const extraFiles = (this.opts.extraWatchFiles ?? []).map((f) => f.replace(/\\/g, '/'));
    const isWatched = (p: string): boolean =>
      isSourceFile(p) || extraFiles.some((f) => p.replace(/\\/g, '/').endsWith(f));

    w.on('add', (path) => {
      if (isWatched(path)) schedule({ path, kind: 'add' });
    });
    w.on('change', (path) => {
      if (isWatched(path)) schedule({ path, kind: 'change' });
    });
    w.on('unlink', (path) => {
      if (isWatched(path)) schedule({ path, kind: 'unlink' });
    });
    w.on('error', (err) => {
      // A vanished subtree or EPERM must never kill the dashboard process.
      this.opts.log?.(`watcher error: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.watcher = w;
    return new Promise((resolve) => w.once('ready', () => resolve()));
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const w = this.watcher;
    this.watcher = null;
    if (w) await w.close();
  }
}

function isSourceFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash) return false;
  return WATCHED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
