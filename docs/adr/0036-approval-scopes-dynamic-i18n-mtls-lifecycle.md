# ADR-0036：审批作用域、动态 i18n 与 mTLS 证书生命周期

- **状态**：已实现（2026-11-17，1.17.0）
- **相关**：ADR-0020（审批）、ADR-0029/0031（Relay TLS/mTLS）、ADR-0032（剩余能力）、ADR-0035（i18n）

## 1. 审批作用域

- `once`：一次调用；`ttl`：时间窗内同一 capability；
- `room`：绑定 `roomId`，Room 关闭/删除时撤销；
- `task`：绑定 `taskId`，任务标记 `done` 时撤销；
- 请求可携带 `roomId/taskId`；Room 自动 wake 带 `roomId`；`fleet_call`/`fleet_delegate` 新增可选 `roomId/taskId`；
- UI 只在有对应上下文时显示“允许本房间/本任务”；没有上下文时服务端拒绝该 scope，不会消耗请求。

## 2. 动态 i18n

- 在客户端翻译层增加：
  - 计数/状态/相对时间等正则（成员/消息/任务/超时/密钥 seq）；
  - 通知正文（审批、checkpoint、分叉、吊销）的中英句式；
  - `动作失败：原因` / `动作成功` 等动态运行状态；
  - 常见 Room/设备/配置标签。
- 用户消息正文、工具返回的原始错误、插件日志不做机器翻译；不支持的内容回退原文。

## 3. mTLS 生命周期

- Relay 服务端支持 `allowedClientFingerprints` 或 `allowedClientFingerprintsFile`；文件每个新连接重新读取，因此撤销指纹无需重启 Relay；
- `scripts/relay-mtls.mjs` 初始化 CA/server/client 并生成 allowlist；
- `scripts/relay-client-cert.mjs rotate|revoke|list` 轮换/吊销/查看客户端证书；`rotate --install` 覆盖 `client-cert.pem/client-key.pem`；
- `fleet_relay_reconnect` 让客户端断开并重新读取证书文件；不调用则在下一次正常重连时生效；
- 已有连接在撤销后仍保持，直到断开；这是 TLS 会话的固有限制。

## 不变量

1. 无上下文时不能授予 room/task scope；
2. room/task grant 只匹配相同 Room/task 上下文；
3. allowlist 缺失/损坏时 fail-closed（拒绝所有客户端）；
4. 证书私钥不进入 invite、peer 广告或日志；
5. i18n 不改变协议/存储，未知文本回退中文。

## 未完成

- 插件日志、DSH 原生 prompt/alert、工具原始错误仍是中文；
- 多真人身份模型仍为设计边界；
- 真 3+ 设备与 Relay TLS 实链路矩阵未跑。
