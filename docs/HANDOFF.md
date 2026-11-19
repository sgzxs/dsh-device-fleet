# 新 Session 交接文档

**交接时间：2026-11-17 15:00（Asia/Shanghai）**  
**项目：dsh-device-fleet 1.20.8（正式版，npm `latest`）**  
**一句话：1.20.8 同步文档/仓库元数据并修复 GitHub CI；运行时代码同 1.20.7，A/B 仍在 1.20.7。**

---

## 1. 新 Session 先做这 5 步

1. 工作目录：
   ```powershell
   cd C:\Users\PS\.dsh\plugins\dsh-device-fleet
   ```
2. 读文档：
   - [STATUS.md](./STATUS.md)（唯一现状页，含真机测试结果与 1.11.1 修复）
   - [ARCHITECTURE.md](./ARCHITECTURE.md)（结构与不变量）
   - [ADR-0027](./adr/0027-device-revocation-fork-and-chain-paging.md)（吊销/分叉/分页/恢复）
   - [ADR-0028](./adr/0028-signed-invite-bootstrap-and-chain-checkpoint.md)（邀请引导/链压缩）
   - [ADR-0029](./adr/0029-relay-tls-and-candidate-lifecycle.md)（Relay TLS/候选）
   - [ADR-0026](./adr/0026-signed-roster-rotation-chain.md)（rotation chain 设计背景）
   - [DOC-MAP.md](./DOC-MAP.md)（文档路由）
3. 跑测试：
   ```powershell
   node scripts/ci.mjs
   ```
   期望：
   ```text
   net 45/45、host 68/68、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed
   ```
4. 看 A/B 状态（当前 1.11.0）：
   ```text
   fleet_status
   fleet_rotation_status
   room_status({ roomId: "session-269260c9-d6b9-4cf6-b142-deda4d629524" })
   ```
5. 不要从 `notes/` 旧快照推断现状；以 STATUS + 当次命令输出为准。

---

## 2. 当前环境

| 设备 | deviceId | 版本 | 地址 | 状态 |
| --- | --- | --- | --- | --- |
| A（desktop-ui） | `50fdaf90-f0aa-440e-9fa6-c60ba5051001` | 1.20.7 | `0.0.0.0:60583` | 运行中；identity seq12（from 5，checkpoint seq4，records 8） |
| B（laptop） | `b8fc0c22-a535-4ed4-864e-7c12ab06ee91` | 1.20.7 | `[::]:60581`，LAN `192.168.137.31` | 运行中；已恢复 |
| B 旧身份 ×2 | `c2d42572-…`、`38268e75-…` | — | — | 均已重置并**吊销**（墓碑） |
| C | `5e281cdf-684f-40fa-a0a6-b2209420035b` | — | — | 不在 roster |

- **两端必须同版本**；A/B 均 1.20.7。
- A 的源码目录同时是 profile 的 `link:` 安装源；通过 `plugin_manager set_bundle` 重载即可加载新版本。
- B 的 `execution.cwd=C:\Users\threemore\.dsh`；Room agent 回合需要 B 本地模型凭证。
- Room：A 为 authority **epoch9**（`roomId = authorityRoomId = session-269260c9-…`），成员 host / worker-c / B-v111；coordinator 指向当前 B。

---

## 3. 已完成并验收

```text
Fleet 同账号配对 / 直连 / 账号指纹绑定 ✅
fleet_call / fleet_run / fleet_delegate ✅
Room 消息/任务/Replica/mirror sync ✅
authority promotion / 旧 authority 降级 mirror / room_sync ✅
remote wake → room_reply ✅
设备密钥轮换（保持 deviceId）✅
rotation chain 持久化 + 握手补发 + 离线补链 ✅
1.11.x P0：吊销 / 分叉检测与人工选择 / 链分页 / 身份重置 ✅（真机除 fork 人工选择）
1.11.x P1：签名邀请引导 / 链 checkpoint 压缩 / Relay TLS / 候选 TTL·排序·UI / 归档 Room ✅（Relay TLS 仅单测）
```

关键真机证据（2026-11-15）：

