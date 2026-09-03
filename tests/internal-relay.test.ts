import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { isForwardableEvent, rootRelayToken, startHttpServer } from '../src/server/http.js';
import { getFreePort } from './helpers/net.js';
import type { GraphEvent, ModuleNode } from '../src/shared/types.js';

/**
 * Code-review 2026-08-29: the cross-session relay. A same-root secondary
 * instance POSTs its tool-driven events to the primary's
 * /internal/broadcast, which re-fans them to the primary's dashboard
 * websockets. The endpoint is loopback-only and takes an event allowlist —
 * snapshot/graph_delta are refused because every instance watches the tree
 * itself and relaying deltas would double-flash every page.
 */

let root = '';
let url = '';
let teardown: (() => Promise<void>) | null = null;

const aNode: ModuleNode = {
  id: 'src/a.ts',
  path: 'src/a.ts',
  language: 'ts',
  testState: 'untested',
  coveredBy: [],
  typeErrors: []
};

async function post(body: string): Promise<{ status: number; text: string }> {
  // P0-3: the relay accepts only same-root instances carrying the shared
  // root token — this test's POSTs are all legitimate same-root relays.
  const res = await fetch(`${url}/internal/broadcast?token=${rootRelayToken(root)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  return { status: res.status, text: await res.text() };
}

/** A socket-level frame collector: nothing can slip past between awaits. */
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
    waitFor(type: string, timeoutMs = 2500): Promise<GraphEvent> {
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = (): void => {
          const at = frames.findIndex((f) => f.type === type);
          if (at >= 0) return resolve(frames.splice(at, 1)[0]!);
          if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for a ${type} frame`));
          setTimeout(poll, 25);
        };
        poll();
      });
    }
  };
}

function dashboardWs(): Promise<ReturnType<typeof collect>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
    const c = collect(ws);
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'module-graph-relay-'));
  const started = await startHttpServer({
    preferredPort: await getFreePort(),
    publicDir: join('dist', 'server', 'public'),
    info: { rootPath: root, port: 0, version: 'test' },
    // The hub greets each socket with a snapshot frame; the relay tests wait
    // for it before asserting on relayed frames.
    getSnapshot: () => ({ generatedAt: 0, rootPath: root, nodes: [], edges: [] })
  });
  url = started.url;
  teardown = async () => {
    started.server.closeAllConnections?.();
    started.server.close();
  };
});

afterAll(async () => {
  await teardown?.();
  await rm(root, { recursive: true, force: true });
});

describe('POST /internal/broadcast relay', () => {
  it('relays a node_update to dashboard websockets with 204', async () => {
    const c = await dashboardWs();
    await c.waitFor('snapshot'); // the hub greets every socket with a snapshot

    const relayed = c.waitFor('node_update');
    const res = await post(JSON.stringify({ type: 'node_update', node: aNode }));
    expect(res.status).toBe(204);
    const ev = (await relayed) as { type: string; node: { id: string } };
    expect(ev.node.id).toBe('src/a.ts');
  });

  it('relays a module_activity frame untouched', async () => {
    const c = await dashboardWs();
    await c.waitFor('snapshot');
    const relayed = c.waitFor('module_activity');
    const activity = { type: 'module_activity', id: 'src/a.ts', path: 'src/a.ts', activity: 'viewing', at: 1 };
    const res = await post(JSON.stringify(activity));
    expect(res.status).toBe(204);
    await expect(relayed).resolves.toEqual(activity);
  });

  it('refuses snapshot and graph_delta (every instance watches the tree itself)', async () => {
    const snap = await post(JSON.stringify({ type: 'snapshot', snapshot: { nodes: [], edges: [] } }));
    expect(snap.status).toBe(400);
    const delta = await post(
      JSON.stringify({ type: 'graph_delta', delta: { addedNodes: [], removedNodeIds: [], addedEdges: [], removedEdges: [] } })
    );
    expect(delta.status).toBe(400);
  });

  it('answers 400 for malformed JSON and for shape-invalid events', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ type: 'module_activity' }))).status).toBe(400); // missing id
    expect((await post(JSON.stringify({ type: 'review_timeout' }))).status).toBe(400);
    expect((await post(JSON.stringify({ type: 'node_update', node: { nope: true } }))).status).toBe(400);
  });

  it('answers 405 for non-POST', async () => {
    const res = await fetch(`${url}/internal/broadcast`);
    expect(res.status).toBe(405);
  });

  it('answers 413 for an oversized body', async () => {
    const big = JSON.stringify({ type: 'scan_error', message: 'x'.repeat(1024 * 1024 + 1) });
    const res = await post(big);
    expect(res.status).toBe(413);
  });
});

