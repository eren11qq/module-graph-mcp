import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHttpServer } from '../src/server/http.js';
import { getFreePort } from './helpers/net.js';

/**
 * P0-4 (2026-08-31 audit): the dashboard HTTP surface is authenticated with
 * a random per-startup token that rides in the dashboard URL. /api/* (except
 * the band-walk /api/info) and the /ws handshake reject requests without it,
 * so a same-machine low-privilege process can no longer read source files it
 * has no right to see. Static assets stay public — the shell itself must load
 * to read the token out of its own URL.
 */

let root = '';
let url = '';
let token = '';
let teardown: (() => Promise<void>) | null = null;

async function start(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'module-graph-token-'));
  token = 'startup-token-0123456789abcdef';
  const started = await startHttpServer({
    preferredPort: await getFreePort(),
    publicDir: join('dist', 'server', 'public'),
    info: { rootPath: root, port: 0, version: 'test' },
    token,
    getSnapshot: () => ({ generatedAt: 0, rootPath: root, nodes: [], edges: [] })
  });
  url = started.url;
  teardown = async () => {
    started.server.closeAllConnections?.();
    started.server.close();
  };
}

function wsProbe(socketUrl: string): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(socketUrl);
    const timer = setTimeout(() => resolve('rejected'), 2500);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve('open');
      ws.close();
    });
    ws.once('error', () => {
      clearTimeout(timer);
      resolve('rejected');
    });
  });
}

beforeAll(async () => {
  await start();
});

afterAll(async () => {
  await teardown?.();
  await rm(root, { recursive: true, force: true });
});

describe('P0-4 startup-token auth on /api/* and /ws', () => {
  it('embeds the token in the dashboard URL', () => {
    expect(url).toContain(`token=${token}`);
  });

  it('keeps /api/info open (the same-root band walk needs it) and static assets public', async () => {
    expect((await fetch(`${url}/api/info`)).status).toBe(200);
    expect((await fetch(url)).status).toBe(200);
  });

  it('rejects /api/source without the token and serves it with the token', async () => {
    const base = url.replace(/\?.*$/, '');
    const denied = await fetch(`${base}/api/source?path=secret.ts`);
    expect(denied.status).toBe(401);
    // With the token the request is AUTHORIZED — the file is missing in this
    // fixture, so 404 (not 401) proves the auth gate passed.
    const allowed = await fetch(`${base}/api/source?path=secret.ts&token=${token}`);
    expect(allowed.status).toBe(404);
  });

  it('rejects /api/graph without the token', async () => {
    const base = url.replace(/\?.*$/, '');
    expect((await fetch(`${base}/api/graph`)).status).toBe(401);
    expect((await fetch(`${base}/api/graph?token=${token}`)).status).toBe(200);
  });

  it('rejects /api/report without the token', async () => {
    const base = url.replace(/\?.*$/, '');
    expect((await fetch(`${base}/api/report`)).status).toBe(401);
  });

  it('rejects WebSocket upgrades without the token and accepts them with it', async () => {
    const base = url.replace(/\?.*$/, '');
    const wsBase = `${base.replace(/^http/, 'ws')}/ws`;
    await expect(wsProbe(wsBase)).resolves.toBe('rejected');
    await expect(wsProbe(`${wsBase}?token=${token}`)).resolves.toBe('open');
  });
});
