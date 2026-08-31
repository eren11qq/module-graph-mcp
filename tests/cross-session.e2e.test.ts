import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { getFreePort } from './helpers/net.js';
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
 */

const ROOT = resolve('test-fixtures/sample-app');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

interface Instance {
  child: ChildProcessWithoutNullStreams;
  stderr: string;
  send(obj: Record<string, unknown>): void;
  waitForReply(id: number, tries?: number): Promise<Record<string, any>>;
  waitUntilStderr(needle: string, timeoutMs?: number): Promise<void>;
}

function spawnInstance(port: number, root: string = ROOT): Instance {
  const child = spawn(
    process.execPath,
    ['dist/server/index.js', '--root', root, '--port', String(port)],
    // env suppresses the browser open for the PRIMARY (which owns its
    // preferred port); the SECONDARY is kept headless by the dedup itself.
    // The suppressed openBrowser still logs, so tests can observe exactly
    // WHEN the popup would have fired.
    { env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const inst: Instance = {
    child,
    stderr: '',
    send(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    async waitForReply(id, tries = 240) {
      for (let i = 0; i < tries; i++) {
        const at = replies.findIndex((r) => r.id === id);
        if (at >= 0) return replies.splice(at, 1)[0] as Record<string, any>;
        await sleep(50);
      }
      throw new Error(`timed out waiting for MCP reply ${id}`);
    },
    async waitUntilStderr(needle, timeoutMs = 8000) {
      const started = Date.now();
      while (!inst.stderr.includes(needle)) {
        if (Date.now() - started > timeoutMs) {
          throw new Error(`stderr never contained "${needle}"; got:\n${inst.stderr}`);
        }
        await sleep(50);
      }
    }
  };

  const replies: Array<{ id?: unknown }> = [];
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      replies.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (d: Buffer) => {
    inst.stderr += d.toString('utf8');
  });

  return inst;
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
let secondaryPort = 0;
let primary: Instance;
let secondary: Instance;
let ws: WebSocket;

beforeAll(async () => {
  primaryPort = await findPrimaryPort();
  secondaryPort = primaryPort + 1;
  primary = spawnInstance(primaryPort);
  await primary.waitUntilStderr('dashboard    :');

  secondary = spawnInstance(primaryPort); // same preferred port → bumps to primaryPort + 1
  await secondary.waitUntilStderr('keeping this session headless');

  ws = new WebSocket(`ws://127.0.0.1:${primaryPort}/ws`);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  // Handshake on the secondary so its later tool calls ride a real session.
  secondary.send({ jsonrpc: '2.0', id: 900, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await secondary.waitForReply(900);
}, 20000);

afterAll(() => {
  ws?.close();
  primary?.child.kill();
  secondary?.child.kill();
});

describe('two sessions, one dashboard (cross-session relay)', () => {
  it('startup is silent: the primary arms instead of popping, the secondary goes headless', async () => {
    await primary.waitUntilStderr('auto-open armed');
    // The heart of the popup policy: restoring every project at app open
    // must not pop a single tab until a session actually does something.
    expect(primary.stderr).not.toContain('browser auto-open suppressed');
    expect(secondary.stderr).toContain(`same-root instance already serves this dashboard at http://127.0.0.1:${primaryPort}`);
  }, 15000);

  it('a read on the secondary lights the ball; the popup waits for the page to close', async () => {
    const collected = collect(ws); // ws is the shared socket opened in beforeAll

    secondary.send({
      jsonrpc: '2.0',
      id: 910,
      method: 'tools/call',
      params: { name: 'get_module_details', arguments: { path: 'core/app.ts' } }
    });
    const reply = await secondary.waitForReply(910);
    expect(reply.error).toBeUndefined();
    const payload = JSON.parse(reply.result.content[0].text);
    expect(payload.id).toBe('core/app.ts');

    const ev = (await collected.waitFor('module_activity')) as { id: string; activity: string };
    expect(ev.id).toBe('core/app.ts');
    expect(ev.activity).toBe('viewing');

    // The relay was the primary's FIRST file activity — but the test's own
    // socket IS a connected dashboard page, so the armed primary stays quiet:
    // popping now would stack a tab onto the one the user is already looking
    // at, and the file is NOT recorded as popped (a later page-less stretch
    // still pops).
    await primary.waitUntilStderr('dashboard already open in a browser — skip auto-open for core/app.ts');
    expect(primary.stderr).not.toContain('dashboard auto-open for core/app.ts');

    // Close the tab (server evicts the socket before its own handler ends),
    // then a relayed read of ANOTHER file pops — under NO_OPEN the attempt
    // shows up as the suppressed-open log line.
    await new Promise<void>((res) => {
      ws.once('close', () => res());
      ws.close();
    });
    secondary.send({
      jsonrpc: '2.0',
      id: 911,
      method: 'tools/call',
      params: { name: 'get_module_details', arguments: { path: 'core/emitter.ts' } }
    });
    await secondary.waitForReply(911);
    await primary.waitUntilStderr('dashboard auto-open for core/emitter.ts (relayed activity)');
    expect(primary.stderr).toContain('browser auto-open suppressed');

    // Later tests collect relayed frames again — reopen the page socket.
    ws = new WebSocket(`ws://127.0.0.1:${primaryPort}/ws`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
  }, 30000);

  it('a begin_review on the secondary pulses on the primary (node_update relay)', async () => {
    const collected = collect(ws);
    secondary.send({
      jsonrpc: '2.0',
      id: 920,
      method: 'tools/call',
      params: { name: 'begin_review', arguments: { path: 'core/app.ts' } }
    });
    await secondary.waitForReply(920);

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
  let solo: Instance;

  beforeAll(async () => {
    const soloRoot = await mkdtemp(join(tmpdir(), 'mg-solo-'));
    // Written before spawn so the baseline scan knows the module the test
    // opens later.
    await writeFile(join(soloRoot, 'a.ts'), 'export const a = 1;\n');
    solo = spawnInstance(await getFreePort(), soloRoot);
    await solo.waitUntilStderr('auto-open armed');
  }, 20000);

  afterAll(() => {
    solo?.child.kill();
  });

  it('stays silent until the agent opens a file, then pops once per file', async () => {
    expect(solo.stderr).not.toContain('browser auto-open suppressed');

    solo.send({ jsonrpc: '2.0', id: 700, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await solo.waitForReply(700);
    solo.send({ jsonrpc: '2.0', id: 701, method: 'tools/call', params: { name: 'get_dashboard_info', arguments: {} } });
    await solo.waitForReply(701);

    // File-less tools never trigger the popup.
    expect(solo.stderr).not.toContain('dashboard auto-open for');

    solo.send({
      jsonrpc: '2.0',
      id: 702,
      method: 'tools/call',
      params: { name: 'get_module_details', arguments: { path: 'a.ts' } }
    });
    await solo.waitForReply(702);

    await solo.waitUntilStderr('dashboard auto-open for a.ts (file opened by agent)');
    // MODULE_GRAPH_NO_OPEN=1 turns the attempt into this log line instead of
    // a real browser window — the trigger path is what the test pins down.
    expect(solo.stderr).toContain('browser auto-open suppressed');

    solo.send({
      jsonrpc: '2.0',
      id: 703,
      method: 'tools/call',
      params: { name: 'get_module_details', arguments: { path: 'a.ts' } }
    });
    await solo.waitForReply(703);

    // Same file again: the per-file dedup keeps it at one popup.
    const pops = solo.stderr.match(/dashboard auto-open for a\.ts/g) ?? [];
    expect(pops).toHaveLength(1);
  }, 15000);
});
