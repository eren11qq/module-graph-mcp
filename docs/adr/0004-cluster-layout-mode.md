# ADR 0004: 排列双模式——区域罗盘 / 聚类螺旋（Layout mode: regions vs clusters）

- 状态：已接受（2026-09-01）
- 关联：ADR 0003（单档存档，本轮不推翻只并列加字段）；`src/web/communities.ts` /
  `src/web/layout-cluster.ts`（新增）、`graph-view.ts` / `graph-areas.ts` /
  `layout-store.ts` / `theme.ts` / `main.ts` / `index.html`（修改）；
  测试 `tests/communities.test.ts` / `tests/layout-cluster.test.ts`

## 背景

区域化海报（2026-08-29）按**目录前缀**分堆，与真实 import 结构无关——一个被十个
模块引用的 `src/shared/types.ts` 只是「脊柱区的一员」。GitNexus 式聚类布局提出
另一视角：小球按**依赖社区**成团，团在黄金角螺旋上领中心，聚类关系第一次直接可
见。用户裁定（grilling）：不做二选一，顶栏加「排列：聚类/区域」分段开关，两模式
并存，per-root 记忆。

## 决策

1. **自研确定性 Louvain**（`communities.ts`，约 200 行，零新依赖）：Leiden 无 npm
   发布（GitNexus 也是 vendor），Louvain 两阶段（局部模块度增益移动 + 聚合重跑）
   百行可审计。确定性三钉：节点按 id 排序迭代、真并列收益用固定种子 mulberry32
   择一、权重恒为整数（浮点加法组合序无关）。resolution 固定 1.0（教科书原值，
   记 COMPROMISES 12）。同图必同分团。
2. **聚类求解不读存档，确定性优先于拖拽保留**（D2 搁置）：`currentLayout()` 在
   聚类模式返回空 Map，每个球按 `fnv1a(path)` 出生在自己的聚类领地中心（角度
   `hash%360`、半径比例 `(hash>>>8)%100`、幅度 `jitterScale·√n`），fcose
   (randomize:false) 就地精修，收尾走**全局最小距离硬保证** `separateAllBalls
   (ballGap: 32)`（同日修正 D3：原「同聚类 `separateTouching`」漏掉跨聚类对）。
   拖拽行为零特判：drop 点照旧写档（为区域模式服务），但聚类重渲时被确定性重解
   覆盖——「只活到下一次重渲、切回区域即复活」如实记 COMPROMISES。
3. **单档 write-through**（D5，不推翻 ADR 0003）：两模式共用一份「最后稳定布局」，
   切模式 = 换一种重排方式，上一次求解的落点就是这一次的种子。不做模式分档存档；
   模式本身作为 `modes: Record<rootPath, LayoutMode>` 并列顶层字段进存档
   （D1，不升 `ARCHIVE_VERSION`——升版本 = 全档作废，违背向后兼容；缺省同日
   修正为 `'cluster'`（R2），脏值回落同此）。切换瞬间的视觉跳变是预期行为。
4. **孤儿 = 单例社区**（D3）：零连线球在 Louvain 中自然成为单例社区，照常上螺旋
   领中心，管线零特判；聚类模式没有孤儿坞。
5. **聚类仅空间表达**：测试状态、评审环、类型错误环、改动标记、过滤、入出场编排
   全部通道零改动；新文件球（applyDelta）在聚类模式下同样走全量重解，无增量特判。
6. ~~**区域模式逐行不动**~~（同日修正 D3，见下）：`graph-areas.ts` 除
   `separateTouching` 加 export 外新增 `separateAllBalls`（全场硬保证通道），
   罗盘管线本身（applyRegionLayout/computeRegionSlots）仍逐行不动；区域模式的
   行为变化仅限「游离球/跨区对也会被分离到 ≥ ballGap」——正是本轮诉求。
   回归门：graph-areas / layout-store / graph-view 测试全绿。

