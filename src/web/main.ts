import './styles.css';
import type { GraphEvent, GraphSnapshot, TestState } from '../shared/types.js';
import type { SourceLoader } from './code-view.js';
import { createDetailPanel } from './detail-panel.js';
import { createFrameSink, type FrameSink } from './frame-sink.js';
import { createGraphModel } from './graph-model.js';
import { createGraphView } from './graph-view.js';
import { createLegend } from './legend.js';
import { createStatusbar } from './statusbar.js';
import { CHROME, clampTuning, defaultLayoutTuning, TUNING_RANGES, setTheme as setActiveTheme, type LayoutTuning, type ThemeKey } from './theme.js';

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
// 四力滑杆 (Code-review 2026-08-29): gravity / nodeRepulsion /
// edgeElasticity / idealEdgeLength. main 持有状态并写 localStorage;`input`
// 只刷新读数,松手 (`change`) 才重排 —— 重排永远从当前位置出发、仅由用户
// 主动触发,可玩性不破坏布局稳定性。
// ---------------------------------------------------------------------------

const TUNING_KEYS = ['gravity', 'nodeRepulsion', 'edgeElasticity', 'idealEdgeLength'] as const;

const tuneControls = new Map<(typeof TUNING_KEYS)[number], { input: HTMLInputElement; out: HTMLOutputElement }>();
for (const key of TUNING_KEYS) {
  const input = document.getElementById(`tune-${key}`) as HTMLInputElement | null;
  const out = document.getElementById(`tune-${key}-val`) as HTMLOutputElement | null;
  if (input === null || out === null) continue;
  const range = TUNING_RANGES[key];
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  tuneControls.set(key, { input, out });
}

function storedTuning(): LayoutTuning {
  try {
    const raw = localStorage.getItem(CHROME.layoutTuningStorageKey);
    return raw === null ? defaultLayoutTuning() : clampTuning(JSON.parse(raw));
  } catch {
    return defaultLayoutTuning();
  }
}

function formatTuningValue(key: (typeof TUNING_KEYS)[number], value: number): string {
  // 整数量纲(斥力/边长)显示整数,0–1 量纲(引力/弹性)固定两位小数。
  return key === 'nodeRepulsion' || key === 'idealEdgeLength' ? String(Math.round(value)) : value.toFixed(2);
}

function reflectTuning(t: LayoutTuning): void {
  for (const [key, { input, out }] of tuneControls) {
    input.value = String(t[key]);
    out.textContent = formatTuningValue(key, t[key]);
  }
}

let tuning = storedTuning();
reflectTuning(tuning);
// Boot-time restore (empty graph → applyLayout 早退,等 snapshot 到来即生效)。
view.setLayoutTuning(tuning);

for (const [key, { input, out }] of tuneControls) {
  input.addEventListener('input', () => {
    out.textContent = formatTuningValue(key, Number(input.value));
  });
  input.addEventListener('change', () => {
    tuning = { ...tuning, [key]: Number(input.value) };
    reflectTuning(tuning);
    view.setLayoutTuning(tuning);
    try {
      localStorage.setItem(CHROME.layoutTuningStorageKey, JSON.stringify(tuning));
    } catch {
      /* private mode: 滑杆值只在内存存活 */
    }
  });
}

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
