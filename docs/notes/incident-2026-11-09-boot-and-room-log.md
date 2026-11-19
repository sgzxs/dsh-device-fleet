# 事故复盘：插件启动失败、Room 会话日志损坏与修复（2026-11-09）

这页记录 2026-11-09 桌面端上 `dsh-device-fleet` 的三段连环故障：**启动失败 → 会话日志不可读 → 修完日志后会话从侧栏消失**。写给要维护这个插件、或以后再遇到同类现象的人：每条都给出**现象、根因、修法、当次证据**，以及一份按症状查的处置手册。结论是：三处都已修复并验证，数据未丢失；真正的坑不是业务逻辑，而是**宿主（DSH 0.2.2-rc.1）的三条隐式契约**——client 槽位必须先声明后注册、自定义会话事件必须带 `ignorable`、会话日志 zstd 流的第一帧必须恰好是 header 行。

- 机器：Windows / 桌面端 `@deepseek-ai/dsh-desktop` 0.2.2-rc.1（Electron 44.7.0，Node 24.21.0）
- profile：`desktop`；插件以 `link:` 方式安装到 `C:\Users\PS\.dsh\plugins\dsh-device-fleet`，版本 `0.1.0-dev.33`
- 会话：`session-269260c9-…`（Room host，6668 事件）、`session-0b0af927-…`（Room host，7986 事件）

## 状态一览

| 事件 | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| A 启动失败 | 弹窗 `web boot: 1 entry did not activate / dsh-device-fleet: failed` | `client.js` 对 `shell.overlay` / `main` 直接 `slots.register`，早于 `dsh-client-ui-layout` 的槽位声明 | 已修复（`ctx.slots.inject`），浏览器实测通过 |
| B 会话不可读 | `contains event type "room/created" … not marked ignorable` | Room 事件用 `session.append()` 写入，缺少 `ignorable: true` | 已修复（改用 `appendPluginRecord`），两份日志已修 |
| C 会话消失 | 重启后侧栏找不到该会话，文件仍在 | 修 B 时把整份日志压成单一 zstd 帧，首帧不再是单独 header | 已修复（重写帧结构），逐行回读一致 |

三者的关系是**一条事故链**：A 让用户进了恢复模式（profile patch 被重置）；恢复后打开开发用的 Room 会话，暴露 B；修 B 时手写重压日志，引入 C。B、C 都只影响本地日志，网络层与 Fleet 配对数据未受损。

## 时间线（Asia/Shanghai）

| 时间 | 事件 |
| --- | --- |
| 20:03:42 | 插件管理器启用 `include:device-fleet`（dev.33），写入 profile patch |
| 20:05:25 / 20:05:32 | 桌面端启动失败，连续两次 web-boot 崩溃日志 |
| 20:05:47–56 | 用户点「禁用第三方插件、备份 profile patch 并重启」：patch 被重置为最小版，第三方 bundle 从 `package.json` 摘除 |
| 20:12–20:16 | 定位 A：client entry 在槽位声明前注册；修复并做复现/浏览器验证 |
| 20:21 | 恢复 profile patch 与 bundles；运行中的 app 热加载了 device-fleet（`fleet_status` 正常） |
| 20:26 | 用户打开开发会话，报 B（`room/created` seq 3568） |
| 20:28 | 修复 `RoomService` 写入路径；修复两份受影响日志（合计 21 条事件） |
| 20:32 | 用户重启后发现会话消失（C）；按首帧契约重写两份日志 |
| 20:33 之后 | 验证：首帧 = 199 字节 header、全文回读一致、旧类型 0 条 |

## 事件 A：client 半激活失败导致应用无法启动

### 现象（A）

桌面端启动即弹「应用无法启动或已意外停止」，正文只有两行：

```
web boot: 1 entry did not activate
dsh-device-fleet: failed
```

诊断报告里 `source: web-boot`、`phase: running`，但没有具体异常——因为这条信息的产生方**只输出入口名和 fiber 状态**。

### 根因（A）

