# ADR-0029：Relay TLS 与候选生命周期

- **状态**：已实现（2026-11-15，1.11.0）
- **相关**：ADR-0017（直连与 Relay 两阶段）、ADR-0024（版本严格匹配）、`src/net/relay-server.js`、`src/net/relay-client.js`、`src/net/tls-options.js`、`src/net/fleet-node.js`
- **结论**：Relay 的控制面与数据面都支持 TLS；设备侧只接受本地配置或邀请里的 `tls` 设置，同行学到的候选不能关闭证书校验。peer 学到的 Relay 候选带 TTL 与排序，过期自动清理。

## 背景

1.11.0 之前：

- Relay 控制面（注册、token、connect 元数据）是明文 TCP；token 虽有时效，但元数据与不可达目标列表会暴露在链路上；
- 数据面本身有端到端加密，但拼接两端仍暴露连接关系与流量特征；
- peer 会在握手里互相广告 Relay 候选，候选没有来源/年龄，长期累积；状态页只有数量，无法判断哪个可用、哪个该删；
- 多 Relay 已有 failover，但顺序只按 online 排，失败过的候选仍会反复先试。

## 决策

### 1. Relay TLS

- 服务端 `createRelayServer({ tls: { cert, key, ca?, requestCert?, rejectUnauthorized? } })`：
  - 控制面与数据面都用 `tls.createServer`；
  - `cert/key/ca` 可以是 PEM 字符串或文件路径（路径在启动时读取，便于部署）；
  - `state.secure` 暴露是否启用，`scripts/relay-server.mjs` 支持 `--tls-cert/--tls-key/--tls-ca`。
- 客户端 `relay.tls = { ca?, servername?, rejectUnauthorized? }`：
  - 控制面用 `tls.connect`，在 `secureConnect` 后注册；
  - 数据面同样用 TLS 连接并发送一行 header；
  - `ca` 可放 CA/自签证书 PEM 或文件路径；`servername` 用于 SNI/主机名校验；
  - `rejectUnauthorized: false` 只允许来自**本地配置或邀请**（邀请本身有 fleetKey HMAC 保护）；从 peer 握手学到的候选会剥掉该字段。
- 设备配置经 `runtime-config` 白名单清洗，只保留 `ca/servername/rejectUnauthorized`；私钥永远不会进入设备配置或邀请。
- 没有 TLS 的旧 Relay 仍可用（不配置 `tls` 即明文，与 1.10 行为一致）。

### 2. 候选生命周期

- 候选字段：`host/port/dataPort/{tls}, source('config'|deviceId), persistent, learnedAt`。
- 配置候选 `persistent: true`，永不过期；peer 学到的候选默认 TTL 7 天（`FleetNode({ relayCandidateTtlMs })`）。
- 每 `min(TTL, 1h)` 清理一次过期候选并关闭对应 client；`pruneRelayCandidates(now)` 可同步调用（测试用）。
- 同一候选被 peer 重复广告会刷新 `learnedAt`（相当于续期）。
- `relayCandidateList()`（握手/邀请）只广告前 8 个排序后的候选；`status().relay.list` 暴露 `online/source/persistent/failures/ageMs/tls.hasCa`。
- 连接排序：在线优先 → 配置优先 → 失败次数少优先 → 最近成功优先。失败计数在 `RelayClient` 上累计，`register.ok` 或成功建链后清零。
- 配置变更（`reconfigure`）清掉学到的候选，只保留新配置；避免旧 Relay 的 client 泄漏。

## 不变量

1. 只有本地配置/邀请可以把 `rejectUnauthorized` 设为 `false`；peer 广告的候选不能降低校验强度。
2. 私钥只存在于 Relay 主机的 server 配置，不出现在设备配置、邀请或握手消息里。
3. TLS 只保护 Relay 链路；设备业务帧仍然是端到端加密，Relay 无法读取。
4. 配置候选不因 TTL 消失；学到的候选过期后必须重新广告才会回来。
5. Relay 失败不阻塞直连；直连可达时不会使用 Relay。
6. `relayCandidateList` 上限 8，避免握手/邀请无界增长。

## 后果

- 正：控制面 token/元数据可走 TLS；候选有来源和年龄，状态页可解释；多 Relay failover 会优先尝试健康节点。
- 负：自签证书需要每台设备分发 CA（或邀请内置 `tls.ca`）；TLS 增加一次握手开销；Relay 仍是自托管单点，没有内建高可用。
- 兼容：不配置 `tls` 的老 Relay/老客户端仍是明文；1.10.x 与 1.11.0 不能互连（严格版本）。

## 未决

- Relay 控制面 mTLS / 设备证书（当前只有 fleetKey HMAC token）；
- 候选延迟探测（当前只按 online/failures/最近成功排序）；
- 多 Relay 自动选优与健康检查的 3+ 真机矩阵；
- 内置 P2P/NAT 打洞。
