# 调用细节复用会话轨迹，不自建 trace UI

## Status
accepted

## Context
用户想看跨设备调用的"整个流程"。DSH 已经为每个会话提供轨迹视图（turn/tool 调用/结果），再自建一套 trace UI 会重复渲染、数据模型也会分叉。

## Decision
- Room UI 只负责**房间层面的视图**：完整对话（用户视角）、成员/策略、Room Board。
- **执行细节复用 DSH 的会话轨迹**：
  - Host 的 Room 会话轨迹：Host agent 的动作 + `room/*` 事件；
  - 每个 Participant 设备的本地会话轨迹：该 agent 自己的 turn、工具调用与结果、自己的上下文。
- Room UI 提供"查看细节"入口：定位/打开**所属设备**上的会话轨迹（v1 不把远端轨迹镜像到房间）；用户要看 B 的细节就去 B 的设备界面（或后续做只读镜像）。
- **远端轨迹只读镜像**（在一个界面看所有设备细节）作为后续增强，需要会话事件同步与脱敏，v1 不做。

## Considered Options
- 在 Room UI 自建工具调用详情渲染——重复实现、与 DSH 轨迹不一致，否决。
- 把所有 Participant 的会话事件回放进 Host 日志——房间日志膨胀、跨设备信息泄露风险，否决。

## Consequences
v1 查看另一台设备的细节需要切换设备；房间记录保持"消息 + Board + 审计指针"的干净模型；后续镜像需要定义哪些事件可跨设备、如何脱敏。

## 追记（1.18.0）

- 新增 `CallLedger` + `fleet.calls.list` + 控制台“调用”页：聚合**调用元数据/结果摘要**，可在一个界面看到本机与已连接设备的 outbound/inbound 调用。
- 这实现了“跨设备调用详情”的只读聚合，但**不是完整 DSH turn/tool trajectory 镜像**；ADR-0023 的完整轨迹镜像仍未做。
