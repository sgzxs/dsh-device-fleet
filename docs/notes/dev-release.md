# 开发版发布记录

> **历史发布流水（按时间追加）。** 当前版本与现状见 [STATUS.md](../STATUS.md)。早期 dev.4–dev.20 期间的若干条目沿用了 `0.1.0-dev.20` 标题前缀；版本对应关系以 npm 发布时间为准，本次不重写历史正文。

- 包名：`dsh-device-fleet`
- 起始版本：`0.1.0-dev.3`（2026-11-09）；当前版本：`1.20.7`（**正式发布**；现状看 [STATUS.md](../STATUS.md)）
- dist-tag：`dev` → `1.20.7`，`latest` → `1.20.7`（也可用精确版本安装）
- registry：<https://registry.npmjs.org/dsh-device-fleet>
- 首个 tarball：<https://registry.npmjs.org/dsh-device-fleet/-/dsh-device-fleet-0.1.0-dev.3.tgz>
- 首个离线包：`dsh-device-fleet-0.1.0-dev.3.tgz`（历史文件；当前正式离线包为 1.20.7）
- 发布时间：2026-11-09（Asia/Shanghai）
- 首个版本内容：网络层 v1/v2 + Host 插件 + 直调 MVP（`fleet_invite/join/list/tools/call/read/fetch/run`）；Room/Board/委派/审批 UI 当时未包含。

## 安装

```sh
dsh plugin --profile web add dsh-device-fleet@dev
# 桌面 app：完全退出后
dsh plugin --profile desktop add dsh-device-fleet@dev
```

发布时 npm 对新包做了短暂的处理/占位（`0.0.0-stage`），约几分钟后真实版本生效；后续版本号递增、tag 复用 `dev`。

## 已知限制

- 严格同版本：两台设备必须安装同一 `0.1.0-dev.3`，DSH 版本也要同一发布线；
- `fleet_run` 的 `ask` 审批目前 fail-closed（审批收件箱未实现）；
- `fleet_fetch` 仅返回文本；
- 首次加载会在 `$DSH_HOME/device-fleet/` 自动创建身份与独立 Fleet；加入已有 Fleet 需要先 `fleet_join` 再重启；
- 默认 `direct.host=0.0.0.0` + UDP 组播发现；Windows 防火墙可能弹窗，需允许。

## 安装激活记录（本机 desktop profile，2026-11-09）

- 第一次 install_bundle 被拒：`package.json` 带 UTF-8 BOM → 去掉 BOM 后通过；
- 第一次 activate 失败：`@deepseek-ai/schemastery` 只有默认导出（`import Schema from ...`），改为默认导入；
- 第二次 activate 失败：Cordis 直接访问未 inject 的服务会抛错 → 可选服务统一走 `ctx.get(name)`；
- 最终 `set_plugin include:device-fleet enabled=true` → `application: applied`，8 个 `fleet_*` 工具出现在模型工具表，`fleet_list` 返回本机 device id，`taskui_probe` 仍为 v0.4.2 / tasks=247（与 task-list 无冲突）。
- 已发布 `0.1.0-dev.3`（包含上述激活修复）；`0.1.0-dev.1` 会激活失败，不要使用。
## 0.1.0-dev.3（首个发布）

- 邀请里新增 `endpoints`（创建者的局域网/热点 IPv4 + direct 端口），加入方重启后自动向这些地址回连，绕开组播发现失败；
- 新增 `fleet_status`（deviceId/直连端口/发现/连接/roster/hints）与 `fleet_connect(host, port)`（手动直连，成功后会从握手学到对端 deviceId）；
- `fleet_list` 仍是本地视图；配对成功后双方 roster 会自动固定对端公钥。
## 0.1.0-dev.20（稳定化）

- 直连端口可固定（profile `direct.port`），插件重载不再换端口；
- 连接断开后自动重试已知地址（不再只在启动时试一次）；
- `fleet_connect` 手动地址会持久化到 `peer-hints.json`，重启后继续回连；
- 新增 `fleet_delegate`（dev.5）：目标设备用 `SubagentProvider` + `delivery:'caller'` 跑 agent 并返回最终结果。
## 0.1.0-dev.20（审批收件箱，逻辑层）

- 新增 `ApprovalInbox`：ask 档请求排队、超时 fail-closed、approve（once/ttl）/deny、关闭时全部失败关闭；
- 直调与委派的 ask 档改为等待本机收件箱结果（不再一律拒绝）；
- 新工具：`fleet_approvals` / `fleet_approve` / `fleet_deny`；`fleet_simulate_request`（仅 `approvals.simulation: true`）用于本机无第二台设备时演练流程；
- 审批面板（Client UI）与通知尚未实现，当前通过工具/后续 UI 应答。
## 0.1.0-dev.20（Room 逻辑层，本机模拟）

- `RoomService`：当前会话升级为 Room Host；本地模拟参与者（真实 DSH session/agent）；
- 寻址消息：`room_send` 只唤醒被点名成员，Host 会话写权威 `room/message` 事件；
- 可见性：`room_messages` 提供完整 transcript；未点名成员不运行；
- Room Board：`room_task_add/update/list`，`dependsOn` 串行交接（前置完成时唤醒下一个 owner），无依赖任务并行不受影响；
- 工具：`room_create / room_add_local / room_remove_member / room_send / room_messages / room_status / room_task_* / room_close`；
- 远程参与者传输与 Client UI 未做（下一步）。
## 0.1.0-dev.20（审批面板 UI，第一版）

- Host 新增本地 HTTP 数据面：GET `/device-fleet/approvals`、POST `/device-fleet/approvals/decide`（仅本机 web 载体，决策仍走 ApprovalInbox）；
- Client half：`client.js` 闭包工厂，注册 `shell.overlay` 浮动「Fleet 审批」按钮 + 面板，轮询待审批列表，支持允许一次 / 允许 15 分钟 / 拒绝；
- package.json 增加 `dsh.client` 与 `./client` 导出；`files` 增加 client.js；
- Client 视觉验证需要刷新页面；当前无浏览器控制，仅验证了 bundle 语法与 Host 路由注册。
## 0.1.0-dev.20（审批入口不遮挡）

- 触发按钮从右下角浮动改为 `sidebar.footer.action`（设置旁边），不再遮挡任务列表/内容面板；
- 审批 inbox 改为点击后居中的模态对话框（带遮罩，Esc/点遮罩关闭）；
- 轮询在 Client apply 中启动并由 ctx.effect 清理；待审批数量作为按钮徽标；
- 已实测：面板点击「允许」后 Host `fleet_approvals` 清空。
## 0.1.0-dev.20（Phase B：运行时配置 + 配置页）

- `RuntimeConfig`：profile patch 为 base，UI 修改写入 `$DSH_HOME/device-fleet/config-overrides.json`，apply 时合并并持久化；
- 保存即生效：policy/execution/approvals/deviceName/promptSection/autoApproveAsk 直接更新运行时对象；direct/discovery/relay 通过 `FleetNode.reconfigure()` 原地重启网络监听（不重启插件/DSH）；`dataDir` 只读；
- Host：`GET /device-fleet/config`、`POST /device-fleet/config`（校验/清洗后应用）；
- Client：注册 `plugins.row.config`（key `dsh-device-fleet#device-fleet`）与 `plugins.bundle.config`（key `dsh-device-fleet`），配置页含设备/网络、执行上下文、Tool Policy、审批与提示四组表单；
- 单测 18/18、网络 9/9。
## 0.1.0-dev.20（配置页 DSH 化改版）

- Host 新增 `GET /device-fleet/options`：本机地址、可用 preset 列表、shell 工具、subagent providers、工作目录候选；
- 配置保存前会 ensure 工作目录存在（Device Fleet 工作区自动创建）；
- 配置页重做：行式布局（label 左/控件右）、DSH token 配色、分组标题、去掉多余说明文字与 dataDir 展示；
- 下拉化：直连地址、局域网发现、Relay 模式、工作目录（工作区/默认/DSH 主目录/自定义）、Agent Preset、Shell、委派 Provider、7 项能力权限、开关项；
- 仍保留文本输入：设备名称、端口、超时、根目录/工具列表、自定义工作目录与 Relay 地址。
## 0.1.0-dev.20（房间详情与配置页修复）

- 房间详情接口从 prefix 路由改为精确路由 `GET /device-fleet/room?id=...`，修复控制台一直「加载房间…」；客户端加载失败时显示错误文案；
- 配置页宽行改为「标签在上、控件在下」，修复根目录等标签竖排换行；
- 保存按钮改为固定品牌蓝底白字，修复按钮看起来空白；
- 「允许的原始工具」改为「免审批即用的工具」：从 Host options 拉取本机真实工具清单，以复选框选择（不再手输工具名）。
## 0.1.0-dev.20（原始工具遵循 DSH 审批）

- 移除「免审批即用的工具」白名单；raw tool 调用不再由插件 allowlist 决定；
- `policy.capabilities.tool` 默认 `auto`：完全走 DSH 工具流水线（target Session 的 pre-execute policy + approval seam）；`deny` 禁用 raw tools，`ask` 在 DSH 前加一层本机审批；
- 新增 `approval/request` 监听：Execution Slot 里 DSH 需要审批的工具调用会转到本设备审批收件箱（面板可处理），不需要审批的工具直接执行；
- 旧配置里 `tool: deny` + 空 allowedTools 自动迁移为 `auto`；
- 配置页移除工具复选框列表，「原始工具（遵循 DSH 审批）」保留 自动/询问/拒绝 下拉。
## 0.1.0-dev.20（Phase C：交互动作）

- Room 用户动作：以用户身份发消息（选择收件人）、看板任务添加/状态更新、关闭房间、移除成员；
- 设备动作：生成/复制邀请码、手动地址连接（host+port）；
- 审批历史：ApprovalInbox 记录最近 50 条已决请求（approved/denied/expired/closed），Console 审批 Tab 展示历史；
- 新增 Host 动作路由：`/room/send`、`/room/task`、`/room/close`、`/room/member/remove`、`/pair/invite`、`/pair/connect`、`/approvals/history`。
## 0.1.0-dev.20（修复控制台空白）

- 根因：FleetConsole 的设备/房间交互误用了从未定义的 `ActionButton` 组件（React 渲染抛 ReferenceError，主面板空白）。
- 修复：统一改用已有的 `smallButton`。
- 新增 `scripts/client-smoke.mjs`：用最小 Hooks 渲染器 + mock fetch 实际渲染控制台（初始/设备/房间列表/房间详情），防止这类渲染崩溃再次漏过 `node --check`。
## 0.1.0-dev.20（Room 回归 Session）

- Room 恢复为「就是普通 Session」的体验：会话输入框下方新增 Room 成员条（composer.dock），显示 Room 成员；普通会话显示「升级为 Room」按钮（Host API `/room/upgrade`，无需工具调用）；
- Host 监听 `session/event` 的 `user/message`：Room Host 会话里用户正常聊天输入会自动投递给房间参与者并唤醒它们（带 `[Room]` 前缀的注入消息不重播，避免循环）；
- 参与者回复投递回 Host 时以 `[Room] <成员>: <内容>` 形式进入正常 Chat 流，不再需要独立的房间仪表盘；
- Fleet 控制台保留为设备/配对/审批/配置管理入口。
## 0.1.0-dev.21（Room 回复地址修复）

- 参与者被用户消息唤醒时，回复引导里的目标从无效的 "host" 修正为真实 Host member id（`host:<sessionId>`），修复 worker 回执发给自己/失败的问题。
## 0.1.0-dev.22（Room 独立视图，停止 host 转述）

- Session 内新增「房间」Conversation View（`conversation.view`，label 房间）：展示成员、时间线（含发言者/收件人）、看板与房间操作，输入默认发给非 host 参与者；
- 移除 Chat 输入的隐式 Room 广播：普通 Chat 只属于 host agent，Room 交流在「房间」页进行，避免用户在 Chat 里说话被自动转发、或 host agent 转述 worker 回复；
- host 不再接收参与者回复的 Chat 注入（参与者回复只进入房间时间线）；
- 输入框下方成员条提示「房间消息在『房间』页交流」。
## 0.1.0-dev.23（Room 聊天气泡视图）

- 「房间」Conversation View 重做为聊天式：agent 消息在左（头像 + 名字 + 收件人），用户消息在右；时间戳、Enter 发送、收件人勾选；
- 参与者消息原文直接作为左侧气泡展示，不再进入 host 的普通 Chat；
- 看板可展开/收起，支持任务状态更新与添加。
## 0.1.0-dev.24（Room @点名）

- 房间输入框支持输入 `@` 弹出成员自动补全；选中成员变为「发给」chip，可点击取消；
- 无点名时默认发给所有非 host 参与者；被点名成员才唤醒；
- 聊天气泡显示发送者与收件人（worker-c · → host），用户侧为右气泡、agent 侧为左气泡；
- 后续：把 Room 状态下的 Chat 替换为这套界面（插件增量，不卸载系统 Chat）。
## 0.1.0-dev.25（Room 头像）

- Room 对话头像改为图片：worker → worker.png（蓝色大肥鱼），host → host.png（偷吃 Token），user → user.png；
- Host 新增 `/device-fleet/avatar/{host,worker,user}` 精确路由，从插件 `assets/avatars/` 提供 PNG；package `files` 包含 assets。
## 0.1.0-dev.26（Room 自动切换 + 头像库）

- RoomDock 在检测到会话是 Room 时尝试通过标准 slot 的 `useConversation` 钩子自动切到「房间」Conversation View（不同版本的 shell 若未暴露该 API 则保持手动切换）；
- 头像库：Settings → Plugins → Device Fleet 配置页新增「头像库」，可多选上传 png/jpeg/webp；Host 存到 `$DSH_HOME/.../avatars/`，提供列表/预览/删除接口；
- Room 成员头像按成员顺序循环分配库中图片，可点「换头像」切换到下一组；未上传时使用内置三张图。
## 0.1.0-dev.27（修复插件配置页空白）

- 根因：dev.26 头像库区块误用了不存在的 `sectionCard`，FleetConfig 渲染抛 ReferenceError，导致 Settings → Plugins → Device Fleet 配置页消失。
- 修复：头像库改用普通卡片容器；client smoke 增加配置页真实渲染用例（plugins.row.config）防止回归。
## 0.1.0-dev.28（Room 复用 DSH 输入框 + @点名解析）

