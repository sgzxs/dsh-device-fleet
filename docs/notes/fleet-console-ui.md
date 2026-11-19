# Fleet 控制台 UI（Phase A，dev.13）

## 用户决策（2026-11-09）

1. **配置保存必须即时生效**：不重启插件、不重启 DSH。→ Phase B 采用"运行时配置 + 持久化 overrides"设计（下一阶段实现）。
2. 房间 UI 动作身份：以**用户**身份（ADR-0007）。
3. 实施顺序：A → B → C → D。

## 本阶段实现

### Host 读模型

`src/host/ui-web.js`：

- `GET /device-fleet/overview`：`FleetNode.status()` + rooms 摘要 + approvals 列表；
- `GET /device-fleet/rooms`：房间摘要列表；
- `GET /device-fleet/rooms/:id`：房间详情（成员、策略、transcript、看板任务）。

### Room 持久化 / rehydrate

`RoomService` 新增 `stateFile`（`$DSH_HOME/device-fleet/rooms.json`）：

- 每次 append（创建/成员/消息/任务/关闭）后原子写快照；
- 启动时 `load()` 重建 rooms/members/messages/tasks；
- 成员 agent 不序列化，唤醒时通过 `sessionController.resolveAgent(sessionId)` 懒解析；
- 插件卸载不再关闭房间（避免重载即销毁）。

**验证**：创建 room + worker-c + 任务 + 1 条消息 → 插件重载 → `room_status` 仍显示 2 名成员、1 条消息、1 个任务；`room_task_list` 保留任务。

### Client

`client.js` 新增：

- `sidebar.panellist` 图标（id `fleet`，label `设备联邦`，圆形网格图标）；
- `main` keyed 面板 `fleet` = Fleet 控制台，三个 Tab：
  - **设备**：本机名称/id、直连地址、relay、发现数量；Fleet 成员列表（在线/离线）；回连地址；
  - **房间**：房间列表（成员数/消息数/任务数），选中后展示成员、看板、时间线；
  - **审批**：待审批列表 + 允许一次/15 分钟/拒绝（与快捷面板共用 Host API）。

## 未完成（Phase B/C/D）

- 配置页与即时生效（Phase B）；
- 房间交互：以用户身份发消息、看板操作、邀请/移除成员（Phase C）；
- 配对向导、设备操作、审批历史/授权撤销、SSE、通知、i18n、a11y（Phase C/D）。