```text
[1.11.0] A seq2 / B seq0 双向在线轮换 → roster head 一致；delegate ROTATION-OK
[1.11.0] A 10 条链 → compact keep 8（归档 seq0-1、checkpoint seq1、from=2）→ 再轮换 seq10
[1.11.0] 邀请 v2 1870 字符 → decode：creator seq10 / roster / relays / endpoints / HMAC 全部通过
[1.11.0] B fleet_reset_identity → A TOFU 接纳（当时需手动 connect）；delegate RESET-OK
[1.11.0] A 吊销新 B → 入站 rotation-revoked；删除墓碑 → 同 id 重新接纳 → delegate READMIT-OK
[1.11.0] B 离线时 A 轮换 seq11/seq12 → B 重连 roster A=12 → delegate OFFLINE-CATCHUP-OK
[1.11.0] Room：A 提权 → 清理旧 B 成员 → 重加新 B → ROOM-RECOVERY-OK / FINAL-ROOM-OK
[1.11.1] A/B 双端 1.11.1 在线；delegate V111-BASELINE-OK
[1.11.1] B fleet_reset_identity → 新 id b8fc0c22；10s 内自动回连（无手动 connect），delegate V111-AUTORECONNECT-OK
[1.11.1] 旧身份 c2d42572/38268e75 吊销；Room 重加新 B → remote wake V111-ROOM-OK；A authority epoch9
node scripts/ci.mjs → net 45/45 · host 68/68 · overlay 2/2 · plugin-order 1/1 · perf 1/1 · client smoke passed
```

1.11.1 修复：A 压缩链后 B 重置身份（自身链为空）主动重连时，A 的**发送侧**剪枝检查误把 B 公告的
`rotationSeq` 当成 B 对 A 的 pin，错误报 `rotation-history-pruned`，导致 B 无法自动回连。修复为：
发送侧只按对端 seq 推送可用后缀；剪枝判定只由接收方用自己的 roster pin 对照对端的 `rotationFrom` 完成。
新增两个回归用例（peer 自身链为空但 pin 在 responder 头；剪枝链仍接纳全新 peer）。

### 1.12.0（P0+P1）新增能力

```text
归档 Room     RoomService.restoreArchivedRoom + room_restore + /room/restore；replica → 可写 Room
邀请 v3       jti/expiresAt/singleUse；hello inviteId；首次 TOFU 兑换；known-devices 豁免重接纳；invite.ttlMs
通知          NotificationCenter + overview + GET/read 路由 + 控制台通知页/桌面通知
密钥 UI       轮换/重置按钮（重置输入 RESET）+ 恢复三步引导
checkpoint    握手携带 checkpoint（含该高度公钥）；本机存 offer；trust 后采纳 head 公钥并续链
文件传输      fleet_upload/fleet_download，512 KiB 分块 + SHA-256 + 2 GiB 上限（流式）；write 默认 ask
Room seq      新事件 canonical 绑定 rotationSeq；旧事件兼容
Relay         ping/pong 延迟、候选按延迟排序、TLS + mTLS（客户端 cert/key），控制台显示延迟
```

### 1.12.2 双端真机（A/B 均 1.12.2）

```text
重连/版本   A/B pluginVersion=1.12.2；B online，fleet_call 20ms
基线委派    fleet_delegate → V122-BASELINE-OK（1457ms）
归档 Room   创建→发消息→归档→restore（消息保留）→继续写→删除
Room seq    新消息 event: rotationSeq=12, origin=A, signature=true
通知        B→A run：A pending approval + notification(unread=1) → approve once → mark read(unread=0)
文件        B→A download 1034 bytes，SHA-256 Egp0… 一致；B 侧 Remove-Item 清理成功
invite      /pair/invite 字符串 code(4717)+expiresAt；decode jti/singleUse/creatorSeq=12
环境项      B→A fleet_run 初始化执行槽时 SetNamedSecurityInfoW(Win32 5) 失败（A 的 E:\Dsh_test ACL），
            命令未执行；A→B fleet_run 正常。属于 A 的 DSH 执行 workspace 权限，不是插件问题。
```

### 1.12.3 双端真机（B 上临时新身份，A 真实 host）

```text
单次邀请   邀请 v3 → 第一身份 7a9112ae 接纳；第二身份 8c6d41b9 同 jti 被拒
           （handshake-closed / peer-rejected，ledger usedBy=7a9112ae）
checkpoint 新身份 pin A@seq0 → rotation-checkpoint-required（from=5, checkpoint seq4）
           → offer 含 headEdPublic → trust trusted → 重连 seq12/head NWSS…
清理       临时身份从 A roster 删除，B/A 临时邀请与 probe 文件删除
升级后     A/B 均 1.12.3 自动重连；fleet_delegate → V123-BASELINE-OK（1801ms）
```

### 1.13.0 双端真机（A/B 1.13.0）

