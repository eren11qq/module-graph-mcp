import './styles.css';
import type { GraphEvent, GraphSnapshot, TestState } from '../shared/types.js';
import type { SourceLoader } from './code-view.js';
import { createDetailPanel } from './detail-panel.js';
import { createFrameSink, type FrameSink } from './frame-sink.js';
import { createGraphModel } from './graph-model.js';
import { createGraphView } from './graph-view.js';
import { createLegend } from './legend.js';
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

/** Ticket 09: restricted source fetch for the detail panel's code view. */
async function loadSource(path: string): Promise<{ content: string; truncated?: boolean }> {
  const res = await fetch(`/api/source?path=${encodeURIComponent(path)}`);
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
  onFocusChange: (node) => sink?.setFocus(node)
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
// View controls (ticket 11): search box, 只看未测 filter, directory collapse
// ---------------------------------------------------------------------------

const btnUntestedOnly = document.getElementById('btn-untested-only') as HTMLButtonElement;
const btnCollapse = document.getElementById('btn-collapse') as HTMLButtonElement;
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
btnCollapse.addEventListener('click', () => toggleBtn(btnCollapse, (on) => setViewState({ collapseEnabled: on })));
searchBox.addEventListener('input', () => setViewState({ query: searchBox.value }));

// ---------------------------------------------------------------------------
// Connection: REST first render + WS both enter through the sink's single
// apply() seam; frame guards live there.
// ---------------------------------------------------------------------------

function setLive(connected: boolean, text: string): void {
  connEl.classList.toggle('off', !connected);
  connTxt.textContent = text;
}

function connectWs(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
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
    setLive(false, '离线 · 重连中…');
    setTimeout(connectWs, CHROME.wsRetryMs);
  });
}

async function boot(): Promise<void> {
  applyTheme(storedTheme(), false);

  try {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snapshot = (await res.json()) as GraphSnapshot;
    sink?.apply({ type: 'snapshot', snapshot });
  } catch (err) {
    statusbar.flashEvent(`图数据未就绪（${err instanceof Error ? err.message : String(err)}）`);
  }

  connectWs();
}

void boot();
