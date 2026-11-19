# 协作形态：Room 之下的本地团队与跨设备委派

## Status
accepted

## Context
两台设备要"看起来无缝衔接、agent 自由运行"，同时每个 agent 也应保留自己原有的组织能力（本地 Agent Team、subagent）。把这些都塞进 Room 会让房间成员爆炸、上下文互相污染；完全隔离又失去跨设备合作。

## Decision
采用"房间 + 逐 agent 私有团队 + 跨设备委派"的三层模型：
- **Room**：跨设备协作的共享层。每个成员设备在房间里只有一个**代表 agent**（Participant），共享 Room Board、点名与消息。
- **Local Team**：每个代表 agent 在自己设备上仍可自由使用本地 Agent Team / subagent 干活；这些本地成员**对 Room 不可见、不被点名、不写 Room Board**，只由代表 agent 把结果带回房间。
- **Delegation（跨设备委派）**：成员 agent 可把一次性任务交给另一台成员设备上的 agent 执行并取回结果；被委派方使用**独立的一次性子会话**（不进入 Room、不共享房间历史、不可续聊），对应 DSH 外部 `SubagentProvider` 的 one-shot 语义。
- **边界**：跨设备委派有深度上限（默认 1，禁止 A→B→A 回环）；被委派的远程子 agent 不能创建/加入 Room，也不能再唤醒第三方成员；Room 成员之间才谈"合作"，委派只谈"派活"。

## Considered Options
- 所有协作都塞进 Room——成员与上下文膨胀，否决。
- 禁止 agent 使用本地团队——与"agent 自由运行"相悖，否决。
- 远程子 agent 直接复用目标设备 Room 里的代表会话——会抢上下文与写锁，否决。

## Consequences
需要区分"房间成员"与"委派子会话"两种远程 agent 身份；委派结果只回到委派者；深度与回环需要协议层限制；本地团队的成本与行为仍由各设备自己负责。
