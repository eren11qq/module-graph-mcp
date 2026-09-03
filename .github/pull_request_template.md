## 这个 PR 做了什么

<!-- 一句话 + 必要的展开；关联 issue：Fixes # / Relates to # -->

## Type of change

- [ ] Bug fix
- [ ] New feature / tool
- [ ] Documentation
- [ ] Refactor (no behavior change)

## Checklist

- [ ] `npm run build` 后 `npm test` 全绿
- [ ] `npm run evals` 全绿（改了 src 记得先 build）
- [ ] MCP 工具变化：README 工具表 + CLAUDE.md 速览 + `src/evals/tasks/` 探针任务已同步
- [ ] 接口/设计变化：`docs/MODULE-DESIGN.md` 或 ADR 已更新
- [ ] 新妥协 / 妥协条件变化：`COMPROMISES.md` 已更新
- [ ] `CHANGELOG.md` Unreleased 已记录
- [ ] 人类可读日志走 stderr，未污染 stdout（MCP 通道）