- 移除房间页自带发送栏，房间消息直接使用 DSH 底部输入框；
- Host 监听 Room Host 会话的 user/message：解析 `@成员名`，被点名成员才加入收件人；未点名默认发给所有参与者；
- 消息文本会去掉 @mention 标记后写入房间日志；host 本身已收到 Chat 输入，不重复唤醒；
- 房间页保留成员/气泡/看板，底部提示用 @ 点名。
## 0.1.0-dev.29（@补全面板 + host 房间发言）

- 房间 Dock 读取 DSH 输入框草稿（标准 `useInput` 钩子），输入 `@` 时在输入框上方弹出补全面板，顶部标注「可发送给：所有人 / 指定 agent」，列出 Room 成员并可点击插入 `@name`；
- host agent 在 Chat 的 assistant 消息会同步写入 Room 日志（只读记录，不唤醒参与者），房间页左侧出现 host 气泡与 host 头像。
## 0.1.0-dev.30（按视图路由输入 + @agent 快捷 chip）

- 修复：只有「房间」Conversation View 打开时，DSH 输入框消息才路由给 Room 参与者；在 Chat 页和 host 说话不再唤醒 worker-c（房间页 mount/unmount 向 Host 上报 focus）；
- Room Dock 常驻显示「可发送给 @host @worker-c …」chip，点击通过 inputActions/execCommand 插入 @name，避免与 DSH 原生 @ 文件补全冲突；
- DSH 原生 `@` 会先弹文件/文件夹补全（系统行为，插件不能替换该 popup）。
## 0.1.0-dev.31（Room focus TTL + 头像/补全稳定化）

- 修复插件被禁用后看起来“会话不是房间”的困惑：Room 数据在 rooms.json 中持久化，重新启用插件即恢复；
- Room 输入路由增加 20s TTL 与 5s heartbeat：只有「房间」视图仍然活跃时 Chat 输入才会投递给参与者，避免切回 Chat 后残留 focus 导致误唤醒 worker-c；
- Room Dock 常驻 @host/@worker-c 插入 chip；DSH 原生 @ 仍会弹文件补全（系统行为）。
## 0.1.0-dev.32（Room 状态下替换 Chat 的增量覆盖层）

- Room 会话在 Chat 视图下，插件在内容区渲染 Room 对话覆盖层（成员/左右气泡/头像/看板），系统 Chat 仍挂载在下方不卸载；
- 当切到「房间」Conversation View 时覆盖层自动隐藏（视图本身接管）；普通会话不渲染覆盖层；
- Room 输入仍走 DSH 输入框与 @点名；覆盖层与房间视图共用同一 Room 状态。
## 0.1.0-dev.33（回滚 Chat 覆盖层，恢复 Room Dock）

- dev.32 的 Room Chat 覆盖层在真实页面里导致 composer dock 不渲染（Room 成员条/房间标签消失），已回滚覆盖层渲染，恢复稳定的 Room Dock；
- 保留 focus heartbeat/TTL、@agent chip、host 发言同步与头像库；后续会用更小步的隔离组件重新尝试 Chat 替换。
## 0.1.0-dev.33（启动失败修复：client 槽位注册竞态）

- 现象：桌面端启动报 `web boot: 1 entry did not activate / dsh-device-fleet: failed`，应用无法打开；
- 根因：`client.js` 对 `shell.overlay` 与 `main` 用了直接 `ctx.slots.register()`。这两个槽由 `dsh-client-ui-layout` 的根注册声明，而客户端所有 entry 是并发创建的；当本插件先于 ui-layout apply 时，注册抛 `slot "shell.overlay" is not declared`，整个 client entry 变 FAILED（该错误信息不进入 web boot 摘要，所以只看到 `failed`）；
- 修复：两处改为 `ctx.slots.inject(slot, () => ctx.slots.register(...))`，与官方 client 插件一致，等声明到达再注册；
- `scripts/client-smoke.mjs` 的槽位 mock 改为真实语义（未声明即抛、inject 延迟执行），并在「任何槽位都未声明」时先 apply，防止竞态回归；
- 顺带修复 `src/plugin/index.js` 里 `const policy` 被 live-config 回调重新赋值的问题（改配置保存时会抛 `Assignment to constant variable`）；
- 验证：严格槽位 mock 复现旧代码抛错、新代码通过；用桌面运行时 0.2.2-rc.1 在独立 profile 启动同一份 patch，真实 Chromium 加载页面后无 `Failed to load plugins`；host 单测 19/19、net 10/10、client smoke 全过。
- 注意：本机 `dsh-device-fleet-0.1.0-dev.33.tgz` 打包于修复之前，分发前需重新 `npm pack`（或升版本重发）。
## 0.1.0-dev.33（会话日志修复：room 事件必须是 ignorable plugin record）

- 现象：打开做过 Room 的会话报 `历史加载失败：... contains event type "room/created" (seq 3568) unknown to this harness and not marked ignorable; refusing to interpret the log`；
- 根因：`RoomService.append()` 用 `session.append('room/created', ...)` 直接写自定义事件。DSH 持久化读路径只接受 `KNOWN_SESSION_EVENT_TYPES` 内的事件，或带信封标记 `ignorable: true` 的未知事件；`session.append` 不写该标记，整个日志因此不可读（同版本 harness 也读不了自己写的日志）；
- 修复：改用 `@deepseek-ai/dsh-session` 导出的 `appendPluginRecord(session, 'plugin:device-fleet/<name>', data)`，事件类型进入 `plugin:` 命名空间并自带 `ignorable: true`；新增 `@deepseek-ai/dsh-session` peer 依赖，按需动态 import（纯 Node 单测没有运行时包树）；写失败只告警一次并继续，Room 状态仍落 `rooms.json`；
- 已损坏日志：新增 `scripts/repair-session-logs.mjs`（需 zstd CLI，`ZSTD_PATH` 可指定）。它把旧 `room/*` 事件原地改名为 `plugin:device-fleet/*` 并补 `ignorable: true`，其余行逐字节保留，先备份再替换，并用重新解压逐行校验；本机已修 `session-269260c9`（20 条）与 `session-0b0af927`（1 条），原始文件留 `.bak-room-events-*`；
- 二次踩坑：第一次修复把整份 JSONL 压成了**单一 zstd 帧**，而 DSH 读 header 的方式是「只解第一帧，且第一帧必须恰好是一行 header」（`assertZstdHeaderFrame`）。帧结构被改坏后 header 读取失败，日志被当作损坏而**静默跳过**，会话从侧栏消失（目录和文件都还在）。已按「第一帧=header，其余按 4MB 分帧」重写，两个会话均恢复；工具已内置同样的帧结构与校验；
- 测试：`test/host.test.mjs` 注入 `appendRecord` 桩并断言写出的类型只能是 `plugin:device-fleet/room-*`，19/19 通过；两个会话修复后用真实 zstd 解压逐行复核，旧类型 0 条、第一帧为单行 header。
- 串起三段故障的完整复盘（含运行手册与备份清单）：[incident-2026-11-09-boot-and-room-log.md](./incident-2026-11-09-boot-and-room-log.md)。
## 0.1.0-dev.34（事故修复发布）

- 槽位注册全部改为 `ctx.slots.inject`（修应用启动失败）；
- Room 会话事件改用 `appendPluginRecord` 写 `plugin:device-fleet/*` + `ignorable`（修会话日志不可读），旧日志已修复；
- 会话日志首帧 header 契约校验（修侧栏会话消失）；
- `repair-session-logs.mjs` 增加 %TEMP% 不可写时的工作区回退；
- Host 19/19、网络 10/10、client smoke 全过；全量 137 份会话日志 changed=0。
## 0.1.0-dev.35（Chat 替换：隔离实验，默认关闭）

- 新增 feature-flag 的 Room Chat 覆盖层（localStorage `fleet.roomOverlay`，默认关闭），只读渲染 Room 成员/气泡；
- 覆盖层包在 class ErrorBoundary 内：渲染失败只显示回退提示，不再可能连带卸载 composer dock；
- Room 成员条新增「替换 Chat（实验）」/「恢复 Chat」开关；系统 Chat 始终保留未卸载。
## 0.1.0-dev.36（Chat 替换默认开启测试）

- 测试构建：Room 会话在 Chat 视图下默认显示只读 Room 覆盖层（localStorage 无记录时视为开启）；点「回到 Chat」持久化为关闭；
- 覆盖层存活期间向 Host 上报 Room focus，Chat 输入直接路由给 Room 成员；卸载/关闭后取消；
- ErrorBoundary 仍包裹覆盖层，渲染失败只回退提示，不影响 composer dock；smoke 增加覆盖层与边界回退渲染断言。
## 0.1.0-dev.37（修复 webServer 采样导致所有 HTTP 路由丢失）

- 根因：Host 插件在 `apply` 时 `const webServer = service('webServer')` 采样；桌面端 webServer 可能晚于插件激活，采样为 undefined 后所有 `/device-fleet/*` 路由永久不注册，客户端房间 Dock 拉不到数据而消失（dev.24 起间歇出现）。
- 修复：改用 `ctx.inject(['webServer'], (webCtx) => { ... })`，在服务可用后注册头像/审批/配置/UI 路由。
- RoomDock 增加加载失败提示与重试，Dock 不再因一次 fetch 失败直接消失。
## 0.1.0-dev.38（RoomDock 永不静默消失 + 版本标记）

- Room 成员条渲染包 `RoomDockBoundary`：RoomDock 渲染异常时显示带版本号的错误条，不会让 slot occupant 变 inactive/整块消失；
- `room=null` 时改为显示「Room 载入中…（版本）」，不再 return null；
- 成员条显示 `0.1.0-dev.38`，用于确认浏览器加载的是哪一版 client bundle。
## 0.1.0-dev.39（修复 React #310：条件调用的 useInput）

- RoomDock 的 `props.useInput()` 原先在 `if (!room) return` 之后调用：首帧没有 Room 数据时不调用，数据到达后多出一个 hook → React error #310（Rendered more hooks than during the previous render），slot 将 dock 标为 inactive 并整块消失。
- 把 `useInput` 移到与 `useConversation` 相同的无条件顶部区域；版本标记 0.1.0-dev.39 用于确认 bundle。
## 0.1.0-dev.40（彻底移除 RoomDock 内的标准 hook，定位 #310 残留）

- RoomDock 不再调用 `useConversation` / `useInput` 等标准 hook（自动切 View 与 @补全面板暂时移除，保留可点击 chip）；
- 覆盖层恢复为默认关闭，先验证成员条本身稳定；点「替换 Chat（实验）」再测试覆盖层；
- 版本标记 0.1.0-dev.40。
## 0.1.0-dev.41（Room 覆盖层改到 frame-level shell.overlay）

- 根因：`conversation.composer.dock` 在 docked composer 内部，fixed 覆盖层被裁剪，只剩一条横线；slot 文档也要求 fixed overlays portal 到 document.body。
- 修复：RoomDock 只通过 `roomOverlayStore` 发布显示意图；新增 `shell.overlay` occupant `fleet-room-overlay` 渲染 RoomOverlayStream（frame-wide 层，不会被 composer 裁剪）。
- 覆盖层仍是实验开关，成员条可「替换 Chat（实验）」/「恢复 Chat」。
## 0.1.0-dev.42（覆盖层融入 Chat 列，去掉卡片感）

- 覆盖层几何改用 RoomDock 实测的输入框 dock rect：left/width 对齐对话列，top 42、bottom 92，铺满 Chat 内容区；
- 去掉 border/圆角/阴影/外边距，背景使用主背景色，视觉上像 Conversation View 而不是浮层；
- 覆盖层标题从“Room 对话”改为“房间”；smoke 同步。
## 0.1.0-dev.43（覆盖层按真实对话滚动容器测量）

- dock 自身矩形偏窄，导致覆盖层只盖住中右部分；改为从 dock 向上找到第一个大型 scroll 容器（Chat 消息视口），用它 left/top/width/height 定位；
- 覆盖层使用真实视口尺寸，不再出现左侧 Chat 露出、只覆盖一条窄区的问题。
## 0.1.0-dev.44（覆盖层止于输入框上方）

- 实测对话视口高度包含输入框，覆盖层把 composer 一起盖住了；改为从 dock 祖先里查询 textarea/contenteditable，取其 top 作为 composerTop，覆盖层高度 = composerTop - column.top - 10；
- 找不到输入框时回退 height-8。
## 0.1.0-dev.45（覆盖层高度硬约束，保证输入框可见）

- composerTop 多路探测：祖先矩形 + 全局 textarea/contenteditable（取视口下半部顶部最小者）；
- 无法测量时高度回退 height-150；
- 最终硬 clamp：height 不超过 window.innerHeight - top - 160，任何测量错误都不会盖住输入框；
- 覆盖层右下加 9px 低透明度 geom 调试文本（top/h/vh），便于用户截图定位几何。
## 0.1.0-dev.47（移除覆盖层残留 + 精简底部 Room 条）

- 移除 Room 覆盖层注册与“替换 Chat”实验（原生「房间」Conversation View 才是房间界面）；
- 底部 dock 只保留 `Room · N 名成员 · 在上方「房间」Tab 中交流`，去掉 @host/@worker-c 两个成员标志与版本号；
- 研究结论：A) View 选择是 per-session persisted conversation store（`{draft,view,viewRequest}`），`openView/selectView` 只在 Conversation owner 内部暴露；B) @补全的正确位置是 `conversation.input.overlay`（slash-menu/command-popup 同层），不是 composer.dock。
## 0.1.0-dev.48（@补全落到 conversation.input.overlay）

- 新增 RoomMentionOverlay，注册到 `conversation.input.overlay`（与 slash-menu/command-popup 同层），在输入框卡片内部浮出成员列表；
- 输入 `@` + 已输入名字片段时，列出当前 Room 成员，点击插入 `@name`（优先 inputActions，回退 execCommand）；
- 底部 dock 不再承载成员 chip；smoke 覆盖 mention overlay 渲染。
## 0.1.0-dev.49（InputState 诊断）

- RoomMentionOverlay 仍注册在 `conversation.input.overlay`；
- 临时把真实 InputState 的 keys / draft / 样本通过 `/device-fleet/room/focus` 上报到 Host，经 `/device-fleet/overview` 的 clientDebug 读取，用于确认草稿字段结构后再修 @ 解析；
- 无 UI 变化。
## 0.1.0-dev.50（agent 名称并入 DSH 原生 @补全）

- 不再自绘第二个 @ 浮层；改为包装 Host `fileReferences.list`：Room host session 的成员名作为候选合并到原生 `@` 文件补全列表最前面（path=成员名，kind=file），由 DSH 自己的补全 UI 渲染和插入；
- 非 Room 会话不影响，仍只返回文件候选；文件候选去重并限制 20 条；
- client 侧移除 mention overlay 注册。
## 0.1.0-dev.51（自定义 @ 补全 portal 到 body，压在系统补全上方）

