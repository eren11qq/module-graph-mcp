# 模块设计（Module Design）

按 codebase-design 词汇撰写：**Module**（模块）、**Interface**（接口：调用方必须知道的一切——类型、不变量、顺序约束、错误模式）、**Implementation**（实现体）、**Seam**（接缝：不改动此处即可改变行为的位置）、**Adapter**（接缝处的具体实现角色）、**Depth**（接口处的杠杆率）、**Leverage**（调用方所得）、**Locality**（维护方所得）。

---

## 1. 系统一句话

一个 Node 进程 = **本地 dashboard**（浏览器小球图，WS 实时推送）+ **stdio MCP server**（agent 查询图与源码）。文件变动 → chokidar 防抖窗口 → 增量重分析 → delta 推帧。

```
                         ┌──────────────────────────────────────────────┐
   磁盘事件 ──► FileWatcher ──► IncrementalGraph ◄──read── HTTP (dashboard)
              (chokidar      (lexer/解析缓存/      ▲            ◄──read── stdio MCP (agent)
                防抖窗口)       .gitignore/原子     │
                               plan phase/          │
                               cached snapshot)     │
                          StatePipeline ────────────┘
                          (coverage 四色 + tsc 红环,
                           原地改节点 → 推 node_update)
                                         │
                               WsHub.broadcast (graph_delta / node_update / scan_error)
```

**shared/types.ts 是全部模块的共同 Interface 语言**：`ModuleNode` / `Edge` / `GraphSnapshot` / `GraphDelta` / `GraphEvent`。两个 transport（WS 帧、MCP JSON-RPC）序列化的都是这份词汇。

---

## 2. 模块清单（按层）

### 服务端

| Module | Interface（调用方必须知道的全部） | Implementation 藏了什么 | 行数 |
|---|---|---|---|
| `IncrementalGraph` | `fullScan()` / `applyEvents(events) → GraphDelta` / `snapshot()`（cached）/ `nodeIds()` / `node(id)`（可变协作入口）/ `setNote(id, note) → bool` | TS scanner 词法管线、specifier 提取与解析缓存、.gitignore 匹配、目录遍历、**原子 plan phase**（I/O 先行，抛错则状态原封不动）、net-delta 计算、**cached snapshot**（结构变化失效；快照与引擎共享节点对象，字段级更新即时可见——别名是写进 Interface 的契约，不是事故） | ~660 |
| `FileWatcher` | `start()` / `stop()` + `onQuiesce(changes)` 回调，`{root, debounceMs, extraWatchFiles}` | chokidar、扩展名/输出目录过滤、save-burst 防抖合并为有序事件窗口 | 119 |
| `startLiveReload` | `→ {ready, stop}`；失败语义：baseline 失败降级为空图且 watcher 照常启动（下一事件自愈）、窗口失败 → `scan_error` 广播 + 保留上一好帧 | **窗口串行化**（windowChain，防止两个 applyEvents 交错腐蚀图）、baseline 顺序与 snapshot 补推、delta→WS 推送、状态层触发时机 | ~125 |
| `StatePipeline` | `refreshCoverage()`（廉价幂等）/ `scheduleTypecheck()`（合并调度）/ `static watchedReportFiles` | coverage 全量重映射、tsc 合并（至多一飞一排队）、变更 diff、降级语义（超时保留旧徽章）、`node_update` 推送 | 156 |
| `CoverageMapper`（coverage.ts） | `refresh(files) → {states, reportMtimeMs, reportFound}`；纯函数：`parseCoverageSummaryJson` / `deriveTestState` / `buildTestTargetIndex` | istanbul json-summary 容错解析、报告 key → 根相对路径归一化、命名约定测试索引、四色判定 | 317 |
| `typecheck.ts` | `runTypecheck(root) → TypecheckResult`（五种状态：`ok/errors/timeout/unavailable/parse-failed`，**从不 throw**）；纯函数 `parseTscOutput` | 子进程 spawn、超时 SIGTERM→SIGKILL 宽限、诊断解析与按文件分组、tsc 探测 | 267 |
| `gitignore` | `parseIgnoreRule(line)` / `loadGitignore(rootAbs)` | 最小 glob（`*` `**` `?`、锚定、目录限定、取反）、last-match-wins、不可读 .gitignore 降级为空规则集 | ~110 |
| `readSourceFile`（source-reader.ts） | `→ SourceReadResult`（ok / denied{status 400/403/404/413/415, reason, detail}），拒绝顺序写死在 Interface | 全部安全策略：null 字节、绝对路径、`..`、扩展名白名单、resolve 逃逸、symlink 逃逸、413、二进制嗅探 | 116 |
| `startHttpServer` + `WsHub` | `→ {url, port, hub}`；`hub.broadcast(event)` / `closeAll()` / `size` | 静态文件 + traversal 守卫、CSP/nosniff、Host 白名单（防 DNS rebinding）、WS Origin 校验（防 CSWSH）、端口被占递增重试、WS 握手快照 | 233 |
| `McpStdioServer` + `buildTools` | `serve()`；`buildTools(graph: GraphSnapshotSource, {broadcast, readSourceFile}) → Record<string, ToolDef>`——`GraphSnapshotSource` 是 tools 需要的最小图接口（engine 结构性满足，测试用字面量 fake），源码读取经注入的 port | 换行分隔 JSON-RPC 2.0、10MB 消息上限、工具分发、**错误结果自解释**（`suggestNodeIds`：猜出 5 个最相近 id） | ~400 |
| `path-conventions` | `SOURCE_EXTENSIONS` / `LANGUAGE_BY_EXTENSION` / `EXCLUDED_DIRECTORIES` | 约定常量单一事实源（曾有四份扩展名副本、三份排除集） | 24 |
| `index.ts` | CLI 参数 + 进程装配 + 关停顺序（stdin 关 → stop watcher → closeAll → exit） | **组合根**——唯一知道所有模块的地方，刻意不深 | 122 |

