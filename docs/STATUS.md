# 项目现状（唯一权威页）

**版本：1.20.7（正式版，npm `latest` + `dev`）** · **更新：2026-11-19 15:10（Asia/Shanghai）** · A/B 均 1.20.7 真机验证：轨迹 30 事件（新/旧）、unowned 403、CSRF evil 403、管理工具/根外路径拒绝、`fleet_run` 正常、calls 133 条仅 A/B。配置/启动回滚由 net 单测覆盖（50/50）。npm `latest` 已切到 1.20.7。

> 部署提醒：1.17.3 A/B 必须同版本；当前 **A 已 1.17.3，B 仍 1.17.2**（待安装 1.17.3 并重载插件）。升级 A/B 时都要重载插件；只有插件管理器不可用或 bundle/profile patch 变更才需要重启 DSH。

## 历史真机测试记录（2026-11-15，1.11.x 阶段）

已通过（1.11.0 阶段）：

```text
基础链路        A↔B 1.11.0 直连；fleet_call/fleet_tools/fleet_run/fleet_delegate ✅
Room            B authority epoch6/A mirror；A 提权 epoch7、移除旧设备、重加新 B、remote wake → ROOM-RECOVERY-OK/FINAL-ROOM-OK ✅
在线轮换        A seq2、B seq0，双方 roster head 一致；轮换后 delegate OK ✅
链压缩          A 10 条 → 压缩 keep 8（归档 seq0-1、checkpoint seq1、from=2），B roster 仍 seq9；压缩后再轮换 seq10 ✅
邀请 v2         在线生成 1870 字符邀请；decode 校验 HMAC/creator seq10/roster/relay/endpoint 全部通过 ✅
身份重置        B fleet_reset_identity → 新 deviceId；A TOFU 接纳；delegate RESET-OK ✅
吊销            A 吊销新 B → 入站握手 rotation-revoked、A→B 也被拒；删除墓碑后同 id 可重新 TOFU 接纳，delegate READMIT-OK ✅
离线补链        B 离线期间 A 轮换 seq11、seq12；B 重连后 roster A 自动到 seq12，delegate OFFLINE-CATCHUP-OK ✅
控制台数据面    /device-fleet/overview 暴露 rotation/account/revoked/archivedRooms/relay.list；归档/恢复 Room 可见 ✅
```

1.11.1 版本回归（两端 1.11.1）：

```text
基线            A/B pluginVersion=1.11.1、直连在线；delegate V111-BASELINE-OK ✅
关键修复        B fleet_reset_identity → 新 deviceId b8fc0c22；10s 内自动回连（无手动 fleet_connect），
                A TOFU 接纳；delegate V111-AUTORECONNECT-OK ✅
Room 最终态     A authority epoch9；旧身份成员清理；新 B 加入 → remote wake V111-ROOM-OK ✅
吊销            A 吊销旧身份 c2d42572/38268e75（墓碑保留）；新 B 正常 ✅
```

测试中发现并修复（1.11.1）：

```text
问题：A 压缩链后，B 重置身份（自身链为空）主动重连时，A 的发送侧剪枝检查把
      B 公告的 rotationSeq（B 自己的链位置）误当成 B 对 A 的 pin，错误报
      rotation-history-pruned，导致 B 无法自动回连。
修复：发送侧不再判定剪枝，只按对端 seq 推送可用后缀；接收方用自己的 roster pin
      对照对端的 rotationFrom 判定 rotation-history-pruned。
回归：新增「peer 自身链为空但 pin 在 responder 头」与「剪枝链仍接纳全新 peer」
      两用例；net 36/36。
```

1.12.0（P0+P1）：

```text
P0 归档 Room        restoreArchivedRoom：replica → 可写 Room（消息/任务/成员保留，authority epoch+1）
   邀请一次性       v3 jti/expiresAt/singleUse；hello 携带 inviteId，首次 TOFU 兑换；known-devices 豁免重接纳
   通知中心         approval/revocation-pending/revoked/rotation-fork → 控制台通知页 + 桌面通知开关
   密钥 UI          轮换/重置按钮 + 恢复三步引导；重置需输入 RESET
P1 checkpoint      剪枝时对端带签名 checkpoint（含该高度公钥）；本机只存 offer，用户 confirm 后采纳
   文件传输         512 KiB 分块、SHA-256、2 GiB 上限（1.18.0 起流式）；fleet_upload/fleet_download；write 默认 ask + roots
   Room rotationSeq 新事件 canonical 绑定签名 epoch；旧事件兼容
   Relay             ping/pong 延迟探测、候选按延迟排序；TLS + 客户端证书 mTLS（私钥不进 invite）
测试               net 40/40 · host 64/64 · overlay 2/2 · plugin-order 1/1 · perf 1/1 · client smoke passed
```

