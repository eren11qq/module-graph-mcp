# Changelog

本文件记录值得关注的变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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
