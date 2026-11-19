# fleet_call 统一执行入口 + 少量 typed 快捷工具

## Status
accepted

## Context
纯 typed 能力目录要求每台设备、每个新工具都同步进插件工具表；纯 `fleet_call` 又让模型拿不到目标工具的精确 JSON Schema，复杂参数会在目标设备校验失败、白跑一次往返，且必须先查目录。

## Decision
直调只有一个执行原语：`fleet_call(device, tool, parameters)`。
- `fleet_tools(device)` 返回目标设备**可被远端调用**的工具名、JSON Schema 与 Tool Policy 摘要；
- `fleet_call` 的 `parameters` 在目标设备按其真实 schema 校验，错误原样回传；
- 另注册少量高频 **typed 快捷工具**：`fleet_read` / `fleet_fetch` / `fleet_run`，它们只是 `fleet_call` 的薄包装，提供精确 schema 与更好的 function-calling 保真度；
- 任何设备新增的工具无需插件升级即可通过 `fleet_call` 使用（仍受该设备 Tool Policy 约束）；快捷工具集合可配置。

## Considered Options
- 纯 typed 能力目录——新增工具要改插件，否决。
- 纯 `fleet_call`——参数保真度差、发现往返多，否决。
- 动态按需镜像（查目录后临时注册 typed 工具）——会动态改工具表、打掉 KV cache，复杂度高，否决。

## Consequences
工具表固定为 `fleet_list` / `fleet_tools` / `fleet_call` + 三个快捷工具；模型对未 typed 工具需先 `fleet_tools` 发现；审计与限额统一在一条执行路径上做。
