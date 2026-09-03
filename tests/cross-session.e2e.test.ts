import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { dashboardToken, getFreePort, spawnClient, type SpawnedClient } from '../src/evals/mcp-client.js';
import type { GraphEvent } from '../src/shared/types.js';

/**
 * Code-review 2026-08-29: two MCP sessions over the SAME repository root.
 * The second instance must (a) stay headless — the first instance's tab is
 * the one on screen — and (b) relay its tool-driven events to the first
 *  instance's dashboard, so one page shows every session's AI activity.
 * Popup policy (file-granular): NOBODY pops at startup; the armed primary
 * pops once per distinct file the agent opens (own tool call naming the
 * file, or a relayed event naming it) — but only while no dashboard page is
 * connected: a live tab already shows the project, further pops would stack
 * duplicate tabs. Files never opened never pop.
 *
 * Candidate #3 (2026-09-03): the hand-rolled Instance/spawn/framing/token
 * copies are gone — stdio rides the shared evals client (spawnClient), and
 * the P0-4 dashboard-URL token extraction is the client's own dashboardToken.
 */

const ROOT = resolve('test-fixtures/sample-app');

/** A free port whose successor is free too — the secondary bumps into a+1. */
async function findPrimaryPort(): Promise<number> {
  for (;;) {
    const a = await getFreePort();
    if (await isPortFree(a + 1)) return a;
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

/** Socket-level frame collector for the primary's dashboard websocket. */
function collect(ws: WebSocket): { frames: GraphEvent[]; waitFor(type: string, timeoutMs?: number): Promise<GraphEvent> } {
  const frames: GraphEvent[] = [];
  ws.on('message', (data: unknown) => {
    try {
      frames.push(JSON.parse(String(data)) as GraphEvent);
    } catch {
      /* tolerate malformed frames */
    }
  });
  return {
    frames,
    waitFor(type: string, timeoutMs = 10000): Promise<GraphEvent> {
      return new Promise((res, rej) => {
        const started = Date.now();
        const poll = (): void => {
          const at = frames.findIndex((f) => f.type === type);
          if (at >= 0) return res(frames.splice(at, 1)[0]!);
          if (Date.now() - started > timeoutMs) return rej(new Error(`timed out waiting for a ${type} frame`));
          setTimeout(poll, 25);
        };
        poll();
      });
    }
  };
}

let primaryPort = 0;
let primary: SpawnedClient;
let secondary: SpawnedClient;
let ws: WebSocket;

beforeAll(async () => {
  primaryPort = await findPrimaryPort();
  primary = await spawnClient(ROOT, { port: primaryPort });
  await primary.waitUntilStderr('dashboard    :');

  // Same preferred port → the secondary bumps to primaryPort + 1 and relays.
  secondary = await spawnClient(ROOT, { port: primaryPort });
  await secondary.waitUntilStderr('relaying tool events there');

  const token = await dashboardToken(primary);
  ws = new WebSocket(`ws://127.0.0.1:${primaryPort}/ws?token=${token}`);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
}, 20000);

afterAll(async () => {
  ws?.close();
  await Promise.all([primary?.close(), secondary?.close()]);
});

describe('two sessions, one dashboard (cross-session relay)', () => {
  it('startup is silent: the primary arms instead of popping, the secondary goes headless', async () => {
    await primary.waitUntilStderr('auto-open armed');
    // The heart of the popup policy: restoring every project at app open
    // must not pop a single tab until a session actually does something.
    expect(primary.stderr()).not.toContain('browser auto-open suppressed');
    expect(secondary.stderr()).toContain(`same-root instance serves this dashboard at http://127.0.0.1:${primaryPort} — relaying tool events there`);
  }, 15000);

  it('a read on the secondary lights the ball; the popup waits for the page to close', async () => {
    const collected = collect(ws); // ws is the shared socket opened in beforeAll

    const read = await secondary.callTool('get_module_details', { path: 'core/app.ts' });
    expect(read.failed).toBe(false);
    expect((read.payload as { id: string }).id).toBe('core/app.ts');

    const ev = (await collected.waitFor('module_activity')) as { id: string; activity: string };
    expect(ev.id).toBe('core/app.ts');
    expect(ev.activity).toBe('viewing');

    // The relay was the primary's FIRST file activity — but the test's own
    // socket IS a connected dashboard page, so the armed primary stays quiet:
    // popping now would stack a tab onto the one the user is already looking
    // at, and the file is NOT recorded as popped (a later page-less stretch
    // still pops).
    await primary.waitUntilStderr('dashboard already open in a browser — skip auto-open for core/app.ts');
    expect(primary.stderr()).not.toContain('dashboard auto-open for core/app.ts');

    // Close the tab (server evicts the socket before its own handler ends),
    // then a relayed read of ANOTHER file pops — under NO_OPEN the attempt
    // shows up as the suppressed-open log line.
    await new Promise<void>((res) => {
      ws.once('close', () => res());
      ws.close();
    });
    await secondary.callTool('get_module_details', { path: 'core/emitter.ts' });
    await primary.waitUntilStderr('dashboard auto-open for core/emitter.ts (relayed activity)');
    expect(primary.stderr()).toContain('browser auto-open suppressed');

    // Later tests collect relayed frames again — reopen the page socket.
    ws = new WebSocket(`ws://127.0.0.1:${primaryPort}/ws?token=${await dashboardToken(primary)}`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
  }, 30000);

  it('a begin_review on the secondary pulses on the primary (node_update relay)', async () => {
    const collected = collect(ws);
    await secondary.callTool('begin_review', { path: 'core/app.ts' });

    const ev = (await collected.waitFor('node_update')) as { node: { id: string; aiReview?: { status: string } } };
    expect(ev.node.id).toBe('core/app.ts');
    expect(ev.node.aiReview?.status).toBe('checking');
  }, 30000);
});

/**
 * Popup policy (file-granular), the plain case: ONE project, ONE armed
 * instance. Nothing opens at startup; a file-less tool (get_dashboard_info)
 * does not pop either — the popup fires when the agent first OPENS a file
 * via a file-targeted tool, and only once per that file. A throwaway root
 * keeps this instance foreign to the shared-root pair above, so the band
 * walk can never demote it to headless.
 */
describe('one project, first opened file pops (armed instance)', () => {
  let solo: SpawnedClient;

  beforeAll(async () => {
    const soloRoot = await mkdtemp(join(tmpdir(), 'mg-solo-'));
    // Written before spawn so the baseline scan knows the module the test
    // opens later.
    await writeFile(join(soloRoot, 'a.ts'), 'export const a = 1;\n');
    solo = await spawnClient(soloRoot);
    await solo.waitUntilStderr('auto-open armed');
  }, 20000);

  afterAll(async () => {
    await solo?.close();
  });

  it('stays silent until the agent opens a file, then pops once per file', async () => {
    expect(solo.stderr()).not.toContain('browser auto-open suppressed');

    await solo.callTool('get_dashboard_info');

    // File-less tools never trigger the popup.
    expect(solo.stderr()).not.toContain('dashboard auto-open for');

    await solo.callTool('get_module_details', { path: 'a.ts' });

    await solo.waitUntilStderr('dashboard auto-open for a.ts (file opened by agent)');
    // MODULE_GRAPH_NO_OPEN=1 turns the attempt into this log line instead of
    // a real browser window — the trigger path is what the test pins down.
    expect(solo.stderr()).toContain('browser auto-open suppressed');

    await solo.callTool('get_module_details', { path: 'a.ts' });

    // Same file again: the per-file dedup keeps it at one popup.
    const pops = solo.stderr().match(/dashboard auto-open for a\.ts/g) ?? [];
    expect(pops).toHaveLength(1);
  }, 15000);
});
