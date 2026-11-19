# ADR-0030：归档 Room 恢复、一次性邀请、通知中心与密钥操作 UI

- **状态**：已实现（2026-11-15，1.12.0）
- **相关**：ADR-0028（邀请引导/链压缩）、ADR-0029（Relay）、`src/host/room-service.js`、`src/host/store.js`、`src/host/notifications.js`、`src/net/identity.js`、`client.js`
- **结论**：补齐 P0 产品闭环：归档 Room 可在运行时恢复为可写 Room；邀请码带过期与单次使用；控制台新增通知中心、轮换/重置按钮与密钥泄露恢复引导。

## 1. 归档 Room 恢复

- `RoomService.restoreArchivedRoom({ roomId, snapshot })`：
  - 若 Room 仍在内存：只做 `closed=false` 并补 host 成员；
  - 若只剩 replica：从 `roomReplica.state()` 重建 Room（members/messages/tasks/policy/creator/coordinator、mirror 信息）；
  - 恢复为本地 authority 时 `authorityEpoch = 旧 epoch + 1`、heartbeat=now，使其立即能写；mirror 仍保持原 authority。
- 插件新增 `room_restore` 工具与 `POST /device-fleet/room/restore`；控制台“已归档”列表的“恢复”按钮改为调用它（同时取消归档标记）。
- 限制：恢复不重放 Room 事件、不自动重新邀请远端成员；远端成员需要重新加入/同步。

## 2. 邀请过期与单次使用（invite v3）

- payload v3 增加 `jti`、`expiresAt`、`singleUse: true`，HMAC 覆盖全部字段（前缀按版本区分，v2 仍可验）。
- 生成侧把 `jti/expiresAt` 写入 `issued-invites.json`；`fleet_invite` 返回过期时间，控制台显示“单次使用 · 到期时间”。
- 加入方 `decodeInvite` 在加入/加载时拒绝过期邀请；过期 pending 会被删除，避免永久重试。
- 单次使用在首次握手兑换：joiner 在 hello 里携带 `inviteId`（签名、transcript 剔除），目标设备在 TOFU 首次接纳时调用 `redeemIssuedInvite`：
  - 未用过且未过期 → 标记 `usedAt/usedByDeviceId`；
  - 已用过 → `invite-consumed`，握手拒绝；
  - 过期 → `invite-expired`。
- `known-devices.json` 记录曾被接纳过的 deviceId：删除设备后重新接纳（TOFU）不会再次消耗邀请，也不会被已用 jti 误拒。
- 配置 `invite.ttlMs`（默认 24h，最小 60s），可由运行时配置页修改。

## 3. 通知中心

- `NotificationCenter` 保存内存环形列表（默认 100 条）并追加 `notifications.jsonl` 审计。
- 触发：远程审批请求、第三方吊销 advisory、设备吊销、轮换链分叉。
- `overview` 暴露 `notifications/notificationsUnread`；新增 `GET /device-fleet/notifications` 与 `POST /device-fleet/notifications/read`。
- 控制台新增“通知”页签（未读角标、全部已读）与浏览器桌面通知开关（Notification API，权限失败降级为提示）。

## 4. 密钥操作 UI 与恢复引导

- 控制台“设备密钥链”卡片新增“轮换本机密钥”“重置身份”按钮，均带确认；重置额外要求输入 `RESET`。
- 新增 `POST /device-fleet/fleet/rotate-identity` 与 `/reset-identity`；重置后提示新 deviceId 与重新入网步骤。
- 设备页增加“密钥泄露恢复”三步引导（先吊销旧 id → 重置身份 → 重新入网/邀请 Room）。

## 不变量

1. 恢复只从本地 replica 读，不跨设备拉取未验证数据；恢复出的 authority epoch 必须高于旧值。
2. 邀请 v3 的 `jti/expiresAt` 在 HMAC 覆盖范围内；过期邀请不可加入。
3. 单次邀请只在“首次接纳且非 known-device”时兑换；同一 jti 第二次兑换必须失败。
4. 通知不影响控制流，失败只记录；审批/吊销的权威状态仍在 inbox/roster。
5. 轮换/重置/信任 checkpoint 等破坏性动作必须显式确认。

## 后果

- 正：归档 Room 可继续使用；邀请可过期且不可重用；用户能收到关键事件；密钥恢复有明确 UI 路径。
- 负：恢复的 Room 与原远端成员会短暂脱节；邀请单次使用依赖首次握手时的在线兑换（离线加入仍需重新邀请）；桌面通知受浏览器权限限制。
