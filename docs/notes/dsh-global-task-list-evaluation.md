# dsh-global-task-list 可复用性评估（v0.4.2）

源码位置：`C:\Users\PS\.dsh\plugins\dsh-global-task-list`（profile 以 `link:` 引用，desktop profile 已启用）。
结论：**数据模型与面板 UI 大部分可复用；作为"跨设备共享任务板"不能直接复用**，缺共享数据源、room/owner 维度、程序化读写 API 与远端镜像模式。

## 事实

### 数据模型（dsh-global-task-list 的 src/index.ts）

`storageDomain` 域 `task_ui` v1，表 `tasks`，记录字段：

`title, status(pending|running|done|blocked|failed), description, nextStep, steps[{text,state:done|current|next|todo}], parentId, dependsOn[], surface(生成式 UI 文档), progress{text,percent?}, jobId, createdAt, updatedAt` + 行主键 `id`。

- 任务**刻意 session-independent**：README「Tasks are session-independent by design」，记录里没有 session/owner 字段，跨会话交接是设计目标。
- 存储是 `storageDomain`（本机 `$DSH_HOME` 持久化），跨会话、跨重启；**不跨设备**。

### Host 对外面

- 模型工具（6 个）：`task_add / task_list / task_get / task_update / task_delete / taskui_probe`。
- HTTP 路由（浏览器面板用）：
  - `GET /task-ui/tasks` 快照（附派生 `jobStale`）
  - `POST /task-ui/status` 只改 status
  - `POST /task-ui/delete` 删除
  - `POST /task-ui/ask` 生成式 UI 的"追问"，给某个 master agent 排队一条 user 消息
  - `GET /task-ui/events` SSE：无 payload，只是"变了，重新拉"通知
- 无 `ctx.provide` 的 Host service、无 Typert `@Remote` 命名空间、无导出给其他插件用的编程 API（package exports 只有 `.` 与 `./client`）。
- HTTP 路由未走 `connection.admit` 认证（面板同源使用）；不适合直接当作跨设备 API。

### Client 面板

- `conversation.input.dock` slot 的常驻面板：折叠分组（running / other open / done）、步骤流、拖动改宽、SSE 刷新、状态/删除/拆分操作、zh/en 本地化。
- 数据源写死为**本机** `/task-ui/tasks` + `/task-ui/events`；没有"远端只读/镜像"数据源接口。

### 与 Room 任务板的对齐度

| Room 板需要 | task_ui 现状 | 复用判断 |
|---|---|---|
| goal / tasks / 负责人 / 状态 / 依赖 | 有 title/status/parentId/dependsOn/steps/progress，无 owner/member 字段 | 字段 80% 可映射；需加 room 作用域与 owner |
| 产物指针（device + path） | 无；`surface` 可承载任意 JSON | 可放 surface 或加字段 |
| Host 权威、参与设备镜像 | 严格本机存储 | 需新增同步层 |
| 任何设备都能看/操作同一份板 | 面板只读本机路由 | 需新增数据源/镜像模式 |
| agent 低成本读写 | 已有 task_* 工具与 prompt 引导 | 可直接复用（加 room 参数） |
| 并发更新防覆盖 | 单进程 domain，无跨设备 CAS | 需在同步层做版本号/CAS |

## 三条整合路径

**A. 扩展本插件（推荐，前提是代码可改）**
加 `roomId`（或 scope）与 `ownerMember`、版本号；加 Host 侧编程 API（service 或 Remote）供 Fleet 插件读写；Room Host 权威、参与设备镜像到本地 `task_ui`（镜像只读，写回 Host）；面板按 room 分组并标记只读镜像。保留现有工具名（`task_*` 增加可选 `roomId`）或新增 `room_task_*`。工作量：中。

**B. Fork UI/schema 进 Fleet 插件**
把 TASK_SCHEMA、面板组件、surface 渲染器复制进新插件（MIT），独立演进。避免跨插件耦合与版本兼容，但要维护 ~48KB 面板 + CSS 的副本。工作量：中大。

**C. 仅存引用**
Room 板只存 `{deviceId, taskId}` 指针，各设备用本地 task_ui 记录，Host 聚合指针状态。插件零改动；但没有统一视图、状态要轮询、agent 两头维护，不推荐作为最终形态（可作 PoC 过渡）。
