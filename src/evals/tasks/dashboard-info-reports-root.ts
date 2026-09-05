import { basename } from 'node:path';
import { check, type EvalTask } from '../types.js';

/**
 * Probe ①: get_dashboard_info hands back the watched root it was spawned with.
 *
 * P0-1 (交付审计): like get_module_graph, get_dashboard_info answers
 * immediately with `scanning: true` while the baseline scan is still running
 * (plugin-mode handshake must never wait), so under a loaded cold start the
 * node/edge counts can read 0/0. The probe waits out the baseline with the
 * same bounded retry budget as module-graph-shape; when the budget is spent
 * the count checks below fail with the usual explicit message. maxMs covers
 * that worst case (measured ~100-150ms when the baseline is warm, ADR 0001).
 */
const SCAN_RETRY_BUDGET_MS = 2500;
const SCAN_RETRY_STEP_MS = 100;

export const task: EvalTask = {
  id: 'dashboard-info-reports-root',
  description: 'get_dashboard_info reports the spawned fixture root and a loopback dashboard URL plus the ADR 0002 module table',
  maxMs: 3000,
  // 候选 #3 (2026-09-05): the honest client meter also charges the initialize
  // handshake and EVERY scan-settle retry reply (the old hand-sum counted only
  // the last). Measured 2259B; 3000 keeps the ADR 0001 hairline within ~33%.
  maxBytes: 3000,
  async probe(client): Promise<void> {
    let res = await client.callTool('get_dashboard_info');
    check(!res.failed, `get_dashboard_info failed: ${res.rpcError?.message ?? res.text}`);
    let p = res.payload as {
      scanning?: boolean;
      rootPath?: unknown;
      dashboardUrl?: unknown;
      nodeCount?: unknown;
      edgeCount?: unknown;
      modules?: Array<{ id?: unknown; label?: unknown; files?: unknown }>;
    };
    const settled = () => p.scanning !== true && p.nodeCount === 7 && p.edgeCount === 8;
    const deadline = Date.now() + SCAN_RETRY_BUDGET_MS;
    while (!settled() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SCAN_RETRY_STEP_MS));
      res = await client.callTool('get_dashboard_info');
      check(!res.failed, `get_dashboard_info failed on retry: ${res.rpcError?.message ?? res.text}`);
      p = res.payload as typeof p;
    }
    check(typeof p.rootPath === 'string' && basename(p.rootPath) === 'sample-app', `rootPath wrong: ${String(p.rootPath)}`);
    check(
      typeof p.dashboardUrl === 'string' &&
        /^http:\/\/127\.0\.0\.1:\d+\?token=[0-9a-f]{32}$/.test(p.dashboardUrl),
      `dashboardUrl not a loopback URL with the startup token: ${String(p.dashboardUrl)}`
    );

    check(p.nodeCount === 7 && p.edgeCount === 8, `counts wrong: nodes=${String(p.nodeCount)} edges=${String(p.edgeCount)}`);
    // ADR 0002 §7.1: the module table rides get_dashboard_info (单一事实源).
    check(Array.isArray(p.modules) && p.modules.length === 6, `modules list missing: ${JSON.stringify(p.modules)}`);
    check(
      p.modules!.every((m) => typeof m.id === 'string' && typeof m.label === 'string' && Array.isArray(m.files)),
      `module entry shape wrong: ${JSON.stringify(p.modules)}`
    );
  }
};