- 失败来自**浏览器端**的 boot 审计，不是 Host 插件：前端在 `dsh-web-frontend` 里启动所有 client entry 后，逐个检查 fiber 状态，只拼接 `${name}: ${state}`，再把整段文本经 desktop IPC `bootFailed` 抛给主进程；主进程 `reportFatal(..., "web-boot")` 落盘并弹窗。
- `client.js` 的 `apply()` 里有两处**直接**注册：`ctx.slots.register({ name: 'shell.overlay' … })` 与 `{ name: 'main', key: 'fleet' }`。
- 这两个槽不是页面初始就存在的，而是由 `dsh-client-ui-layout` 的**根注册**声明（`root` 的 children 表里带 `main` 与 `shell.overlay`）。而 client entry 是**并发创建**的（`ClientEntries.start` 用 `Promise.all` 逐个 `loader.create`），谁先 apply 取决于各自依赖的服务何时就绪。
- 本插件只 `inject: ['slots']`，通常比 ui-layout 先 apply，于是注册抛 `slot "shell.overlay" is not declared (a parent entry's children table must declare it)`，整个 client entry 变 FAILED。旧版本能跑属于时序运气（代码注释里“dev.10 直接注册能渲染”就是那次侥幸）。

### 修复（A）

- `client.js`：`shell.overlay` 与 `main` 都改成 `ctx.slots.inject(slot, () => ctx.slots.register(...))`，等槽位声明到达后再注册——与所有官方 client 插件一致。
- `scripts/client-smoke.mjs`：槽位 mock 从“永远成功”改成真实语义（**未声明就抛**、`inject` 延迟执行），并新增断言：**任何槽位都还没声明时调用 `apply` 不能抛**，声明之后 8 个注册必须全部完成。这条测试在旧代码上会红。
- `src/plugin/index.js`：`const policy` 改为 `let policy`。live-config 回调会重新赋值，否则用户保存配置时抛 `Assignment to constant variable`。
- 恢复被恢复模式重置的桌面端 profile 补丁 `C:\Users\PS\.dsh\profiles\desktop\cordis.patch.yml` 与 `package.json` 的 bundles（`dsh-device-fleet`、`dsh-global-task-list`）。重置前的完整 patch 在 `cordis.patch.yml.bak-1794225947489`（恢复动作自动备份），重置后写出的最小 patch 另存为 `.bak-recovery` 作对比。

### 验证（A）

- 用严格槽位 mock 加载 `client.js`：旧代码在 `apply` 阶段抛 `slot "shell.overlay" is not declared`；新代码在零槽位声明时通过，声明后 8/8 注册。
- 用桌面运行时（0.2.2-rc.1）在**隔离 profile**（`base + web-app + task-list + device-fleet`，同一份 patch）启动，真实 Chromium 加载页面：boot 覆盖层消失、无 `Failed to load plugins`，正常进入「选择工作区」。
- 恢复后运行中的 app 热加载成功：`fleet_status` 返回本机 deviceId、直连 `0.0.0.0:60580`、发现开启。

## 事件 B：Room 自定义事件让整份会话日志不可读

### 现象（B）

打开开发会话报：

```
历史加载失败：failed to observe session "session-269260c9-…":
session "…" contains event type "room/created" (seq 3568)
unknown to this harness and not marked ignorable; refusing to interpret the log
```

### 根因（B）

- `RoomService.append()` 用 `session.append('room/created' | 'room/member' | 'room/message' | 'room/task' | 'room/closed', data)` 写自定义事件。
- DSH 持久化读路径（`dsh-session-persistence` 的 `validateStoredEvents`）只接受两类事件：`KNOWN_SESSION_EVENT_TYPES` 里的事件，或信封带 `ignorable: true` 的未知事件。`session.append()` 不会写 `ignorable`，于是任何 `room/*` 事件都会让**整份日志**被拒绝。
- 后果比“历史页打不开”更重：连写它的同一个 harness 也读不了自己的日志；而侧栏列举时对损坏日志是**静默跳过**（见事件 C），所以文件看似“消失”。

### 修复（B）

- [src/host/room-service.js](../../src/host/room-service.js) 的 `append()` 改为写**可忽略插件记录**：调用 `@deepseek-ai/dsh-session` 导出的 `appendPluginRecord(session, 'plugin:device-fleet/' + name, data)`。事件类型进入 `plugin:` 命名空间，且由 API 自行带上 `ignorable: true`；不认识的 reader 会保留并跳过，fork/resume 不会丢。
- 事件名改为 `room-created` / `room-member` / `room-message` / `room-task` / `room-closed`（前缀由 `append()` 统一加）。
- 兼容性处理：
  - `@deepseek-ai/dsh-session` 加为 peer 依赖；模块**按需动态 import**，因为纯 Node 单测没有运行时包树，顶层静态导入会让 `test/host.test.mjs` 直接起不来。
  - 写日志失败只告警一次并继续：Room 状态本来就会落 `rooms.json`，日志是审计副本，不该反过来阻断房间操作。
