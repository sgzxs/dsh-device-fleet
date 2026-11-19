# ADR-0033：人类可读命名与控制台视觉重构

- **状态**：已实现（2026-11-15，1.14.0）
- **相关**：ADR-0025（Room replica）、ADR-0030/0031/0032
- **结论**：用户界面不再用后端 id 充当名称；Room/成员使用确定性的人类可读名称；控制台按卡片、层级、气泡消息重构。

## 1. 命名规则

- 新增 `src/host/human-names.js`：
  - `friendlyName(seed)` 由 id 稳定哈希到「形容词 + 名词 + 数字」，如 `琥珀狐狸 27`；
  - 同一 seed 永远同名，旧数据无需迁移即可获得名称。
- Room：创建时写入 `title`，持久化到 `rooms.json`；旧 Room 在 load 时补生成；`summary/detail/archivedRooms` 均返回 `title`。
- 成员：`memberSummary.displayName`：
  - host → `主持人`；
  - remote → 成员名，缺失时 `远程成员`；
  - 其它 → 成员名。
- 消息 `fromLabel`：用户 → `用户`，其它 → `displayName`，不再拼接 `memberId`。
- 会话标题：`<Room 名> · <参与者>`；远程参与者加“（远程）”。
- 设备/审批/通知：显示 roster 中的设备名；id 只保留在 tooltip/诊断/工具参数中。
- 后端 id 仍是协议、审计与工具层的唯一标识，不改传输。

## 2. 视觉重构

- 统一卡片：14px 圆角、细分隔线、轻微渐变与内阴影；页面最大宽度 1180、留白 22/24。
- 顶栏：品牌状态点 + 设备/版本 pill + 分段式 tab 容器；选中 tab 用 accent 实底。
- Room 列表：标题 + 成员/消息/任务元信息 + 选中状态点，不再显示截断 id。
- Room 详情：大标题 + 计数副标题；成员头像圆点/角色 pill；任务状态中文化；看板 owner 显示成员名。
- 消息：作者名与目标、左右气泡、头像、时间戳、圆角方向区分。
- 空状态/占位文案改为面向用户的表达。
- 按钮补 `aria-label/title`；完整 i18n 仍未做。

## 3. checkpoint quorum（配置面）

- 新增 `rotation.checkpointQuorum`（默认 1，最小 1）。
- 设备收到 `fleet.rotation.checkpoint_trusted` advisory 后计入 endorsement；本地 trust 时若配置 >1，要求 `1 + endorsements >= quorum`，否则 `checkpoint-quorum`。
- 仍是“确认计数”，不是多签；默认 1 保持原行为。

## 不变量

1. 传输/密钥/审计 id 不变；人类名称只是展示层 + Room 持久化 title。
2. `friendlyName` 必须确定性；同一 Room 名不能随 reload 变化。
3. title 缺失时任何读取路径都要有稳定回退，不能显示 `Room 1a2b3c4d`。
4. quorum 只影响 checkpoint 信任，不影响普通握手。
5. 视觉改动不得改变现有 HTTP 路由/工具语义。

## 未完成

- ~~归档 Room 恢复后自动重新邀请远端成员~~（1.15.2 已实现）；
- i18n 已覆盖控制台静态/动态文案与原生确认框；插件日志、DSH 自身提示、工具原始错误仍是原文；
- checkpoint 多签（当前计数/quorum 配置，非密码学多方签名）；
- P2P（范围外）。
