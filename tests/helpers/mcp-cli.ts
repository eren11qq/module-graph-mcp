import { spawn } from 'node:child_process';

/**
 * Run the compiled CLI (dist/server/index.js) to completion and collect its
 * streams — the single implementation of the "spawn, gather stdout/stderr,
 * await exit code" ritual that mcp-e2e / mcp-guardrails each hand-rolled
 * several times. MODULE_GRAPH_NO_OPEN=1 is forced: a CLI test never opens a
 * browser.
 */
export function runServerCli(
  args: readonly string[],
  env: Record<string, string> = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['dist/server/index.js', ...args], {
    env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1', ...env }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString('utf8');
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout, stderr })));
}
