# 文档地图（DOC-MAP）

## 事实归属

| 事实类型 | 唯一权威页 | 其它位置 |
| --- | --- | --- |
| 当前进度、待办、验证状态、版本 | [STATUS.md](./STATUS.md) | notes 只保留当时快照 |
| 架构、组件、数据流、不变量 | [ARCHITECTURE.md](./ARCHITECTURE.md) | ADR 解释动机 |
| 术语定义与禁用叫法 | [GLOSSARY.md](./GLOSSARY.md) | 正文首次出现可一句话解释 |
| 设计取舍、被否决方案 | [adr/](./adr/) | 只在 STATUS 放指针 |
| 版本变更流水 | [notes/dev-release.md](./notes/dev-release.md) | 现状看 STATUS |
| 事故/配对/实测过程 | `notes/*.md` | 标“历史快照”，不复述现状 |
| 网络/Relay 协议细节 | `notes/network-v1-v2-implementation.md` | 当前部署限制看 STATUS |
| 安装/使用入口 | 根 `README.md` | 本索引 |

## 落账规则

1. 新事实先判断属于哪一类，只写进对应权威页；
2. 同一结论不在两页展开，必要时只写一句话指针；
3. 新术语先写 GLOSSARY，再在正文使用；
4. 历史快照不改写成现在时；被推翻的现状结论在 STATUS 直接更新；
5. 新文档必须同时登记到 [README.md](./README.md) 的“按问题查”表。

## 历史快照清单

`docs/notes/` 下除 `dev-release.md` 外均为历史快照：

- `network-v1-v2-implementation.md`
- `relay-deployment.md`
- `room-replica-phase.md`
- `room-logic-phase.md`
- `pairing-session-2026-11-09.md`
- `remote-tests-2026-11-09.md`
- `incident-2026-11-09-boot-and-room-log.md`
- `approval-inbox-phase.md`
- `approval-panel-ui.md`
- `fleet-console-ui.md`
- `ui-surface-audit.md`
- `dsh-global-task-list-evaluation.md`
- `step1-host-plugin-and-direct-call.md`
- `design-decisions-summary.md`（设计阶段 ADR 汇总，不含 0025）

这些页面中的“未完成/当前版本/下一步”均以 [STATUS.md](./STATUS.md) 为准；不要直接引用为现状。
