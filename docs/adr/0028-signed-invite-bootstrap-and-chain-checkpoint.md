# ADR-0028：签名邀请引导与轮换链 checkpoint 压缩

- **状态**：已实现（2026-11-15，1.11.0）
- **相关**：ADR-0024（版本严格匹配）、ADR-0026（轮换链）、[ADR-0027](./0027-device-revocation-fork-and-chain-paging.md)（吊销/分页）、`src/net/identity.js`、`src/host/store.js`、`src/net/rotation.js`
- **结论**：邀请码升级为 v2——整包 HMAC 签名，并携带创建者/成员/吊销墓碑的引导快照，让加入方在第一次握手前 pin 住成员，关闭 TOFU 窗口；同时给本机轮换链增加 checkpoint 归档压缩，超长链不再无限增长。

## 背景

1.11.0 之前，Fleet 加入方的信任完全依赖 TOFU：拿到邀请码、连上第一台应答的设备，就把它的公钥 pin 下来。问题：

- 加入时若 Fleet 里已有被吊销设备，加入方不知道，可能先 TOFU 信任它；
- 邀请码只带 `fleetKey`，任何拿到码的人都能改写 endpoints（无签名）；
- 轮换链只增不减，握手/诊断最终会撞上 1024 条上限；
- 新设备入网只能从 seq 0 开始补链，而历史链对它是不可验证的（没有初始 pin）。

## 决策

### 1. 邀请码 v2：HMAC 签名 + 引导快照

```text
invite v2 payload {
  v: 2, fleetId, fleetKey, name, accountFingerprint,
  relay, relays, endpoints, createdAt,
  creator: { deviceId, name, edPublic, xPublic, rotationSeq?, rotationHead? },
  roster: [ { deviceId, name, edPublic, xPublic, rotationSeq?, rotationHead?,
              revokedAt?, revokedBy?, revokedSeq?, revocationReason? } ],
  revocations: [ device.revoke 记录（含签名） ],
  sig: HMAC-SHA256(fleetKey, "invite-v2|" + stableStringify(payload 去掉 sig))
}
```

- 邀请码本身仍是 bearer 凭据（带 fleetKey），HMAC 保证**没有 fleetKey 的中间人**不能改写引导名单/endpoint；
- 加入方在 `loadState` 应用 pending enrollment 时导入快照：
  - 创建者与成员按 `deviceId` pin 公钥；**本地已有 pin 永不覆盖**，只在 key 相同时补更高的 `rotationSeq/rotationHead`；
  - 吊销墓碑先用快照里的公钥验签 `revocations`，验过才写成 `revokedAt`（并保留 `revocationRecord`）；
  - 快照里已标记 `revokedAt` 但没有记录可验的条目也按墓碑 pin（写入 `revocationSource: 'invite'`）。
- v1 邀请仍可解码（无签名、无引导数据），保持向后兼容；v2 缺 `sig` 或验签失败直接拒绝。
- 大小上限：roster ≤ 64、revocations ≤ 64；只保留公钥与轮换/吊销元数据，不含私钥、事件或 Room 数据。

### 2. rotation chain checkpoint 压缩

- 新增 `device.rotation.checkpoint` 记录：

```text
{ v:1, type:"device.rotation.checkpoint", deviceId, seq, head, edPublic,
  archivedRecords, createdAt, signature }   // 当前设备密钥自签
```

  它只声明「已验证过的前缀被移到归档」，**不能**被对端用来跳过验链。

- 本机链文件格式升级为 `{ v: 1, checkpoint, records }`（旧裸数组仍可读）。`fleet_rotation_compact({ keep, confirm: true })`：
  - 把最旧的 `N-keep` 条记录归档到 `identity-rotations.archive-<时间戳>.json`；
  - 对归档前缀的末尾生成 checkpoint，写入活动文件；
  - 活动链只保留最近 `keep` 条（默认 64，最小 8）。
- 握手公告新增 `rotationFrom`（本地仍可提供的最旧 seq）：
  - 对端 pin 在 `rotationFrom - 1` 之前时，以 `rotation-history-pruned` 明确失败，并提示重新配对；不再空转到轮次上限；
  - **1.11.1 修正**：只有接收方（知道自己对 peer 的 pin）负责判定剪枝；发送方不能把对端公告的 `rotationSeq`（它自己的链位置）当成「它对我的 pin」，否则会误拒「自身链为空、但已 pin 到我的最新头」的设备（身份重置后的重连即此场景）。
  - pin 在保留窗口内（或已追上）时，补链行为与分页完全不变。
- 轮换仍以活动链最后一条为 previous，seq/prevHash 连续；checkpoint 不参与验链。

## 不变量

1. 邀请 v2 的 HMAC 覆盖除 `sig` 外的全部字段；缺签/坏签一律拒绝。
2. 本地已 pin 的公钥不会被邀请快照覆盖；只有 key 相同才接受更高的轮换头。
3. 吊销墓碑只有验签通过（或快照自带 `revokedAt`）才写入；无记录的自签/第三方吊销不会被凭空放行。
4. checkpoint 只是归档声明，签名者是压缩时的当前设备密钥；对端不得据此跳过 rotation chain 验证。
5. 链压缩后活动链仍满足 seq/prevHash 连续，且 `rotationFrom = records[0].seq`。
6. 被剪掉历史的对端失败码固定为 `rotation-history-pruned`，不允许静默降级为 TOFU。

## 后果

- 正：新设备入网即拿到成员/吊销视图，TOFU 只作为兜底；邀请被无密钥第三方篡改会被发现；轮换链可以长期运行而握手体积有界。
- 负：邀请码变大（成员越多越大）；`keep` 太小会让离线设备无法自动补链，必须重新配对；checkpoint 是自签声明，不具备多方信任，后续若要「可信 checkpoint」仍需用户确认或多签。
- 兼容：v1 邀请仍可用；旧链文件自动按裸数组读取；1.11.0 与 1.10.x 因插件版本严格匹配不能互连。

## 未决

- checkpoint 的多方签名/用户确认信任模型；
- 邀请快照是否需要携带成员完整的 rotation records（目前只带 head，靠后续补链）；
- 超大 Fleet 的邀请分片/二维码承载。
