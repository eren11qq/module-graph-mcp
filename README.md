# module-graph-mcp

实时模块依赖图：一个 Node 进程同时是 **本地 dashboard**（浏览器里看小球连线图，点击查看测试状态 / 类型错误 / 源码）和 **stdio MCP server**（编码 agent 可直接查询图与源码）。文件改动经 chokidar 监听，通过 WebSocket 实时推送到页面。

## 功能一览

- **依赖图渲染**：文件级小球 + 依赖箭头；球色 = 测试状态（Okabe-Ito 色盲安全四色）；红环 = 类型错误；红色虚线弧 = 循环依赖；球大小随依赖度数增长
- **实时更新**：文件增删改 → 增量重分析 → `graph_delta` / `node_update` 推帧，页面免刷新
- **节点详情**：点击锁球 → 测试状态 / 覆盖它的测试文件 / 类型错误列表（含行号）/ 入出边跳转 / 语法高亮源码（错误行标记）
- **视图控制**：搜索框（大小写不敏感匹配路径与文件名）、「只看未测」过滤、**[模块视图 | 文件视图]** 分段切换（ADR 0002：默认模块视图——文件球按功能类成堆、堆与堆之间连模块级边；点堆进入该功能类的文件视图；文件视图未聚焦时即海报模式）
- **MCP 查询**：agent 可拉全图、查单模块详情、列未测模块、写备注（备注实时出现在 dashboard 详情面板）
- **健康报告**：MCP `get_health_report` 工具与 `GET /api/report` 验收报告页——固定整数权重表打分（高中心度 / 未测 / 类型错误 / 在环上 / 评审 error），items 风险降序、同分按 id 字典序，中文简报 top 5；报告页支持 `?focus=<module-id>` 深链高亮（服务端拼装 HTML，无脚本无新依赖）
- **爆炸半径与变更证据链**（GitNexus 移植）：改代码前 `get_impact` 看一个模块的波及面（upstream/downstream 按 BFS 深度分组、含测试状态与类型错误数）；改完后 `get_change_impact` 回放 watcher 记录的最近变更（仅内存、上限 100 条）并逐变更给出风险级（波及在环上或高中心度 → high；受影响 >10 → medium；否则 low）；`get_module_details` 响应新增 `context` 统计（入出度 / 在环上 / 归一化中心度）
- **AI 检查通道**：agent 审查前调 `begin_review` → 球边缘呼吸脉冲 + 面板「检查中」（响应内嵌评审 playbook：三色 verdicts 定义、分批节奏与配对纪律）；过程中 `update_review` 可分批推送部分 verdicts，源码行实时逐行上色；完成后 `end_review` → 逐行三色高亮（绿 confident / 黄 unsure / 红 error）+ 球外圈评审环（红环 = 有 error、黄环 = 有 unsure、绿环 = 全 confident）+ 详情面板「AI 已检查」徽章；检查约 10 分钟无活动自动回落
- **探索可见**：agent 每读一个模块（`get_module_details`），对应球以紫色「查看」脉冲亮 3 秒、ticker 闪「AI 正在查看 …」——浏览文件不再是黑箱
- **多会话一页**：同仓库新会话不再重复弹浏览器页（也不会闪控制台黑框）；它的 AI 活动（查看脉冲 / 检查脉冲）自动转发到第一个 dashboard 页上
- **测试运行上报**：agent 跑完测试调 `report_test_run` → 覆盖率报告内文件整批转红 / 回绿
- **双主题**：暗色仪器盘（默认）/ 亮色工作台，顶栏切换、localStorage 记忆，画布与壳层联动

## 快速开始

前置：Node ≥ 20。

```bash
git clone <本仓库> module-graph-mcp
cd module-graph-mcp
npm install
npm run build          # tsc 编译服务端 + vite 打包前端到 dist/server/public
node dist/server/index.js --root ./test-fixtures/sample-app
```

启动**不弹浏览器**——桌面端（如 ZCode）打开时会为每个项目拉起一个 server 进程，弹窗按**文件粒度**后移：agent 通过面向文件的 MCP 工具（`get_module_details` / `begin_review` / `update_review` / `end_review` / `report_note`）**打开某个文件**时，才为该文件自动打开 dashboard（默认 `http://127.0.0.1:24282`，端口被占自动 +1）；同一文件只弹一次，agent 没打开过的文件绝不弹（`get_dashboard_info` / `get_module_graph` 等无文件工具不触发）。**同仓库一个窗口**：被占端口按「端口带扫描」找同根实例——找到则本进程保持无头、永不弹页，其工具事件转发到主实例页面（转发事件指名的文件同样按文件粒度触发主实例弹窗）；整个端口带都是异根/空闲时本进程 armed。只想复现界面 demo，用仓库自带的 `test-fixtures/sample-app` 加 `--open` 即可。要监视自己的项目，把 `--root` 指向该目录。

