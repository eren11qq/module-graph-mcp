import { basename } from 'node:path';
import { check, type EvalTask, type ProbeResult } from '../types.js';

/** Probe ①: get_dashboard_info hands back the watched root it was spawned with. */
export const task: EvalTask = {
  id: 'dashboard-info-reports-root',
  description: 'get_dashboard_info reports the spawned fixture root and a loopback dashboard URL',
  maxMs: 500,
  maxBytes: 600,
  async probe(client): Promise<ProbeResult> {
    const res = await client.callTool('get_dashboard_info');
    check(!res.failed, `get_dashboard_info failed: ${res.rpcError?.message ?? res.text}`);
    const p = res.payload as { rootPath?: unknown; dashboardUrl?: unknown; nodeCount?: unknown; edgeCount?: unknown };
    check(typeof p.rootPath === 'string' && basename(p.rootPath) === 'sample-app', `rootPath wrong: ${String(p.rootPath)}`);
    check(
      typeof p.dashboardUrl === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(p.dashboardUrl),
      `dashboardUrl not a loopback URL: ${String(p.dashboardUrl)}`
    );
    check(p.nodeCount === 7 && p.edgeCount === 8, `counts wrong: nodes=${String(p.nodeCount)} edges=${String(p.edgeCount)}`);
    return { bytes: res.bytes };
  }
};