- [test/host.test.mjs](../../test/host.test.mjs)：注入 `appendRecord` 桩，断言写出的类型**只能是** `plugin:device-fleet/room-*`，防止回退。

### 已损坏日志的修复

新增 [scripts/repair-session-logs.mjs](../../scripts/repair-session-logs.mjs)：

- 把每条 `room/*` 原地改名为 `plugin:device-fleet/*` 并补 `ignorable: true`；**其余行逐字节保留**；
- 先备份原文件，再替换；替换前重新解压逐行比对，确认只有预期行变化、旧类型清零；
- 本机修复结果：`session-269260c9-…` 20 条（2 created / 3 member / 7 message / 7 task / 1 closed），`session-0b0af927-…` 1 条（1 created）。
- 用法与依赖见下方运行手册。

### 验证（B）

- 修复后两份日志解压逐行复核：旧 `room/*` 类型 0 条；所有改写的类型都在 `plugin:device-fleet/` 下且 `ignorable: true`；事件数量、seq 连续性不变（6668 / 7986 条事件）。
- 说明：Room 面板读的是 `rooms.json` 与内存状态，不依赖这些日志事件，因此改名不影响历史消息展示。

## 事件 C：修完日志后会话从侧栏消失

### 现象（C）

按 B 修好日志、重启 DSH 后，侧栏里找不到该会话；文件与目录都还在，重启也不报错。

### 根因（C）

- 第一次修复为了省事，把整份 JSONL（26 MB）重新压成了**一个 zstd 帧**。
- DSH 读会话 header 的方式是：只扫描并解压**第一个 zstd 帧**，然后 `assertZstdHeaderFrame` 要求这段明文**恰好是一行 header**（结尾一个换行、中间不能再有换行）。
- 单一帧里含 header + 全部事件，校验必然失败并抛 `SessionPersistenceCorruptionError`；`listArtifacts` 对“格式不支持/损坏”的捕获是 `metadata = undefined` 然后 `continue`——**静默跳过**，于是会话从列表里消失，启动日志里也不会留痕。
- 原始文件之所以正常，是因为它每次追加都写独立小帧：第一帧只有 199 字节的 header。

### 修复（C）

- 重写两份日志的帧结构：**第 1 帧 = header 行**（199 字节，含换行），其余事件按 4 MB 分帧（共 7 帧/份）。
- 校验方式与运行时一致：取第一帧单独解压，要求等于 header 行；再全量解压回读，要求与修复后的 JSONL **逐字节一致**。
- [scripts/repair-session-logs.mjs](../../scripts/repair-session-logs.mjs) 同步修正：生成同样的帧结构，并在替换前校验“首帧即 header”。

### 验证（C）

- `zstdDecompressSync(整份文件)` 只产出 199 字节的 header 行（证明首帧独立且只含 header）；更严格的 `newline count = 1` 检查通过。
- 全量解压：6669 / 7987 行，最后事件分别为 `turn/end` 与 `plugin:device-fleet/room-created`，与修复前内容一致。

## 变更清单

| 文件 | 变更 | 为什么 |
| --- | --- | --- |
| `client.js` | `shell.overlay` / `main` 改为 `ctx.slots.inject` | 消除与 ui-layout 的声明竞态（A） |
| `scripts/client-smoke.mjs` | 槽位 mock 改为真实语义；新增“零声明时 apply 不抛”断言 | 让同类竞态在单测阶段变红（A） |
| `src/plugin/index.js` | `const policy` → `let policy`；`RoomService` 传入 `warn` | live-config 重新赋值；记录写入失败可告警（A/B） |
| `src/host/room-service.js` | `append()` 改用 `appendPluginRecord`；事件名改 `room-*`；懒加载 `@deepseek-ai/dsh-session`；失败降级 | 自定义事件必须带 `ignorable`，否则整份日志不可读（B） |
| `test/host.test.mjs` | 注入 `appendRecord` 桩；断言类型前缀 | 防止写回 `room/*`（B） |
| `scripts/repair-session-logs.mjs` | 新增：扫描/修复旧日志，备份+逐行校验，按 DSH 帧结构重写 | 修复存量数据；避免重蹈 C |
| `package.json` | 新增 `@deepseek-ai/dsh-session` peer 依赖 | 运行时提供 `appendPluginRecord`（B） |
| `docs/notes/dev-release.md` | 两段 dev.33 修复记录 | 发布历史留痕 |
| 两个 session 的 `session.v4.jsonl.zstd` | 事件改名 + 补 `ignorable` + 重写帧 | 恢复可读性与侧栏可见性（B/C） |

