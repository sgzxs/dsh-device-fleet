# DSH Device Fleet

让登录同一 DeepSeek 账号、且都安装互联插件的多台设备上的 agent 与工具互相可用，使用时像在同一台设备上。

## Language

**设备 (Device)**:
一台运行 DSH 的机器，有自己的 Host、会话、工作区、文件系统与工具集。
_Avoid_: 节点, 客户端, 实例

**Fleet (设备联邦)**:
一组经显式入网、互相信任的设备的集合；只有同一 Fleet 的成员可以互联。
_Avoid_: 账号设备组, 集群, 网络

**入网 (Enrollment)**:
把一台新设备加入 Fleet 的一次性动作：由已有成员签发邀请，新设备接受后成为成员。
_Avoid_: 配对, 关联, 绑定

**邀请 (Fleet Invite)**:
一份一次性、会过期的 Fleet 入网凭据，携带 Fleet 标识、会合信息与一次性 token。
_Avoid_: 配对码, 二维码（后者只是邀请的载体）

**Fleet 成员 (Fleet Member)**:
已入网的一台设备，在 Fleet 成员表中占一条记录，带设备身份、能力档位与撤销状态。
_Avoid_: 节点, 对端（对端只是单次连接的视角）

**账号 (Account)**:
设备本机登录的 DeepSeek 账号；Fleet 要求成员登录同一账号，用于成员校验与账号切换隔离。
_Avoid_: 用户, 登录, 身份

**账号指纹 (Account fingerprint)**:
只在 Fleet 内比较、不暴露原始账号 ID 的账号校验值；用于拒绝不同账号的设备，以及账号切换后的旧连接。
_Avoid_: 账号 ID, 账号哈希, token

## Collaboration

**Room (协作房间)**:
一个跨设备的共享协作容器，以事件日志副本的形式存在于参与设备上；包含消息、成员、任务板与策略，最终一致、可离线继续。
_Avoid_: 群, 频道, channel, 单一权威日志

**Room 副本 (Room Replica)**:
一台设备上某个 Room 的完整本地副本，包含事件日志与快照；同一设备上属于同一 Room 的多个 session 共用一份副本。
_Avoid_: Mirror, 镜像, 缓存, 影子（旧模型里只读影子已废弃）

**Snapshot (快照)**:
从事件日志压缩出的某一时刻状态，用于快速加载与同步；不替代事件历史。
_Avoid_: 备份, 存档

**Room 索引 (Room Index)**:
账号级维护的 Room 元数据列表（roomId、标题、密钥引用、最后已知成员位置）；用于跨设备发现 Room，独立于副本是否仍在本地。
_Avoid_: 房间列表, 目录

**Member (Room 成员)**:
参与某个 Room 的一个 agent session；session 存在即成员，同一设备可有多个成员。
_Avoid_: Participant（旧设备级参与者概念）, 用户, 节点

**User (用户)**:
账号所有者本人，是每个 Room 的 Room 级单例成员，跨设备同一身份；User 的发言带 `viaDeviceId` 审计来源。
_Avoid_: 账号（账号是登录身份）, 设备用户, 客户端用户

**Creator (创建者)**:
创建该 Room 的成员；创建本身授予初始邀请权，不代表持续权威。
_Avoid_: Host, 房主, 管理员

**Coordinator (协调者)**:
可选的初始引导者或首选同步源（通常是 Creator 所在设备）；可随时离线，不具有写入特权。
_Avoid_: Host, 服务端, 服务器, 主控

**Room Invite (房间邀请)**:
已有成员签发的一次性 Room 加入凭据，携带 roomId、room key、有效期与角色；新成员凭它加入并追加 join 事件。
_Avoid_: Fleet Invite（那只是 Fleet 入网）, 二维码

**Room Key (房间密钥)**:
Room 的加入与事件校验凭据；成员移除时轮换，用于阻止被移除设备继续同步新事件。
_Avoid_: 密码, token, Fleet key

