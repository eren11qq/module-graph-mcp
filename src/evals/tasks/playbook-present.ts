import { check, type EvalTask } from '../types.js';
import { MAX_REVIEW_SUMMARY, MAX_VERDICT_ENTRIES, MAX_VERDICT_MESSAGE } from '../../server/review-lifecycle.js';

/**
 * Probe: begin_review embeds the review playbook (trust-loop roadmap PR-5)
 * — the section headers are the contract, asserted verbatim so the text
 * cannot drift silently. Closes the review it opened (no dangling checking).
 *
 * 候选 #10 (2026-09-05): the budget numbers ride the same reply, asserted
 * AGAINST THE CONSTANTS — the playbook text interpolates them, so a probe
 * pass means "the prose still cites the live budgets". A re-hardcoded or
 * de-numbered sentence trips these checks. ADR 0001 discipline: playbook
 * text edits and this probe ship in one change.
 */
export const task: EvalTask = {
  id: 'playbook-present',
  description: 'begin_review reply embeds the stable review playbook (Verdicts / Cadence / Closure sections)',
  maxMs: 500,
  maxBytes: 2500,
  async probe(client): Promise<void> {
    const begin = await client.callTool('begin_review', { path: 'utils/format.ts' });
    check(!begin.failed, `begin_review failed: ${begin.rpcError?.message ?? begin.text}`);
    const p = begin.payload as { aiReview?: { status?: string }; playbook?: string };
    check(p.aiReview?.status === 'checking', 'begin must land in checking');
    const playbook = p.playbook ?? '';
    check(playbook.includes('## Review playbook'), 'playbook header missing');
    check(playbook.includes('### Verdicts'), 'playbook Verdicts section missing');
    for (const verdict of ['confident', 'unsure', 'error']) {
      check(playbook.includes(`- ${verdict}:`), `playbook lacks the ${verdict} definition`);
    }
    check(playbook.includes('### Cadence'), 'playbook Cadence section missing');
    check(playbook.includes('update_review'), 'playbook Cadence must mention update_review');
    check(playbook.includes('### Closure'), 'playbook Closure section missing');
    check(playbook.includes('end_review') && playbooksaysPairing(playbook), 'playbook Closure must demand begin/end pairing');
    check(playbook.includes('summary'), 'playbook Closure must mention the summary requirement');
    // Drift alarm (候选 #10): the cited budgets must track the constants.
    check(playbook.includes(`max ${MAX_VERDICT_ENTRIES} entries`), `playbook entry cap no longer tracks MAX_VERDICT_ENTRIES=${MAX_VERDICT_ENTRIES}`);
    check(playbook.includes(`message max ${MAX_VERDICT_MESSAGE} chars`), `playbook message cap no longer tracks MAX_VERDICT_MESSAGE=${MAX_VERDICT_MESSAGE}`);
    check(playbook.includes(`summary (max ${MAX_REVIEW_SUMMARY} chars)`), `playbook summary cap no longer tracks MAX_REVIEW_SUMMARY=${MAX_REVIEW_SUMMARY}`);

    // Hygiene: never leave the probed module in checking.
    const end = await client.callTool('end_review', { path: 'utils/format.ts', verdicts: [] });
    check(!end.failed, `end_review failed: ${end.rpcError?.message ?? end.text}`);
  }
};

/** The pairing rule wording the agent must see. */
function playbooksaysPairing(playbook: string): boolean {
  return playbook.includes('ALWAYS pair a begin_review with an end_review');
}
