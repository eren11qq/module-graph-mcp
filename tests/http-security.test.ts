import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHttpServer } from '../src/server/http.js';
import { getFreePort } from './helpers/net.js';

/**
 * P0-1 security envelope for the dashboard HTTP surface: malformed
 * percent-encoding must not kill the process, foreign Host headers (DNS
 * rebinding) are rejected, WS upgrades only happen on /ws with the
 * dashboard's own Origin (CSWSH), and every response carries nosniff
 * (+ CSP on HTML).
 */

let root = '';
let url = '';
let wsUrl = '';
let teardown: (() => Promise<void>) | null = null;

async function start(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'module-graph-httpsec-'));
  const started = await startHttpServer({
    preferredPort: await getFreePort(),
    publicDir: 'src/server/public',
    info: { rootPath: root, port: 0, version: 'test' },
    getSnapshot: () => ({ generatedAt: 0, rootPath: root, nodes: [], edges: [] })
  });
  url = started.url;
  wsUrl = `${url.replace(/^http/, 'ws')}/ws`;
  teardown = async () => {
    started.server.closeAllConnections?.();
    started.server.close();
  };
}

function rawRequest(
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsProbe(socketUrl: string, headers: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(socketUrl, { headers });
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

describe('http security envelope (P0-1)', () => {
  it('answers 400 for malformed percent-encoding and keeps serving', async () => {
    const res = await fetch(`${url}/%zz`);
    expect(res.status).toBe(400);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const after = await fetch(`${url}/api/info`);
    expect(after.status).toBe(200);
  });

  it('rejects foreign Host headers with 403 (DNS rebinding)', async () => {
    const res = await rawRequest('/api/info', { host: 'evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects a loopback host on the wrong port', async () => {
    const port = Number(new URL(url).port);
    const res = await rawRequest('/api/info', { host: `127.0.0.1:${port + 1}` });
    expect(res.status).toBe(403);
  });

  it('accepts the real loopback Host', async () => {
    const res = await fetch(`${url}/api/info`);
    expect(res.status).toBe(200);
  });

  it('rejects WebSocket upgrades on non-/ws paths', async () => {
    const bad = wsUrl.replace(/\/ws$/, '/nope');
    await expect(wsProbe(bad, {})).resolves.toBe('rejected');
  });

  it('rejects WebSocket upgrades with a foreign Origin', async () => {
    await expect(wsProbe(wsUrl, { origin: 'http://evil.example' })).resolves.toBe('rejected');
  });

  it('accepts WebSocket upgrades with the dashboard origin', async () => {
    await expect(wsProbe(wsUrl, { origin: url })).resolves.toBe('open');
  });

  it('sends nosniff on API and static responses', async () => {
    for (const path of ['/api/info', '/api/graph', '/api/source?path=nope.ts', '/definitely-missing']) {
      const res = await fetch(`${url}${path}`);
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });

  it('sends a strict CSP on HTML responses', async () => {
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'"
    );
  });
});