**Room Policy (房间策略)**:
房间的管理规则（邀请权、加入方式、成员上限、任务板写权限等）；以带签名的策略事件记录并最终一致。
_Avoid_: 权限, 设置, 房规

**Room Type (房间类型)**:
Room Policy 的命名预设（内置或用户保存，如私密/团队/只读），创建房间时解析成一份 Room Policy。
_Avoid_: 模板, 模式

**Room Event (房间事件)**:
追加式、由设备签名的一条状态变更记录，例如消息、成员加入/移除、任务变更、策略变更；Room 的状态由事件推导。
_Avoid_: 日志行, 消息（消息只是事件的一种）

**Room Visibility (房间可见性)**:
User 可见 Room 的全部事件与聊天；agent 成员只可见唤醒它的交接消息与分配给它的任务，不读取完整聊天历史。
_Avoid_: 权限, 隐私模式

**Addressing (点名)**:
Room 消息的显式收件人集合；只有被点名成员会被唤醒，未点名成员不跑模型；可见性由 Room Visibility 决定，不由 Addressing 决定。
_Avoid_: @（只是显示形式）, 广播（`*` 是点名的广播特例）

**Wake (唤醒)**:
让某个成员在其设备上跑一轮模型的动作；由点名消息或 Task 分配触发，按 `eventId + memberId` 幂等。
_Avoid_: 通知, 启动, 触发

**Participant Brief (参与者任务简报)**:
唤醒一个成员时给它的最小交接上下文：点名消息原文与被分配的 Task；不包含完整 Room 历史。
_Avoid_: 房间历史, 全量上下文, 会话记录

**Room Board (房间任务板)**:
与 Room 同生命周期的共享结构化状态（目标、Task Block、负责人、依赖、产物指针），以事件同步、CRDT 合并。
_Avoid_: 任务列表, 面板数据, 全局任务库

**Task Block (任务块)**:
Room Board 上分配给某个成员的一段可独立开始与完成的工作单元；串行块完成后触发下一块交接，并行块互不影响。
_Avoid_: 任务, 子任务, 工单

**Room Upgrade (房间升级)**:
把一个当前会话初始化为 Room 的创建者与首个成员，并可选地邀请其他成员加入的动作；保留双方上下文。
_Avoid_: 转房间, 升格, 建房

**Local Team (本地团队)**:
成员 agent 在自己设备上使用的 Agent Team / subagent 集合；其 session 可以各自加入 Room 成为 Member，也可以保持私有。
_Avoid_: 小团队, 下属, 子房间

**Delegation (委派)**:
成员 agent 把一次性任务交给另一台成员设备上的 agent 执行并取回结果；被委派方使用独立的一次性子会话，不进入 Room、不共享房间历史。
_Avoid_: 协作, 派发, 远程调用（那是工具直调）

## Execution

**Direct Call (直调)**:
A 的 agent 直接调用目标设备上的一个 tool 并取回结果的一次性调用；不进入 Room、不创建 Member、不读取目标设备的对话上下文。
_Avoid_: 远程调用（太泛）, RPC, 工具桥

**Execution Slot (执行槽)**:
目标设备上由插件管理的隐藏执行上下文，只提供 cwd、沙箱与审批路由；不跑模型、不进 Room、不保存对话历史。
_Avoid_: 影子 agent, 执行会话, 沙箱容器

**Tool Policy (工具策略)**:
目标设备插件对"其他设备的直调"的授权规则，按设备与工具粒度决定免审批、需本机审批或拒绝；由资源所有者设备制定。
_Avoid_: 权限位, ACL, 白名单（白名单只是其中一种手段）

**Fleet Tool (设备无关能力函数)**:
以 `device` 参数指定目标设备的直调工具；统一入口为 `fleet_call(device, tool, parameters)`，另有少量高频 typed 快捷工具（`fleet_read` / `fleet_fetch` / `fleet_run`）。
_Avoid_: 远程工具, 镜像工具, MCP tool
