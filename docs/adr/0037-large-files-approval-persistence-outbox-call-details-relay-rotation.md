# ADR-0037：大文件、审批持久化、离线 outbox、调用详情与 Relay 证书轮换

- **状态**：已实现（2026-11-18，1.18.0）
- **相关**：ADR-0018（离线语义）、ADR-0020（审批）、ADR-0023（调用详情）、ADR-0029（Relay）、ADR-0036（作用域/撤销）

## 1. 文件传输

- 单文件上限提升到 **2 GiB**；上传/下载改为流式读写，避免整文件进内存。
- 保留 512 KiB 分块、SHA-256、续传、目录递归、删除；目录仍不做差异同步，符号链接只报告不跟随。
- 目标 `write` 策略与 allowedRoots 不变。

## 2. 审批持久化

- `ApprovalInbox` 可选 `stateFile`：pending 请求落盘，重启后恢复为 `resumed` 状态（原调用方已断开，批准只记录审计，不会复活调用）。
- `ToolPolicy` 可选 `stateFile`：once/ttl/room/task grants 落盘，重启后继续生效；过期的加载时丢弃。
- 文件：`approval-inbox.json`、`tool-grants.json`。写入使用临时文件 + rename。

## 3. 离线 outbox

- 普通 `fleet_*` 直调仍 fail-fast（ADR-0018 语义）。
- 新增显式 `fleet_queue_call` / `fleet_queue_delegate`：条目持久化到 `outbox.json`，目标重连或每 30s 重试；成功/失败结果保存在条目中。
- `fleet_outbox` / `fleet_outbox_result` / `fleet_outbox_cancel` 管理；进程重启时 running 条目回到 queued。
- 离线错误保持 queued；策略/审批/参数错误标记 failed。

## 4. 跨设备调用详情

- 新增 `CallLedger`（`call-ledger.jsonl`），记录 outbound/inbound 调用的设备、能力/工具、Room/task、状态、耗时、参数/结果摘要；不保存完整会话轨迹。
- `fleet.calls.list` RPC 让已连接设备交换账本；控制台“调用”页合并本机 + 对端条目。
- 这是 ADR-0023 的“只读调用详情”落地；完整 DSH turn/tool trajectory 镜像仍未做。

## 5. Relay 服务端证书轮换 / HA

- `createRelayServer` 新增 `reloadTls(tls)`：通过 TLS server `setSecureContext` 热替换证书，不重启监听。
- `scripts/relay-server.mjs` 支持 `--tls-client-allowlist` 与 SIGHUP 重载；Windows 无 SIGHUP 时重启 Relay。
- `scripts/relay-server-cert.mjs rotate --install` 用现有 CA 签发新 server cert/key。
- HA 仍以客户端多候选 + 多 Relay 部署为主；不提供服务端集群编排。

## 不变量

1. 大文件仍逐块校验，失败删除半成品。
2. 持久化 grants 只影响重启后的授权，不改变 Tool Policy 决策逻辑。
3. outbox 是 opt-in；普通调用不会静默排队。
4. 调用账本只存摘要，不存完整参数/结果。
5. Relay 证书热轮换只对 TLS listener 有效；已有连接不受影响。

## 未完成

- i18n 的日志/工具原始错误（原生 confirm 已在 1.18.1 接入）；
- checkpoint 密码学多签；
- 完整 DSH 轨迹镜像；
- Relay 服务端集群编排。