1.12.1（热修复）：

```text
问题  B 真机激活 1.12.0 时 TDZ：signEventWithRotation 在 RoomReplicaStore 构造前未初始化
修复  currentRotationSeq / signEventWithRotation / signRemappedEvents 上移到 replica store 之前
回归  test/plugin-order.test.mjs 静态检查定义顺序；scripts/ci.mjs 新增 plugin-order
```

1.12.2（回归修复）：

```text
问题  /device-fleet/pair/invite 返回 {ok:true, code:{code,expiresAt}}，控制台邀请码/到期时间显示异常
修复  ui-web 拆包并返回 {ok:true, code, expiresAt}；host 测试覆盖响应形状
问题  未探测过的 Relay 候选 latencyMs 显示 0（Number(null) 误判）
修复  latencyMs 仅在非 null 且有限时输出，否则 null
```

1.12.2 双端真机（A/B 均 1.12.2）：

```text
重连/版本      A/B pluginVersion=1.12.2；B online，fleet_call 20ms
基线委派        fleet_delegate → V122-BASELINE-OK（1457ms）
归档 Room      创建→发消息→归档→room_restore（消息保留）→继续写→删除
Room seq       新消息 replica event: rotationSeq=12, origin=A, signature=true
通知中心       B→A run 触发 pending approval；A notification(unread=1)；approve once；mark read(changed=1, unread=0)
文件下载       B 文件 → A 1034 bytes，SHA-256 Egp0… 与上传值一致；B 侧清理 V122-CLEANUP-OK
invite         /pair/invite 返回字符串 code（4717 字符）+ expiresAt；decode jti/singleUse/creatorSeq=12
已知环境项     B→A fleet_run 在 A 执行槽初始化时 SetNamedSecurityInfoW(Win32 5) 失败（E:\Dsh_test ACL），
               命令未执行；同路径 A→B run 正常。属于 A 的 DSH 执行 workspace 权限，不是插件回归。
```

### 已知问题（Room × 身份重置）

重复「身份重置 → 重新加入 Room → 再提权」的测试序列中，出现过一次 authority 回摆：A 提权到 epoch7 后，旧 B 身份（仍是 Room 成员）把自己提升到 epoch8 并 claim，A 降为 mirror；随后旧 B 被重置，A 再次 promote 到 epoch9 才恢复。原因主要是旧身份在重置前残留的本地 Room authority 元数据仍参与 epoch 竞争，属于恢复流程而非本轮代码回归。

建议：密钥泄露恢复时，先在各设备对旧身份执行 `room_remove_device` / 关闭相关 Room，再重置身份；或在重置后由存活设备立即 promote 并清理旧成员。后续可考虑在 `fleet_reset_identity` 内自动归档本地 authority Room。

尚未真机覆盖：3+ 设备（第三方吊销 advisory、分叉选择）、自签 TLS Relay 实际链路、控制台按钮逐项点击（数据面已验）、>16 条分页离线补链、长压测。

1.12.3（checkpoint 真机修复与双端验证）：

```text
问题  checkpoint 在链压缩时（seq4/旧 seq1）签名，之后轮换到 seq12；握手用 peer 当前 key 验证，
      签名不匹配 → 不保存 offer → fleet_rotation_trust_checkpoint 报 no-offer，信任流程不可用。
修复  广告前用当前 identity 重签 checkpoint（head 与 headEdPublic/headXPublic 不变）；
      FleetNode 构造与 rotate/compact 后 refresh；旧格式 checkpoint 无 head 公钥时，
      用户确认后回退为 pin 对端当前广告的 seq/head/keys（不再逐条回放旧记录）。
回归  net 新增 checkpoint 刷新 / legacy 回退两用例（42/42）。

双端真机（B 上临时新身份，A 为真实 host）：
  单次邀请  A 生成 v3 邀请 → 第一身份 7a9112ae 接纳；第二身份 8c6d41b9 同一 jti 被拒
            （handshake-closed / peer-rejected；ledger usedBy=7a9112ae）
  checkpoint 新身份 pin A@seq0 → 第一次连接 rotation-checkpoint-required（from=5, checkpoint seq4）
            → offer 含 headEdPublic → trust trusted → 重连 connected，A 补到 seq12/head NWSS…
  清理        临时身份从 A roster 删除；B 侧 probe 文件与邀请文件删除。
  升级后      A/B 均 1.12.3，自动重连；fleet_delegate → V123-BASELINE-OK（1801ms）；A 链 8 条/from=5，B pin seq12。
```

