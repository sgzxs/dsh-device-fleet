# 跨设备调用实测（2026-11-09，dev.6）

环境：A `desktop` / `50fdaf90-…`（端口固定 60580）；B `laptop` / `c2d42572-…`（dev.6，同一热点）。
测试文件：A `E:\Dsh_test\hello-from-A.txt`；B `E:\Dsh_test\hello-from-B.txt`。

## 结果

| # | 调用 | 结果 | 耗时 |
|---|---|---|---|
| 1 | `fleet_read(B, E:/Dsh_test/hello-from-B.txt)` | ✅ 返回 `hello from device B` | 48ms |
| 2 | `fleet_call(B, tool="read", {file_path:…hello-from-B.txt})` | ✅ 返回同一内容（原始工具直调） | 4ms |
| 3 | `fleet_fetch(B, hello-from-B.txt)` | ✅ 返回文本 | 1ms |
| 4 | `fleet_run(B, "echo hello-from-B")` | ⚠️ `approval_denied`（B 策略 run=ask，审批 UI 未实现，fail-closed 正确） | 即时 |
| 5 | `fleet_delegate(B, "读取 hello-from-B.txt 并原样返回")` | ✅ B 的 agent（spawn 子会话 `1a768f89…`）读文件并回传最终文本 | 2.7s |
| 6 | `fleet_delegate(B, "用 fleet_read 读 A 的 hello-from-A.txt 并原样返回")` | ✅ B 的 agent 反向调用 A 的 `read`，回传 `hello from device A (fleet test)`（子会话 `515f8c1b…`） | 2.5s |

## 结论

- v1 直连 + 端到端加密 + 配对/roster 固定公钥：**通过**；
- 直调（typed 快捷工具 / `fleet_call` 原始工具 / fetch）：**通过**；
- Tool Policy 与 fail-closed 审批：**按设计生效**；
- 跨设备委派（B 的 agent 在本机执行并回传；B 的 agent 反向调 A 工具）：**通过**；
- 遗留：审批收件箱 UI（`run`/`delegate` 的 `ask` 档目前只能拒绝或配置 auto）；Room/Room Board/设备页 UI 未开始；委派返回文本里 `[reasoning]` 是结果里的 reasoning block 展示，可后续过滤。

## 复现命令（A 侧）

```
fleet_list()
fleet_read(device="c2d42572-…", path="E:/Dsh_test/hello-from-B.txt")
fleet_call(device="c2d42572-…", tool="read", parameters={file_path:"E:/Dsh_test/hello-from-B.txt"})
fleet_delegate(device="c2d42572-…", task="读取 E:/Dsh_test/hello-from-B.txt 并原样返回")
fleet_delegate(device="c2d42572-…", task="用 fleet_read 读设备 50fdaf90-… 的 E:/Dsh_test/hello-from-A.txt 并原样返回")
```
