import type { ModuleNode } from '../shared/types.js';
import { createSourceView, type SourceLoader } from './code-view.js';
import { shortLabel } from './theme.js';
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
 * Right-column detail card (verdict #5 + tickets 08/09): path, state badge,
 * last run time, type errors, coverage, clickable in/out lists, and the
 * highlighted source view with error-line markers.
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

  function show(node: ModuleNode, ctx: DetailContext): void {
    container.replaceChildren();

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
    const runAt = document.createElement('span');
    runAt.className = 'detail-degrees';
    runAt.textContent = `最近运行 ${formatRunAt(node.lastTestRunAt)}`;
    metaRow.append(badge, runAt);

    container.append(pathEl, metaRow);

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

    // Source view (ticket 09): highlighted, error lines marked.
    const source = block(`源码 · ${node.path}`);
    sourceHost.className = 'code-view-host';
    sourceHost.style.position = 'relative';
    sourceHost.style.overflow = 'auto';
    sourceHost.style.maxHeight = '280px';
    sourceHost.style.background = 'var(--bg)';
    sourceHost.style.border = '1px solid var(--border)';
    sourceHost.style.borderRadius = '8px';
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
