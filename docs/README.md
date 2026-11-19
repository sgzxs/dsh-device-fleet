# dsh-device-fleet 文档索引

**当前版本：1.20.7（正式版，npm `latest`）** · 现状、真机结果与待办见 [STATUS.md](./STATUS.md)；审计见 [SECURITY-AUDIT-1.20.1.md](./SECURITY-AUDIT-1.20.1.md)；发布记录见 [RELEASE.md](./RELEASE.md)。

这里是**文档唯一入口**：先按“我想做什么”查，再进权威页。项目介绍与安装看根 [README](../README.md)。

## 按问题查

| 我想了解 | 去这里 |
| --- | --- |
| **作为 agent 怎么用 Fleet 工具** | [AGENT-GUIDE.md](./AGENT-GUIDE.md) |
| 项目当前做到哪、还差什么、怎么验 | [STATUS.md](./STATUS.md) |
| 设备密钥被泄露/要吊销一台设备/轮换链分叉怎么办 | [ADR-0027](./adr/0027-device-revocation-fork-and-chain-paging.md)、[STATUS.md](./STATUS.md) |
| 邀请码为何带成员名单/如何压缩轮换链 | [ADR-0028](./adr/0028-signed-invite-bootstrap-and-chain-checkpoint.md) |
| Relay 如何启用 TLS/候选为何会消失 | [ADR-0029](./adr/0029-relay-tls-and-candidate-lifecycle.md) |
| 归档 Room 如何恢复/邀请为何一次性 | [ADR-0030](./adr/0030-archived-room-restore-single-use-invites-notifications.md) |
| checkpoint 如何信任/文件如何传输 | [ADR-0031](./adr/0031-checkpoint-trust-file-transfer-room-rotation-and-relay-health.md) |
| 新 session 接手/继续开发 | [HANDOFF.md](./HANDOFF.md) |
| 项目架构、组件、数据流、关键不变量 | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 文档事实归属、落账规则、哪些页是历史 | [DOC-MAP.md](./DOC-MAP.md) |
| 术语：Fleet / Room / Replica / Authority / Coordinator / Relay | [GLOSSARY.md](./GLOSSARY.md) |
| 历史设计/项目背景与旧术语 | [../CONTEXT.md](../CONTEXT.md) |
| 为什么这样设计、被否决过什么 | [adr/](./adr/) |
| 版本变更流水 | [notes/dev-release.md](./notes/dev-release.md)（历史流水，现状看 STATUS） |
| 网络层与 Relay 协议细节 | [notes/network-v1-v2-implementation.md](./notes/network-v1-v2-implementation.md)（历史快照） |
| 跨网络连接与 Relay 部署 | [notes/relay-deployment.md](./notes/relay-deployment.md)（历史快照） |
| Room Replica 实施阶段记录 | [notes/room-replica-phase.md](./notes/room-replica-phase.md)（历史快照） |
| 首次真实配对过程 | [notes/pairing-session-2026-11-09.md](./notes/pairing-session-2026-11-09.md)（历史快照） |
| 跨设备直调/委派实测 | [notes/remote-tests-2026-11-09.md](./notes/remote-tests-2026-11-09.md)（历史快照） |
| 启动与 Room 日志事故复盘 | [notes/incident-2026-11-09-boot-and-room-log.md](./notes/incident-2026-11-09-boot-and-room-log.md)（历史快照） |
| 审批收件箱/面板 | [notes/approval-inbox-phase.md](./notes/approval-inbox-phase.md)、[notes/approval-panel-ui.md](./notes/approval-panel-ui.md)（历史快照） |
| Fleet 控制台/配置页/UI 缺口 | [notes/fleet-console-ui.md](./notes/fleet-console-ui.md)、[notes/ui-surface-audit.md](./notes/ui-surface-audit.md)（历史快照） |
| 旧 Host 权威 Room 逻辑 | [notes/room-logic-phase.md](./notes/room-logic-phase.md)（历史快照） |
| 全局任务列表作为 Room Board 的评估 | [notes/dsh-global-task-list-evaluation.md](./notes/dsh-global-task-list-evaluation.md)（历史快照） |
| 第一步 Host 插件/直调 MVP | [notes/step1-host-plugin-and-direct-call.md](./notes/step1-host-plugin-and-direct-call.md)（历史快照） |

## 决策记录（ADR）