1.13.0 新增与真机结果：

```text
新增       invite 带 rotations + split/join；文件 stat/list/delete + 目录/续传；room.rotationSeqMode=strict；
           重置前关 Room；checkpoint 确认广播；notifications.webhook；同步退避；a11y；relay-mtls.mjs
真机       A/B 1.13.0 重连；fleet_delegate → V130-BASELINE-OK（1056ms）
文件       目录上传 2 文件 10246B → list 正常 → 递归下载哈希一致；续传（100B→5000B）后下载哈希一致；
           递归删除成功、再 list 返回 file-not-found
invite     HTTP 生成→decode：rotations=8、finalSeq=12、+24h；300 字符分片=40 段
config     POST room.rotationSeqMode=strict 成功；GET 后已回退 audit
webhook    simulation 审批 → 本地 listener 收到 POST（kind=approval）
mTLS       scripts/relay-mtls.mjs 生成 CA/server/client 证书与 relay-mtls.json
未做       重置前 Room 清理未真机执行（需重置身份）；strict 拒绝路径未构造；checkpoint 广播/Relay 多活未双端触发
```

1.14.0 新增与验证：

```text
命名        friendlyName 稳定哈希 → 「琥珀狐狸 27」；Room title 持久化、旧 Room 自动补名
成员        host→主持人、remote→成员名/远程成员；消息 fromLabel 不再拼 memberId
UI          页面最大宽度/留白、分段 tab、卡片层次、Room 标题+元信息、成员头像、任务中文化、气泡消息
quorum      rotation.checkpointQuorum（默认1）；确认广播计入 endorsement，trust 前检查 1+endorsements
测试        net 44/44（含 quorum 计数）、host 66/66（含命名/标题断言）、smoke passed
```

## 一句话结论

Fleet 同账号配对、AES-GCM 直连、账号指纹绑定、直调/委派、Room 消息/任务/Replica/镜像同步、审批（once/ttl/room/task + 离线撤销队列）、Relay（TLS/mTLS/指纹 allowlist/轮换吊销脚本）、authority promotion/downgrade、mirror wake、密钥轮换/吊销/分叉/链分页/checkpoint 压缩与用户确认、一次性过期邀请、通知中心、二进制文件传输、归档 Room 运行时恢复、动态 i18n、Agent 说明书均已实现并通过单测/部分真机。真 P2P、3+ 设备矩阵、Relay TLS 实链路与长压测仍未完成。

## 已完成（当前代码）

