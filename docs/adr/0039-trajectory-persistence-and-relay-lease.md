# ADR-0039：轨迹持久化/脱敏与 Relay lease 选主

- **状态**：已实现（2026-11-18，1.20.0）
- **相关**：ADR-0038（M-of-N / 轨迹 / supervisor）、ADR-0029（Relay）

## 1. 轨迹持久化与脱敏

- `TrajectoryStore` 以 JSONL 追加写入 `<dataDir>/trajectory.jsonl`，启动时加载。
- 保留窗口 7 天；单会话 800 事件、最多 200 会话；文件超过 16 MiB 时重写压缩。
- 递归脱敏：键名匹配 `secret|token|password|api_key|authorization|cookie|private_key|credential` 的值替换为 `[redacted]`；字符串截断 2 KB，事件数据截断 16 KB。
- 边界：脱敏是启发式，不是 DLP；持久化文件仍应依赖磁盘权限保护。

## 2. Relay 跨主机选主

- `scripts/relay-lease.mjs` 是无状态 HTTP lease coordinator：
  - `POST /acquire`：租约空闲/过期/同 owner 时授予，否则 409，返回当前 leader；
  - `POST /renew`：owner+leaseId 匹配才续租；
  - `POST /release`；`GET /state`。
- `relay-cluster.mjs --coordinator http://...`：
  - 只有 leader 启动 relay 子进程并每 TTL/3 续租；
  - 409/续租失败/coordinator 不可达时停止本地节点并进入 standby；
  - leader 崩溃后租约到期，standby 接管。
- 边界：coordinator 是显式单点；生产可替换为 etcd/Consul。它不是 Raft/BFT，也不复制 relay 状态。

## 3. 为什么不是 FROST

- 当前 checkpoint 是 head 绑定 M-of-N **多签名证书**：每个设备独立 Ed25519 签名，达到阈值才信任。
- FROST/阈值签名需要可审计的密码学库、可信 dealer/DKG、nonce 管理与密钥仪式；手写实现风险高于收益，因此本 ADR 不把 M-of-N 冒充 FROST。
- 若需要单签名固定的阈值证书，应单独引入审计库并定义 DKG/reshare 流程。
