import './styles.css';
import type { GraphEvent, GraphSnapshot, TestState } from '../shared/types.js';
import type { SourceLoader } from './code-view.js';
import { createDetailPanel } from './detail-panel.js';
import { createFrameSink, type FrameSink } from './frame-sink.js';
import { createGraphModel } from './graph-model.js';
import { createGraphView } from './graph-view.js';
import { createLegend } from './legend.js';
import type { LayoutMode } from './layout-store.js';
import { createStatusbar } from './statusbar.js';
import { CHROME, setTheme as setActiveTheme, type ThemeKey } from './theme.js';

// ---------------------------------------------------------------------------
// Section 3 mount points (the only DOM the render path touches)
// ---------------------------------------------------------------------------

const cyContainer = document.getElementById('cy') as HTMLElement;
const tooltipEl = document.getElementById('tooltip') as HTMLElement;
const detailContainer = document.getElementById('detail-card') as HTMLElement;
const legendEl = document.getElementById('legend') as HTMLElement;
const scanNotice = document.getElementById('scan-notice') as HTMLElement;
const authNotice = document.getElementById('auth-notice') as HTMLElement;
const connEl = document.getElementById('conn') as HTMLElement;
const connTxt = document.getElementById('conn-txt') as HTMLElement;

// One browser-side graph: every frame folds here, and every consumer
// (statusbar counts, detail-panel adjacency) reads through the model.
const model = createGraphModel();

// The sink and the view reference each other: view focus events route into
// the sink, the sink's detail-panel jumps route back into the view. The view
// is created first with a late-bound callback; the sink is assigned right
// after, before any frame or interaction can arrive.
let sink: FrameSink | undefined;

// P0-4: the startup token rides in the dashboard URL (?token=…). Every /api/*
// fetch and the WS handshake must present it; static assets load without it
// so the shell can read it out of its own location first.
const TOKEN = new URLSearchParams(location.search).get('token') ?? '';

/** Append the startup token to a URL that already has a query string. */
function withToken(query: string): string {
  return TOKEN === '' ? query : `${query}&token=${encodeURIComponent(TOKEN)}`;
}

/** Ticket 09: restricted source fetch for the detail panel's code view. */
async function loadSource(path: string): Promise<{ content: string; truncated?: boolean }> {
  const res = await fetch(withToken(`/api/source?path=${encodeURIComponent(path)}`));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { content: string; truncated?: boolean };
  return { content: body.content, truncated: body.truncated };
}

const detailPanel = createDetailPanel(detailContainer, loadSource);

const view = createGraphView(cyContainer, {
  tooltipEl,
  physics: true,
  onFocusChange: (node) => sink?.setFocus(node),
  onLayoutModeChange: (mode) => renderModeButtons(mode)
});

const statusbar = createStatusbar({
  sbLeft: document.getElementById('sb-left') as HTMLElement,
  band: document.getElementById('band') as HTMLElement,
  bandCap: document.getElementById('band-cap') as HTMLElement,
  evt: document.getElementById('evt') as HTMLElement
});

// Filter knobs stay owned here — main is the composition root; the sink
// reads them at render time instead of keeping its own mirror.
const hiddenStates = new Set<TestState>();
let hideReviewed = false;

const legend = createLegend(legendEl, {
  onToggleState: (state) => {
    if (hiddenStates.has(state)) hiddenStates.delete(state);
    else hiddenStates.add(state);
    setViewState({ hiddenStates: new Set(hiddenStates) });
  },
  onToggleReviewed: () => {
    hideReviewed = !hideReviewed;
    setViewState({ hideReviewed });
  }
});

sink = createFrameSink({
  model,
  view,
  statusbar,
  legend,
  detail: detailPanel,
  scanNotice,
  filters: () => ({ hiddenStates, hideReviewed })
});

// ---------------------------------------------------------------------------
// Theme: dark 暗色仪器盘 (default) / light 亮色工作台; topbar toggle +
// localStorage mg-theme. Canvas palette via graph-view.setTheme (cy.style
// rebuild keeps positions), shell via body[data-theme] CSS tokens.
// ---------------------------------------------------------------------------

const themeBtn = document.getElementById('btn-theme') as HTMLButtonElement;
let currentTheme: ThemeKey = CHROME.defaultTheme;

function storedTheme(): ThemeKey {
  try {
    const v = localStorage.getItem(CHROME.themeStorageKey);
    return v === 'light' || v === 'dark' ? v : CHROME.defaultTheme;
  } catch {
    return CHROME.defaultTheme;
  }
}

function applyTheme(key: ThemeKey, persist = true): void {
  currentTheme = key;
  document.body.dataset.theme = key;
  setActiveTheme(key);
  view.setTheme(key);
  // Legend swatches echo the active canvas palette.
  sink?.refreshDerived();
  themeBtn.textContent = key === 'dark' ? '亮色工作台' : '暗色仪器盘';
  themeBtn.title = key === 'dark' ? '切换到亮色工作台' : '切换到暗色仪器盘';
  if (persist) {
    try {
      localStorage.setItem(CHROME.themeStorageKey, key);
    } catch {
      /* private mode: theme just won't survive a reload */
    }
  }
}

