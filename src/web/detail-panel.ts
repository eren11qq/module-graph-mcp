import type { ModuleNode } from '../shared/types.js';
import { worstReviewVerdict } from './ai-review.js';
import { createSourceView, type SourceLoader } from './code-view.js';
import { reviewColor, shortLabel } from './theme.js';
import { stateLabel, stateColor } from './test-states.js';

export interface DetailContext {
  outgoing: string[];
  incoming: string[];
  onJump(id: string): void;
}

export interface DetailPanel {
  show(node: ModuleNode, ctx: DetailContext): void;
  clear(): void;
}

function formatRunAt(ts: number | undefined): string {
  if (ts === undefined) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Right-column detail card (ticket 08/09 + theme.html 定稿 + ticket 12):
 * name/path, state badge, degrees, note, the AI-review status area (checking
 * pulse label / done + summary + verdict tallies), type errors, coverage,
 * clickable in/out lists, and the line-rendered source view.
 *
 * The whole card is the vertical scroll container (styles.css); the source
 * block itself is no longer height-capped — long lines fold, nothing needs
 * horizontal scrolling, and trailing `// ? 待确认` markers stay attached to
 * their row.
 */
export function createDetailPanel(container: HTMLElement, loadSource: SourceLoader): DetailPanel {
  // One source-view instance lives across panel rebuilds; the element is
  // detached on replaceChildren and re-attached below.
  const sourceHost = document.createElement('div');
  const sourceView = createSourceView(sourceHost, loadSource);

  function clear(): void {
    container.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'detail-hint';
    hint.textContent = '点击小球锁定模块详情；点空白、Esc 或再次点击解锁。';
    container.append(hint);
  }

  function block(title: string): { root: HTMLElement; body: HTMLElement } {
    const root = document.createElement('div');
    root.className = 'detail-block';
    const heading = document.createElement('div');
    heading.className = 'detail-block-title';
    heading.textContent = title;
    const body = document.createElement('div');
    root.append(heading, body);
    return { root, body };
  }

  function jumpList(ids: string[], ctx: DetailContext): HTMLElement {
    const wrap = document.createElement('div');
    if (ids.length === 0) {
      const none = document.createElement('span');
      none.className = 'detail-none';
      none.textContent = '无';
      wrap.append(none);
      return wrap;
    }
    for (const id of ids) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'detail-link';
      btn.textContent = shortLabel(id);
      btn.title = id;
      btn.addEventListener('click', () => ctx.onJump(id));
      wrap.append(btn);
    }
    return wrap;
  }

  /** Ticket 12: AI review status area between the meta row and the code. */
  function aiReviewArea(node: ModuleNode): HTMLElement | null {
    const review = node.aiReview;
    if (review === undefined) return null;
    const root = document.createElement('div');
    root.className = `ai-status ai-${review.status}`;
    if (review.status === 'checking') {
      const tag = document.createElement('span');
      tag.className = 'checking-tag';
      tag.textContent = 'AI 检查中';
      root.append(tag);
      return root;
    }
    const label = document.createElement('span');
    label.className = 'ai-done-label';
    label.textContent = 'AI 检查完成';
    root.append(label);

    const tally = { confident: 0, unsure: 0, error: 0 };
    for (const v of review.verdicts) tally[v.verdict]++;
    const counts = document.createElement('span');
    counts.className = 'ai-tally';
    counts.innerHTML = '';
    const parts: Array<[string, string]> = [
      ['ai-t-pass', `✓ ${tally.confident}`],
      ['ai-t-unsure', `? ${tally.unsure}`],
      ['ai-t-error', `✗ ${tally.error}`]
    ];
    for (const [cls, text] of parts) {
      const t = document.createElement('span');
      t.className = cls;
      t.textContent = text;
      counts.append(t);
    }
    root.append(counts);

    if (review.summary !== undefined && review.summary.length > 0) {
      const summary = document.createElement('div');
      summary.className = 'ai-summary';
      summary.textContent = review.summary;
      root.append(summary);
    }
    if (review.reviewedAt !== undefined) {
      const at = document.createElement('div');
      at.className = 'ai-reviewed-at';
      at.textContent = `检查时间 ${formatRunAt(review.reviewedAt)}`;
      root.append(at);
    }
    return root;
  }

  function show(node: ModuleNode, ctx: DetailContext): void {
    container.replaceChildren();

    const name = document.createElement('div');
    name.className = 'detail-name';
    name.textContent = shortLabel(node.path);

    const pathEl = document.createElement('div');
    pathEl.className = 'detail-path';
    pathEl.textContent = node.path;
    pathEl.title = node.path;

    const metaRow = document.createElement('div');
    metaRow.className = 'detail-meta';
    const badge = document.createElement('span');
    badge.className = 'detail-badge';
    badge.style.color = stateColor(node.testState);
    badge.style.borderColor = stateColor(node.testState);
    badge.textContent = stateLabel(node.testState);
    // Code-review 2026-08-29: AI 检查徽章 — 状态徽章旁一眼可见该模块正被 /
    // 已被 AI 检查；tally 与 summary 细节仍在下方 aiReviewArea。checking 用
    // accent 色，done 按最差 verdict 取评审环三色。
    let aiBadge: HTMLSpanElement | null = null;
    if (node.aiReview !== undefined) {
      aiBadge = document.createElement('span');
      aiBadge.className = 'detail-badge ai-badge';
      aiBadge.textContent = node.aiReview.status === 'checking' ? 'AI 检查中' : 'AI 已检查';
      const tone =
        node.aiReview.status === 'checking'
          ? 'var(--accent)'
          : reviewColor(worstReviewVerdict(node.aiReview));
      aiBadge.style.color = tone;
      aiBadge.style.borderColor = tone;
    }
    const degrees = document.createElement('span');
    degrees.className = 'detail-degrees';
    degrees.textContent = `度 ${ctx.incoming.length + ctx.outgoing.length} ＝ 出 ${ctx.outgoing.length} ＋ 入 ${ctx.incoming.length}`;
    metaRow.append(badge);
    if (aiBadge !== null) metaRow.append(aiBadge);
    metaRow.append(degrees);
    const runAt = document.createElement('div');
    runAt.className = 'detail-degrees detail-runat';
    runAt.textContent = `最近运行 ${formatRunAt(node.lastTestRunAt)}`;

    container.append(name, pathEl, metaRow, runAt);

    // AI review (ticket 12) right under the meta: pulse while checking,
    // summary + tallies once done.
    const ai = aiReviewArea(node);
    if (ai !== null) container.append(ai);

    // Note (ticket 10): free-form agent note via the report_note MCP tool.
    if (node.note !== undefined && node.note.length > 0) {
      const note = block('备注');
      const text = document.createElement('div');
      text.className = 'detail-note';
      text.textContent = node.note;
      note.body.append(text);
      container.append(note.root);
    }

    // Type errors (ticket 07/08): line + code + message, red-marked.
    const errors = block(`类型错误（${node.typeErrors.length}）`);
    if (node.typeErrors.length === 0) {
      const none = document.createElement('span');
      none.className = 'detail-none';
      none.textContent = '无';
      errors.body.append(none);
    } else {
      for (const err of node.typeErrors) {
        const row = document.createElement('div');
        row.className = 'detail-error';
        const where = document.createElement('span');
        where.className = 'detail-error-loc';
        where.textContent = `L${err.line} ${err.code}`;
        const msg = document.createElement('span');
        msg.textContent = err.message;
        row.append(where, msg);
        errors.body.append(row);
      }
    }
    container.append(errors.root);

    // Coverage (ticket 06/08): the test files covering this module.
    const cover = block(`覆盖测试（${node.coveredBy.length}）`);
    cover.body.append(jumpList(node.coveredBy, ctx));
    container.append(cover.root);

    // Dependencies.
    const out = block(`出向（依赖，${ctx.outgoing.length}）`);
    out.body.append(jumpList(ctx.outgoing, ctx));
    container.append(out.root);

    const inc = block(`入向（被引用，${ctx.incoming.length}）`);
    inc.body.append(jumpList(ctx.incoming, ctx));
    container.append(inc.root);

    // Source view (ticket 09/12): per-line rows, verdict highlights; the
    // whole detail card scrolls — no inner height cap, no horizontal scroll.
    const source = block(`源码 · ${node.path}`);
    sourceHost.className = 'code';
    source.body.append(sourceHost);
    container.append(source.root);
    // show() handles load failures itself; this catch is the last resort so
    // a render bug can never surface as an unhandled rejection.
    sourceView.show(node).catch((err: unknown) => {
      const note = document.createElement('div');
      note.className = 'code-error-note';
      note.textContent = `源码渲染失败：${err instanceof Error ? err.message : String(err)}`;
      sourceHost.replaceChildren(note);
    });
  }

  clear();
  return { show, clear };
}
