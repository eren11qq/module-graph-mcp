# module-graph-mcp

实时模块依赖图：一个 Node 进程同时是 **本地 dashboard**（浏览器里看小球连线图，点击查看测试状态 / 类型错误 / 源码）和 **stdio MCP server**（编码 agent 可直接查询图与源码）。文件改动经 chokidar 监听，通过 WebSocket 实时推送到页面。

## 功能一览

- **依赖图渲染**：文件级小球 + 依赖箭头；球色 = 测试状态（Okabe-Ito 色盲安全四色）；红环 = 类型错误；红色虚线弧 = 循环依赖；球大小随依赖度数增长
- **实时更新**：文件增删改 → 增量重分析 → `graph_delta` / `node_update` 推帧，页面免刷新
- **节点详情**：点击锁球 → 测试状态 / 覆盖它的测试文件 / 类型错误列表（含行号）/ 入出边跳转 / 语法高亮源码（错误行标记）
- **视图控制**：搜索框（大小写不敏感匹配路径与文件名）、「只看未测」过滤、目录折叠（同目录 ≥3 个文件折叠为一个目录球，点目录球展开）
- **MCP 查询**：agent 可拉全图、查单模块详情、列未测模块、写备注（备注实时出现在 dashboard 详情面板）

## 快速开始

前置：Node ≥ 20。

```bash
git clone <本仓库> module-graph-mcp
cd module-graph-mcp
npm install
npm run build          # tsc 编译服务端 + vite 打包前端到 dist/server/public
node dist/server/index.js --root ./test-fixtures/sample-app
```

启动后会自动打开浏览器（默认 `http://127.0.0.1:24282`，端口被占自动 +1）；只想复现界面 demo，用仓库自带的 `test-fixtures/sample-app` 即可。要监视自己的项目，把 `--root` 指向该目录。

**测试状态判定**：主判定读 `coverage/coverage-summary.json`（vitest/jest 覆盖率报告，存在且达标 = 通过，失败 = 失败）；没有覆盖率数据时按命名约定兜底——存在同名 `*.test.ts(x)` 视为「有测试未跑」，否则「未测」。

## CLI 选项与环境变量

| 选项 | 说明 |
|---|---|
| `--root <dir>` | 监视的项目根目录（默认当前目录；必须是已存在的目录） |
| `--port <n>` | dashboard 端口（默认 24282；被占用自动递增） |
| `--no-open` | 不自动打开浏览器（CI / 测试环境用） |
| `MODULE_GRAPH_NO_OPEN=1` | 同 `--no-open` 的环境变量形式 |

所有人类可读日志走 **stderr**——stdout 属于 MCP JSON-RPC 协议通道。服务只绑定 `127.0.0.1`，是本地单机工具。

## 界面交互

- 悬停：一跳邻域保持高亮，其余淡出；点击：锁定并打开详情（再点同球 / 点背景 / `Esc` 解锁）
- 搜索框：大小写不敏感，匹配路径与文件名；与「只看未测」可叠加（AND）
- 目录折叠：开关打开后，直接子文件 ≥3 的目录折叠为一个目录球（状态按最严重者聚合、类型错误计数累加、边重接到目录球）；根目录文件永不折叠；点击目录球展开该目录
- 布局：层级（默认）/ 力导向 fcose，`←` / `→` 方向键切换
- 图例：灰=未测、蓝=有测试未跑、绿=通过、红(橙)=失败，及依赖边 / 循环依赖线型

## 注册为 MCP server

单进程双通道：注册进 MCP 客户端不影响浏览器 dashboard（同一进程同时服务 stdio 与 HTTP）。路径请换成你机器上的绝对路径。

### Claude Code

```bash
claude mcp add module-graph -- node /absolute/path/to/module-graph-mcp/dist/server/index.js --root /absolute/path/to/your-project
```

或项目根 `.mcp.json`：

```json
{
  "mcpServers": {
    "module-graph": {
      "command": "node",
      "args": ["/absolute/path/to/module-graph-mcp/dist/server/index.js", "--root", "/absolute/path/to/your-project"]
    }
  }
}
```

### Kilo Code

写入项目 `kilo.json`（或全局 `~/.config/kilo/kilo.json`）：

```jsonc
{
  "mcp": {
    "module-graph": {
      "type": "local",
      "command": ["node", "/absolute/path/to/module-graph-mcp/dist/server/index.js", "--root", "/absolute/path/to/your-project"],
      "enabled": true
    }
  }
}
```

### MCP 工具

| 工具 | 说明 |
|---|---|
| `get_module_graph` | 全图：文件级节点（测试状态 / 类型错误）+ import 边 |
| `get_module_details` | 单模块详情：状态、coveredBy、类型错误、入出边、源码全文、备注 |
| `list_untested` | 所有「未测」模块 id + 计数 |
| `report_note` | 给模块写自由备注（≤2000 字符；空串清除） |

## MVP 边界（明确不做）

- **Python 等其他语言解析**——只静态分析 `ts / tsx / js / jsx` 的 import
- **多项目根**——单进程只监视一个 `--root`
- **历史持久化**——图与备注均在内存，进程退出即失
- lint 错误收集、agent 备注编辑 UI

## 开发

```bash
npm run build          # 构建产物在 dist/（运行时读取）
npm test               # vitest 全量（冒烟 / e2e 测试会 spawn dist/server/index.js，改完 src 先 build）
npm run typecheck:web  # 前端 tsconfig 单独检查
```