| 编号 | 主题 |
| --- | --- |
| [0001](./adr/0001-fleet-enrollment-over-account-auto-discovery.md) | 入网基础 |
| [0002](./adr/0002-shared-room-as-coordination-unit.md) | Room 协作单元 |
| [0003](./adr/0003-direct-call-and-room-as-two-channels.md) | 直调与 Room 两通道 |
| [0004](./adr/0004-direct-call-policy-owned-by-target-device.md) | 直调策略 |
| [0005](./adr/0005-upgrade-session-to-room-host.md) | 会话升级 Host |
| [0006](./adr/0006-addressed-messages-and-any-device-speaks.md) | 寻址消息 |
| [0007](./adr/0007-user-speech-decoupled-from-device.md) | 用用户身份发言 |
| [0008](./adr/0008-extend-global-task-list-as-room-board.md) | 全局任务作为 Board |
| [0009](./adr/0009-room-policy-configured-at-creation.md) | Room 策略创建时确定 |
| [0010](./adr/0010-room-policy-v1-fields-and-custom-room-types.md) | Room 策略字段 |
| [0011](./adr/0011-room-board-lifecycle-and-hooks.md) | Board 生命周期 |
| [0012](./adr/0012-lazy-wake-and-directed-speech.md) | 懒唤醒/定向发言 |
| [0013](./adr/0013-direct-call-as-device-agnostic-functions.md) | 直调即函数 |
| [0014](./adr/0014-fleet-call-unified-entry-with-typed-shortcuts.md) | 统一 fleet_call |
| [0015](./adr/0015-room-plus-local-teams-and-delegation.md) | Room + 本地团队 |
| [0016](./adr/0016-delegation-upgrade-reuses-session.md) | 委派复用会话 |
| [0017](./adr/0017-network-phases-direct-and-relay.md) | 网络阶段 |
| [0018](./adr/0018-offline-fail-fast-and-durable-room-log.md) | 离线快速失败 |
| [0019](./adr/0019-execution-context-configured-locally.md) | 执行上下文本地配置 |
| [0020](./adr/0020-approval-inbox-with-scoped-grants.md) | 审批收件箱 |
| [0021](./adr/0021-room-visibility-user-full-agents-scoped.md) | Room 可见性 |
| [0022](./adr/0022-tool-adoption-mechanisms.md) | 工具采用机制 |
| [0023](./adr/0023-reuse-session-trajectory-for-call-details.md) | 复用会话轨迹 |
| [0024](./adr/0024-strict-version-match-with-reserved-capabilities.md) | 版本匹配 |
| [0025](./adr/0025-decentralized-room-replicas.md) | 去中心化 Replica |
| [0026](./adr/0026-signed-roster-rotation-chain.md) | 签名 roster 轮换链（已实现，扩展见 0027） |
| [0027](./adr/0027-device-revocation-fork-and-chain-paging.md) | 吊销 / 分叉 / 链分页 / 泄露恢复 |
| [0028](./adr/0028-signed-invite-bootstrap-and-chain-checkpoint.md) | 签名邀请引导 / 链 checkpoint 压缩 |
| [0029](./adr/0029-relay-tls-and-candidate-lifecycle.md) | Relay TLS / 候选生命周期 |
| [0030](./adr/0030-archived-room-restore-single-use-invites-notifications.md) | 归档 Room 恢复 / 一次性邀请 / 通知 / 密钥 UI |
| [0031](./adr/0031-checkpoint-trust-file-transfer-room-rotation-and-relay-health.md) | checkpoint 信任 / 文件传输 / Room rotationSeq / Relay 延迟+mTLS |
| [0032](./adr/0032-remaining-capabilities-except-p2p.md) | 1.13 剩余能力（除 P2P）：invite 链/分片、文件、严格模式、webhook、退避 |
| [0033](./adr/0033-human-readable-names-and-console-redesign.md) | 人类可读命名 / 控制台视觉重构 / checkpointQuorum |
| [0034](./adr/0034-theme-room-ux-config-and-storm-guard.md) | 主题适配 / Room 交互 / 配置页 / 自动重邀 / 连接风暴保护 |
| [0035](./adr/0035-console-i18n.md) | 控制台 i18n（中文/English） |
| [0036](./adr/0036-approval-scopes-dynamic-i18n-mtls-lifecycle.md) | 审批 Room/任务作用域 / 动态 i18n / mTLS 轮换吊销 |
| [0037](./adr/0037-large-files-approval-persistence-outbox-call-details-relay-rotation.md) | 大文件 / 审批持久化 / outbox / 调用详情 / Relay 证书轮换 |
| [0038](./adr/0038-m-of-n-checkpoint-trajectory-relay-cluster.md) | M-of-N checkpoint / DSH 轨迹 / Relay 多节点 |
| [0039](./adr/0039-trajectory-persistence-and-relay-lease.md) | 轨迹持久化/脱敏 / Relay lease 选主 |
| [0040](./adr/0040-threshold-model-m-of-n-not-frost.md) | 阈值模型：M-of-N 多签，不引入未审计 FROST |
| [安全审计 1.20.1](./SECURITY-AUDIT-1.20.1.md) | 1.20.2 修复项与剩余风险 |

另见 [notes/design-decisions-summary.md](./notes/design-decisions-summary.md)（历史汇总，现状以 ADR + STATUS 为准）。

## 文档状态约定

- **STATUS.md** 是“现在时”的唯一权威页；`notes/` 下除 `dev-release.md` 的发布流水外，都是**当时快照**，不应当作现状。
- **ARCHITECTURE.md** 负责结构与不变量；**ADR** 负责“为什么当时这样定”，只加追记，不改写成现在时。
- 同一事实只在一处展开，其它位置只给一句话指针。
- 历史快照里的旧版本号、旧“未完成”结论如果与 STATUS 冲突，以 STATUS + 代码为准。
