# CLAUDE.md

module-graph-mcp 的本地 agent 指令。本仓库是一个**本地 dashboard + stdio MCP server**：浏览器实时渲染模块依赖图（球色 = 测试状态、红环 = 类型错误、评审环 = AI 检查结果），同一进程通过 stdio 提供 MCP 工具。

## MCP 工具速览（14 个）

| 工具 | 用途 |
|---|---|
| `get_dashboard_info` | dashboard 地址、被监视根目录、节点/边计数：每会话先调它核实监视树，并把链接给用户 |
| `get_module_graph` | 全图：文件级节点（测试状态 / 类型错误 / AI 评审）+ import 边 |
| `get_module_details` | 单模块详情：状态、coveredBy、类型错误、AI 评审、入出边、context 统计（入出度 / 在环上 / 中心度）、源码全文（读取会让该球短暂亮起） |
| `get_impact` | 改前看**爆炸半径**：upstream（谁依赖它）/ downstream（它依赖谁）按 BFS 深度分组，含各节点测试状态与类型错误数；direction 默认 both、maxDepth 默认 3 上限 10 |
| `get_change_impact` | 改后看**变更证据链**：watcher 记录的最近变更文件 + 每个在图变更的波及面与风险级（波及在环上或高中心度 → high；受影响 >10 → medium；否则 low）；记录仅内存，重启即清 |
| `declare_edit_scope` | 开工前声明**改动边界**：modules（功能模块 id，`get_dashboard_info` 会给合法清单）+ files（显式文件；表外文件只能走这里）。新声明覆盖旧声明；会话级，重启即清；空对象 = 清除范围 |
| `report_edits` | 改完后上报实际改动文件；服务端用模块表展开声明范围 + watcher 磁盘事实交叉核对——**越界改动**（范围外，红角标 + 警示条）与**漏报**（watcher 看见但没上报）都判红，响应返回两份清单与 ok 标志 |
| `list_untested` | 所有「未测」模块 id + 计数 |
| `get_health_report` | 确定性健康报告：固定整数权重表打分（高中心度=3、未测=2、类型错误=2、在环上=1、评审error=2，同分按 id 字典序），items 风险降序 + 中文简报 top 5 |
| `report_note` | 给模块写备注（≤2000 字符；空串清除） |
| `begin_review` | 标记模块进入 AI 检查（球开始脉冲）；响应内嵌**评审 playbook**（三色 verdicts 定义 / update 分批节奏 / end 配对纪律，关键节被探针逐字断言） |
| `update_review` | 检查进行中推送部分 verdicts（dashboard 逐行上屏；同样新条覆盖旧行） |
| `end_review` | 提交逐行 verdicts，结束检查（三色上屏 + 评审环） |
| `report_test_run` | 上报刚跑完的测试结果 `{ failed: boolean }` |

**使用指引**：改任何代码**之前**先 `declare_edit_scope` 声明改动边界（modules + files 双通道；表外文件显式点名），再对目标文件调 `get_impact` 看爆炸半径（波及在环上或高中心度节点的改动要格外小心）；**改完**立刻调 `report_edits` 上报实际改动（越界/漏报判红）+ `get_change_impact` 串起变更证据链、核对风险级，再决定是否跑测试 / 上报评审。响应过大会被 `_maxTokens` 预算截断并给出省略标记（按标记里的指引收窄查询或调大预算）。`MODULE_GRAPH_MCP_READ_ONLY=1` 启动时 7 个变更类工具（`report_note` / `begin_review` / `update_review` / `end_review` / `report_test_run` / `declare_edit_scope` / `report_edits`）不可见且调用被拒（审计友好错误），分析类工具保持可用。

## AI 检查流程（强制）

在**本仓库或任何接入了 module-graph MCP server 的项目**里做代码检查 / 编辑时：