## 同日修正（2026-09-01 用户裁定 R2/D2/D3，grilling 二轮）

- **D1 缺省翻转**：首次加载 / 无模式记录 → **cluster**（聚类海报开场），
  区域模式保留在顶栏开关。`layout-store` 白名单同步翻转：只认显式
  `'regions'`，其余（缺省/脏值）一律 cluster；`ARCHIVE_VERSION` 仍为 6。
- **D2「固定距离」口径**：静止基准下任意两球边到边 ≥ ballGap(32)；漂移动效
  保留（最坏逼近 ≈10.2px，永不重叠）。
- **D3 全局最小距离硬保证**：`separateAllBalls`（graph-areas.ts）对全场
  非题注球跑 `separateTouching`，两模式 applyLayout 收尾统一接（跑在
  rebase/persist 之前——分离落点自动成 drift 基准与存档落点）；regions 侧
  在区内分离 + 罗盘平移**之后**兜底，游离球与跨区贴边对从此有人管。
  同笔：`REPULSION_BASE` 20000→40000（×2）加大非邻接排布间距；`gravity`、
  `SPACING_GAP` 不动。
- **收敛事实（计划假设 60 轮上限，实测不成立）**：Gauss-Seidel 逐对全量推送
  是渐近收敛——50 球紧贴网格无容差时残余违例永不归零（140 轮仍差 ~1e-5、
  moved 早退不可达）。修法不是加轮数裸奔，而是满足判据加 1e-6px 容差
  （残差 ≤1e-6 即视为满足、真早退，141 轮收工），上限取 200 兜病态堆。
  测试「稠密堆收敛」常驻回归门，≥gap 断言未放宽。

## 实现期事实修正（对计划的偏离，均有测试钉死）

- **fcose 确定性**（计划修正点 4 的风险排查）：真实 cytoscape headless 实测——
  同图同起始位 fresh 实例两次求解、同实例回播出生点再解，两种路径都**逐位全等**；
  差异只出现在「不清位直接重解」（起点变了）。测试
  `钉死修正点 4：同图两次全量重解落点逐位全等` 常驻回归门。
- **「环图单社区」不成立**：Blondel 增益必须按「i 已虚拟脱离现群」计 σ（否则弱桥
  相连的两坨也会算出假合并增益）。修正后 5-环按模块度真相裂成 3+2 两段弧
  （Q>0），完全图（三角形/K5）才保持单社区。测试忠实断言真实行为，未放宽预期。
- **确定性口径**：「重载后布局完全一致」指求解静止基准（drift base / 存档落点）；
  physics 漂移的 `Math.random` 振幅/相位天然非确定，不在口径内。

## 同日修正二（2026-09-01 海报质量三修 + 标签节流，计划 1788249253048）

四笔改动 + 三处对计划提示词/假设的事实修正（均有 headless 实测与钉死测试）。

### 对提示词的事实修正

- 原提示词引的 fcose「现值」(gravity 0.32 / nodeRepulsion 13 500 / idealEdgeLength
  78 / nodeSeparation 120 / numIter「默认未标」) **全部引错**：实际基线是
  gravity 0.25、尺寸感知 nodeRepulsion（REPULSION_BASE 40000）、函数式
  idealEdgeLength（spacingGap 52 + 两端半径）、nodeSeparation 150、numIter
  默认 2500（fcose 源码 index.js/cose.js 核实）。
- 「测试球降权 0.25」与「排除出 Louvain + 多数票」是两个互斥方案，取后者
  （D3）：Louvain 输入 = 非测试球 + 两端皆 src 的边，重边计数天然是整数权重,
  communities.ts 内核**零改动**。测试球判定与 graph-areas PATH_REGIONS 同口径
  （tests/、test-fixtures/ 前缀），刻意本地小函数不 import，管线互不耦合。

### 四笔改动

