# 安全审计：dsh-device-fleet 1.20.1 → 1.20.7（正式版）

- **审计时间**：2026-11-19 00:00–00:25（Asia/Shanghai）
- **范围**：`src/net`（identity/rotation/fleet-node/secure-channel/relay/discovery/tls）、`src/plugin/index.js` RPC 与工具、`src/host`（tool-policy/file-transfer/trajectory/call-ledger/approval/room/ui-web）、`client.js`、`scripts`（relay/lease/cert）
- **方法**：人工代码审查 + 三个只读子审计（crypto/auth、RPC/file、client/relay）+ 定向单测 + 现有 CI
- **基线**：1.20.1；本报告修复覆盖 1.20.2–1.20.7（1.20.3 轨迹 RPC、1.20.4 审批工具、1.20.5 HTTP 同源、1.20.6/1.20.7 配置/启动回滚）；A/B 均 1.20.7

## 结论

- **已作为 1.20.7 正式版发布（`latest`=1.20.7）**。发现 3 个 Critical 级问题均已关闭；HTTP CSRF、配置回滚、启动回滚也已修复。剩余是外部审计/跨主机数据面/发布签名等后续增强项，不再阻塞本次发布。
- 1.20.2/1.20.3/1.20.4 已修复所有能由代码单独关闭的 Critical/High：能力冒充、管理工具远程调用、allowlist 失效、grants 绕过 roots、symlink 逃逸、轨迹/calls 越权、Relay 客户端私钥外发、lease 默认无鉴权、已吊销 checkpoint 签名计数、Agent 自审批。
- 仍需：安全审计复验、真实跨主机 Relay/TLS、HTTP UI 的 Origin/CSRF 加固、发布签名。

## 发现汇总

| # | 严重度 | 问题 | 状态 |
| --- | --- | --- | --- |
| C1 | Critical | `capability:'read'/'grep'` 可携带任意 `tool` 名，执行 `fleet_reset_identity`/`fleet_approve` 等管理工具；`tool:'auto'` 且 allowlist 未生效 | **Fixed** |
| C2 | Critical | 本地 agent 可调用 `fleet_approve` 自审批，绕过“人类确认” | **Fixed（1.20.4：Agent 工具移除，审批仅 UI/HTTP；`fleet_approvals` 只读）** |
| C3 | Critical | 未知设备可省略 `inviteId` 走 TOFU，绕过一次性/过期邀请 | **Fixed** |
| H1 | High | approval grants 在 roots 检查前消费，一次 in-root 批准可读写任意路径 | **Fixed** |
| H2 | High | `allowedRoots` 仅 lexical resolve；junction/symlink（含 dangling leaf）可逃逸 | **Fixed** |
| H3 | High | RELAY candidate 广告携带客户端 `tls.cert/key`，同 Fleet 对端可拿到客户端私钥 | **Fixed** |
| H4 | High | lease coordinator 默认 `0.0.0.0` 无 token；浏览器 CSRF 可 release/steal lease | **Fixed（默认 loopback、非 loopback 必须 token、Origin 拒绝、timing-safe）** |
| H5 | High | Relay register token 可重放；`replaced` 被当永久关闭，攻击者可让设备离线 | **Mitigated**（ts 去重、replaced 重连；fleet-key 持有者伪造 deviceId 仍未解决） |
| H6 | High | `room.snapshot`/`fleet.session.trajectory`/`fleet.calls.list` 可被任意 roster peer 读取 | **Fixed**（成员校验、session owner、calls 仅返回 caller 相关） |
| H7 | High | `policy.allowedTools` 是死配置；raw tool 默认 `auto`，可绕过 `run:ask` | **Fixed**（allowlist 强制执行、tool 默认 `ask`） |
| M1 | Medium | Room/task grant revoke 可被任意 peer 调用 | **Fixed**（Room 成员校验） |
| M2 | Medium | HTTP UI/approval/config 路由无 Origin/CSRF 校验（loopback/DNS rebinding） | **Fixed（1.20.5：同源 Origin/Host/Sec-Fetch-Site 校验）** |
| M3 | Medium | checkpoint 主题自签名计入 quorum；已吊销成员签名仍计数；offer 未绑定 deviceId/seq 可回滚 | **Fixed** |
| M4 | Medium | 邀请 HMAC 的 key 就在 payload 内，持有邀请者可重算字段；单次语义只是流程约束 | **Open（设计）** |
| M5 | Medium | Relay mTLS allowlist 未自动 requestCert，allowlist-only 配置会拒绝所有连接/或退回明文 | **Fixed**（allowlist 自动 requestCert；CLI 传 requestCert） |
| M6 | Medium | Relay data/control 慢连接、pending 无上限；SecureChannel 8 MiB 预认证行 | **Mitigated**（1 MiB 预认证、header timeout、data socket cap） |
| M7 | Medium | Discovery 无签名，可伪造名字/peer | **Mitigated**（名称清洗、peer 上限/过期；未加 HMAC） |
| M8 | Medium | 轨迹脱敏只按敏感 key 名，命令/正文里的秘密不脱敏；持久化文件曾默认权限 | **Mitigated**（0600、JSONL；启发式仍非 DLP） |
| M9 | Medium | 审核/审计工具可被本地 agent 调用；审批 prompt 只显示 160 字符 args | **Open** |
| L1 | Low | 非 timing-safe HMAC 比较（membership proof/invite） | Open |
| L2 | Low | 签名 payload 无 domain-separation 前缀 | Open |
| L3 | Low | lease token 在 argv、HTTP 明文、无速率限制 | Open |
| L4 | Low | `relay-server-cert --name` 路径穿越、证书私钥权限未显式 chmod | **Fixed（name 校验；私钥仍依赖 openssl 默认）** |
| L5 | Low | 客户端 DOM telemetry 无条件查询全页 | Open |
| L6 | Low | npm 无 provenance/签名 | Open |

