import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Ticket 09/10: the single security envelope for reading one text source
 * file inside the watched root. Shared by the HTTP endpoint (/api/source)
 * and the MCP tool get_module_details, so both surfaces enforce identical
 * rules and produce identical denial reasons.
 *
 * Denial order (first hit wins):
 *   400  missing / malformed / empty path
 *   403  null byte, absolute path, `..` segment, non-whitelisted extension,
 *        resolved path escaping the root, symlink escape
 *   404  missing file
 *   415  binary payload (NUL byte sniff)
 *
 * Oversize files are NOT denied (code-review 2026-08-29): the decoded head
 * is served with truncated:true so the dashboard can still open big files.
 */

export const SOURCE_ENDPOINT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.md', '.txt'
]);

export const MAX_SOURCE_BYTES = 512 * 1024;

export interface SourceReadOk {
  ok: true;
  /** normalized root-relative POSIX path */
  path: string;
  content: string;
  /** true file size on disk, even when `content` was clipped */
  sizeBytes: number;
  /**
   * True when the file exceeded MAX_SOURCE_BYTES and `content` only holds
   * the decoded head (code-review 2026-08-29).
   */
  truncated: boolean;
}

export interface SourceReadDenied {
  ok: false;
  status: 400 | 403 | 404 | 415;
  reason: string;
  detail: string;
}

export type SourceReadResult = SourceReadOk | SourceReadDenied;

/**
 * Largest `end ≤ maxBytes` such that buffer[0..end) ends on a UTF-8 sequence
 * boundary — the tail is never a partial multi-byte character (code-review
 * 2026-08-29 truncation support). Invalid lead bytes are left to the
 * decoder's replacement fallback, as for the untruncated path.
 */
function utf8HeadEnd(buffer: Buffer, maxBytes: number): number {
  let end = Math.min(maxBytes, buffer.length);
  if (end === 0) return 0;
  let lead = end - 1;
  while (lead > 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
  const b = buffer[lead]!;
  const need =
    (b & 0x80) === 0x00 ? 1
    : (b & 0xe0) === 0xc0 ? 2
    : (b & 0xf0) === 0xe0 ? 3
    : (b & 0xf8) === 0xf0 ? 4
    : 1;
  if (end - lead < need) end = lead; // the tail sequence is cut — drop it
  return end;
}

export function readSourceFile(rootPath: string, requested: string): SourceReadResult {  const deny = (status: SourceReadDenied['status'], reason: string, detail: string): SourceReadDenied => ({
    ok: false,
    status,
    reason,
    detail
  });

  if (typeof requested !== 'string' || requested.length === 0) {
    return deny(400, 'missing path', '(no path given)');
  }
  let rel: string;
  try {
    rel = decodeURIComponent(requested);
  } catch {
    return deny(400, 'malformed encoding', requested.slice(0, 80));
  }
  if (rel.includes('\0')) {
    return deny(403, 'null byte in path', requested.slice(0, 80));
  }

  const posix = rel.replace(/\\/g, '/').trim();
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) {
    return deny(403, 'absolute path outside the watched root', posix.slice(0, 120));
  }
  const segments = posix.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    return deny(400, 'missing path', posix);
  }
  if (segments.some((s) => s === '..')) {
    return deny(403, 'path traversal (`..` segment)', posix.slice(0, 120));
  }

  const dot = posix.lastIndexOf('.');
  const slash = posix.lastIndexOf('/');
  const ext = dot > slash ? posix.slice(dot).toLowerCase() : '';
  if (!SOURCE_ENDPOINT_EXTENSIONS.has(ext)) {
    return deny(403, `extension "${ext || '(none)'}" is not on the whitelist`, posix.slice(0, 120));
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(rootPath);
  } catch {
    return deny(404, 'watched root not found', rootPath);
  }
  const abs = resolve(rootReal, ...segments);
  if (!abs.startsWith(rootReal + sep)) {
    return deny(403, 'resolved path escapes the watched root', posix.slice(0, 120));
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return deny(404, 'not found', posix);
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return deny(404, 'not found', posix);
  }
  if (!real.startsWith(rootReal + sep)) {
    return deny(403, 'symlink escapes the watched root', posix.slice(0, 120));
  }

  const size = statSync(real).size;

  const buffer = readFileSync(real);
  if (buffer.includes(0)) {
    return deny(415, 'binary content rejected', posix.slice(0, 120));
  }

  // Code-review 2026-08-29: oversize no longer denies with 413 — the first
  // MAX_SOURCE_BYTES bytes are served with truncated:true (sizeBytes stays
  // the true size). The cut is repaired to a UTF-8 sequence boundary so a
  // multi-byte character (or an astral char's surrogate pair) never decodes
  // to U+FFFD at the tail.
  const truncated = size > MAX_SOURCE_BYTES;
  const content = truncated
    ? buffer.subarray(0, utf8HeadEnd(buffer, MAX_SOURCE_BYTES)).toString('utf8')
    : buffer.toString('utf8');

  return { ok: true, path: segments.join('/'), content, sizeBytes: size, truncated };
}