```text
重连/基线   A/B 1.13.0；fleet_delegate → V130-BASELINE-OK（1056ms）
文件        目录上传 2 文件/10246B → list → 递归下载哈希一致；100B→5000B 续传后哈希一致；
            递归删除成功，再 list 返回 file-not-found
invite      HTTP 生成 → decode rotations=8/finalSeq=12/+24h；300 字符分片 40 段
config      room.rotationSeqMode=strict 接受，随后回退 audit
webhook     simulation 审批 → 本地 listener 收到 POST(kind=approval)
mTLS        relay-mtls.mjs 生成 CA/server/client；relay-client-cert.mjs rotate/revoke/list + 指纹 allowlist
未做        重置前 Room 清理（需重置身份）、strict 拒绝路径、checkpoint 广播与 Relay 多活双端触发
```

### 已知问题（Room × 重复身份重置）

测试中 A 提权到 epoch7 后，旧 B 身份（仍是 Room 成员）曾把自己提升到 epoch8 并 claim，A 降为 mirror；
旧 B 随后被重置，A 再次 promote 到 epoch9 才完全恢复。根因是旧身份重置前残留的本地 Room authority
元数据仍参与 epoch 竞争，属于恢复流程边界而非本轮代码回归。恢复建议：重置前先 `room_remove_device`
或关闭相关 Room；重置后由存活设备立即 promote 并清理旧成员。后续可在 `fleet_reset_identity` 内自动归档
本地 authority Room。

---

## 4. 代码结构速查

```text
src/plugin/index.js          DSH Host 插件入口：工具、Room 路由、RPC、rotationChain/peerRotations 注入、吊销/重置/分叉/压缩动作
src/net/fleet-node.js        网络门面：直连/relay/roster、applyRotation/applyPeerRotations/applyRevocation/resolveFork、候选 TTL
src/net/secure-channel.js    握手：rotationSeq/Head/From 公告、16 条内联、rotation.page 分页、rotation.pull 拉取、剪枝失败
src/net/rotation.js          seq/prevHash chain、吊销记录、checkpoint、applyRotationChain（分叉/gap）、resolveRotationFork、分页
src/net/relay-server.js      Relay 控制面/数据面，可选 TLS/mTLS，按 IP 限流，ping/pong
src/net/relay-client.js      Relay 客户端（TLS/mTLS/重连/失败计数/延迟探测），控制面 + 数据面
src/net/tls-options.js       Relay TLS PEM/路径解析（客户端 cert/key、服务端 mTLS）
src/host/store.js            identity/roster/peer-rotations/rotation state、invite 账本/known-devices、链压缩、reset
src/host/identity.js 同目录  邀请 v3 编码/解码与 HMAC（实为 src/net/identity.js）
src/host/room-service.js     Room authority、promote/downgrade、heartbeat、归档 Room 恢复
src/host/room-replica.js     Replica 状态/authority 事件/归档标记
src/host/notifications.js    通知环形列表 + notifications.jsonl 审计
src/host/file-transfer.js    分块上传/下载、SHA-256、大小上限
src/host/remote-room-peer.js 远端 participant wake/reply binding
src/host/remote-room.js      authority 侧 room.reply recordReply
src/host/tools.js            工具定义与 handlers（rotation/revoke/fork/reset/trust_checkpoint/upload/download）
client.js                    Fleet 控制台：设备/房间/通知/审批、密钥操作、Relay 延迟、归档 Room 恢复
test/net.test.mjs            45 项（含 TLS/mTLS Relay、指纹 allowlist、延迟、invite 链/分片、checkpoint 刷新/回退、分叉、吊销）
test/host.test.mjs           65 项（含 restore、invite 链导入、文件续传/目录/删除、同步退避、UI 33 路由）
test/fixtures/tls/           自签证书 + 客户端证书夹具（TEST-ONLY；openssl.cnf 记录再生成命令）
scripts/ci.mjs               全量 CI
```

新数据文件（`$DSH_HOME/device-fleet/` 或 profile 的 `device-fleet/`）：

```text
peer-rotations.json                每个对端已接受的链 { genesisEdPublic, genesisXPublic, records }
identity-rotations.json            本机链；压缩后变为 { v, checkpoint, records }
identity-rotations.archive-*.json  压缩归档的旧记录
issued-invites.json                本机发出的邀请 { jti: { createdAt, expiresAt, usedAt, usedByDeviceId } }
known-devices.json                 曾被接纳的 deviceId（删除后重接纳不重复消耗邀请）
notifications.jsonl                通知审计（追加）
revocations.jsonl                  本地吊销审计（追加）
diagnostics.jsonl                  新增 rotation-fork / revocation-pending / identity-reset 事件
```

