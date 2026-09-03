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
 * to read the token out of its own URL — and the HTML entry points self-heal:
 * a missing/stale token 302s to the same path carrying the current one, so a
 * bare http://127.0.0.1:PORT/ just works instead of dead-ending on a notice.
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

  it('self-heals HTML entry points: missing or stale tokens 302 to the same path with the current token', async () => {
    const base = url.replace(/\?.*$/, '');
    for (const entry of ['/', '/index.html', '/api/report']) {
      const res = await fetch(`${base}${entry}`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location') ?? '', base).searchParams.get('token')).toBe(token);
      // A stale token is REPLACED, not appended, and other params survive.
      const stale = await fetch(`${base}${entry}?token=deadbeef&focus=a.ts`, { redirect: 'manual' });
      expect(stale.status).toBe(302);
      const loc = new URL(stale.headers.get('location') ?? '', base);
      expect(loc.searchParams.get('token')).toBe(token);
      expect(loc.searchParams.get('focus')).toBe('a.ts');
      expect(loc.searchParams.getAll('token').length).toBe(1);
    }
    // Following the redirect lands on the real 200 shell / report.
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('never redirects a request that already carries the token', async () => {
    const base = url.replace(/\?.*$/, '');
    expect((await fetch(`${base}/?token=${token}`, { redirect: 'manual' })).status).toBe(200);
  });

  it('self-healed /api/report actually serves the report page', async () => {
    const base = url.replace(/\?.*$/, '');
    const res = await fetch(`${base}/api/report`); // fetch follows the 302
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });


  it('rejects WebSocket upgrades without the token and accepts them with it', async () => {
    const base = url.replace(/\?.*$/, '');
    const wsBase = `${base.replace(/^http/, 'ws')}/ws`;
    await expect(wsProbe(wsBase)).resolves.toBe('rejected');
    await expect(wsProbe(`${wsBase}?token=${token}`)).resolves.toBe('open');
  });
});
