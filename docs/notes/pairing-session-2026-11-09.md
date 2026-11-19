# 首次配对实录（2026-11-09）

## 环境

- 设备 A：本机（Windows，DSH desktop profile，`device-fleet` 0.1.0-dev.3）
  - deviceId：`50fdaf90-f0aa-440e-9fa6-c60ba5051001`，deviceName：`desktop`
  - 直连：`0.0.0.0:60506`（热点网段 `192.168.137.1:60506`）
  - allowedRoots：`E:/Dsh_test`
- 设备 B：另一台设备（同一热点 `192.168.137.0/24`，plugin 0.1.0-dev.3）
  - deviceId：`c2d42572-e5f0-4d7e-9fff-c28d9a668439`
- 热点网段内网段：A `192.168.137.1/24`，B 为客户端之一。

## 过程

1. dev.3 邀请携带 `endpoints`（A 的 `210.73.18.88:60506` 与 `192.168.137.1:60506`）。
2. B 安装 dev.3 → `fleet_join` 新邀请 → 重启；插件读取 enrollment endpoints，自动回连 A。
3. 结果：双方握手成功，roster 互固定公钥；A 侧 `fleet_list` 显示 B `online`，`fleet_status.connected` 含 B。
4. `fleet_tools(device=B)` 成功（说明 RPC/加密通道正常）。
5. `fleet_read(device=B, path=E:/Dsh_test/hello-from-A.txt)` 返回 `denied: no allowed roots configured on this device` —— 策略按设计拦截，B 侧尚未配置 allowedRoots。

## 结论

- **网络层 v1 直连 + 配对流程打通**（组播发现在该热点下不可用，邀请 endpoints 自动回连解决了问题）。
- **Tool Policy 生效**：目标设备未配置允许根时直调被拒。
- 待配置 B 的 `policy.allowedRoots` / `execution.cwd` 后可双向直调；`fleet_run` 待审批收件箱 UI。

## 复现要点

- 邀请里的 endpoints 由 `networkInterfaces()` 的非回环 IPv4 + 当前 direct port 组成；direct 端口每次插件重载会变，重载后需重新生成邀请或手动 `fleet_connect`。
- 同一账号指纹：邀请携带 `accountFingerprint`；B 登录不同账号会在加载时被标记 mismatch 并拒绝连接。
