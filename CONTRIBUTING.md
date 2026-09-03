# Contributing to module-graph-mcp

感谢你有兴趣参与！本仓库是一个 TypeScript 项目（Node ≥ 20），单进程同时提供 dashboard 与 stdio MCP server。

## 贡献范围

可以直接开 PR 的改动：

* 不改变既有行为的小型增量（新探针任务、文档改进、独立 bug 修复）
* 单一定义清晰的逻辑改动——每个 PR 只覆盖一件事

其他改动（新 MCP 工具、弹窗/安全策略变更、依赖图语义调整）请先开 issue 与维护者讨论。

## 开发环境

```bash
git clone https://github.com/eren11qq/module-graph-mcp.git
cd module-graph-mcp
npm install
npm run build          # tsc 编译服务端 + vite 打包前端到 dist/server/public
```

常用命令：

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建产物到 `dist/`（测试与 evals 会 spawn `dist/server/index.js`，**改完 src 必须先 build**） |
| `npm test` | vitest 全量（含冒烟 / e2e） |
| `npm run test:watch` | vitest watch 模式 |
| `npm run evals` | evals probe 基准（同样要求先 build） |
| `npm run typecheck:web` | 前端 tsconfig 单独检查 |

CI 按四步流水线执行：`npm ci → build → test → evals`（见 `.github/workflows/ci.yml`），本地提交前请跑通同样四步。

## evals probe 基准

`npm run evals` 对 `test-fixtures/sample-app` 逐任务**冷启动**一个真实 server 进程，先按不变量断言（节点/边清点、错误自解释、评审生命周期等），再按 `maxMs` / `maxBytes` 门槛判红——响应体积是硬契约（见 [ADR 0001](docs/adr/0001-evals-maxbytes-ci-contract.md)），超限即 CI 红；runner 始终记录 p50/p95（ms 与 bytes 两列）。

* 任务注册表在 `src/evals/tasks/registry.ts`，与磁盘**双向对账**：游离的任务文件、幽灵清单条目都会红（`tests/evals-structure.test.ts`）。
* **新增 / 修改 MCP 工具必须同步更新对应探针任务**，并在同一 PR 里更新门槛值（初始值 = 实测 p95 × 1.5 向上取整）。

## 项目约定

* 人类可读日志一律走 **stderr**，stdout 属于 MCP JSON-RPC 通道。
* 服务只绑定 `127.0.0.1`；鉴权 / 弹窗等安全相关设计改动需在 PR 里说明理由（现有妥协及其触发条件记录在 [COMPROMISES.md](COMPROMISES.md)）。
* 架构级决策写 ADR：`docs/adr/NNNN-标题.md`，编号顺延。
* 模块接口以 [docs/MODULE-DESIGN.md](docs/MODULE-DESIGN.md) 为基准（Standards 轴）；接口变化与该文档同 PR 更新。
* AI agent 在本仓库工作的行为约定见 [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md)。

## 提交 PR

1. 在 `CHANGELOG.md` 的 `Unreleased` 下记录你的改动（新特性 / 修复 / 破坏性变更），风格简洁。
2. 涉及 MCP 工具的改动：同步更新 README 工具表、CLAUDE.md 工具速览、evals 探针任务。
3. PR 描述里的 checklist 请如实勾选；CI（build → test → evals）必须全绿。
