# ADR-0027：设备吊销、轮换分叉处理与链分页

- **状态**：已实现（2026-11-15），1.11.0 发布，1.11.1 修复真机发现的剪枝误判；A/B 真机已验证吊销/恢复/离线补链/Room 恢复，分叉人工选择与 3+ 设备仍待真机覆盖。
- **相关**：ADR-0026（签名 roster 轮换链）、ADR-0024（版本严格匹配）、[STATUS.md](../STATUS.md)、`src/net/rotation.js`、`src/net/secure-channel.js`、`src/net/fleet-node.js`、`src/host/store.js`
- **结论**：在 ADR-0026 的轮换链之上补齐 P0 收尾——由用户确认的 `device.revoke`、同 seq 不同 hash 的分叉检测与人工选择、握手内链分页，以及密钥泄露后的「先吊销、再重置身份」恢复流程。真正的链压缩（checkpoint）留待后续。

## 背景

ADR-0026 已经实现：`device.rotation` 记录、seq/prevHash 链、roster 的 `rotationSeq/rotationHead`、握手内补发、离线补链（1.10.12 真机通过）。仍未解决：

1. 旧密钥泄露后无法声明作废；轮换不能阻止已泄露的密钥继续签名。
2. 两条链在同 seq 上分叉（同一把旧密钥签了两个不同新密钥）时只能整链拒绝，用户无法判断/选择。
3. 链只在握手 hello/ack 里整段携带；链一长，握手报文线性膨胀。
4. 被泄露的设备没有恢复路径：换密钥不算恢复，因为攻击者也能用同一把旧密钥签名。

## 决策

### 1. 吊销记录：本地确认 + 签名广播

```text
device.revoke {
  v: 1,
  type: "device.revoke",
  deviceId,          // 被吊销设备
  revokedSeq,        // 断言方看到的对方链头 seq（审计用，不可伪造信任）
  revokedHead,       // 对应 head hash
  revokedAt,
  reason,
  revokedBy,         // 断言方 deviceId
  revokerEdPublic,   // 断言方当前 Ed25519 公钥
  signature          // 断言方当前私钥对 canonical（不含 signature）签名
}
```

- **自己吊销自己**（`revokedBy === deviceId`）：必须由 roster 里 pin 的当前公钥签名；收到即生效（绝对）。
- **第三方吊销**：签名只证明「谁在断言」，不证明「密钥真的泄露」。收到后只写 `revocationPending`，由本机用户确认（`fleet_revoke_device confirm: true`）后才写 `revokedAt`。
- 吊销落成 roster 墓碑：`revokedAt/revokedBy/revokedSeq/revocationReason/revocationSource/revocationRecord`，并保留在 `roster.json`；`authorizePeer` 在握手阶段直接以 `device-revoked` 拒绝，TOFU 不会再把它加回来。
- 本地吊销同时级联移除该设备在所有 Room 的成员、断开连接、删除回连地址；`fleet_remove_device` 才是删除墓碑（删除后才可能被 TOFU 重新信任）。
- 已吊销设备不能靠轮换自救：`applyRotationChain` 对 `revokedAt` 的条目直接返回 `revoked`。
- 广播：本地吊销向当前已连接的其它设备发 `fleet.device.revoke`；新 peer 连上时，把 roster 里保存的 `revocationRecord` 再广播一次，覆盖离线错过的设备。第三方记录可以中继（签名与 revoker 的 roster 公钥才是判据，不要求发送者=签名者）。

### 2. 分叉检测：持久化对端链 + 阻塞自动更新

- 每台设备在 `peer-rotations.json` 保存它已接受的对端链：
  `{ [deviceId]: { genesisEdPublic, genesisXPublic, records: [...] } }`，genesis 是首次接受轮换前的 pin 公钥。
- 三类分叉统一识别：
  1. 收到 seq ≤ 本地 head 的记录，hash 与已接受记录不同；
  2. 收到 seq = head+1 的记录，但 `prevHash` 不等于本地 head；
  3. 握手对端广播的 `rotationSeq` 与本地相同、`rotationHead` 不同（不需要传记录即可发现）。
- 命中后写 roster `rotationFork = { seq, localHead, localHash, remoteHead, remoteHash, detectedAt, source, records }`，**不更新**公钥，握手以 `rotation-fork` 失败并写 `diagnostics.jsonl`；`records` 保留触发分叉的对端分支（上限 1024 条），供人工选择。
- 人工处理：`fleet_rotation_fork_resolve({ deviceId, action, confirm: true })`
  - `keep-local`：清掉 fork 标记，继续用本地分支；
  - `adopt-peer`：只接受「能从本地已验证前缀接上」的对端分支；校验通过后丢弃本地冲突尾部、改用对端分支的最后一个密钥。接不上的分支返回 `fork-not-resolvable`，只能先吊销/重新配对。
