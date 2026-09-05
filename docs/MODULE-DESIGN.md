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
                               WsHub.broadcast (graph_delta / node_update / scan_error / review_timeout / module_activity)
```

**shared/types.ts 是全部模块的共同 Interface 语言**：`ModuleNode` / `Edge` / `GraphSnapshot` / `GraphDelta` / `GraphEvent`。两个 transport（WS 帧、MCP JSON-RPC）序列化的都是这份词汇。

---

## 2. 模块清单（按层）

### 服务端

| Module | Interface（调用方必须知道的全部） | Implementation 藏了什么 | 行数 |
|---|---|---|---|
| `IncrementalGraph` | `fullScan()` / `applyEvents(events) → GraphDelta` / `snapshot()`（cached）/ `nodeIds()` / `node(id)`（可变协作入口）/ `setNote(id, note) → bool` / `setReview(id, review) → bool`（ticket 12）/ `toRelId(path) → string \| null`（GitNexus 移植：watcher 路径 → 图 id 词表，出根为 null） | TS scanner 词法管线、specifier 提取与解析缓存、.gitignore 匹配、目录遍历、**原子 plan phase**（I/O 先行，抛错则状态原封不动）、net-delta 计算、**cached snapshot**（结构变化失效；快照与引擎共享节点对象，字段级更新即时可见——别名是写进 Interface 的契约，不是事故） | 647 |
| `FileWatcher` | `start()` / `stop()` + `onQuiesce(changes)` 回调，`{root, debounceMs, extraWatchFiles}` | chokidar、扩展名/输出目录过滤、save-burst 防抖合并为有序事件窗口 | 119 |
| `startLiveReload` | `→ {ready, stop, reportTestRun(failed), recentChanges}`；opts 可注入 `reviewStore`（常驻：fullScan 后 attach done 评审再广播 baseline 快照；unlink 窗口剪掉对应条目）；失败语义：baseline 失败降级为空图且 watcher 照常启动（下一事件自愈）、窗口失败 → `scan_error` 广播 + 保留上一好帧 | **窗口串行化**（windowChain，防止两个 applyEvents 交错腐蚀图）、baseline 顺序与 snapshot 补推、delta→WS 推送、状态层触发时机、测试结果上报转发、**recent-changes 记录**（GitNexus 移植：applyEvents 后按原始事件路径 `toRelId` 记录——空 delta 的纯内容修改也记，可注入） | 155 |
| `StatePipeline` | `refreshCoverage()`（廉价幂等）/ `scheduleTypecheck()`（合并调度）/ `reportTestRun(failed)`（置位后立即重映射）/ `static watchedReportFiles` | coverage 全量重映射、tsc 合并（至多一飞一排队）、变更 diff、降级语义（超时保留旧徽章）、`node_update` 推送 | 164 |
| `CoverageMapper`（coverage.ts） | `refresh(files) → {states, reportMtimeMs, reportFound}`；纯函数：`parseCoverageSummaryJson` / `deriveTestState` / `buildTestTargetIndex` | istanbul json-summary 容错解析、报告 key → 根相对路径归一化、命名约定测试索引、四色判定 | 317 |
| `typecheck.ts` | `runTypecheck(root) → TypecheckResult`（五种状态：`ok/errors/timeout/unavailable/parse-failed`，**从不 throw**）；纯函数 `parseTscOutput` | 子进程 spawn、超时 SIGTERM→SIGKILL 宽限、诊断解析与按文件分组、tsc 探测 | 267 |
| `gitignore` | `parseIgnoreRule(line)` / `loadGitignore(rootAbs)` | 最小 glob（`*` `**` `?`、锚定、目录限定、取反）、last-match-wins、不可读 .gitignore 降级为空规则集 | ~110 |
| `readSourceFile`（source-reader.ts） | `→ SourceReadResult`（ok{content, truncated} / denied{status 400/403/404/415, reason, detail}），拒绝顺序写死在 Interface | 全部安全策略：null 字节、绝对路径、`..`、扩展名白名单、resolve 逃逸、symlink 逃逸、二进制嗅探；超限不再 413，按字节截断（`utf8HeadEnd` 修复到 UTF-8 序列边界，truncated 标记 + sizeBytes 保真） | 152 |
| `startHttpServer` + `WsHub` | `→ {url, port, hub}`；`hub.broadcast(event)` / `closeAll()` / `size`；`POST /internal/broadcast`（跨实例转发入口，事件白名单 + 仅回环 + Origin 白名单）；`GET /api/report`（验收报告页，`?focus=<module-id>` 服务端高亮锚点）；HTML 入口（`/` / `/index.html` / `/api/report`）缺 token 或旧 token → 302 补发当前 token（token 自愈，裸地址直接可用；`/api/*` 数据面与 `/ws` 无 token 仍 401） | 静态文件 + traversal 守卫、CSP/nosniff、Host 白名单（防 DNS rebinding）、WS/broadcast Origin 校验（防 CSWSH/跨站伪造 POST）、端口被占递增重试、WS 握手快照、/api/source 截断透传、`isForwardableEvent` 校验（白名单派生自 `FORWARDABILITY` 穷尽映射——候选 #7：每个 `GraphEvent` 变体必须表态 fwd/hold，新变体漏登记 = 编译红；snapshot/graph_delta 刻意 hold——每实例自己监听文件树，转发 delta 会双重闪烁）、/api/report 服务端拼装独立 HTML（复用 `buildHealthReport` 纯函数 + `renderReportPage` 转义拼装，无构建步骤无脚本，天然不进 relay 面） | 563 |
| `McpStdioServer` + `buildTools` | `serve()`；14 工具：`get_dashboard_info` / `get_module_graph` / `get_module_details` / `get_impact` / `get_change_impact` / `list_untested` / `get_health_report` / `report_note` / `begin_review` / `update_review` / `end_review` / `report_test_run` / `declare_edit_scope` / `report_edits`（ADR 0002 §7.2 改动核对工具对）；`buildTools(graph: GraphSnapshotSource, {broadcast, readSourceFile, reportTestRun, httpInfo, onFileActivity, isBaselineDone, recentChanges, defaultMaxTokens, readOnly, reviewStore}) → Record<string, ToolDef>`——`GraphSnapshotSource` 是 tools 需要的最小图接口（engine 结构性满足，测试用字面量 fake），源码读取经注入的 port | 换行分隔 JSON-RPC 2.0、10MB 消息上限、工具分发、**错误结果自解释**（`suggestNodeIds`：猜出 5 个最相近 id）、AI 评审三工具经 `ReviewLifecycle` 委派（工具体只剩参数校验 + reply 整形，回复字节级不变）、`begin_review` 响应内嵌评审 playbook（`REVIEW_PLAYBOOK` 稳定文本节，关键节被 playbook-present 探针逐字断言，信任闭环 PR-5；预算数字从 review-lifecycle 常量插值、`report_note` 上限 `MAX_NOTE_LENGTH` 单点，探针按常量断言防回硬码（候选 #10，2026-09-05））、**基线闸门**（名单派生自 `ToolDef.contentDependent` 必填 bit——候选 #7，2026-09-05：内容依赖型工具有界等基线，自述型工具即时应答带 scanning 注记；构造仅调一次 buildTools，可见集是全量注册表的投影，会话状态单例）、**响应预算**（`withinBudget`：per-call `_maxTokens` > deps 默认，非法静默忽略 + stderr 记行，截断经 response-budget）、**只读分权**（`readOnly` 时 `mutating` 标志工具经 `hideMutatingTools` 整层隐藏、tools/call 查全量注册表标志返回专属审计错误——手抄名单 `READ_ONLY_BLOCKED_TOOLS` 已随候选 #7 退役，名单即派生品）；**改动核对**（ADR 0002 §7.2：`declare_edit_scope` 会话级范围存 buildTools 闭包、`report_edits` 用 `edit-scope.ts` 纯函数对上报 ∪ watcher 磁盘事实交叉核对，越界/漏报判红，广播 `edit_scope` / `edit_verification` 事件）；`get_dashboard_info` 附带模块表（模块→文件清单，单一事实源）；`get_module_details` 每次读取广播 `module_activity`（探索可见，2026-08-29）；**工具体仪式共享件**（候选 #1，2026-09-03：`errorResult` / `readStringArray` / `VERDICTS_ARRAY_ERROR` 单一来源，路径卫生收编进 `path-conventions.normalizeFilePath`，展开截断统一 `EDIT_SCOPE_EXPAND_CAP`）；变更证据链打分委派 `impact.scoreChanges`（候选 #6） | 1164 |
| `ReviewLifecycle`（review-lifecycle.ts） | `begin(id, path)` / `update(id, path, rawVerdicts) → outcome` / `end(id, rawVerdicts, rawSummary)`——typed outcome，不认识 MCP 回复格式；`AI_VERDICTS` / `REVIEW_CHECKING_TIMEOUT_MS` / `normalizeVerdicts` / 预算常数 `MAX_VERDICT_ENTRIES·MAX_VERDICT_MESSAGE·MAX_REVIEW_SUMMARY` 是它导出的接口词汇（清洗器与数字的唯一真源，候选 #2/#10） | begin/end 配对纪律、checking 超时回落（身份令牌 + update 重挂——update 换新 checking 对象会静默解除旧定时器，故每次重绑）、verdict 清洗与分批合并（每行最后一条 / 500 上限 / 200·500 截断）、`node_update` → `review_timeout` 广播顺序——四条曾以注释散在工具体、定时器闭包、引擎别名与 dashboard 假设里的不变量收拢为私有实现（2026-08-29 架构评审候选 #1）；持久化不在此层——end_review 工具体把 done 结论交给 review-store | 176 |
| `createReviewStore`（review-store.ts） | `createReviewStore({rootPath, log}) → {attachInto(graph) → number, set(id, review \| undefined), remove(ids)}`；`ReviewGraph` = `{node(id), setReview(id, review)}`（IncrementalGraph 结构性满足） | **评审常驻**（2026-09-01）：done 结论持久化到 `<root>/.module-graph/reviews.json`（schema `{version:1, reviews}`）；load 只认 done（checking 瞬态不复活）、剪掉已不存在文件的条目；写前重读磁盘合并（并发会话并集、同 key 后写覆盖、本地墓碑集合防删除意图被残留复活）；fs 仪式（原子写、坏文件降级、告警一次、gitignore 自举）委托落盘卫生层——本模块只剩 done-only 判定、委托清洗与墓碑合并（候选 #1，2026-09-05）；verdict 解码委托 `review-lifecycle.normalizeVerdicts`，磁盘复活与 end_review 活路径恒等（行排序/每行最后一条/同一批上限），第二清洗器分叉已删（候选 #2，2026-09-05） | 198 |
| `buildHealthReport` / `findCycleNodeIds`（health-report.ts） | 纯函数：`findCycleNodeIds(edges) → Set<id>`（多起点 DFS，指向 on-stack 祖先的弧封闭环，环上节点全标记）、`computeHighCentralityIds(snap) → Set<id>`（top-20% rank 截断，与 impact.ts 共享）、`buildHealthReport(snap) → HealthReport`（固定整数权重表 + 同分 id 字典序 + 中文简报 top 5 + 剩余计数）；`HEALTH_FLAG_LABELS` 是简报与报告页共用的展示词汇 | **信任闭环的确定性打分**（信任闭环路线图 PR-3）：高中心度=入度+出度排序前 20%（rank 截断，非度数阈值）、环检测为 back-edges.ts 的服务端移植（接口换 `Edge[]`、问句从"哪些弧"换成"哪些节点在环上"）；同输入同输出逐字节稳定，evals 探针断言精确排序 | 199 |
| `computeImpact` / `computeGraphStats`（impact.ts） | 纯函数：`computeImpact(snap, startId, {direction?, maxDepth?}) → ImpactResult`（upstream=反向边 / downstream=正向边 / both 取最小深度；visited 防环收敛；未知 start → 结构化 miss；按深度升序、同深度 id 字典序；`DEFAULT_IMPACT_DEPTH=3` / `MAX_IMPACT_DEPTH=10`）、`computeGraphStats(snap) → GraphStats`（`{inDegree, outDegree, inCycle, highCentrality, centrality(id)}`，centrality=(in+out)/(2·(n−1))）、`createGraphStats(getSnap)`（按 generatedAt 记忆化的访问器工厂，每图一份）；`IMPACT_DIRECTIONS` 是校验与 schema 共用的词表 | **爆炸半径与风险启发式的图数学**（GitNexus 移植步骤 1）：BFS 邻接表每调用重建（仓库规模毫秒级）、环与高中心度直接复用 health-report 的两个导出（零新算法）、get_module_details 的 `context` 信封与 get_change_impact 的风险判定都吃 `GraphStats`；派生统计只进响应信封、绝不挂 ModuleNode（活共享对象会陈旧）；**变更证据链打分**（候选 #6，2026-09-03）：`scoreChanges(snap, recorded, stats) → {changes, impacts, overallRisk}` 纯函数 + `CHANGE_IMPACT_HEURISTICS` 唯一文本来源——风险判定（`assessChangeRisk`：在环/高中心度→high、受影响>10→medium）与图数学同居，get_change_impact 工具体只剩解析 + 整形 | 264 |
| `verifyEdits` / `normalizeFilePath` / `createEditScopeStore`（edit-scope.ts） | 纯函数：`verifyEdits(scope, reported, watcherRecorded: (string \| WatcherFact)[]) → {scopeDeclared, declaredModules, declaredFiles, outOfScope[], unreported[], preexisting[], ok}`（watcher 证据先按 `scope.declaredAt` 基线过滤：更早 → preexisting 不判；越界 = (上报 ∪ 代内 watcher) ∖ 范围，来源标签去重 reported 优先；漏报 = 代内 watcher 见而上报无；裸 string 无时间 → 永不豁免）；`normalizeFilePath`（反斜杠/`./`/空白卫生；候选 #1 起实现住 `path-conventions.ts`，此处再导出）；`createEditScopeStore`（会话级，declare 覆盖并盖 `declaredAt = Date.now()`、空声明清除） | **改动核对判定**（ADR 0002 §7.2 + ticket 13 scope epoch）：判定靠模块表 + watcher 磁盘事实，不靠 AI 自觉；基线前的历史残留（上一会话）不再错判成本代越界/漏报；`isInScope` 是工具与纯函数共用的范围判定；store 挂 buildTools 闭包，重启即清 | 142 |
| `createRecentChanges`（recent-changes.ts） | `createRecentChanges({rootPath?, log?}) → {record(paths), list() → RecentChange[], clear()}`；`RECENT_CHANGES_CAP=100`（最新写入优先，超限逐出最旧；重记录刷新时间戳与逐出序）；`list()` 最新在前、同毫秒按 id 字典序；给 rootPath → 落盘 `<root>/.module-graph/recent-changes.json`（schema `{version:1, changes}`，写前重读磁盘并集合并同根兄弟会话，启动回灌截到容量，clear() 同步清空磁盘）；fs 仪式委托落盘卫生层——clear() 曾是指南针目录里唯一的非原子写手，现与 persist 同路（候选 #1，2026-09-05） | **变更证据链的有界记录**（GitNexus 移植步骤 3 + ticket 13 修法 B）：Map 插入序=逐出序（delete+set 技巧，逐出 O(1)）；重启灭失 → 已修（落盘回灌堵住 report_edits 假绿路径），残余缺口=单会话内 >100 连改时最旧记录滑出核对窗口（容量语义不变，注释里明说）；null/空路径静默跳过；喂它的是 live-reload 的原始事件路径（空 delta 也记）；不给 rootPath → 纯内存（测试与裸管线） | 174 |
| `createDotModuleStore`（dot-module-store.ts） | `createDotModuleStore({rootPath, fileName, version, log?}) → {loadRaw() → ok{body} \| empty{missing/corrupt/version}, saveRaw(body) → ok \| {ok:false, err}, warn(msg)〔闩〕}`；导出 `DOT_MODULE_DIR` 目录名单一事实源（run.ts 的 fixture 清理 import 它） | **落盘卫生层**（候选 #1，2026-09-05，CONTEXT.md 词条）：`.module-graph/` 下 JSON 状态的统一 fs 仪式——mkdir、自忽略 .gitignore 自举（不覆盖用户已有）、tmp+rename 原子写、坏文件即空、version 信封、warn-once 闩、失败降级不 throw；只管仪式不管语义（解码与合并留消费者）。deletion test：删它，仪式在两消费者逐字重现（收编前正是如此） | 105 |
| `applyTokenBudget`（response-budget.ts） | 纯函数：`estimateTokens(text)`（ceil(utf8 字节/4)）、`applyTokenBudget(text, maxTokens) → {text, truncated, originalTokens}` | **响应预算护栏**（GitNexus 移植步骤 5）：4 字节/token 的计划钉死粗估（零依赖）；截断点 = maxTokens×4 字节减去标记自身字节，UTF-8 续字节回扫到字符边界（中文/emoji 不劈半）；预算太小放不下正文时只返回英文省略标记（含原始估算与收窄指引）——护栏文本永远优先，截断后 JSON 可能不完整是接受过的代价 | 50 |
| `renderReportPage`（report-page.ts） | 纯函数：`renderReportPage(report, focus | null) → HTML 字符串`——无构建步骤、无脚本、无新依赖 | **/api/report 验收报告页**（信任闭环路线图 PR-4）：health-report 排序的 HTML 投影；`?focus=` 深链由服务端算好高亮类（`report-focus`），文件系统来源的 id/rootPath 全量 HTML 转义；CSP 与 dashboard 同一份常量 | 84 |
| `evals`（src/evals/） | `run.ts` CLI（逐任务**冷启动 spawn** dist/server/index.js，不变量断言先行 + maxMs/maxBytes 硬门槛，p50/p95 两列照记）；`tasks/registry.ts` 注册表 ⇄ 磁盘双向对账；`EvalTask { id, description, probe(client, fixture), maxMs, maxBytes, spawnEnv? }`（spawnEnv 按任务注额外 env，如 read-only-mode 的 READ_ONLY=1） | **信任做成可执行资产**（信任闭环路线图 PR-2）：`mcp-client.ts` 是**唯一的 cold-start stdio client**（换行分帧 + 按 id 关联 + stderr 观察；MODULE_GRAPH_NO_OPEN=1 强制无头；`spawnClient` 支持注额外 env 与钉端口，暴露 `request`/`stderr`/`waitUntilStderr`）——候选 #3（2026-09-03）起 cross-session / review-persistence e2e 与 evals 共用这一份，`getFreePort` 实现也住这里（tests/helpers/net.ts 再导出）；**字节自计量**（第二轮候选 #3，2026-09-05）：`bytesSeen()` 计所有进过 stdout 的字节（initialize / listTools / 重试回复全入账，`ToolCallOutcome.bytes` 与 `ProbeResult` 删除、probe 签名收为 `Promise<void>`），非 stdio 流量经 `countExternal` 入同一本账，run.ts 从 client 读数——maxBytes 从「探针记得加」的 convention 变成结构，dashboard-info / read-only 两预算按诚实读数重校（1500→3000 / 4000→8000，红线收紧非放松：旧数漏计、新数=全量）；maxBytes 是 CI 红线契约（ADR 0001）；目录守卫 tests/evals-structure.test.ts 钉死结构（游离文件 / 幽灵条目都红） | 1134 |
| `path-conventions` | `SOURCE_EXTENSIONS` / `LANGUAGE_BY_EXTENSION` / `EXCLUDED_DIRECTORIES` | 约定常量单一事实源（曾有四份扩展名副本、三份排除集） | 22 |
| `index.ts` | CLI 参数（缺 `--root` 回退 cwd；`--open` / `--no-open`）+ 进程装配 + 关停顺序（stdin 关 → stop watcher → closeAll → exit） | **组合根**——唯一知道所有模块的地方，刻意不深；MCP 传输先于基线扫描启动（插件模式握手不能等扫描），基线状态经 `isBaselineDone` deps 供给闸门与 scanning 注记；**弹窗策略**（文件粒度；启动绝不弹页，只 armed：agent 经面向文件工具（`get_module_details` / `report_note` / `begin_review` / `update_review` / `end_review`，mcp.ts `onFileActivity`）打开某文件、或同根 relay 事件指名该文件（http.ts `onRelayAccepted`）时 `openBrowser`，每文件至多一次（`poppedFiles` 集合去重），无文件工具与未打开文件绝不触发；**同仓库去重走端口带扫描** `findSameRootInstance`：bumped 实例从首选端口起逐个探测 `/api/info`（跳过自身端口、单探测 800ms / 总量 3s 有界），扫到同根即无头并经 `makeForwarder` 把工具事件 POST 到主实例 `/internal/broadcast`，`httpInfo` 为无头实例返回主实例 URL；抢到首选端口者恒为主实例、不做扫描也不降级（否则同根双启动会同归于静）；`shouldAutoOpen` 只是 armed 纯决策；**护栏 env 响亮校验**（GitNexus 移植：`parseGuardrailEnv` 解析 `MODULE_GRAPH_MCP_READ_ONLY`（unset/0 关、1 开、其他值 fail 退出）与 `MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS`（正整数否则 fail），连同 live-reload 的 `recentChanges` 一起注入 MCP deps） | 312 |