### 共享

- `shared/types.ts` —— wire 词汇表。它是接口语言，不是独立 deep module；任何模块的 Interface 都由它定义。

### 浏览器端

| Module | Interface | Implementation 藏了什么 | 行数 |
|---|---|---|---|
| `createGraphModel`（graph-model.ts） | `foldSnapshot` / `foldDelta` / `foldNodeUpdate` / `rootPath()` / `nodes()` / `edges()` / `node(id)` / `neighbors(id)`，纯 data-in/data-out | 浏览器端**唯一**的图状态与 fold（snapshot/delta/node_update 三种帧）、邻接查询——main.ts 与 graph-view 的两份副本和两份 fold 已删除 | ~80 |
| `createGraphView`（graph-view.ts） | 8 方法：`setSnapshot` / `applyDelta` / `applyNodeUpdate` / `setLayoutMode` / `setViewState` / `focusNode` / `clearFocus` / `resetView` + `onFocusChange` 回调 | 全部 cytoscape：样式表、度数→球径、hover 邻域高亮、锁球、增量 element 操作；每帧只算一次 backEdges 并喂给 layout（layout 不再自产） | ~540 |
| `applyViewState` + `dirBallDirOf`（graph-filters.ts） | `(nodes, edges, ViewState) → {nodes, edges}`；dir-ball id 解析归此 module，纯 data-in/data-out | 只看未测 → 搜索 → 目录折叠三级管线、状态按严重度聚合、边重接、`dir:` 命名空间 | ~170 |
| `hierarchyLayout` + `findBackEdges` | 纯函数：`LayoutGraphInput + {backEdges?} → positions/backEdges/…`；可消费调用方传入的循环弧 | 层级布局、**循环依赖检测**（红弧唯一来源；传入即消费、不再自产） | ~310 |
| `test-states` | `TEST_STATES`（color/label/severity 一张表）/ `STATE_ORDER` / `stateColor` / `stateLabel` | 四色测试状态词汇单一事实源（调色、标签、图例序、聚合严重度同源） | ~30 |
| `theme` | `THEME` / `diameterOf` / `shortLabel` | 视觉形状常量单一事实源（边、节点半径、fcose 参数、间距）；状态词汇已迁往 test-states | ~85 |
| `createDetailPanel` / `createSourceView` | 工厂 + 注入 `SourceLoader` port；`DetailContext` 由 model 的 `neighbors(id)` 喂养 | 详情面板、语法高亮、错误行标记 | 165+136 |
| `frame-guards` | `isGraphSnapshot` / `isGraphDelta` / `isModuleNode` | 不可信 WS 帧的类型守卫（畸形帧整帧丢弃，保留上一好帧） | 44 |
| `main.ts` | —— | **浏览器组合根**：REST 首渲染、WS 客户端、帧 → GraphModel → view 的分发、断线 3s 重连（无自有图状态） | ~290 |

