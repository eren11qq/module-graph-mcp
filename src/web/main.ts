import './styles.css';
import type { GraphDelta, GraphSnapshot, ModuleNode } from '../shared/types.js';
import { createDetailPanel } from './detail-panel.js';
import { isGraphDelta, isGraphSnapshot, isModuleNode } from './frame-guards.js';
import { createGraphView } from './graph-view.js';
import type { SourceLoader } from './code-view.js';
import { createGraphModel } from './graph-model.js';
import { STATE_ORDER, stateColor, stateLabel } from './test-states.js';

// ---------------------------------------------------------------------------
// Section 3 mount points (the only DOM the render path touches)
// ---------------------------------------------------------------------------

const cyContainer = document.getElementById('cy') as HTMLElement;
const tooltipEl = document.getElementById('tooltip') as HTMLElement;
const graphStatus = document.getElementById('graph-status') as HTMLElement;
const detailContainer = document.getElementById('detail-card') as HTMLElement;

// One browser-side graph: every frame folds here, and every consumer
// (status line, detail-panel adjacency) reads through the model.
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
    outgoing,
    incoming,
    onJump: (id) => view.focusNode(id)
  });
}

const view = createGraphView(cyContainer, {
  tooltipEl,
  onFocusChange: (node) => {
    focusedId = node?.id ?? null;
    if (node) showDetail(node);
    else detailPanel.clear();
  }
});

// ---------------------------------------------------------------------------
// Legend — the state vocabulary's single display surface.
// ---------------------------------------------------------------------------

function renderLegend(): void {
  const list = document.getElementById('legend-list');
  if (!list) return;
  for (const state of STATE_ORDER) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = stateColor(state);
    const label = document.createElement('span');
    label.textContent = stateLabel(state);
    row.append(swatch, label);
    list.append(row);
  }

  const edgeRow = document.createElement('div');
  edgeRow.className = 'legend-row';
  const line = document.createElement('span');
  line.className = 'legend-line solid';
  const edgeLabel = document.createElement('span');
  edgeLabel.textContent = '依赖边（箭头 = 依赖方向）';
  edgeRow.append(line, edgeLabel);

  const cycleRow = document.createElement('div');
  cycleRow.className = 'legend-row';
  const cycleLine = document.createElement('span');
  cycleLine.className = 'legend-line';
  const cycleLabel = document.createElement('span');
  cycleLabel.textContent = '循环依赖';
  cycleRow.append(cycleLine, cycleLabel);

  list.append(edgeRow, cycleRow);
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

btnUntestedOnly.addEventListener('click', () => toggleBtn(btnUntestedOnly, (on) => view.setViewState({ untestedOnly: on })));
btnCollapse.addEventListener('click', () => toggleBtn(btnCollapse, (on) => view.setViewState({ collapseEnabled: on })));
searchBox.addEventListener('input', () => view.setViewState({ query: searchBox.value }));

// ---------------------------------------------------------------------------
// Data loading: REST first render, WS listener (snapshot pushes since ticket 04)
// ---------------------------------------------------------------------------

const scanNotice = document.getElementById('scan-notice') as HTMLElement;

function applySnapshot(snapshot: GraphSnapshot): void {
  model.foldSnapshot(snapshot);
  view.setSnapshot(snapshot);
  graphStatus.textContent = `${model.nodes().length} 模块 / ${model.edges().length} 边 · 根 ${snapshot.rootPath}`;
  scanNotice.hidden = true;
}

function applyDelta(delta: GraphDelta): void {
  model.foldDelta(delta);
  view.applyDelta(delta);
  graphStatus.textContent = `${model.nodes().length} 模块 / ${model.edges().length} 边 · 根 ${model.rootPath() ?? '…'}`;
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

function setStatus(message: string): void {
  graphStatus.textContent = message;
}

/** Ticket 08: fold one node_update patch into the model and the view. */
function applyNodeUpdate(node: ModuleNode): void {
  model.foldNodeUpdate(node);
  view.applyNodeUpdate(node);
  if (focusedId === node.id) {
    const fresh = model.node(node.id);
    if (fresh) showDetail(fresh);
  }
}

function connectWs(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.addEventListener('message', (evt) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(evt.data));
    } catch {
      return; // tolerate malformed frames
    }
    if (msg === null || typeof msg !== 'object') return;
    const event = msg as { type?: unknown; snapshot?: unknown; message?: unknown; delta?: unknown; node?: unknown };
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
    }
  });
  ws.addEventListener('close', () => {
    setTimeout(connectWs, 3000);
  });
}

async function boot(): Promise<void> {
  renderLegend();

  const infoEl = document.getElementById('server-info');
  try {
    const res = await fetch('/api/info');
    if (res.ok && infoEl) {
      const info = (await res.json()) as { rootPath: string; version: string };
      infoEl.textContent = `${info.rootPath}（v${info.version}）`;
    }
  } catch {
    if (infoEl) infoEl.textContent = '（/api/info 不可用）';
  }

  try {
    const res = await fetch('/api/graph');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applySnapshot((await res.json()) as GraphSnapshot);
  } catch (err) {
    setStatus(`图数据未就绪（${err instanceof Error ? err.message : String(err)}）`);
  }

  connectWs();
}

void boot();
