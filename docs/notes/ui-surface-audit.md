# UI 呈现缺口审计（2026-11-09）

## 现状盘点

当前插件已实现的 UI 只有**审批面板**（dev.12）：

- 入口：`sidebar.footer.action` 的「🛰️ 审批」；
- 内容：`shell.overlay` 居中对话框，待审批列表 + 允许一次/15 分钟/拒绝；
- 数据：Host `/device-fleet/approvals`、`/device-fleet/approvals/decide`。

其余**全部**依靠模型工具文本输出或 profile YAML 配置，没有任何可视化：

| 设计要素 | 当前呈现方式 | 缺口 |
|---|---|---|
| 设备列表 / 在线状态 / 直连地址 / relay / 发现 | `fleet_status` 文本 | 无设备页，无法看设备拓扑与连接路径 |
| 配对：邀请码、加入、手动地址、设备移除 | `fleet_invite`/`fleet_join`/`fleet_connect` 工具 | 无配对向导，邀请码需在聊天里传 |
| 插件配置（deviceName/direct/discovery/relay/execution/policy/approvals/prompt） | profile `cordis.patch.yml` | 完全无 UI，改配置要手改 YAML + 重启 |
| Room 列表 / 房间状态 | `room_status`、`room_messages` 文本 | 无房间列表/视图 |
| Room 成员（设备 × agent、host/local/remote） | `room_status` JSON | 无成员可视化，看不出"不同设备不同 agent" |
| Room 时间线（用户可见完整对话） | `room_messages` 文本 | 无时间线 UI，无消息流式更新 |
| Room 发消息 / 点名 | `room_send` 工具 | 无输入框/@成员操作 |
| Room Board（任务、owner、状态、依赖、交接） | `room_task_*` 文本 | 无看板视图 |
| 房间策略（invite/join/maxMembers/boardWrite） | 创建参数 | 无查看/编辑 |
| 审批历史 / TTL 授权管理 | 收件箱列表（仅 pending） | 无历史、无授权撤销 |
| 委派（fleet_delegate） | 工具结果文本 | 无历史/运行状态/中断入口 |
| 直调审计（谁调了哪台设备什么工具） | 会话轨迹里 | 无 Fleet 维度审计页 |
| 首次配对引导 | 无 | 新设备没有任何向导 |
| 错误/诊断 | `fleet_status` + 日志 | 无连接诊断页 |
| 通知 | 无 | 新审批/新消息没有系统通知 |
| 国际化 | 中文硬编码 | 未接 Client locale 服务 |
| 多窗口/实时 | 审批 2.5s 轮询 | Room/设备状态无推送，多窗口不同步 |

## 关键基础设施缺口（UI 之前必须先补）

1. **Host 读模型 API 不足**：目前只有 approvals 两条路由；需要
   - `GET /device-fleet/overview`：本机身份/版本/直连/relay/discovery/roster/connected/peerHints；
   - `GET /device-fleet/rooms`、`GET /device-fleet/rooms/:id`：成员、策略、transcript、tasks；
   - `GET /device-fleet/events`（SSE）或长轮询：状态变化推送。
2. **配置写路径缺失**：Cordis config 来自 profile patch，运行时不可写。需要确定：
   - 方案 A（推荐）：`$DSH_HOME/device-fleet/config-overrides.json` + apply 时合并，UI 写该文件；保存后提示"重载插件生效"（或调用 Host 重新加载）；
   - 方案 B：直接改写 profile `cordis.patch.yml`（风险高：破坏注释/结构，需备份）。
3. **Room 状态无持久化/rehydrate**：RoomService 是内存 Map，插件重载/DSH 重启后房间消失。UI 之前应先做基于 host session 事件的 rehydrate，否则"房间视图"打开是空的。
4. **UI 操作的身份与授权**：UI 里的"发消息/改任务/关房"是以**用户**身份还是 host agent 身份？需要 Room 服务暴露 user 动作并校验房主/成员权限。
5. **Slot/设计系统**：已确认可用的官方扩展点：
   - `sidebar.panellist`（全局面板图标）+ `main`（keyed 主面板）→ Fleet 控制台；
   - `settings.section`（设置页）或 `plugins.bundle.config`（插件配置页，key = 包名）→ 配置 UI；
   - `shell.overlay` → 对话框/房间详情；
   - `sidebar.footer.action` → 快捷入口（审批已用）。
6. **多设备语义呈现**：房间成员需要 "设备（名称/在线/连接路径）× agent（session/角色）" 两级标签；当前 member 只有 `local:session-…`/`host:…` 字符串，远程成员还没有实体，需要先接远程参与者传输。

## 建议的信息架构

```
侧栏
├─ 全局面板图标「Fleet」 (sidebar.panellist: id=fleet)
│   └─ main keyed "fleet" 主面板
│        ├─ 设备 Tab：本机状态、roster、在线/离线、直连/relay、配对按钮、诊断
│        ├─ 房间 Tab：房间列表 → 房间详情（成员树、时间线、看板、策略）
│        └─ 审批 Tab：待审批 + 历史 + 授权管理
├─ Settings 上方「🛰️ 审批」快捷入口（已实现）
└─ Settings → 插件 → Device Fleet 配置页
     (plugins.bundle.config key "dsh-device-fleet" 或 plugins.row.config "dsh-device-fleet#device-fleet")
     分块：设备/网络 · 执行上下文 · 远端权限(Tool Policy) · 本地审批 · 高级
```

## 分阶段实施计划

**Phase A：Fleet 控制台（只读）**
- Host `/overview`、`/rooms`、`/rooms/:id` API；
- `sidebar.panellist` + `main` 主面板，三个 Tab：设备 / 房间 / 审批（待审批 + 只读时间线/看板）；
- 先解决 Room rehydrate，否则只读视图无内容。

**Phase B：配置 UI**
- `plugins.bundle.config` 注册配置页；
- 字段分组 + 校验 + 当前值显示；
- 保存走 overrides 文件（方案 A），保存后提示重载插件；policy 的 roots/tools 用列表编辑器。

**Phase C：交互动作**
- 房间：以用户身份发消息（点名选择成员）、看板任务增改/交接、关房、邀请/移除成员（权限校验）；
- 设备：配对向导（邀请码生成/扫码式复制、手动地址连接、移除设备）；
- 审批：历史列表 + ttl 授权撤销。

**Phase D：体验与可靠性**
- SSE/事件推送替代轮询，多窗口同步；
- 通知（新审批/新房间消息）；
- Client locale（zh/en），a11y，空状态/引导；
- 插件重载 rehydrate、房间日志持久补发（ADR-0018）。

## 需要你确认的决策

1. 配置写路径：选 **overrides 文件（推荐）** 还是直接改 profile YAML？
2. 房间 UI 动作的身份：以 **用户** 身份（推荐，符合 ADR-0007 用户发言与设备解耦）还是 host agent 身份？
3. 先做 Phase A（控制台只读）还是先做 Phase B（配置页）？我建议按 A → B → C → D。
