# 直调工具面：设备无关的能力函数 + device 参数

## Status
accepted；amended by ADR-0014 —— 能力目录改为 `fleet_call` 统一入口 + 少量 typed 快捷工具；本文中"设备无关、device 参数、Execution Slot 映射、稳定错误码"仍然有效。

## Context
把每台设备的远程工具都镜像到本地，会让工具表随"设备数 × 工具数"膨胀，设备上下线还会改变 schema、打掉 KV cache；而纯通用的 `remote_call(device, tool, args)` 又要求模型先查目录，不够"原生 function calling"。

## Decision
直调工具注册为**与设备无关的固定函数**，统一带 `device` 参数（设备 id 或唯一名）：
- `fleet_list()` 返回成员 id/名称/在线状态/能力/Tool Policy 摘要；
- 能力函数按固定目录、在所有设备上同构注册，例如 `fleet_read(device, path, ...)`、`fleet_list_dir(device, path)`、`fleet_grep(device, pattern, path)`、`fleet_fetch(device, path, ...)`、`fleet_run(device, command, cwd?, timeoutMs?)`；
- `device` 在 schema 中用字符串而不是枚举：schema 保持稳定（KV cache 友好），运行时按 Fleet 成员表校验；
- 目标设备把能力映射到本地 tool（如 `fleet_read` → `read`），以 Execution Slot 执行；是否免审/需审批/拒绝由该设备的 Tool Policy 决定；
- 未纳入目录的冷门工具可通过可选的 `fleet_call(device, tool, args)` 兜底（默认关闭）。

## Considered Options
- 每设备镜像工具——schema 随设备变化、工具表膨胀，否决。
- 纯通用 `remote_call` + 目录查询——每次新工具都要先查一次，不够原生，否决。
- MCP 桥接——无 wait/cancel 语义、本构建无 server SDK，不作为核心路径，否决。

## Consequences
需要一张"能力 → 本地工具"映射表与稳定错误码（`device_not_found` / `offline` / `unsupported` / `denied` / `approval_timeout` / `tool_failed`）；能力目录按插件版本固定，设备间能力差异靠运行时校验；模型需要先用 `fleet_list` 拿到 device id。