- 撤掉把成员名塞进 fileReferences 候选的做法（会出现文件图标）；
- 恢复 RoomMentionOverlay 并 `ReactDOM.createPortal(panel, document.body)`：z-index 2147483000，自绘成员补全 UI（头像/名字/host 标记）显示在系统补全上方；
- 位置由 composer.input.overlay 内的锚点测量，固定定位在输入框上方；
- ReactDOM 不可用时回退 inline，不阻塞 client entry。
## 0.1.0-dev.52（Room 成员补全作为原生文件补全的顶部一段）

- RoomMentionOverlay 改为**一个合并面板**：顶部是 Room 成员（头像/名字/host 标记），下面接 Host `/device-fleet/file-refs` 返回的文件候选，视觉上就是“在系统文件补全上方接了一段”；
- 面板 portal 到 body，并在可见期间隐藏原生「文件与文件夹」弹窗，避免两层弹窗叠加；关闭后恢复原生弹窗；
- Host 新增 `/device-fleet/file-refs`，通过 fileReferences 服务按 session Agent 查询文件候选。
## 0.1.0-dev.53（合并补全稳定性）

- 只有 ReactDOM.createPortal 可用时才隐藏原生文件弹窗，避免 portal 不可用时把系统补全隐藏而自己的面板也不可见；
- 面板改为“成员段 + 文件候选段”的单一列表（文件候选由 `/device-fleet/file-refs` 提供），定位改用全局 composer input 测量。
## 0.1.0-dev.54（成员补全接在原生文件补全上方）

- 原生「文件与文件夹」弹窗保持原样显示；
- RoomMentionOverlay 每 200ms 测量原生弹窗 rect，在当前会话出现 `@` 时把成员补全面板定位到原生弹窗**正上方**（同 left/width，底边贴住其 top），两段列表连成一条；
- 移除“隐藏原生弹窗/合并文件候选”的做法；成员段点击插入 @name。
## 0.1.0-dev.55（成员补全面板与原生补全无缝衔接）

- 读取原生「文件与文件夹」弹窗的 computed style（背景/文字/边框色/圆角/阴影），成员面板复用同一套样式；
- 面板底边与原生顶部重叠 = 原生圆角半径（至少 8px），上面板下圆角为 0，遮住原生顶部圆角，两段列表形成连续表面；
- 去掉上面板的下边框，避免接缝出现双线；位置/宽度继续跟随原生 rect。
## 0.1.0-dev.56（成员面板宽度/接缝/背景修正）

- 原生弹窗测量改为“按标签文本找到所有祖先，取宽度最小且可见的面板”，避免量到全屏 wrapper 导致成员面板铺满窗口；
- 成员面板加 box-sizing: border-box，宽度与原生 rect 严格一致；
- 背景恢复为插件自己的不透明 `--dsw-alias-bg-overlay`（不再复制原生 computed background，之前变成了透明）；
- 保留读取原生边框色/圆角/阴影，底边继续重叠原生圆角。
## 0.1.0-dev.57（修复接缝方向：面板底边应压住原生顶部）

- 之前 bottom = innerHeight - native.top + overlap 把成员面板放在原生弹窗上方 overlap px，留下缝隙和直角；改为 - overlap，使面板底边落到原生顶部之下，盖住原生圆角；
- 接缝处不再露出直角/背景缝。
## 0.1.0-dev.58（接缝不遮挡 + 圆角缺口填充）

- 成员面板底边与原生弹窗顶边**相切不重叠**，不再遮挡原生列表；
- 在两块面板之间的接缝处加一条同背景、同左右边框的 connector 条（高 2×圆角半径）填充两侧圆角缺口，使外轮廓连续，不露直角也不留缝。
## 0.1.0-dev.59（诊断原生弹窗 DOM 位置）

- 在 @ token 激活时把「文件与文件夹」标签的 14 级祖先（tag/class/rect/position/z-index/background/radius）和 body 直接子节点上报到 Host clientDebug，用于精确确认原生弹窗容器与坐标，再据此定位成员面板。
## 0.1.0-dev.60（DOM 位置诊断修正）

- 诊断 effect 不再依赖 mention（避免 TDZ）；组件挂载后每 800ms 检查「文件与文件夹」标签，首次出现时上报 14 级祖先与 body 子节点坐标，用于精确对齐原生弹窗。
## 0.1.0-dev.61（按真实 DOM 定位原生弹窗）

- 诊断确认原生补全容器：`_surface_1w4el_1 pc3rQa_menu`（position absolute, z-index 100, radius 16, left 885/top 860/width 1064/height 400）；内部 `pc3rQa_viewport` 才是列表视口；
- 测量改为选“有背景/圆角/阴影且高度最大的祖先”，即外层 menu，而不是内层 title/viewport；
- 成员面板仅在原生弹窗存在时显示，切 View 时跟随消失（不再悬停残影、出现时机一致）；
- connector 的 z-index 降到 50（原生为 100），只填圆角缺口、不盖住原生标题和内容。
## 0.1.0-dev.62（两块独立圆角面板 + 小间隙）

- 按需求改为：成员补全是一块完整的圆角矩形（四角同半径），放在原生文件补全弹窗上方，二者之间保留 8px 间隙，互不接触/不遮挡；
- 移除 connector 与任何重叠逻辑；面板仅在原生弹窗存在时出现，随其消失；
- 宽度/左边继续对齐原生外层 menu（pc3rQa_menu）。
## 0.1.0-dev.63（P0 清理：移除临时诊断与废弃覆盖层）

- 删除废弃的 Room Chat 覆盖层组件/几何测量（RoomOverlayBoundary/Stream/Host、conversationColumnRect、composerTopFor、composerInputRect、roomOverlayStore、mountedRoomViews/notify）；
- 删除 Host clientDebug 通道与 `/device-fleet/file-refs` 代理路由（@补全已改为独立面板，不再需要）；
- 删除 smoke 中对已移除组件的断言；client-smoke 保留 8 槽位、Room View/Dock/Mention 渲染检查；
- scripts 目录只保留 client-smoke.mjs 与 repair-session-logs.mjs；Host 19/19、net 10/10、client smoke 通过。
## 0.1.0-dev.64（P1：远程 Room 参与者 MVP）

- RoomService 支持 `kind: 'remote'` 成员：`addRemoteMember({roomId, deviceId, name})`、`recordRemoteReply()`，成员摘要带 deviceId；
- 新增 `RemoteRoomBridge`：Room 发消息给 remote 成员时，通过现有 `fleet.delegate` RPC 把文本委派到目标设备 agent，返回文本作为该成员回复写回 Room transcript，并唤醒本机 local participants；
- 新工具 `room_add_remote({roomId, deviceId, name})`，要求 device 已连接（peer-offline 快速失败）；
- Host 测试新增 remote 成员发送/回复用例（20/20），net 10/10，client smoke 通过；
- 限制：远程回复仍是 one-shot delegation（复用会话上下文未做）、远端不能主动写 Board、无 UI 添加入口；需目标设备升级到 dev.64。
## 0.1.0-dev.65（远程联调发现的两个修复）

- 实测 B 通过 Remote 工具在 A 上 `room_create` + `room_add_remote` 成功；随后 A→B Room 消息经 fleet.delegate 返回并在 2.2s 内写回 transcript（B 回复带 `[reasoning]` 前缀）；
- 修复 1：`room_create` 若来自隐藏 Execution Slot（远程调用上下文）则返回 `room-create-local-only`，避免创建用户无法打开的隐藏 host Room；
- 修复 2：delegation 结果只拼接 text blocks，不再把 reasoning 渲染成 `[reasoning]`；
- Host 测试 21/21（新增 remote room_create 守卫用例），net 10/10，client smoke 通过。
## 0.1.0-dev.66（Room 内邀请已连接设备 + 澄清隐藏 Room）

- Room 视图头部新增「邀请设备」：列出当前已连接设备，点击后调用 `/device-fleet/room/add-remote` 把该设备作为 remote member 加入**当前** Room；
- Room 成员显示 `（remote）` 标记；
- ui-web 新增 `/device-fleet/room/add-remote` 路由（routes 13，测试同步）。
## 0.1.0-dev.67（P1：持久远端 Room 参与者）

- 新增 `RemoteRoomPeer`（目标设备侧）：`room.join` 创建并保留真实 participant 会话/agent；`room.wake` 把 Host 消息注入该持久会话；监听绑定会话的 assistant/message，通过 `room.reply` 把回复发回 Host；
- `RemoteRoomBridge`（Host 侧）：添加 remote 成员时调用 `room.join` 记录 `remoteSessionId`；发送消息时优先 `room.wake` 持久路径，老的 remote 成员会在首次发送时自动 join 升级；`room.reply` 写回 transcript 并唤醒本机参与者；B 旧版本时回退 one-shot delegation；
- RoomService 新增 `setRemoteSessionId`，成员摘要带 `remoteSessionId`；Host 测试 23/23（peer join/wake/reply 与 bridge 持久路径）。
## 0.1.0-dev.68（连接握手诊断）

- `/device-fleet/overview` 新增 `warnings`（内存最近 20 条网络 warning，含 code/message/时间），用于定位 B 侧 `handshake-closed` 的真实原因（身份/roster/账号/fleet/版本）；
- 不影响正常连接行为。
## 0.1.0-dev.69（修复持久远端回复的目标设备 + 防 agent 循环）

- 修复 B 侧 RemoteRoomPeer：`room.join/room.wake` 现在接收 RPC 的 `hostDeviceId`（A 的 deviceId），不再把 B 自己的 deviceId 当成回复目标；`room.reply` 才能真正发回 A；
- 旧 binding 会在下次 wake 时被修正 hostDeviceId；
- RoomService.recordRemoteReply 默认只发给原始发送者（用户消息则发给 host），不再广播唤醒所有本地参与者，避免 worker-c ↔ B 自动循环回复；
- RemoteRoomBridge 记录每条远程消息的 replyTo，room.reply 只唤醒该目标；
- Host 测试 23/23。
## 0.1.0-dev.70（远端/本地参与者会话可见性）

- RemoteRoomPeer.join 创建 B 侧真实 session 后调用 `sessionController.rename`，标题为 `Room <短id> · <name> (remote)`，让 B 的会话列表中能看到它（它是普通 DSH session，不是隐藏 Execution Slot）；
- RoomService.addLocalParticipant 同样把 worker 会话重命名为 `Room <短id> · <name>`，便于在 A 的会话列表中识别；
- 仍然不是“B 上的 Room host”：Room 权威状态在 A，B 的会话只是被远程唤醒的 participant。
## 0.1.0-dev.71（A 权威 + B Room 镜像，session 级成员）

- 远端成员改为 session 级：`remote:<device>:<session>`；同一设备的多个 agent/subagent 可各自加入同一个 Room；
- B 侧 `room.join` 创建真实 session 后调用 A `room.snapshot`，并在 B 的 RoomService 中创建 **mirror Room**（`mirror: {deviceId, roomId}`），使 B 的该 session 出现「房间」View/成员/消息/看板；
- B 镜像的发送通过 `room.send` RPC 代理到 A 权威；B 的 `GET /device-fleet/room` 对 mirror 会拉取 A 最新 snapshot 再渲染；
- B 的 Chat 视图仍是与该 participant agent 的私聊，Room 视图是同一个共享 Room；
- 同一个 B 设备可对同一 Room 多次 `room.join`/`room_add_remote` 创建多个 session 成员（多个 agent 真参与）；
- Host 测试 24/24（含 mirror create/apply/proxy-send 用例）。
## 0.1.0-dev.72（远端回复改为同步等待 + 镜像自同步）

- B 侧 `room.wake` 不再依赖 headless session 的 assistant 事件转发：调用 `sessionController.wait({afterSeq, timeoutMs})` 等待本轮结束并抓取最后一条 assistant text，再通过 `room.reply` 回 A；事件转发仅在无 wait API 的旧 DSH 上作为 fallback；
- A 侧 wake RPC 超时提升到 120s，以覆盖远端 agent 完整一轮；
- `room.sync`：A 加入 remote 成员后把完整 snapshot 推给 B 镜像，B 的成员列表会包含自己；
- 测试 24/24。
## 0.1.0-dev.73（远端回复等待竞态 + 镜像自愈/推送）

- B 侧 wake 在 followup 后先轮询 state（active/running/queue）再 wait，避免 wait 在 turn 激活前看到 idle 立即返回导致“Chat 有回复但 Room 没收到的”问题；无输出时重试最多 8 次；
- B 侧 wake 发现本地 mirror Room 缺失（进程重启/升级后）会重新 ensureMirror 拉取 A snapshot；
- A 侧新增 `RemoteRoomBridge.syncMirrors(roomId)`：记录 remote reply 后把最新 Room snapshot 推给所有远端 mirror session，B 的 Room view 无需等下一次轮询即可看到回复；
- 测试 24/24。
## 0.1.0-dev.74（用 Session Observer 转发远端回复，恢复私聊隐私）

- B 侧 per-session 使用 `sessionController.observeEvent(address)` 持久监听 participant session 的 assistant 消息；这是可靠的 headless 路径，不依赖 UI/事件总线；
- 只有存在 `pendingReplies`（Room wake 引发的回复）时才转发 `room.reply`，B 用户在该 session 的私聊回复不会被泄露到 Room；
- wake 不再同步等待，立即返回；A 侧记录 reply 后 `syncMirrors` 推送 snapshot 给 B 镜像；
- B 的 mirror room 不再执行本地 assistant→Room 镜像写入，避免重复消息；
- 无 observeEvent 的旧 DSH 上回退到 wait/event 方式；测试 24/24。
## 0.1.0-dev.75（后台 wait 长轮询抓远端回复）

- 放弃 observeEvent 方案（本地 Host 调用 stream Remote 方法形态不稳定）；
- B 侧 wake 设置 pendingReplies 后立即返回，后台 `replyWhenReady` 每 10s 调一次 `sessionController.wait({afterSeq})` 长轮询直到出现 assistant text，再 `room.reply` 回 A，最多 180s；
- 修正 pendingReplies 重复计数；无 wait API 时回退事件转发；
- 这样 B 的 Chat 正常开始 turn 后，即使激活发生在 wake 返回之后也能抓到回复；测试 24/24。
## 0.1.0-dev.76（远端 Agent 的显式 Room 通道 room_reply）

