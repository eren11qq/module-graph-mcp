import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { basename } from 'node:path';
import { getFreePort } from './helpers/net.js';

/**
 * Ticket 01 acceptance: a real process must present itself as an MCP server
 * over stdio while the dashboard serves over HTTP in the same process.
 */
describe('MCP stdio end-to-end (Ticket 01)', () => {
  let child: ChildProcessWithoutNullStreams;
  let port: number;
  const replies: unknown[] = [];
  let linesPending = Promise.resolve();

  beforeAll(async () => {
    port = await getFreePort();
    child = spawn(
      process.execPath,
      ['dist/server/index.js', '--root', 'test-fixtures/empty', '--port', String(port), '--no-open'],
      { env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    // stderr only carries human logs; surface failures if the server dies early
    child.stderr.on('data', () => {});
    child.on('exit', (code) => {
      if (code !== undefined && code !== 0 && code !== null && !exiting) {
        throw new Error(`server exited early with code ${code}`);
      }
    });

    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        replies.push(JSON.parse(line));
        linesPending = Promise.resolve();
      }
    });
  });

  let exiting = false;
  afterAll(() => {
    exiting = true;
    child?.kill();
  });

  function send(obj: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  // Replies leave in COMPLETION order, not request order: tools/call is
  // dispatched async (the baseline gate may hold it) while ping answers
  // synchronously. JSON-RPC correlates by id, so match by id.
  async function waitForReply(id: number): Promise<Record<string, any>> {
    for (let i = 0; i < 100; i++) {
      const at = replies.findIndex((r) => (r as { id?: unknown }).id === id);
      if (at >= 0) return replies.splice(at, 1)[0] as Record<string, any>;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for MCP reply ${id}`);
  }

  it('completes initialize -> tools/list -> tools/call -> ping handshake', async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }); // notification: no reply expected
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_module_graph', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'ping' });

    const init = await waitForReply(1);
    expect(init.result.serverInfo.name).toBe('module-graph-mcp');
    expect(typeof init.result.protocolVersion).toBe('string');

    const list = await waitForReply(2);
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('get_module_graph');
    for (const t of list.result.tools as Array<{ name: string; description?: string }>) {
      expect(typeof t.description, `tool ${t.name} needs a description`).toBe('string');
    }

    const call = await waitForReply(3);
    expect(call.error).toBeUndefined();
    const payload = JSON.parse(call.result.content[0].text);
    expect(payload.nodes).toEqual([]);
    expect(payload.edges).toEqual([]);
    expect(basename(payload.rootPath)).toBe('empty');

    const pong = await waitForReply(4);
    expect(pong.result).toEqual({});
  });

  it('serves the dashboard over HTTP in the same process', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Module Graph');

    const info = (await (await fetch(`http://127.0.0.1:${port}/api/info`)).json()) as {
      rootPath: string;
      port: number;
      version: string;
    };
    expect(info.version).toBe('0.1.0');
    expect(basename(info.rootPath)).toBe('empty');
  });
});

describe('argument validation (Ticket 01)', () => {
  it('rejects a missing --root directory with a clear non-zero exit', async () => {
    const child = spawn(
      process.execPath,
      ['dist/server/index.js', '--root', 'test-fixtures/does-not-exist'],
      { env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1' } }
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const code: number = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).not.toBe(0);
    expect(stderr).toContain('--root must be an existing directory');
  });

  it('rejects an invalid --port value with a clear message', async () => {
    const child = spawn(
      process.execPath,
      ['dist/server/index.js', '--port', '99999'],
      { env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1' } }
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const code: number = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).not.toBe(0);
    expect(stderr).toContain('--port must be an integer');
  });
});
