# ADR-0032：1.13 的剩余能力补齐（除 P2P）

- **状态**：已实现（2026-11-15，1.13.0）
- **相关**：ADR-0025（Room 副本）、ADR-0028（invite/checkpoint）、ADR-0030/0031
- **结论**：补齐 P2P 之外的剩余代码项：invite 携带轮换链与分片、文件续传/目录/删除、Room `rotationSeq` 严格模式、身份重置前关闭 authority Room、checkpoint 确认广播、通知 webhook、Room 同步退避、a11y 标签与 mTLS 证书生成工具。

## 1. invite 携带轮换链 + 分片

- v3 payload 新增 `rotations`（创建者当前链，最多 1024 条），HMAC 覆盖；加入时写入 `peer-rotations.json`，离线也能从链头验证。
- `splitInviteCode` / `joinInviteCode` 提供 1800 字符分片/无损拼接；码仍是 bearer 凭据。
- 未做：超大 Fleet 的自动分片 UI（API 已具备）。

## 2. 文件传输扩展

- `fleet.file.stat/list/delete` RPC；`list` 走 `list` 权限，`stat`/`get` 走 `fetch`，`put`/`delete` 走 `write`，全部受 roots 约束。
- `fleet_upload` 支持 `recursive`（目录）与 `resume`（远端较小文件断点续传）；`fleet_download` 支持 `recursive`。
- 新增工具 `fleet_file_list` / `fleet_file_delete`；删除目录必须 `recursive: true`。
- 上限 2 GiB（1.18.0 起）；未做目录差异同步/符号链接跟随。

## 3. Room `rotationSeq` 严格模式

- 配置 `room.rotationSeqMode`：`audit`（默认，接受历史事件）或 `strict`（事件必须携带 origin 当前 epoch）。
- 严格模式会拒绝历史事件；升级前需评估旧 Room 日志。

## 4. 身份重置前 Room 清理

- `fleet_reset_identity` 先 close 本机 authority Room（通知 mirror）、归档 replica，再换身份，避免旧 authority 元数据参与 epoch 竞争。
- `summary.closedRooms` 返回被关闭的 Room。

## 5. checkpoint 确认广播

- `trustRotationCheckpoint` 成功后向已连接 peer 广播 `fleet.rotation.checkpoint_trusted`（advisory）；接收方记录通知。
- 仍未做：多签/quorum 强制执行；确认结果不改变其它设备的 roster。

## 6. 通知 webhook / 同步退避 / a11y / mTLS 工具

- `notifications.webhook`：POST JSON（审批/吊销/分叉/checkpoint 确认），失败静默，不阻塞。
- `RoomReplicaSync` 对失败 peer 指数退避（1s→60s），手动 `room_sync` 用 `force` 绕过。
- 控制台按钮补充 `aria-label/title`；完整 i18n 未做。
- `scripts/relay-mtls.mjs` 用 openssl 生成 CA/server/client 证书和配置片段；生产应由组织 PKI 管理。

## 不变量

1. invite 的 rotations 在 HMAC 内；链记录只用于加速/离线验证，最终仍以握手补链为准。
2. 文件删除必须经过 `write` 策略；目录删除必须显式 recursive。
3. strict 模式不影响默认 audit 行为。
4. 重置前关闭 Room 失败只告警，不阻止恢复（旧身份仍应被吊销）。
5. checkpoint 广播是 advisory，不构成共识。
6. 退避只影响后台同步，手动强制同步不被阻止。

## 未完成（明确保留）

- checkpoint 阈值多签/聚合签名/共识协议（当前是每个确认签名 + 有效签名计数，默认 quorum=1）；
- 真 P2P/NAT 打洞（本 ADR 范围外）；
- 完整 i18n：控制台标签、通知/审批动态句子、原生 confirm 已支持中英；插件日志、DSH 自身提示、工具原始错误仍是原文；
- 完整 DSH 远端轨迹的持久化/全量归档（当前按会话内存保存有界事件，可拉取只读轨迹）；
- Relay 跨主机选主/共识（多节点 supervisor + 客户端 failover 已完成）；