- 新增工具 `room_reply({text})`：B 的 participant session 里的 agent 直接把回复作为自己的 Room 发言发给 A 权威（`room.reply` RPC），不再依赖“截获 Chat 输出再转发”；
- wake prompt 明确要求 agent 用 `room_reply` 回复；工具有 `pendingReplies` 防护，只在 Room wake 上下文可用，私聊不会泄露；
- 后台 wait 作为 fallback，若 agent 没调用工具仍会抓最终 assistant 文本；
- 这也回答了“B 为什么不像在 Room 发话”：之前 B 只走 Chat 通道注入+回捞，没有 Room 发言 API；现在有了；
- 测试 24/24。
## 0.1.0-dev.77（mirror Room 持久化修复）

- RoomService.load/persist 保留 `mirror: {deviceId, roomId}` 字段；之前重启后 mirror 标记丢失，导致 B 的 Room view 发送走本地而不是代理回 A；
- 加载条件允许 mirror room 没有本地 host member（mirror 成员来自 A snapshot）；
- 测试 24/24。
## 0.1.0-dev.78（B Room 本地优先 + 远端镜像发送归属 + host 不被唤醒）

- B 的 mirror Room 详情改为本地优先：立即返回本地持久化 snapshot，后台并发合并刷新 A 权威；B 的 Room 打开不再等待 RPC；
- A 的 room.send 对来自 B mirror 的发送按调用设备归属到 B 的 remote 成员，不再显示成 A 的 host user；
- RoomService.send 永远跳过 host 成员，避免 `[Room] user: ...` 注入 host Chat；
- A 的 host 用户消息/Room UI 发送后主动 syncMirrors 推送 B 镜像；
- 测试 24/24。
## 0.1.0-dev.79（Room 加法模型：只发布明确的 Room 回复）

- 取消 B 侧 assistant 输出自动回捞：Room 发言只能通过 `room_reply` 工具显式发布；
- `room_reply` 仅在存在 Room wake 标记（pendingReplies）的轮次可用，私聊轮次调用会被拒绝（`not-a-room-turn`）——这就是“检测消息是否从 Room 发起”的实现；
- B 的私聊 Chat 不再有任何自动写入 Room 的路径；
- A host 的 assistant 回复也只在 Room 视图聚焦时镜像进 Room，普通 Chat 保持私密；
- B Room 本地优先加载（dev.78）一并生效；测试 24/24。
## 0.1.0-dev.80（修复命名 session 被路由到同房间其他 session）

- B 的 room.wake 在指定 sessionId 但本地 binding 缺失时，不再回退到“房间里的第一个 session”（dev.79 实测中导致 B-agent2 的唤醒被送进 B 的 session，并把它自己的 remoteSessionId 覆盖成 B 的 session）；
- 命名 session 只允许绑定该 session，绑定失败则创建新的 participant session 并由 Host 更新 remoteSessionId；
- 无 sessionId 的 legacy wake 才使用房间首 session 回退；测试 24/24。
## 0.1.0-dev.81（重启后从持久 mirror 恢复 binding）

- 新增 `RemoteRoomPeer.hydrateFromRooms(rooms)`：进程重启后扫描本机持久化的 mirror Room（roomId=本地 participant sessionId，mirror={deviceId,roomId}），重建 bindings/roomSessions/sessionRooms；
- wake 时若 binding 的 agent 尚未解析，按 sessionId `resolveAgent` 恢复；session 已不存在才淘汰并创建新 participant session；
- 这样重启后不再依赖第一条 wake 才绑定，也不会因为 binding 缺失而走错 session；
- 测试 24/24。
## 0.1.0-dev.82（Room 成员可见性：给所有参与者 room_members）

- 新增 `room_members` 工具：所有 Room 参与者（host/local participant/remote participant）都能列出成员；省略 roomId 时按当前 session 解析（本地成员遍历 RoomService，remote 成员走 binding 拉 A snapshot）；
- Room wake prompt 增加成员 roster：本地/远端参与者被唤醒时直接看到 `Room members: host, worker-c, B, ...`；
- 远端成员的 binding 提供 `membersForSession` 拉权威成员列表；
- 测试 24/24。
## 0.1.0-dev.83（room_members 可选参数 schema 修复）

- dev.82 的 `room_members` 工具把 `required:false` 写进参数 schema，Host 校验失败导致整个插件未激活；改为省略 required（可选参数）；
- 其余同 dev.82：room_members、wake roster、远端成员查询。
## 0.1.0-dev.84（Room 级稳定头像）

- RoomService 在成员创建/加载时分配 `avatarKey`（由 memberId 稳定哈希到内置头像），memberSummary/snapshot 携带；mirror 从 A snapshot 原样获得；
- 客户端 Room 成员头像改为 `member.avatarKey`（缺省用 memberId 哈希 fallback），不再依赖查看设备的 avatarOffset/本地头像库索引；
- 因此在 A 和 B 上，同一个 Room 成员显示同一个头像；移除 Room 头部「换头像」（该功能会破坏跨设备一致性，后续若做 Room 级头像选择应持久化到 Room 成员并同步图片数据）；
- 测试 24/24、client smoke 通过。
## 0.1.0-dev.85（Phase 1：本地 Room Replica + 旧数据迁移）

- 新增 `RoomReplicaStore`（`src/host/room-replica.js`）：每设备每 Room 一份 `rooms/<roomId>/events.jsonl` + `snapshot.json`，版本化事件信封（v/id/roomId/seq/type/author/payload/prev/signature 占位）；
- `room-index.json` 账号级 Room 索引；`session-members.json` 设备内 session↔member 映射；
- 插件启动时把旧 `rooms.json` 一次性、幂等迁移为事件日志（room.created/member.joined/message/task.added/room.closed），并保留旧文件；
- RoomService 写路径改为 write-through：房间/成员/消息/任务/远程回复/镜像/关闭都会追加副本事件；
- A 侧 authority Room 的 `/device-fleet/room` 读取切换到本地副本；B mirror 读取仍走原本地优先路径（Phase 2 再统一切换）；
- 新增单测：事件重放/重启恢复/session 绑定/旧数据幂等迁移/RoomService 写事件；Host 27/27。
## 0.1.0-dev.86（Phase 1 收尾：迁移快照与标题）

- 迁移完成后为每个 Room 生成 `snapshot.json`；
- 修正迁移生成的 Room 标题（去掉 session- 前缀再截断）；
- A 侧 authority Room 的 `/device-fleet/room` 已从副本读取，实测 49 条消息/4 成员/1 任务与旧 rooms.json 完全一致；
- 测试 27/27、net 10/10、client smoke 通过。
## 0.1.0-dev.87（Phase 2：副本事件同步协议）

- 事件增加 `origin/originSeq`（按作者设备），支持跨设备 vector clock；
- `RoomReplicaStore` 新增 `vectorClock/eventsMissingFor/importEvents`；导入保留原 eventId/origin/originSeq，本地重排 seq；
- 新增 `RoomReplicaSync` 与 RPC `room.sync.hello/pull/push`：并行探测可达成员，选 vector clock 最领先者拉取，再回推本地缺失事件；对端无副本时也可首推建立副本；
- B 的 mirror Room 打开时后台执行 authority → mirror 的事件拉取（remap roomId），Room 视图改为从 mirror 副本读取；
- 单测新增双向同步收敛用例；Host 29/29、net 10/10、client smoke 通过；
- 同时包含 dev.86 热修复：config/state 读取容忍 UTF-8 BOM；direct listener close 会销毁残留 socket（避免插件重载后端口占用）。
## 0.1.0-dev.88（Phase 2 同步工具与 mirror 落地）

- 新增 `room_sync` 工具：按当前 session/mirror 解析 Room，手动触发副本同步，返回 imported/pulled/pushed/messages/seq；
- B 的 mirror 同步在导入事件后把 replica state 应用到 RoomService mirror，使现有 room_messages/room_status 与 UI 都可见同步结果；
- Host 工具列表更新；测试 29/29。
## 0.1.0-dev.89（Phase 2b：legacy bootstrap + 自动同步触发）

- B mirror 在事件拉取后用 `room.snapshot` 一次性 bootstrap 旧历史（legacy 事件不参与 vector clock，A/B 可能差一条旧消息）；
- `room.wake` 处理完后自动触发该 participant session 的 mirror 副本同步；
- B 从 mirror Room 发送后自动触发同步；
- `room_sync` mirror 结果包含 bootstrap 导入计数；测试 29/29。
## 0.1.0-dev.90（Phase 3：mirror 本地写入 + Brief 任务 + agent scoped 消息）

- B mirror Room 发送改为本地优先：`appendMirrorMessage` 先写本地副本/RoomService 并 emit 事件，再异步 `room.sync.push` 给 A；失败由下次 sync 重试；
- A 收到 `room.sync.push` 后 `applyExternalEvents` 把导入消息应用到权威 RoomService（含唤醒被点名本地成员）；
- B mirror sync 会回推本地未确认事件；
- Participant Brief 增加“分配给该成员的 Task”列表（本地 wake 与远端 room.wake）；
- `room_messages` 对 participant agent 做 scoped 过滤：只看发给它/由它发送的消息；host/User 视角仍看全部；
- 新增 mirror 本地写入单测；Host 30/30、net 10/10、client smoke 通过。
## 0.1.0-dev.91（Phase 3 修复：快照事件不得跨设备同步）

- `room.snapshot`/bootstrap 事件标记 `localOnly`，`eventsMissingFor` 与 `importEvents` 均跳过；避免 B 的 legacy bootstrap snapshot 推到 A 权威副本、覆盖 A 的消息历史（实测 A 消息数曾从 57 降到 54）；
- 新增 `repairForeignBootstrapSnapshots`：A 启动时若发现权威副本尾部是来自外设备的 legacy bootstrap snapshot，则用 RoomService 当前 detail 追加一条 local-only 权威修复快照；
- mirror 本地写入 + push 已真机验证：B 的 `B LOCAL-FIRST WRITE TEST 90` 先出现在 B 本地，再通过 push 出现在 A；
- Host 30/30、net 10/10、client smoke 通过。
## 0.1.0-dev.92（Phase 3：任务/成员/策略外部事件应用）

- `applyExternalEvents` 扩展：task.added/updated（task 级 LWW，updatedAt 新者胜）、member.joined/left、policy.updated（updatedAt LWW）；
- mirror Room 的 task 创建/更新在 emit 后通过 `publishMirrorEvent` 异步 push 给权威；
- 新增外部事件 LWW 单测；Host 31/31、net 10/10、client smoke 通过；
- 成员/策略的 mirror 本地写工具入口仍是下一步（本次先打通 task 本地写入与权威应用）。
## 0.1.0-dev.93（Phase 3：成员/策略 mirror 入口 + 字段级 Task CRDT）

- 新增 `room_policy_update` 工具与 `RoomService.updatePolicy`：写 policy.updated 事件，mirror 上自动 push 权威；A 用 updatedAt LWW 应用；
- `removeMember`、`addRemoteMember`、`addLocalParticipant` 的 member 事件在 mirror 上通过 `publishMirrorEvent` push；
- Task 改为字段级 LWW：task 带 `fieldVersions`（title/description/owner/status/dependsOn/note），外部 task 事件按字段合并，冲突用 at + by 决胜；`updateTask` 只更新变更字段的版本；
- A `applyExternalEvents` 支持 member/policy/task 字段级应用；Host 31/31、net 10/10、client smoke 通过。
## 0.1.0-dev.94（room_policy_update schema 修复）

- dev.93 的 `room_policy_update` 参数 schema 对 object 未声明 `additionalProperties`，Host 校验失败导致插件未激活；已显式设为 true；
- 其余同 dev.93（字段级 Task CRDT、policy/member mirror 写入口）。
## 0.1.0-dev.95（Phase 3：字段级 Task 在副本重放中合并 + 可等待监听关闭）

- `RoomReplicaStore.state` 对 task.added/updated 使用字段级 LWW 合并（之前重放是整 task 后写覆盖，导致 A 的 status=done 被 B 的 note 事件回退为 running）；现在字段合并与 RoomService 一致；
- 插件 dispose 返回 `node.close()` promise，加载器会等待旧 direct listener 关闭后再激活新实例，避免端口被旧实例占用与 B 连到旧版本节点；
- 真机已验证：B mirror 创建 task + 更新 status + policy maxMembers=9 + 移除 B-agent2，A 权威都正确应用；字段级 status/note 合并修复；
- Host 31/31、net 10/10、client smoke 通过。
## 0.1.0-dev.96（Phase 4：Room Invite/key、关闭广播、离开、唤醒幂等）

- Room 创建时生成 room key 并持久化；invite 工具 `room_invite_create` / `room_invite_accept`（base64url JSON：roomId/key/deviceId/exp）；
- A 新增 RPC `room.invite.accept` 校验 key 后添加 remote member；B 先 `room.join` 创建 participant session/mirror，再让 A 添加成员；
- 成员移除时轮换 room key；
- `RoomService.close` 通过 `onClosed` → `RemoteRoomBridge.notifyClosed` 向远端 mirror 发送 `room.closed`，B 清理 mirror/local replica（`RoomReplicaStore.removeReplica`）；
- 新增 `room_leave` 工具（非 host 移除自己，host 关闭 Room）；
- B 的 `RemoteRoomPeer.wake` 按 `roomId:messageId` 去重，避免重复通知重复唤醒；
- 新增 invite/key rotation 与 wake dedupe 单测；Host 33/33、net 10/10、client smoke 通过。
## 0.1.0-dev.97（Phase 4：room_leave 后清理本地 mirror）

- `room_leave` 在 mirror 上移除自己后，若已无本地成员则 `rooms.close`；插件 `onClosed` 对 mirror 释放 peer binding + 删除本地 replica，避免离开后残留 Room；
- `RemoteRoomPeer.releaseSession(sessionId)` 精确释放单个 participant session；
- 真机验证 invite：A 生成 invite → B `room_invite_accept` 加入（A 成员 5，B 新 mirror 同步出 B-invite），B `room_leave` 后 A/B 成员均回到 4；
- 已知：B 新 mirror 在 bootstrap snapshot 与事件重放重叠时消息计数偏高（77 vs A 64），待下一步修 snapshot/event 去重；Host 33/33、net 10/10、client smoke 通过。
## 0.1.0-dev.98（修复 bootstrap snapshot 与事件重放的消息重复）

- `RoomReplicaStore.state` 应用 `room.snapshot` 后用 snapshot 的 message id 重置去重集合；后续重放的事件不会再追加 snapshot 已有的消息（B 新 mirror 曾出现 77 条 vs A 64 条）；
- 其余同 dev.97（invite/leave 清理、room key、wake 去重）；Host 33/33、net 10/10、client smoke 通过。
## 0.1.0-dev.99（Phase 4：leave 清理修复、外部移除轮换 key、孤儿 mirror 启动清理）

