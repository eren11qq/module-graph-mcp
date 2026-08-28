import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { McpStdioServer, type GraphSnapshotSource } from '../src/server/mcp.js';

/**
 * P1-2 acceptance (stdio robustness), unit-level so chunk boundaries are
 * deterministic:
 *  - a multi-byte UTF-8 character split across two stdin chunks must survive
 *    decoding (StringDecoder) instead of corrupting into U+FFFD garbage;
 *  - prototype keys (__proto__ / constructor) as tool names must answer
 *    Unknown tool, not Internal error;
 *  - unbounded garbage without a newline must reject serve() instead of
 *    buffering forever.
 */

function startServer(): {
  input: EventEmitter;
  replies: Array<Record<string, any>>;
  serving: Promise<void>;
} {
  const input = new EventEmitter();
  const replies: Array<Record<string, any>> = [];
  const output = {
    write: (s: string) => {
      replies.push(JSON.parse(s));
      return true;
    }
  } as unknown as NodeJS.WritableStream;
  const graph: GraphSnapshotSource = {
    snapshot: () => ({ rootPath: '/proj', generatedAt: 1, nodes: [], edges: [] }),
    setNote: () => false
  };
  const server = new McpStdioServer(input as unknown as NodeJS.ReadableStream, output, () => {}, graph);
  return { input, replies, serving: server.serve() };
}

async function waitForReplies(replies: Array<unknown>, n: number, ms = 5000): Promise<void> {
  const start = Date.now();
  while (replies.length < n) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${n} reply(ies), got ${replies.length}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('MCP stdio robustness (P1-2)', () => {
  it('keeps a multi-byte character intact when it is split across chunks', async () => {
    const { input, replies, serving } = startServer();

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_module_details', arguments: { path: 'docs/中文.md' } }
    });
    // Cut two bytes into the 6-byte '中文' sequence.
    const cut = Buffer.byteLength(request.slice(0, request.indexOf('中文')), 'utf8') + 2;
    const buf = Buffer.from(`${request}\n`, 'utf8');
    input.emit('data', buf.subarray(0, cut));
    input.emit('data', buf.subarray(cut));

    await waitForReplies(replies, 1);
    const text = replies[0]!.result.content[0].text as string;
    expect(text).toContain('module not found: "docs/中文.md"');
    expect(text).not.toContain('\uFFFD');
    expect(replies.length).toBe(1);
    void serving;
  });

  it('answers Unknown tool for prototype-key tool names', async () => {
    const { input, replies } = startServer();

    for (const [id, name] of [[1, '__proto__'], [2, 'constructor'], [3, 'toString']] as const) {
      input.emit(
        'data',
        Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } })}\n`, 'utf8')
      );
    }
    await waitForReplies(replies, 3);

    for (const [i, name] of [['0', '__proto__'], ['1', 'constructor'], ['2', 'toString']] as const) {
      const reply = replies[Number(i)]!;
      expect(reply.error).toEqual({ code: -32602, message: `Unknown tool: ${name}` });
    }
  });

  it('rejects serve() when buffered input grows past the 10 MB stdio cap', async () => {
    const { input, serving } = startServer();

    input.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    await expect(serving).rejects.toThrow(/stdio limit/);
  });
});
