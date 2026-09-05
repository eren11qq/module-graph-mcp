<div align="center">

# module-graph-mcp

### 实时模块依赖图 —— 给你的编码 Agent 一部「显微镜」

**浏览器实时图 · stdio MCP 双通道 · 14 个工具 · AI 动过哪里一眼可见 · 100% 本地**

<br>

<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b0e8ff?style=flat-square&labelColor=0a0e14" alt="license"></a>
<a href="https://github.com/eren11qq/module-graph-mcp/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/eren11qq/module-graph-mcp/ci.yml?style=flat-square&labelColor=0a0e14&label=CI" alt="CI"></a>
<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520-3c873a?style=flat-square&labelColor=0a0e14" alt="node"></a>
<a href="#quick-start"><img src="https://img.shields.io/badge/Windows-supported-4cc2ff?style=flat-square&labelColor=0a0e14" alt="Windows"></a>
<a href="#quick-start"><img src="https://img.shields.io/badge/macOS-supported-4cc2ff?style=flat-square&labelColor=0a0e14" alt="macOS"></a>
<a href="#quick-start"><img src="https://img.shields.io/badge/Linux-supported-4cc2ff?style=flat-square&labelColor=0a0e14" alt="Linux"></a>

<br>

<a href="#接入-mcp-客户端"><img src="https://img.shields.io/badge/MCP-stdio%20JSON--RPC-b389f0?style=flat-square&labelColor=0a0e14" alt="MCP stdio"></a>
<a href="#features"><img src="https://img.shields.io/badge/tools-14%20个%20MCP%20工具-b389f0?style=flat-square&labelColor=0a0e14" alt="14 tools"></a>
<a href="#配置参考"><img src="https://img.shields.io/badge/privacy-仅绑定%20127.0.0.1%20·%20零远程调用-2dd4bf?style=flat-square&labelColor=0a0e14" alt="local only"></a>
<a href="#配置参考"><img src="https://img.shields.io/badge/safety-只读模式%20·%20审计错误-2dd4bf?style=flat-square&labelColor=0a0e14" alt="read-only mode"></a>
<a href="#acknowledgements"><img src="https://img.shields.io/badge/a11y-Okabe--Ito%20色盲安全配色-2dd4bf?style=flat-square&labelColor=0a0e14" alt="colorblind safe"></a>

</div>