- `room_leave` 在 mirror 上无条件关闭本地 mirror（原先用 kind=local 判断，B mirror 里 A 成员也是 local，导致不关闭）；
- 外部 `member.left` 应用到权威时，若移除的是 remote 成员则轮换 room key（之前只有 A 本地 removeMember 轮换；B 发起 leave 后旧 invite 仍有效）；
- 启动时清理“无本地 participant”的孤儿 mirror（之前 leave 残留的 B mirror）；
- 新增外部移除 key rotation 单测；Host 34/34、net 10/10、client smoke 通过。
## 0.1.0-dev.100（Phase 4 收尾：事件签名、同步成员校验、设备移除级联、关闭通知测试）

- `room-signing.js`：Ed25519 设备私钥签名 Room 事件（canonical JSON，排除 signature），peer 用 roster 公钥验证；新事件签名，历史无签名事件按 legacy 接受；
- `RoomReplicaStore` 注入 `signEvent/verifyEvent`，导入时丢弃签名无效的远程事件；
- `room.sync.hello/pull/push` 增加成员校验：调用 device 必须是该 Room 成员（或 mirror 的 authority device），否则 `unauthorized`；
- 新增 `room_remove_device` 工具与 `removeDeviceMembers`：移除某设备全部成员 + 轮换 key；
- 新增事件签名/篡改拒绝、设备移除级联、room.closed 通知单测；Host 36/36、net 10/10、client smoke 通过。
## 1.0.0（Room Replica 稳定版）

- Phase 1–4 完成：本地复制/存储、事件同步、本地写入与字段级 CRDT、Invite/key、leave/close 生命周期、事件签名与同步成员校验、唤醒幂等、设备移除级联；
- 真机双设备（desktop-ui ↔ laptop）验证：消息/任务/策略/成员 CRDT、invite 加入/离开、mirror 清理、key 轮换；
- 已知限制：三台以上设备未覆盖；同步 pending/冲突 UI 未做；历史坏 snapshot 仍在 append-only 日志（已 local-only + 修复快照覆盖），compaction 留待 Phase 6；旧 Host/Mirror 桥保留为兼容层。
## 1.0.1（修复 RoomReplicaStore 未接收 signEvent/verifyEvent）

- 1.0.0 的 `RoomReplicaStore` 构造函数解构缺少 `signEvent`/`verifyEvent`，`typeof` 未声明变量恒为 undefined，导致新事件实际未签名（真机冒烟发现 B 推送事件 signature=false）；
- 补上构造参数并在 store 内签名/校验；新增 store 签名与坏签名拒绝单测；Host 37/37、net 10/10、client smoke 通过；
- 历史未签名事件继续按 legacy 接受，新事件签名。
## 1.0.2（修复签名与 roomId remap 冲突）

- 真机发现 B 推送事件在 mirror 本地 roomId 上签名后，被 remap 到 authority roomId，签名随即失效，A 丢弃该事件（B reply 不落 A）；
- `RoomReplicaStore.importEvents(roomId, events, {sourceRoomId})` 在验证签名时使用原始 roomId，验证后再映射到本地 roomId；
- mirror 拉取 A 事件时保留原 roomId 验证，再落本地；
- mirror push 前对新 roomId 的事件重新用本机设备密钥签名；
- 新增 remap 签名导入单测；Host 38/38、net 10/10、client smoke 通过。
## 1.0.3（签名 canonical 排除本地 seq/prev）

- 导入事件时 A 会重写 seq/prev，导致按 stored envelope 复验签名失败；真机验证 B 事件 `verified=false`；
- 签名 canonical 排除 `seq`/`prev`（保留 roomId/origin/originSeq/id/type/author/payload/createdAt），跨 mirror remap 后签名仍可用；
- 新增“seq/prev 重写后仍验签通过”单测；Host 39/39、net 10/10、client smoke 通过。
## 1.1.0（Phase 6：同步状态、签名强制、快照压缩）

- Room 详情新增 `sync`：`{role: authority|mirror, pending, lastSeq}`；Client Room 头部显示「副本 · 主设备 / 已同步 / 待同步 N」；
- `RoomReplicaStore` 新增 `requireSigned`：远程导入拒绝无签名事件，关闭“剥离签名”绕过；本地历史事件不受影响；
- 新增 `compactSnapshots`：启动时删除被覆盖的 local-only snapshot 事件并重排本地 seq/prev（签名 canonical 已排除 seq/prev，签名仍有效）；A 历史坏 snapshot 自动清理；
- 新增 compaction / requireSigned 单测；Host 38/38、net 10/10、client smoke 通过。
## 1.2.0（Phase 7：key 校验、OR-Set 依赖、legacy 重签、Invite UI、唤醒补投）

- Room key 交换/校验：authority 在 `room.sync.hello` 对成员返回 roomKey，mirror 保存并在 pull/push 携带；authority 校验 pull/push 的 roomKey（无效返回 unauthorized）；
- Task dependsOn 改为 add-only OR-Set（union，不再字段 LWW）；
- 启动时 `resignLocalEvents` 用当前设备密钥重签本地历史事件；远程导入继续 `requireSigned`；
- 新增 Invite 预检 RPC `room.invite.check`：B 在创建本地 session/mirror **之前**校验 invite，坏邀请不再留下孤儿 mirror；
- Client Room 头部新增「邀请码」按钮：调用 `/device-fleet/room/invite` 并复制邀请码；
- 唤醒补投：RemoteRoomPeer 持久化每个 participant 的 backfill cursor，mirror 同步后对 cursor 之后、未消费的点名消息补 wake；幂等由已消费集合保证；
- 新增 OR-Set 与 backfill 单测；Host 40/40、net 10/10、client smoke 通过。
## 1.3.0（Phase 7a：移除旧 mirror-send 桥、mirror 本地唤醒）

- 删除旧 `room.send` RPC 与 `mirrorSend` 回退路径；mirror 发送不再代理到 Host，完全走本地 replica append + signed event push；
- mirror 本地写入后对**同设备的 participant session** 直接 wake（不再等 Host 唤醒），为无 Host/离线本地协作打基础；
- 无 Authority 时 push 失败只保留 pending，下次 sync 重试；本地 UI/事件日志不受影响；
- Host 40/40、net 10/10、client smoke 通过。## 1.3.1（修复 channel closed 时的 unhandled rejection）

- 1.3.0 移除旧 mirror-send 后，几处后台 fan-out（`syncMirrors`、`mirrorPublish`）以 `void` 启动且无 catch；当 A/B 连接刚关闭（例如 A 插件卸载/重连）时，Fleet RPC 以 `secure channel is closed` reject，未处理拒绝导致 DSH host 退出（B 设备报“应用无法启动或意外停止”）；
- 所有后台 fan-out 加 `.catch`，只记录 warning，不允许击穿 Host 进程；
- Host 40/40、net 10/10、client smoke 通过。
## 1.4.0（Phase 7b–7g：Creator/Coordinator、GC、key 加密、签名 invite、Device UI、性能）

- Creator/Coordinator：Room 记录 `creatorMemberId/creatorDeviceId/coordinatorDeviceId`；新增 `room_coordinator_update` 工具与 `room.coordinator` LWW 事件，RoomService/Replica/持久化/镜像同步均支持；
- 通用 event GC：`RoomReplicaStore.compactEvents` 将事件日志替换为单条带 `baseClock` 的快照，保留状态与 vector clock；启动时 >800 事件自动执行；新增 GC 单测；
- Room key 静态加密：rooms.json 用 fleetKey 派生 AES-256-GCM 加密 key（`keyEnc`），运行时解密；invite 用设备 Ed25519 签名，authority 校验签名；
- Device 移除 UI：新增 `/device-fleet/room/remove-device` 路由 + Room 头部「移除设备」按钮；
- 多副本收敛测试：3 个 RoomReplicaStore 通过 RoomReplicaSync 无 Host 收敛，验证 vector clock/消息一致；
- 性能测试 `test/perf.test.mjs`：2000 事件 append/state/GC 预算；
- Host 43/43、perf 1/1、net 10/10、client smoke 通过。
## 1.5.0（多 Relay 列表 + 自动切换 + 邀请码携带）

- `FleetNode` 支持 `relays` 数组（兼容单 `relay`），为每个 Relay 建立客户端，连接时按顺序尝试，有可用在线 Relay 自动 failover；`status().relay` 返回 `{online, onlineCount, endpoints}`；
- 配置 schema/`RuntimeConfig` 增加 `relays`，保存后 reconfigure 立即生效；
- Fleet Invite 编解码携带 `relays` 列表，入网自动获得；`relay` 单值继续兼容；
- `scripts/relay-server.mjs` + `docs/notes/relay-deployment.md` 支持多 Relay 部署说明；
- 新增多 Relay failover 单测（一个坏 Relay + 一个可用 Relay，成功经可用 Relay 连接）与 invite relays 回环测试；Host 43/43、net 11/11、perf 1/1、client smoke 通过；
- 另修 1.4.0 真机发现的 coordinator 字段未同步到 mirror 的问题（createMirror/applyMirrorSnapshot 复制 creator/coordinator）。
## 1.5.1（修复 mirror 未接收 creator/coordinator 字段）

- 1.5.0 修了 createMirror/applyMirrorSnapshot，但 plugin 构造 mirror snapshot 时只传 createdAt/policy/members/messages/tasks，仍丢 creator/coordinator；
- 两处 applyMirrorSnapshot 调用补齐 creatorMemberId/creatorDeviceId/coordinatorDeviceId/hostSessionId/closed；
- Host 43/43、net 11/11、client smoke 通过。
## 1.6.0（Relay 候选自动广告 + 学习探测）

- 安全通道握手新增 `relayCandidates` 字段（hello/hello.ack 签名内），对端连接后自动学习 Relay 候选；
- `FleetNode` 维护 Relay 候选表（配置 + 学习，最多 8 个），学习到的候选会异步启动 RelayClient 做可达性探测，并加入 failover 顺序；
- `relayCandidateList()` 供邀请码/状态使用；邀请码现在携带“已学习 + 已配置”的 Relay 列表；
- `fleet_status.relay` 增加 `candidates` 数量，connect 时优先在线 Relay；
- 新增 handshake relay 广告/学习单测；Host 43/43、net 12/12、perf 1/1、client smoke 通过。
## 1.7.0（Room/协作核心补齐：mirror 互同步、creator 回填、GC/归档/删除、Fleet 移除、pending 详情）

- signedRoomId：事件记录原签名 logical roomId，跨 mirror 重映射后可复验；本地事件重映射时重签；
- mirror 之间 peer sync：B/C mirror 可互相 hello/pull/push（自动尝试连接其他成员设备），不必只通过 A；
- creator 元数据启动回填：旧 authority Room 自动补 creatorMemberId/creatorDeviceId，并广播 room.creator 事件；
- 新增 `room_archive` / `room_delete` / `room_gc` 工具；`room_delete` 会先关闭 Room（触发 room.closed）再删除本地副本；
- 新增 `fleet_remove_device` 工具与 Room 头部「移除 Fleet 设备」按钮：Fleet roster 删除、断连、级联移除所有 Room 成员、清 peer hints；
- Room 详情 sync 增加 `pendingEvents`，Client badge 的 tooltip 显示 pending 事件类型/origin；
- 新增 3-replica/sync-remap/creator 回填单测；Host 45/45、net 12/12、perf 1/1、client smoke 通过。
## 1.7.1（DSH prerelease 兼容放宽）

- 握手 `dshVersion` 校验从严格全等改为同一 release line：core `major.minor.patch` 相同即允许，忽略 prerelease 后缀（如 `0.2.2-rc.1` ↔ `0.2.2-rc.2`）；
- 插件版本仍严格相等（线协议版本）；跨 patch/minor 的 DSH 仍拒绝；
- 新增 `version-compat.js`，`harnessVersionsCompatible` 单测 + 双节点 rc.1/rc.2 直连测试；
- ADR-0024 更新为“插件严格、DSH 同 release line 允许 prerelease skew”；
- Host 45/45、net 14/14、perf 1/1、client smoke 通过。
## 1.8.0（UI 管理入口、overlay 检测、自动 GC、审计持久化、CI）

- Room UI：归档/取消归档、GC、删除 Room 按钮；pendingEvents 可展开详情；
- Fleet UI：Fleet 邀请码加入输入；设备列表逐台移除；Tailscale/ZeroTier overlay 状态；Relay 列表 JSON 编辑；
- 后端：`/room/archive`、`/room/delete`、`/room/gc`、`/pair/join` 路由；room detail 返回 archived；
- 审批历史写入 `approval-history.jsonl`（onAudit）；
- RoomReplicaStore.autoCompact：启动时按 `DSH_FLEET_AUTO_COMPACT_EVENTS`（默认 800）自动压缩；
- overlay 检测模块（Tailscale/ZeroTier CLI，用户态只读，不内嵌 VPN）；overlay IP 加入本地 endpoints/invite；
- Relay 控制面按 IP 连接数限流（默认 8）；
- 新增 overlay 单测、approval onAudit/autoCompact 单测、`scripts/ci.mjs` 与 CI workflow；
- 测试：net 14/14、host 47/47、overlay 2/2、perf 1/1、client smoke；npm 1.8.0。
- 未完成：3+ 真机/WAN 受限环境、真 P2P 打洞/内置 VPN、权威转移、TLS Relay、TOFU 轮换/吊销。
## 1.8.1（非连接部分补齐：SSE、审批历史加载、Coordinator/自动压缩 UI）

- 新增 `/device-fleet/events` SSE：overview/审批/房间状态每 3 秒推送；Client 优先 EventSource，保留 15 秒轮询兜底；
- 启动时从 `approval-history.jsonl` 加载最近审批历史，重启不丢；
- Room 头部新增「Coordinator」设置按钮；后端 `/room/coordinator` 路由；
- 配置页新增「自动压缩阈值」（`replica.autoCompactMinEvents`），sanitizer/schema 同步；
- 测试：net 14/14、host 47/47、overlay 2/2、perf 1/1、client smoke；路由 22 条；
- 仍未完成（硬缺口）：3+ 真机/WAN、真 P2P/内置 VPN、Room 权威转移、Relay TLS、TOFU 轮换/吊销、i18n/a11y。
## 1.8.2（无 Host 镜像本地唤醒：多 agent 模拟通过）

