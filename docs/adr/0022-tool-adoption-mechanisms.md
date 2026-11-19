# Fleet 工具的采用机制

## Status
accepted

## Context
模型不会主动想到"可以用另一台设备"。`dsh-global-task-list` 的经验证明：只写工具描述不够，需要在模型组织工作时主动提醒、首次使用时给手册、写错时即时纠偏。同时提醒不能按"在线成员"门控——离线成员的存在也是客观状态。

## Decision
采用四层机制：
1. **工具描述**：`fleet_list` / `fleet_tools` / `fleet_call` / `fleet_read` / `fleet_fetch` / `fleet_run` / `room_*` / `fleet_delegate` 的描述写清"何时用、边界、直调 vs Room vs 委派"的选择。
2. **常驻 system prompt section**：当 Fleet 有至少一台成员（含离线）且工具在当前 scope 可调用时渲染一句；只列**稳定的成员名单**（名字/角色），在线状态不进 prompt（保护 KV cache，状态放 `fleet_list` 结果）。
3. **首次使用手册**：第一次调用任一 fleet 工具时，把内置 skill `fleet` 的手册挂到**这次工具结果**里（同一 turn 生效、每 session 一次）；完整手册不常驻。
4. **编排钩子 + 即时纠偏**：`tools/post-execute` 在 `todo_write` / `subagent*` / `workflow` / `ralph` 后注入**一行**跨设备提示（每 session 一次，与手册投递互斥）；`fleet_call` 被拒/离线/审批超时、Room 消息缺收件人、Board 未更新时，在工具结果里给出针对本次调用的纠偏。
5. **可选**：`agent/pre-step` 意图检测（用户消息提到设备名/"另一台/远程"等关键词时注入设备清单），默认关闭，作为设置项。

## Considered Options
- 只靠工具描述——模型常常想不到用，否决。
- 每轮强制检查清单——token 最贵、打断思考，否决。
- 与 task-list 手册同时注入大段文本——上下文膨胀，否决（因此钩子只发一行，完整手册走首次调用）。

## Consequences
需要 once-per-session 投递状态与两个投递通道互斥；常驻 section 只在有成员时渲染、成员列表变化才更新；在线状态查询有额外一次工具调用成本。
