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
   * rootPath reported by whoever owns the preferred port; null when the probe
   * failed or the port is held by something that is not a module-graph server.
   */
  primaryRoot: string | null;
  /** This instance's realpath'd watched root. */
  rootPath: string;
}

/**
 * Auto-open policy (code-review 2026-08-29): an MCP client spawns one server
 * process per session, so opening unconditionally produced one browser tab
 * (plus a console flash on Windows) per new session. Now only the FIRST
 * instance of a given root opens the dashboard; a second session on the same
 * root stays headless and forwards its activity to the first instance's page
 * instead. `--open` overrides the dedup, `--no-open` overrides everything.
 */
export function shouldAutoOpen(d: AutoOpenDecision): boolean {
  if (d.noOpen) return false;
  if (d.forceOpen) return true;
  if (!d.portBumped) return true;
  // A bumped port with no identifiable same-root primary means the port is
  // free real estate (foreign process or probe failure) — open our own tab.
  return d.primaryRoot !== d.rootPath;
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
