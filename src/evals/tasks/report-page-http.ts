import { Buffer } from 'node:buffer';
import { dashboardToken } from '../mcp-client.js';
import { check, type EvalTask } from '../types.js';
import type { SpawnedClient } from '../mcp-client.js';

/** Poll until the baseline scan has filled the report (deadline-bounded). */
async function fetchReportWhenReady(port: number, query: string): Promise<{ status: number; body: string; contentType: string; csp: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/report${query}`);
      const body = await res.text();
      if (res.ok && body.includes('共 7 个模块')) {
        return { status: res.status, body, contentType: res.headers.get('content-type') ?? '', csp: res.headers.get('content-security-policy') ?? '' };
      }
      if (Date.now() > deadline) {
        throw new Error(`/api/report never showed the full 7-module report (status ${res.status})`);
      }
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Probe: the /api/report acceptance page — server-assembled HTML over the
 * same deterministic health ranking, with the ?focus= deep link computed
 * server-side (no JS). HTTP fetch against the freshly spawned dashboard.
 */
export const task: EvalTask = {
  id: 'report-page-http',
  description: 'GET /api/report serves the ranked HTML report; ?focus= highlights the module row',
  maxMs: 800,
  maxBytes: 16000,
  async probe(client): Promise<void> {
    const port = (client as SpawnedClient).port;
    // P0-4: /api/* is authenticated with the startup token from the dashboard URL.
    const token = await dashboardToken(client);

    const plain = await fetchReportWhenReady(port, `?token=${token}`);
    check(plain.status === 200, `status ${plain.status}, expected 200`);
    check(plain.contentType.includes('text/html'), `content-type wrong: ${plain.contentType}`);
    check(plain.csp.includes('default-src'), `CSP header missing: ${plain.csp}`);
    check(plain.body.includes('<h1>模块健康报告</h1>'), 'page lacks the title section');
    check(plain.body.includes('权重表') && plain.body.includes('排名'), 'page lacks the weights/ranking sections');
    check(plain.body.includes('id="module-core/emitter.ts"'), 'page lacks the top module anchor');
    check(!plain.body.includes('class="report-item report-focus"'), 'no row may be highlighted without ?focus');
    // Off-wire traffic: deposit into the client's single budget (候选 #3).
    client.countExternal(Buffer.byteLength(plain.body, 'utf8'));

    const focused = await fetchReportWhenReady(port, `?token=${token}&focus=core%2Femitter.ts`);
    check(focused.status === 200, `focus fetch status ${focused.status}`);
    check(
      focused.body.includes('<li id="module-core/emitter.ts" class="report-item report-focus">'),
      'focus deep link must highlight the target row server-side'
    );
    check(focused.body.includes('聚焦模块：<code>core/emitter.ts</code>'), 'focus note missing');
    check(
      focused.body.split('class="report-item report-focus"').length === 2,
      'exactly one row may bear the highlight class'
    );
    client.countExternal(Buffer.byteLength(focused.body, 'utf8'));
  }
};