**测试状态判定**：主判定读 `coverage/coverage-summary.json`（vitest/jest 覆盖率报告，**存在即通过——MVP 不设覆盖率阈值**；agent 通过 `report_test_run` 上报失败运行后，报告内文件转红）；没有覆盖率数据时按命名约定兜底——存在同名 `*.test.ts(x)` 视为「有测试未跑」，否则「未测」。

## CLI 选项与环境变量

| 选项 | 说明 |
|---|---|
| `--root <dir>` | 监视的项目根目录（默认当前目录；必须是已存在的目录） |
| `--port <n>` | dashboard 端口（默认 24282；被占用自动递增） |
| `--open` | 启动时立即弹页（无视同仓库去重；不带它则按上面的弹窗策略等首次活动） |
| `--no-open` | 从不自动打开浏览器（CI / 测试环境用；优先级高于 `--open`） |
| `--version` | 打印版本号后退出（不启动服务） |
| `MODULE_GRAPH_NO_OPEN=1` | 同 `--no-open` 的环境变量形式 |
| `MODULE_GRAPH_MCP_READ_ONLY` | `1` = 只读模式：7 个变更类工具（`report_note` / `begin_review` / `update_review` / `end_review` / `report_test_run` / `declare_edit_scope` / `report_edits`）不注册、调用被拒（审计友好错误）；分析类工具保持可用。unset / `0` = 关；其他值启动即报错退出 |
| `MODULE_GRAPH_MCP_DEFAULT_MAX_TOKENS` | 默认响应 token 预算（正整数；非法值启动即报错退出）。工具调用参数 `_maxTokens`（正整数，非法静默忽略）可按次覆盖；超限响应在 UTF-8 边界截断并追加英文省略标记（含原始估算 token 数与收窄指引），截断后的 JSON 可能不完整——护栏文本优先 |

所有人类可读日志走 **stderr**——stdout 属于 MCP JSON-RPC 协议通道。服务只绑定 `127.0.0.1`，是本地单机工具。

## 界面交互

- 悬停：一跳邻域保持高亮，其余淡出；点击：锁定并打开详情（再点同球 / 点背景 / `Esc` 解锁）
- 搜索框：大小写不敏感，匹配路径与文件名；与「只看未测」可叠加（AND）
- **模板模式**（ADR 0002）：工具栏 [模块视图 | 文件视图] 切换，默认模块视图——文件球按功能类（模块表）成堆，堆与堆之间连模块级边（跨堆文件边聚合重连，保留跨模块环）；表外文件不进模块视图（只在文件视图出现）；点堆题注/文件球进入该功能类的文件视图，点空白回全部文件；模块视图模板位与文件视图存档按模式分档（重置布局两档全清）
- **改动核对**（ADR 0002 §7.2）：开工前 `declare_edit_scope {modules, files}` 声明边界（新声明覆盖旧声明、重启即清），改完后 `report_edits {files}` 上报——服务端用模块表展开范围 + watcher 磁盘事实交叉验证，越界改动（红角标 + 状态栏警示条 + tooltip 文案）与漏报都判红；范围内文件常驻紫环、已改整球变紫；read-only 模式下与其它变更类工具一起隐藏 + 审计拒绝
- 布局：力导向 fcose（唯一布局；早期的层级布局方案已裁定弃用，无切换快捷键）
- 图例：灰=未测、蓝=有测试未跑、绿=通过、红(橙)=失败，及依赖边 / 循环依赖线型；AI 评审环行（绿=全 confident / 黄=有 unsure / 红=有 error），点击该行隐藏 / 显示已评审节点

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
| `get_module_graph` | 全图：文件级节点（测试状态 / 类型错误 / AI 评审）+ import 边 |
| `get_module_details` | 单模块详情：状态、coveredBy、类型错误、AI 评审、入出边、context 统计（入出度 / 在环上 / 中心度）、源码全文（>512KB 截断并标注 `truncated`）、备注；每次读取让该球短暂亮起紫色脉冲 |
| `get_impact` | 爆炸半径：upstream（谁依赖它）/ downstream（它依赖谁）按 BFS 深度分组（同深度按 id 字典序），每项含测试状态与类型错误数；`direction` 默认 both、`maxDepth` 默认 3 上限 10（非法回退 3）；未知 path 走自解释错误 |
| `get_change_impact` | 变更证据链：watcher 记录的最近变更文件（`{id, changedAt, inGraph}`）+ 每个在图变更的波及面（both 方向、深度 3）与风险级；返回 `overallRisk` 与中文启发式说明；记录仅内存（上限 100 条），服务重启即清 |
| `get_dashboard_info` | dashboard 浏览器地址、被监视根目录、节点/边计数：agent 每会话先调它核实监视的树对不对，并把链接给用户 |
| `list_untested` | 所有「未测」模块 id + 计数 |
| `get_health_report` | 确定性健康报告：固定整数权重表打分（高中心度=3、未测=2、类型错误=2、在环上=1、评审 error=2，同分按 id 字典序），items 风险降序 + 中文简报 top 5 |
| `report_note` | 给模块写自由备注（≤2000 字符；空串清除） |
| `begin_review` | 标记模块进入 AI 检查：球开始脉冲、面板显示「检查中」；与 `end_review` 配对使用 |
| `update_review` | 检查进行中分批推送部分 verdicts（格式同 `end_review`，与已有结论合并、同样新条覆盖旧行）：源码行实时逐行上色 |
| `end_review` | 提交逐行 verdicts（`confident/unsure/error`，1-based 行号；≤500 条、每行最后一条生效、message ≤200 字符、summary ≤500 字符）；球停止脉冲，三色与评审环上屏 |
| `report_test_run` | 上报刚跑完的测试结果 `{ failed: true \| false }`：覆盖率报告内文件整批转红 / 回绿 |

