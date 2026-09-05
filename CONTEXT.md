# CONTEXT.md — 域模型词条

**项目定位一句话**：AI 负责 speed，module-graph 负责 trust。

本文件只收词条——每个词是什么、在信任闭环里扮演什么角色。实现细节以
`docs/MODULE-DESIGN.md`（接口表）与 `docs/adr/`（裁定记录）为准。

---

- **EvalTask** —— 一条可执行的信任探针任务：`id` + 描述 + 探针函数 + 两条硬门槛
  （maxMs / maxBytes）。任务注册表与磁盘双向对账，游离文件与幽灵条目都算红。

- **probe** —— 探针：对一个**冷启动**的真实 server 进程发出的最小断言集。先断言
  不变量（图形状、错误自解释、生命周期、排序……），全部通过后才轮到门槛判红。
  每条任务独立起进程，探针之间零共享。

- **信任门（trust gate）** —— probe 必须整体通过才算绿的那道门：不变量 + maxMs +
  maxBytes 三者缺一即红。红 = CI 红 = 信任闭环拉响警报，而不是"下次再修"。

- **maxMs / maxBytes** —— 信任门的两个数值臂。maxMs 管冷启动耗时；maxBytes 管
  **响应体积**（整条 JSON-RPC 响应行的字节数求和）。二者都是写死在任务定义里的
  整数，初始值 = 实测 p95 × 1.5 向上取整；只有探针与文档同 PR 更新时才允许改
  （见 ADR 0001）。

- **简报（brief）** —— 健康报告给 agent 看的中文摘要：top 5 风险模块 + 剩余计数，
  逐字稳定（探针断言它的关键行）。排序契约在 items 数组里：固定整数权重表打分，
  同分按 id 字典序。

- **playbook** —— 评审方法论的内嵌文本：begin_review 的响应里带着稳定的三色
  verdicts 定义（confident / unsure / error）、update_review 分批节奏与 end_review
  配对纪律。关键节逐字断言；改文本必须连带探针同一 PR。预算数字（每行最后一条
  生效 / 500 条 / 200 / 500 字符）不手抄——从 review-lifecycle 的常量插值，
  探针按常量断言防回硬码（候选 #10，2026-09-05）；磁盘复活的评审经
  `normalizeVerdicts` 清洗，与 end_review 活路径恒等（候选 #2，同日）。

- **爆炸半径（blast radius）** —— 改一个文件之前先看的波及面：upstream（谁依赖它）
  与 downstream（它依赖谁）按 BFS 深度分组，每项带测试状态与类型错误数。
  get_impact 的产出；visited 集合让依赖环收敛，深度默认 3、上限 10。

- **变更证据链（change evidence chain）** —— 改完之后回放的「你刚动了什么、波及了
  谁、多危险」：watcher 窗口记录的**原始事件路径**（空 delta 的纯内容修改也记）+
  每个在图变更的波及面与风险级。get_change_impact 的产出；记录落盘
  `<root>/.module-graph/recent-changes.json`（上限 100 条），重启自动回灌。

- **只读模式（read-only）** —— 检查者可信的分权手段：`MODULE_GRAPH_MCP_READ_ONLY=1`
  启动时 5 个变更类工具不注册（tools/list 不可见），调用被拒并返回**专属审计错误**
  （区别于 Unknown tool）；分析类工具保持可用——只读会话仍可探索，只是写不进任何东西。

---

## 2026-08-31 模板模式轮（grilling 定案；模块视图 UI 已由 ADR 0003 于 2026-09-01 退役，模块表与改动核对词条保留）