### 共享

- `shared/types.ts` —— wire 词汇表。它是接口语言，不是独立 deep module；任何模块的 Interface 都由它定义。
- `module-table.ts` —— **功能模块表**（ADR 0002 §7.1 引入；ADR 0003 后仅服务
  `declare_edit_scope` 的 modules 通道展开与 `get_dashboard_info` 清单，无视图投影）：
  六功能类（MCP 服务 / 依赖图引擎 / Dashboard 渲染 / 共享契约 / 信任探针 / 测试与样例），条目 = 目录前缀（尾 `/`，整棵）或显式文件；`moduleIdOf`（首个命中即所属类）/ `modulesOf`（冲突可见）/ `filesInModule` / `moduleMatches` 纯函数；表外文件无类（进范围只能显式点名）；服务端核对器与 `get_dashboard_info` 共用同一份——单一事实源（124 行）

### 浏览器端

| Module | Interface | Implementation 藏了什么 | 行数 |
|---|---|---|---|
| `createGraphModel`（graph-model.ts） | `foldSnapshot` / `foldDelta` / `foldNodeUpdate` / `rootPath()` / `nodes()` / `edges()` / `node(id)` / `neighbors(id)`，纯 data-in/data-out | 浏览器端**唯一**的图状态与 fold（snapshot/delta/node_update 三种帧）、邻接查询——main.ts 与 graph-view 的两份副本和两份 fold 已删除（候选 #5，2026-09-03 起此话完全成真：graph-view 的 currentNodes/currentEdges 第三份副本也删了，view 经 `model` 注入只读原始终态，degrees/regions/hub 集仍是视图派生态）；候选 #4 起三种 fold 的直接调用方只剩 graph-view（frame-sink 不再手折） | 78 |
| `createGraphView`（graph-view.ts） | 14 方法 + **`model` 必注**（候选 #5：view 自持副本已删，原始终态从 model 读；候选 #4，2026-09-05：`applySnapshot` / `applyDelta` / `applyNodeUpdate` = 完整调用——入口先 fold 本帧进注入的 model 再重渲/patch，「先 fold 后 apply」的配对序住进 module，不再是 caller 纪律，setSnapshot 已改名；评审 #5，2026-09-05：单主题，`setTheme` 随切换钮删除）：`applySnapshot` / `applyDelta` / `applyNodeUpdate` / `pulseViewing`（2026-08-29：module_activity 的瞬态查看脉冲，按 id 自到期）/ `setViewState`（只看未测 / 搜索 / 图例 / 隐藏已评审）/ `setEditScope` / `setEditVerification`（ADR 0002 §7.2：范围与核对结果落地，新范围=新基线清标记）/ `focusNode` / `clearFocus` / `resetView` / `cycleCount` + `onFocusChange` 回调 | 全部 cytoscape：主题化样式表（状态填充 / type-error 环 / checking 亮边 / viewing 紫边+紫 overlay（声明序在 checking 之前：评审赢）/ AI 评审环 border（实测 underlay 渲染圆角方形，改 border 且声明序在 type-error 之后：评审赢、type-error 让位、聚焦仍最赢）——五条独立视觉通道 + ADR 0002 §7.2 三条改动标记通道（`in-scope` 常驻紫环声明在评审环之后 / `edited` 紫填充 / `out-of-scope` 红⛔标 + tooltip 文案 + 状态栏警示条））、度数→球径（tests 带缩 0.85）、hover 邻域高亮（调暗扫描排除板块）、锁球、增量 element 操作；每帧只算一次循环弧（back-edges.ts）供红弧样式与 statusbar 计数消费；**单一文件海报视图**（ADR 0003：模块视图中断后不再分叉，增量 DOM 路径只在无过滤时走，`filtersActive()` 一律全量重渲）；布局唯一 fcose + 区域化后处理——两条海报通道的**求解序各自住进通道模块**（候选 #4，2026-09-03：`layout-cluster.solveClusterPoster` / `graph-areas.solveRegionsPoster`），applyLayout 只剩「清板 → solveX(cy) → rebase → persist →（区域才）syncPlates」编排壳，「分离先于 rebase/persist」（ADR 0004 D3）成为通道内部约束；存档按 rootPath 单档（layout-store v6，ADR 0003） | 1045 |
| `applyViewState` + `searchMatches` / `isUntested` / `deriveScopeMarks`（graph-filters.ts） | `(nodes, edges, ViewState) → {nodes, edges}`，纯 data-in/data-out | 图例状态过滤 → 只看未测 → 隐藏已评审 → 搜索管线；目录折叠已随 ADR 0002 退役（§7.1）、`focusedModule` 聚焦分支已随 ADR 0003 退役，`dir:` 命名空间删除；`deriveScopeMarks`（ADR 0002 §7.2 标记派生，原 module-view.ts 的唯一保留面，2026-09-01 搬家至此）：范围环（声明模块 ∪ 显式文件）/ 已改紫 / 越界红角标三条独立 class 通道判定 | 129 |
| `findBackEdges`（back-edges.ts） | 纯函数：`LayoutGraphInput → Set<linkId>`（多起点 DFS，指向 on-stack 祖先的弧即回边） | **循环依赖检测**（红弧与 statusbar 循环计数的唯一来源）；原 `hierarchyLayout` 层级布局已按 ticket-00 amendment 裁定删除（fcose 唯一布局），检测逻辑于 2026-08-29 抽出留存 | 96 |
| `assignRegions` / `computeRegionSlots` / `applyRegionLayout` / `syncRegionPlates`（graph-areas.ts） | 纯函数 `assignRegions(nodes, edges) → Map<id, RegionId>`（路径前缀表 + 度 0 兜底）、`computeRegionSlots(bboxes, geo) → Map<RegionId, Slot>`；两个 cy 动词 `applyRegionLayout`（刚性平移各区到罗盘槽位，孤儿坞例外——度 0 无排列可保，按 id 排序收确定性网格）/ `syncRegionPlates`（每非空区一枚 `region-plate` 背景节点，z 底层、events:no、随主题调色）、第三个 cy 动词 `solveRegionsPoster(cy, regions)`（候选 #4：区域通道整解——fcose → 罗盘平移 → 全场分离，序归本模块；几何逐行未动，ADR 0004） | **区域化海报**（2026-08-29 grilling Q1–Q9）：把单张 fcose 云团摆成固定罗盘——web 左 / shared 脊柱居中 / server 右 / tests 底带 / 样例岛右下 / 孤球坞左下；不做布局（fcose 唯一布局裁定不破），只做定位后处理；「fcose→平移→分离→rebase」顺序归 solveRegionsPoster 独占（applyLayout 只管清板/题注与 rebase/persist 交接；rebase 把分离后位置快照为漂移基点，板块与物理状态互不见面） | 400 |
| `solveClusterPoster` / `clustersOfRenderedGraph` / `seedClusterLayout` / `refineClusterBodies` / `anchorClusterTerritories` / `planTerritories` / `assignTestBalls` / `fnv1a`（layout-cluster.ts） | 通道级一口函数 `solveClusterPoster(cy) → Map<id, clusterIdx>`（聚类 → 出生 → 逐簇精修 → 领地归位 → 全场分离 → fit；返回归属供管线测试直接断言），段函数皆可单独 data-in/data-out 直测 | **聚类海报管线**（ADR 0004 + 候选 #4，2026-09-03：序归本模块独占，layout-cluster.test 从此跑生产函数本身，手抄管线删除）：确定性三钉（id 序迭代 / 固定种子决胜 / 整数权重）、测试球不进 Louvain 输入事后多数票挂靠、`clusterFcoseOverrides` 只进② THEME.fcose 一字不动、求解不读存档——同图两次全量重解逐位全等 | 363 |
| `worstReviewVerdict`（ai-review.ts） | `AiReview → '' / confident / unsure / error`（最差 verdict 定环色） | 评审环判定纯函数：仅 done 参与，error > unsure > confident | 26 |
| `test-states` | `TEST_STATES`（label/severity 一张表）/ `STATE_ORDER` / `stateColor` / `stateLabel` | 四色测试状态词汇单一事实源（调色、标签、图例序、聚合严重度同源） | 27 |
| `theme` | `THEME` / `MOTION` / `CHROME` / `CY_PALETTE` / `diameterOf` / `shortLabel` / `reviewColor` | 视觉与动效常量单一事实源（边、节点半径、fcose 参数、单主题色板含 AI 评审环三色——#5 起 light 色板与「当前主题」全局已删，与 styles.css `[data-theme="dark"]` token 由等值钉锁死、viewing 紫与板块 plate 三色、`THEME.layout` 罗盘几何、`THEME.areas` 区域视觉通道——tests 缩放与跨区线细淡）；状态词汇已迁往 test-states | 412 |
| `createPhysics`（physics.ts） | `rebase` / `popNode` / `restorePop` / `destroy` | 入场漂移、释放弹簧、hover 弹出、checking/viewing 双脉冲的 rAF 层（同一 overlay 通道，checking 优先）；`prefers-reduced-motion` 全降级 | 214 |
| `createStatusbar`（statusbar.ts） | `setCounts` / `setBand` / `flashEvent`；`bandWeights` / `passRatePct` 纯函数 | 左计数（节点/边/循环）、中四色覆盖率带、右事件 ticker | 96 |
| `createDetailPanel` / `createSourceView` | 工厂 + 注入 `SourceLoader` port；`DetailContext` 由 model 的 `neighbors(id)` 喂养 | 详情面板（meta 行 AI 检查徽章 + AI 评审三色行）、语法高亮、错误行标记、超限截断提示 | 248+192 |
| `frame-guards` | `isGraphSnapshot` / `isGraphDelta` / `isModuleNode` | 不可信 WS 帧的类型守卫（畸形帧整帧丢弃，保留上一好帧） | 44 |
| `createFrameSink`（frame-sink.ts） | `apply(event: GraphEvent)`（六类帧全吃 + frame-guards 畸形帧整帧丢弃；`module_activity` 为瞬态帧——不 fold、不触发派生刷新，只驱动 viewing 脉冲 + ticker）/ `refreshDerived()`（视图状态与主题变更的非帧派生刷新）/ `setFocus(node)`——deps 注入 model/view/statusbar/legend/detail/scanNotice/`filters()` | **帧编排唯一归属**（2026-08-29 架构评审候选 #2）：view（内部 fold 本帧——候选 #4 fold-then-apply）→ 派生 UI（statusbar 计数 / 覆盖带 / 图例 / 聚焦面板）的固定顺序；曾三份手抄 + `renderLegend` 六调用点（a236598 真 bug）收敛为一处；**microtask 合帧**——N 帧 burst 每批一次派生刷新、状态计数单遍一次、ticker flash 保持同步；聚焦面板诚实性（delta/node_update 跟进、节点移除清空一次）；入场仅首次快照播放 | 287 |
| `createLegend`（legend.ts） | `createLegend(container, {onToggleState, onToggleReviewed}) → {render(counts)}`——counts 含 states/reviews 计数与 hiddenStates/hideReviewed；toggle 经 hooks 上报，不拥有状态 | dumb 渲染：4 状态行 + AI 评审环行（三色计数）+ 依赖边/循环行、off 类、键盘激活——DOM 结构与原 main.ts `renderLegend` 一致 | 108 |
| `main.ts` | —— | **浏览器组合根**：REST 首渲染与 WS 帧共用 `FrameSink.apply` 单一 seam、WS 连接/断线 3s 重连、主题切换、视图控件绑定；过滤旋钮（hiddenStates / hideReviewed）所有权留此，sink 渲染时经 `filters()` 读取。帧编排、图例与入场已迁 `FrameSink` / `legend`（无自有图状态、无帧编排） | 214 |

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
| 落盘卫生 | `createDotModuleStore`（`loadRaw/saveRaw/warn`） | review-store、recent-changes——两个生产 adapter 骑同一仪式 seam；测试真 temp dir（replace-don't-layer：不造内存 fake，仪式的对象就是文件系统） | **真实**（候选 #1，2026-09-05） |
| 跨实例事件转发 | `POST /internal/broadcast`（事件白名单 + 仅回环） | 同根 secondary（转发方，`makeForwarder`）、primary 的 WsHub（接收方） | **真实**（两个进程 Adapter；2026-08-29 多会话一页） |

