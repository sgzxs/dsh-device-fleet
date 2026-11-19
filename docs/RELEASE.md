# 正式发布闸门（Release Gate）

- **目标版本**：1.20.8（正式版补丁）
- **当前 dist-tag**：`dev` → 1.20.8；`latest` → 1.20.8
- **结论（2026-11-19）**：**已作为正式版补丁发布。** 运行时代码同 1.20.7；本版同步 README/AGENT-GUIDE、仓库元数据并修复 GitHub CI。

## 已满足

- `npm run release:check` 通过：版本一致、关键文件存在、入口语法、npm pack 含 `src/plugin/index.js`、`client.js`、`scripts/relay-lease.mjs`、`docs/STATUS.md`。
- `node scripts/ci.mjs`：net 48/48、host 73/73、overlay 2/2、plugin-order 1/1、perf 1/1、client smoke。
- A/B 1.20.0 真机：A→B 委派后 32 条远端轨迹；B `trajectory.jsonl` 84 行落盘。
- lease：双候选 409、renew、release、TTL 过期接管、token 401/200；supervisor 双节点端口监听。
- 3 节点直连 mesh 测试（进程内网络层）。

## 阻碍 `latest` 的事项

1. **没有独立安全审计**：密钥、审批、轨迹脱敏、lease token 都涉及安全边界；M-of-N 证书也需外部评审。
2. **没有真实 3 主机 Relay/TLS 跑通**：当前是单机多进程 + lease 单点；跨主机 DNS/防火墙/证书分发未验证。
3. **`latest` 迁移**：1.8.4 → 1.20.7 已发布，但仍建议对旧用户做一次显式升级/配置备份演练。
4. **FROST/BFT 未实现且是明确决策**（ADR-0040）：若产品要求单一组签名或跨主机强一致日志，当前不满足；不能以 M-of-N 冒充。
5. **发布签名/来源**：npm 包没有 provenance/签名发布流程；发布账号 token 只有单点。

## 发布步骤（满足上述后）

```powershell
cd C:\Users\PS\.dsh\plugins\dsh-device-fleet
node scripts/ci.mjs
npm run release:check
npm pack --pack-destination .
npm publish --tag latest
```

发布后验证：

```powershell
npm view dsh-device-fleet dist-tags
dsh plugin --profile web add dsh-device-fleet@1.20.1
```

## 回滚

- npm 不允许覆盖版本；回滚 = 把 `latest` 指回 1.8.4（或上一个稳定版）。
- 插件数据目录保留；升级前建议备份 `fleet.json`、`trajectory.jsonl`、`tool-grants.json`、`approval-inbox.json`。