> [!IMPORTANT]
> 不要从 MCP 市场 / 插件市场安装——那里的安装命令往往过时。请跟随下方的 [Quick Start](#quick-start)。

## Contents

- [30 秒理解](#30-秒理解)
- [How It Works](#how-it-works)
- [Features](#features)
- [Quick Start](#quick-start)
- [接入 MCP 客户端](#接入-mcp-客户端)
- [配置参考](#配置参考)
- [设计文档与决策记录](#设计文档与决策记录)
- [MVP 边界（明确不做）](#mvp-边界明确不做)
- [开发](#开发)
- [Acknowledgements](#acknowledgements)

## 30 秒理解

* **一个 Node 进程，双通道服务**：既是**本地 dashboard**（浏览器里的实时模块依赖图），也是 **stdio MCP server**（编码 agent 直接查询图与源码）。
* 文件增删改经 chokidar 监听 → 增量重分析 → 测试状态 / 类型错误 / AI 评审结论通过 WebSocket 实时推帧，页面**免刷新**。
* Agent 侧提供 **14 个 MCP 工具**：拉全图、查爆炸半径、声明改动边界、提交逐行评审——AI 动过哪里、查过哪里，人在图上**一眼可见**。

## How It Works

单个 Node 进程持有依赖图与状态机，同时向两侧输出：向上经 **stdio JSON-RPC** 服务编码 Agent / MCP 客户端（评审结论、改动申报、测试结果由此回流），向下经 **HTTP 127.0.0.1 + WebSocket** 推浏览器 Dashboard（力导向图 / 健康报告页）；被监视项目根目录经 chokidar 监听 + 增量解析源源喂图。

静态分析 `ts / tsx / js / jsx` 的 import，构建**文件级依赖图**：球色 = 测试状态，红环 = 类型错误，红色虚线弧 = 循环依赖。它不替代 agent 的内置工具，而是补上 agent 缺的那块**结构性信任**：agent 负责 speed，module-graph 负责 trust。

## Features

<details>
<summary><b>Dashboard 能力</b></summary>

* **依赖图渲染**：文件级小球 + 依赖箭头；球色 = 测试状态（Okabe-Ito 色盲安全四色）；红环 = 类型错误；红色虚线弧 = 循环依赖；球大小随依赖度数增长
* **节点详情**：点击锁球 → 测试状态 / 覆盖它的测试文件 / 类型错误列表（含行号）/ 入出边跳转 / 语法高亮源码（错误行标记）
* **视图控制**：搜索框（大小写不敏感）、「只看未测」过滤、[模块视图 | 文件视图] 分段切换（ADR 0002：功能类成堆、堆间连模块级边；未聚焦即海报模式）
* **排列双模式**（ADR 0004）：顶栏「聚类 / 区域」开关——聚类 = Louvain 社区 + 黄金角螺旋的确定性海报；区域 = 目录区域 + 罗盘海报；两模式统一 `separateAllBalls` 硬保证任意两球边到边 ≥32px
* **AI 检查可视化**：`begin_review` → 球边缘呼吸脉冲 +「检查中」；`update_review` 分批推送 → 源码行实时逐行上色；`end_review` → 三色高亮（绿 confident / 黄 unsure / 红 error）+ 球外圈评审环；`get_module_details` 每次读取让对应球紫色脉冲 3 秒、ticker 闪「AI 正在查看 …」
* **探索可见 / 多会话一页**：同仓库新会话不再弹第二个浏览器窗口，其 AI 活动自动转发到主 dashboard 页
* **单主题定稿**：dark 暗色仪器盘——亮色工作台已经架构评审退役（2026-09），色板单源 `CY_PALETTE`，TS ⇄ CSS 等值钉防漂移
* **图例**：灰=未测、蓝=有测试未跑、绿=通过、红(橙)=失败；评审环行（绿/黄/红），点击可隐藏 / 显示已评审节点
* **健康报告页**：`GET /api/report`——固定整数权重表打分、items 风险降序、中文简报 top 5；支持 `?focus=<module-id>` 深链高亮（服务端拼装 HTML，无脚本无新依赖）

</details>

<details>
<summary><b>MCP 工具（14 个）</b></summary>

| 工具 | 说明 |
|---|---|
| `get_dashboard_info` | dashboard 地址、被监视根目录、节点/边计数：每会话先调它核实监视的树，并把链接给用户 |
| `get_module_graph` | 全图：文件级节点（测试状态 / 类型错误 / AI 评审）+ import 边 |
| `get_module_details` | 单模块详情：状态、coveredBy、类型错误、AI 评审、入出边、context 统计（入出度 / 在环上 / 中心度）、源码全文（>512KB 截断）、备注；读取会让该球短暂亮起紫色脉冲 |
| `get_impact` | 爆炸半径：upstream（谁依赖它）/ downstream（它依赖谁）按 BFS 深度分组，含测试状态与类型错误数；`direction` 默认 both、`maxDepth` 默认 3 上限 10 |
| `get_change_impact` | 变更证据链：watcher 记录的最近变更 + 每个在图变更的波及面与风险级（波及在环上或高中心度 → high；受影响 >10 → medium；否则 low）；记录落盘、重启回灌 |
| `declare_edit_scope` | 开工前声明改动边界（modules + files 双通道）；新声明覆盖旧声明、重启即清 |
| `report_edits` | 改完上报实际改动：服务端交叉验证，**越界改动**与**漏报**都判红（红角标 + 状态栏警示条） |
| `list_untested` | 所有「未测」模块 id + 计数 |
| `get_health_report` | 确定性健康报告：固定整数权重表打分（高中心度=3、未测=2、类型错误=2、在环上=1、评审 error=2，同分按 id 字典序），items 风险降序 + 中文简报 top 5 |
| `report_note` | 给模块写自由备注（≤2000 字符；空串清除），实时出现在详情面板 |
| `begin_review` | 标记进入 AI 检查：球开始脉冲；响应内嵌评审 playbook（三色 verdicts 定义 / 分批节奏 / 配对纪律） |
| `update_review` | 检查中分批推送部分 verdicts，源码行实时逐行上色 |
| `end_review` | 提交逐行 verdicts（`confident/unsure/error`，≤500 条、每行最后一条生效）；三色与评审环上屏 |
| `report_test_run` | 上报刚跑完的测试结果 `{ failed: true \| false }`：覆盖率报告内文件整批转红 / 回绿 |

**推荐工作流**：改码前 `declare_edit_scope` 声明边界 → `get_impact` 看爆炸半径 → 改码 → `report_edits` 核对 + `get_change_impact` 串证据链 → 跑测试后 `report_test_run`。所有 MCP 客户端工具（Claude Code、Codex、Kilo Code、ZCode、Cursor 等支持 stdio MCP 的均可）通用。

</details>

## Quick Start

**前置条件**：Node ≥ 20、git。

### 1. 安装

一条命令（克隆到 `~/.module-graph-mcp`、构建、把 `module-graph` 命令放进 PATH）：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/eren11qq/module-graph-mcp/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/eren11qq/module-graph-mcp/main/install.ps1 | iex
```

### 2. 验证安装

直接跑仓库自带的 demo 项目（`--open` 启动即弹页）：

```bash
module-graph --root ~/.module-graph-mcp/test-fixtures/sample-app --open
```

看到浏览器弹出小球连线图即安装成功。升级 = 重跑同一条安装命令。

### 3. 接入与监视

**接入你的 MCP 客户端**见 [接入 MCP 客户端](#接入-mcp-客户端)；想监视自己的项目，把 `--root` 指向该目录即可。

<details>
<summary><b>手动安装（开发 / 贡献者，从源码）</b></summary>

```bash
git clone https://github.com/eren11qq/module-graph-mcp.git
cd module-graph-mcp
npm install
npm run build          # tsc 编译服务端 + vite 打包前端到 dist/server/public
node dist/server/index.js --root ./test-fixtures/sample-app
```

</details>

## 接入 MCP 客户端

单进程双通道：注册进 MCP 客户端不影响浏览器 dashboard（同一进程同时服务 stdio 与 HTTP）。路径请换成你机器上的绝对路径——用一键脚本装过的话，入口就是 `~/.module-graph-mcp/dist/server/index.js`。

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

### ZCode

在 `~/.zcode/cli/config.json` 注册（用户级，所有会话自动连接）：

```json
{
  "mcp": {
    "servers": {
      "module-graph": {
        "type": "stdio",
        "command": "node",
        "args": ["<本仓库绝对路径>/dist/server/index.js"],
        "timeoutMs": 60000
      }
    }
  }
}
```

不传 `--root` 时服务端回退到子进程 cwd；弹窗行为与同仓库多会话共享策略详见 [配置参考](docs/CONFIGURATION.md)。

## 配置参考

所有人类可读日志走 **stderr**——stdout 属于 MCP JSON-RPC 协议通道。服务只绑定 `127.0.0.1`，是本地单机工具。

常用开关：`--root`（被监视项目根）、`--port`（默认 24282，被占自动 +1）、`--open` / `--no-open`（弹窗策略）、`MODULE_GRAPH_MCP_READ_ONLY`（只读模式）、`MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS`（响应体积预算）。

完整 CLI 选项表、环境变量、弹窗策略、测试状态判定规则见 **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**。

## 设计文档与决策记录

* [docs/MODULE-DESIGN.md](docs/MODULE-DESIGN.md) —— 模块接口表（Standards 轴度量基准）
* [docs/adr/](docs/adr/) —— 架构决策记录（ADR 0001–0004）
* [COMPROMISES.md](COMPROMISES.md) —— 已知妥协清单（每处「先这样」的代价与回头修触发条件）

## MVP 边界（明确不做）

* **Python 等其他语言解析** —— 只静态分析 `ts / tsx / js / jsx` 的 import
* **多项目根** —— 单进程只监视一个 `--root`
* lint 错误收集、agent 备注编辑 UI

## 开发

```bash
npm run build   # 先构建（测试与 evals 会 spawn dist 产物）
npm test        # vitest 全量
npm run evals   # evals probe 基准（不变量断言 + maxMs/maxBytes 硬门槛）
```

贡献流程、evals 任务注册表对账规则、PR 约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## Acknowledgements

* 爆炸半径与变更证据链方法论移植自 **GitNexus**
* 图渲染基于 **cytoscape.js** + **cytoscape-fcose**（力导向布局）与 **Louvain** 社区发现
* 测试状态配色采用 **Okabe-Ito** 色盲安全调色板
* README 结构与工程实践参考 **[Serena](https://github.com/oraios/serena)**；页面排版版式（居中式徽章矩阵 / Contents 目录 / 编号上手）参考 **[codegraph](https://github.com/colbymchenry/codegraph)**
