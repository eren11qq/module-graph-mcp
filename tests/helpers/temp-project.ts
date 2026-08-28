import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway directory tree for graph-engine / watcher / pipeline scenarios.
 * Nested paths are created implicitly; call sites rm(root, recursive) when done.
 */
export async function makeTempProject(
  files: Record<string, string> = {},
  prefix = 'module-graph-'
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return root;
}