## 接入为 ZCode MCP 插件（推荐用法）

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

- **不传 `--root`**：服务端回退到子进程 cwd。**打开 ZCode 不弹页**——每个项目一个进程照常启动，但只有该项目会话的 agent **首次打开某个文件**（面向文件的 MCP 工具）或第一条指名该文件的同根转发事件到达时才弹浏览器，同一文件只弹一次；同一仓库跨会话共用一个窗口：后续会话静默（无头），其 AI 活动转发到第一页，且其 `get_dashboard_info` 直接返回主实例的链接，agent 交给用户的永远是那一页。`--open` / `--no-open` 可强制行为（env `MODULE_GRAPH_NO_OPEN=1` 等价后者）。
- agent 侧约定：会话内先调 `get_dashboard_info` 核实 `rootPath` 与 dashboard 链接；若监视的树不对，在该项目的 `<repo>/.zcode/config.json` 里用同名的 workspace 级条目（`--root` 传绝对路径）覆盖。
- 基线扫描期间握手**不会**被阻塞：`get_dashboard_info` / `get_module_graph` 即时应答并带 `scanning: true`；依赖图内容的工具（begin_review / get_module_details 等）自动等基线落定（上限 20s）再作答。

## MVP 边界（明确不做）

- **Python 等其他语言解析**——只静态分析 `ts / tsx / js / jsx` 的 import
- **多项目根**——单进程只监视一个 `--root`
- **评审常驻**——`end_review` 落地的三色结论写入 `<root>/.module-graph/reviews.json`（默认 gitignore），服务重启 / 弹窗页面关闭后重新打开仍然在；图与备注仍为内存态；检查中状态约 10 分钟无收尾自动回落
- lint 错误收集、agent 备注编辑 UI

## 开发

```bash
npm run build          # 构建产物在 dist/（运行时读取）
npm test               # vitest 全量（冒烟 / e2e 测试会 spawn dist/server/index.js，改完 src 先 build）
npm run evals          # evals probe 基准：逐任务冷启动 spawn dist 产物跑探针（也要求先 build）
npm run typecheck:web  # 前端 tsconfig 单独检查
```

### evals probe 基准

`npm run evals` 对 `test-fixtures/sample-app` 逐任务**冷启动**一个真实 server 进程，先按不变量断言（节点/边清点、错误自解释、评审生命周期等），再按 `maxMs` / `maxBytes` 门槛判红——响应体积是硬契约（见 `docs/adr/0001-evals-maxbytes-ci-contract.md`），超限即 CI 挂，runner 始终记录 p50/p95（ms 与 bytes 两列）。任务注册表在 `src/evals/tasks/registry.ts`，与磁盘双向对账：游离的任务文件、幽灵清单条目都会红（`tests/evals-structure.test.ts`）。CI 在四步流水线的第四步跑它（`npm ci → build → test → evals`）。

