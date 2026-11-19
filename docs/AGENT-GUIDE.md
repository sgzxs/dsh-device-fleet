# Agent 使用说明书（Fleet 操作手册）

面向**使用 Fleet 工具的 agent**。项目介绍/安装看 [README](../README.md)，当前状态看 [STATUS](./STATUS.md)。

## 1. 先看现场

1. `fleet_list`：拿到设备 id、在线状态、本机 id。
2. 不确定目标能力：`fleet_tools(device)`。
3. 排障：`fleet_status`（本机）或对目标 `fleet_call` 的 `fleet.info`。

规则：

- 目标离线会立即失败（`offline`），**不要忙等/循环重连**；告诉用户或稍后再试。
- 不要在回复里暴露 Fleet key、邀请码、私钥、证书私钥。
- 设备显示名用 roster 的 `name`，不要把 `deviceId` 当人类可读名称。

## 2. 选哪个工具

| 需求 | 工具 | 说明 |
| --- | --- | --- |
| 看/取文件 | `fleet_read` / `fleet_fetch` | 目标 roots 内；`fetch` 返回文本 |
| 列目录/删文件 | `fleet_file_list` / `fleet_file_delete` | 删除需 `write` 策略 |
| 跑命令 | `fleet_run` | 目标策略通常 `ask`，会等目标用户审批 |
| 调任意工具 | `fleet_call` | 先 `fleet_tools` 查参数 |
| 让目标 agent 做一件事 | `fleet_delegate` | 一次性子 agent；不共享本会话历史 |
| 持续协作/共享任务板 | Room 工具 | `room_*`；见下 |
| 传文件 | `fleet_upload` / `fleet_download` | 2 GiB/文件，流式分块 SHA-256 |
| 离线排队 | `fleet_queue_call` / `fleet_queue_delegate` | 持久化 outbox，重连/30s 重试，结果可查 |

直调是**无状态**的：不会把本地会话历史带给目标。委派也是独立的子 agent；需要上下文时把关键信息写进 `task`。

## 3. 入网与连接（给用户的操作）

1. A 生成邀请码：`fleet_invite`（一次性、会过期；含 Fleet key，保密）。
2. B 安装**完全相同版本**的插件；更新插件后重载插件即可，无需重启 DSH。
3. B 执行 `fleet_join(code)` 或控制台「加入 Fleet」；邀请会排队。
4. B **再重载一次插件**（`plugin_manager set_bundle enabled:false` → `true`），消费待入网邀请。
5. B 连接 A：同一局域网可能自动发现；否则 A 用 `fleet_status` 查直连地址，B 用 `fleet_connect(host, port)` 或控制台「连接设备」。
6. A 执行 `fleet_list` 确认 B 在线，再 `fleet_tools(B)` / `fleet_run(B, ...)`。

关键：**入网/更新/连接都不需要重启 DSH**；只有插件管理器不可用或 bundle/profile patch 变更才需要重启。

## 4. 审批（目标设备决定）

目标设备的 Tool Policy 决定 `auto / ask / deny / allow`：

- `allow/auto`：直接执行。
- `ask`：目标用户收到审批请求；默认 60 秒无响应 fail-closed。
- `deny`：直接拒绝，不要绕过。

错误码：

- `approval_denied` / `approval-timeout`：目标用户拒绝/超时；不要无限重试。让用户处理，或建议把对应 capability 改为 `allow`。
- `denied`：策略拒绝；检查 roots/能力。
- `unsupported`：目标设备没有该能力/服务。

审批范围（用户在设备联邦审批面板中选择的 `scope`）：

- `once`：一次调用
- `ttl`：TTL 内同一 capability（默认 15 分钟）
- `room`：本 Room 生命周期（请求需带 `roomId`）
- `task`：任务完成前（请求需带 `taskId`）

审批决策只能由用户在设备联邦审批面板做出；Agent 可以用 `fleet_approvals` 查看待审批项，但**没有** `fleet_approve`/`fleet_deny` 工具，不能自行批准。

`fleet_call` / `fleet_delegate` / `fleet_run` 可带可选 `roomId`/`taskId`，让目标用户选择 Room/任务级授权。Room 自动 wake 已带 `roomId`。

## 5. Room 协作

