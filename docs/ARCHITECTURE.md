# 架构

本文只描述**当前代码结构与不变量**；历史设计动机看 [adr/](./adr/)，现状看 [STATUS.md](./STATUS.md)。

## 组件

```text
DSH Host 插件 (src/plugin/index.js)
├─ 网络层 src/net/
│  ├─ FleetNode           直连/发现/relay 客户端、RPC、roster、peer hints
│  ├─ SecureChannel       Ed25519 身份 + X25519 + AES-GCM 握手与帧；rotation 公告/补链/分页
│  ├─ rotation            保持 deviceId 的设备密钥轮换、吊销记录、链验签/分叉检测/分页/checkpoint
│  ├─ relay-server/client v2 控制面 + 数据面拼接（端到端密文，可选 TLS）
│  ├─ tls-options         Relay TLS 证书/CA 的 PEM/路径解析
│  └─ discovery           LAN UDP 发现
├─ Host 能力 src/host/
│  ├─ DirectCallHost/Client  跨设备工具调用与 typed shortcuts
│  ├─ DelegationHost         远程一次性委派
│  ├─ ApprovalInbox          本机审批 + 审计历史
│  ├─ RoomService            消息/成员/任务/策略/关闭/唤醒/authority heartbeat
│  ├─ RoomReplicaStore       每设备 Room 事件日志 + 快照 + 索引 + vector clock
│  ├─ RoomReplicaSync        hello/pull/push 同步
│  ├─ room-signing           Room 事件 Ed25519 签名/验签
│  ├─ roster-signing         roster HMAC 持久化校验
│  ├─ remote-room/peer       远端成员唤醒、回复、镜像
│  └─ overlay                Tailscale/ZeroTier 只读检测
└─ Client UI (client.js)     Fleet 控制台、Room 视图、审批面板、配置页
```

## 关键数据

- **Identity**：设备 Ed25519 + X25519 密钥；`deviceId` 是随机 UUID，密钥轮换时保持不变。
- **Fleet**：`fleetId` + `fleetKey`；邀请码携带 fleet key/endpoints/relay 列表，v2 起整包 HMAC 签名并携带创建者/成员/吊销墓碑的引导快照（ADR-0028）。
- **账号绑定**：joiner 的 `enrollment.accountFingerprint`；creator 无 enrollment 时用 `account.json` 持久化指纹，peer 握手可反向绑定。
- **设备轮换**：`identity-rotations.json` 保存旧私钥签名的 rotation chain；对端用 roster 旧公钥逐条验证后替换新公钥，并在 `peer-rotations.json` 保存已接受的对端链（genesis + records）用于分叉检测与人工选择。链可显式压缩：旧记录归档、活动链保留最近 N 条，`rotation.checkpoint` 记录归档前缀。
- **Relay**：控制面注册 token（fleetKey HMAC + 时间戳）；控制面与数据面都可 TLS（`relay.tls.ca`），私钥只在 Relay 主机。peer 学到的 Relay 候选带 TTL（默认 7 天）、来源与失败计数，配置候选永不过期；`fleet_status.relay.list` 暴露排序后的候选。
- **吊销**：`device.revoke` 由断言方当前密钥签名；自签立即生效，第三方记录只写 `revocationPending`，需本机用户确认。roster 条目成为墓碑（`revokedAt/revocationRecord`），握手以 `device-revoked` 拒绝，Room 成员级联移除，记录向已连接/后连上的 peer 补发。
- **Room**：
  - authority Room：由 Host session 升级创建，`roomId = hostSessionId`；
  - mirror Room：本地 session 映射到远端 authority Room，本地事件先写 replica，再异步 publish。
- **Room Replica**：`rooms/<roomId>/events.jsonl` + `snapshot.json` + 索引；事件含 `origin/originSeq/seq/prev/signature/signedRoomId`。
- **同步**：`room.sync.hello/pull/push`；每个 replica 用 vector clock 找缺失事件；事件跨 mirror 时重映射 roomId；本机事件重签，authority-signed 事件保留签名。
- **Room 元数据**：creator、coordinator、authority（`authorityDeviceId/authorityRoomId/authorityEpoch/authorityHeartbeatAt`）均为 LWW/确定性收敛事件；promotion 保留原 `authorityRoomId`，downgrade 必须真正设置 `mirror`。
- **审批**：本机 `ApprovalInbox`；`ask` 策略阻塞等待；结果落 `approval-history.jsonl`。
- **诊断**：`diagnostics.jsonl` 记录冷启动 execution host 的 `deferred/unavailable/recovered` 事件，便于复盘 `no execution slot`。

