import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Lightweight .gitignore support (root file only, no third-party libraries).
 * The watched root's .gitignore decides which subtrees and files produce
 * neither nodes nor edges; an unreadable or absent .gitignore degrades to an
 * empty rule set — it must never take down a scan.
 */

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  matches(relPath: string, isDirectory: boolean): boolean;
}

export interface GitignoreMatcher {
  isIgnored(relPath: string, isDirectory: boolean): boolean;
}

/**
 * Translate one .gitignore line into a matcher. Deliberately minimal glob
 * support — enough for this project and its tests:
 *   - `*`  matches any run of characters except `/` within one segment
 *   - `**` matches across directory boundaries
 *   - `?`  matches exactly one non-`/` character
 * A pattern containing `/` is anchored to the watched root; a bare name like
 * `*.log` matches any path segment at any depth; a trailing `/` restricts to
 * directories; a leading `!` negates a previous match.
 */
export function parseIgnoreRule(rawLine: string): IgnoreRule | null {
  let line = rawLine.replace(/\s+$/, '');
  if (line.length === 0 || line.startsWith('#')) return null;

  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  }

  let dirOnly = false;
  while (line.endsWith('/')) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return null;

  // Leading "/" (or any interior slash) anchors the rule to the root.
  let anchored = false;
  if (line.startsWith('/')) {
    anchored = true;
    line = line.slice(1);
  } else if (line.includes('/')) {
    anchored = true;
  }
  if (line.length === 0) return null;

  const segmentToPattern = (segment: string): string => {
    if (segment === '**') return '(?:[^/]+/)*[^/]+';
    let out = '';
    for (const ch of segment) {
      if (ch === '*') out += '[^/]*';
      else if (ch === '?') out += '[^/]';
      else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return out;
  };

  const segments = line.split('/');
  const body = segments.map(segmentToPattern).join('/');
  const anchoredRegex = new RegExp(`^${body}$`);
  const segmentRegex = anchored ? null : new RegExp(`^(?:${body})$`);

  return {
    negate,
    dirOnly,
    matches(relPath: string, isDirectory: boolean): boolean {
      if (dirOnly && !isDirectory) return false;
      if (anchoredRegex.test(relPath)) return true;
      if (segmentRegex !== null) {
        // Unanchored rule: match any single segment of the path.
        for (const seg of relPath.split('/')) {
          if (seg.length > 0 && segmentRegex.test(seg)) return true;
        }
      }
      return false;
    }
  };
}

/** Last matching rule wins, mirroring gitignore semantics. */
export async function loadGitignore(rootAbs: string): Promise<GitignoreMatcher> {
  const rules: IgnoreRule[] = [];
  const gitignorePath = join(rootAbs, '.gitignore');
  try {
    if (existsSync(gitignorePath)) {
      const content = await readFile(gitignorePath, 'utf8');
      for (const raw of content.split('\n')) {
        const rule = parseIgnoreRule(raw);
        if (rule) rules.push(rule);
      }
    }
  } catch {
    // An unreadable .gitignore must never take down the scan.
  }
  return {
    isIgnored(relPath: string, isDirectory: boolean): boolean {
      let ignored = false;
      for (const rule of rules) {
        if (rule.matches(relPath, isDirectory)) ignored = !rule.negate;
      }
      return ignored;
    }
  };
}