---

## 5. 关键坑（不要再踩）

1. **握手新字段必须从 transcript 剔除**  
   `rotationSeq/rotationHead/rotationFrom/rotationChunks` 与 `rotations` 一起在 `stripRotations()` 里剔除；签名仍然覆盖它们。再往 hello/ack 加字段时，两边都要同步剔除，并升版本。
2. **ack 之后紧跟的 page 必须在切二进制帧之前读完**  
   响应方在 `finishIdentity()` 里先写 ack + 所有 `rotation.page`，再 `deriveKeys/enterFrames`；发起方在 `expectedChunks > chunks` 时不能 finish，否则 newline JSON 会被当成帧解析（`frame-invalid`）。
3. **分叉不是普通验链失败**  
   `applyRotationChain` 返回 `fork` 时不能自动更新公钥；roster 写 `rotationFork` 并阻塞，必须 `fleet_rotation_fork_resolve(confirm: true)`。`adopt-peer` 只接受能接到已验证本地前缀的分支。
4. **吊销是「本地确认」不是「远端命令」**  
   第三方 `device.revoke` 只写 `revocationPending`；只有本机 `fleet_revoke_device(confirm: true)` 才写 `revokedAt`。自签吊销（`revokedBy === deviceId`）才立即生效。
5. **被吊销的 deviceId 不能复活**  
   轮换、TOFU、重连都不行；只能 `fleet_remove_device` 删墓碑后重新配对。`fleet_reset_identity` 会换新 deviceId，旧 id 的吊销不受影响。
6. **撤销后重连方向**  
   吊销会清掉该设备的 peer hint（避免反复回连旧 id）；恢复后的新设备需要主动连其它设备（对方按 TOFU 接纳新 id）。
7. **rotations 不能放进 `validateIdentityMessage` 返回值**（1.10 老坑）  
   它会改变 transcript；从原始 `message.rotations` 取链，transcript 用 `stripRotations()`。
8. **FleetNode 必须传 `rotationChain` 和 `peerRotations`**  
   漏 `rotationChain` → 握手发空链；漏 `peerRotations` → 分叉检测退化为只看 head。
9. **接收端先过滤已应用前缀**（保留）
   B 已 seq0 时，A 发 `[seq0, seq1]`；`applyRotationChain` 会自动按 seq/prevHash 判断，不要手写过滤。
10. **邀请 v2 的 HMAC 在 fleetKey 上**  
    `encodeInvite/decodeInvite` 用 `HMAC(fleetKey, "invite-v2|" + stableStringify(payload 去掉 sig))`；新增字段必须同时进签名，否则会被判定无效。加入方导入引导时**不覆盖本地已 pin 公钥**。
11. **链压缩会让旧 pin 的设备失效**  
    `fleet_rotation_compact` 后活动链首条 seq 之上的 peer 仍可补链；更早的 peer 会得到 `rotation-history-pruned`，只能重新配对。压缩前先确认所有设备在线。
12. **Relay 候选不能由 peer 关闭证书校验**  
    peer 广告的 `tls` 只接受 `ca/servername`；`rejectUnauthorized: false` 只来自本地配置或签名邀请。学到的候选 7 天 TTL，配置候选永不过期。
13. **promotion 后必须广播 claim**（保留）
14. **remote participant 成员归一化**（保留）
15. **B 的远程插件管理需要 B 本地审批/GUI**（保留）

---

## 6. 常用验证命令

```text
fleet_status
fleet_list
fleet_rotation_status
fleet_rotation_status({ deviceId: "<B>" })
fleet_call(B, fleet_status)
fleet_run(B, "Get-Location")
fleet_delegate(B, "Reply with exactly: HELLO")
room_status({ roomId: "session-269260c9-d6b9-4cf6-b142-deda4d629524" })
room_sync({ roomId: "session-269260c9-d6b9-4cf6-b142-deda4d629524" })
room_members({ roomId: "session-269260c9-d6b9-4cf6-b142-deda4d629524" })
```

吊销/恢复/压缩（都需要用户确认，先问再做）：

```text
fleet_revoke_device({ deviceId: "<B>", reason: "lost key", confirm: true })
fleet_rotation_fork_resolve({ deviceId: "<B>", action: "keep-local" | "adopt-peer", confirm: true })
fleet_rotation_compact({ keep: 64, confirm: true })
fleet_reset_identity({ confirm: true, reason: "leaked key" })
```

A 主 Room id：

```text
session-269260c9-d6b9-4cf6-b142-deda4d629524
```

