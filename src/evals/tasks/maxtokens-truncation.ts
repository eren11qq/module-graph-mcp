import { check, type EvalTask } from '../types.js';

/**
 * Probe: the per-call `_maxTokens` guardrail. A tiny budget cuts the reply
 * to the truncation marker (original estimate + fix guidance, English) even
 * when the marker alone exceeds the budget; a generous budget leaves the
 * reply a parseable JSON payload. The JSON-after-cut may be unparseable by
 * design (plan §风险) — the MARKER is the contract, not the JSON.
 */
export const task: EvalTask = {
  id: 'maxtokens-truncation',
  description: '_maxTokens cuts an over-budget reply to the marker; a generous budget passes it through intact',
  maxMs: 500,
  maxBytes: 6000,
  async probe(client): Promise<void> {
    const cut = await client.callTool('get_health_report', { _maxTokens: 30 });
    check(!cut.failed, `budgeted call must still succeed: ${cut.rpcError?.message ?? cut.text}`);
    check(cut.text.includes('response truncated'), `marker missing: ${cut.text.slice(0, 120)}`);
    check(cut.text.includes('original ≈'), `original estimate missing: ${cut.text.slice(0, 160)}`);
    check(cut.text.includes('"_maxTokens"'), `fix guidance missing: ${cut.text.slice(-120)}`);
    check(cut.text.length < 400, `tiny budget returned a huge text: ${cut.text.length} chars`);

    const intact = await client.callTool('get_health_report', { _maxTokens: 100000 });
    check(!intact.failed, `generous budget broke the call: ${intact.rpcError?.message ?? intact.text}`);
    const p = intact.payload as { totalModules?: number } | undefined;
    check(p?.totalModules === 7, `pass-through reply not parseable: ${intact.text.slice(0, 80)}`);
  }
};
