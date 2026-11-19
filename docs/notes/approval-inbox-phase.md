# 审批收件箱（逻辑层，dev.7）

## 实现

- `src/host/approval-inbox.js`：`ApprovalInbox`
  - `request()`：排队、60s（可配）超时 fail-closed、事件 `request/approved/denied/expired/closed`；
  - `list()`：待审列表（来源设备、能力、工具、参数摘要、剩余时间）；
  - `approve(id, {scope})`：`once` / `ttl`（TTL 由 Tool Policy 的 `approvalTtlMs` 控制）；
  - `deny(id, reason)`；`close()` 时全部失败关闭。
- `DirectCallHost` / `DelegationHost` 的 `ask` 档改为等待收件箱结果（不再一律拒绝），批准后按 scope 写入 Tool Policy 授权。
- 新工具：`fleet_approvals`；`fleet_simulate_request`（仅 `approvals.simulation: true`）用于本机无第二台设备时演练。**1.20.4 起 `fleet_approve` / `fleet_deny` 已从 Agent 工具移除，审批只能走 UI。**
- 配置：`approvals: {ttlMs, maxPending, simulation}`。

## 已验证

单元测试（`node test/host.test.mjs`，10/10）：
- 收件箱排队/批准/拒绝/超时/关闭/上限；
- DirectCallHost 在 `run=ask` 时阻塞等待收件箱批准后才执行；
- 工具 handler 的列表/批准/拒绝/模拟。

当前 DSH 环境内模拟（dev.7，无需第二台设备）：
1. `fleet_simulate_request` 创建一条 `run/pwsh` 请求，`fleet_approvals` 显示 `58328ms left`；
2. 在设备联邦审批面板点「允许一次」→ `approved … (once)`；再次 `fleet_approvals` 为 `(no pending approvals)`；
3. 再模拟一条 `delegate` 请求，在面板点「拒绝」→ `denied …`；
4. （历史）旧版对不存在 id 调 `fleet_approve` → `Error: [unknown-request]`；1.20.4 起 Agent 无此工具。

## 未完成

- **Client UI 审批面板/通知**（需 Client bundle）：当前只能通过工具或后续 UI 应答；Host 侧已发出 `request/approved/denied/expired` 事件，面板可直接消费；
- `room` 级授权 scope（需 Room 概念落地后再加）；
- 审批结果持久化审计日志（后续与 Room 事件一起做）。
