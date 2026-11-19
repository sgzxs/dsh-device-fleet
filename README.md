# dsh-device-fleet

DeepSeek Harness 的设备联邦插件：把登录同一账号、且都安装本插件的多台设备连成一个 **Fleet**，让 agent 可以直调其他设备的工具、在共享 **Room** 里协作，或把任务委派给另一台设备的 agent。

- 源码/Issue：https://github.com/sgzxs/dsh-device-fleet
- npm：https://www.npmjs.com/package/dsh-device-fleet

## 当前状态

**1.20.8 正式版（npm `latest` / `dev`）**：1.20.7 的运行时代码不变；本补丁同步 README/AGENT-GUIDE、仓库元数据，并修复 GitHub CI 的 client-smoke 绝对路径与审批超时测试 keepalive。安全修复与功能面同 1.20.7。

功能面：Fleet 配对/直连/发现/Relay（TLS/mTLS/多候选/证书热轮换/lease 选主）、直调/委派/审批（once/ttl/room/task，持久化）、Room 与镜像、密钥轮换/吊销/分叉/链分页/checkpoint M-of-N、一次性邀请、通知 webhook、2 GiB 流式文件传输（上传/下载续传）、跨设备调用详情与持久化 DSH 轨迹、离线 outbox、主题/中英切换。

进度、验证结果与待办统一维护在 [docs/STATUS.md](./docs/STATUS.md)；本页只保留安装、配对与使用入口。

## 安装

