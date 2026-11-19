# 跨设备协作以共享 Room 为协调单位

## Status
accepted

## Context
三个以上 agent 在同一件事上协作时，两两配对会退化成 N(N-1)/2 条互不相干的会话：没有共同历史，协作者之间只能经发起者转发，发起者成为瓶颈与单点；星型转发也同样没有"所有人看到同一份上下文"的群聊感。

## Decision
引入 Room 作为跨设备协作的协调单位：由一台设备（Host）托管唯一一份权威消息历史、成员表与共享任务板，所有 Participant 共享并按序广播；任意 Participant 可以直接对其他 Participant 说话，不必经过发起者。Participant 的 agent 按需懒创建，唤醒时只拿任务简报（Participant Brief）与定向消息，不继承房间全量历史。

## Considered Options
- 两两配对的常驻会话——只在 2 台设备时等价于 Room，3 台以上无共同历史，否决作为协调单位（保留为其实现细节：2 人房 = 1:1）。
- 星型 Lead + workers（仅发起者↔协作者）——实现最简单，但没有群聊感，发起者是单点，否决。

## Consequences
多设备协作需要 Host 角色与广播/排序/持久化；房间历史与各 agent 的上下文解耦，token 成本可控；Host 设备离线时房间需要降级或迁移（一期先按离线只读处理）。