themeBtn.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// ---------------------------------------------------------------------------
// Keyboard: Esc drops the focus lock.
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (evt) => {
  const target = evt.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }
  if (evt.key === 'Escape') {
    view.clearFocus();
  }
});

document.getElementById('btn-reset')?.addEventListener('click', () => view.resetView());
document.getElementById('btn-reset-layout')?.addEventListener('click', () => view.resetLayout());

// ---------------------------------------------------------------------------
// 排列模式分段开关 (ADR 0004): topbar 区域的/聚类的 → view.setLayoutMode。
// 激活态复用 .tool-toggle.active；per-root 模式经 layout-store 持久化
// （store 通道自带隐私模式回落，不裸用 localStorage——与主题同姿态）。
// ---------------------------------------------------------------------------

const btnModeRegions = document.getElementById('btn-mode-regions') as HTMLButtonElement;
const btnModeCluster = document.getElementById('btn-mode-cluster') as HTMLButtonElement;

function renderModeButtons(mode: LayoutMode): void {
  btnModeRegions.classList.toggle('active', mode === 'regions');
  btnModeCluster.classList.toggle('active', mode === 'cluster');
}

btnModeRegions.addEventListener('click', () => view.setLayoutMode('regions'));
btnModeCluster.addEventListener('click', () => view.setLayoutMode('cluster'));
renderModeButtons(view.getLayoutMode());

// ---------------------------------------------------------------------------
// View controls (ticket 11): search box, 只看未测 filter
// ---------------------------------------------------------------------------

const btnUntestedOnly = document.getElementById('btn-untested-only') as HTMLButtonElement;
const searchBox = document.getElementById('search-box') as HTMLInputElement;

function toggleBtn(btn: HTMLButtonElement, set: (on: boolean) => void): void {
  const on = !btn.classList.contains('active');
  btn.classList.toggle('active', on);
  set(on);
}

/** One funnel for every view-state change: the statusbar's visible-graph
    counters (循环依赖) must track what the pipeline just rendered. */
function setViewState(patch: Parameters<typeof view.setViewState>[0]): void {
  view.setViewState(patch);
  sink?.refreshDerived();
}

btnUntestedOnly.addEventListener('click', () => toggleBtn(btnUntestedOnly, (on) => setViewState({ untestedOnly: on })));
searchBox.addEventListener('input', () => setViewState({ query: searchBox.value }));

// ---------------------------------------------------------------------------
// Connection: REST first render + WS both enter through the sink's single
// apply() seam; frame guards live there.
// ---------------------------------------------------------------------------

function setLive(connected: boolean, text: string): void {
  connEl.classList.toggle('off', !connected);
  connTxt.textContent = text;
}

/**
 * 常驻横幅：访问令牌缺失或失效时整页都是空白，必须让用户看到原因
 * 和正确的打开方式，而不是一条一闪而过的 toast。
 */
function showAuthNotice(message: string): void {
  authNotice.textContent = message;
  authNotice.hidden = false;
}

let wsAuthFailed = false;

function connectWs(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws${TOKEN === '' ? '' : `?token=${encodeURIComponent(TOKEN)}`}`);
  // 非 101 握手响应（401/404）走 error 事件：令牌无效/过期，不再无限重连。
  ws.addEventListener('error', () => {
    wsAuthFailed = true;
  });
  ws.addEventListener('open', () => setLive(true, 'LIVE · WS 已连接'));
  ws.addEventListener('message', (evt) => {
    setLive(true, 'LIVE · WS 已连接');
    let msg: unknown;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return; // tolerate malformed frames
    }
    if (msg === null || typeof msg !== 'object') return;
    sink?.apply(msg as GraphEvent);
  });
  ws.addEventListener('close', () => {
    if (wsAuthFailed) {
      setLive(false, '访问被拒绝');
      showAuthNotice(`访问令牌无效或已过期（服务可能已重启）。请用启动日志中的完整 dashboard 链接重新打开：${location.origin}${location.pathname}?token=…`);
      return; // 不重连：服务端重启换了 token，重连只会空转
    }
    setLive(false, '离线 · 重连中…');
    setTimeout(connectWs, CHROME.wsRetryMs);
  });
}

async function boot(): Promise<void> {
  applyTheme(storedTheme(), false);

  if (TOKEN === '') {
    // 无令牌：/api/* 与 WS 握手全部 401，页面必然空白——直接给指引，别白试。
    setLive(false, '缺少令牌');
    showAuthNotice(`此页面需要访问令牌：请用启动日志中的完整 dashboard 链接打开（URL 应含 ?token=…）。当前地址：${location.origin}${location.pathname}`);
    return;
  }

  try {
    const res = await fetch(`/api/graph${TOKEN === '' ? '' : `?token=${encodeURIComponent(TOKEN)}`}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = (await res.json()) as GraphSnapshot;
    sink?.apply({ type: 'snapshot', snapshot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'HTTP 401') {
      // 令牌失效（服务重启换 token）：连接也是 401，别再发起。
      setLive(false, '访问被拒绝');
      showAuthNotice(`访问令牌无效或已过期（服务可能已重启）。请用启动日志中的完整 dashboard 链接重新打开：${location.origin}${location.pathname}?token=…`);
      return;
    }
    statusbar.flashEvent(`图数据未就绪（${message}）`);
  }

  connectWs();
}

void boot();
