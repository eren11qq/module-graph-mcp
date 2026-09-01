# MCP Probe 评估基准方案

> 来源：调研 PostHog `services/mcp/evals/` 后的移植方案。PostHog 对 evals 的定位原话：
> *"a fixed benchmark of agent tasks … that can be scored against a live MCP server. A change
> to a tool description, schema, or handler 'improves the MCP' only if these scores say so."*
>
> 本方案为 **probe 模式（无 LLM、确定性）**，agent 模式（LLM 评审打分）为二期。
> 状态：已评审、暂缓实现（2026-08-30）。

## 1. 要解决的问题

现有测试只回答"代码对不对"（单测测内部逻辑、e2e 测 server 能起、路由通、增量推送正常），
没有任何东西回答"**AI agent 用这 9 个工具能不能把事情办成**"。例如：

- 工具描述含糊，agent 先调 `get_module_details` 撞上基线扫描未完成，白等后放弃——没有测试会失败；
- 某次重构让 `get_module_graph` 响应膨胀 3 倍，撑爆 agent 上下文——没有测试会失败；
- 改一句工具描述措辞，agent 工具选择正确率下跌——完全不可见。

probe 评估基准把"agent 体验"变成 CI 可验证的契约：响应结构、延迟预算、错误行为、目录一致性。

## 2. 目标与非目标

**目标**

- 固定一组 agent 任务，对着真实 spawn 的 MCP server 确定性探测；
- 校验每个只读工具的响应结构、延迟预算、错误契约；
- 守卫测试保证基准不腐化（引用的工具必须真实存在，只读工具必须被覆盖）；
- 全部落在 `tests/`，**不改生产代码、不加任何依赖**。

**非目标（明确不做）**

- agent 模式（LLM 回放 + 评审打分）；
- CI 接入（仓库当前没有 `.github/workflows`）；
- 新增运行时/开发依赖；
- 探测有副作用的工具（`report_*` / `begin_review` 系留到二期，与 PostHog "probe 必须只读"规则对齐）。

## 3. 文件结构

```text
tests/
  helpers/
    mcp-client.ts      # 新增：可复用 MCP 客户端（从 mcp-e2e.test.ts 的模式提炼）
    net.ts             # 已有：getFreePort
  evals/
    tasks.ts           # 新增：类型化任务集
    runner.ts          # 新增：逐任务探测 + 打分汇总
    evals.test.ts      # 新增：vitest 套件 + 守卫测试
package.json           # 小改：加 "evals": "vitest run tests/evals"
CLAUDE.md              # 小改：改工具描述/schema/目录前后必须跑 npm run evals
README.md              # 小改：评估基准一小节
```

### `tests/helpers/mcp-client.ts`

复用 `tests/mcp-e2e.test.ts` 已验证的 spawn/framing 模式，提炼为类：

- `spawn(process.execPath, ['dist/server/index.js', '--root', <fixture>, '--port', N, '--no-open'])`，
  环境变量 `MODULE_GRAPH_NO_OPEN: '1'`；
- 完成 `initialize` → `notifications/initialized` 握手；
- `callTool(name, args)`：按 JSON-RPC id 关联回复（**回复按完成序而非请求序到达**，
  e2e 测试已验证该坑），返回 `{ parsed, latencyMs }`；
- `toolsList()`：返回工具目录，供守卫测试使用。

现有测试文件不改动，仅新代码使用该 helper。

### `tests/evals/tasks.ts` —— 任务集

PostHog 用 `tasks.yaml` + zod schema + fixture 测试；我们直接用 TypeScript，
**tsc 就是 schema 校验**，零新依赖，等价守住"任务格式"这一层。

```ts
export interface EvalTask {
  /** kebab-case，唯一，如 "graph-cold-start-scanning" */
  id: string;
  /** 工具域，如 "graph" / "details" / "untested" / "dashboard" */
  category: string;
  /** 仿真实用户对 agent 说的话，供 agent 模式二期复用 */
  intent: string;
  /** 一个胜任的 agent 应调用的工具 */
  expectedTools: string[];
  /** 也算对的替代路径（不罚分），二期 agent 模式用 */
  acceptableTools?: string[];
  probe: {
    tool: string;
    args: Record<string, unknown>;
    /** 对解析后结果的断言，抛错即失败 */
    validate: (parsed: unknown) => void;
    /** 墙钟延迟预算（ms），超时即失败 */
    maxMs: number;
  };
}
```