- Mirror Room `send()` 在 authority 推送失败/离线时仍唤醒本机 local participant（无需 authority RPC）；
- 新增单测：mirror + authority offline + 本地 agent，断言 `woken` 与 followup；
- host 48/48；net 14/14；overlay 2/2；perf 1/1；client smoke；
- 说明：这是“多 agent 模拟”的 hostless 基础能力，真正的 authority 转移/跨设备唤醒路由仍需 3 节点或 LAN 双设备多 session 联调。
## 1.8.3（authority 事件 + epoch + 单主收敛基础）

- RoomService 新增 authority 元数据：authorityDeviceId/authorityRoomId/authorityEpoch，持久化；
- 新事件 `room.authority`：epoch 高者胜；同 epoch 按 deviceId 字典序确定性收敛；低 epoch 忽略；
- `updateAuthority()`：仅当前 authority 可发，epoch 必须递增，广播事件；
- mirror 收到事件后更新 mirror 目标；
- Room UI 新增「Authority」按钮与 `/room/authority` 路由；
- 测试：authority epoch 收敛、host 49/49；
- 仍待：跨设备唤醒路由、旧 authority 回归后的完整降级、签名 roster 轮换。
## 1.8.4（2026-11-14）

- 修复冷启动 `no execution slot`：`apply()` 取不到 `sessionController` 时，首次远程直调重新解析服务并惰性创建 `ExecutionSlot`/`DirectCallHost`；仍为空才返回 `[unsupported] no execution slot`；
- 新增 `src/host/lazy-execution-host.js` 与 host 回归测试；冷启动诊断写入 `$DSH_HOME/device-fleet/diagnostics.jsonl`；
- 测试：net 14/14、host **50/50**、overlay 2/2、perf 1/1、client smoke passed；
- A/B 当前仍 1.8.3；升级时两端同步（ADR-0024）。
## 1.8.5（delegation flat spec、authority 回填/写入拒绝、fleet_run description）

- DSH 0.2.2-rc.3 `ctx.subagents.startActivation()` 改为扁平 spec：`parent/prompt/cwd/agentPreset` 顶层传递；保留旧 `request` 形状 TypeError fallback；
- `fleet_run` 的 run capability 自动补 `description`；
- 旧 authority Room 启动回填 authority 元数据并广播 `room.authority`；
- `send/addTask/updateTask` 在非当前 authority 设备返回 `not-authority`；
- 真机 A/B 1.8.4 已验证 fleet_call/fleet_run/fleet_delegate/Room sync/Room wake；
- 测试：net 14/14、host 51/51、overlay 2/2、perf 1/1、client smoke。
## 1.9.0（跨设备唤醒路由第一阶段 + authority 写入保护）

- mirror `RoomService.send()` 对 remote member 调用 `mirrorWakeRemote`，按成员所属设备路由；
- 新增 RPC `room.wake.member`：校验 Room 成员、只唤醒本机 local participant、按 sender:room:message:member 去重；
- authority 启动回填（authorityDeviceId/authorityRoomId/authorityEpoch）；
- 旧 authority 在 send/addTask/updateTask 返回 `not-authority`；
- delegation flat spec、fleet_run description、fleet_delegate/Room sync/wake 真机已通过；
- 测试：net 14/14、host 52/52、overlay 2/2、perf 1/1、client smoke。
- 仍缺：真正单主选举/旧 authority 自动降级完整流程、签名 roster 密钥轮换、Relay TLS。
## 1.9.1（authority claim、签名 roster 持久化）

- `room_authority_claim` 工具 / `RoomService.claimAuthority`：authority 离线后可声明接管，epoch 递增；旧 authority 继续写入会 `not-authority`；
- roster 持久化增加 HMAC 签名 `roster.sig`；loadState 校验失败时清空 roster（检测篡改/损坏）；`signRoster/verifyRoster` 单测；
- 明确：这只是 roster 防篡改，不是完整设备密钥轮换协议；旧密钥授权新密钥仍待后续；
- 测试：net 14/14、host 54/54、overlay 2/2、perf 1/1、client smoke。
## 1.9.2（creator 账号指纹绑定/持久化）

- 根因：creator 无 enrollment，启动时账号服务未就绪 → accountFingerprint=null；joiner 的 enrollment 非空 → account mismatch。
- `SecureChannel` responder 未绑定时从首个已认证 peer 绑定账号指纹后再发 ack；
- `FleetNode` 新增 `onPeerAccountFingerprint`/`account-bound`；
- 新增 `account.json` 持久化（`saveAccountBinding`），`accountMatches` 同时检查 enrollment 与 account binding；
- A/B 真机恢复：fleet_call/fleet_run/fleet_delegate/room_sync 全部通过；authority 转移/claim/写入拒绝验证（epoch 3）。
- 测试：net 15/15、host 54/54、overlay 2/2、perf 1/1、client smoke。
- 仍缺：真正自动单主选举、签名 roster 的密钥轮换、Relay TLS。
## 1.10.0（设备密钥轮换协议/工具）

- `src/net/rotation.js`：保持 deviceId 的 Ed25519/X25519 轮换，旧私钥签 `device.rotation`，对端用 roster 旧公钥验证后替换；
- `FleetNode.applyRotation` + RPC `fleet.rotation`；
- `fleet_rotate_identity`：所有 connected peer ack 后才切换身份，写 identity.json/identity-rotation.json；任一失败则中止；
- 测试：net 17/17、host 54/54、overlay 2/2、perf 1/1、client smoke；
- 说明：真机轮换尚未执行；自动 authority 选举仍未实现。
## 1.10.1（authority heartbeat + mirror promotion + 自动 promotion timer）

- authority 每 5s 发送 `room.authority.heartbeat`，mirror 记录 `authorityHeartbeatAt`；
- `RoomService.promoteMirrorToAuthority()`：mirror 本地 session 提升为 host，保留 authorityRoomId，epoch+1；
- `room_authority_promote` 工具；
- 自动 promotion timer：heartbeat 超过 15s 且本机为 coordinator 时自动 promote；
- 测试：net 17/17、host 56/56、overlay 2/2、perf 1/1、client smoke；
- 已知缺口：旧 authority 恢复后的自动降级/双主收敛尚未实现。
## 1.10.2（自动 authority promotion + 旧 authority 降级）

- `RoomService.promoteMirrorToAuthority()` / `room_authority_promote`；
- 自动 promotion timer：heartbeat 超过 15s 且本机 coordinator 时 promote；
- `RoomService.downgradeToMirror()`；RPC `room.authority.claim`（sender 成员校验、epoch 必须更高）；
- authority 在 peer 连接时主动发送 claim，让回归的旧 authority 自动降级；
- 测试：net 17/17、host 57/57、overlay 2/2、perf 1/1、client smoke；
- 真机故障切换待 A/B 同步 1.10.2 后验证。
## 1.10.3（authority 事件降级 + claim 保留 authorityRoomId）

- `room.authority` 事件在更高 epoch 且远端 authority 时真正设置 `room.mirror`，不再只更新元数据；
- `claimAuthority` 保留已有 `authorityRoomId`，不再覆盖为本地 room id；
- heartbeat 更新 mirror 的 `authorityEpoch`；
- 测试：net 17/17、host 57/57、overlay 2/2、perf 1/1、client smoke；
- 真机仍出现 split-brain/半降级，自动 election 未验收。

## 1.10.4（工作区，未发版）

- auto promotion 增加 30s 启动宽限期（`promotionReadyAt`）；
- 待办：启动恢复保持 mirror、自动 promotion 硬门禁、回归测试与发布。
## 1.10.4（启动宽限期 + 自动 promotion 硬门禁）

- 自动 promotion timer 增加 30 秒启动宽限期（`promotionReadyAt`）；
- `promoteMirrorToAuthority({ automatic: true })` 必须曾收到 heartbeat、heartbeat 过期超过 15s、本机 coordinator；手动 `room_authority_promote` 不受限；
- 新增测试 `automatic mirror promotion requires a stale heartbeat and local coordinator`；
- CI：net 17/17、host 58/58、overlay 2/2、perf 1/1、client smoke；
- 已发布 `dsh-device-fleet@1.10.4`；A/B 仍 1.10.3，待同步升级后重新做故障切换。
## 1.10.5（promotion claim 广播 + mirror 更高 epoch 更新）

- promotion 成功后向所有 connected peer 主动发 `room.authority.claim`，双 target（authorityRoomId + 本地 Room id）；
- 手动 `room_authority_promote` 同样广播；
- `downgradeToMirror` 不再在已是 mirror 时直接返回，支持更高 epoch 更新 authority/mirror 指向；
- 测试：net 17/17、host 58/58、overlay 2/2、perf 1/1、client smoke；已发布 1.10.5。

## 1.10.6（mirror sync 授权修复 + 真机收敛验收）

- `findSyncRoom` 同时匹配 roomId、mirror.roomId、authorityRoomId；
- `assertSyncPeer` 允许本地设备同步自己的 replica；
- 真机：B epoch6 authority、A mirror epoch6/A 主 Room、A room_sync 成功；fleet_call/run/delegate 回归通过；
- 测试：host 58/58；已发布 1.10.6。
## 1.10.7（room.reply Room 查找修复）

- `recordReply` 同时按 roomId/mirror.roomId/authorityRoomId 查找 promoted authority 的本地 Room；
- 用本地 roomId 记录回复并同步 mirror；
- 测试：host 58/58、CI 全绿；已发布。

## 1.10.8（远端 participant 成员归一化 + wake/reply 真机验收）

- `member.joined` 外部事件把 origin 为远端的 `kind=local` 成员归一化为 remote，补 deviceId/remoteSessionId；
- 启动迁移 mirror 中无法在本机解析的 local 成员；
- 真机：A mirror wake → B-test 本地 participant → `room_reply` → A 收到 B-TEST-ACK-1.10.8，作者正确、无重复；
- 测试：host 58/58、CI 全绿；已发布。
## 1.10.10–1.10.12（离线 rotation chain 补发真机通过）

- 1.10.10：hello/ack 携带 rotations；transcript 用 `stripRotations` 剔除链，避免密钥派生不一致；
- 1.10.11：接收端按本地 `rotationSeq` 过滤已应用前缀，再按 seq 排序验链；
- 1.10.12：修复启动时漏传 `rotationChain`（FleetNode 构造），否则 A 握手链为空，B 报 peer-rejected；
- 真机：B 停插件 → A 本地轮换 seq1 → B 重连 → B 从 seq0 head 验 seq1 → roster 更新 rotationSeq=1，fleet_delegate 返回 FINAL-1.10.12-OK；
- 测试：net 19/19（含 offline peer catches up a rotation chain）、host 58/58、overlay 2/2、perf 1/1、client smoke。

## 1.11.0（吊销 / 分叉 / 链分页 / 泄露恢复 / 邀请引导 / 链压缩 / Relay TLS，ADR-0027–0029）

