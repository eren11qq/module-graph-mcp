import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { join } from 'node:path';
import { startHttpServer } from '../src/server/http.js';
import { getFreePort } from './helpers/net.js';

describe('startHttpServer port fallback (Ticket 01)', () => {
  it('starts on the preferred port when free', async () => {
    const preferred = await getFreePort();
    const started = await startHttpServer({
      preferredPort: preferred,
      publicDir: 'src/server/public',
      info: { rootPath: '/x', port: preferred, version: 'test' }
    });
    expect(started.port).toBe(preferred);
    started.server.closeAllConnections?.();
    started.server.close();
  });

  it('bumps to the next free port when the preferred one is occupied', async () => {
    const occupied = await getFreePort();
    const blocker = net.createServer().listen(occupied, '127.0.0.1');
    await new Promise((r) => blocker.on('listening', r));
    try {
      const started = await startHttpServer({
        preferredPort: occupied,
        maxTries: 5,
        publicDir: 'src/server/public',
        info: { rootPath: '/x', port: occupied, version: 'test' }
      });
      expect(started.port).toBe(occupied + 1);
      started.server.closeAllConnections?.();
      started.server.close();
    } finally {
      blocker.close();
    }
  });

  it('survives two consecutive occupied ports (retry handler must stay attached, P1-5)', async () => {
    const first = await getFreePort();
    const second = first + 1;
    const blockerA = net.createServer().listen(first, '127.0.0.1');
    const blockerB = net.createServer().listen(second, '127.0.0.1');
    await Promise.all([
      new Promise((r) => blockerA.on('listening', r)),
      new Promise((r) => blockerB.on('listening', r))
    ]);
    const blockers = [blockerA, blockerB];
    try {
      const started = await startHttpServer({
        preferredPort: first,
        maxTries: 5,
        publicDir: 'src/server/public',
        info: { rootPath: '/x', port: first, version: 'test' }
      });
      expect(started.port).toBe(first + 2);
      started.server.closeAllConnections?.();
      started.server.close();
    } finally {
      for (const b of blockers) b.close();
    }
  });
});

describe('http handler (Ticket 01)', () => {
  it('serves index.html at / and rejects path traversal', async () => {
    const preferred = await getFreePort();
    const started = await startHttpServer({
      preferredPort: preferred,
      publicDir: join('src', 'server', 'public'),
      info: { rootPath: '/x', port: preferred, version: 'test' }
    });
    try {
      const page = await fetch(`${started.url}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Module Graph');

      const api = await fetch(`${started.url}/api/info`);
      expect(api.status).toBe(200);
      const body = (await api.json()) as { rootPath: string; version: string };
      expect(body.version).toBe('test');

      const evil = await fetch(
        `${started.url}/${encodeURIComponent('..')}/${encodeURIComponent('..')}/package.json`
      );
      expect([403, 404]).toContain(evil.status);
    } finally {
      started.server.closeAllConnections?.();
      started.server.close();
    }
  });
});
