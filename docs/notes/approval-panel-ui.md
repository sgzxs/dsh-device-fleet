# 审批面板 UI（dev.9 → dev.12）

## Host 数据面

`src/host/approval-web.js`：

- `GET /device-fleet/approvals` → `{ approvals: [...] }`（ApprovalInbox.list）；
- `POST /device-fleet/approvals/decide`，body `{ id, action: "approve"|"deny", scope?, reason? }` → 决策走 ApprovalInbox；
- 路由注册在插件 apply 中、卸载时 dispose；纯逻辑 `createApprovalApi` 与路由分离便于单测。

## Client 半

`client.js`（闭包工厂，id = `dsh-device-fleet`）：

- **入口**：`sidebar.footer.action`（Settings 上方），显示 `🛰️ 审批`，有待审批时带数字并高亮；不再占用 `shell.overlay` 右下角，避免与任务列表 UI 重叠；
- **面板**：`shell.overlay` 直接注册的居中模态对话框（遮罩、Esc/点遮罩/收起关闭）；
- 2.5s 轮询 `/device-fleet/approvals`；按钮「允许一次 / 允许 15 分钟(ttl) / 拒绝」POST 到 decide；
- 共享模块级 store + `ctx.effect` 启动/清理轮询；使用 `--dsw-alias-*` token（带 fallback）。

## 修复记录

- dev.10：右下角浮动按钮可用，但会遮挡任务列表（用户截图确认）；
- dev.11：入口迁到 sidebar footer；发现点击无反应；
- dev.12：修复 `Panel` 的条件 Hook 顺序（关闭时提前 return，打开后才调 `useEffect`，导致 React 渲染报错）；同时把 `shell.overlay` 改回直接注册（dev.10 已验证可用路径）。

## 端到端验证（已完成）

1. 刷新页面后 Settings 上方出现「🛰️ 审批」；
2. 点击后居中对话框正常打开并显示待审批条目（用户确认）；
3. `fleet_simulate_request` 造请求 `dae59ce4-…`（run/pwsh，simulated-device-B）；
4. 用户在面板点击「允许一次」；
5. Host `fleet_approvals` 返回 `(no pending approvals)` → **UI → HTTP → ApprovalInbox 写回链路闭环**。

## 限制

- 轮询而非 SSE 推送；
- 路由未额外鉴权（依赖 web 载体本地/会话边界）；
- 面板暂无房间视图（时间线/看板页下一步）。
