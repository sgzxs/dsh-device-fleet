# 术语表

| 术语 | 定义 | _避免叫法_ |
| --- | --- | --- |
| Fleet | 同一账号下、由 fleetId/fleetKey 绑定的一组设备 | 集群、网络组 |
| Device | 一台运行 DSH + 插件的设备；有 `deviceId` 与 Ed25519/X25519 密钥 | 节点（与 Relay 节点混淆） |
| Room | 多成员共享的消息与任务协作单元；User 与 agent 都可参与 | 群聊、频道 |
| Authority | Room 当前的权威设备；默认是创建 Room 的 Host 设备 | Host（仅在指“本地 Host session”时保留） |
| Coordinator | 可变的协调设备元数据；不等于 authority | 管理员、owner |
| Creator | 创建 Room 的成员/设备，创建后不可变 | owner |
| Room Replica | 每台设备本地保存的 Room 事件日志 + 快照 + 索引 | 缓存、副本文件 |
| Mirror | 本地 session 映射到远端 authority Room 的本地 Room | 从库、克隆 |
| Snapshot | 对事件日志状态的压缩表示，用于快速启动/补同步 | 备份 |
| Vector clock | 每设备事件计数，用于找缺失事件 | 版本号、Lamport |
| Room Key | 派生的 Room 密钥；成员移除后轮换 | 房间密码 |
| Invite | 一次性邀请码；Fleet invite 带 fleet key，Room invite 带 room key | 链接、token |
| Relay | 自托管 TCP 中继；只拼接端到端密文，不能读内容 | 代理、VPN |
| Hostless | authority 离线时由 mirror/其他成员继续本地写入与唤醒的协作形态 | 无服务器（不准确） |
| Wake | 向被寻址的本地/远端 participant 注入 Room 消息并启动/唤醒其 agent | 通知、推送 |
| Pending | mirror 本地已写入、尚未被 authority 确认同步的事件 | 队列（泛指时可用） |
| Overlay | Tailscale/ZeroTier 等第三方虚拟网络；插件只做检测和地址广告 | 内置 VPN（未实现） |
| Account binding | creator 用 `account.json` 持久化的账号指纹，用于没有 enrollment 时的握手校验 | 账号缓存 |
| Key rotation | 保持 `deviceId` 不变，由旧私钥签名授权新 Ed25519/X25519 公钥 | 重新入网、换设备 |
| Rotation chain | 该设备全部轮换记录按 seq/prevHash 串成的链；roster 只存 head（`rotationSeq/rotationHead`） | 密钥历史、签名列表 |
| Rotation fork | 同一 `deviceId`、同一 seq 出现两条不同 hash 的链（或被替换的中间段）；自动更新被阻塞，需人工选择 | 双主（那是 Room 概念） |
| Rotation paging | 握手内只内联少量链记录，其余用 `rotation.page`/`rotation.pull` 按页补发 | 分批握手 |
| Device revocation | 由用户确认后永久拒绝某 `deviceId`：握手拒绝、Room 级联移除、roster 留墓碑 | 删除设备（删除会允许 TOFU 重新信任） |
| Revocation advisory | 其它设备签名广播、但尚未经本机用户确认的吊销声明（`revocationPending`） | 生效的吊销 |
| Invite jti | 邀请 v3 的单次使用 id，首次握手兑换后写入 `issued-invites.json` | 可重复使用的邀请码 |
| Checkpoint offer | 对端链被剪枝时提供的自签 checkpoint；本机只保存，待用户确认 | 已信任的 checkpoint |
| Notification | 控制台通知中心的条目（审批/吊销/分叉），审计写入 `notifications.jsonl` | 系统通知/邮件 |
| File transfer | `fleet_upload/fleet_download` 的 512 KiB 分块 + SHA-256 传输 | Room 消息附件 |
| Identity reset | 泄露恢复：归档旧身份并生成新 `deviceId`，旧 id 不能恢复 | 重新轮换（轮换保留 deviceId） |
| Invite bootstrap | 邀请 v2 携带的创建者/成员/吊销墓碑快照，加入方在首次握手前据此 pin 成员 | TOFU（那是兜底） |
| Rotation checkpoint | 链压缩时对归档前缀生成的自签声明；只记录归档到哪里，不能用于跳过验链 | 链头、快照 |
| History pruned | 本地链已剪掉对端 pin 位置之前的记录，握手以 `rotation-history-pruned` 要求重新配对 | 链损坏 |
| Relay TLS | Relay 控制面/数据面使用 TLS；私钥只在 Relay 主机，设备只需 CA | 端到端加密（那是 SecureChannel） |
| Archived Room | 保留本地事件副本但从活动列表隐藏的 Room；可恢复或删除 | 已删除 Room |
| Authority heartbeat | authority 每 5s 发给 peer 的存活/epoch 通知，mirror 记录 `authorityHeartbeatAt` | 心跳检测（泛称） |
| Mirror promotion | authority 心跳超时后，本地 mirror session 提升为新 authority，保留 `authorityRoomId`，epoch 递增 | 自动选举（仅其中一步） |
| Downgrade to mirror | 旧 authority 观察到更高 epoch claim 后转为 mirror；不是仅更新元数据 | 降权、离线 |
| Split-brain | 两台设备同时认为自己是 authority，epoch/写入未收敛 | 双主（可作解释用） |
| Startup grace | 插件启动后一段时间内禁止自动 promotion，避免 reload 期间误接管 | 启动延迟 |