---

## 3. Seam 清单

判断标准：**一个 Adapter 是假设的 seam，两个 Adapter 才是真实的 seam。**

| Seam | 位置 | 两侧 Adapter | 判定 |
|---|---|---|---|
| wire 词汇 | `shared/types.ts` + `GraphEvent` | WS/REST（浏览器）、stdio JSON-RPC（agent）——两个生产 Adapter | **真实** |
| 文件系统现实 | `FileWatcher.onQuiesce` | chokidar（生产）、测试直灌事件（live-reload.test） | **真实** |
| 图引擎 | `IncrementalGraph`（`opts.graph` 注入） | 真实引擎、测试注入 | **真实** |
| 类型检查源 | `runTypecheckFn` 注入（StatePipeline/live-reload） | 真 tsc 子进程（真外部依赖，DEEPENING 分类 4）、测试假 run | **真实** |
| 安全信封 | `readSourceFile` | HTTP `/api/source`、MCP `get_module_details`——两个生产 Adapter 强制同一策略 | **真实**（教科书式） |
| 源码读取（web） | `SourceLoader` port | main.ts 的 fetch、测试 mock | **真实** |
| 广播 fan-out | `WsHub.broadcast`（`McpToolDeps.broadcast` 同型） | live-reload、StatePipeline、mcp 三处生产调用 | **真实** |
| 图快照源 | `GraphSnapshotSource`（mcp.ts 定义的 tools 最小图接口） | IncrementalGraph（生产）、测试字面量 fake（mcp-tools 直测） | **真实** |
| 源码读取注入面 | `McpToolDeps.readSourceFile` | 真实安全信封（生产，默认值）、测试注入假信封 | **真实** |

**内部 seam**（私有于实现、供自身测试，符合 seam discipline）：coverage.ts 的纯解析函数、graph-filters.ts 的 `applyViewState`、hierarchy-layout.ts、frame-guards.ts——全部 no-DOM/no-cytoscape，data-in/data-out。

---

## 4. Depth 评估

**深**（小 Interface，大量行为）：

- `IncrementalGraph`：6 个方法背后是 ~660 行——词法、缓存、原子性、delta、cached snapshot。deletion test：删掉它，事件→delta 的全部复杂度在 live-reload 里重现。全仓库最深。
- `createGraphModel`：9 个方法背后是浏览器端唯一的图状态；三种帧的 fold 与邻接查询集中一处，data-in/data-out 直测。删除它，两份副本与漂移风险立即重现。
- `typecheck`：1 个函数背后是 267 行进程管理 + 解析 + 五种降级模式，Interface 上"从不 throw"是关键错误模式契约。
- `readSourceFile`：1 个函数背后是整套安全策略；Interface 把拒绝顺序（400→403→404→413→415）写成契约。
- `hierarchyLayout`：1 个函数产出整个层级布局；循环弧可由调用方喂入，同帧唯一来源。
- `CoverageMapper`：1 个 `refresh` 背后是容错解析 + 路径归一化 + 命名约定索引。

**中**：`FileWatcher`（4 项配置 + 2 方法换掉整个 chokidar 世界）、`StatePipeline`、`http`、`mcp`。`createGraphView` 收窄到 8 方法后仍隐藏全部 cytoscape 渲染管线——Leverage 极高。

**非模块**：`index.ts` / `main.ts` 是组合根，刻意 shallow；`theme` / `test-states` / `path-conventions` 是单一事实源常量（删除即出现重复副本）。

> 勘误史：本节曾评 `GraphStore`「浅但便宜，保留」。2026-08-28 架构评审以别名证据推翻该结论（快照与引擎共享活节点对象，所谓 mutation contract 结构性为假，`report_note` 依赖该隐式别名），已删除并把 cached snapshot 收进引擎。

---

## 5. 设计债与 deepening 机会（2026-08-28 评审后全部落地）

### 1. 双引擎已收敛

