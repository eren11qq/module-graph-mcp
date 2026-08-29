import './styles.css';
import type { GraphDelta, GraphSnapshot, ModuleNode, TestState } from '../shared/types.js';
import { createDetailPanel } from './detail-panel.js';
import { worstReviewVerdict } from './ai-review.js';
import { isGraphDelta, isGraphSnapshot, isModuleNode } from './frame-guards.js';
import { createGraphView } from './graph-view.js';
import type { SourceLoader } from './code-view.js';
import { createGraphModel } from './graph-model.js';
import { createStatusbar } from './statusbar.js';
import { CHROME, reviewColor, shortLabel, setTheme as setActiveTheme, type ThemeKey } from './theme.js';
import { STATE_ORDER, stateColor, stateLabel } from './test-states.js';

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
let focusedId: string | null = null;

const detailPanel = createDetailPanel(detailContainer, loadSource);

/** Ticket 09: restricted source fetch for the detail panel's code view. */
async function loadSource(path: string): Promise<{ content: string }> {
  const res = await fetch(`/api/source?path=${encodeURIComponent(path)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { content: string };
  return { content: body.content };
}

function showDetail(node: ModuleNode): void {
  const { incoming, outgoing } = model.neighbors(node.id);
  detailPanel.show(node, {
    incoming,
    outgoing,
    onJump: (id) => view.focusNode(id)
  });
}

const view = createGraphView(cyContainer, {
  tooltipEl,
  physics: true,
  onFocusChange: (node) => {
    focusedId = node?.id ?? null;
    if (node) showDetail(node);
    else detailPanel.clear();
  }
});

// ---------------------------------------------------------------------------
// Statusbar: counts / coverage band / event ticker (the shell's signature row)
// ---------------------------------------------------------------------------

const statusbar = createStatusbar({
  sbLeft: document.getElementById('sb-left') as HTMLElement,
  band: document.getElementById('band') as HTMLElement,
  bandCap: document.getElementById('band-cap') as HTMLElement,
  evt: document.getElementById('evt') as HTMLElement
});

function stateCounts(): Record<TestState, number> {
  const counts: Record<TestState, number> = {
    passing: 0,
    failing: 0,
    'has-tests-unrun': 0,
    untested: 0
  };
  for (const n of model.nodes()) counts[n.testState]++;
  return counts;
}

function refreshStatus(rootPath: string): void {
  statusbar.setCounts(model.nodes().length, model.edges().length, view.cycleCount(), rootPath);
  statusbar.setBand(stateCounts());
}

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
  renderLegend();
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
// Legend — the state vocabulary's display surface AND a filter: click a row
// to hide/show that state (theme.html FILTER_OFF), persisting through the
// view pipeline as hiddenStates.
// ---------------------------------------------------------------------------

const hiddenStates = new Set<TestState>();
// Code-review 2026-08-29 评审环图例行: 点击隐藏/显示已评审节点（同图例过滤交互）。
let hideReviewed = false;

function renderLegend(): void {
  legendEl.replaceChildren();
  for (const state of STATE_ORDER) {
    const row = document.createElement('div');
    row.className = 'legend-row' + (hiddenStates.has(state) ? ' off' : '');
    row.dataset.state = state;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;

    const swatch = document.createElement('span');
    swatch.className = 'dot';
    swatch.style.background = stateColor(state);
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = stateLabel(state);
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = String(stateCounts()[state]);

    const toggle = (): void => {
      if (hiddenStates.has(state)) hiddenStates.delete(state);
      else hiddenStates.add(state);
      setViewState({ hiddenStates: new Set(hiddenStates) });
      renderLegend();
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        toggle();
      }
    });
    row.append(swatch, label, cnt);
    legendEl.append(row);
  }

  const edgeRow = document.createElement('div');
  edgeRow.className = 'legend-row edge-row';
  edgeRow.style.marginTop = '8px';
  const line = document.createElement('span');
  line.className = 'legend-line';
  const edgeLabel = document.createElement('span');
  edgeLabel.textContent = '依赖边（箭头 = 依赖方向）';
  edgeRow.append(line, edgeLabel);

  const cycleRow = document.createElement('div');
  cycleRow.className = 'legend-row edge-row';
  const cycleLine = document.createElement('span');
  cycleLine.className = 'legend-line dashed';
  const cycleLabel = document.createElement('span');
  cycleLabel.textContent = '循环依赖';
  cycleRow.append(cycleLine, cycleLabel);

  // 评审环行：三色小样本 + 各档计数，点击隐藏/显示已评审节点。
  const reviewRow = document.createElement('div');
  reviewRow.className = 'legend-row review-row' + (hideReviewed ? ' off' : '');
  reviewRow.setAttribute('role', 'button');
  reviewRow.tabIndex = 0;
  const ringCounts: Record<'confident' | 'unsure' | 'error', number> = { confident: 0, unsure: 0, error: 0 };
  for (const n of model.nodes()) {
    const v = worstReviewVerdict(n.aiReview);
    if (v !== '') ringCounts[v]++;
  }
  for (const verdict of ['confident', 'unsure', 'error'] as const) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = reviewColor(verdict);
    dot.title = `评审环 ${verdict}`;
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = String(ringCounts[verdict]);
    reviewRow.append(dot, cnt);
  }
  const reviewLabel = document.createElement('span');
  reviewLabel.className = 'name';
  reviewLabel.textContent = 'AI 评审环';
  reviewRow.append(reviewLabel);

  const toggleReviewed = (): void => {
    hideReviewed = !hideReviewed;
    setViewState({ hideReviewed });
    renderLegend();
  };
  reviewRow.addEventListener('click', toggleReviewed);
  reviewRow.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      toggleReviewed();
    }
  });

  legendEl.append(reviewRow, edgeRow, cycleRow);
}

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
  refreshStatus(model.rootPath() ?? '…');
}

btnUntestedOnly.addEventListener('click', () => toggleBtn(btnUntestedOnly, (on) => setViewState({ untestedOnly: on })));
btnCollapse.addEventListener('click', () => toggleBtn(btnCollapse, (on) => setViewState({ collapseEnabled: on })));
searchBox.addEventListener('input', () => setViewState({ query: searchBox.value }));

// ---------------------------------------------------------------------------
// Data loading: REST first render, WS listener (snapshot pushes since ticket 04)
// ---------------------------------------------------------------------------

/** 入场编排: shell + graph fade in once, on the very first snapshot only. */
let entrancePlayed = false;
function playEntrance(): void {
  if (entrancePlayed) return;
  entrancePlayed = true;
  document.body.classList.add('enter');
  window.setTimeout(() => document.body.classList.remove('enter'), CHROME.entranceTotalMs);
}

function applySnapshot(snapshot: GraphSnapshot): void {
  model.foldSnapshot(snapshot);
  view.setSnapshot(snapshot);
  refreshStatus(snapshot.rootPath);
  scanNotice.hidden = true;
  statusbar.flashEvent(`快照 ${model.nodes().length} 节点 / ${model.edges().length} 边`);
  renderLegend();
  playEntrance();
}

function applyDelta(delta: GraphDelta): void {
  model.foldDelta(delta);
  view.applyDelta(delta);
  refreshStatus(model.rootPath() ?? '…');
  renderLegend();
  // A successful delta means the view caught up with disk — retire the
  // stale-frame notice (same contract as applySnapshot).
  scanNotice.hidden = true;
  statusbar.flashEvent(`推送 +${delta.addedNodes.length}−${delta.removedNodeIds.length} 节点 · +${delta.addedEdges.length}−${delta.removedEdges.length} 边`);
  // Keep the detail panel honest when the locked node's edges changed.
  if (focusedId !== null) {
    const stillThere = model.node(focusedId);
    if (stillThere) showDetail(stillThere);
    else {
      focusedId = null;
      detailPanel.clear();
    }
  }
}

/** Ticket 08/12: fold one node_update patch into the model and the view. */
function applyNodeUpdate(node: ModuleNode): void {
  model.foldNodeUpdate(node);
  view.applyNodeUpdate(node);
  if (node.aiReview?.status === 'checking') {
    statusbar.flashEvent(`AI 检查 ${shortLabel(node.id)} …`);
  } else if (node.aiReview?.status === 'done') {
    statusbar.flashEvent(`AI 检查完成 · ${shortLabel(node.id)}`);
  } else {
    statusbar.flashEvent(`更新 ${shortLabel(node.id)} · ${stateLabel(node.testState)}`);
  }
  refreshStatus(model.rootPath() ?? '…');
  // Legend counts (incl. the review-ring row) read the model — keep them
  // honest when a patch flips a node's state/review in place.
  renderLegend();
  if (focusedId === node.id) {
    const fresh = model.node(node.id);
    if (fresh) showDetail(fresh);
  }
}

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
    const event = msg as { type?: unknown; snapshot?: unknown; message?: unknown; delta?: unknown; node?: unknown; id?: unknown };
    switch (event.type) {
      case 'snapshot':
        if (isGraphSnapshot(event.snapshot)) applySnapshot(event.snapshot);
        else console.warn('ws: dropped malformed snapshot frame');
        return;
      case 'graph_delta':
        // Missing array fields used to crash mergeDelta (removedEdges.map);
        // a malformed frame is dropped whole, the last good frame stays.
        if (isGraphDelta(event.delta)) applyDelta(event.delta);
        else console.warn('ws: dropped malformed graph_delta frame');
        return;
      case 'node_update':
        if (isModuleNode(event.node)) applyNodeUpdate(event.node);
        else console.warn('ws: dropped malformed node_update frame');
        return;
      case 'scan_error':
        // Light notice: the last good frame stays on screen until a rescan succeeds.
        scanNotice.textContent = `最近一次重扫失败（${String(event.message ?? 'unknown error')}），当前显示上一帧快照；文件恢复后将自动追平。`;
        scanNotice.hidden = false;
        return;
      case 'review_timeout':
        // 服务端强制回落了一个没人收尾的检查——脉冲已由配对的 node_update
        // 停止，这里只在 ticker 里说明原因。
        statusbar.flashEvent(`AI 检查超时回落 · ${shortLabel(String(event.id ?? ''))}`);
        return;
    }
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
    applySnapshot((await res.json()) as GraphSnapshot);
  } catch (err) {
    statusbar.flashEvent(`图数据未就绪（${err instanceof Error ? err.message : String(err)}）`);
  }

  connectWs();
}

void boot();