## 不变量

1. **插件版本严格一致**；DSH 版本允许同 core 的 prerelease skew（ADR-0024 更新）。
2. **协议版本/线格式必须兼容**；未知事件类型保留但可忽略。
3. Room 事件签名 canonical **排除** `signature/seq/prev/signedRoomId`，因此跨 mirror 重编号/重映射后可复验。
4. 同一设备同一 Room 只有一个本地 replica；authority Room 与 mirror Room 用不同本地 roomId。
5. authority 元数据按最高 epoch 收敛；同 epoch 按 deviceId 字典序裁决；claim/promote 递增 epoch，启动/reload 不递增。
6. mirror 发送本地优先，authority 不可达时保留 pending；本机 local participant 可由 mirror 直接唤醒。
7. 自动 promotion 仅在“曾收到 authority heartbeat 且已过期 + 本机 coordinator + 启动宽限期结束”时允许；`heartbeatAt=0` 不等于离线。
8. 旧 authority 观察到更高 epoch claim 时必须转为 mirror（`mirror` 字段真实写入），不能只改元数据。
9. 设备密钥轮换保持 `deviceId`，由旧私钥签名授权新 Ed25519/X25519 公钥；roster 从已 pin 的旧公钥开始验证 rotation chain，握手 transcript 不包含 `rotations/rotationSeq/rotationHead/rotationChunks`。
10. 成员移除后轮换 Room key；已同步的明文无法回收。
11. Relay 只能看到密文与元数据；直接调用策略由目标设备决定。
12. 吊销只作用于 `deviceId`：自签记录必须由该条目当前公钥签名并立即生效；第三方记录必须由 roster 中已 pin 的断言方密钥签名，且只有本地用户确认后才写 `revokedAt`。
13. 被吊销设备不能通过轮换、TOFU 或重连恢复；只有 `fleet_remove_device` 删除墓碑后重新配对。
14. 同 seq 不同 hash、`prevHash` 断裂、公告 head 不同都算分叉：不自动更新公钥，人工 `confirm` 后 `keep-local` 或 `adopt-peer`；`adopt-peer` 只能接在已验证的本地前缀上。
15. 握手内 rotation 链传输有界（16 条内联、64 条/页、1024 条/16 轮上限）；超限失败并提示重新配对。
16. 邀请 v2 的 HMAC 覆盖除 `sig` 外全部字段；本地已 pin 公钥不被邀请快照覆盖，吊销墓碑需验签（或快照自带标记）才写入。
17. rotation checkpoint 只是归档声明，不能用于跳过验链；压缩后 `rotationFrom = 活动链首条 seq`，对端 pin 在更早位置时以 `rotation-history-pruned` 失败。
18. 只有本地配置/邀请可以关闭 Relay 证书校验；peer 广告的候选不能设置 `rejectUnauthorized: false`。配置候选永不因 TTL 过期，peer 学到的候选过期即删除。

## 已知结构限制

- authority 仍是事实上的写入中心；自动 promotion 已实现，但旧 authority 自动降级/双主收敛尚未通过真机验收。
- 没有 NAT 打洞；跨网依赖公网可达设备、Relay 或外部 overlay。
- Roster 有 HMAC 防篡改、rotation chain 与吊销墓碑；吊销/分叉状态与 `rotationSeq/rotationHead` 一样不在 `roster.sig` 的 canonical 内，文件级篡改只能靠 Fleet key 重签发现。rotation 记录尚未纳入 invite（只带 head）；Room 事件绑定 `rotationSeq` 未完成。
- rotation 链可归档压缩，但 checkpoint 是单设备自签声明，没有多方信任；剪掉历史后，落后太远的 peer 只能重新配对。
- Relay 支持 TLS，但仍是自托管单点/明文可选；没有内建高可用、mTLS 或 NAT 打洞。
- 事件日志保留全量事件 + 快照；仅手动/自动压缩，无冷存储。
