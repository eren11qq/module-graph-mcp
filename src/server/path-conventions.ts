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

/**
 * Agent 输入路径卫生的单一事实源：去空白、反斜杠转 POSIX、剥前导 ./；
 * 空输入（'./'、'/'）返回 ""。此前同一段三元式在 mcp.ts 与 edit-scope.ts
 * 里逐字抄写三份——现在只住这里。
 */
export function normalizeFilePath(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return p === './' || p === '/' ? '' : p;
}
