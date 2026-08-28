import type { ModuleNode } from '../shared/types.js';

/**
 * Single source of truth for the server-side file conventions: which files
 * count as source files, which language label each extension carries and
 * which directories are never entered. Previously duplicated (four copies of
 * the extension list, three of the exclusion set); now shared by
 * incremental-graph, coverage and file-watcher.
 */

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'] as const;
export type SourceExtension = (typeof SOURCE_EXTENSIONS)[number];

export const LANGUAGE_BY_EXTENSION: Record<SourceExtension, ModuleNode['language']> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx'
};

/** Never entered at any depth; these produce neither nodes nor edges. */
export const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.git']);
