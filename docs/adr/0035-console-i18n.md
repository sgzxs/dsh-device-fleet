# ADR-0035：Fleet 控制台 i18n（中文/English）

- **状态**：已实现（2026-11-16，1.16.0）
- **相关**：ADR-0033/0034
- **结论**：控制台与 Room 视图支持中英切换；默认跟随浏览器语言，选择持久化到 `localStorage`。

## 实现

- 语言检测：`localStorage['dsh-fleet-lang']` → `navigator.language`（zh* → 中文，否则 English）。
- 顶栏 `中文/EN` 按钮切换并持久化。
- 翻译层：`translateText(text)` + `localize(node)` 递归翻译 React 文本子节点及 `placeholder/title/aria-label/label`；
  - 精确词典覆盖导航、设备页、Room、通知、审批、配置页的主要标签；
  - 正则覆盖计数类动态文本（`N 位成员 · N 条消息`、`房间（N）` 等）。
- 包裹组件：FleetConsole、RoomView、RoomDock、审批面板、Room mention overlay。
- 用户消息正文不经过专用翻译；仅当正文恰好等于词典标签时可能被替换（边缘情况，可后续按节点类型跳过）。

## 不变量

1. 不改变后端数据/路由/协议。
2. 语言切换即时生效，无需刷新。
3. 无法识别的文本回退原文（中文），不出现占位符。
4. 动态数字/ID 保持原值。

## 未完成

- 后端通知正文数据仍是中文；客户端对常见句式做正则翻译，未覆盖所有动态句子；
- 插件日志、DSH 自身提示、工具原始错误未翻译；
- 原生 confirm 已接入翻译层（1.18.1）；
- 完整逐句翻译与复数规则未做。
