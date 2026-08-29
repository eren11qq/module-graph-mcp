import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/server/http.js';
import { getFreePort } from './helpers/net.js';

/**
 * Ticket 09 security acceptance for GET /api/source: the endpoint reads ONLY
 * whitelisted text files inside the watched root; traversal, symlink escape,
 * binary payloads and oversize files are all denied — each denial is also
 * reported to the security-event log.
 */

let root = '';
let url = '';
let teardown: (() => Promise<void>) | null = null;
const securityEvents: string[] = [];

async function start(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'module-graph-source-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'ok.ts'), 'export const ok = 1;\n', 'utf8');
  await writeFile(join(root, 'src', 'data.json'), '{"a":1}\n', 'utf8');
  await writeFile(join(root, 'script.py'), 'print("nope")\n', 'utf8');
  await writeFile(join(root, 'binary.ts'), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(
    join(root, 'big.ts'),
    `export const big = '${'x'.repeat(600 * 1024)}';\n`,
    'utf8'
  );

  const started = await startHttpServer({
    preferredPort: await getFreePort(),
    publicDir: join('dist', 'server', 'public'),
    info: { rootPath: root, port: 0, version: 'test' },
    onSecurityEvent: (msg) => securityEvents.push(msg)
  });
  url = started.url;
  teardown = async () => {
    started.server.closeAllConnections?.();
    started.server.close();
  };
}

async function source(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}/api/source?path=${encodeURIComponent(path)}`);
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

beforeAll(async () => {
  await start();
});

afterAll(async () => {
  await teardown?.();
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/source security envelope (Ticket 09)', () => {
  it('reads a whitelisted text file inside the root', async () => {
    const { status, body } = await source('src/ok.ts');
    expect(status).toBe(200);
    expect(body).toMatchObject({ path: 'src/ok.ts', content: 'export const ok = 1;\n' });
  });

  it('reads json on the whitelist', async () => {
    const { status, body } = await source('src/data.json');
    expect(status).toBe(200);
    expect((body as { content: string }).content).toBe('{"a":1}\n');
  });

  it('denies `..` traversal with a security log entry', async () => {
    securityEvents.length = 0;
    const { status } = await source('../package.json');
    expect(status).toBe(403);
    expect(securityEvents.some((m) => m.includes('403') && m.includes('traversal'))).toBe(true);
  });

  it('denies encoded traversal (%2e%2e)', async () => {
    const { status } = await source('%2e%2e/vite.config.ts');
    expect(status).toBe(403);
  });

  it('denies nested traversal that stays textual (src/../..)', async () => {
    const { status } = await source('src/../../etc/passwd');
    expect(status).toBe(403);
  });

  it('denies absolute paths', async () => {
    const { status } = await source('/etc/passwd');
    expect(status).toBe(403);
  });

  it('denies extensions outside the whitelist', async () => {
    securityEvents.length = 0;
    const { status } = await source('script.py');
    expect(status).toBe(403);
    expect(securityEvents.some((m) => m.includes('whitelist'))).toBe(true);
  });

  it('denies binary payloads with 415', async () => {
    const { status } = await source('binary.ts');
    expect(status).toBe(415);
  });

  it('denies oversize files with 413', async () => {
    const { status } = await source('big.ts');
    expect(status).toBe(413);
  });

  it('answers 404 for missing files inside the root', async () => {
    const { status } = await source('src/nope.ts');
    expect(status).toBe(404);
  });

  it('answers 400 when the path parameter is absent', async () => {
    const res = await fetch(`${url}/api/source`);
    expect(res.status).toBe(400);
  });

  it('denies symlink escapes out of the root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'module-graph-outside-'));
    try {
      await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;\n', 'utf8');
      try {
        await symlink(join(outside, 'secret.ts'), join(root, 'src', 'leak.ts'));
      } catch (err) {
        // Windows without symlink privilege (no admin / developer mode)
        // cannot even CREATE the link — the escape is structurally impossible
        // there, so skip rather than fail on the environment.
        if ((err as NodeJS.ErrnoException)?.code === 'EPERM') return;
        throw err;
      }
      const { status } = await source('src/leak.ts');
      expect(status).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