| 领域 | 状态 | 证据 |
| --- | --- | --- |
| Fleet 配对/直连/发现/relay 候选 | 可用 | net 40/40；A/B 1.11.0 真机直连 |
| 账号指纹绑定（`account.json`） | 可用 | 1.9.2 真机恢复；creator peer 绑定 |
| 直调、委派、审批收件箱/UI | 可用 | fleet_call/fleet_run/fleet_delegate 多次真机通过 |
| Room 消息/成员/任务/字段级 CRDT/签名 | 可用 | host 61/61；A/B 真机 |
| Room Replica / mirror sync / signedRoomId 重映射 | 可用 | `room_sync` 真机；sync 授权修复 |
| 跨设备唤醒 `room.wake.member` | 可用 | 1.9.0 CROSS-WAKE 闭环 |
| authority claim / heartbeat / promotion | 可用 | 1.10.1–1.10.6 单测与真机 |
| 旧 authority 自动降级 / mirror 收敛 | 可用 | 1.10.6 真机：A mirror=B/A 主 Room, epoch6 |
| reload 保持 mirror / 启动宽限期 | 可用 | 1.10.4 启动宽限；1.10.12 最终回归 |
| remote wake + `room_reply` | 可用 | 1.10.8 B-test ACK，作者/去重正确 |
| 设备密钥轮换（保持 deviceId） | 可用 | 1.10.0/1.10.9 真机 |
| 签名 rotation chain + 握手补发 + 离线补链 | 可用 | 1.10.12：B 从 seq0 验到 seq1，roster `rotationSeq=1` |
| roster HMAC 防篡改 | 已实现 | `roster.sig`；load 校验失败清空 |
| **设备吊销 `device.revoke` + 握手拒绝 + 墓碑** | **已实现（1.11.0）** | net：吊销阻止握手、自证/第三方区分 |
| **同 seq 不同 hash 分叉检测 + 人工选择** | **已实现（1.11.0）** | `applyRotationChain` / `fleet_rotation_fork_resolve`；net 分叉用例 |
| **握手内 rotation 链分页（16 内联 / 64 每页 / 1024 上限）** | **已实现（1.11.0）** | net：20 步链双向补链用例 |
| **密钥泄露恢复（先吊销 → `fleet_reset_identity` → 重新入网）** | **已实现（1.11.0）** | store/identity 重置单测；工具带 `confirm` 门禁 |
| **签名邀请引导（creator/roster/吊销墓碑 + HMAC）** | **已实现（1.11.0）** | net 邀请 v2 用例；store join 导入用例（ADR-0028） |
| **rotation chain checkpoint 压缩 + `rotation-history-pruned`** | **已实现（1.11.0）** | store 压缩单测；net 剪枝握手用例（ADR-0028） |
| **Relay TLS（控制面 + 数据面）** | **已实现（1.11.0）** | net TLS Relay 用例（自签证书夹具，ADR-0029） |
| **Relay 候选 TTL/排序/状态/UI** | **已实现（1.11.0）** | 候选过期/排序单测；控制台候选卡片 |
| **已归档 Room 列表/恢复/删除入口** | **已实现（1.11.0）** | overview.archivedRooms + 控制台渲染（smoke） |
| **归档 Room 运行时恢复** | **已实现（1.12.0）** | `restoreArchivedRoom` + `room_restore` + host 单测 |
| **一次性/过期邀请（v3）** | **已实现（1.12.0）** | identity/store/握手兑换单测；`invite.ttlMs` |
| **通知中心** | **已实现（1.12.0）** | `NotificationCenter` + 2 路由 + smoke |
| **轮换/重置 UI + 恢复引导** | **已实现（1.12.0）** | 2 路由 + 按钮 + smoke |
| **Room 事件绑定 rotationSeq** | **已实现（1.12.0）** | 签名 canonical 绑定 + 篡改用例 |
| **checkpoint 用户确认信任** | **已实现（1.12.0）** | net 剪枝 checkpoint 用例 |
| **二进制文件上传/下载** | **已实现（1.12.0）** | host 分块/校验 roundtrip；`write` 策略 |
| **Relay 延迟探测 + mTLS** | **已实现（1.12.0）** | net 延迟/mTLS 用例；控制台延迟 |
| 真 P2P / 内置 overlay | 未实现 | 仅检测 Tailscale/ZeroTier |

## 测试基线

```text
net:          44/44   （含 TLS/mTLS Relay、延迟、invite 链/分片、checkpoint 刷新/回退/quorum、分叉、吊销）
host:         66/66   （含 room restore、人类命名、invite 链导入、文件续传/目录/删除、同步退避、UI 路由）
overlay:       2/2
plugin-order:  1/1
perf:          1/1
client smoke: passed（含通知页、归档 Room、密钥恢复引导）
```

口径：2026-11-15 在 A 的 `C:\Users\PS\.dsh\plugins\dsh-device-fleet` 运行 `node scripts/ci.mjs`（源码 1.11.1）。

## 当前环境

- **A**：`50fdaf90-f0aa-440e-9fa6-c60ba5051001`（desktop-ui），Windows，`0.0.0.0:60583`，插件 **1.13.0**（已重载）；identity seq12（本地链 8 条、from=5、checkpoint seq4）。
- **B**：`b8fc0c22-a535-4ed4-864e-7c12ab06ee91`（laptop），LAN `192.168.137.31`，`[::]:60581`，插件 **1.15.2**（已升级并重连）；identity 重置后自身链为空（seq -1）。
- A 的 roster：旧 B `c2d42572-…` 与 `38268e75-…` 均已吊销（墓碑，原因 identity reset）；当前 B `b8fc0c22-…` 在线。
- Room：A 为 authority **epoch9**（`roomId = authorityRoomId = session-269260c9-…`），成员 host / worker-c / B-v111；coordinator 指向当前 B。



