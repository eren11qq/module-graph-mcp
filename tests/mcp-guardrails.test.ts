import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { applyTokenBudget, estimateTokens } from '../src/server/response-budget.js';
import { buildTools, McpStdioServer, READ_ONLY_BLOCKED_TOOLS, type GraphSnapshotSource, type McpToolDeps } from '../src/server/mcp.js';
import type { ModuleNode } from '../src/shared/types.js';

/**
 * GitNexus port step 5 guardrails, three layers:
 *  ① applyTokenBudget direct — the 4-bytes/token estimate, UTF-8-safe
 *    cutting (Chinese + emoji boundaries), the marker contract, tiny budgets.
 * ② Tool registration — read-only mode hides exactly the five mutation
 *    tools; analysis tools stay visible.
 * ③ Transport — a read-only server answers a mutation tools/call with the
 *    dedicated audit error (NOT "Unknown tool"), and the _maxTokens /
 *    defaultMaxTokens budget wraps real replies. Env-failure paths spawn the
 *    real dist entry (they need the built artifact, like mcp-e2e).
 */

describe('applyTokenBudget (direct)', () => {
  it('estimates tokens as ceil(utf8 bytes / 4)', () => {
    expect(estimateTokens('abcd')).toBe(1); // 4 bytes
    expect(estimateTokens('abcde')).toBe(2); // 5 bytes → ceil(1.25)
    expect(estimateTokens('中文')).toBe(2); // 6 bytes → ceil(1.5)
  });

  it('passes short text through untouched', () => {
    const r = applyTokenBudget('hello', 100);
    expect(r).toEqual({ text: 'hello', truncated: false, originalTokens: 2 });
  });

  it('cuts over-budget ASCII and appends the marker with the original estimate', () => {
    const body = 'x'.repeat(1000); // 250 tokens
    const r = applyTokenBudget(body, 50);
    expect(r.truncated).toBe(true);
    expect(r.originalTokens).toBe(250);
    expect(r.text.endsWith('raise the per-call "_maxTokens" argument.]')).toBe(true);
    expect(r.text).toContain('original ≈ 250 tokens');
    const bodyPart = r.text.slice(0, r.text.indexOf('\n\n[module-graph-mcp'));
    expect(bodyPart).toMatch(/^x+$/); // pure body, no garbage
    expect(bodyPart.length).toBeLessThanOrEqual(50 * 4);
  });

  it('never splits a multi-byte Chinese character (no U+FFFD)', () => {
    const body = '汉'.repeat(500); // 1500 bytes ≈ 375 tokens
    const r = applyTokenBudget(body, 100);
    expect(r.truncated).toBe(true);
    const bodyPart = r.text.slice(0, r.text.indexOf('\n\n[module-graph-mcp'));
    expect(bodyPart).toMatch(/^(汉)+$/); // every kept character is complete
    expect(r.text).not.toContain('\uFFFD');
  });

  it('never splits an emoji surrogate pair (no U+FFFD)', () => {
    const body = '🙂'.repeat(200); // 800 bytes = 200 tokens; budget 400B lands mid-surrogate
    const r = applyTokenBudget(body, 100);
    expect(r.truncated).toBe(true);
    const bodyPart = r.text.slice(0, r.text.indexOf('\n\n[module-graph-mcp'));
    expect(bodyPart).toMatch(/^(\u{1F642})+$/u);
    expect(r.text).not.toContain('\uFFFD');
  });

  it('a tiny budget returns ONLY the marker (the guardrail text wins)', () => {
    const body = 'secret-payload-'.repeat(100);
    const r = applyTokenBudget(body, 1);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('response truncated');
    expect(r.text).not.toContain('secret-payload');
  });
});

// ---------------------------------------------------------------------------
// Tool registration + transport behavior over a fake graph
// ---------------------------------------------------------------------------

function fakeGraph(): GraphSnapshotSource {
  return {
    snapshot: () => ({ rootPath: '/proj', generatedAt: 1, nodes: [], edges: [] }),
    setNote: () => false,
    setReview: () => false
  };
}

function startServer(deps: McpToolDeps = {}): {
  input: EventEmitter;
  replies: Array<Record<string, any>>;
  logs: string[];
} {
  const input = new EventEmitter();
  const replies: Array<Record<string, any>> = [];
  const logs: string[] = [];
  const output = {
    write: (s: string) => {
      replies.push(JSON.parse(s));
      return true;
    }
  } as unknown as NodeJS.WritableStream;
  const server = new McpStdioServer(input as unknown as NodeJS.ReadableStream, output, (m) => logs.push(m), fakeGraph(), deps);
  void server.serve();
  return { input, replies, logs };
}

async function waitForReplies(replies: Array<unknown>, n: number): Promise<void> {
  const start = Date.now();
  while (replies.length < n) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${n} reply(ies)`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function call(input: EventEmitter, id: number, name: string, args: Record<string, unknown> = {}): void {
  input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`, 'utf8'));
}