## 运行手册（按症状查）

### 1. 应用启动失败，但摘要只有 `<name>: failed`

- 这是**前端 client entry** 失败，不是 Host 插件加载失败；摘要故意不带异常。
- 排查方向：`client.js` 的 `apply()` 里有没有**直接** `ctx.slots.register(<由别的插件声明的槽>)`。任何不是本插件声明的槽，都必须走 `ctx.slots.inject(slot, () => register(...))`。
- 复现手段：用真实槽位语义的 mock 跑 `scripts/client-smoke.mjs`（未声明即抛、inject 延迟），比浏览器快得多。

### 2. 打开历史报 `unknown event type … not marked ignorable`

- 某个插件用 `session.append()` 写了自定义类型。正确写法是 `appendPluginRecord(session, 'plugin:<pkg>/<name>', data)`。
- 存量日志用修复工具处理（先干跑，再 `--repair`）：

```powershell
# zstd CLI 不在 PATH 时指定；多帧解压必须用 CLI，Node 的 zstd 只解第一帧
$env:ZSTD_PATH = 'D:\Anaconda\Library\bin\zstd.exe'
node scripts/repair-session-logs.mjs 'C:\Users\PS\.dsh\sessions\--C-Users-PS-.dsh--\session-269260c9-d6b9-4cf6-b142-deda4d629524'          # 只报告
node scripts/repair-session-logs.mjs 'C:\Users\PS\.dsh\sessions\--C-Users-PS-.dsh--\session-269260c9-d6b9-4cf6-b142-deda4d629524' --repair # 备份并改写
node scripts/repair-session-logs.mjs 'C:\Users\PS\.dsh\sessions' --all --repair                                                        # 全量体检
```

### 3. 日志文件在，侧栏却没有该会话

- 先看**第一帧**：解压整份文件，`zstdDecompressSync` 只会吐出第一帧。如果它不等于 header 行（不是“恰好一行”），就会被当作损坏**静默跳过**。
- 直接用同一个修复工具重写帧结构即可（它会保留内容、只重建帧）。
- 注意：会话目录里的 `*.bak-*` 备份不参与列举，别被它们误导。

### 4. 修复后仍要确认

- 事件数量、`seq` 连续性、末事件类型是否与修复前一致；
- 旧类型是否清零；
- 应用里刷新页面后会话是否出现（列表在页面加载时拉取）。

## 数据与备份

| 路径 | 内容 | 处置 |
| --- | --- | --- |
| `sessions/<workspace>/<session>/session.v4.jsonl.zstd` | 修复后的会话日志 | 当前使用 |
| 同目录 `*.bak-room-events-*` | **修复前**的原始日志（仍含 `room/*`，不可直接使用） | 保留作回滚证据 |
| `profiles/desktop/cordis.patch.yml.bak-1794225947489` | 恢复模式重置**前**的完整 patch | 保留（回滚依据） |
| `profiles/desktop/cordis.patch.yml.bak-recovery` | 恢复模式重置**后**写出的最小 patch | 保留（对比用） |
| `profiles/desktop/package.json.bak-recovery` | 恢复模式重置后的 package.json | 保留（对比用） |
| `profiles/desktop/device-fleet/` | Room/审批/身份状态（`rooms.json`、`config-overrides.json`、`identity.json`） | 不要删；Room 历史在这里 |

排查过程中产生的单帧临时备份（`*.bak-singleframe-*`）已删除，它们对新读取器无价值。

## 验证记录（本次实跑）

| 项 | 命令/方式 | 结果 |
| --- | --- | --- |
| Host 单测 | `node test/host.test.mjs` | 19/19 通过 |
| 网络单测 | `node test/net.test.mjs` | 10/10 通过 |
| Client smoke | `node scripts/client-smoke.mjs` | 零声明 apply 通过、8 个注册、各视图渲染通过 |
| 启动端到端 | 隔离 profile + 桌面运行时 + 真实 Chromium | 无 `Failed to load plugins`，进入工作区选择页 |
| 会话内容 | `zstd` 解压 + 逐行比对 | 21 条事件改写，其余行逐字节一致；旧类型 0 条 |
| 会话 header | 首帧单独解压 | 199 字节、仅一行、`id/version=4` 正确 |
| 侧栏可见性 | 用户刷新/重启后确认 | 待用户确认（文件层校验已全部通过） |