**内部 seam**（私有于实现、供自身测试，符合 seam discipline）：coverage.ts 的纯解析函数、graph-filters.ts 的 `applyViewState`、back-edges.ts 的 `findBackEdges`、ai-review.ts 的 `worstReviewVerdict`、frame-guards.ts——全部 no-DOM/no-cytoscape，data-in/data-out。

---

## 4. Depth 评估

**深**（小 Interface，大量行为）：

- `IncrementalGraph`：8 个方法背后是 637 行——词法、缓存、原子性、delta、cached snapshot。deletion test：删掉它，事件→delta 的全部复杂度在 live-reload 里重现。全仓库最深。
- `createGraphModel`：9 个方法背后是浏览器端唯一的图状态；三种帧的 fold 与邻接查询集中一处，data-in/data-out 直测。删除它，两份副本与漂移风险立即重现。
- `typecheck`：1 个函数背后是 267 行进程管理 + 解析 + 五种降级模式，Interface 上"从不 throw"是关键错误模式契约。
- `readSourceFile`：1 个函数背后是整套安全策略；Interface 把拒绝顺序（400→403→404→415）与超限截断语义（truncated + UTF-8 边界修复）写成契约。
- `CoverageMapper`：1 个 `refresh` 背后是容错解析 + 路径归一化 + 命名约定索引。
- `ReviewLifecycle`：3 个动词背后是定时器、身份令牌、verdict 清洗与事件顺序；interface 上只见 typed outcome，MCP 回复格式与路径校验都留在 mcp.ts。deletion test：删掉它，四条不变量在三个文件里重现。
- `FrameSink`：3 个方法背后是六类帧的编排、microtask 合帧与畸形帧守卫。deletion test：删掉它，六步手抄在三处重现，a236598 类 bug 无 interface 可钉。
- `createDotModuleStore`：3 个动词背后是 `.module-graph/` 全部 fs 仪式（原子写、gitignore 自举、坏文件即空、version 信封、warn 闩、降级不 throw）；interface 上只见 `loadRaw/saveRaw/warn`，各文件的解码与合并留消费者（候选 #1，2026-09-05）。deletion test：删它，仪式在两消费者逐字重现。
- `graph-areas`：4 个导出背后是区域化全部词汇——成员表、罗盘几何、刚性平移、板块生命周期；两个纯函数即测试面，两个 cy 动词把顺序坑（板块与物理状态互不见面、平移必须赶在 rebase 快照之前）全部吸收。deletion test：删掉它，「位置讲区、尺寸讲枢纽、线型讲区内/跨区」的规矩散落成 graph-view 手工活。