- **功能模块（functional module）** —— 模块表的顶层分类单元：模块表按**功能**
  分类（例：剪辑类、登录类），模块名 + 路径清单（目录前缀或显式文件）把监视树切
  成若干功能类；每个功能类下辖若干小模块，**每个小球（一个文件）就是一个小模块**。
  本项目 v1 六个功能类：MCP 服务（src/server 对外接口面）/ 依赖图引擎（src/server
  内核面）/ Dashboard 渲染（src/web）/ 共享契约（src/shared）/ 信任探针（src/evals）/
  测试与样例（tests + test-fixtures）。仅供 `declare_edit_scope` 的 modules 通道
  展开与 `get_dashboard_info` 清单消费，无视图投影（ADR 0003）。

- ~~**模板模式（template layout）** —— 一种布局样式：小球按功能模块表排列；
  取代目录折叠。内含两个视图，工具栏切换：模块视图（默认）与文件视图。~~
  **已退役（ADR 0003）**：唯一视图 = 文件海报（fcose + 区域罗盘）。
  **消歧（ADR 0004）**：模板模式按**功能模块表**排列（人写的分类），与新的
  **聚类模式**按 **import 图的 Louvain 社区**排列是两回事——后者不读模块表。

- ~~**模块视图（module view）** —— 模板模式的默认视图：**所有小模块球直接按功能
  类排成堆**，每堆一个功能类（例：登录功能一堆），每个小球保留自身状态与标记；
  堆与堆之间以模块级边连线，一眼看到模块之间关系；点某堆进入该功能类的文件视图。~~
  **已退役（ADR 0003）**。

- **文件视图（file view）** —— 现在的**唯一视图**：显示文件球（全部文件，海报
  模式；模块视图退役后不再有聚焦/切换态）。点文件球开详情。

- ~~**模块级边（module-level edge）** —— 模块视图展示的依赖线：把跨模块的文件边
  聚合重连成模块对模块的边，保留「谁依赖谁」骨架与跨模块环。~~
  **已退役（ADR 0003）**。

- **编辑范围（edit scope）** —— agent 开工前声明的改动边界：`declare_edit_scope`
  的 modules + files。改动上报里落在范围外的文件叫越界改动。

- **越界改动（out-of-scope edit）** —— `report_edits` 上报的改动中不属于声明
  范围的文件；服务端用模块表核对并警示——AI 常修一处坏一处，核对不靠 AI 自觉。

- **范围标记（scope mark）** —— 编辑范围内文件的紫色环标记；改完后整球变紫
  （改动标记）。与测试球色、类型错误红环、评审环、查看紫脉冲互相区分。

---

## 2026-09-01 聚类排列模式轮（grilling 定案，ADR 0004）

- **排列模式（layout mode）** —— 文件海报的两条重排通道，顶栏「排列：聚类/区域」
  分段开关切换、per-root 记忆于布局存档并列的 `modes` 字段（不升存档版本）。
  **默认 = 聚类**（2026-09-01 用户裁定 R2：首次加载/无记录都以聚类海报开场）：
  - **聚类模式（cluster layout，缺省）** —— 确定性海报，四段管线：Louvain 社区
    （**测试球不进输入**，事后多数票挂靠，2026-09-01 D3）→ 每社区按面积需求半径
    领黄金角螺旋领地、成员 `fnv1a(path)` 出生 → **逐簇 fcose 精修 + 按真实团形
    重标定领地刚体归位**（2026-09-01 海报质量修正：整图一次求解只回送连通分量的
    包围盒中心，弱桥把各团糊回一坨，「保种」必须一簇一解）→ 全场
    `separateAllBalls` 硬保证收尾。聚类感来自真实依赖结构。求解**不读位置存档**
    （同图两次全量重解逐位全等）；孤儿 = 单例社区照常上螺旋，无孤儿坞；无盘无板
    无题注。
  - **区域模式（regions layout）** —— 现行管线：fcose + 目录前缀区域 + 罗盘平移
    + 题注板；聚类感来自人写的目录结构。THEME.fcose 共享力参数只归这条通道，
    聚类分支的 numIter/gravity/idealEdgeLength 覆盖不碰它。
