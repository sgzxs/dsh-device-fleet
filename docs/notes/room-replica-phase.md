# Room 副本容器：实施阶段

依据 [ADR-0025](../adr/0025-decentralized-room-replicas.md) 与 `CONTEXT.md` 的新术语。每个阶段都要可独立验证，避免一次性重写。

## Phase 0：文档与词汇（完成）

- 更新 `CONTEXT.md`：Room / Room Replica / Snapshot / Room Index / Member / User / Creator / Coordinator / Room Event / Room Visibility 等；
- ADR-0025 记录去中心副本的架构决定；
- 本文件记录实施切分。

## Phase 1：本地 Room Replica 基础（A 侧完成，B 侧待更新验证）

目标：每台设备上同一 Room 只有一份**可写**副本，先不改变同步方式（仍可从旧 Host 拉状态作为过渡）。

**状态（dev.86）**：`src/host/room-replica.js` 已实现事件日志/快照/索引/session 映射；插件启动时把旧 `rooms.json` 一次性迁移；RoomService 全部写路径已 write-through；A 侧 authority Room 的 `/device-fleet/room` 已切到副本读取（实测 49 消息/4 成员/1 任务与旧数据一致）。B 的 mirror Room 仍走原有本地优先读取路径，等 B 更新到 dev.86 并进入 Phase 2 再统一切换。

- 新存储布局：`<dataDir>/rooms/<roomId>/events.jsonl` + `snapshot.json` + `index.json`；
- 事件信封：`v, roomId, type, author {kind, memberId?, sessionId?, deviceId?}, lamport, parents, signature, payload`；
- 设备级 Room Index：账号下 Room 列表、key 引用、最后已知成员位置；
- 把现有 `rooms.json` 的 Room / 成员 / 消息一次性导入事件日志（迁移工具 + 幂等标记）；
- 同设备多 session 共用副本：session ↔ member 映射在本地索引中维护；
- Room 视图 / 成员 / 消息先从副本读取；写路径暂时保留旧桥，逐步替换。

验收：重启后副本、索引、成员映射恢复；旧 Room 迁移后内容一致；同设备两个 session 看到同一份 Room。

## Phase 2：事件同步协议（完成）

目标：设备之间交换缺失事件，Room 可以没有 Host 继续同步。

**状态（dev.89）**：`RoomReplicaSync` 已实现 `room.sync.hello/pull/push`，事件带 `origin/originSeq`，支持并行探测、最领先者拉取、回推缺失事件；B 的 mirror Room 打开/`room.wake`/mirror 发送/手动 `room_sync` 时自动从 A 拉取事件并 remap 到本地 mirror，随后把 replica state 应用到 RoomService；legacy 历史通过一次性 `room.snapshot` bootstrap 对齐。真机结果：B `room_sync` 首次 `imported=1 (bootstrap), messages=53`，第二次 `imported=0`；A 发消息触发 B wake 后 B 自动同步，A/B 消息数一致（55），A 事件日志 61 个事件。

- RPC：`room.sync.hello {roomId, vectorClock, capabilities}`、`room.sync.pull {eventIds/ranges}`、`room.sync.push {events}`；
- 版本化 JSON 事件 + capability 协商；未知事件类型保留但忽略应用；
- 同步触发：被唤醒、发送消息、打开/聚焦 Room、重连；Room 视图打开时周期 anti-entropy；
- 同步源：并行探测所有可达 Room 成员，选择 vector clock 最领先者；只有“至少一个成员”的设备是持久源；
- 本地 pending 事件队列；推送失败保留到下次触发；
- Merkle / 事件哈希校验可先用事件签名 + eventId 唯一性，后续再加。

验收：两台设备在线/离线切换后最终一致；无 Host 时可从任一成员补齐；重复事件幂等。

## Phase 3：CRDT 状态与本地写入（完成，真机通过）