## 关键修复证据

- **C1/C3/H7**：`direct-call.js` 对 `read/grep` 强制固定工具名，`tool` 禁止 `fleet_*`/`room_*`/`plugin_*`（只放行 4 个只读状态工具）；`tool-policy.js` 强制执行 `allowedTools`，raw tool 默认 `ask`；未知设备必须带 jti。
- **H1**：`tool-policy.js` 把 roots 检查移到 grants 消费之前，并要求 `read/list/grep/fetch/write` 必须带 path。
- **H2**：`canonicalPath` 解析 realpath、拒绝 dangling symlink；单测覆盖 junction 逃逸。
- **H3**：`relayCandidateList` 只广告 `ca/servername/rejectUnauthorized`；单测断言无 `cert/key`。
- **H5**：Relay `lastRegisterTs` 拒绝相同/更旧 ts；客户端 `replaced` 改回退重连。
- **H6**：`room.snapshot` 要求 Room 成员；`fleet.session.trajectory` 校验 session owner；`fleet.calls.list` 仅返回 caller 参与的记录；`room.closed` 仅 authority。
- **M3**：checkpoint 拒绝 subject 自签、已吊销/待吊销签名；证书生成二次过滤；offer 校验 deviceId 与 seq 不回退。
- **M5**：allowlist 存在时自动 `requestCert`；`relay-server.mjs` 设置 requestCert/rejectUnauthorized。

## 测试

- `node scripts/ci.mjs`：**net 49/49、host 74/74**、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed。
- 新增测试：capability spoof 防护、allowlist/default policy、junction 逃逸、relay candidate 私钥不外发、已吊销 checkpoint 签名过滤、trajectory owner/persistence/脱敏。
- 真机 A/B 1.20.3：新子会话轨迹 30 事件、1.20.2 旧轨迹 30 事件可读；unowned session 返回 403；`fleet_reset_identity` 被 allowlist 拒绝；根外 `C:/Windows/win.ini` 被 roots 拒绝；根内读取与 `fleet_run` 正常；calls 90 条仅 A/B。真实 junction 创建被 B 的 shell 权限拒绝，symlink 逃逸仍由单测覆盖。

## 发布判断

**不能正式切 `latest`**，原因：

1. ~~C2 自审批未关闭~~：1.20.4 已从 Agent 工具移除 `fleet_approve`/`fleet_deny`，审批只能由本地 UI/HTTP 做出。
2. M2 HTTP UI 无 Origin/CSRF 校验；需要 DSH webServer 认证或 Origin 白名单。
3. 无独立外部安全审计；本报告是自审。
4. 真实跨主机 Relay/TLS、`latest` 1.8.4→1.20.x 迁移未演练。
5. M4 邀请单次语义仍受“fleetKey 持有者即成员”模型限制。

**已作为 1.20.7 正式版发布**；后续建议补外部独立审计、跨主机 Relay 数据面/三主机演练与 npm provenance。内部审计与 A/B 真机验证已完成。