**中**：`FileWatcher`（4 项配置 + 2 方法换掉整个 chokidar 世界）、`StatePipeline`、`http`、`mcp`。`createGraphView` 收窄到 9 方法后仍隐藏全部 cytoscape 渲染管线——Leverage 极高。

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

graph-view 每帧只算一次循环弧（back-edges.ts），渲染样式与 statusbar 计数消费同一集合——计算路径归一（历史：`hierarchyLayout` 曾接受调用方传入 `backEdges`「传入即消费」；2026-08-29 该布局整体删除）。Interface 收窄史：12→8（三个单字段 setter 收敛为 `setViewState(patch)`，死方法 `getLayoutMode`/`destroy` 删除）；现行 14 方法——`cycleCount` 为 ticket-12 循环计数新增（同批的 `setTheme` 随评审 #5 单主题化删除），`setEditScope` / `setEditVerification` 为 ADR 0002 改动标记新增，`resetLayout` / `getLayoutMode` / `setLayoutMode` 为 ADR 0004 排列模式新增；目录折叠随 ADR 0002 退役，`dir:` 命名空间删除。TestState 词汇收敛为 `src/web/test-states.ts` 一张表（调色/标签/图例序/严重度同源）。

### 6. 区域化海报（2026-08-29 grilling Q1–Q9 定案）