0. **探索即可见**：`get_module_details` 每次读取都会让对应球亮起 3 秒紫色「查看」脉冲——正常浏览文件无需任何额外调用；`begin_review` 仍专用于**开始审查 / 编辑前**的持续检查状态。
1. **开始前**：对将要审查的每个文件调 `begin_review { path }`——dashboard 上对应小球开始脉冲，用户能看到你正在检查哪里。
2. **过程中（可选，推荐大文件使用）**：每确认一批行结论就调 `update_review { path, verdicts }`——dashboard 对应行实时逐行上色。verdicts 格式同 `end_review`，与已有部分结论合并（同样新条覆盖旧行）。
3. **结束时**：对每个 `begin_review` 过的文件调 `end_review { path, verdicts, summary? }`。verdicts 是逐行结论：`{ line: <1-based 行号>, verdict: "confident" | "unsure" | "error", message?: string }`。上限：≤500 条（每行最后一条生效）、message ≤200 字符、summary ≤500 字符。
4. **绝不留悬挂的 checking**：`begin_review` 之后必须 `end_review`（哪怕结论是零问题——verdicts 传空数组即全绿）。不结束的话球会一直闪，约 10 分钟无 begin/update 活动后服务端会强制回落并提示超时。
5. **跑完测试后**：调 `report_test_run { failed: true | false }`——只有你握有真实退出码；上报后覆盖率报告内文件整批转红 / 回绿。
6. 注意：`end_review` 落地的评审结论会**持久化到磁盘**（`<root>/.module-graph/reviews.json`，默认 gitignore）——服务重启、弹窗页面关闭后再打开，已检查的痕迹（三色环）仍然常驻；checking 中间态不持久化，约 10 分钟无活动自动回落照旧。

## 可复制到全局 code-review skill 的段落

把下面这段粘进你的全局 code-review skill（或任何希望联动 dashboard 的检查流程 skill）：

````markdown
## Dashboard linkage (module-graph MCP)

If a `module-graph` MCP server is connected, make the review visible on the
user's dashboard:

1. BEFORE reviewing a file, call `begin_review` with `{ path: "<module id>" }`
   (POSIX path relative to the watched root, e.g. `src/index.ts`). The ball
   for that file starts pulsing — the user can see what you are inspecting.
2. WHILE reviewing (optional, recommended for long files), call
   `update_review` with `{ path, verdicts }` whenever a batch of lines is
   settled — the dashboard paints those rows live. Verdicts merge into the
   pending review; on the same line the new entry wins.
3. AFTER finishing a file, ALWAYS call `end_review` with
   `{ path, verdicts, summary? }`. Verdicts are per-line:
   `{ line: <1-based>, verdict: "confident" | "unsure" | "error", message? }`
   (≤500 entries, last entry per line wins, message ≤200 chars,
   summary ≤500 chars). A file with no findings still gets an `end_review`
   with an empty verdicts array — never leave a module in `checking`.
4. AFTER running the tests, call `report_test_run` with
   `{ failed: <true|false> }` — only you hold the real exit code; the
   dashboard flips in-report files red/green accordingly.
````

## 其它约定

- 人类可读日志走 stderr，stdout 属于 MCP JSON-RPC 通道。
- 弹窗策略：server 启动**不弹浏览器**；agent 通过面向文件的 MCP 工具（`get_module_details` / `begin_review` / `update_review` / `end_review` / `report_note`）打开某文件、或同根 relay 事件指名该文件时才弹，且**只在没有已连接的 dashboard 页面时弹**（WS 有 OPEN 客户端即跳过、不记 poppedFiles，页面关掉后后续文件可重新弹），同一文件每进程至多弹一次；没打开过的文件绝不弹（`get_dashboard_info` / `get_module_graph` 等无文件工具不触发），`--open` 仍无条件启动即弹。Linux 启动器候选链：`wslview` →（WSL 下插）`cmd.exe /c start ""` → `xdg-open` → `gio open`，逐个 spawn 失败兜底、全败只记 stderr。同一仓库跨会话共用一个窗口：副实例无头转发，其 `get_dashboard_info` 直接返回主实例链接。
- 构建 / 测试：`npm run build`（先 build 再 `npm test`，e2e 会 spawn dist 产物）、`npm test`。
- evals 基准：`npm run evals`（同样先 build）——逐任务冷启动探针，不变量断言 + maxMs/maxBytes 硬门槛（响应体积超限即红，ADR 0001）；新增/修改 MCP 工具必须同步更新 `src/evals/tasks/` 的对应探针任务，注册表 ⇄ 磁盘双向对账（tests/evals-structure.test.ts）。
- 设计文档：`docs/MODULE-DESIGN.md`（Standards 轴度量基准，接口表以它为准）；工单在 `.scratch/module-graph-mcp/issues/`。
