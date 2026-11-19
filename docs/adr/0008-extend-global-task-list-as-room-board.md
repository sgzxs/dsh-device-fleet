# 复用并扩展 dsh-global-task-list 作为 Room 任务板

## Status
accepted

## Context
Room 需要结构化的共享状态（目标、任务、负责人、产物指针），否则被唤醒的 agent 只能反复读聊天记录。`dsh-global-task-list`（v0.4.2，作者自己维护、可改源码）已有高度对齐的数据模型（status/steps/progress/parentId/dependsOn/surface）、持久化 `storageDomain`、成熟的面板 UI 与生成式 surface 渲染；但它刻意设计为**本机、session-independent**，没有共享数据源与 room/owner 维度。

## Decision
走扩展路线（不 fork、不重写）：
- 在 `task_ui` 记录上增加 **room 作用域**（`roomId`）、**负责人成员**（owner member）与**版本号**（用于跨设备 CAS）；
- 增加 **Host 侧程序化 API**（Host service 或 Typert Remote）供 Fleet 插件读写，而不是复用未认证的 `/task-ui` HTTP 路由；
- **Room Host 权威**；参与设备把房间任务**镜像**到本地 `task_ui`（只读，写入回到 Host）；面板按 room 分组并标记只读镜像；
- agent 工具面沿用现有 `task_*` 并增加可选 `roomId`，或新增 `room_task_*`（命名在工具面设计中再定）。

## Considered Options
- Fork TASK_SCHEMA 与面板组件进 Fleet 插件——要维护 ~48KB 面板与 CSS 的副本，且失去后续改进，否决。
- Room 板只存 `{deviceId, taskId}` 指针、插件零改动——没有统一视图、状态滞后，仅可作 PoC 过渡，否决。

## Consequences
个人任务库与房间任务板共用一份存储与面板，需要明确的 room 过滤与只读镜像规则；schema 增加字段（domain 后端描述符不随 schema 变，无需版本升级）；跨设备更新需要 CAS 与冲突提示；扩展后的插件成为 Fleet 的依赖项。
