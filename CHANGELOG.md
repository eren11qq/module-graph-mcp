# Changelog

本文件记录值得关注的变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 重构 —— 架构评审第二轮（候选 #1「落盘卫生层」，2026-09-05）

* 新增 `src/server/dot-module-store.ts`：`<root>/.module-graph/*.json` 的统一 fs 仪式（mkdir、自忽略 .gitignore 自举、tmp+rename 原子写、坏文件即空、version 信封、warn-once 闩、失败降级不 throw）收编 review-store 与 recent-changes 的两份逐字抄本；`DOT_MODULE_DIR` 成目录名单一事实源，evals run.ts 的 fixture 清理不再手抄字面量；解码与合并语义（墓碑并集 / per-id max / 容量截断）刻意留在消费者
* review-store / recent-changes 换接线，对外 interface 与两文件盘上 schema 逐字节不变（旧 reviews.json / recent-changes.json 原样可读）；顺手修复：`recent-changes.clear()` 曾是目录里唯一非原子写手，现走同一条 tmp+rename 路
* 协议钉自两消费者测试套件回收进 `tests/dot-module-store.test.ts`（仪式只证一次；消费者套件留领域钉与降级接线钉）；词条进 CONTEXT.md（落盘卫生层），MODULE-DESIGN 行/Seam 表/Depth 评估同步

### 重构 —— 架构评审第二轮（候选 #2 + #10「清洗器归一 / 常量单源」，2026-09-05）

* review-store 的第二清洗器 `cleanReview` 删除逐字 fork：verdict 解码改委托 `review-lifecycle.normalizeVerdicts`（已实证分叉——旧实现丢行排序、丢每行最后一条生效、丢 500 条上限、200/500 截断手抄、`AI_VERDICTS` 自声明），磁盘复活评审与 end_review 活路径恒等；新增「落盘复活形状恒等」红先钉（乱序/同行重复/超限 + 503→500 逐出）
* 预算数字单源：`MAX_VERDICT_ENTRIES` / `MAX_VERDICT_MESSAGE` / `MAX_REVIEW_SUMMARY` 自 review-lifecycle 导出，mcp.ts 的 playbook 文本、begin/update/end 描述、`report_note` 上限（`MAX_NOTE_LENGTH=2000`）全部模板插值——对外字节零变化；playbook-present 探针改为按常量断言，回硬码/删数字即红（ADR 0001 文本-探针同 PR 纪律延续）
* CONTEXT.md playbook 词条、MODULE-DESIGN 三行同步；对外 interface、`reviews.json` schema、全部 wire 字节不变

### 重构 —— 架构评审第二轮（候选 #3「字节记账下沉」，2026-09-05）

* evals 的 maxBytes 红线从 convention 变结构：`mcp-client.ts` 加 `bytesSeen()`（stdout 每个字节必经计数，含 initialize 握手、listTools 全量 schema、扫描重试的每一份中间回复、不可解析垃圾行）与 `countExternal()`（HTTP 探针的非 stdio 流量入同一本账）；`ToolCallOutcome.bytes`、`ProbeResult` 删除，16 个探针的 `bytes +=` 手抄全部退役——忘加一行即静默放松红线的病根拔掉（红先钉 tests/evals-client-bytes.test.ts：握手入账 / listTools 入账 / 外账合并三点）
* 诚实表首跑照出两处结构性漏计，`dashboard-info-reports-root`（1500→3000，实测 2259）与 `read-only-mode`（4000→8000，实测 7054，旧数从未计 listTools）按全量读数重校——预算上限虽升，度量口径为全量真值，ADR 0001 可见性增强；其余 14 预算不动全绿
* run.ts 失败路径也回报 `bytesSeen()`（崩溃前的线费不再显示为 0）；对外 wire、server 行为零变化

### 重构 —— 架构评审第二轮（候选 #4「fold-then-apply：view 自己完成配对」，2026-09-05）

* `GraphView` 三个公开 mutator `applySnapshot`（原 `setSnapshot`，改名已拍板）/ `applyDelta` / `applyNodeUpdate` 由「半个调用」升格为完整调用：入口先 `model.foldX(frame)` 再渲染/DOM patch——「先 fold 后 apply」的配对序从注释与 caller 纪律进 module 内部，render-before-fold bug 类不可表达
* `frame-sink.ts` 三处手抄配对各删一行（guard → view → 派生不变，flashEvent 与聚焦面板读 model 的时序不受影响——fold 已在 view 入口完成）；`tests/graph-view.test.ts` 的 paired 配对替身删除（裸 view 直测，「调用即正确」在测试面同样成立）；红先钉三枚（applySnapshot/applyDelta/applyNodeUpdate 单独调用即落账 model）先行失败后转绿
* `GraphModel` 对外 interface 不动（fold 仍是全图唯一实现，graph-model.test 直测保留），直接调用方收敛为 graph-view 一家；frame-sink.test 假身按新契约折账，派生值断言原样通过；纯 web 内部事，wire 字节与 evals 零变化；CONTEXT.md 新词条「调用即正确」、MODULE-DESIGN 三行同步

### 重构 —— 架构评审第二轮（候选 #5「主题单源：删浅色 + 等值钉」，2026-09-05）

