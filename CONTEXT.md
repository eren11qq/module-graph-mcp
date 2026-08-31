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
  配对纪律。关键节逐字断言；改文本必须连带探针同一 PR。
