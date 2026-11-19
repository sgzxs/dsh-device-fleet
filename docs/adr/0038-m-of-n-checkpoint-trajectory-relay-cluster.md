# ADR-0038：M-of-N checkpoint、DSH 会话轨迹与 Relay 多节点 supervisor

- **状态**：已实现（2026-11-18，1.19.0）
- **相关**：ADR-0023（调用详情）、ADR-0028（checkpoint）、ADR-0029（Relay）、ADR-0032（剩余能力）

## 1. M-of-N checkpoint 签名证书

- endorsement 的签名 payload 为 `{type:'checkpoint-trust', trustedBy, deviceId, seq, head, at}`。
- 接收方按 roster 中 `trustedBy` 的 Ed25519 公钥验签；无签名/坏签名/非成员拒绝。
- 计数键为 `deviceId:seq:head`，不同 head 的签名不会混算。
- `trustRotationCheckpoint` 生成并保存 `checkpointCertificate`：
  - `threshold` 来自 `rotation.checkpointQuorum`；
  - `count = 本地确认 1 + 有效外部签名数`；
  - 未达阈值返回 `quorum`，不写入信任。
- 这是 **M-of-N 多签名证书**，不是阈值签名（如 FROST）或 BFT 共识；仍需每个设备独立确认。

## 2. DSH 远端会话轨迹

- 每个设备监听 `session/event`，写入 `TrajectoryStore`（内存，默认 200 会话 × 800 事件，单事件 16 KiB 截断）。
- RPC `fleet.session.trajectory`（capability `read`，可走审批）返回一个会话的事件列表。
- 委派结果把 `childId` 写入调用账本 `sessionId`；控制台“调用”页对这类条目显示“轨迹”，按会话拉取目标设备的只读事件。
- 边界：不是持久化全量归档；重启前的事件不保留；只覆盖本设备记录到的会话；事件内容按原样返回，未做字段级脱敏。

## 3. Relay 多节点 supervisor

- `scripts/relay-cluster.mjs` 启动 N 个 `relay-server.mjs` 子进程，分配连续 control/data 端口。
- 崩溃后按退避重启；每 10s 探测控制端口；SIGINT/SIGTERM 关闭全部子进程。
- 不提供跨主机选主/分布式共识；建议每台主机运行一个 supervisor，设备把各节点加入 `relay.urls`，客户端已有候选 failover。

## 4. 3 节点代码级验证

- `net.test.mjs` 增加三节点直连 mesh：A/B/C 全连接、C→B RPC、三端 roster 各含两名 peer。
- 这是单进程网络层矩阵，不代替真实三台设备/真实 Relay 链路测试。