明确未验证：没有用自动化手段驱动桌面端 Electron 页面枚举侧栏（桌面 profile 被主进程独占，且无远程调试端口）；侧栏可见性依据的是与运行时一致的首帧/全量校验，而非直接读 UI。

## 遗留与建议

1. **离线包已过期**：`dsh-device-fleet-0.1.0-dev.33.tgz` 是在两轮修复之前打的，分发给其他设备前必须重打 `npm pack`，或升版本重发。
2. **版本号策略**：这次没有升版本，是为了避免与另一台仍跑 dev.33 的设备在严格版本匹配（ADR-0024）下互相拒绝。正式分发时建议发 `0.1.0-dev.34`，并把两边一起升级。
3. **把不变量变成门禁**：`client-smoke` 已覆盖槽位竞态；建议再加一条“会话日志写入类型必须是 `plugin:` 前缀”的单测（当前靠 `test/host.test.mjs` 的断言），以及发布前跑一次 `repair-session-logs.mjs` 的干跑。
4. **观察到的宿主行为**：不可读会话在列表阶段是静默跳过，只有按 id 打开才会报损坏原因。插件侧能做的是绝不再写非法事件；需要更强的诊断时，可在启动日志里 grep `SessionFormatUnsupportedError` / `SessionPersistenceCorruptionError`。
5. **Room 事件语义**：`plugin:device-fleet/*` 是**审计副本**，权威状态仍在 `rooms.json`；后续若要做跨设备回放，读取方必须按 `pluginRecordOf` 的方式解析，不能假设 harness 认识这些类型。

## 复核记录（2026-11-09 20:40，恢复会话后）

按本页记录逐项复核，结论：A/B/C 的修复均已在代码和运行态生效。

| 项 | 复核方式 | 结果 |
| --- | --- | --- |
| A：槽位声明竞态 | `client.js` 全部 8 个槽位改为 `ctx.slots.inject`；`node scripts/client-smoke.mjs`（未声明即抛、inject 延迟） | 零声明时 apply 通过，声明后 8/8 注册；`all deferred slot registrations ran: 8` |
| B：Room 事件不可读 | `room-service.js` 使用 `appendPluginRecord`（`plugin:device-fleet/room-*`），测试桩断言前缀；解压两份日志统计类型 | 旧 `room/*` 类型 0 条；`plugin:device-fleet/*` 记录 20 条（269）+1 条（0b0） |
| C：首帧 header | `zstdDecompressSync` 只解第一帧 | 两份日志首帧均 199 字节、换行数 1、header 正确 |
| 全量日志体检 | `repair-session-logs.mjs <sessions> --all` | 137 份会话日志，`changed: 0`，无错误 |
| Host/网络/Client 测试 | 三个测试脚本 | Host 19/19、网络 10/10、client smoke 全过 |
| 侧栏可见性 | 当前会话即修复后的 `session-269260c9-…`，可正常继续对话 | 已由用户实际使用确认（此前记录的“待确认”已关闭） |

复核中发现并修复一个**工具环境问题**：`repair-session-logs.mjs` 原先无条件在 `os.tmpdir()` 下 `mkdtemp`，在受限 sandbox/ACL 下会报 `EPERM: operation not permitted`，导致干跑直接失败。现已改为失败时回退到 `./.repair-tmp`，两份日志干跑与 `--all` 体检均可正常执行。

另外完成发布一致性处理：源码在事故修复后未改版本（仍是 dev.33），旧 tarball 时间为 20:03、早于修复代码（20:40），按本页“遗留与建议”第 1/2 条升级为 **0.1.0-dev.34** 并重新 `npm pack` / 发布；另一台设备需同步升级到 dev.34（严格版本匹配 ADR-0024）。

## 术语

- **ignorable 插件记录（plugin record）**：类型为 `plugin:<pkg>/<name>`、信封带 `ignorable: true` 的会话事件。旧 reader 会保留但跳过，不影响会话解释；是 out-of-repo 插件写会话日志的唯一安全方式。
- **header 帧**：`.jsonl.zstd` 的第一个 zstd 帧，必须**恰好包含一行**会话 header（`{"type":"session","version":4,…}`）。后续帧才是事件。
- **web boot**：桌面端页面启动插件的阶段；其失败由前端审计后经 IPC 上报主进程，往往只带入口名与状态。
- **Room host session**：被 `room_create` 升级为房间宿主的普通 DSH 会话；房间的权威日志以插件记录形式追加在它的会话日志里，房间状态另存 `rooms.json`。