- **球间最小距离硬保证（2026-09-01 D3）** —— 静止基准下任意两球边到边
  ≥ `ballGap`(32)：两模式收尾统一走全局 `separateAllBalls`（题注板除外，跨聚类对
  与区域模式游离球都在内），跑在 physics.rebase/persist 之前 → 分离落点即 drift
  基准与存档落点。漂移动效保留（最坏逼近 ≈10.2px，永不重叠）。
- **聚类（community）** —— Louvain 模块度意义下的依赖社区：自研确定性实现
  （`src/web/communities.ts`，零依赖），输出按「大小降序 + 最小 id」稳定编号；
  测试球（`tests/`、`test-fixtures/` 前缀）不进 Louvain 输入，事后按 out 边
  多数票挂靠（平票取小下标，无票单例），重边按条计票。
- **标签节流（2026-09-01 D5）** —— 球上标签走 class 通道：视口内球数 ≤ 40 全开；
  超出只给度数前 24（`node.labeled`），聚焦球靠 `node.focused` 并行通道永远亮字；
  hover 详情本就走独立 tooltip，题注板不受节流影响。
- **write-through 单档** —— 两模式共用一份「最后稳定布局」：任何模式求解落定后
  都回写存档，切模式 = 用对方的落点当种子重排（不推翻 ADR 0003 的单档裁定）。

---

## 2026-09-05 落盘卫生轮（grilling 定案；架构评审候选 #1）

- **落盘卫生层（dot-module store）** —— `<root>/.module-graph/` 下 JSON 状态
  文件的统一读写仪式：目录创建、自忽略 `.gitignore` 自举、tmp+rename 原子写、
  坏文件即空、schema version 信封、warn-once 闩、写失败降级仅内存（全路径
  绝不 throw）。**只管仪式，不管语义**——各状态文件自身的解码（reviews 的
  done-only、changes 的容量截断）与合并规则（墓碑并集 / per-id max）留在
  消费者；目录名 `DOT_MODULE_DIR` 单一事实源，server 消费者与信任探针的
  fixture 清理共用。住 `src/server/dot-module-store.ts`。

## 2026-09-05 fold-then-apply 轮（架构评审候选 #4）

- **调用即正确（fold-then-apply）** —— 浏览器图状态的三种帧（snapshot /
  graph_delta / node_update）由 `GraphView` 的 `applySnapshot` /
  `applyDelta` / `applyNodeUpdate` 在入口先折进注入的 model 再渲染——
  「先 `model.foldX` 后 `view.applyX`」的配对序曾是注释与 caller 纪律
  （frame-sink 三处 + 测试配对替身各抄一遍），现在住进 module 内部，
  render-before-fold 这类 bug 不可表达。`GraphModel` 的 fold 仍是全图
  唯一实现，但直接调用方只剩 graph-view 一家。

## 2026-09-05 主题单源轮（架构评审候选 #5）

- **等值钉（TS ⇄ CSS 逐色交叉断言）** —— 同一个视觉色在 `theme.ts`
  （画布侧）与 `styles.css`（chrome 侧）各存一份字面量，双主题时代测试
  各钉一侧、从不交叉，漂移只能靠肉眼在页面上撞见。现在
  `tests/theme-palette.test.ts` 解析 `[data-theme="dark"]` token 块与
  `CY_PALETTE` 逐色对账，改一侧忘另一侧即红——「两个可改点」变成
  「一个可改点 + 一个报警器」。`[data-theme]` 外壳保留是刻意的：
  将来加回第二主题 = 色板 + CSS 块 + 切换钮三件套，等值钉自动覆盖。
- **删即收敛（参数泄漏的最便宜解）** —— 「当前主题」本是漏成 module 级
  全局的一个参数：隐式消费者四个，切换必须按
  `setActiveTheme→setTheme→refreshDerived` 的序调，错序=旧色板残影。
  单主题化让这道参数整个消失——没有切换就没有顺序，`GraphView`
  接口 15→14，测试不再做手动 reset 全局舞。参数化重构未发生，
  因为参数没了好。