- `device.revoke`：断言方当前密钥签名的吊销记录；自签立即生效，第三方记录只写 `revocationPending`，本机 `fleet_revoke_device(confirm: true)` 后才生效；
- 吊销墓碑留在 roster（`revokedAt/revocationRecord`），握手以 `device-revoked` 拒绝，Room 级联移除成员，删除回连地址；`fleet_remove_device` 才会删除墓碑并允许重新配对；
- 吊销广播：向已连接 peer 发 `fleet.device.revoke`；新 peer 连上时补发 roster 里保存的 `revocationRecord`；自签吊销延迟 250ms 应用，避免关闭回包通道；
- 分叉检测：`applyRotationChain` 识别「同 seq 异 hash」「head+1 的 prevHash 不符」「公告 head 不同」；`peer-rotations.json` 持久化对端链；命中后写 `rotationFork`、阻塞自动更新、握手 `rotation-fork`；
- 人工处理：`fleet_rotation_fork_resolve(confirm: true)`，`keep-local` 清标记，`adopt-peer` 只接已验证本地前缀（genesis/历史记录/当前 head 三种锚点）；
- 链分页：hello/ack 携带 `rotationSeq/rotationHead/rotationFrom`；16 条内联、64 条/页；响应方在 ack 后预推 `rotation.page`（`rotationChunks` 声明页数），发起方落后时发 `rotation.pull`；`fleet.rotation.records` RPC 支持 `fromSeq/limit`；上限 1024 条/16 轮；
- transcript：`stripRotations` 同时剔除 `rotationSeq/rotationHead/rotationFrom/rotationChunks`，签名仍覆盖；
- 邀请 v2：`encodeInvite/decodeInvite` 整包 HMAC 签名，携带 `creator/roster/revocations` 引导快照；加入时 pin 创建者与成员、导入吊销墓碑，本地已有公钥不覆盖；v1 邀请仍可读；
- 链压缩：`fleet_rotation_compact(confirm)` 归档旧记录并写 `rotation.checkpoint`，活动链保留最近 N 条（默认 64）；握手 `rotationFrom` 检测剪枝，对端报 `rotation-history-pruned`；
- Relay TLS：`createRelayServer({ tls })` 控制面+数据面 TLS，`relay.tls.ca` 设备侧 CA；`tls-options.js` 支持 PEM/文件路径；CLI 新增 `--tls-cert/--tls-key/--tls-ca`；
- Relay 候选：peer 候选 TTL 7 天、配置候选永不过期；`online→配置→失败少→最近成功` 排序；`fleet_status.relay.list` 与控制台候选卡片；peer 广告不能关闭证书校验；
- 归档 Room：`overview.archivedRooms` + 控制台恢复/删除按钮；
- 泄露恢复：`fleet_reset_identity(confirm: true)` 归档 identity/链并生成新 deviceId；`peer-rotations.json`、`identity-rotations.archive-*.json`、`revocations.jsonl` 新增；
- UI：吊销/待确认/分叉/密钥链/Relay 候选/归档 Room 卡片与按钮；新增 HTTP 路由 4 条（总计 27）；
- 工具：`fleet_rotation_status` / `fleet_rotation_compact` / `fleet_revoke_device` / `fleet_rotation_fork_resolve` / `fleet_reset_identity`；
- 测试：net 34/34（含 TLS Relay、剪枝握手、邀请 v2）、host 61/61、overlay 2/2、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.11.0`（`dev` tag，2026-11-15；shasum `b47040056ff58399b8b5336087d20f1aa684b6a5`，97 files）；`latest` 未移动，仍为 1.8.4；
- 注意：握手/邀请格式变更，两端必须同时升级到 1.11.0；A/B 真机仍 1.10.12，待升级后统一复验。

## 1.11.1（真机测试修复：剪枝误判）

- 真机（A/B 1.11.0）完成：基础链路、Room authority 提权/恢复、在线双向轮换、链压缩（10→8，checkpoint/归档）、离线补链（seq12）、邀请 v2 生成与验签、B 身份重置 + A TOFU 接纳、吊销拒绝与删墓碑后重新接纳、remote wake（ROOM-RECOVERY-OK / FINAL-ROOM-OK）；
- 修复：A 压缩链后，B 重置身份（自身链为空）主动重连时，A 的**发送侧**剪枝检查把 B 公告的 `rotationSeq`（B 自己的链位置）误当成 B 对 A 的 pin，错误返回 `rotation-history-pruned`，导致 B 无法自动回连。现改为发送侧只按对端 seq 推送可用后缀，剪枝判定只由接收方用自己的 roster pin 对照对端的 `rotationFrom` 完成；
- 回归用例：`a peer pinned at the responder head is not treated as pruned when its own chain is empty`、`a pruned chain still admits a fresh (unpinned) peer`；net 36/36；
- 其它：无协议字段变化，1.11.0 → 1.11.1 仅行为修复；仍要求两端同版本（ADR-0024）；
- 已发布 `dsh-device-fleet@1.11.1`（`dev` tag）；`latest` 仍为 1.8.4。

## 1.12.0（P0+P1：归档恢复、一次性邀请、通知、checkpoint、文件传输、Relay 延迟/mTLS）

- P0 归档 Room：`restoreArchivedRoom` 从 replica 重建可写 Room（消息/任务/成员保留，authority epoch+1）；`room_restore` 工具 + `/room/restore` + 控制台“恢复”改为真正恢复；
- P0 邀请 v3：`jti/expiresAt/singleUse`，HMAC 按版本覆盖；`issued-invites.json` 账本；hello 携带 `inviteId`，首次 TOFU 兑换，`invite-consumed`/`invite-expired` 拒绝；`known-devices.json` 豁免删除后重接纳；配置 `invite.ttlMs`（默认 24h）；
- P0 通知：`NotificationCenter` + `notifications.jsonl`；审批/第三方吊销/吊销/分叉触发；overview + 2 路由 + 控制台通知页/桌面通知开关；
- P0 密钥 UI：轮换/重置按钮（重置需输入 `RESET`）+ 两步路由 + 密钥泄露恢复三步引导；
- P1 checkpoint：握手携带含“该高度公钥”的自签 checkpoint；剪枝时存 offer、握手报 `rotation-checkpoint-required`；`fleet_rotation_trust_checkpoint(confirm)` 采纳 head 公钥并续链；
- P1 文件传输：`fleet.file.put/get` + `fleet_upload/fleet_download`；512 KiB 分块、SHA-256、64 MiB 上限；`write` 能力默认 ask、allowedRoots 生效；
- P1 Room rotationSeq：新事件 canonical 绑定签名 epoch；旧事件兼容；
- P1 Relay：ping/pong 延迟探测、候选按延迟排序、`fleet_status` 暴露 `latencyMs`；mTLS 客户端 `cert/key` + 服务端 `requestCert`，新增客户端证书夹具；
- 测试：net 40/40、host 64/64、overlay 2/2、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.12.0`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.12.0.tgz`，101 files，shasum `ebf0a159280f6922d0f3bf67fb310126597f1cfb`，1,120,103 bytes）；`latest` 未移动，仍为 1.8.4；
- 注意：1.12.0 与 1.11.x 不互连，两端需同时升级；真机回归待做。

## 1.12.1（热修复：插件激活 TDZ）

- B 真机报告：1.12.0 安装成功但插件激活失败，`ReferenceError: Cannot access 'signEventWithRotation' before initialization`，60581 无监听；
- 根因：`RoomReplicaStore` 构造时按值传入 `signEvent: signEventWithRotation`，而该 `const` arrow 定义在构造之后；`const` 不提升，插件 `apply()` 初始化阶段直接抛 TDZ；
- 修复：把 `currentRotationSeq` / `signEventWithRotation` / `signRemappedEvents` 上移到 `new RoomReplicaStore(...)` 之前；
- 回归：新增 `test/plugin-order.test.mjs`，静态检查 callback helper 定义顺序与所有 `signEvent:` 引用的初始化顺序；已加入 `scripts/ci.mjs`（plugin-order 1/1）；
- 其余功能与 1.12.0 相同；仍要求两端同版本（1.12.x）；
- 已发布 `dsh-device-fleet@1.12.1`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.12.1.tgz`，101 files，shasum `26dd1741cabcc96e674c2d296ab993a61430e634`，1,120,889 bytes）；`latest` 仍为 1.8.4。

## 1.12.2（1.12.1 真机回归修复）

- 1.12.1 A/B 真机回归通过：双端 1.12.1、直连、`fleet_delegate`（V121-BASELINE-OK）、归档 Room 恢复（消息保留、可继续写）、`fleet_upload`/`fleet_download` 1034 字节往返 SHA-256 一致；
- 修复：`POST /device-fleet/pair/invite` 把 `createInvite()` 的 `{code,expiresAt}` 又包了一层 `code`，控制台会显示对象且到期时间为空；现在拆包返回 `{ok, code, expiresAt}`，host 测试覆盖；
- 修复：未探测过的 Relay 候选 `latencyMs` 因 `Number(null)===0` 显示 `0ms`，现在保持 `null`；
- 测试：net 40/40、host 64/64、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；
- 1.12.2 A 侧验证：`POST /device-fleet/pair/invite` 返回字符串 `code`（4717 字符）与 `expiresAt`（+24h），decode 得到 jti/singleUse/creatorSeq=12；
- 1.12.2 双端验证：A/B 1.12.2 重连、V122-BASELINE-OK、归档 Room 恢复、Room 事件 rotationSeq=12、审批通知/已读、文件下载校验；B→A `fleet_run` 因 A 的 `E:\Dsh_test` sandbox ACL（Win32 5）失败，属环境项；
- 已发布 `dsh-device-fleet@1.12.2`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.12.2.tgz`，101 files，shasum `bf002b7a34a36ab9ea3222e6c0731e11f12140ce`，1,121,526 bytes）；`latest` 仍为 1.8.4。

## 1.12.3（checkpoint 广告签名修复 + 双端邀请/checkpoint 验证）

- 真机 checkpoint 测试发现：checkpoint 在压缩时签名，之后轮换到新 key；握手仍用 peer 当前 key 验证旧签名 → 失败且不保存 offer，`fleet_rotation_trust_checkpoint` 报 no-offer；
- 修复：新增 `refreshRotationCheckpoint`，FleetNode 构造、每次 rotate、每次 compact 后都用当前 identity 重签广告 checkpoint（seq/head/head 公钥不变）；新增两个 net 回归（刷新签名、旧格式回退）；
- 旧格式回退：checkpoint 没有 `headEdPublic/headXPublic` 时，用户 confirm 后 pin 对端当前广告的 seq/head/keys，不再回放旧记录；
- 双端真机（B 上临时新身份，A 真实 host）：
  - 单次邀请：第一身份 7a9112ae 接纳；第二身份 8c6d41b9 同 jti 被拒（handshake-closed / peer-rejected，ledger usedBy=7a9112ae）；
  - checkpoint：新身份 pin A@seq0 → rotation-checkpoint-required（from=5, checkpoint seq4）→ offer 含 headEdPublic → trust trusted → 重连到 seq12/head `NWSS…`；
  - 临时身份、邀请与 probe 文件已清理；
- 测试：net 42/42、host 64/64、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.12.3`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.12.3.tgz`，101 files，shasum `0f9cb335cbbf9412b7ee161f95aaff4f3a6e9c6a`，1,124,138 bytes）；`latest` 仍为 1.8.4。

## 1.13.0（除 P2P 外的剩余代码项）

- invite：v3 payload 增加创建者 `rotations`（≤1024 条），加入时写入 `peer-rotations.json`；新增 `splitInviteCode`/`joinInviteCode` 分片；
- 文件：`fleet.file.stat/list/delete` RPC；`fleet_upload` 支持目录与断点续传，`fleet_download` 支持目录；新增 `fleet_file_list`/`fleet_file_delete` 工具；write/list/fetch 策略与 roots 生效；
- Room：`room.rotationSeqMode=audit|strict`；身份重置前 close 本地 authority Room 并归档 replica；
- checkpoint：trust 成功后向 peer 广播 `fleet.rotation.checkpoint_trusted`（advisory，无 quorum）；
- 通知：`notifications.webhook` POST JSON；
- 同步：失败 peer 指数退避 1s→60s，手动 `room_sync` 强制；
- a11y/工具：按钮 `aria-label/title`；`scripts/relay-mtls.mjs` 生成 CA/server/client 证书与配置片段；
- 测试：net 43/43、host 65/65、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.13.0`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.13.0.tgz`，shasum `6d3c486af6ec5435142760d8e7e03d775c07eb5c`，1,131,451 bytes）；`latest` 仍为 1.8.4。

## 1.14.0（人类可读命名 + 控制台视觉重构 + checkpoint quorum）

- 新增 `human-names.js`：`friendlyName(seed)` 稳定生成「琥珀狐狸 27」；Room 创建/加载写 `title`，summary/detail/archived 返回 title；旧 Room 自动补名；
- 成员 `displayName`：host→主持人、remote→成员名/远程成员；消息 `fromLabel` 不再拼 `memberId`；会话标题改为 `<Room 名> · <参与者>`；
- 设备/审批/通知显示 roster 设备名，id 只留在 tooltip/诊断/工具参数；
- 控制台视觉：页面宽度/留白、分段 tab、卡片层次、Room 列表标题+元信息、成员头像/角色 pill、任务状态中文化、消息气泡/头像/时间戳；
- checkpoint：新增 `rotation.checkpointQuorum`（默认1）；确认广播计入 endorsement，trust 时检查 `1+endorsements >= quorum`；
- 测试：net 44/44、host 66/66、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.14.0`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.14.0.tgz`，shasum `94604ea2a21c23d37a21618661f5fa459d745240`，1,137,056 bytes）；`latest` 仍为 1.8.4。

## 1.14.1（Room 详情标题热修复）

- 1.14.0 真机验证发现：Room 列表已显示人类名，但 `/room` 详情从 replica state 读取旧 `title`（如 `Room session-`）；
- 修复：详情返回时用 RoomService 的 `room.title` 覆盖 replica title（mirror 与 authority 两条路径）；
- 验证：A 1.14.0 热重载后 `/room` 返回 `薄暮风铃 52`，成员显示 `主持人/worker-c/B-v111`；
- 测试：net 44/44、host 66/66、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.14.1`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.14.1.tgz`，shasum `1e3605f8cb75e1cf77fde7e2ae466f0b68fc52af`，1,137,512 bytes）；`latest` 仍为 1.8.4。

## 1.14.2（控制台视觉收尾）

- 全局样式层：按钮 hover/active 过渡、输入 focus ring、细滚动条、卡片 hover；
- 设备页顶部统计条（在线设备/活跃房间/未读通知）；
- Room 列表改为头像块 + 标题/元信息两行，选中态用 accent 色；
- 1.14.1 的详情标题修复保持；
- 测试：net 44/44、host 66/66、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；
- 已发布 `dsh-device-fleet@1.14.2`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.14.2.tgz`，shasum `b357df27d30b274f127cb6ee0bc6c79807a7c0e0`，1,138,123 bytes）；`latest` 仍为 1.8.4。

## 1.15.0（主题适配、Room 交互、配置页、连接风暴保护）

