# 委派升级为 Room 时复用原委派会话

## Status
accepted

## Context
用户常常先让 B 的 agent 做一次性任务（委派），随后才发现要继续合作。重新委派或新建 Participant 会话会丢掉上下文、cwd 与已完成的中间状态；而把"委派"和"合作"做成两套互不相通的东西，又违背"无缝衔接"的目标。

## Decision
- 委派升级为 Room 是**显式动作**（`room.upgrade` 携带 delegation id）：A 的当前会话成为 Room Host；B 上原委派子会话**直接绑定为 Participant**（保留 sessionId、上下文、cwd、中间状态），不新建会话。
- 升级后该成员只走 Room 语义；Room 日志以系统事件记录"该 Participant 由某次委派升格而来"，原委派对话留在参与者本地会话，Room 只接收摘要/指针，不整段回放。
- Room 内**新发起**的委派仍创建隔离的一次性会话，结果只回发起者，不自动成为 Participant；需要长期参与时再显式升级。

## Considered Options
- 新建 Participant 会话 + 用委派结果当简报——丢失工作现场，否决。
- 不升级、继续"再委派 + 摘要"——长期合作持续浪费，否决。
- 自动隐式升级——用户会不知道"什么时候变成了房间"，否决。

## Consequences
委派记录必须保存目标会话 id 与可升级性；房间成员记录要允许"绑定已有会话"而不只是"新建会话"；升级时 Room 与参与者两侧的历史衔接需要摘要规则（不整段回放）。
