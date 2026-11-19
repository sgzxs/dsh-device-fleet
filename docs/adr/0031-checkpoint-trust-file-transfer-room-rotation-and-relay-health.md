# ADR-0031：checkpoint 用户确认、文件传输、Room 事件 rotationSeq 与 Relay 延迟/mTLS

- **状态**：已实现（2026-11-15，1.12.0）
- **相关**：ADR-0027（轮换链）、ADR-0028（checkpoint 压缩）、ADR-0029（Relay TLS）、`src/net/rotation.js`、`src/net/secure-channel.js`、`src/host/file-transfer.js`、`src/host/room-signing.js`
- **结论**：补齐 P1：被剪枝的 peer 可用“用户确认的 checkpoint”恢复信任；支持分块校验文件上传/下载；Room 事件绑定签名密钥 epoch；Relay 增加延迟探测与 mTLS。

## 1. checkpoint 用户确认信任

- 发送方在 hello/ack 携带本机 `rotationCheckpoint`（自签，含归档前缀的 `seq/head` 与 **该高度上的公钥** `headEdPublic/headXPublic`）。
- 接收方发现自己 pin 早于对端 `rotationFrom` 且对端提供了 checkpoint 时：
  - 校验 checkpoint 由对端当前公钥签名、且 `checkpoint.edPublic === peer.edPublic`；
  - 把 offer 存到 roster `rotationCheckpointOffer`，**不更新公钥**；
  - 握手以 `rotation-checkpoint-required` 失败，提示用户确认。
- `fleet_rotation_trust_checkpoint({ deviceId, confirm: true })`：
  - 采纳 checkpoint 的 `seq/head` 与 `headEdPublic/headXPublic`（不是当前公钥），这样后续 records 仍能从该高度逐条验证；
  - 清掉旧的 peer-rotations 链与非必要标记；下一次握手从 checkpoint 之后继续补链。
- 这是显式人工信任动作，绝不自动执行；没有 checkpoint 时仍报 `rotation-history-pruned`。
- **1.12.3 修正**：checkpoint 是压缩时签名的，之后轮换会让当前 key 验证旧签名失败。现在广告前用当前 identity 重签（`refreshRotationCheckpoint`，保留 seq/head/head 公钥），并在构造/rotate/compact 后刷新。旧格式 checkpoint（无 `headEdPublic/headXPublic`）在用户确认后回退为 pin 对端当前广告的 seq/head/keys。

## 2. 文件传输

- `src/host/file-transfer.js`：512 KiB 分块、base64 传输、SHA-256 校验、越界/offset 校验（1.18.0 起上限 2 GiB、流式传输）。
- RPC：`fleet.file.put`（capability `write`）与 `fleet.file.get`（capability `fetch`）；两者都走 Tool Policy（allowedRoots + auto/ask/deny），`ask` 时进入本机审批收件箱。
- 工具：`fleet_upload(device, localPath, remotePath)` 与 `fleet_download(device, remotePath, localPath)`；下载逐块写入并在 EOF 校验整文件哈希。
- 默认 `write=ask`，`fetch` 沿用原有 auto + roots 限制。

## 3. Room 事件绑定 rotationSeq

- 新签名的 Room 事件在 canonical 中加入 `rotationSeq`（签名设备当前的链 seq）；没有该字段的旧事件仍按原 canonical 验证。
- 插件在 `signEvent` 回调里写入 `event.rotationSeq = currentRotationSeq()`，覆盖本地写入、mirror 重签与同步 remap。
- 验证仍使用 roster 当前公钥；旧密钥签名会被拒绝。`rotationSeq` 提供审计与后续按 epoch 校验的基础（是否强制等于当前 seq 留待后续版本）。
- **1.12.1 修正**：`signEvent` 回调在 `RoomReplicaStore` 构造时按值传入，helper 必须在构造前初始化；1.12.0 因把 `const signEventWithRotation` 放在构造之后导致插件激活 TDZ。已上移并加 `plugin-order` 静态回归。

## 4. Relay 延迟/健康检查与 mTLS

- `RelayClient.probe()` 发 `ping`，Relay 回带时间戳的 `pong`；客户端记录 `latencyMs`。FleetNode 每 60s 探测在线 Relay。
- 候选排序：在线 → 配置 → 延迟低 → 失败少 → 最近成功；`fleet_status.relay.list` 暴露 `latencyMs`，控制台显示。
- mTLS：`clientTlsOptions` 支持 `cert/key`；Relay 服务端 `requestCert/rejectUnauthorized` 生效。设备侧凭据可放 PEM 或文件路径；**私钥不会进入 invite 或 peer 广告**。
- 测试夹具包含自签 CA + 客户端证书；无客户端证书的连接被拒绝。

## 不变量

1. checkpoint 值在用户 `confirm` 前不会改变 roster 公钥；采纳的是 checkpoint 高度的公钥，不是当前公钥。
2. 文件传输的写入必须经过目标 Tool Policy 的 `write` 决策与 roots 检查；校验失败删除半成品。
3. Room 事件的 `rotationSeq` 在签名 canonical 内；旧事件无该字段仍可验证。
4. peer 广告的 Relay 候选仍不能关闭证书校验；mTLS 私钥只存在于本地配置。
5. Relay 延迟只是排序提示，不改变连接语义。

## 后果

- 正：剪枝后的设备有受控恢复路径；二进制文件可跨设备传输；Room 事件可追溯到密钥 epoch；Relay 排序更可用且支持 mTLS。
- 负：checkpoint 信任是单设备自签 + 人工确认，仍不是多方共识；文件传输 2 GiB 上限（1.18.0）；mTLS 需要分发客户端证书；Room rotationSeq 默认 audit，strict 需显式配置。
