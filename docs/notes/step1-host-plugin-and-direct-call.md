# Step 1：Host 插件接入 + 直调 MVP（实现说明）

状态：**代码完成、单元测试通过（net 8/8 + host 6/6），尚未在真实 DSH 进程内安装联调**。

## 本轮落地

| 文件 | 内容 |
|---|---|
| `src/plugin/index.js` | Cordis Host 插件入口：`name`/`inject`/`Config`/`apply`；加载持久状态、启动 FleetNode、注册 6 个 `fleet_*` 工具、常驻提示 section、首次使用手册、编排钩子一行提示、账号指纹绑定、退出清理 |
| `src/host/store.js` | `$DSH_HOME/device-fleet/` 下的身份/Fleet/roster/config/enrollment 持久化（原子写）；邀请创建与接受；账号指纹比对 |
| `src/host/tool-policy.js` | 设备本地 Tool Policy：allowedRoots、read/list/grep/fetch/run/tool 六种能力的 auto/ask/deny、原始工具 allowlist、一次性/TTL 授权 |
| `src/host/execution-slot.js` | Execution Slot：懒创建隐藏 DSH 会话（`sessionController.create` → `resolveAgent`），用 `ctx.tools.execute` 在该 agent 上下文里执行工具，不跑模型 |
| `src/host/direct-call.js` | `DirectCallHost`（B 侧：`fleet.ping/info/tools/call`，策略→审批→执行）、`DirectCallClient`（A 侧 RPC 封装与结果渲染） |
| `src/host/tools.js` | 6 个工具定义：`fleet_list` / `fleet_tools` / `fleet_call` + `fleet_read` / `fleet_fetch` / `fleet_run`（typed 快捷工具走同一 `fleet.call` 路径） |
| `cordis.patch.yml` | 插件挂载行与安全默认配置 |
| 网络层 | 握手新增 `pluginVersion` / `dshVersion` / `capabilities` 严格校验（ADR-0024）；新增版本不匹配测试 |

## 配置示例（profile patch / 插件设置页）

```yaml
- id: device-fleet
  config:
    deviceName: desktop
    discovery: true
    relay: { host: relay.local, port: 47800, dataPort: 47801 }
    execution:
      cwd: D:/work            # Execution Slot 的工作目录
      agentPreset: standard   # 必须是本机存在的 preset
      shellTool: pwsh
    policy:
      allowedRoots: [D:/work] # 直调只能访问这些根
      capabilities: { read: auto, list: auto, grep: auto, fetch: auto, run: ask, tool: deny }
      allowedTools: []
      approvalTtlMs: 900000
```

## 已测试

- 网络层 8 个测试：直连 RPC、组播发现、Relay 加密中继、跨 fleet/跨账号/固定公钥/版本不匹配拒绝、Relay 鉴权失败；
- Host 层 6 个测试：状态持久化与邀请入网、Tool Policy（根目录/能力档位/allowlist/TTL）、Execution Slot 懒创建与结果归一、DirectCallHost 的策略/审批/执行、工具 handler 的列表与快捷路由、客户端渲染；
- 全部 `src/**/*.js` 通过 `node --check`。

## 未验证 / 已知缺口

1. **未在真实 DSH 进程里加载**：`@deepseek-ai/dsh-tools`/`schemastery`/`dsh-llm` 的 peer 解析、Config schema 校验、`ctx.*` API 细节需要在安装后确认（sandbox 里无法 import profile 依赖）。
2. **审批收件箱 UI 未实现**：`ask` 档当前 fail-closed（`autoApproveAsk: true` 仅供开发）；收件箱、TTL 授权、通知属于下一步。
3. **`fleet_run` 参数尚简单**：目前只传 `command`；cwd/超时/环境变量待补。
4. **`fleet_fetch` 只返回文本**（≤ 限制内），大文件/二进制与写入 A 侧工作区待做。
5. **Room / Board / 委派 / UI 未开始**；插件尚未安装到 profile（需要一次 danger-full-access 审批）。
6. 账号服务不可用时 `accountFingerprint = null`，握手不做账号比对；需要在真实登录态下验证。

## 下一步

1. 安装 bundle 到 `desktop` profile（`plugin_manager install_bundle`，需批准）；
2. 在真实 DSH 里验证：插件加载、6 个工具出现在模型工具表、`fleet_list` 正常；
3. 用第二台设备（或第二个 DSH_HOME/实例）完成一次"fleet_read 读对端文件 + fleet_run 跑命令（带 B 侧审批）"的端到端联调；
4. 再进入 Room / Board / 委派与审批 UI。