## 1.10 关键进展（保留）

### 自动 authority 选举（已验收）

```text
A 停 heartbeat → B 等待过期+启动宽限 → B promote（epoch6、保留 authorityRoomId）
A 恢复 → B 广播 claim → A 真正写入 mirror → room_sync 成功
```

关键修复：

- 1.10.3：`room.authority` 事件在更高 epoch 时真正设置 `room.mirror`；
- 1.10.4：30s 启动宽限期 + 自动 promotion 硬门禁（heartbeat 已见且过期、coordinator、mirror）；
- 1.10.5：promotion 后主动广播 claim；mirror 已存在时可被更高 epoch 更新；
- 1.10.6：mirror sync 按 `authorityRoomId` 查找 Room；本地设备可同步自己的 replica。

### remote wake + room_reply（已验收）

```text
A mirror wake → B-test 本地 participant → room_reply → A 收到 B-TEST-ACK-1.10.8
```

修复：

- 1.10.8：远端设备的 local participant 在 mirror 中归一化为 `kind=remote`；启动迁移历史 local 成员；
- 1.10.7：`recordReply` 按 roomId/mirror.roomId/authorityRoomId 找 promoted authority 的本地 Room。

### 设备密钥轮换与 rotation chain（已验收，1.11.0 扩展）

```text
1.10.0 在线轮换：旧私钥签 record，B roster 更新，A 新密钥重连
1.10.9 链持久化：identity-rotations.json、seq/prevHash、rotation.records RPC
1.10.10–12 离线补链：hello/ack 携带 rotations、transcript 剔除链、按已应用前缀过滤、启动注入 chain
真机：A 离线生成 seq1 → B 重连从旧 head 验 seq1 → roster rotationSeq=1 → delegate OK
1.11.0：吊销/分叉/链分页/身份重置（见 ADR-0027）
```

关键坑：

- 把 rotations 放进 `validateIdentityMessage` 返回对象会改变 transcript，导致握手关闭；改为从原始 message 取链，transcript 使用 `stripRotations`（1.11.0 起同时剔除 `rotationSeq/rotationHead/rotationChunks`）；
- A 启动时漏传 `rotationChain` 导致发送空链，B 报 `peer-rejected`；
- B 必须先过滤已应用的 seq0，只验 seq1，否则 `verifyRotationChain` 首条 seq 不匹配。

## 1.11.x 变更（ADR-0027 / 0028 / 0029）

```text
device.revoke     自己签=绝对吊销；第三方签=advisory，需本机用户确认
吊销墓碑          留 roster，握手 device-revoked；TOFU 不能复活；可向离线 peer 补发
分叉              peer-rotations.json 持久化对端链；同 seq 异 hash/prevHash 断裂/公告 head 不同 → fork
人工处理          fleet_rotation_fork_resolve(confirm)：keep-local / adopt-peer（只接已验证前缀）
链分页            hello/ack rotationSeq+rotationHead+rotationFrom；16 条内联 + 64/页；响应方预推、发起方 pull
链压缩            fleet_rotation_compact(confirm)：归档旧记录 + checkpoint；接收方按自己的 pin 报 rotation-history-pruned
邀请 v2           HMAC 签名 + creator/roster/吊销墓碑引导；加入时 pin 成员、导入墓碑
泄露恢复          fleet_revoke_device(confirm) ×N → fleet_reset_identity(confirm) → 重新配对
Relay TLS         relay.tls.ca → 控制面/数据面 TLS；私钥只在 Relay 主机；peer 候选不能关闭校验
候选生命周期      peer 候选 TTL 7 天；配置永不过期；online/config/failures/最近成功 排序；UI 列表
归档 Room         overview.archivedRooms + 控制台恢复/删除入口
新工具            fleet_rotation_status / fleet_rotation_compact / fleet_revoke_device /
                  fleet_rotation_fork_resolve / fleet_reset_identity
新文件            peer-rotations.json、identity-rotations.archive-*.json、revocations.jsonl（审计）
1.11.1 修复       发送侧不再用对端自身 rotationSeq 判定剪枝（误拒身份重置后的重连）；
                  剪枝判定只由接收方按自己的 roster pin 完成；新增两个回归用例。
```

## 未完成 / 已知缺口（按优先级）

### 明确不做（范围外）

