/**
 * Response budget guardrail (GitNexus port, plan step 5): a tool reply that
 * would flood the agent's context is cut to a token budget with an explicit
 * English truncation marker carrying the original estimate and the fix.
 *
 * The estimate is the plan-pinned simplification: one token ≈ 4 UTF-8 bytes.
 * No tokenizer, no dependency — a coarse upper bound is exactly right for a
 * guardrail. Cutting a JSON reply can leave it unparseable; that is accepted
 * on purpose (plan §风险): the guardrail text must always survive, and the
 * marker tells the agent how to recover.
 */

/** Plan-pinned conversion rate: one estimated token per 4 UTF-8 bytes. */
export const BYTES_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

export interface BudgetedText {
  text: string;
  truncated: boolean;
  /** Estimated tokens of the ORIGINAL text (marker reports this). */
  originalTokens: number;
}

/**
 * Enforce a token budget on one reply text. Within budget → unchanged.
 * Over budget → the body is cut at the last UTF-8 character boundary that
 * fits `maxTokens × 4` bytes MINUS the marker's own bytes, and the marker is
 * appended. A budget too small to hold any body returns the marker alone —
 * the guardrail text always wins.
 */
export function applyTokenBudget(text: string, maxTokens: number): BudgetedText {
  const originalTokens = estimateTokens(text);
  if (originalTokens <= maxTokens) return { text, truncated: false, originalTokens };

  const suffix = `\n\n[module-graph-mcp: response truncated at ~${maxTokens} tokens — original ≈ ${originalTokens} tokens. Narrow your query (fewer nodes, smaller depth) or raise the per-call "_maxTokens" argument.]`;
  const budgetBytes = maxTokens * BYTES_PER_TOKEN;
  const bodyBytes = budgetBytes - Buffer.byteLength(suffix, 'utf8');
  if (bodyBytes <= 0) {
    return { text: suffix.trimStart(), truncated: true, originalTokens };
  }
  const buf = Buffer.from(text, 'utf8');
  // Never split a multi-byte character: walk back over UTF-8 continuation
  // bytes (0b10xxxxxx) to the last character boundary at or before the cut.
  let end = bodyBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8') + suffix, truncated: true, originalTokens };
}