~~单张 fcose 云团，孤球散落无解释~~ 新建 `src/web/graph-areas.ts`：成员资格 = 路径前缀表 + 度 0 兜底（表外有连线者不进映射、留 fcose 原位——堆积即扩表信号）；fcose 排完后各区**刚性平移**到固定罗盘（web 左 / shared 脊柱居中 / server 右 / tests 底带 / 样例岛右下 / 孤球坞左下网格）。接线顺序是硬约束：板块先移除 → fcose → 平移 → `physics.rebase()`（rebase 把平移后位置快照为漂移基点，海报不被漂移拽回）→ 板块重建——`region-plate` 背景节点（z 底层、`events:'no'`、调暗扫描排除）与 fcose/物理状态互不见面。跨区线一律细+淡（`edge-cross` 通道，声明序在 cycle 之前：循环报警仍赢），tests 带球缩 0.85；每件事只让一个机制干：**位置讲区、尺寸讲枢纽（球径公式不变）、线型讲区内/跨区**。不违反「fcose 唯一布局」裁定——本模块不做布局，只做定位后处理；唯一重排是孤儿坞（度 0 无排列可保，按 id 排序收确定性网格）。本轮明确不做（Q9 纯视觉）：区点击高亮、区域折叠（与 dir-collapse 的合并留作独立一轮）、拖放位置持久化。