- 创建/升级：`room_create`；加入远端：`room_add_remote`；本地参与者：`room_add_local`。
- 消息：`room_send(to=[memberId...], text)`；`@name` 不会自动加收件人，需显式 `to`。
- 任务板：`room_task_add` / `room_task_update` / `room_task_list`；owner 必须是成员。
- 同步/诊断：`room_sync`、`room_status`、`room_messages`。
- 归档/恢复：`room_archive` / `room_restore`；恢复会尝试重邀远端成员。
- Authority：不要假设本机是 authority；写入失败先看 `room_status.authorityDeviceId`。mirror 本地写可能被代理或拒绝。
- 关闭 Room 会撤销该 Room 的审批 grant；任务 `done` 会撤销任务 grant。

## 6. 文件传输

- `fleet_upload(device, localPath, remotePath, resume)`；`fleet_download` 同理。
- 目录：`recursive: true`；删除目录必须显式 `recursive`。
- 单文件上限 **2 GiB**；流式上传/下载，`fleet_download` 支持 `resume` 复用 `.part`；不做目录差异同步，符号链接只报告不跟随。
- 目标 `write` 策略默认 `ask`，且必须在 `allowedRoots` 内。

## 7. 离线 outbox 与调用详情

- 普通 `fleet_run` / `fleet_call` / `fleet_delegate` 在目标离线时 fail-fast；需要“稍后执行”时用：
  - `fleet_queue_call({device, tool, parameters, capability, roomId, taskId, label})`
  - `fleet_queue_delegate({device, task, ...})`
- 队列在目标重连或每 30 秒重试；用 `fleet_outbox` 查看状态，`fleet_outbox_result` 读取结果，`fleet_outbox_cancel` 取消仍在 queued 的条目。
- 控制台「调用」页聚合本机与已连接设备的调用元数据/结果；委派条目可点「轨迹」按 `sessionId` 拉取目标设备记录的有界 DSH 会话事件（只读，需 `read` 授权）。

## 8. Relay 多节点与选主

- 单机多节点：`node scripts/relay-cluster.mjs --fleet-state <fleet.json> --nodes 3 --base-port 60600 --base-data-port 60610`。
- 跨主机选主：先运行 `relay-lease.mjs --host 0.0.0.0 --token <secret>`（非 loopback 必须带 token），各主机 supervisor 加 `--coordinator http://<lease-host>:60700 --lease-token <secret>`；只有 lease leader 启动节点，失联自动过期并由 standby 接管。
- lease coordinator 是单点；生产可换 etcd/Consul。设备配置各 Relay 节点，客户端候选 failover。

## 9. 安全与密钥操作

- `fleet_rotate_identity`：保留 deviceId，轮换密钥；失败时看 `fleet_rotation_status`。
- `fleet_revoke_device(confirm:true)` / `fleet_reset_identity(confirm:true)`：**必须由用户明确确认**后调用；reset 会换 deviceId，旧身份不可恢复。
- `fleet_rotation_fork_resolve` / `fleet_rotation_compact` / `fleet_rotation_trust_checkpoint`：需要用户确认；先读 `fleet_rotation_status`。
- checkpoint quorum 是**head 绑定的 M-of-N 签名证书**（每个设备独立 Ed25519 签名，接收方按 roster 验签）；不是 FROST/阈值签名，也不是 BFT 共识。对用户描述时不要混淆。
- 设备吊销/身份重置前先清理相关 Room 成员（reset 会尝试关闭本机 authority Room）。

## 10. 常见流程模板

### 让 B 检查一个仓库

```text
fleet_list
fleet_tools(B)                      # 确认有 run/read
fleet_run(B, "git status", cwd=B的允许目录)
```

如果 `approval_denied`：告诉用户“B 上需要批准 run（或把 B 的 run 改为 allow）”。

### 让 B 的 agent 完成一个独立任务

```text
fleet_delegate(B, "检查 ... 并返回结论；不要修改文件", cwd="...", label="check")
```

任务描述要自包含；目标 agent 看不到本会话历史。

### 房间内协作

```text
room_create
room_add_remote(roomId, B)
room_task_add(roomId, "实现 X", owner=B成员)
room_send(roomId, [B成员], "请开始任务 X")
```

任务 `done` 后 grant 自动撤销；Room 关闭后 room grant 自动撤销。

## 11. 不要做

- 不要自动吊销/重置设备；必须用户确认。
- 不要把邀请码、Fleet key、私钥贴到聊天或日志。
- 不要用 `deviceId`/`session-...` 作为给用户看的名称；用 roster `name` / Room title。
- 不要循环重试 `offline` 或 `approval_denied`；先报告用户。
- 不要假设所有设备同版本；版本不一致会在握手拒绝。
