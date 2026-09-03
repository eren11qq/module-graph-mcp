# Changelog

本文件记录值得关注的变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

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
