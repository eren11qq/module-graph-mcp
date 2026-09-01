# ADR 0003: 模块视图 UI 退役，文件海报成为唯一视图（模块表保留）

- 状态：已接受（2026-09-01）
- 修正：ADR 0002 §7.1 / `docs/MODULE-DESIGN.md` §7.1（模板模式与模块视图）——
  §7.2 改动核对不受影响，模块表与其契约面原样保留
- 关联：`docs/MODULE-DESIGN.md` §2/§6/§7；evals 探针 `edit-scope-verification`（零变更通过，
  作为服务器 wire 契约未破坏的回归哨兵）

## 背景

ADR 0002 引入的模块视图（六堆固定模板位 + 模块级边 + `pile:<id>` 题注钻取）与保留的
文件视图（fcose + 区域化海报 + `graph-areas` 罗盘）是**两套聚类视图**：同一张模块表在
画布上投影两次，交互语义（点堆 / 聚焦 / 分档存档）互相缠绕，`viewMode`/`focusedModule`
穿透 graph-view 15+ 处。2026-09-01 用户复议裁定：体验差异可接受但冗余不除不清，删除
模块视图，文件视图（区域化海报）成为唯一视图。同轮复议明确保留：弹窗策略链、跨实例
relay、`/api/report`、`physics.ts`。

## 决策

1. **删除模块视图 UI**：`src/web/module-view.ts` 整删（六堆模板位、`pile:` 词表、
   模块级边聚合、点堆钻取随之消失）；`ViewState` 删 `viewMode`/`focusedModule`，
   工具栏 segmented 切换删除；`deriveScopeMarks`（三条改动标记通道判定）是唯一
   保留面，迁入 `graph-filters.ts` 成为纯 data-in/data-out seam。
2. **模块表保留**：`src/shared/module-table.ts` 与 `declare_edit_scope` 的 `modules`
   通道原样不动——它是 agent 圈定改动范围的**省 token 手段**（一句模块名展开成整棵
   文件清单），供服务端核对器（ADR 0002 §7.2）与 `get_dashboard_info` 清单消费，
   与画布投影无关。
3. **布局存档单档化**：layout-store 从 rootPath+模式双键收敛回 rootPath 单档
   （档案 v5→6，旧分档条目整体作废、不迁移）；「重置布局」全清。

## 行为变化（文档已同步 MODULE-DESIGN §7.1）

- 打开 dashboard 直接是文件视图海报，区域罗盘（graph-areas）无条件生效。
- 搜索命中文件 → 直接定位高亮文件球（「自动聚焦其所在功能类」的钻取语义随视图消失）。
- 表外文件不再「只在文件视图出现」——本来就有这一视图。

## 后果

- **服务器端零改动**：mcp.ts / edit-scope.ts / module-table.ts / evals 全不碰；
  `edit_scope` / `edit_verification` 广播事件与三条标记通道（in-scope 紫环 /
  edited 紫填充 / out-of-scope 红⛔）行为不变。
- **难逆程度低**：纯前端删除，回滚 = `git revert` 本轮单提交（文档与测试同提交内），
  无数据迁移欠账（旧存档本就作废）。
- **权衡**：模块级边「堆对堆一眼看模块关系」的信息密度由 graph-areas 区域罗盘部分
  承接（同一条功能类路径事实源）；若日后要恢复，git 历史里有完整实现。
