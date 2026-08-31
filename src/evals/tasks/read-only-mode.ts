import { check, type EvalTask, type ProbeResult } from '../types.js';

/**
 * Probe: MODULE_GRAPH_MCP_READ_ONLY=1 hides exactly the seven mutation tools
 * (review trio + note + test-run + ADR 0002 改动核对工具对) from tools/list
 * (analysis tools stay visible) and a mutation tools/call is refused with the
 * dedicated audit error — NOT a generic "Unknown tool" — so the mode is
 * diagnosable from the wire alone. spawnClient injects the env (GitNexus
 * port step 5).
 */
const MUTATION_TOOLS = [
  'report_note',
  'begin_review',
  'update_review',
  'end_review',
  'report_test_run',
  'declare_edit_scope',
  'report_edits'
];

export const task: EvalTask = {
  id: 'read-only-mode',
  description: 'MODULE_GRAPH_MCP_READ_ONLY=1 hides the mutation tools and refuses their calls with the audit error',
  maxMs: 600,
  maxBytes: 4000,
  spawnEnv: { MODULE_GRAPH_MCP_READ_ONLY: '1' },
  async probe(client): Promise<ProbeResult> {
    const names = await client.listTools();
    for (const blocked of MUTATION_TOOLS) {
      check(!names.includes(blocked), `read-only leak: ${blocked} is still listed`);
    }
    for (const visible of ['get_impact', 'get_change_impact', 'get_health_report', 'get_module_graph']) {
      check(names.includes(visible), `analysis tool missing in read-only mode: ${visible}`);
    }

    const refused = await client.callTool('report_note', { path: 'index.ts', text: 'should not land' });
    check(refused.failed, 'report_note must be refused in read-only mode');
    check(refused.rpcError !== undefined, `refusal must be a JSON-RPC error: ${refused.text.slice(0, 80)}`);
    check(
      refused.rpcError!.message.includes('unavailable in read-only mode'),
      `refusal message wrong: ${refused.rpcError!.message}`
    );

    // ADR 0002 §7.2: the edit-scope pair is mutation-class too.
    const scopeRefused = await client.callTool('declare_edit_scope', { modules: ['dashboard'] });
    check(scopeRefused.failed, 'declare_edit_scope must be refused in read-only mode');
    check(scopeRefused.rpcError !== undefined, `scope refusal must be a JSON-RPC error: ${scopeRefused.text.slice(0, 80)}`);
    check(
      scopeRefused.rpcError!.message.includes('unavailable in read-only mode'),
      `scope refusal message wrong: ${scopeRefused.rpcError!.message}`
    );
    const editsRefused = await client.callTool('report_edits', { files: ['core/app.ts'] });
    check(editsRefused.failed, 'report_edits must be refused in read-only mode');
    check(editsRefused.rpcError !== undefined, `edits refusal must be a JSON-RPC error: ${editsRefused.text.slice(0, 80)}`);

    // Analysis still works end-to-end in the same session.
    const info = await client.callTool('get_health_report');
    check(!info.failed, `analysis tool broke in read-only mode: ${info.rpcError?.message ?? info.text}`);
    return { bytes: refused.bytes + scopeRefused.bytes + editsRefused.bytes + info.bytes };
  }
};
