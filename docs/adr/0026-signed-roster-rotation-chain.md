# ADR-0026：签名 roster 轮换链与离线补发

- **状态**：设计已被后续 ADR 扩展（保留为背景）：链结构/验链/本地持久化/握手补发/离线补链、吊销、chain 压缩、分叉人工处理、握手内链分页与泄露恢复已由 [ADR-0027](./0027-device-revocation-fork-and-chain-paging.md) 与 [ADR-0028](./0028-signed-invite-bootstrap-and-chain-checkpoint.md) 落地；checkpoint 已支持压缩/用户确认，invite 携带 rotations 引导，Room 事件绑定 rotationSeq 已实现。
- **相关**：ADR-0024（版本严格匹配）、`src/net/rotation.js`、`src/host/roster-signing.js`、`docs/STATUS.md`
- **结论**：现有“单次设备密钥轮换 + roster HMAC”保留，但需要补一条由旧密钥连续签名的 rotation chain、吊销记录和握手内补发机制；否则离线 peer 无法安全追上轮换，也无法拒绝重放。

## 背景

当前已实现：

- `device.rotation`：旧 Ed25519 私钥签新 Ed25519/X25519 公钥，`deviceId` 不变；
- `fleet_rotate_identity`：要求所有 connected peer ack 后才切换；
- roster 写入 `roster.sig` HMAC，检测文件篡改。

缺口：

1. 轮换时离线/未连接的 peer 不会收到 rotation record；它下次握手仍拿旧 roster 公钥，会拒绝新密钥。
2. 没有 rotation chain 序号/前序哈希，无法判断两条 rotation 的先后，也无法拒绝重放。
3. 没有吊销记录；旧密钥泄露后无法声明“新链已接管、旧链作废”。
4. roster HMAC 是 Fleet 共享密钥签名，不能证明某条轮换由旧设备密钥授权。

## 决策

### 1. Rotation chain

每个设备维护 append-only 链：

```text
rotation[0] = { seq: 0, deviceId, edPublic, xPublic }   // 初始 roster 项
rotation[n] = {
  v: 1,
  type: "device.rotation",
  deviceId,
  seq: n,
  prevHash,          // sha256(canonical(rotation[n-1]))
  oldEdPublic,
  newEdPublic,
  newXPublic,
  rotatedAt,
  signature          // oldEdPrivate 对 canonical（不含 signature）签名
}
```

- `deviceId` 永远不变；
- `seq` 严格递增；
- `prevHash` 形成链，任何中间记录缺失/替换都可检测；
- 对端从 roster 保存的 `rotationHead`（最新 seq/hash）开始验链。

### 2. Roster 保存链头

roster entry 增加：

```text
rotationSeq
rotationHead       // 最新 rotation record 的 hash
```

`rotationHead` 用于快速判断“我落后了”以及握手时声明需要补发的起点。

### 3. 握手补发

`SecureChannel` hello/ack 增加可选字段：

```text
rotationSeq
rotationHead
rotations: [ ... ]   // 仅当对端 head 落后时携带，最多 N 条
```

处理顺序必须是：

1. 用**当前 roster 中已 pin 的旧公钥**验证第一条 rotation 的 `signature`；
2. 按 `seq/prevHash` 逐条验证；
3. 验证最后一条 `newEdPublic` 与握手签名公钥一致；
4. 只有验证通过后才更新 roster/允许握手继续。

不允许先信任握手里的新公钥再验 rotation。

### 4. 吊销

新增：

```text
device.revoke {
  deviceId,
  revokedSeq,
  revokedAt,
  reason,
  signature   // 当前链最新 edPrivate 签名
}
```

- 收到后把 roster entry 标记 `revokedAt/revokedSeq`；
- 被吊销设备不能继续握手/写入；
- 若当前密钥已泄露，吊销只能由更高层（例如用户手动确认）签新链，不能仅靠泄露密钥自证。

### 5. 重放与回退

- `seq` 必须严格大于本地已存的 `rotationSeq`；
- `prevHash` 必须匹配本地 head 或链中已知前缀；
- 相同 `seq` 但不同 hash 视为分叉，告警并拒绝自动更新，要求人工选择；
- 所有 rotation 记录按 `(deviceId, seq)` 持久化，roster 的 `rotationHead` 与记录必须一致。

### 6. 离线补发

peer 重连时：

- 若对端 `rotationSeq` 高于本地，发起 `fleet.rotation.records` RPC，按 range 拉取并验链；
- 若握手阶段就发现新公钥与 roster 不符，携带最多 N 条 rotation 记录在 hello 中补发；
- 记录超过 N 条时分页，先完成链验证再继续握手。

## 不变量

1. `deviceId` 永不因轮换改变。
2. 每条 rotation 必须由链上前一条旧私钥签名。
3. `seq` 单调递增，`prevHash` 连续。
4. roster 的 `rotationHead` 与 rotation 记录一致。
5. 被吊销设备不能通过旧链恢复。
6. 握手先验证 rotation chain，再信任新公钥。

## 未决

- 密钥泄露后的恢复流程：是否允许用户在新设备上手动重建 Fleet/roster；
- rotation chain 的保留上限与压缩策略；
- 是否需要把 rotation 记录也纳入 Fleet invite（新设备入网时拿到完整链）；
- Room 事件签名是否也需绑定 `rotationSeq`。

## 实施顺序

1. `src/net/rotation.js` 增加 chain 结构、seq/prevHash、verifyChain；
2. `store`/roster 持久化 rotationSeq/rotationHead；
3. `fleet.rotation.records` RPC + 离线补发；
4. SecureChannel 握手携带 rotation 并先验链；
5. 吊销工具与 UI；
6. 单测 + A/B 真机（停 B、A 轮换、B 重连自动补链）。

## 后果

- 正：离线 peer 能安全追上轮换；重放/分叉/中间记录替换可检测；为吊销提供基础。
- 负：握手更大、链需要持久化与分页；实现和测试复杂度显著上升。
- 在实现前，`fleet_rotate_identity` 仍只应在所有 peer connected 时使用；离线时轮换会导致该 peer 无法握手，这是当前已知限制。
