import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { makeTempProject } from './helpers/temp-project.js';
import { getFreePort } from './helpers/net.js';

/**
 * 常驻 e2e (2026-09-01): the review traces survive the popup page / the
 * whole process. A real dist server ends a review, dies, and a fresh
 * process over the same root restores the green ring — get_module_details
 * must report the persisted done review after the restart.
 */

interface Session {
  child: ChildProcessWithoutNullStreams;
  send(obj: Record<string, unknown>): void;
  waitForReply(id: number): Promise<Record<string, any>>;
  close(): Promise<void>;
}

function spawnServer(root: string, port: number): Session {
  const child = spawn(
    process.execPath,
    ['dist/server/index.js', '--root', root, '--port', String(port), '--no-open'],
    { env: { ...process.env, MODULE_GRAPH_NO_OPEN: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
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
  child.stderr.on('data', () => {});

  const session: Session = {
    child,
    send(obj) {
      child.stdin.write(`${JSON.stringify(obj)}\n`);
    },
    async waitForReply(id) {
      for (let i = 0; i < 200; i++) {
        const at = replies.findIndex((r) => r.id === id);
        if (at >= 0) return replies.splice(at, 1)[0] as Record<string, any>;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for MCP reply ${id}`);
    },
    close() {
      return new Promise<void>((res) => {
        child.kill();
        child.once('exit', () => res());
        setTimeout(res, 3000);
      });
    }
  };
  return session;
}

let nextId = 1;
async function handshake(s: Session): Promise<void> {
  s.send({ jsonrpc: '2.0', id: nextId, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await s.waitForReply(nextId);
  nextId++;
}

async function call(s: Session, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const id = nextId++;
  s.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const reply = await s.waitForReply(id);
  const text = (reply.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '';
  return { reply, text, payload: JSON.parse(text) };
}

describe('review persistence across process restarts (常驻 e2e)', () => {
  it('an ended review is restored by a fresh server over the same root', async () => {
    const root = await makeTempProject({
      'src/a.ts': 'export const a = 1;\n'
    });
    try {
      const port = await getFreePort();

      // Session 1: begin + end a review (green ring: empty verdicts).
      const s1 = spawnServer(root, port);
      await handshake(s1);
      const begin = await call(s1, 'begin_review', { path: 'src/a.ts' });
      expect(begin.payload.aiReview.status).toBe('checking');
      const end = await call(s1, 'end_review', { path: 'src/a.ts', verdicts: [], summary: '常驻 e2e' });
      expect(end.payload.aiReview.status).toBe('done');
      await s1.close();

      // Session 2: a brand-new process — the review must come back from disk.
      const s2 = spawnServer(root, port + 1);
      await handshake(s2);
      const details = await call(s2, 'get_module_details', { path: 'src/a.ts' });
      expect(details.payload.aiReview).toEqual({ status: 'done', verdicts: [], summary: '常驻 e2e', reviewedAt: expect.any(Number) });
      // The dashboard's graph view must carry it too.
      const graph = await call(s2, 'get_module_graph', {});
      const node = graph.payload.nodes.find((n: { id: string }) => n.id === 'src/a.ts');
      expect(node?.aiReview?.status).toBe('done');
      await s2.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