目标：消息、成员、任务、策略都通过副本事件合并，User / agent 都可以本地写入。

**状态（dev.95）**：消息/任务 mirror 本地写入 + push 权威、A `applyExternalEvents`（message/task/member/policy）均真机验证；Task 字段级 LWW 在 RoomService 与 RoomReplicaStore 两侧都生效（dev.95 修复副本重放整 task 覆盖导致 status 回退的问题）；`room_policy_update` 与 member 事件可在 mirror 本地写并同步；Participant Brief 带任务，`room_messages` 对 participant agent scoped。真机：B 创建 `B LOCAL TASK 94`、status=running→A 收到；A status=done 与 B note 字段合并为 done+note；B policy maxMembers=9 同步到 A；B 移除 B-agent2 后 A/B 成员都变 3，随后重新邀请恢复 4。剩余（非 Phase 3 阻塞）：字段级 OR-Set 依赖、Room key/生命周期属于 Phase 4。

- 消息：append-only，按 Lamport + eventId 排序；Addressing 只决定唤醒；
- 成员：OR-Set（join / leave / remove 事件）；
- Task：字段级 LWW + OR-Set 依赖；Room Policy：LWW（受权限限制）；
- `room_reply`、Room 视图发送、任务操作本地 append → pending → 同步；
- Participant Brief：从副本构造“点名消息 + 分配任务”，不把完整历史给 agent；
- Agent 工具可见性：`room_members` 可用；`room_messages` 仅返回该成员被交接 / 相关的消息或禁用（按实现选择）；
- User 视角：共享完整 Room Replica 视图，所有本地 session 打开同一 Room 看到同一状态。

验收：两个设备并发发消息 / 改任务后合并结果一致；agent 只能拿到 Brief；User 能看到全部事件。

## Phase 4：生命周期、权限与密钥（完成，dev.100）

**状态（dev.100）**：Room 创建生成并持久化 room key；`room_invite_create` / `room_invite_accept` 打通 invite 加入；A RPC `room.invite.accept` 校验 key 后添加 remote member；本地/外部成员移除都会轮换 key；`room_leave` 在 mirror 上关闭并删除本地 mirror（孤儿 mirror 启动清理）；`RoomService.close` 通过 `onClosed` 向远端发送 `room.closed` 并清理 mirror/local replica；`RemoteRoomPeer.wake` 按 `roomId:messageId` 去重；Room 事件用设备 Ed25519 密钥签名、peer 用 roster 公钥校验，导入丢弃签名无效事件（历史无签名事件按 legacy 接受）；`room.sync.*` 要求调用 device 是 Room 成员；新增 `room_remove_device` 级联移除设备成员并轮换 key；关闭通知/级联/签名均有单测，关闭广播真机因需新建测试 Room 暂以单测覆盖。

**原始目标**：Room Invite + room key；成员移除追加 remove 事件 + key 轮换；Device 移除级联；Room 索引长期保留；唤醒幂等。

验收：成员移除后旧设备不能再同步新事件；重启 / 重连后不重复唤醒；Room 在 Host 缺席时仍可运行。

## Phase 5：迁移、多设备与发布（进行中）

**状态（1.0.3）**：旧 Host/Mirror 路径保留为兼容桥；双设备（desktop-ui ↔ laptop）完成 invite/leave、消息/任务/字段级 CRDT、签名/成员校验真机测试；签名 canonical 排除本地 `seq/prev`，跨 mirror remap 后可复验（真机 B 写入事件 `origin=B signed=True verified=True`，A/B 均 74 条消息）；历史坏 snapshot 保留在 append-only 日志但已被 local-only 修复快照覆盖、不参与同步，compaction 作为后续维护项；同步状态 UI 尚未加；稳定版 1.0.3 发布（1.0.0→1.0.1 修 store 未接签名，1.0.2 修 remap 验签，1.0.3 修 seq/prev canonical）。