已正式发布到 npm：**`dsh-device-fleet@1.20.8`（`latest` 与 `dev` 均指向 1.20.8）**。离线包 **`dsh-device-fleet-1.20.8.tgz`** 也在本目录；GitHub Release：[v1.20.8](https://github.com/sgzxs/dsh-device-fleet/releases/tag/v1.20.8)。

```sh
# npm 安装（A/B 两端必须同一版本）
dsh plugin --profile web add dsh-device-fleet@1.20.8

# 或从本目录/离线包安装（版本可控）
dsh plugin --profile desktop add C:/path/to/dsh-device-fleet-1.20.8.tgz
```

两台设备的**插件版本必须一致**；DSH 需同一发布线（允许 prerelease 后缀不同，ADR-0024）。不一致会在握手时直接拒绝。

### 配对（Fleet 入网）

1. 设备 A：对 agent 说“生成 Fleet 邀请码” → 模型调用 `fleet_invite`，拿到一次性邀请码（含 fleetKey，注意保密）。1.11.0 的邀请还带 HMAC 签名的引导信息：创建者公钥、当前成员名单与吊销墓碑，加入方在第一次握手前就 pin 住这些设备。
2. 设备 B：安装后**重载插件**（`plugin_manager set_bundle enabled:false` → `true`，无需重启 DSH）；对 agent 说“加入 Fleet：`<code>`” → `fleet_join` 把邀请排队；再重载一次插件后生效，并导入上面的引导 roster。
3. 设备 B：若未自动连接，用「连接设备」或 `fleet_connect` 填 A 的 `fleet_status` 直连地址（热操作，无需重启）。
4. 两台设备各自在 profile patch 里配置 `policy.allowedRoots` 与 `execution.cwd`（不配时直调读取一律被拒）。
5. 设备 B：`fleet_list` 看到设备 A → `fleet_read(device=A, path="A 允许根内的文件")` 验证。

```yaml
# 两个 profile 的 cordis.patch.yml 里给 device-fleet 行追加 config：
- id: device-fleet
  config:
    deviceName: desktop
    execution:
      cwd: D:/work
      agentPreset: standard
    policy:
      allowedRoots: [D:/work]
```

`fleet_run` 默认需要目标设备本机审批；请求会进入目标设备的审批面板/收件箱，60 秒无响应 fail-closed。首次联调可先用 `fleet_read` / `fleet_fetch` 验证链路。

## 文档

- 文档索引：[docs/README.md](./docs/README.md)
- **Agent 使用说明书（完整版）**：[docs/AGENT-GUIDE.md](./docs/AGENT-GUIDE.md)；插件还会在 agent 首次调用 `fleet_*` / `room_*` 后注入精简版 `FLEET_MANUAL`（工具选择、审批只读、保密、密钥操作红线）
- 仓库级 agent 约定：[AGENTS.md](./AGENTS.md)（要求先读完整手册）
- 当前进度/待办/验证：[docs/STATUS.md](./docs/STATUS.md)
- 架构与不变量：[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- 术语表：[docs/GLOSSARY.md](./docs/GLOSSARY.md)、[CONTEXT.md](./CONTEXT.md)（设计阶段词汇）
- 决策记录：[docs/adr/](./docs/adr/)（从入网方式到吊销、邀请引导与 Relay TLS）
- 网络实现说明（线格式/Relay 协议/限制）：[docs/notes/network-v1-v2-implementation.md](./docs/notes/network-v1-v2-implementation.md)
- 全局任务列表复用评估：[docs/notes/dsh-global-task-list-evaluation.md](./docs/notes/dsh-global-task-list-evaluation.md)
- 事故复盘（启动失败 / Room 会话日志损坏 / 帧结构，2026-11-09）：[docs/notes/incident-2026-11-09-boot-and-room-log.md](./docs/notes/incident-2026-11-09-boot-and-room-log.md)

## 快速开始

```js
import {
  FleetNode, createFleet, decodeInvite, encodeInvite, generateIdentity, accountFingerprint,
} from './src/net/index.js'

// 第一台设备：创建 Fleet，导出邀请
const fleet = createFleet({ name: 'home' })
const accountFp = accountFingerprint(fleet.fleetKey, 'account-user-id')
const invite = encodeInvite({ fleet, accountFingerprint: accountFp })

// 第二台设备：解码邀请，加入
const joined = decodeInvite(invite)

const a = new FleetNode({
  identity: generateIdentity({ name: 'desktop' }),
  fleet,
  accountFingerprint: accountFp,
  direct: { host: '0.0.0.0', port: 0 },
  discovery: true,
})
const b = new FleetNode({
  identity: generateIdentity({ name: 'laptop' }),
  fleet: joined.fleet,
  accountFingerprint: joined.accountFingerprint,
  direct: { host: '0.0.0.0', port: 0 },
  discovery: true,
})

a.onRequest(async ({ method, params }) => params) // 示例：eecho
await a.start()
await b.start()

// 发现/手动地址均可；双向 RPC 已端到端加密
const result = await b.request(a.identity.deviceId, 'echo', { path: '/tmp/report.md' })
console.log(result)
```

## Relay（v2，跨网兜底）

```js
import { createRelayServer } from './src/net/relay-server.js'

// 在用户自己的一台机器/VPS/NAS 上启动（可选 TLS）：
const relay = createRelayServer({
  host: '0.0.0.0',
  fleets: { [fleet.fleetId]: fleet.fleetKey },
  tls: { cert: '/etc/fleet/relay-cert.pem', key: '/etc/fleet/relay-key.pem' },
})
const { port, dataPort } = await relay.ready
console.log({ port, dataPort, secure: relay.state.secure })
```

设备侧配置（`tls.ca` 为签发该证书的 CA；自签证书可直接放证书 PEM）：

```yaml
relay:
  host: relay.example.com
  port: 60600
  dataPort: 60601
  tls:
    ca: /etc/fleet/relay-ca.pem
    servername: relay.example.com
```

直连不可达时自动走 Relay；Relay 只看到密文与连接元数据，TLS 保护控制面 token 与连接元数据。CLI 启动器支持 `--tls-cert` / `--tls-key` / `--tls-ca`。

### mTLS 客户端证书轮换/吊销

Relay 可要求客户端证书并维护指纹 allowlist；allowlist 文件在**每个新连接**时重新读取，吊销无需重启 Relay：

```js
const relay = createRelayServer({
  host: '0.0.0.0',
  fleets: { [fleet.fleetId]: fleet.fleetKey },
  tls: {
    cert: '/etc/fleet/relay-cert.pem',
    key: '/etc/fleet/relay-key.pem',
    ca: '/etc/fleet/ca-cert.pem',
    requestCert: true,
    rejectUnauthorized: true,
    allowedClientFingerprintsFile: '/etc/fleet/allowed-clients.json',
  },
})
```

生命周期工具（需要 `openssl`）：

```bash
# 初始化 CA + server/client 证书，并生成 allowed-clients.json
node scripts/relay-mtls.mjs --out relay-mtls --cn relay.example.com

# 轮换一个客户端证书；--install 覆盖 client-cert.pem/client-key.pem
node scripts/relay-client-cert.mjs rotate --out relay-mtls --name phone --install

# 吊销指纹/名称（下一次连接立即拒绝；已有连接保持到断开）
node scripts/relay-client-cert.mjs revoke --out relay-mtls --name phone

# 列出 allowlist
node scripts/relay-client-cert.mjs list --out relay-mtls
```

客户端替换证书文件后可调用 `fleet_relay_reconnect` 立即重新连接并读取新文件；不调用则在下一次正常重连时生效。

服务端证书轮换：

```bash
node scripts/relay-server-cert.mjs rotate --out relay-mtls --install
# Unix: kill -HUP <relay-pid>；Windows: 重启 relay-server 进程
```

`scripts/relay-server.mjs` 收到 SIGHUP 后调用 `relay.reloadTls()` 热替换证书，不重启监听；多个 Relay 可通过设备配置的 `relays` 列表 + 客户端候选 failover 使用。

## 离线 outbox 与调用详情

普通 `fleet_run/fleet_call/fleet_delegate` 在目标离线时仍 fail-fast；需要稍后执行时：

- `fleet_queue_call` / `fleet_queue_delegate`：持久化到 `outbox.json`，目标重连/30s 重试。
- `fleet_outbox` 列表、`fleet_outbox_result` 结果、`fleet_outbox_cancel` 取消 queued 条目。

控制台新增「调用」页：聚合本机与已连接设备的调用元数据/结果（`/device-fleet/calls`），不包含完整 DSH turn trajectory。文件传输上限为 **2 GiB/文件**，流式上传/下载。

## 测试

```sh
node scripts/ci.mjs           # net / host / overlay / perf + client smoke 全量入口
node test/net.test.mjs        # 仅网络层（含 TLS Relay 与证书夹具）
```

当前基线（2026-11-19，1.20.8）：net 50/50、host 75/75、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed。真机 A/B 1.20.7：轨迹 30 事件（新/旧）、unowned 403、CSRF evil 403、管理工具/根外路径拒绝、`fleet_run` 正常、calls 133 条。

## 安全说明

- 业务帧端到端加密（X25519 + HKDF + AES-256-GCM）；Relay 只能看到密文与元数据，控制面/数据面均可用 TLS；
- 设备身份首次接触用 `fleetKey` 成员证明校验并固定（TOFU）；1.11.0 起可用 HMAC 签名的邀请提前 pin 入网成员，避免 TOFU 竞争；
- 密钥轮换保留 `deviceId`，由旧私钥签链并可离线补发；吊销由用户确认后留墓碑，被吊销设备握手直接拒绝；
- 账号指纹 `HMAC(fleetKey, accountUserId)` 只做成员校验与隔离，不是传输凭据；
- 仍缺：真 P2P/NAT 打洞、rotation checkpoint 的多方信任、3+ 设备真机矩阵；Relay 仍是自托管单点。

## 下一步

见 [docs/STATUS.md](./docs/STATUS.md) 的「未完成 / 已知缺口」与「交接下一步」；本页不再维护待办清单。
