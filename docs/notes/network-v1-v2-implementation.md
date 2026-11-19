# 网络层 v1/v2 实现说明

状态：**已实现并通过本机双端测试**（2026-11-09）。对应 ADR：[0017 网络层分阶段](../adr/0017-network-phases-direct-and-relay.md)。

## 文件

| 文件 | 作用 |
|---|---|
| `src/net/identity.js` | 设备身份（Ed25519 签名 + X25519 协商）、`fleetKey` 邀请编解码、成员证明 HMAC、账号指纹、Relay 注册 token |
| `src/net/secure-channel.js` | 端到端安全通道：HELLO/HELLO_ACK 握手、签名与成员证明校验、X25519+HKDF 派生、AES-256-GCM 帧、计数防重放 |
| `src/net/protocol.js` | 版本号、帧类型（rpc.req/res/err、event、ping/pong、ready）、稳定 JSON、错误序列化 |
| `src/net/direct.js` | v1 直连：TCP 监听器 + 出站拨号（带超时） |
| `src/net/discovery.js` | v1 局域网发现：UDP 组播公告（fleetHash + deviceId + 直连端口） |
| `src/net/relay-server.js` | v2 Relay：控制面（注册/连接/接受/拒绝）+ 数据面（两条 TCP 拼接，只搬密文） |
| `src/net/relay-client.js` | v2 客户端：控制连接、自动重连、请求/接受连接、数据 socket |
| `src/net/fleet-node.js` | 设备门面：roster/TOFU、直连/发现/Relay 选择、RPC、事件、关闭 |
| `test/net.test.mjs` | 7 个测试（见下） |

## 线格式

### 安全通道握手（换行分隔 JSON）

1. 发起方 → 响应方 `hello`：`{t:'hello', v:1, fleetId, deviceId, name, edPublic, xPublic, ephX, nonce, ts, accountFingerprint, proof, sig}`
   - `proof = HMAC(fleetKey, "member|fleetId|deviceId|edPublic|xPublic|accountFingerprint")`
   - `sig = Ed25519(稳定 JSON(除 sig 外的全部字段))`
2. 响应方校验 fleet/时间戳/签名/成员证明/账号指纹/已固定公钥，回复 `hello.ack`（同构）。
3. 双方以 `X25519(ephX_i, ephX_r)` 为 IKM、`sha256(稳定 JSON(hello,ack))` 为 salt，HKDF 派生：
   - 发起→响应 32B key + 4B nonce 前缀；响应→发起 32B key + 4B nonce 前缀。
4. 双方各发一条加密 `ready` 帧；收到对方 `ready` 后通道可用（`ready` 事件）。

### 加密帧

```
| u32be length | AES-256-GCM ciphertext | 16B tag |
nonce = 4B 方向前缀 || u64be 计数器；AAD = "dsh-device-fleet/frame/v1"
```

计数器严格递增、按 TCP 顺序校验，重放/乱序/篡改都会使 `openFrame` 失败并断链。

## Relay 协议（v2）

控制面（TCP，换行分隔 JSON）：
- `register {fleetId, deviceId, ts, token}` → `register.ok`；`token = HMAC(fleetKey, "relay-register|fleetId|deviceId|ts")`；Relay 用配置的 fleetKey 校验，时间戳 ±120s。
- `connect {reqId, targetDeviceId}` → 请求方收 `connect.pending`，目标方收 `incoming {reqId, fromDeviceId}`。
- 目标方 `accept {reqId}` → 双方收 `connect.ready {reqId, dataPort, token}`；`reject` → 请求方收 `connect.fail`。
- 心跳 `ping`/`pong`。

数据面（第二个 TCP 端口）：双方分别连接并发送一行头
`{fleetId, deviceId, reqId, token}\n`，Relay 校验后把两条 socket 的原始字节互相 pipe。**Relay 不解析、不终止加密**，与 secure-channel 的密文完全兼容。

## 已验证（`node test/net.test.mjs`，7/7 通过）

1. 邀请编解码携带 fleet/账号指纹/Relay 地址；
2. v1 直连：认证握手 + RPC echo + 双向 roster TOFU 固定；
3. 不同 fleet 或不同账号指纹的握手被拒；
4. roster 中固定公钥与对端不一致时被拒；
5. v2 Relay：两设备经中继完成加密 RPC，Relay 记录到 splice；
6. Relay 拒绝不知道 fleetKey 的客户端；
7. LAN 组播发现发现对端并通过发现地址直连（组播不可用时测试自动跳过）。

运行：`node test/net.test.mjs`（受限沙箱里 `node --test test/` 需要 spawn 子进程，可能被拒；直接跑测试文件即可）。

## 当前限制 / 后续

- **无 NAT 打洞**：跨网一律走 Relay（v3 再做打洞）。
- **Relay 控制面为明文 TCP**：部署时应在 TLS/反代之后，或后续加 TLS。
- **TOFU 无密钥轮换/吊销**：Roster 只固定公钥，设备重装会变新身份；后续加签名 roster 与吊销。
- **无二进制流式分块**：RPC 参数/结果为 JSON（大文件需后续加 chunk 帧）。
- **无重放窗口**：严格顺序计数已防重放；断线重连即新会话，不做跨会话恢复。
- **无速率限制/审计**：Relay 与节点都未做限流；上线前补。
- **账号指纹需上层注入**：网络层只接收 `accountFingerprint` 字符串，由 Host 插件从 `deepseekAccount.getDeviceIdentity()` 派生。
