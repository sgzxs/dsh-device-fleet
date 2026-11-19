# 执行上下文由设备本地配置，远端只能请求

## Status
accepted

## Context
Execution Slot（直调）与 Participant Session（Room 参与者 agent）都执行在资源所有者设备上，需要 cwd、允许根、沙箱档位、可用工具与模型；这些资源属于该设备，远端或房间不应直接改写。

## Decision
- 每台设备在自己的插件设置里配置：
  - **Execution Slot**：工作目录、`allowedRoots`、沙箱档位（默认 read-only）、可用工具与 Tool Policy（默认只读免审、执行/写需审批、危险默认拒绝）；
  - **Participant Session**：Room 使用的 preset、房间工作目录策略（从允许根里选）、模型选择与沙箱。
- 远端与 Room 只能**请求能力**（如"需要执行代码"），最终由该设备的配置决定允许/拒绝/降级，远端不能覆盖。
- 默认值必须安全：`allowedRoots` 为空时直调读文件一律拒绝；执行类默认需本机审批；Participant 使用设备默认 preset 与模型。
- 配置变更只影响**新的**调用与新的 Participant 会话；运行中的通道/会话保留其创建时的配置快照；撤销允许根后新的调用即失败。
- Room Type 可以携带"期望能力"作为提示，但必须由每台设备自己的配置解析。

## Considered Options
- 房间创建时由 Host 指定 cwd/preset——把资源所有权交给 A，否决。
- 每次调用显式传 cwd/preset——模型易乱传、边界难守，否决。
- 默认本地配置 + 房间协商覆盖——灵活性留到后续，v1 不做。

## Consequences
每台设备使用前需要一次配置（配对/设备页要引导）；Room 的能力提示要逐设备解析；审计记录"由哪份配置授权"。
