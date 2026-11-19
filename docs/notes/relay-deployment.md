# 跨网络连接：Public IP 直连或自建 Relay

状态：代码支持，但当前两台设备都是 `relay: null`，实际连接走局域网直连（或公网 IPv4 直连，取决于防火墙）。

## 三种方式

1. **同一局域网 / 热点直连（当前情况）**
   - `fleet_connect(host="192.168.137.1", port=60583)`；
   - 无需额外组件。

2. **公网 IP 直连**
   - 插件监听 `0.0.0.0:<port>`，如果设备有公网 IPv4（例如 A 的 `210.73.18.88`）且防火墙/路由器允许入站，另一网络设备可直接：
     ```
     fleet_connect(host="210.73.18.88", port=60583)
     ```
   - 不需要 Relay；但公网 IP 可能变化，且不少宽带/校园网禁止入站。
   - 当前设备 A 有公网 IPv6（`2400:...`），但 Direct listener 目前绑定 IPv4 `0.0.0.0`，IPv6 直连尚未配置。

3. **自建 Relay（推荐跨网络）**
   - 在网络可达的公网 VPS 上运行：
     ```sh
     node scripts/relay-server.mjs \
       --host 0.0.0.0 --port 60600 --data-port 60601 \
       --fleet-state /path/to/fleet.json
     ```
   - VPS 防火墙/安全组放行 **TCP 60600 和 60601**；
   - 单 Relay 配置：
     ```json
     "relay": { "host": "<VPS 公网 IP 或域名>", "port": 60600, "dataPort": 60601 }
     ```
   - **多 Relay 列表（1.5.0+）**：
     ```json
     "relays": [
       { "host": "relay-a.example.com", "port": 60600, "dataPort": 60601 },
       { "host": "relay-b.example.com", "port": 60600, "dataPort": 60601 }
     ]
     ```
     客户端会按顺序尝试，单个 Relay 不可用自动切换；`fleet_status` 显示 `relay.onlineCount / relay.endpoints`；
   - Relay 只拼接端到端加密后的字节流，不能读取 Room/消息内容；
   - 设备直连失败或不可用时自动走 Relay；严格版本匹配仍在设备握手时校验。
   - Fleet 邀请码会携带 `relay`/`relays` 列表，新设备入网自动获得。

## 验证

- Relay 本地集成测试：`node test/net.test.mjs`（含 "relay v2: two devices behind relay exchange encrypted RPC"）；
- 跨网络真机需要一台公网 VPS 或可控的端口映射；当前环境只有局域网/热点，未做真实 WAN 验证。

## 实测限制（2026-11-12）

- A 设备有公网 IPv4 `210.73.18.88` 和公网 IPv6 `2400:dd0d:1001:10a0:...`，本机自连均正常；
- B 换到其他网络（手机热点）后，B → A 的 ping/TCP 60583/60600/60601（IPv4 与 IPv6）全部超时；
- 反向 **A → B IPv6 可达**：B 的 `/64` 地址 `240e:...:5cc2:...` 在 60581/60610 上 TCP 成功；
- 结论：A 不能当公网入口/Relay，但可以用“反连”：A 主动 `fleet_connect` B 的 IPv6 插件端口，建立后通道双向，Room 同步/回复正常（实测 A/B 83 条消息，B room_reply 成功）；
- 长期稳定仍建议 VPS Relay 或 Tailscale/ZeroTier；B 热点 IPv6 地址可能变化，且 A 必须先发起连接。



- Relay 需要 `fleetKey` 校验注册；不要在不可信机器上运行；
- 没有 NAT 打洞；Relay 是兜底路径，延迟/带宽取决于 VPS；
- 设备插件版本必须一致（严格版本匹配，ADR-0024）。
