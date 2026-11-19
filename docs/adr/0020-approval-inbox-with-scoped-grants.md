# B 侧审批：请求面板、超时失败、限次/限时/限房间授权

## Status
accepted

## Context
Tool Policy 的"需审批"档需要一个本机交互面：B 的资源由 B 授权；B 可能无人值守；一个多步任务如果每次弹窗会逼用户改成永久允许。

## Decision
- 审批请求出现在 **B 的插件请求面板（待办收件箱）**：显示来源设备、agent/会话、能力/工具名、参数摘要、目标 cwd/允许根、风险类与超时倒计时。
- 默认 **60 秒**无响应即 fail-closed（可配置）；B 离线/无人值守时不弹窗、直接失败。
- 批准的授权范围三选一：**仅本次** / **本任务内有效（TTL 默认 15 分钟）** / **本 Room 会话内有效**。
- **永久授权只允许在设备设置页按"设备 × 能力"显式开启**，不在逐次弹窗中提供，防止手滑。
- 所有请求与结果写入 B 的审计日志；A 侧只能看到 `approval_pending` / `denied` / `approval_timeout`，看不到 B 的审批界面。

## Considered Options
- 转发到 A 的用户确认——把 B 的资源授权交给 A，违背资源所有者原则，否决。
- 纯配置自动判定、无交互——"需审批"档失去意义，否决。
- 每次强制弹窗、无 TTL——多步任务反复打断，用户最终会改成永久允许，否决。

## Consequences
需要请求收件箱 UI 与通知；TTL 授权要在到期/房间结束/任务结束时自动失效；A 侧 agent 要能区分"被拒/超时/等待中"并据此重试或换方案。

## 实现追记（1.17.0）

- 批准范围实现为 `once` / `ttl` / `room` / `task`；
- `room` 授权存于 Tool Policy 的 `key@room:<roomId>`，Room 关闭/删除时撤销；
- `task` 授权存于 `key@task:<taskId>`，任务标记 done 时撤销；
- 审批请求可携带 `roomId/taskId`（`fleet_call`/`fleet_delegate` 可选参数，Room 自动 wake 会带 `roomId`），UI 只在有对应上下文时显示“允许本房间/本任务”；
- 永久授权仍由设备配置的 capability 矩阵承担。