* light 亮色工作台整体删除（用户拍板）：dashboard 定稿为单主题 dark 暗色仪器盘——`theme.ts` 的 `LIGHT` 色板、`CY_PALETTES` 双表、`ThemeKey`、「当前主题」全局（`activeTheme` / `setTheme` / `activeThemeKey`）与 `CHROME.themeStorageKey` / `defaultTheme` 全退役，`CY_PALETTE` 成唯一色板；页顶切换钮、`mg-theme` localStorage 记忆、`main.ts` 的 `setActiveTheme→view.setTheme→refreshDerived` 顺序舞一并消失（原全局参数泄漏问题的最便宜解：参数本身没了）
* 双真源病根上等值钉：`tests/theme-palette.test.ts` 重写为解析 `styles.css` 的 `[data-theme="dark"]` token 块与 TS 侧逐色交叉断言（四状态色 / AI unsure / type-error / 画布地面 = --bg / 边色 / 环朱红 / accent / label 共 12 枚），改一侧忘另一侧即红——双主题时代「各钉一侧、从不交叉」的账结清；`[data-theme]` 外壳刻意保留：将来加回第二主题 = 色板 + CSS 块 + 切换钮三件套按钉补齐
* `GraphView` 接口 15→14 方法（`setTheme` 删除，唯一 caller 是同批消失的切换钮）；`THEME.typeError` 双键压单键；`styles.css` 删 light token 块与 hljs 亮色覆盖（`connPulseSoft` keyframes 随之成孤儿删除）；纯 web 内部事，wire 字节与 evals 零变化（server 源 diff 为零）；CONTEXT.md 新词条「等值钉」、MODULE-DESIGN graph-view/theme 两行同步

### 重构 —— 架构评审轮（候选 #1–#6，2026-09-03；wire 字节零变化，evals 16/16 绿）

* mcp.ts 工具体仪式收编：`errorResult` 统一 10 处错误信封、`readStringArray` / `VERDICTS_ARRAY_ERROR` 去守卫重复、路径卫生 16 处抄本归 `path-conventions.normalizeFilePath` 单一事实源、展开截断并档 `EDIT_SCOPE_EXPAND_CAP`
* `tests/` 类型门：新增 `tsconfig.tests.json`（`npm run build` 链尾执行），修 49 处积压 seam 漂移——GraphView/Statusbar fake 补齐缺员、`'ok'`→`'passing'` 词表跟上、stale 注释与 cast 收编
* cold-start stdio client 合并：`src/evals/mcp-client.ts` 成唯一实现（+`request`/`stderr`/`waitUntilStderr`/钉端口），cross-session 与 review-persistence e2e 弃手搓副本共用之；`getFreePort` 单一实现 + helpers 再导出；`runServerCli` 收编 5 处退出码仪式（mcp-e2e 的 Ticket-01 原始分帧验收照旧保留）
* 海报管线各成一个深 module：`layout-cluster.solveClusterPoster` / `graph-areas.solveRegionsPoster`——「separate 先于 rebase/persist」的序从五文件注释收进通道内部，layout-cluster.test 手抄管线删除、直跑生产函数（ADR 0004 几何零触碰）
* graph-view 放下第二份图状态：`currentNodes`/`currentEdges` 副本删除，原始终态只读 `graph-model`（`model` 注入 GraphViewOptions，配对序 = 先 fold 后 apply）；`deriveScopeMarks` 逐球单喂改批量缓存
* 变更风险判定搬回图数学：`impact.scoreChanges` 纯函数 + `CHANGE_IMPACT_HEURISTICS` 唯一文本来源，`get_change_impact` 工具体只剩解析 + 整形；新增 scoreChanges 风险矩阵直测（impact.test.ts）

## [0.1.0]

### 新增 —— Dashboard

* 文件级依赖图实时渲染（chokidar 监听 → 增量重分析 → WebSocket 推帧，页面免刷新）：球色 = 测试状态（Okabe-Ito 四色）、红环 = 类型错误、虚线弧 = 循环依赖
* 节点详情面板：测试状态 / coveredBy / 类型错误（含行号）/ 入出边跳转 / 语法高亮源码
* 模块视图 ⇄ 文件视图分段切换（ADR 0002 模板模式），聚类 / 区域双排列模式（ADR 0004）
* 健康报告页 `GET /api/report`（确定性打分 + 中文简报，`?focus=` 深链高亮）
* 暗色 / 亮色双主题，localStorage 记忆

### 新增 —— MCP 工具（14 个）

* 查询类：`get_dashboard_info` / `get_module_graph` / `get_module_details` / `get_impact` / `get_change_impact` / `list_untested` / `get_health_report`
* 变更类：`report_note` / `begin_review` / `update_review` / `end_review` / `report_test_run` / `declare_edit_scope` / `report_edits`
* 护栏：`_maxTokens` 响应预算与 UTF-8 边界截断标记、`MODULE_GRAPH_MCP_READ_ONLY` 只读模式
* 文件粒度弹窗策略与同仓库多会话共享单窗口（副实例活动转发、token 自愈）

### 新增 —— 工程

* evals probe 基准（冷启动逐任务探针，maxMs / maxBytes 硬契约，见 ADR 0001）与四步 CI 流水线
* 一键安装脚本（install.sh / install.ps1）