function list(input: EventEmitter, id: number): void {
  input.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`, 'utf8'));
}

describe('read-only mode (GitNexus port + ADR 0002)', () => {
  it('buildTools hides exactly the seven mutation tools; analysis stays visible', () => {
    const readOnly = buildTools(fakeGraph(), { readOnly: true });
    const names = Object.keys(readOnly);
    for (const blocked of READ_ONLY_BLOCKED_TOOLS) expect(names).not.toContain(blocked);
    expect(names).toHaveLength(7); // 14 全量 − 7 变更类 = 7 分析类
    for (const visible of ['get_impact', 'get_change_impact', 'get_health_report', 'get_module_details', 'get_module_graph', 'list_untested', 'get_dashboard_info']) {
      expect(names).toContain(visible);
    }

    // 12 存量 + declare_edit_scope + report_edits (ADR 0002).
    expect(Object.keys(buildTools(fakeGraph(), {}))).toHaveLength(14);
  });

  it('the transport answers a mutation call with the audit error, not Unknown tool', async () => {
    const { input, replies } = startServer({ readOnly: true });
    list(input, 1);
    call(input, 2, 'report_note', { path: 'a.ts', text: 'x' });
    call(input, 3, 'report_test_run', { failed: false });
    call(input, 4, 'declare_edit_scope', { modules: ['dashboard'] });
    call(input, 5, 'report_edits', { files: ['a.ts'] });
    call(input, 6, 'no_such_tool');
    await waitForReplies(replies, 6);

    const listed = (replies[0]!.result.tools as Array<{ name: string }>).map((t) => t.name);
    for (const blocked of READ_ONLY_BLOCKED_TOOLS) expect(listed).not.toContain(blocked);

    for (const [reply, tool] of [
      [replies[1], 'report_note'],
      [replies[2], 'report_test_run'],
      [replies[3], 'declare_edit_scope'],
      [replies[4], 'report_edits']
    ] as const) {
      expect(reply!.error!.code).toBe(-32602);
      expect(reply!.error!.message).toContain(`"${tool}" is unavailable in read-only mode`);
      expect(reply!.error!.message).toContain('MODULE_GRAPH_MCP_READ_ONLY=1');
    }
    // Genuinely unknown tools still say Unknown tool — the two errors differ.
    expect(replies[5]!.error!.message).toBe('Unknown tool: no_such_tool');
  });
});

describe('_maxTokens / defaultMaxTokens response budget (transport level)', () => {
  // The empty-graph get_module_graph reply is ~15 tokens (well over 5, well
  // under 1000), so the same fixture separates truncation from pass-through.
  it('truncates a long reply at the default budget and logs one stderr line', async () => {
    const { input, replies, logs } = startServer({ defaultMaxTokens: 5 });
    call(input, 1, 'get_module_graph');
    await waitForReplies(replies, 1);
    const text = replies[0]!.result.content[0].text as string;
    expect(text).toContain('response truncated');
    expect(text).toContain('"_maxTokens"');
    expect(logs.some((l) => l.includes('truncated'))).toBe(true);
  });

  it('a per-call _maxTokens overrides the default (larger → pass-through)', async () => {
    const { input, replies } = startServer({ defaultMaxTokens: 5 });
    call(input, 1, 'get_module_graph', { _maxTokens: 100000 });
    await waitForReplies(replies, 1);
    const text = replies[0]!.result.content[0].text as string;
    expect(text).not.toContain('response truncated');
    const body = JSON.parse(text) as { rootPath: string };
    expect(body.rootPath).toBe('/proj'); // still valid JSON: untouched reply
  });

  it('an illegal per-call _maxTokens is ignored with one stderr line, reply intact', async () => {
    const { input, replies, logs } = startServer();
    for (const [i, bad] of [['banana'], [-3], [2.5], [null]].entries()) {
      call(input, i + 1, 'get_module_graph', { _maxTokens: bad[0] });
    }
    await waitForReplies(replies, 4);
    for (const reply of replies) {
      expect((reply!.result.content[0].text as string).includes('response truncated')).toBe(false);
    }
    expect(logs.filter((l) => l.includes('ignoring illegal _maxTokens'))).toHaveLength(4);
  });
});

describe('guardrail env fails loudly (spawn dist, like mcp-e2e)', () => {
  it('MODULE_GRAPH_MCP_READ_ONLY with a garbage value exits non-zero with a message', async () => {
    const child = spawn(process.execPath, ['dist/server/index.js', '--root', 'test-fixtures/empty'], {
      env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1', MODULE_GRAPH_MCP_READ_ONLY: 'maybe' }
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    expect(code).not.toBe(0);
    expect(stderr).toContain('MODULE_GRAPH_MCP_READ_ONLY must be unset, "0" or "1"');
  });

  it('MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS with a non-integer exits non-zero', async () => {
    const child = spawn(process.execPath, ['dist/server/index.js', '--root', 'test-fixtures/empty'], {
      env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1', MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS: 'lots' }
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    expect(code).not.toBe(0);
    expect(stderr).toContain('MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS must be a positive integer');
  });
});
