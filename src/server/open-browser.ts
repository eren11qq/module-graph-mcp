import { spawn } from 'node:child_process';

export interface OpenOptions {
  /** Set via --no-open flag or MODULE_GRAPH_NO_OPEN=1 (tests use this). */
  noOpen?: boolean;
}

export interface AutoOpenDecision {
  /** --no-open: never open, whatever else is true. */
  noOpen: boolean;
  /** --open: always open, even when a same-root instance already serves a tab. */
  forceOpen: boolean;
  /** True when the preferred port was busy and this instance bound a later one. */
  portBumped: boolean;
  /**
   * True when the port-band walk found another live instance watching the
   * SAME root — this instance is that project's secondary and must stay
   * headless. `false` also covers the preferred-port holder: it is the root's
   * primary by construction (a same-root instance can only ever sit on a
   * later, bumped port).
   */
  sameRootHolder: boolean;
}

/**
 * Auto-open policy (file-granular): an MCP client spawns one server
 * process per session, and a desktop client spawns one per project at app
 * open — popping at startup produced N tabs before the user touched anything.
 * So the decision computed here is only ARMED at startup; index.ts executes
 * it per file: each distinct module the agent opens (file-targeted tool call,
 * or a relayed event naming that file) pops the dashboard once, and files
 * never opened never pop. Within one root exactly one instance arms: the one
 * that owns its preferred port, or the bumped instance when the band scan
 * finds no same-root holder. `--open` overrides the dedup, `--no-open`
 * overrides everything.
 */
export function shouldAutoOpen(d: AutoOpenDecision): boolean {
  if (d.noOpen) return false;
  if (d.forceOpen) return true;
  if (!d.portBumped) return true;
  return !d.sameRootHolder;
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
      // windowsHide keeps cmd.exe from flashing a console window on Windows —
    // that flash was the second "popup" users saw per new session.
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => launchNext(index + 1));
      child.unref();
    } catch {
      launchNext(index + 1);
    }
  };
  launchNext(0);
  return undefined;
}