- 旧 Host / Mirror 路径替换或降级为只读兼容：保留（Phase 6 清理）；
- 三台以上设备同步/冲突/性能：当前环境只有 2 台，未覆盖；
- 同步状态 / pending / 冲突 UI：未做；
- 文档与稳定版发布：完成；
- 历史坏事件 compaction：未做，已知无害（local-only 且被修复快照覆盖）。

## Phase 7a：旧 mirror-send 桥移除 / 本地唤醒（1.3.0 完成）

**状态（1.7.0）**：Room/协作核心补齐：
- `signedRoomId`：事件记录原签名 logical roomId，跨 mirror 重映射后可复验；本地事件重映射时重签；
- mirror 之间 peer sync：B/C mirror 可互相 hello/pull/push（自动尝试连接其他成员设备），不再只依赖 A；
- creator 元数据启动回填：旧 authority Room 自动补 creatorMemberId/creatorDeviceId，并广播 room.creator 事件；
- `room_archive` / `room_delete` / `room_gc` 工具（archive/delete 目前是 admin/agent 工具入口，无独立 UI 按钮）；
- `fleet_remove_device` 工具 + Room 头部「移除 Fleet 设备」按钮：Fleet roster 删除、断连、级联移除所有 Room 成员、清 peer hints；
- Room 详情 sync 增加 `pendingEvents`，Client badge tooltip 显示 pending 事件类型/origin；
- Host 45/45、net 12/12、perf 1/1、client smoke 通过；A 1.7.0 真机验证 creator 回填、archive/unarchive、room_gc、fleet_remove_device 错误路径。
- 待真机：B 更新 1.7.0 后跨设备验证；3+ 设备 mirror 互同步；archive/delete UI 按钮仍可后续补。

**Phase 7 仍缺（架构级）**：真正多成员无 Host 的协调/唤醒路由、Creator/Coordinator、通用事件 GC、room key 静态加密与签名 invite、Device/Fleet 移除 UI、性能压测。

**状态（1.2.0 真机）**：Room 详情返回 `sync`，Client Room 头部显示副本角色/待同步数；远程导入启用 `requireSigned`；启动 `compactSnapshots` 清理历史坏 snapshot（A 实测 snapshot 2→1、状态不变）；启动 `resignLocalEvents` 重签全部本地历史事件（A 实测 26 条本地事件签名复验全部通过）；room key 在 `room.sync.hello` 下发给成员并在 pull/push 校验（B 1.2.0 同步成功）；Task dependsOn 改为 add-only OR-Set；invite 预检 RPC 生效（B 用旧 key invite 返回 `invite-invalid`，未创建本地 session）；Client 增加「邀请码」按钮，A HTTP 路由实测返回 code；RemoteRoomPeer 持久化 backfill cursor；close 广播真机通过（worker-c 测试 Room 关闭后 B mirror 返回 unknown-room）。Host 40/40、net 10/10、client smoke 通过。

**仍未完成（架构级，需单独阶段）**：
- 移除旧 Host/Mirror 兼容桥、完全无 Host 运行；
- Coordinator/Creator 语义、Room 索引长期保留/User 归档/删除；
- 通用事件日志 compaction/GC（目前只压缩 snapshot）；
- room key 静态加密与签名 invite（目前明文/仅传输保护）；
- Device/Fleet 移除 UI（目前只有工具）；
- 性能/大日志压测与更细的 pending/冲突操作 UI；
- 3+ 设备真机（当前环境限制）。

- **最终一致窗口**：UI 必须明确 pending / 同步状态，不能假装强一致；
- **安全**：明文本地副本无法回收已同步数据，成员移除只能阻止后续同步；
- **存储增长**：保留全部事件 + 快照，需要后续 compaction / 归档策略；
- **迁移风险**：旧 Room 导入必须幂等、可回滚；
- **复杂度**：先 Phase 1/2 打通单 Room 双设备，再扩多设备 / 多 Room。