describe('isForwardableEvent (unit)', () => {
  it('accepts exactly the relayable allowlist', () => {
    expect(isForwardableEvent({ type: 'node_update', node: aNode })).toBe(true);
    expect(isForwardableEvent({ type: 'module_activity', id: 'a.ts', path: 'a.ts', activity: 'viewing', at: 1 })).toBe(true);
    expect(isForwardableEvent({ type: 'review_timeout', id: 'a.ts', path: 'a.ts' })).toBe(true);
    expect(isForwardableEvent({ type: 'scan_error', message: 'boom' })).toBe(true);
    // ADR 0002 §7.2: 改动核对事件可跨实例转发（同仓库副会话 → 主 dashboard）。
    expect(isForwardableEvent({ type: 'edit_scope', scope: { modules: ['dashboard'], files: [] } })).toBe(true);
    expect(isForwardableEvent({ type: 'edit_scope', scope: null })).toBe(true);
    expect(
      isForwardableEvent({ type: 'edit_verification', verification: { edited: ['a.ts'], outOfScope: ['b.ts'], unreported: [] } })
    ).toBe(true);
    expect(isForwardableEvent({ type: 'edit_scope', scope: { modules: 'dashboard' } })).toBe(false); // 畸形载荷
    expect(isForwardableEvent({ type: 'snapshot', snapshot: {} })).toBe(false);
    expect(isForwardableEvent({ type: 'graph_delta', delta: {} })).toBe(false);
    expect(isForwardableEvent({ type: 'nope' })).toBe(false);
    expect(isForwardableEvent(null)).toBe(false);
    expect(isForwardableEvent('node_update')).toBe(false);
  });
});

describe('P0-3 relay hardening (2026-08-31 audit)', () => {

  it('requires the shared root token — a token-less POST is refused', async () => {
    // Deliberately bypass the token-carrying post() helper: a blind local
    // process does not know the root-derived token.
    const res = await fetch(`${url}/internal/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'scan_error', message: 'forged' })
    });
    expect(res.status).toBe(401);
  });

  it('accepts a same-root instance carrying the token (204)', async () => {
    const relayToken = rootRelayToken(root);
    const res = await fetch(`${url}/internal/broadcast?token=${relayToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'module_activity', id: 'src/a.ts', path: 'src/a.ts', activity: 'viewing', at: 1 })
    });
    expect(res.status).toBe(204);
  });

  it('strips forged notes and DONE reviews; keeps the transient checking pulse', async () => {
    const relayToken = rootRelayToken(root);
    const c = await dashboardWs();
    await c.waitFor('snapshot');

    const relayed = c.waitFor('node_update');
    const forged = {
      type: 'node_update',
      node: {
        ...aNode,
        note: 'fake note',
        // A forged DONE review is the fake "AI checked ✓" vector.
        aiReview: { status: 'done', verdicts: [{ line: 1, verdict: 'confident' }], summary: 'forged OK' }
      }
    };
    const res = await fetch(`${url}/internal/broadcast?token=${relayToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(forged)
    });
    expect(res.status).toBe(204);

    const ev = (await relayed) as unknown as { type: string; node: Record<string, unknown> };
    expect(ev.node.id).toBe('src/a.ts');
    expect(ev.node.note).toBeUndefined();
    expect(ev.node.aiReview).toBeUndefined();
  });

  it('lets a legitimate checking pulse through the relay (cross-session activity)', async () => {
    const relayToken = rootRelayToken(root);
    const c = await dashboardWs();
    await c.waitFor('snapshot');

    const relayed = c.waitFor('node_update');
    const checking = {
      type: 'node_update',
      node: { ...aNode, aiReview: { status: 'checking', verdicts: [] } }
    };
    const res = await fetch(`${url}/internal/broadcast?token=${relayToken}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(checking)
    });
    expect(res.status).toBe(204);

    const ev = (await relayed) as { type: string; node: { aiReview?: { status?: string } } };
    expect(ev.node.aiReview?.status).toBe('checking');
  });

  it('disables the relay entirely in read-only mode (403)', async () => {
    const roRoot = await mkdtemp(join(tmpdir(), 'module-graph-relay-ro-'));
    try {
      const started = await startHttpServer({
        preferredPort: await getFreePort(),
        publicDir: join('dist', 'server', 'public'),
        info: { rootPath: roRoot, port: 0, version: 'test' },
        readOnly: true,
        getSnapshot: () => ({ generatedAt: 0, rootPath: roRoot, nodes: [], edges: [] })
      });
      try {
        const res = await fetch(`${started.url}/internal/broadcast?token=${rootRelayToken(roRoot)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'scan_error', message: 'forged' })
        });
        expect(res.status).toBe(403);
      } finally {
        started.server.closeAllConnections?.();
        started.server.close();
      }
    } finally {
      await rm(roRoot, { recursive: true, force: true });
    }
  });
});

