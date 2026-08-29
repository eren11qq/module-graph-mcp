import type { AiReview, AiVerdict } from '../shared/types.js';

/**
 * AI 评审环词汇（code-review 2026-08-29）：一个节点检查完成后，由「最差
 * verdict」决定球外圈环色——error 红环 > unsure 黄环 > confident 绿环。
 * checking 中与从未评审的节点没有环（''）。纯 data-in/data-out，stylesheet
 * 规则（graph-view）与图例行（main.ts）共用这一份判定。
 */

/** '' = 无评审环（checking 中 / 未评审）。 */
export type ReviewRingVerdict = '' | AiVerdict;

export function worstReviewVerdict(review: AiReview | undefined): ReviewRingVerdict {
  if (review === undefined || review.status !== 'done') return '';
  if (review.verdicts.some((v) => v.verdict === 'error')) return 'error';
  if (review.verdicts.some((v) => v.verdict === 'unsure')) return 'unsure';
  // done 且无 error/unsure（含空 verdicts 列表）= 全 confident。
  return 'confident';
}

/** 图例行的三色样本标签（与环色一一对应）。 */
export const REVIEW_RING_LABELS: Record<Exclude<ReviewRingVerdict, ''>, string> = {
  confident: '全 confident',
  unsure: '有 unsure',
  error: '有 error'
};
