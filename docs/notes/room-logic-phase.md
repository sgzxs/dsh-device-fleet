# Room 逻辑层实测（2026-11-09，dev.8，单机模拟参与者）

在当前这台 DSH 内，用两个**真实本地 session/agent** 充当 Room 参与者，验证寻址唤醒与看板串行交接，不依赖第二台设备。

## 流程与结果

1. `room_create` → roomId = 当前会话 `session-269260c9-…`，host 成员 `host:session-269260c9-…`。
2. `room_add_local(name="worker-a", cwd=E:/Dsh_test)` → 真实 session `session-d063026e-…`。
3. `room_send(to=[worker-a], text="读取 hello-from-A.txt 并用 room_send 回复 host")` → `woke worker-a`；
   - worker-a 的 agent 真实跑了一轮模型 + 本机 `read`，并在 3.4s 内调用 `room_send` 回传 `hello from device A (fleet test)`；
   - transcript 两条消息，完整可见。
4. `room_add_local(name="worker-b")`；看板：
   - taskA `读取 hello-from-A.txt` owner=worker-a；
   - taskB `汇总读取结果` owner=worker-b，`dependsOn=[taskA]`；
   - taskC `并行：独立检查` owner=worker-a，无依赖。
5. `room_task_update(taskA, done)` → 返回 `handed off to worker-b`；worker-b 被点名唤醒，30s 内完成汇总并 `room_send` 给 host（内容含前序结果、交叉校验、并行任务仍 pending 的说明），同时把自己 taskB 置为 running。
6. `room_task_list`：taskA done、taskB running、taskC pending（并行任务未被串行交接影响）。
7. `room_close`。

## 结论

- Room 生命周期、成员管理、寻址消息、未点名不唤醒、host 权威日志：单机逻辑通过；
- Room Board `dependsOn` 串行交接 / 并行任务不阻塞：真实 agent 验证通过；
- 参与者使用的都是真实 DSH agent（各自 session），不是 mock。

## 限制（下一步）

- 远程参与者传输（把 local participant 换成远端设备成员）尚未接入；
- Client 面板/房间视图未做（用户无法在 GUI 直接看 room 时间线/看板）；
- 房间状态在插件内存 + host session 事件里，插件重载后需要 rehydrate（未实现）；
- 房间策略仅存储，尚未强制（invite/join/maxMembers 中 maxMembers 已生效）。