- **真 P2P / NAT 打洞 / 内置 Tailscale-Headscale-VPN**：仅检测已安装的 Tailscale/ZeroTier 并广告地址；跨网靠自建 Relay。
- **设计边界（不是缺口）**：Room 里的“用户”只是一个发言参与者，**不绑定 device、不进入 Fleet roster、没有独立密钥**；单一人格是刻意设计。只有将来需要多个真人账号/权限/在线状态时，才需要另做多用户身份模型。

### P1：功能缺口

- **i18n 仍非逐句完整**：控制台标签、通知/审批/状态/计数/失败原因已中英；插件日志、DSH 原生 prompt/alert、工具原始错误仍是原文。
- **checkpoint 是 head 绑定 M-of-N 签名证书，但仍不是阈值签名/共识**：每个 endorsement 签名 `{deviceId,seq,head}`；接收方按 roster 验签，只有同一 `seq+head` 的不同设备签名才计入 quorum；仍没有聚合签名/共识协议。
- **文件传输**：支持 2 GiB/文件、流式上传下载、续传、目录递归、删除；目录不做差异/增量同步，符号链接只报告不跟随。
- **离线能力**：普通直调/委派仍 fail-fast；需要排队时使用 `fleet_queue_call` / `fleet_queue_delegate`（持久化 outbox，重连/30s 重试，结果可查）。
- **审批持久化**：pending 收件箱与 once/ttl/room/task grants 已落盘；重启后普通调用无法恢复，但状态/审计可见。
- **远端会话轨迹**：目标设备监听 `session/event` 落盘到 `trajectory.jsonl`（默认 800 事件/会话、200 会话、7 天、16 MiB 压缩），递归脱敏敏感键；调用页按 `sessionId` 拉取只读事件。脱敏是启发式，不是 DLP；重启前未落盘的事件仍会丢。
- **Relay 高可用**：客户端多候选 failover/健康检查；服务端证书热轮换；`relay-lease.mjs` + `relay-cluster.mjs --coordinator` 提供跨主机 lease 选主（leader 才启动节点，失联停节点）。coordinator 是显式单点，生产建议 etcd/Consul；不是 Raft/BFT。

### P2：测试与环境

- **3+ 真机矩阵**未跑：第三方吊销 advisory 的本机确认、rotation fork 人工选择、多 Relay 候选 failover、>16 条分页的离线补链。
- 自签 TLS/mTLS Relay 实链路未跑（当前 Relay `210.73.18.88:60600` 离线；只有单测/脚本）。
- 长历史/大消息量/多 Room/大文件并发压测未做；控制台按钮只做了 smoke 与后端抽查，没有逐项点击回归。
- Relay/WAN 受运营商与路由限制。

### 已知风险

- 重复「身份重置 → 重新加入 Room → 再提权」时，旧身份残留的本地 Room authority 元数据仍可能参与一次 epoch 竞争；1.15.2 已加 creator host 回收（收到更高 claim 后自动降级再提权），但 3+ 设备/网络分区下的多轮竞争未覆盖。
- checkpoint endorsement 只证明“某设备确认过”，不证明该设备独立验证了链；quorum 计数可被同一 Fleet 内多个受信设备满足。

## 交接下一步

1. 3+ 设备矩阵：第三方吊销 advisory、fork 人工选择、多 Relay failover、>16 条分页离线补链；
2. 自签 TLS/mTLS Relay 实链路 + 长压测（大 Room/多 Room/大文件）；
3. 若继续产品化：i18n 扩展到错误/通知正文、审批队列持久化、文件传输上限/增量目录同步；
4. 设计确认：checkpoint 是否升级为密码学多签；Room authority 在 3+ 设备/分区下的收敛策略。

历史流水见 [notes/dev-release.md](./notes/dev-release.md)；轮换链设计见 [ADR-0026](./adr/0026-signed-roster-rotation-chain.md)，吊销/分叉/分页见 [ADR-0027](./adr/0027-device-revocation-fork-and-chain-paging.md)，邀请/压缩见 [ADR-0028](./adr/0028-signed-invite-bootstrap-and-chain-checkpoint.md)，Relay TLS/候选见 [ADR-0029](./adr/0029-relay-tls-and-candidate-lifecycle.md)，P0/P1 见 [ADR-0030](./adr/0030-archived-room-restore-single-use-invites-notifications.md) / [ADR-0031](./adr/0031-checkpoint-trust-file-transfer-room-rotation-and-relay-health.md)。