B 本地 mirror Room id：

```text
session-a7026b70-f6f3-4c82-aca0-5e4c597cb3bc
```

---

## 7. 下一步待办

### P0：已完成（1.11.1 双端回归）

- A 已通过 `plugin_manager set_bundle` 重载到 1.11.1；B 已安装 1.11.1 并重启；
- 已复验：直连、`fleet_call/run/delegate`、Room wake、**B 重置身份后 10s 内自动回连**（1.11.1 修复）、旧身份吊销；
- 1.11.0 阶段已验：轮换/压缩/离线补链/吊销/身份重置/Room 恢复/邀请 v2（见 §3）。

### P1：仍开放的代码项与测试

- 3+ 设备矩阵：第三方吊销 advisory（收到后需本机确认）、分叉人工选择、多 Relay 候选 failover、>16 条分页离线补链；
- 自签证书 Relay TLS/mTLS 实链路；控制台按钮逐项点击回归；服务端证书已支持 SIGHUP 热轮换（Windows 上重启 Relay）；
- i18n 已覆盖控制台静态标签与通知/审批/Room 动态句子；插件日志、DSH 原生 prompt、工具原始错误仍未翻译；
- checkpoint 仍是“每个确认签名 + 有效签名计数”，不是阈值多签/共识；
- 文件传输 2 GiB/文件（流式）、目录无差异同步；审批收件箱与 grants 已持久化；
- 离线 outbox 已提供显式 `fleet_queue_*`；普通直调/委派仍 fail-fast；
- 调用详情页已聚合调用元数据/结果，不包含完整 DSH turn trajectory；
- 真 P2P/内置 overlay 仍为范围外；
- 设计边界：Room 的“用户”是单一发言参与者，不绑定 device/roster；不是待办缺口。

### P2：环境/测试

- 1.12.3 双端回归已完成（含单次邀请/checkpoint）；剩余 3+ 真机（吊销广播、分叉选择、候选 failover、长链补链）；
- 自签 TLS/mTLS Relay 实链路、控制台按钮逐项点击；
- 多 Room、长历史/大消息压测；1.11.1 Room/authority 状态复核已完成（A epoch9 / B-v111）。

---

## 8. 回滚与数据备份

A：

```text
identity.json.bak-1.10.9-rotation
identity-rotations.json.bak-1.10.9
identity-rotations.archive-2026-11-15T05-03-37-808Z.json（1.11 压缩归档，含 seq0-1）
rooms.json.bak-split-20261114
```

B（1.11 身份重置后）：

```text
identity.json.bak-reset-*
identity-rotations.json.bak-reset-*
identity-rotation.json.bak-reset-*
rooms.json.bak-before-mirror-reset
rooms.json.bak-split-20261114
```

1.11.0 源码快照（修改前备份）：

```text
C:\Users\PS\.dsh\tmp\dsh-device-fleet-backup-1.10.12
```

1.11.x 的链文件改为 `{ v, checkpoint, records }`（旧裸数组仍可读，但 1.10.x 读不了新格式）；回滚到 1.10.12 前，先把 `identity-rotations.json` 恢复成升级前的数组文件（或在旧版启动前删除它并重新配对）。邀请 v2 在旧版也不可读（`unknown/unsupported invite`）。

`fleet_reset_identity` 自己归档：

```text
identity.json.bak-reset-<时间戳>
identity-rotations.json.bak-reset-<时间戳>
identity-rotation.json.bak-reset-<时间戳>
```

改 `rooms.json` 前必须先停对应插件，否则运行中的插件会覆盖文件。

---

## 9. 文档入口

- 索引：[README.md](./README.md)
- 现状：[STATUS.md](./STATUS.md)
- 交接：本文件
- 架构：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 术语：[GLOSSARY.md](./GLOSSARY.md)
- ADR：[adr/](./adr/)，轮换链 [0026](./adr/0026-signed-roster-rotation-chain.md)，吊销/分叉/分页 [0027](./adr/0027-device-revocation-fork-and-chain-paging.md)，邀请/压缩 [0028](./adr/0028-signed-invite-bootstrap-and-chain-checkpoint.md)，Relay TLS/候选 [0029](./adr/0029-relay-tls-and-candidate-lifecycle.md)
- 版本流水：[notes/dev-release.md](./notes/dev-release.md)

文档守卫：

```powershell
python "$env:USERPROFILE\.dsh\skills\doc-ledger\scripts\check_docs.py" --root "C:\Users\PS\.dsh\plugins\dsh-device-fleet"
```