### 7. 遗留（低优先）

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
| `mcp-tools.test.ts` | buildTools 直测（fake graph source + 注入 readSourceFile；错误文案按行为断言；checking 超时只留两枚工具级接线钉） |
| `review-lifecycle.test.ts` | ReviewLifecycle interface（超时窗口 / update 重挂 / 身份令牌 / 事件顺序直测） |
| `dot-module-store.test.ts` | 落盘卫生层 interface（round trip、legacy 字节格式、loadRaw 三 reason、gitignore 自举、原子写、不可写盘降级、warn 闩）——协议钉自 review-store / recent-changes 两套件回收，仪式只证一次 |
| `evals-client-bytes.test.ts` | evals client 字节自计量（第二轮候选 #3）：握手回复从 probe 第一行前就入账、listTools 入账、`countExternal` 并进同一读数——真 spawn，钉「探针无法少报」这个结构 |
| `mcp-stdio.test.ts` / `mcp-e2e.test.ts` | stdio transport 韧性 / 进程级握手冒烟；前者含 `onFileActivity` 触发纪律（面向文件工具成功打开才触发，握手、未知工具与无文件工具不计，path 不解析不触发） |
| `cross-session.e2e.test.ts` | 双实例同根 e2e：启动静默 + 主实例 armed、secondary 无头（去重日志）、relay 事件指名文件触发主实例按文件弹窗（env 抑制为日志可观察）+ `module_activity` / `begin_review` 的 `node_update` 跨实例转发；末段单实例首次打开文件弹窗 + 同文件去重、无文件工具不弹（临时根隔离，spawn 套件之二） |
| `open-browser.test.ts` / `internal-relay.test.ts` | `shouldAutoOpen` 全分支 / `/internal/broadcast` 白名单 + 回环 + 413 |
| `http-security.test.ts` / `source-endpoint.test.ts` | startHttpServer / readSourceFile |
| `graph-model.test.ts` | GraphModel 三种帧 fold + 邻接（浏览器唯一图状态） |
| `frame-sink.test.ts` | FrameSink：帧进 → 编排出（每批一次派生刷新 / 畸形帧丢弃 / 聚焦诚实性 / ticker 与 notice） |
| `legend.test.ts` | Legend 渲染面（行结构 / off 类 / toggle hooks） |
| `graph-areas.test.ts` | graph-areas 纯函数直测（成员表 / 罗盘几何不变量）+ 假 cy 上的刚性平移、孤儿网格与板块 upsert |
| `graph-filters.test.ts`（含 `deriveScopeMarks` 标记派生钉，2026-09-01 自 module-view 迁入）/ `graph-view.test.ts`（含区域化 wiring 钉：板块 / edge-cross / tests 缩放 / 孤球退役；ADR 0002 §7.2 钉：改动标记三通道 / 新范围=新基线；模块视图钉已随 ADR 0003 删除）/ `layout-store.test.ts`（rootPath 单档 + 旧分档档案作废）/ `web-render.test.ts`（构建产物 + findBackEdges 环检测 oracle + frame guards）/ `code-view.test.ts` / `ai-review.test.ts` | web 内部 seam 与 createGraphView |
| `module-table.test.ts` | 模块表 seam（六类 / 前缀与显式文件 / 表冲突守卫 / 表外无类 / 展开） |
| `edit-scope.test.ts` | 改动核对 seam（范围判定 / 显式文件通道 / watcher 漏报与并集去重 / 输入卫生 / 会话 store）+ `mcp-guardrails.test.ts`（只读 7 工具隐藏与审计拒绝）+ `edit-scope-verification` evals 探针（wire 契约） |

