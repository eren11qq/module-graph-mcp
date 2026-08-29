import { describe, expect, it } from 'vitest';
import { worstReviewVerdict, REVIEW_RING_LABELS } from '../src/web/ai-review.js';
import type { AiReview } from '../shared/types.js';

/**
 * AI 评审环判定纯函数（code-review 2026-08-29）：最差 verdict 定环色，
 * error > unsure > confident；仅 done 参与判定。graph-view 的 border 通道
 * 规则与 main.ts 的图例行共用这一份判定。
 */

function review(partial: Partial<AiReview>): AiReview {
  return { status: 'done', verdicts: [], ...partial };
}

describe('worstReviewVerdict — 评审环判定', () => {
  it('checking 中与从未评审的节点没有环', () => {
    expect(worstReviewVerdict(undefined)).toBe('');
    expect(worstReviewVerdict({ status: 'checking', verdicts: [] })).toBe('');
  });

  it('error 压过 unsure，unsure 压过 confident', () => {
    expect(
      worstReviewVerdict(review({ verdicts: [{ line: 1, verdict: 'unsure' }, { line: 2, verdict: 'error' }] }))
    ).toBe('error');
    expect(
      worstReviewVerdict(review({ verdicts: [{ line: 1, verdict: 'confident' }, { line: 2, verdict: 'unsure' }] }))
    ).toBe('unsure');
    expect(worstReviewVerdict(review({ verdicts: [{ line: 1, verdict: 'confident' }] }))).toBe('confident');
  });

  it('done 且 verdicts 为空 = 全 confident（绿环，零问题也是结论）', () => {
    expect(worstReviewVerdict(review({}))).toBe('confident');
  });

  it('图例标签覆盖全部三档', () => {
    expect(Object.keys(REVIEW_RING_LABELS).sort()).toEqual(['confident', 'error', 'unsure']);
  });
});
