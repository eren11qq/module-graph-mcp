import { spawn } from 'node:child_process';

export interface OpenOptions {
  /** Set via --no-open flag or MODULE_GRAPH_NO_OPEN=1 (tests use this). */
  noOpen?: boolean;
}

/**
 * Open the dashboard URL in the user's default browser.
 * Best-effort: never throws, failures are reported via the returned message.
 * Human-facing side channel — call sites must not print to stdout (it carries MCP JSON-RPC).
 */
export function openBrowser(url: string, opts: OpenOptions = {}): string | undefined {
  if (opts.noOpen || process.env.MODULE_GRAPH_NO_OPEN === '1') return 'browser auto-open suppressed';

  const candidates: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['cmd.exe', ['/c', 'start', '', url]]]
      : process.platform === 'darwin'
        ? [['open', [url]]]
        : [
            ['wslview', [url]],
            ['xdg-open', [url]]
          ];

  // spawn() does not throw for ENOENT — the failure only surfaces as an
  // async 'error' event, so candidates are tried via that event chain.
  // Signature stays synchronous (call sites log the return value directly);
  // total failure is reported on stderr, the human-facing side channel.
  const launchNext = (index: number): void => {
    if (index >= candidates.length) {
      process.stderr.write(`module-graph-mcp: could not launch a browser; open manually: ${url}\n`);
      return;
    }
    // candidates.length guarantees entry exists (checked above); the non-null
    // assertion replaces the old unreachable runtime guard.
    const [cmd, args] = candidates[index]!;
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => launchNext(index + 1));
      child.unref();
    } catch {
      launchNext(index + 1);
    }
  };
  launchNext(0);
  return undefined;
}
