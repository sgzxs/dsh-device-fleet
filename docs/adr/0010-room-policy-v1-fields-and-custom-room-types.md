# Room Policy v1：可配置协作规则与可保存的 Room Type

## Status
accepted

## Context
不同协作场景需要不同规则；而且 Room 由用户显式命令创建，用户应当在创建前就能在插件里配好"房间类型与权限"，而不是被硬编码规则限制。当前 Fleet 是**单用户**模型（同一账号 = 同一个人），成员即用户自己的设备。

## Decision
v1 Room Policy 字段：
- `invite`: `host-only | members`（谁能邀请新成员）
- `join`: `auto | confirm`（被邀请设备自动加入，还是需要本机确认）
- `maxMembers`: 默认 8
- `boardWrite`: `members | host`（谁能改共享任务板）
- `remove`: `members | host-only`（成员可主动移除他人，或只有 Host 能移除）

Room Type 是命名预设（内置私密/团队/只读），用户可**自定义并保存**；创建房间时解析成一份 Room Policy 快照，写入房间创建事件并广播。Host 可在创建后修改协作类策略并广播；修改不追溯驱逐已有成员，`join` 变更只影响后续加入。

## Considered Options
- 只做内置硬编码策略——不满足"创建前按场景配置"，否决。
- 策略放到设备级 Tool Policy——混淆了协作规则与资源访问，否决。

## Consequences
需要插件设置页管理自定义 Room Type；房间事件持久化策略快照；成员移除/加入规则变更需要广播与审计；"成员可移除他人"依赖单用户 Fleet 假设，未来支持多人房间时必须重新设计。