- 没有 genesis 历史的旧条目（升级前就轮换过）只能以当前 head 为锚点，分叉检测与 adopt 范围相应变小；文件里会带 `warning: rotation-history`。

### 3. 链分页：按需补发，不再整段塞握手

- hello/ack 新增 `rotationSeq` / `rotationHead`；这两项与 `rotations`、`rotationChunks` 一样**不进入握手 transcript**（`stripRotations` 统一剔除），签名仍然覆盖它们。
- 常量：内联最多 16 条（`ROTATION_INLINE_LIMIT`），每页 64 条（`ROTATION_PAGE_LIMIT`），单次握手最多 1024 条 / 16 轮拉取。
- 两种方向：
  - **响应方 → 发起方**：响应方在 ack 时已知道发起方的 `rotationSeq`，只发它缺的后缀；前 16 条内联，其余作为 `rotation.page`（ack 里 `rotationChunks` 声明页数）紧跟 ack 发出。发起方必须先把这些页读完，才能从 newline 握手切到二进制帧。
  - **发起方 → 响应方**：hello 只能盲发最早 16 条；响应方应用后发现仍落后，就发 `rotation.pull { fromSeq, limit }`，发起方用 `rotation.page` 回答，最多 16 轮。
- 现成的 `fleet.rotation.records` RPC 也支持 `{ fromSeq, limit }` 分页（返回 `{ records, fromSeq, complete }`），供诊断工具与后续 checkpoint 使用。
- 明确不做：目前没有密码学压缩/checkpoint。旧 peer 落后超过 1024 条时会以 `rotation-chain-too-long` 失败，提示重新配对；后续若要支持超长链，需要引入受信任 checkpoint（见「未决」）。

### 4. 密钥泄露恢复：先吊销，再重置身份

```text
1) 在其它设备上 fleet_revoke_device(deviceId, confirm: true)   // 每台设备各自确认
2) 在受影响设备上 fleet_reset_identity({ confirm: true })       // 归档旧 identity 与链，生成新 deviceId
3) 新身份重新配对（fleet_invite / fleet_join 或直接连接）
```

- `fleet_reset_identity` 会把 `identity.json`、`identity-rotations.json`、`identity-rotation.json` 归档为 `*.bak-reset-<时间戳>`，生成全新 deviceId，清空本地链，关闭所有连接；`fleet.json`（Fleet 成员密钥）保留，便于重新入网。
- 被吊销的旧 deviceId 不能恢复；新设备以新 deviceId 被 TOFU/邀请重新接纳，Room 成员需要重新邀请（旧 Room 事件保留在本地副本，不会回收明文）。
- 这是「用户确认」路径：纯协议无法在密钥已泄露时自证清白，必须由人决定信任哪台设备。

## 不变量

1. `deviceId` 永不因轮换改变；吊销也只作用于 `deviceId`，不产生新 id。
2. 吊销记录必须由断言方当前 pin 的公钥签名；自己吊销自己时，签名公钥必须等于该条目当前公钥。
3. 第三方吊销只产生 `revocationPending`，没有本地确认就不会进入 `revokedAt`。
4. 被吊销设备不能通过轮换、TOFU 或重连恢复；删除墓碑（`fleet_remove_device`）是唯一的重新信任入口。
5. 轮换记录的 `seq` 单调递增、`prevHash` 连续；同 seq 不同 hash 一律视为分叉，不自动更新。
6. 分叉的人工选择必须显式 `confirm: true`；`adopt-peer` 只能接在已验证的本地前缀上。
7. 握手先验链、再信任新公钥；`rotationSeq/rotationHead/rotations/rotationChunks` 不参与 transcript。
8. 握手内链传输有上限（1024 条 / 16 轮），超限失败并提示重新配对，不允许无界内存消耗。

## 后果

- 正：泄露的密钥有明确的作废与恢复路径；分叉不再静默接受；长链不再撑大握手；离线设备仍能追上轮换（含长链）。
- 负：协议字段变更多，**插件版本必须两端同步升级到 1.11.0**（ADR-0024）；对端链文件与 fork 记录都会持久化，roster 体积略增；`revokedAt/rotationFork/revocationRecord` 等字段不在 `roster.sig` 的 canonical 内（与既有 `rotationSeq/rotationHead` 一样），文件级篡改仍只能靠 Fleet key 重签来发现。
- 负：分叉的 `adopt-peer` 是人工信任动作，工具/UI 必须提示用户先核对对方设备，不能当成自动修复。

## 未决

- 链压缩/checkpoint：是否允许把「seq N 的 head」做成受多方签名或用户确认的 checkpoint，从而截断历史；
- 是否需要把 rotation/revocation 记录纳入 Fleet invite（新设备入网即拿到完整链）；
- Room 事件签名是否绑定 `rotationSeq`（当前只绑 `deviceId` 与事件内容）；
- 3+ 设备的吊销/分叉真机矩阵。