- **测试球归属（D3/Root 2）**：`isTestPath` + `assignTestBalls`（layout-cluster）
  ——out 边（imports）指向的 src 社区多数票、重边按条计票；无 out 票退化为全
  邻居（in∪out）多数票；平票取最小 clusterIndex；无票成单例（下标 = 现有最大
  +1、按 id 升序）。全程无随机，与 D5 的逐位全等口径一致。
- **领地标定（D4/Root 3）**：`planTerritories(requiredRadii)` 取代
  `clusterCenter(index,count)`——黄金角极角序不变，半径从下限 spiralScale·√(i+1)
  起步、逐簇线性外扩 +8px 直到中心距 ≥ max((Ri+Rj)×1.4, Ri+Rj+64)（1.4 系数
  让大簇留白随面积涨，64px 下限救小簇）。spiralScale 语义降为「半径下限」。
- **fcose 保种（D1/Root 1——机制实测换轨）**：计划假设「birth + 整图一次
  fcose(randomize:false) 覆盖 numIter/gravity 即可保种」，headless 实测**破产**
  ——fcose 求解只经 `relocateComponent` 把每个连通分量的包围盒中心送回原位，
  形状整体重算，跨簇弱边把各团经弱桥拽回一坨；另抓到一发更阴的雷：
  `cy.layout({ eles: cy.getElementById([数组]) })` 里 getElementById 只吃单串
  id（`'' + id` 强转查询 → 空集合 → layout 静默空跑、逐位不动）。现行通道：
  ① 每社区独立 eles（filter+union 构造）单解一次，团形只由簇内弹簧
  （clusterIdealEdgeLength = ballGap 32 + 两端半径，D2）与簇心引力决定，relocate
  恰好把团送回出生领地心；② `anchorClusterTerritories` 按精修后的真实团形
  （外接圆 + ballGap 垫圈、√2 方阵化）重跑 planTerritories 并刚体平移归位；
  ③ `clusterFcoseOverrides()`（numIter 600 / gravity 1.2 / D2 边长）只进聚类
  分支，THEME.fcose 共享对象一字不动、regions 逐行如旧。
- **标签节流（D5/Root 4）**：基础 `node` 规则 label 清空，`node.labeled`（JS
  节流通道）与 `node.focused`（聚焦并行通道）各自接回 `data(label)`；题注板
  规则独立不受影响，hover 信息本就走 tooltip 通道。视口内球数 ≤ 40 全开、
  超出只标度数前 24（度降序 + id 升序决胜，基于可见球，`THEME.labels`）；
  hub 集在 renderVisible/applyDelta 缓存，zoom/pan 事件只重判视口、同步 batch
  切 class（无 rAF 状态）。

### 验收数值口径的落地修正

计划验收 2「成员球心到簇心 ≤ R_i + 2×平均球半径」把 R_i 定在等面积下限
（√(Σr²)×1.5）——与冻结的球距机制直接打架：ballGap 32 + r12 球把相邻球心距顶到
≥56px，二跳成员天然站到 ~85px 外（下限由间距机制决定、非布局质量）。改钉两条
真实约束：簇内每边 ≤ 理想边长 + 2×ballGap（团不被撕开）、团外接圆 ≤ 等面积
半径 ×3（团不炸开）（layout-cluster.test 管线套件，真实 headless fcose）。
验收 1（两两 bbox 间隙 ≥ 64）、验收 4（逐位全等两测试）按原样成立并常驻。

## 后果

+ import 结构第一次成为一等视觉事实；跨重载逐位可复现的聚类海报。
+ 顶栏布局存档仍是一份文件（modes 并列字段），「重置布局」语义不变（只清位置）。
− 聚类模式下手摆位不跨重渲保留（D2 明知搁置）。
− Louvain resolution 不可调、无 Leiden 的连通性修正——小图无所谓，巨型 monorepo
  可能出现病态碎团（回头修触发条件见 COMPROMISES 12）。
