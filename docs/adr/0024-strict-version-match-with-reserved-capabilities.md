# 协议版本严格同版本，能力字段预留

## Status
accepted

## Context
插件会升级，Room Board 与工具面也会演进；如果握手只校验协议版本、不校验插件版本，会出现"能连上但行为不一致"的隐藏 bug；而 v1 阶段设备数量少、升级由用户自己控制，做完整能力协商性价比低。

## Decision
- 握手交换并校验 **`protocolVersion`、`pluginVersion`、`dshVersion`**，并预留 `capabilities[]` 字段（v1 只交换与记录，不做降级）。
- v1 采用**严格同版本**：`protocolVersion`、`pluginVersion` 必须一致；`dshVersion` 必须属于同一发布线（core `major.minor.patch` 相同，允许 prerelease 后缀不同，例如 `0.2.2-rc.1` 与 `0.2.2-rc.2`）。不匹配直接拒绝，返回可操作的错误（"两端插件版本不一致，请把两台设备都升级到 x.y.z"）。
- `dshVersion` 放宽仅限 prerelease 后缀：跨 patch/minor 仍拒绝。插件使用的 Host 接口若在 prerelease 间有变更，会在运行时暴露；因此该放宽是面向同 release line 的实用兼容，不承诺跨 release line 兼容。
- 需要某能力但对方未声明时，按明确的"不支持"错误失败，而不是静默降级。
- Relay 只校验 `fleetKey`，不参与版本判定；版本由设备在握手时互相校验。
- 未来升级到"版本区间/能力协商"（ADR 候选 B/C）时，复用预留的 `capabilities[]`，不改变线格式的骨架。

## Considered Options
- 版本区间 + 共同最高版本——实现与测试成本翻倍，v1 不需要。
- 完整能力协商 + 降级——稳定期再做。
- 宽松兼容——隐藏不兼容风险最高，否决。

## Consequences
升级需要两台设备同时进行；错误信息必须包含双方版本与升级建议；`capabilities[]` 需要有明确的命名与文档，避免成为无意义的装饰。