规则（replace, don't layer）：在模块 Interface 上写行为断言，不在实现内部探状态；引擎删除时其专属测试同删，Interface 测试存活于内部重构。

## 7. 模块表与改动核对（2026-08-31 grilling Q1–Q17 定案；模块视图 UI 已随 ADR 0003 退役）

### 7.1 模块表（module table）——只有契约面，没有视图投影

模板模式（模块视图 = 六堆固定模板位 + 模块级边 + 点堆钻取，文件视图双模式切换）
已于 2026-09-01 被 **ADR 0003 退役**：它与区域化海报是两套聚类视图的冗余，
`viewMode`/`focusedModule` 穿透 graph-view 的代价不再值得。**唯一视图 = 文件海报**
（fcose + graph-areas 罗盘），打开 dashboard 直接生效；搜索命中文件 → 直接定位高亮
文件球。

**模块表本身保留**——它从来不是（也不再有任何）渲染概念，而是 agent 圈范围的
**省 token 手段**：`declare_edit_scope { modules }` 一句模块名由服务端展开成整棵
文件清单（§7.2），`get_dashboard_info` 附模块→文件清单供 agent 选范围。表外文件
无类，进范围只能 `files` 显式点名（同 §7.2）；堆积 = 扩表信号（同 graph-areas
表外规则）。