~~analyzer.ts 与 incremental-graph.ts 各持一份逐字复制的词法管线~~ 已删除 `GraphAnalyzer`：gitignore 支持抽为 `src/server/gitignore.ts`（`parseIgnoreRule` / `loadGitignore`），词法与解析收敛为 `IncrementalGraph` 一份实现，`fullScan()` 即其全量重建模式。index.ts 不再预扫描——baseline 由 `startLiveReload` 驱动同一实例完成，启动双扫描消失。顺带修复：baseline 失败不再弄死 watcher（降级为空图 + 下一个文件事件自愈），baseline 完成后向早连的页面补推一帧 `snapshot`。parity 测试改为「窗口驱动 vs 新实例 fullScan」双实例对照。

### 2. GraphStore 已删除，引擎自持 cached snapshot

~~GraphStore 是第二个图容器，mutation contract 被活对象别名穿透~~ 已删除：`IncrementalGraph.snapshot()` 带 cache（仅 fullScan/applyEvents 结构变化失效；快照与引擎共享节点对象，coverage/badge/note 等字段级更新透过共享对象即时可见——别名从隐式事故升级为 Interface 契约）。`setNote` 成为引擎显式入口，`report_note` 不再依赖隐式别名；每次状态更新的全量排序消失（读者触发物化，仅脏时一次）；`sync()` 回调整体删除。

### 3. 浏览器端唯一 graph model

~~一帧 delta 被 main.ts 与 graph-view 各 fold 一次~~ 新建 `src/web/graph-model.ts`：三种帧的唯一 fold + `neighbors(id)` 邻接查询，纯 data-in/data-out（`tests/graph-model.test.ts` 直测）。main.ts 退化为纯分发（无自有图状态），detail-panel 的邻接来自 model——main.ts 里挖边表的代码与第二份快照消失。

### 4. MCP tool seam 成真

`GraphSnapshotSource`（tools 需要的最小图接口）+ `McpToolDeps.readSourceFile` 注入；`tests/mcp-tools.test.ts` 重写为 `buildTools` 直测（fake graph + 注入信封，错误文案按行为断言不锁措辞）；spawn 型断言删除，`mcp-e2e` 成为唯一进程级冒烟。

### 5. 可见图单一所有者 + view 接口收窄

`hierarchyLayout` 接受调用方传入的 `backEdges`（传入即消费、不再自产）；graph-view 每帧只算一次循环弧，渲染样式与 layout 消费同一集合——三条计算路径归一。Interface 12→8：三个单字段 setter 收敛为 `setViewState(patch)`，死方法 `getLayoutMode`/`destroy` 删除；`dir:` id 命名空间的解析移回 graph-filters（`dirBallDirOf`），view 不再认识 filter 内部。TestState 词汇收敛为 `src/web/test-states.ts` 一张表（调色/标签/图例序/严重度同源）。

### 6. 遗留（低优先）

edge key 两种内部格式与 posix 归一六处差异按 YAGNI 缓做——均为纯内部实现、从没跨界，等真实分叉 bug 出现再收敛。

---

## 6. Interface 即测试面（现有测试映射）

| 测试 | 跨越的 Interface |
|---|---|
| `graph-engine.test.ts` | IncrementalGraph 全量重建模式（原 analyzer.test.ts 的 fixture 清单 oracle） |
| `incremental-graph.test.ts` | IncrementalGraph 窗口模式（含 vs 全量重建的 parity 钉子） |
| `live-reload.test.ts` | startLiveReload（注入 graph / runTypecheckFn） |
| `state-pipeline.test.ts` | StatePipeline（假 runTypecheck） |
| `coverage.test.ts` | CoverageMapper + 纯函数内部 seam |
| `typecheck.test.ts` | parseTscOutput / runTypecheck |
| `mcp-tools.test.ts` | buildTools 直测（fake graph source + 注入 readSourceFile；错误文案按行为断言） |
| `mcp-stdio.test.ts` / `mcp-e2e.test.ts` | stdio transport 韧性 / 进程级握手冒烟（唯一 spawn 套件） |
| `http-security.test.ts` / `source-endpoint.test.ts` | startHttpServer / readSourceFile |
| `graph-model.test.ts` | GraphModel 三种帧 fold + 邻接（浏览器唯一图状态） |
| `graph-filters.test.ts` / `graph-view.test.ts` / `web-render.test.ts` / `code-view.test.ts` | web 内部 seam 与 createGraphView |

规则（replace, don't layer）：在模块 Interface 上写行为断言，不在实现内部探状态；引擎删除时其专属测试同删，Interface 测试存活于内部重构。
