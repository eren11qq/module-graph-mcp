# 配置参考（CONFIGURATION）

本文收录 server 的全部运行时配置：CLI 选项、环境变量、弹窗策略、测试状态判定与数据持久化。快速上手见 [README](../README.md)。

## CLI 选项与环境变量

| 选项 | 说明 |
|---|---|
| `--root <dir>` | 监视的项目根目录（默认当前目录；必须是已存在的目录） |
| `--port <n>` | dashboard 端口（默认 24282；被占用自动递增） |
| `--open` | 启动时立即弹页（无视同仓库去重；不带它则按下面的弹窗策略等首次活动） |
| `--no-open` | 从不自动打开浏览器（CI / 测试环境用；优先级高于 `--open`） |
| `--version` | 打印版本号后退出（不启动服务） |
| `MODULE_GRAPH_NO_OPEN=1` | 同 `--no-open` 的环境变量形式 |
| `MODULE_GRAPH_MCP_READ_ONLY` | `1` = 只读模式：7 个变更类工具（`report_note` / `begin_review` / `update_review` / `end_review` / `report_test_run` / `declare_edit_scope` / `report_edits`）不注册、调用被拒（审计友好错误）；分析类工具保持可用。unset / `0` = 关；其他值启动即报错退出 |
| `MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS` | 默认响应 token 预算（正整数；非法值启动即报错退出）。工具调用参数 `_maxTokens`（正整数，非法静默忽略）可按次覆盖；超限响应在 UTF-8 边界截断并追加英文省略标记（含原始估算 token 数与收窄指引），截断后的 JSON 可能不完整——护栏文本优先 |

所有人类可读日志走 **stderr**——stdout 属于 MCP JSON-RPC 协议通道。服务只绑定 `127.0.0.1`，是本地单机工具。

## 弹窗策略

启动**不弹浏览器**——桌面端（如 ZCode）打开时会为每个项目拉起一个 server 进程，弹窗按**文件粒度**后移：

* agent 通过面向文件的 MCP 工具（`get_module_details` / `begin_review` / `update_review` / `end_review` / `report_note`）**打开某个文件**时，才为该文件自动打开 dashboard（默认 `http://127.0.0.1:24282`，端口被占自动 +1）；同一文件只弹一次，agent 没打开过的文件绝不弹（`get_dashboard_info` / `get_module_graph` 等无文件工具不触发）。
* **同仓库一个窗口**：被占端口按「端口带扫描」（首选端口起 20 个连续端口）找同根实例——找到则本进程保持无头、永不弹页，其工具事件转发到主实例页面（转发事件指名的文件同样按文件粒度触发主实例弹窗）；整个端口带都是异根/空闲时本进程 armed。
* **副实例活动转发**：同一仓库跨会话共用一个窗口，后续会话静默（无头），其 AI 活动（查看脉冲 / 检查脉冲 / 备注更新）实时转发到第一个 dashboard 页。
* `get_dashboard_info` 返回的是**该实例自己的** tokenized 链接（P0-4 安全设计：主实例的随机 token 不跨进程共享，副实例无法代开主实例链接）——任何实例的链接都指向同一棵监视树，转发让主实例页面照常显示副会话的活动。
* **token 自愈**：HTML 入口（`/`、`/index.html`、`/api/report`）缺 token / 旧 token 会被服务端 302 补成当前 token，裸 `http://127.0.0.1:<port>/` 直接可用，用户无需复制启动日志链接；`/api/*` 数据面与 `/ws` 仍 401 拒绝。

只想复现界面 demo，用仓库自带的 `test-fixtures/sample-app` 加 `--open` 即可；要监视自己的项目，把 `--root` 指向该目录。

## 基线扫描期间的握手

基线扫描期间 MCP 握手**不会**被阻塞：`get_dashboard_info` / `get_module_graph` 即时应答并带 `scanning: true`；依赖图内容的工具（`begin_review` / `get_module_details` 等）自动等基线落定（上限 20s）再作答。

## 测试状态判定

* **主判定**读 `coverage/coverage-summary.json`（vitest/jest 覆盖率报告）——**存在即通过，MVP 不设覆盖率阈值**；agent 通过 `report_test_run` 上报失败运行后，报告内文件整批转红（上报 `{ failed: false }` 回绿）。
* **兜底**（没有覆盖率数据时）按命名约定：测试文件 = 文件名以 `.test`/`.spec` 结尾，或位于任意 `__tests__/` 段下；命中同名测试文件的源码模块视为「有测试未跑」，否则「未测」。

## 数据持久化

| 数据 | 位置 | 生命周期 |
|---|---|---|
| AI 评审结论（`end_review`） | `<root>/.module-graph/reviews.json`（默认 gitignore） | 持久：服务重启 / 页面关闭后再打开仍在（三色评审环常驻） |
| 最近变更记录（watcher） | `<root>/.module-graph/recent-changes.json` | 持久：上限 100 条，服务重启自动回灌 |
| checking 中间态 | 内存 | 约 10 分钟无 begin/update 活动自动回落 |
| 依赖图与备注 | 内存 | 重启丢失 |
| `declare_edit_scope` 声明 | 内存 | 会话级：新声明覆盖旧声明，重启即清 |