**模块表**（模块名 + 路径清单；按**功能**分类——每个功能类下辖若干小模块，
每个小球（一个文件）就是一个小模块。条目支持**目录前缀**（该目录整棵）或**显式
文件**；一个文件命中多个功能类 = 表冲突，测试红。v1 六个功能类）：
- **MCP 服务** —— src/server 的对外接口面（显式文件：mcp / index / http /
  report-page / open-browser / review-lifecycle / review-store / health-report /
  impact / response-budget / version 等）；
- **依赖图引擎** —— src/server 的内核面（显式文件：incremental-graph /
  file-watcher / live-reload / recent-changes / coverage / source-reader /
  path-conventions / state-pipeline / typecheck / gitignore 等）；
- **Dashboard 渲染** —— src/web/（目录前缀）；
- **共享契约** —— src/shared/（目录前缀）；
- **信任探针** —— src/evals/（目录前缀）；
- **测试与样例** —— tests/ + test-fixtures/（目录前缀）；
- 住在 `src/shared`——服务端核对器（§7.2）与 `get_dashboard_info`
  （模块→文件清单）共用同一份，单一事实源。

**存档**：布局存档按 rootPath **单档**（ADR 0003：曾经的 rootPath + 视图模式
分档随模块视图一起作废，layout-store v5→6 不迁移）；「重置布局」全清。

### 7.2 改动核对（edit-scope verification）

动机：AI 修一处坏一处；核对不靠 AI 自觉，靠模块表 + watcher 磁盘事实。

**工具对**（read-only 模式下同现有变更类工具一起隐藏 + 审计拒绝）：
- `declare_edit_scope { modules?: string[], files?: string[] }` —— 开工前声明
  改动边界；新声明覆盖旧声明；会话级，重启即清。每次成功声明盖基线时刻
  `declaredAt`（scope epoch，ticket 13）。
- `report_edits { files: string[] }` —— 改完后上报实际改动文件。

**核对**：服务端用模块表展开声明范围，改动文件 ∉ 范围 = **越界改动**；watcher
recent-changes（磁盘事实）交叉验证——漏报也逃不掉。响应返回越界清单。
watcher 证据按 `declaredAt` 过滤：`changedAt < declaredAt`（上一会话/重启前
残留）→ 列进 `preexisting` 给人看，不算红、不影响 `ok`；未声明 → 不设下界
（一切照旧）。自己上报的越界永远有罪，不受基线豁免。
（已知权衡，ADR 0002：声明之后落盘的人工改动仍会被算进 agent 代——单 agent
场景的保守方向。）证据链落盘 `<root>/.module-graph/recent-changes.json`
（ticket 13 修法 B）：重启不再灭失越界证据。

**标记**（复用五条视觉通道，不新开球色体系）：
- 范围 = **紫环**（常驻描边；与查看紫脉冲——瞬时 3s 动画——区分）；
- 已改 = **整球变紫**（填充）；
- 越界 = **红警示角标** + 状态栏警示条 + tooltip 文案（红环已被类型错误占用、
  蓝环已被 checking/聚焦占用，故不动环通道）。

**契约义务**：新工具必须同步 evals 探针任务（注册表 ⇄ 磁盘双向对账，
tests/evals-structure.test.ts）；纯函数 seam（模块表解析、范围判定）进
graph-filters 同款测试；CLAUDE.md 工具表与只读清单同步更新（5 → 7 变更类）。
