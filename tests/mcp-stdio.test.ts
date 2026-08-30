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
 *  - oversized lines and newline-less floods are dropped with at most one
 *    -32600 per episode — the process survives and keeps answering (G4).
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
    setNote: () => false,
    setReview: () => false
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

  it('survives an over-limit line: one -32600, then keeps answering', async () => {
    const { input, replies, serving } = startServer();

    input.emit('data', Buffer.concat([Buffer.alloc(11 * 1024 * 1024, 0x61), Buffer.from('\n')]));
    input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`));

    await waitForReplies(replies, 2);
    expect(replies[0]!.id).toBeNull();
    expect(replies[0]!.error).toMatchObject({ code: -32600 });
    expect(replies[1]!.id).toBe(1);
    expect(replies[1]!.result).toEqual({});
    expect(replies).toHaveLength(2);
    void serving;
  });

  it('survives a newline-less flood and resumes once a newline arrives', async () => {
    const { input, replies, serving } = startServer();

    const flood = Buffer.alloc(2 * 1024 * 1024, 0x61);
    for (let i = 0; i < 6; i++) input.emit('data', flood);
    input.emit('data', Buffer.from('end of flood\n'));
    input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`));

    await waitForReplies(replies, 2);
    expect(replies[0]!.error).toMatchObject({ code: -32600 });
    expect(replies[1]!.result).toEqual({});
    expect(replies).toHaveLength(2);
    void serving;
  });

  it('resolves serve() cleanly on stdin EOF', async () => {
    const { input, serving } = startServer();

    input.emit('end');
    await expect(serving).resolves.toBeUndefined();
  });

  it('holds content-dependent calls until the baseline lands; self-describing ones answer immediately', async () => {
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
      setNote: () => false,
      setReview: () => false
    };
    let baselineDone = false;
    const server = new McpStdioServer(input as unknown as NodeJS.ReadableStream, output, () => {}, graph, {
      isBaselineDone: () => baselineDone
    });
    void server.serve();

    const call = (id: number, name: string): void => {
      input.emit(
        'data',
        Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })}\n`)
      );
    };
    call(1, 'get_dashboard_info'); // ungated: answers mid-scan
    call(2, 'begin_review'); // gated: waits for the baseline

    await waitForReplies(replies, 1, 500);
    expect(replies.map((r) => r.id)).toEqual([1]);

    setTimeout(() => {
      baselineDone = true;
    }, 120);
    await waitForReplies(replies, 2);
    expect(replies.map((r) => r.id)).toEqual([1, 2]);
    expect(replies[1]!.result).toBeDefined();
  });
});

/**
 * Popup policy (code-review 2026-08-29): the first KNOWN tools/call is the
 * signal that a session is actually working on this project — the wired hook
 * opens the dashboard. Handshake traffic (initialize, tools/list) and unknown
 * tool garbage must not count, and the hook fires exactly once per process.
 */
describe('onFirstToolCall (popup policy)', () => {
  function startWithHook(): {
    input: EventEmitter;
    replies: Array<Record<string, any>>;
    callsRef: { calls: number };
    serving: Promise<void>;
  } {
    const input = new EventEmitter();
    const replies: Array<Record<string, any>> = [];
    const callsRef = { calls: 0 };
    const output = {
      write: (s: string) => {
        replies.push(JSON.parse(s));
        return true;
      }
    } as unknown as NodeJS.WritableStream;
    const graph: GraphSnapshotSource = {
      snapshot: () => ({ rootPath: '/proj', generatedAt: 1, nodes: [], edges: [] }),
      setNote: () => false,
      setReview: () => false
    };
    const server = new McpStdioServer(input as unknown as NodeJS.ReadableStream, output, () => {}, graph, {
      onFirstToolCall: () => {
        callsRef.calls += 1;
      }
    });
    return { input, replies, callsRef, serving: server.serve() };
  }

  const send = (input: EventEmitter, msg: Record<string, unknown>): void => {
    input.emit('data', Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8'));
  };

  it('fires exactly once, on the first known tool call; handshake and unknown tools do not count', async () => {
    const { input, replies, callsRef, serving } = startWithHook();

    send(input, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send(input, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(input, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send(input, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: '__proto__' } });
    send(input, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_dashboard_info', arguments: {} } });
    send(input, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_untested', arguments: {} } });

    // Five replies land: initialize(1), tools/list(2), unknown-tool error(3),
    // and the two tool calls (4, 5). The notification never replies.
    await waitForReplies(replies, 5);
    const byId = new Map(replies.map((r) => [r.id, r]));
    expect(byId.get(3)!.error).toEqual({ code: -32602, message: 'Unknown tool: __proto__' });
    expect(byId.get(4)!.result).toBeDefined();
    expect(byId.get(5)!.result).toBeDefined();
    expect(callsRef.calls).toBe(1);
    void serving;
  });
});

/**
 * Protocol MUSTs (G3): the initialize reply must never echo a protocol
 * version the server cannot speak, and an unparseable line gets exactly one
 * -32700 with id null instead of silence.
 */
describe('stdio protocol conformance (G3)', () => {
  it('answers unsupported / missing protocol versions with its own, and echoes a supported one', async () => {
    const { input, replies, serving } = startServer();

    const init = (id: number, protocolVersion?: string): void => {
      const params = protocolVersion === undefined ? {} : { protocolVersion };
      input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params })}\n`));
    };
    init(1, '1999-01-01');
    init(2, '2025-06-18');
    init(3);

    await waitForReplies(replies, 3);
    expect(replies[0]!.result.protocolVersion).toBe('2025-06-18');
    expect(replies[1]!.result.protocolVersion).toBe('2025-06-18');
    expect(replies[2]!.result.protocolVersion).toBe('2025-06-18');
    void serving;
  });

  it('treats null / non-string protocolVersion and a missing params object as unspecified', async () => {
    const { input, replies, serving } = startServer();

    input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: null } })}\n`));
    input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 12345 } })}\n`));
    input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'initialize' })}\n`));

    await waitForReplies(replies, 3);
    expect(replies[0]!.result.protocolVersion).toBe('2025-06-18');
    expect(replies[1]!.result.protocolVersion).toBe('2025-06-18');
    expect(replies[2]!.result.protocolVersion).toBe('2025-06-18');
    void serving;
  });

  it('replies with exactly one -32700 parse error (id null) for an unparseable line', async () => {
    const { input, replies, serving } = startServer();

    input.emit('data', Buffer.from('this is not json\n'));

    await waitForReplies(replies, 1);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
    void serving;
  });

  it('survives a bare JSON null line (valid JSON, not a request) and keeps serving', async () => {
    const { input, replies, serving } = startServer();

    input.emit('data', Buffer.from('null\n'));
    input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`));

    await waitForReplies(replies, 2);
    expect(replies[0]!.id).toBeNull();
    expect(replies[0]!.error).toMatchObject({ code: -32600 });
    expect(replies[1]!.result).toEqual({});
    void serving;
  });
});