- 主题：移除硬编码白色/深色层，改用 DSH 语义变量 + 中性灰，浅色/深色共用；补 hover/focus/滚动条。
- Room：收件人 chip（全选/清空）、`@` 成员建议与自动收件人、任务负责人可改；详情布局改为双列 grid，时间线收件人显示名称。
- 配置：设备联邦新增“配置”标签，读取/保存 `/device-fleet/config`，按 top-level diff 提交并即时生效。
- 归档恢复：自动对 remote 成员调用 `room.join`（优先复用 remoteSessionId），失败记录 `reinviteFailed`。
- 连接保护：FleetNode 限制 256 个未完成握手 socket，direct server `maxConnections=256`，close 时销毁 pending。
- 测试：host 66/66、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke passed；net 最近一次 44/44，当前本机 ENOBUFS 待重启复跑。
- 已发布 `dsh-device-fleet@1.15.0`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.15.0.tgz`，shasum `eb990ab83f6af4a98bd8e5e6fd2dbf200f27ffe1`，1,151,815 bytes）；`latest` 仍为 1.8.4。

## 1.15.1（配置页图形化）

- 配置页不再使用 JSON 编辑器，改为分组表单：基础、连接与发现（Relay/TLS/mTLS）、执行、权限策略（能力矩阵、允许目录/工具、TTL）、邀请与审批、Room/轮换、通知。
- 所有字段直接读写 runtime config；保存仍按 top-level diff 提交并即时生效。
- 测试：host 66/66、smoke passed；net 44/44、overlay/plugin-order/perf 全绿（CI）。
- 已发布 `dsh-device-fleet@1.15.1`（`dev` tag，2026-11-15；离线包 `dsh-device-fleet-1.15.1.tgz`，shasum `b23d7d8e5300c74c2106f75c747409f84b6ffe5a`，1,155,641 bytes）；`latest` 仍为 1.8.4。

## 1.15.2（真机回归修复：任务负责人 / authority 收回）

- `/room/task` update 现在把 `owner` 传给 `RoomService.updateTask`，UI 修改负责人真正生效；
- Room creator 收到更高 epoch 的 authority claim 时，先降级为 mirror，再自动 promote 到更高 epoch 并广播，避免 A/B 每次重连 authority 回摆；
- 测试：host 66/66、net 44/44、overlay/plugin-order/perf/smoke 全绿；
- 已发布 `dsh-device-fleet@1.15.2`（`dev` tag，2026-11-16；离线包 `dsh-device-fleet-1.15.2.tgz`，shasum `49673cf8d6c2c3049c8f16fc2fade05e805c4c75`，1,155,956 bytes）；`latest` 仍为 1.8.4。

## 1.16.0（控制台 i18n）

- 顶栏 `中文/EN` 切换，默认跟随浏览器语言，选择写入 `localStorage['dsh-fleet-lang']`。
- `translateText` 精确词典 + 计数正则；`localize` 递归翻译 React 文本/placeholder/title/aria-label。
- 包裹 FleetConsole、RoomView、RoomDock、审批面板、Room mention overlay。
- 未翻译插件 schema 页与后端动态通知正文。
- 测试：net 44/44、host 66/66、overlay/plugin-order/perf/smoke 全绿。
- 已发布 `dsh-device-fleet@1.16.0`（`dev` tag，2026-11-16；离线包 `dsh-device-fleet-1.16.0.tgz`，shasum `5442fb72395c86e81c83e3310d3ac3181fdf2e04`，1,160,731 bytes）；`latest` 仍为 1.8.4。

## 1.16.1（移除插件 Settings 配置页）

- 删除 `plugins.row.config` / `plugins.bundle.config` 客户端注册及整段 `FleetConfig` 组件与表单 helpers。
- 配置入口只保留“设备联邦 → 配置”；服务端 `Config` schema 保留用于 profile config 兼容。
- client smoke 改为断言该页面不再注册。
- 已发布 `dsh-device-fleet@1.16.1`（`dev` tag，2026-11-16；离线包 `dsh-device-fleet-1.16.1.tgz`，shasum `080ce21b529f3748eb691caf41b60cc6d4ead826`，1,120,835 bytes）；`latest` 仍为 1.8.4。

## 1.17.0（审批 Room/任务作用域、动态 i18n、mTLS 生命周期）

- ADR-0020 补齐 `room`/`task` 审批作用域；Room 关闭/删除与任务 done 自动撤销；`fleet_call`/`fleet_delegate` 可携带 roomId/taskId，Room wake 自动带 roomId。
- 控制台 i18n 扩展动态文本：通知/审批/状态/计数/失败原因的中英正则与词典；仍未覆盖插件日志与非 React prompt。
- Relay mTLS：`allowedClientFingerprints` / `allowedClientFingerprintsFile`（每个新连接重新读取）；`scripts/relay-client-cert.mjs rotate|revoke|list`；`fleet_relay_reconnect` 在替换证书后重连并重读文件。
- 测试：host 68/68、net 45/45、overlay/plugin-order/perf/smoke 全绿。
- 已发布 `dsh-device-fleet@1.17.0`（`dev` tag，2026-11-17；离线包 `dsh-device-fleet-1.17.0.tgz`，shasum `105cae164228db63c52f311de37b628b3c35eb2b`，1,181,572 bytes）；`latest` 仍为 1.8.4。

## 1.17.1（热重载说明修正）

- `fleet_join` 入网、插件更新只需重载插件（`plugin_manager set_bundle off/on`），无需重启 DSH；`fleet_connect` 连接本来就是热操作。
- 修正 `fleet_join` 工具输出/描述、控制台提示与 README 配对步骤。
- 已发布 `dsh-device-fleet@1.17.1`（`dev` tag，2026-11-17；离线包 `dsh-device-fleet-1.17.1.tgz`，shasum `40e2fbd22ffca34d4cc35b83de722cb61a80ed62`，1,181,927 bytes）；`latest` 仍为 1.8.4。

## 1.17.2（发布包与文档修正 + Agent 说明书）

- `package.json` `files` 增加 `scripts/` 与 `AGENTS.md`；此前 npm 包不包含 `relay-mtls.mjs` / `relay-client-cert.mjs`，README 中的 mTLS 命令在安装包里无法运行。
- 新增 `docs/AGENT-GUIDE.md`（工具选择、入网/热重载、审批作用域、错误码、Room/文件/安全规则）和根 `AGENTS.md`；扩充注入给 agent 的 `FLEET_MANUAL`。
- README/STATUS/HANDOFF 的版本、测试基线（net 45/45、host 68/68）与当前 A/B 状态同步。
- 已发布 `dsh-device-fleet@1.17.2`（`dev` tag，2026-11-17；离线包 `dsh-device-fleet-1.17.2.tgz`，shasum `0b1984b783591a81db562d81c3f453750a48c42a`，1,219,229 bytes）；`latest` 仍为 1.8.4。

## 1.17.3（Room 授权实测、fleet_run 上下文、任务撤销）

- `fleet_run` 新增可选 `roomId/taskId`，与 `fleet_call`/`fleet_delegate` 一致。
- Room 授权真机验证：B `autoApproveAsk=false` + `run=ask` 时，首次调用产生审批；批准 `scope=room` 后同 roomId 第二次直接放行，换 roomId 再次产生审批。
- mirror 收到 `task.updated(status=done)` 时撤销 task grant；本地 authority 在任务 done 时也撤销。
- 已发布 `dsh-device-fleet@1.17.3`（`dev` tag，2026-11-17；离线包 `dsh-device-fleet-1.17.3.tgz`，shasum `a7c36adc672b0598037b737175f7b94a559dfdb7`，1,224,715 bytes）；`latest` 仍为 1.8.4。

## 1.17.4（任务级 grant 跨设备撤销）

- 实测发现：A 把 task 标记 done 后，B 的 mirror 未及时同步到新任务，task grant 仍然生效。
- 修复：任务 done 时由执行端向 Room 内所有远端设备发送 `room.task.done`，对端 `policy.revokeTask(taskId)`；mirror 的 `onTaskEvent` 保留为兜底。
- 已发布 `dsh-device-fleet@1.17.4`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.17.4.tgz`，shasum `164de6fa4db6c36355de5ccedf732519efc648b1`，1,229,414 bytes）；`latest` 仍为 1.8.4。

## 1.17.5（task grant 撤销修复）

- 1.17.4 的 `revokeTaskEverywhere` 被误放在 `ctx.inject(['webServer'])` 回调内，`onTaskDone` 调用时报 `revokeTaskEverywhere is not defined`；1.17.5 移到 apply 顶层作用域。
- 撤销通知跳过本机 deviceId，只发给其它 Room 成员。
- 真机验证：任务 done → B 收到 `room.task.done` → 同 taskId 再调用重新出现审批；B 的 approve scope=task 与后续同 task 放行此前已通过。
- 已发布 `dsh-device-fleet@1.17.5`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.17.5.tgz`，shasum `f7b0a9d8c23702a82c1b319127ee6b31e8be23b8`，1,229,997 bytes）；`latest` 仍为 1.8.4。

## 1.17.6（离线撤销兜底）

- 新增 `ScopeRevocationQueue`：room/task 撤销请求持久化到 `pending-scope-revocations.json`，对端重连和每 30s 重试补发；成功才移除。
- `room.grant.revoke` RPC 统一处理 room/task grant 撤销；旧 `room.task.done` 保留兼容。
- ToolPolicy 的 room/task grant 从 `Infinity` 改为 **7 天最大寿命**，即使撤销通知永久丢失也不会无限残留。
- host 69/69（新增队列持久化/去重/prune 测试）。
- 已发布 `dsh-device-fleet@1.17.6`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.17.6.tgz`，shasum `1788bb24f24df8a899e70095d61e988474cf5fa3`，1,232,245 bytes）；`latest` 仍为 1.8.4。

## 1.18.0（大文件/审批持久化/outbox/调用详情/Relay 证书轮换）

- 文件传输上限 2 GiB，上传/下载流式；审批收件箱与 grants 持久化；离线 outbox（`fleet_queue_*`）；CallLedger + 控制台“调用”页（`fleet.calls.list` 聚合）；Relay `reloadTls` + SIGHUP + server cert 轮换脚本；i18n 动态文案补齐。
- 测试：net 46/46、host 71/71、overlay/plugin-order/perf/smoke 全绿。
- 已发布 `dsh-device-fleet@1.18.0`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.18.0.tgz`，shasum `f2a5b5527a8d4c1a53efc9c599512ee28d927875`，1,278,946 bytes）；`latest` 仍为 1.8.4。

## 1.18.1（下载续传、确认框 i18n、证书自动重载）

- `fleet_download` 新增 `resume`：复用本地 `.part`，从远端 offset 续传，最终校验完整 SHA-256。
- 原生 `confirm` 文案走 i18n；语言检测增加 `document.documentElement.lang`。
- Relay server 监听证书文件变更并自动 `reloadTls`（SIGHUP 之外，Windows 可用）。
- 已发布 `dsh-device-fleet@1.18.1`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.18.1.tgz`，shasum `1731431091e85a9ed994723b298e27fb6fba578b`，1,283,442 bytes）；`latest` 仍为 1.8.4。

## 1.18.2（checkpoint 签名确认）

- `broadcastCheckpointTrust` 对 `{type,trustedBy,deviceId,seq,head,at}` 做 Ed25519 签名。
- `noteCheckpointTrust` 用 roster 中 trustedBy 的 edPublic 验签，只有有效签名才计入 quorum；无签名/坏签名拒绝。
- 这不是阈值多签：仍是“每个设备独立签名 + 计数”，没有聚合签名/共识协议。
- 已发布 `dsh-device-fleet@1.18.2`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.18.2.tgz`，shasum `d8aa3a82ca98e65e29b40ab0c92a157cff42c40f`，1,287,438 bytes）；`latest` 仍为 1.8.4。

## 1.19.0（M-of-N checkpoint / DSH 轨迹 / Relay 集群）

- checkpoint 签名绑定 seq+head，M-of-N 证书达到 quorum 才写入信任；仍非阈值签名/共识。
- 目标设备保存有界 `session/event` 轨迹，`fleet.session.trajectory` 按会话拉取；调用页显示轨迹。
- `scripts/relay-cluster.mjs` 多节点 supervisor（崩溃重启/健康探测）。
- 3 节点直连 mesh 测试；net 48、host 72；真机 A/B 1.19.0 拉取 32 条远端 DSH 轨迹事件。
- 已发布 `dsh-device-fleet@1.19.0`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.19.0.tgz`，shasum `3bc290278ce998c93c0f2574a773feb8254cfdd1`，1,308,139 bytes）；`latest` 仍为 1.8.4。

## 1.20.0（轨迹持久化/脱敏、Relay 选主）

- `TrajectoryStore` 追加 JSONL，7 天保留、16 MiB 压缩、敏感字段 `[redacted]`；重启后可读。
- 新增 `scripts/relay-lease.mjs` lease coordinator；`relay-cluster.mjs --coordinator` 只有 leader 启动节点，lease 丢失即停节点。
- 实测双候选 409/接管、leader 节点端口监听；lease coordinator 仍是单点，生产建议 etcd/Consul。
- 已发布 `dsh-device-fleet@1.20.0`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.20.0.tgz`，shasum `adf3f26dd76dce83b7054ada18b389fe959345f8`，1,313,127 bytes）；`latest` 仍为 1.8.4。

## 1.20.1（lease token / release gate）

- `relay-lease.mjs --token`：所有请求校验 `x-lease-token`，未授权 401；supervisor 用 `--lease-token`。
- `scripts/release-check.mjs`：版本一致性、关键文件、语法、npm pack 内容检查；`npm run release:check`。
- 文档增加正式发布闸门与 FROST 取舍。
- 已发布 `dsh-device-fleet@1.20.1`（`dev` tag，2026-11-18；离线包 `dsh-device-fleet-1.20.1.tgz`，shasum `9b397fe4e3bd445758b19080fc2fbdffd00efad2`，1,317,059 bytes）；`latest` 仍为 1.8.4。

## 1.20.2（安全审计修复）

- capability spoof/管理工具远程调用、allowedTools 失效、grants 绕过 roots、symlink/junction 逃逸、relay 客户端私钥外发、lease 默认无鉴权、轨迹/calls 越权、已吊销 checkpoint 签名计数。
- 审计报告：`docs/SECURITY-AUDIT-1.20.1.md`；net 49、host 74。
- 已发布 `dsh-device-fleet@1.20.2`（`dev` tag，2026-11-19；离线包 `dsh-device-fleet-1.20.2.tgz`，shasum `c39d90c8d7ab3a445db500e321fa918411bc7124`，1,356,691 bytes）；`latest` 仍为 1.8.4。

## 1.20.3（轨迹 RPC 回归修复）

- 1.20.2 的 roots-before-grants 检查误伤 `fleet.session.trajectory`（read capability 无 path）；加轨迹专用豁免。
- `ui-web` 将 unauthorized 映射为 403。
- 已发布 `dsh-device-fleet@1.20.3`（`dev` tag，2026-11-19；离线包 `dsh-device-fleet-1.20.3.tgz`，shasum `7117c2c58dc941e4f6583bf004fa315d84307dd3`，1,358,151 bytes）；`latest` 仍为 1.8.4。

## 1.20.4（审批收口）

- 移除 `fleet_approve` / `fleet_deny` Agent 工具；`fleet_approvals` 只读。审批只能由本地设备联邦面板/HTTP 做出。
- 更新 AGENT-GUIDE、approval-inbox 注释、simulate 提示。
- 已发布 `dsh-device-fleet@1.20.4`（`dev` tag，2026-11-19；离线包 `dsh-device-fleet-1.20.4.tgz`，shasum `002956035e23b119303e0372d4536dd889324a11`，1,357,675 bytes）；`latest` 仍为 1.8.4。

## 1.20.5（HTTP 同源校验）

- 新增 `src/host/http-guard.js`；ui-web/approval-web/config-web/avatar-web 全部拒绝跨站 Origin、非 loopback Host、cross-site Sec-Fetch-Site。
- 单测覆盖跨站/rebinding；host 75/75。
- 已发布 `dsh-device-fleet@1.20.5`（`dev` tag，2026-11-19；离线包 `dsh-device-fleet-1.20.5.tgz`，shasum `ffbe2e3b25d4afb711db7ee96d6b8875f1d2dc08`，1,361,044 bytes）；`latest` 仍为 1.8.4。

## 1.20.6（配置回滚）

- `runtime.update` 在 apply handler 抛错时恢复旧 overrides 并重新持久化。
- `FleetNode.reconfigure` 先校验 relay 配置；启动失败恢复上一份网络配置并重启。
- 跨主机 TLS Relay 测试中发现该缺陷（B 离线）；host 75/75。
- 已发布 `dsh-device-fleet@1.20.6`（`dev` tag，2026-11-19；离线包 `dsh-device-fleet-1.20.6.tgz`，shasum `b50c40a1a202a2d4d847da0c571a3a3969d4531e`，1,359,706 bytes）；`latest` 仍为 1.8.4。

## 1.20.7（启动回滚修复）

- `start()` direct bind 失败时重置 `started=false`；`reconfigure()` 回滚前重置 `started/closed`，确保真正重启旧配置。
- 新增 net 测试：新 direct port 被占用时 reconfigure 失败后恢复旧 listener，net 50/50。
- 跨主机 TLS Relay 已验证 B `relay.online=true`；清理 B relay 配置触发离线，root cause 为本修复。
- 已正式发布 `dsh-device-fleet@1.20.7`（`latest` + `dev`，2026-11-19；离线包 `dsh-device-fleet-1.20.7.tgz`，shasum `61d09b5d235ad494883b5aefea794d72f6fc06a1`，1,200,382 bytes）。
- 双端 1.15.2 验证：V152-BASELINE-OK；B 重连后 A authority 稳定 epoch11（无回摆）；任务负责人 host↔B 双向修改成功、非法 owner 被拒；配置 `notifications.timeoutMs` 5100 保存并回退 5000。