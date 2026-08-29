# CLAUDE.md

module-graph-mcp 的本地 agent 指令。本仓库是一个**本地 dashboard + stdio MCP server**：浏览器实时渲染模块依赖图（球色 = 测试状态、红环 = 类型错误、评审环 = AI 检查结果），同一进程通过 stdio 提供 MCP 工具。

## MCP 工具速览（7 个）

| 工具 | 用途 |
|---|---|
| `get_module_graph` | 全图：文件级节点（测试状态 / 类型错误 / AI 评审）+ import 边 |
| `get_module_details` | 单模块详情：状态、coveredBy、类型错误、AI 评审、入出边、源码全文 |
| `list_untested` | 所有「未测」模块 id + 计数 |
| `report_note` | 给模块写备注（≤2000 字符；空串清除） |
| `begin_review` | 标记模块进入 AI 检查（球开始脉冲） |
| `end_review` | 提交逐行 verdicts，结束检查（三色上屏 + 评审环） |
| `report_test_run` | 上报刚跑完的测试结果 `{ failed: boolean }` |

## AI 检查流程（强制）

在**本仓库或任何接入了 module-graph MCP server 的项目**里做代码检查 / 编辑时：

1. **开始前**：对将要审查的每个文件调 `begin_review { path }`——dashboard 上对应小球开始脉冲，用户能看到你正在检查哪里。
2. **结束时**：对每个 `begin_review` 过的文件调 `end_review { path, verdicts, summary? }`。verdicts 是逐行结论：`{ line: <1-based 行号>, verdict: "confident" | "unsure" | "error", message?: string }`。上限：≤500 条（每行最后一条生效）、message ≤200 字符、summary ≤500 字符。
3. **绝不留悬挂的 checking**：`begin_review` 之后必须 `end_review`（哪怕结论是零问题——verdicts 传空数组即全绿）。不结束的话球会一直闪，约 10 分钟后服务端会强制回落并提示超时。
4. **跑完测试后**：调 `report_test_run { failed: true | false }`——只有你握有真实退出码；上报后覆盖率报告内文件整批转红 / 回绿。
5. 注意：评审数据是**内存态**，服务端重启或文件重扫后即清空，需要时重新上报。

## 可复制到全局 code-review skill 的段落

把下面这段粘进你的全局 code-review skill（或任何希望联动 dashboard 的检查流程 skill）：

````markdown
## Dashboard linkage (module-graph MCP)

If a `module-graph` MCP server is connected, make the review visible on the
user's dashboard:

1. BEFORE reviewing a file, call `begin_review` with `{ path: "<module id>" }`
   (POSIX path relative to the watched root, e.g. `src/index.ts`). The ball
   for that file starts pulsing — the user can see what you are inspecting.
2. AFTER finishing a file, ALWAYS call `end_review` with
   `{ path, verdicts, summary? }`. Verdicts are per-line:
   `{ line: <1-based>, verdict: "confident" | "unsure" | "error", message? }`
   (≤500 entries, last entry per line wins, message ≤200 chars,
   summary ≤500 chars). A file with no findings still gets an `end_review`
   with an empty verdicts array — never leave a module in `checking`.
3. AFTER running the tests, call `report_test_run` with
   `{ failed: <true|false> }` — only you hold the real exit code; the
   dashboard flips in-report files red/green accordingly.
````

## 其它约定

- 人类可读日志走 stderr，stdout 属于 MCP JSON-RPC 通道。
- 构建 / 测试：`npm run build`（先 build 再 `npm test`，e2e 会 spawn dist 产物）、`npm test`、`npm run lint`。
- 设计文档：`docs/MODULE-DESIGN.md`（Standards 轴度量基准，接口表以它为准）；工单在 `.scratch/module-graph-mcp/issues/`。