### v1 任务清单（约 8 条，全部只读工具）

| id | 工具 | 断言要点 | maxMs |
|---|---|---|---|
| `dashboard-info-baseline` | `get_dashboard_info` | rootPath 正确、基线完成后 `scanning: false`、nodeCount > 0 | 5000 |
| `dashboard-info-fresh` | `get_dashboard_info` | 冷启动可立即应答（握手不阻塞在基线扫描上） | 1000 |
| `graph-shape` | `get_module_graph` | nodes/edges 为数组；节点字段齐全（id/path/language/testState）；edge 两端都落在节点集内；无重复 id | 5000 |
| `graph-cold-start-scanning` | `get_module_graph` | **全新 server 首调**：立即返回 `scanning: true`，不得阻塞等基线（基线门控承诺） | 1000 |
| `graph-after-edit`（可选） | `get_module_graph` | 对临时项目做一次文件变更后，图中对应节点随之更新（复用 `tests/helpers/temp-project.ts`） | 10000 |
| `details-known-path` | `get_module_details` | source 非空；in/out 边与图快照一致；coveredBy 符合命名约定 | 5000 |
| `details-unknown-path` | `get_module_details` | 未知路径返回**结构化错误**（不 crash、不挂起），错误信息含路径 | 1000 |
| `untested-consistency` | `list_untested` | 结果与 `get_module_graph` 的 `testState` 自洽（互为印证，不硬编码 fixture 事实） | 5000 |

延迟预算首轮从宽（内容类 5s、非门控 1s）防 flaky，跑出实测分布后再收紧。

### `tests/evals/runner.ts` —— 执行与打分

```text
for task of tasks:
  t0 = now
  reply = client.callTool(task.probe.tool, task.probe.args)
  latency = now - t0
  task.probe.validate(reply.parsed)        # 结构断言
  assert(latency <= task.probe.maxMs)      # 预算断言
汇总输出:
  task pass rate / p50 / p95 latency / schema 失败数 / 超时数
```

- 每个任务独立记录，单任务失败不中断其余任务；
- 汇总以表格打到测试输出，供改动前后对照（PostHog 的 before/after scores 用法）。

### `tests/evals/evals.test.ts` —— 套件 + 守卫

1. **probe 套件**：spawn 一次 server，跑完全部任务；
2. **目录守卫（PostHog 式）**：任务里引用的每个工具必须出现在活 server 的
   `tools/list` 中——**工具一改名 CI 就红，基准不会悄悄失效**；
3. **反向覆盖（软守卫）**：每个只读工具（`get_dashboard_info`、`get_module_graph`、
   `get_module_details`、`list_untested`）至少被一个任务引用，防止基准过期。

## 4. 断言策略

- **优先不变量**：字段齐全、引用闭合、`list_untested` 与图状态自洽；
- **少硬编码** fixture 事实，少数硬编码（如 sample-app 存在未测试文件）兼当夹具回归检查；
- 实现前先核对 `test-fixtures/sample-app` 的实际目录结构与测试状态；
- 冷启动类任务单独 spawn 实例，与主套件的 server 隔离。

## 5. 验收标准

- `npm run build` 后 `npm test` 全绿，且包含新 evals 套件；
- `npm run evals` 可独立运行并输出打分汇总；
- 故意改掉一个工具名 → 守卫测试变红（演示基准有效性）。

## 6. 二期路线（本方案不实现）

- **agent 模式**：回放 `intent` 经真实 agent loop，按 `expected_tools` 评工具选择、
  按 `success_criteria` 评结果（LLM 评审），产出任务成功率 / token 每任务等分数；
- 探测生命周期工具（`begin_review` → `update_review` → `end_review` 回环，
  server 为一次性实例故可安全变更状态）；
- 若引入 CI，evals 套件进 pipeline。
