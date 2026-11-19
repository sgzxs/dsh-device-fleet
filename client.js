// Fleet approval panel (Client half).
// The trigger lives in the native sidebar footer action row (no overlap with
// content panels); the inbox opens as an intentional centered dialog.
// Data comes from the Host routes registered by src/host/approval-web.js.
window.__ModuleLoader__.load({
  id: 'dsh-device-fleet',
  factory(require) {
    const React = require('react');
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = null;
    }
    const h = React.createElement;
    const { useEffect, useState, useRef } = React;

    // ---- minimal i18n layer -------------------------------------------------
    const LANG_KEY = 'dsh-fleet-lang';
    const detectLanguage = () => {
      try {
        const saved = window.localStorage.getItem(LANG_KEY);
        if (saved === 'en' || saved === 'zh') return saved;
        const htmlLang = String(window.document?.documentElement?.lang ?? '').toLowerCase();
        if (htmlLang.startsWith('zh')) return 'zh';
        if (htmlLang.startsWith('en')) return 'en';
        const nav = String(window.navigator?.language ?? 'zh').toLowerCase();
        return nav.startsWith('zh') ? 'zh' : 'en';
      } catch {
        return 'zh';
      }
    };
    let LANG = detectLanguage();
    const LANG_LISTENERS = new Set();
    const I18N_EN = {
      '设备联邦': 'Device Fleet', '本机': 'This device', '设备': 'Devices', '房间': 'Rooms',
      '通知': 'Notifications', '审批': 'Approvals', '配置': 'Settings', '已归档': 'Archived',
      '在线设备': 'Online devices', '活跃房间': 'Active rooms', '未读通知': 'Unread',
      '设备密钥链': 'Device key chain', '密钥泄露恢复': 'Key compromise recovery',
      '压缩到最近 64 条': 'Compact to 64', '轮换本机密钥': 'Rotate keys', '重置身份': 'Reset identity',
      '密钥链': 'Key chain', '回连地址': 'Reconnect addresses', '配对与连接': 'Pairing & connection',
      '生成邀请码': 'Create invite', '连接': 'Connect', '加入 Fleet': 'Join Fleet',
      'FLEET 成员': 'Fleet members', '已吊销': 'Revoked', '在线': 'Online', '离线': 'Offline',
      '移除': 'Remove', '删除记录': 'Remove tombstone', '吊销': 'Revoke',
      '恢复': 'Restore', '删除': 'Delete', '关闭房间': 'Close room', '成员': 'Members',
      '发消息（以用户身份）': 'Send message (as user)', '全选': 'All', '清空': 'Clear',
      '发送': 'Send', '看板': 'Board', '暂无任务': 'No tasks yet', '添加任务': 'Add task',
      '时间线': 'Timeline', '暂无消息': 'No messages yet', '房间加载失败：': 'Failed to load room: ',
      '尚未选择房间': 'Select a room', '选择 owner': 'Select owner', '新任务标题': 'New task title',
      '主持人': 'Host', '远程': 'Remote', '成员': 'Members', '用户': 'User', '你': 'You',
      '待处理': 'Pending', '进行中': 'In progress', '已完成': 'Done', '受阻': 'Blocked',
      '基础': 'Basics', '连接与发现': 'Connection & discovery', '执行': 'Execution',
      '权限策略': 'Permission policy', '邀请与审批': 'Invites & approvals',
      'Room 与轮换': 'Room & rotation', '通知': 'Notifications',
      '设备名称': 'Device name', '自动批准远程请求': 'Auto-approve remote requests',
      '注入 Fleet 提示词': 'Inject Fleet prompt', '直连地址': 'Direct host', '直连端口': 'Direct port',
      '启用局域网发现': 'Enable LAN discovery', 'Relay 地址': 'Relay host', 'Relay 控制端口': 'Relay control port',
      'Relay 数据端口': 'Relay data port', 'TLS CA（PEM 或路径）': 'TLS CA (PEM or path)',
      'TLS 客户端证书': 'TLS client certificate', 'TLS 客户端私钥': 'TLS client key',
      'TLS servername': 'TLS servername', '跳过证书校验（仅配置项）': 'Skip certificate check (config only)',
      '工作目录': 'Working directory', 'Agent 预设': 'Agent preset', 'Shell 工具': 'Shell tool',
      '审批超时（ms）': 'Approval timeout (ms)', '委派超时（ms）': 'Delegation timeout (ms)',
      '子代理提供方': 'Subagent provider', '允许目录（每行一个）': 'Allowed roots (one per line)',
      '能力策略': 'Capabilities', '允许的原始工具': 'Allowed raw tools', '授权 TTL（ms）': 'Grant TTL (ms)',
      '邀请有效期（ms）': 'Invite TTL (ms)', '审批 TTL（ms）': 'Approval TTL (ms)',
      '最大待审批数': 'Max pending approvals', '开启审批模拟工具': 'Enable approval simulation',
      'Room rotationSeq 模式': 'Room rotationSeq mode', '审计（兼容历史事件）': 'Audit (legacy compatible)',
      '严格（必须当前 epoch）': 'Strict (current epoch required)', 'checkpoint 确认数': 'Checkpoint confirmations',
      'Room 自动压缩阈值': 'Room auto-compact threshold', 'Webhook URL': 'Webhook URL',
      'Webhook 超时（ms）': 'Webhook timeout (ms)', '保存配置': 'Save settings', '重新加载': 'Reload',
      '全部已读': 'Mark all read', '桌面通知（浏览器）': 'Desktop notifications (browser)',
      '暂无通知': 'No notifications', '暂无历史': 'No history yet', '暂无待审批请求': 'No pending approvals',
      '待审批请求': 'Pending approvals', '审批历史': 'Approval history', '允许一次': 'Allow once',
      '允许 15 分钟': 'Allow 15 minutes', '允许本房间': 'Allow in this Room', '允许本任务': 'Allow for this task',
      '拒绝': 'Deny', '远程调用等待审批': 'Remote call awaiting approval',
      '设备轮换链分叉': 'Rotation fork', '对方声明吊销一台设备': 'Peer revocation advisory',
      '设备已吊销': 'Device revoked', '对端确认了 checkpoint': 'Peer confirmed checkpoint',
      '房间（': 'Rooms (', '已归档（': 'Archived (', '成员（': 'Members (',
      '看板（': 'Board (', '通知（': 'Notifications (', '未读': 'unread',
      '收起': 'Collapse', '收起看板': 'Hide board', '收起邀请': 'Hide invite',
      '标记已读': 'Mark read', '全部已读': 'Mark all read', '重试': 'Retry', '复制': 'Copy',
      '升级为 Room': 'Upgrade to Room', '添加': 'Add', '状态': 'Status', '负责人': 'Owner',
      '普通会话': 'Regular session', '学习': 'Learn', '删除 Room': 'Delete Room',
      '归档 Room': 'Archive Room', '恢复归档房间': 'Restore archived Room', '信任': 'Trust',
      '信任 checkpoint': 'Trust checkpoint', '忽略': 'Ignore', '忽略吊销提醒': 'Ignore revocation advisory',
      '采用对端': 'Adopt peer branch', '采用对端分支': 'Adopt peer branch', '保留本机': 'Keep local',
      '保留本机分支': 'Keep local branch', '处理轮换分叉': 'Resolve rotation fork',
      '转移 Authority': 'Transfer authority', '设置 Coordinator': 'Set coordinator',
      '移出房间': 'Leave Room', '移除成员': 'Remove member', '移除设备': 'Remove device',
      '移除 Fleet 设备': 'Remove Fleet device', '邀请设备': 'Invite device', '邀请成员': 'Invite member',
      '连接设备': 'Connect device', '文件与文件夹': 'Files & folders', '新任务': 'New task',
      '待审批请求': 'Pending approvals', '审批历史': 'Approval history',
      '来自': 'From', '来自另一台设备': 'From another device',
      '未登录': 'Not signed in', '未监听': 'Not listening', '未配置': 'Not configured',
      '未设置': 'Not set', '未命名房间': 'Unnamed Room', '未入网': 'Not joined',
      '加载中…': 'Loading…', '加载失败：': 'Load failed: ', '升级中…': 'Upgrading…',
      '升级失败：': 'Upgrade failed: ', '保存失败：': 'Save failed: ', '读取配置失败：': 'Failed to load settings: ',
      '还没有消息': 'No messages yet', '还没有配对设备': 'No paired devices yet',
      '还没有配对设备；在任一台设备上生成邀请码完成配对。': 'No paired devices yet. Create an invite on either device.',
      '未检测到 Tailscale/ZeroTier': 'Tailscale/ZeroTier not detected',
      '桌面通知已开启': 'Desktop notifications enabled',
      '桌面通知权限被拒绝': 'Desktop notification permission denied',
      '当前环境不支持桌面通知': 'Desktop notifications are unavailable here',
      '邀请已排队，重载插件后生效': 'Invite queued; reload the plugin to apply',
      '粘贴 Fleet 邀请码加入': 'Paste a Fleet invite to join',
      '请先粘贴邀请码': 'Paste an invite code first', '请先选择房间': 'Select a Room first',
      '消息不能为空': 'Message cannot be empty', '任务标题不能为空': 'Task title cannot be empty',
      '没有修改': 'No changes', '已保存并即时生效': 'Saved and applied', '已重新加载': 'Reloaded',
      '已取消身份重置（需要输入 RESET）': 'Identity reset cancelled (RESET required)',
      '输入 RESET 以确认重置身份': 'Type RESET to confirm identity reset',
      '重置身份': 'Reset identity', '轮换本机密钥': 'Rotate local keys',
      '压缩轮换链': 'Compact rotation chain', '密钥泄露恢复': 'Key compromise recovery',
      '设备密钥链': 'Device key chain', '设备已吊销': 'Device revoked',
      '设备轮换链分叉': 'Rotation fork', '对方声明吊销一台设备': 'Peer reported a revocation',
      '对端确认了 checkpoint': 'Peer confirmed checkpoint', 'checkpoint 待确认': 'Checkpoint pending',
      'checkpoint 确认数': 'Checkpoint confirmations', '严格（必须当前 epoch）': 'Strict (current epoch required)',
      '审计（兼容历史事件）': 'Audit (legacy compatible)', '自动': 'Auto', '询问': 'Ask', '禁止': 'Deny',
      '允许': 'Allow', '取消': 'Cancel', '关闭': 'Close', '确定': 'Confirm', '保存': 'Save',
      '恢复': 'Restore', '归档': 'Archive', '取消归档': 'Unarchive', '生成': 'Generate',
      '重新生成': 'Regenerate', '刷新': 'Refresh', '查看': 'View', '编辑': 'Edit',
      '打开': 'Open', '进入': 'Enter', '返回': 'Back',
      '调用': 'Calls', '跨设备调用详情': 'Cross-device calls', '方向': 'Direction',
      '轨迹': 'Trajectory', '关闭': 'Close', '暂无轨迹事件': 'No trajectory events',
      'DSH 会话轨迹': 'DSH session trajectory',
      '出站': 'Outbound', '入站': 'Inbound', '耗时': 'Duration', '参数/结果': 'Args / result',
      '暂无调用记录': 'No calls recorded', '失败': 'Failed', '成功': 'Succeeded',
      '设备': 'Device', '能力/工具': 'Capability / tool', '时间': 'Time', '状态': 'Status',
      'Fleet 审批': 'Fleet approvals', 'Fleet 待审批请求': 'Fleet pending approvals',
      '吊销设备': 'Revoke device', '确认吊销': 'Confirm revocation', '吊销原因：': 'Revocation reason: ',
      '设备 ID': 'Device ID', '由': 'by', '直连': 'Direct', '邀请码': 'Invite code',
      '邀请码已复制：': 'Invite copied: ', '单次使用 ·': 'single use · ', '到期': 'expires',
      '个': '', '项': 'items', '台已配对）': 'paired)', '名成员': 'members', '分钟前': 'minutes ago',
      '已连接': 'Connected', '本机': 'This device', '来自': 'From', '密钥 seq': 'key seq',
      '房': 'Room', 'TLS 当前：': 'TLS now: ', '已配置 CA': 'CA configured',
      '已配置客户端证书': 'client certificate configured', 'mTLS 时填写': 'fill for mTLS',
      '可留空': 'optional', '仅开发环境建议开启；关闭时按审批收件箱处理。': 'Development only; when off, use the approval inbox.',
      '在上方「房间」Tab 中交流': 'Chat in the Rooms tab above',
      '在下方 DSH 输入框发送：用 @成员名 点名（例如 @worker-c），不点名则发给所有人。': 'Send from the DSH composer below; @member names a recipient, otherwise everyone is addressed.',
      '（主持人）': ' (host)', '（远程）': ' (remote)',
      '这个会话还不是 Room。在下方输入框旁点击「升级为 Room」，或让 agent 执行 room_create。': 'This session is not a Room yet. Use "Upgrade to Room" or ask the agent to run room_create.',
      '这个会话还不是 Room。点击输入框下方的「升级为 Room」即可创建。': 'This session is not a Room yet. Use "Upgrade to Room" below the composer.',
      '还没有房间。让 agent 在当前会话执行 room_create 升级为 Room Host。': 'No Rooms yet. Ask the agent to run room_create in this session.',
      '选择一个房间查看成员、时间线与看板。': 'Select a Room to view members, timeline and board.',
      '暂无已连接设备': 'No connected devices', '还没有配对设备': 'No paired devices yet',
      '发送消息': 'Send message', '添加任务': 'Add task', '更新任务': 'Update task',
      '读取配置': 'Load settings', '保存配置': 'Save settings', '重新加载': 'Reload',
      '创建邀请码': 'Create invite', '加入 Fleet': 'Join Fleet', '刷新状态': 'Refresh status',
      '设备 ID': 'Device ID', '当前公钥的信任': 'trust in the current public key',
      '信任 checkpoint': 'Trust checkpoint', 'checkpoint 待确认': 'Checkpoint pending',
      'Room 载入中…': 'Loading Room…', 'Room 数据加载失败：': 'Failed to load Room data: ',
      '房间数据加载失败：': 'Failed to load Room: ', '升级失败：': 'Upgrade failed: ',
      '删除本地 Room 副本？会先关闭 Room。': 'Delete the local Room replica? The Room will be closed first.',
      '删除归档房间': 'Delete archived Room', '删除归档 Room': 'Delete archived Room',
      '恢复归档房间': 'Restore archived Room', '归档 Room': 'Archive Room', '删除 Room': 'Delete Room',
      '副本 · 主设备': 'Replica · host', '副本 · 已同步': 'Replica · synced',
      '副本 · 待同步': 'Replica · pending sync', '仅本地副本': 'local replica only',
      '仍在内存': 'still in memory', '未读': 'unread', '通知': 'Notifications',
      '普通会话': 'Regular session', '当前公钥的信任，只有在核对过对方设备后才继续。': 'Only continue after verifying the peer device.',
      '输入 RESET 以确认重置身份': 'Type RESET to confirm identity reset',
      '重置本机身份？': 'Reset this device identity?', '取消': 'Cancel', '确定': 'Confirm',
    };
    const I18N_PATTERNS = [
      [/^(\d+) 位成员 · (\d+) 条消息 · (\d+) 个任务$/, (m) => `${m[1]} members · ${m[2]} messages · ${m[3]} tasks`],
      [/^(\d+) 位成员 · (\d+) 条消息$/, (m) => `${m[1]} members · ${m[2]} messages`],
      [/^已归档（(\d+)）$/, (m) => `Archived (${m[1]})`],
      [/^房间（(\d+)）$/, (m) => `Rooms (${m[1]})`],
      [/^成员（(\d+)）$/, (m) => `Members (${m[1]})`],
      [/^看板（(\d+)）$/, (m) => `Board (${m[1]})`],
      [/^通知（(\d+)，未读 (\d+)）$/, (m) => `Notifications (${m[1]}, ${m[2]} unread)`],
      [/^审批历史（最近 (\d+) 条）$/, (m) => `Approval history (last ${m[1]})`],
      [/^待审批请求（(\d+)）$/, (m) => `Pending approvals (${m[1]})`],
      [/^Fleet 成员（(\d+)）$/, (m) => `Fleet members (${m[1]})`],
      [/^Relay 候选（(\d+)）$/, (m) => `Relay candidates (${m[1]})`],
      [/^已连接 (\d+) 台设备$/, (m) => `${m[1]} devices connected`],
      [/^(\d+) 名成员$/, (m) => `${m[1]} members`],
      [/^(\d+) 条待处理$/, (m) => `${m[1]} pending`],
      [/^(\d+) 台已配对）$/, (m) => `${m[1]} paired)`],
      [/^密钥 seq (\d+)$/, (m) => `key seq ${m[1]}`],
      [/^密钥 seq (\d+) · 本地记录 (\d+)$/, (m) => `key seq ${m[1]} · local records ${m[2]}`],
      [/^(\d+) 分钟前$/, (m) => `${m[1]} minutes ago`],
      [/^(\d+)s 后超时$/, (m) => `timeout in ${m[1]}s`],
      [/^来自另一台设备 · (\d+)s 后超时$/, (m) => `From another device · timeout in ${m[1]}s`],
      [/^(.+) 请求 (.+)$/, (m) => `${translateText(m[1])} requested ${m[2]}`],
      [/^(.+) 确认了 (.+) 的 seq (.+)$/, (m) => `${translateText(m[1])} confirmed ${translateText(m[2])} at seq ${m[3]}`],
      [/^(.+) 的 seq (.+) 与本地不一致，自动更新已暂停$/, (m) => `${translateText(m[1])} seq ${m[2]} differs from local; auto-update paused`],
      [/^(.+) 声明 (.+) 已被吊销，需本机确认$/, (m) => `${translateText(m[1])} reports ${translateText(m[2])} revoked; local confirmation required`],
      [/^(.+) 已被本机吊销$/, (m) => `${translateText(m[1])} was revoked locally`],
      [/^(.+)失败：(.+)$/, (m) => `${translateText(m[1])} failed: ${m[2]}`],
      [/^(.+)成功$/, (m) => `${translateText(m[1])} succeeded`],
      [/^(\d+) 个任务$/, (m) => `${m[1]} tasks`],
      [/^(\d+) 条消息$/, (m) => `${m[1]} messages`],
      [/^(\d+) 位成员$/, (m) => `${m[1]} members`],
      [/^本机 (.+)$/, (m) => `This device ${m[1]}`],
      [/^来自 (.+)$/, (m) => `From ${m[1]}`],
      [/^设备 ID (.+)$/, (m) => `Device ID ${m[1]}`],
      [/^审批 (\d+) 条待处理$/, (m) => `${m[1]} pending approvals`],
      [/^通知（(\d+)，未读 (\d+)）$/, (m) => `Notifications (${m[1]}, ${m[2]} unread)`],
      [/^(.+) · 仅本地副本$/, (m) => `${translateText(m[1])} · local replica only`],
      [/^(.+) · 仍在内存$/, (m) => `${translateText(m[1])} · still in memory`],
      [/^(.+) · 已同步$/, (m) => `${translateText(m[1])} · synced`],
      [/^(.+) · 待同步$/, (m) => `${translateText(m[1])} · pending sync`],
      [/^Room 数据加载失败：(.+)$/, (m) => `Failed to load Room data: ${m[1]}`],
      [/^删除 (.+) 的吊销记录？[\s\S]*$/, (m) => `Delete ${m[1]}'s revocation record? The peer could be re-trusted by Fleet key (TOFU).`],
      [/^从 Fleet 移除 (.+)？[\s\S]*$/, (m) => `Remove ${m[1]} from the Fleet? All Room memberships are removed.`],
      [/^删除归档 Room (.+) 的本地副本？[\s\S]*$/, (m) => `Delete the local replica of archived Room ${m[1]}? Event logs are deleted too.`],
      [/^信任 (.+) 的 checkpoint？[\s\S]*$/, (m) => `Trust ${m[1]}'s checkpoint? Continue only after verifying that device.`],
      [/^删除本地 Room 副本？[\s\S]*$/, () => 'Delete the local Room replica? The Room will be closed first.'],
      [/^轮换本机密钥？[\s\S]*$/, () => 'Rotate this device key? Every connected device must confirm; offline devices catch up on reconnect.'],
      [/^重置本机身份？[\s\S]*$/, () => 'Reset this device identity? A new deviceId is generated and the old identity cannot be restored.'],
      [/^房间数据加载失败：(.+)$/, (m) => `Failed to load Room: ${m[1]}`],
      [/^轨迹加载失败：(.+)$/, (m) => `Failed to load trajectory: ${m[1]}`],
      [/^邀请码已复制：(.+)$/, (m) => `Invite copied: ${m[1]}`],
      [/^轮换完成：seq (.+)$/, (m) => `Rotation complete: seq ${m[1]}`],
      [/^身份已重置：新 deviceId (.+)$/, (m) => `Identity reset: new deviceId ${m[1]}`],
      [/^已连接 (.+)$/, (m) => `Connected ${m[1]}`],
      [/^(.+) · 依赖 (.+)$/, (m) => `${translateText(m[1])} · depends on ${m[2]}`],
      [/^(.+) 项$/, (m) => `${m[1]} items`],
      [/^(.+) 条待处理）$/, (m) => `${m[1]} pending)`],
      [/^(.+) 名成员$/, (m) => `${m[1]} members`],
    ];
    const translateText = (text) => {
      if (LANG !== 'en' || typeof text !== 'string' || text === '') return text;
      const exact = I18N_EN[text];
      if (exact) return exact;
      for (const [pattern, replace] of I18N_PATTERNS) {
        const match = pattern.exec(text);
        if (match) return replace(match);
      }
      return text;
    };
    const confirmText = (message) => {
      if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
      return window.confirm(translateText(String(message)));
    };
    const localize = (node) => {      if (typeof node === 'string') return translateText(node);
      if (Array.isArray(node)) return node.map(localize);
      if (!node || typeof node !== 'object' || !node.props) return node;
      const props = { ...node.props };
      if ('children' in props) props.children = localize(props.children);
      for (const key of ['placeholder', 'title', 'aria-label', 'label']) {
        if (typeof props[key] === 'string') props[key] = translateText(props[key]);
      }
      return { ...node, props };
    };
    const setLanguage = (next) => {
      if (next !== 'en' && next !== 'zh') return;
      LANG = next;
      try {
        window.localStorage.setItem(LANG_KEY, next);
      } catch {
        /* ignore */
      }
      for (const listener of LANG_LISTENERS) listener();
    };
    const useLanguage = () => {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((value) => value + 1);
        LANG_LISTENERS.add(listener);
        return () => LANG_LISTENERS.delete(listener);
      }, []);
      return LANG;
    };
    const withI18n = (Component) => function LocalizedComponent(props) {
      useLanguage();
      return localize(Component(props));
    };


    const POLL_MS = 2500;
    const store = {
      items: [],
      open: false,
      listeners: new Set(),
    };
    let pollTimer = null;
    let polling = false;

    const notify = () => {
      for (const listener of store.listeners) listener();
    };

    const setItems = (items) => {
      const next = Array.isArray(items) ? items : [];
      if (next.length === store.items.length && next.every((item, index) => item.id === store.items[index].id)) return;
      store.items = next;
      notify();
    };

    const startPolling = () => {
      if (polling) return () => {};
      polling = true;
      const tick = async () => {
        try {
          const response = await fetch('/device-fleet/approvals', { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setItems(data.approvals);
        } catch {
          setItems([]);
        }
        if (polling) pollTimer = setTimeout(tick, POLL_MS);
      };
      tick();
      return () => {
        polling = false;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
      };
    };

    const useStore = () => {
      const [, setVersion] = useState(0);
      useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      }, []);
      return store;
    };

    const decide = async (id, action, scope) => {
      try {
        await fetch('/device-fleet/approvals/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, action, ...(scope ? { scope } : {}) }),
        });
      } finally {
        store.items = store.items.filter((item) => item.id !== id);
        notify();
      }
    };

    const dialogStyle = {
      position: 'fixed',
      left: '50%',
      top: '12vh',
      transform: 'translateX(-50%)',
      width: 'min(440px, calc(100vw - 32px))',
      maxHeight: '70vh',
      overflow: 'auto',
      zIndex: 950,
      background: 'var(--dsw-alias-surface-raised, #1f1f1f)',
      color: 'var(--dsw-alias-text, #e8e8e8)',
      border: '1px solid var(--dsw-alias-border, #3a3a3a)',
      borderRadius: 12,
      boxShadow: '0 18px 48px rgba(0,0,0,.45)',
      padding: 14,
      font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
    };

    const smallButton = (label, onClick, tone, disabled) =>
      h(
        'button',
        {
          type: 'button',
          disabled: disabled === true,
          onClick,
          'aria-label': label,
          title: label,
          style: {
            padding: '3px 9px',
            borderRadius: 6,
            border: '1px solid ' + (tone === 'allow' ? 'var(--dsw-alias-accent, #2f6fed)' : 'var(--dsw-alias-border, #3a3a3a)'),
            background: tone === 'allow' ? 'var(--dsw-alias-accent, #2f6fed)' : 'transparent',
            color: 'var(--dsw-alias-text, #e8e8e8)',
            cursor: disabled === true ? 'default' : 'pointer',
            opacity: disabled === true ? 0.55 : 1,
            fontSize: 12,
          },
        },
        label,
      );

    function Trigger({ wide }) {
      const current = useStore();
      const count = current.items.length;
      const expanded = wide !== false;
      return h(
        'button',
        {
          type: 'button',
          title: count > 0 ? 'Fleet 审批：' + count + ' 条待处理' : 'Fleet 审批',
          'aria-label': 'Fleet 审批' + (count > 0 ? '（' + count + ' 条待处理）' : ''),
          onClick: () => {
            store.open = !store.open;
            notify();
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: expanded ? '5px 10px' : '5px 7px',
            borderRadius: 8,
            border: '1px solid ' + (count > 0 ? 'var(--dsw-alias-accent, #2f6fed)' : 'var(--dsw-alias-border, #3a3a3a)'),
            background: count > 0 ? 'var(--dsw-alias-accent, #2f6fed)' : 'transparent',
            color: 'var(--dsw-alias-text, #e8e8e8)',
            cursor: 'pointer',
            fontSize: 12,
            whiteSpace: 'nowrap',
          },
        },
        h('span', { 'aria-hidden': true }, '🛰️'),
        expanded ? h('span', null, count > 0 ? '审批 ' + count : '审批') : null,
      );
    }

    function Panel() {
      const current = useStore();
      useEffect(() => {
        if (!current.open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            store.open = false;
            notify();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [current.open]);
      if (!current.open) return null;
      return h(
        'div',
        {
          style: { position: 'fixed', inset: 0, zIndex: 940, background: 'rgba(0,0,0,.35)' },
          onClick: () => {
            store.open = false;
            notify();
          },
          role: 'presentation',
        },
        h(
          'div',
          { style: dialogStyle, role: 'dialog', 'aria-label': 'Fleet 待审批请求', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            h('strong', null, '待审批请求'),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  store.open = false;
                  notify();
                },
                style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.8 },
              },
              '收起',
            ),
          ),
          current.items.length === 0
            ? h('div', { style: { opacity: 0.7 } }, '暂无待审批请求')
            : current.items.map((item) =>
                h(
                  'div',
                  { key: item.id, style: { borderTop: '1px solid var(--dsw-alias-border, #333)', padding: '9px 0' } },
                  h('div', { style: { fontWeight: 600 } }, (item.capability || 'tool') + (item.tool ? ' / ' + item.tool : '')),
                  h('div', { style: { opacity: 0.75, fontSize: 12 } }, '来自另一台设备 · ' + Math.max(0, Math.round(item.expiresInMs / 1000)) + 's 后超时'),
                  item.reason ? h('div', { style: { opacity: 0.75, fontSize: 12, marginTop: 2 } }, item.reason) : null,
                  h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 11, margin: '5px 0', opacity: 0.8, wordBreak: 'break-all' } }, item.argsSummary),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' } },
                    smallButton('允许一次', () => decide(item.id, 'approve'), 'allow'),
                    smallButton('允许 15 分钟', () => decide(item.id, 'approve', 'ttl'), 'allow'),
                    item.roomId ? smallButton('允许本房间', () => decide(item.id, 'approve', 'room'), 'allow') : null,
                    item.taskId ? smallButton('允许本任务', () => decide(item.id, 'approve', 'task'), 'allow') : null,
                    smallButton('拒绝', () => decide(item.id, 'deny'), 'deny'),
                  ),
                ),
              ),
        ),
      );
    }

    const FLEET_CSS = [
      '.dsh-fleet{color:var(--dsw-alias-text,#e8e8e8);font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.dsh-fleet button{transition:filter .14s ease,background .14s ease,border-color .14s ease,transform .06s ease}',
      '.dsh-fleet button:not(:disabled):hover{filter:brightness(1.16)}',
      '.dsh-fleet button:not(:disabled):active{transform:translateY(1px)}',
      '.dsh-fleet input,.dsh-fleet textarea,.dsh-fleet select{transition:border-color .15s ease,box-shadow .15s ease}',
      '.dsh-fleet input:focus,.dsh-fleet textarea:focus,.dsh-fleet select:focus{outline:none;border-color:#3b82f6!important;box-shadow:0 0 0 3px rgba(59,130,246,.16)}',
      '.dsh-fleet ::-webkit-scrollbar{width:9px;height:9px}',
      '.dsh-fleet ::-webkit-scrollbar-thumb{background:rgba(128,128,128,.35);border-radius:999px;border:2px solid transparent;background-clip:content-box}',
      '.dsh-fleet ::-webkit-scrollbar-thumb:hover{background:rgba(128,128,128,.5);background-clip:content-box}',
      '.dsh-fleet ::-webkit-scrollbar-track{background:transparent}',
      '.dsh-fleet-card{transition:border-color .15s ease,background .15s ease}',
      '.dsh-fleet-card:hover{border-color:rgba(128,128,128,.4)}',
    ].join('\n');
    const cardStyle = {
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.24))',
      borderRadius: 14,
      padding: 14,
      background: 'linear-gradient(180deg, rgba(128,128,128,.05), rgba(128,128,128,0)) , var(--dsw-alias-surface-raised, #1f1f1f)',
      boxShadow: '0 1px 0 rgba(128,128,128,.08) inset',
      marginBottom: 12,
    };
    const sectionTitle = { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-text-weak, #9aa4b2)', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 };
    const pillColor = (tone) => {
      if (tone === 'ok') return 'var(--dsw-alias-accent, #2f6fed)';
      if (tone === 'deny') return '#e06c63';
      if (tone === 'warn') return '#d9a441';
      return 'var(--dsw-alias-border, #3a3a3a)';
    };
    const pill = (text, tone) =>
      h(
        'span',
        {
          style: {
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 500,
            lineHeight: '16px',
            border: '1px solid ' + pillColor(tone),
            background: tone === 'muted' ? 'transparent' : 'color-mix(in srgb, ' + pillColor(tone) + ' 14%, transparent)',
            color: tone === 'muted' ? 'inherit' : pillColor(tone),
            opacity: tone === 'muted' ? 0.7 : 1,
            marginRight: 6,
          },
        },
        text,
      );

    const fmtTime = (value) => {
      try {
        return new Date(value).toLocaleTimeString();
      } catch {
        return '';
      }
    };

    const postJson = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'HTTP ' + response.status);
      return data;
    };

    function FleetIcon({ size = 20, active = false }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          'aria-hidden': true,
          style: { opacity: active ? 1 : 0.75 },
        },
        h('circle', { cx: 12, cy: 12, r: 8.5 }),
        h('ellipse', { cx: 12, cy: 12, rx: 3.6, ry: 8.5 }),
        h('path', { d: 'M3.8 12h16.4' }),
      );
    }

    const controlStyleWidth = (width) => ({
      width,
      boxSizing: 'border-box',
      height: 30,
      padding: '4px 9px',
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.3))',
      background: 'var(--dsw-alias-bg-layer-2, transparent)',
      color: 'inherit',
      fontSize: 12,
    });

    function FleetConsole() {
      const [tab, setTab] = useState('devices');
      const [overview, setOverview] = useState(null);
      const [rooms, setRooms] = useState([]);
      const [selectedRoom, setSelectedRoom] = useState(null);
      const [roomDetail, setRoomDetail] = useState(null);
      const [roomError, setRoomError] = useState('');
      const [error, setError] = useState('');
      const [actionStatus, setActionStatus] = useState('');
      const [inviteCode, setInviteCode] = useState('');
      const [inviteExpiresAt, setInviteExpiresAt] = useState(null);
      const [desktopNotify, setDesktopNotify] = useState(false);
      const lastNotificationId = useRef(null);
      const [joinCode, setJoinCode] = useState('');
      const [connectHost, setConnectHost] = useState('192.168.137.1');
      const [connectPort, setConnectPort] = useState(0);
      const [sendText, setSendText] = useState('');
      const [sendTo, setSendTo] = useState([]);
      const [taskTitle, setTaskTitle] = useState('');
      const [taskOwner, setTaskOwner] = useState('');
      const [configForm, setConfigForm] = useState(null);
      const [configBaseline, setConfigBaseline] = useState(null);
      const [configStatus, setConfigStatus] = useState('');
      const [calls, setCalls] = useState([]);
      const [callsStatus, setCallsStatus] = useState('');
      const [trajectory, setTrajectory] = useState(null);
      const [trajectoryStatus, setTrajectoryStatus] = useState('');
      const language = useLanguage();

      const deviceLabel = (deviceId) => {
        const entry = (overview?.roster ?? []).find((device) => device.deviceId === deviceId)
        return entry?.name ?? '另一台设备'
      };

      const loadCalls = async () => {
        try {
          setCallsStatus('加载中…');
          const response = await fetch('/device-fleet/calls', { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setCalls(Array.isArray(data.calls) ? data.calls : []);
          setCallsStatus('');
        } catch (loadError) {
          setCallsStatus('加载失败：' + String(loadError?.message ?? loadError));
        }
      };
      const loadTrajectory = async (call) => {
        if (!call?.sessionId) return;
        const sessionDevice = call.direction === 'outbound' ? call.deviceId : call.reportedBy;
        try {
          setTrajectoryStatus('加载中…');
          const response = await fetch('/device-fleet/trajectory?device=' + encodeURIComponent(sessionDevice ?? '') + '&session=' + encodeURIComponent(call.sessionId), { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setTrajectory({ ...data.trajectory, call });
          setTrajectoryStatus('');
        } catch (loadError) {
          setTrajectoryStatus('轨迹加载失败：' + String(loadError?.message ?? loadError));
        }
      };
      useEffect(() => {
        if (tab === 'calls') void loadCalls();
      }, [tab]);

      useEffect(() => {
        if (tab !== 'config' || configForm) return;
        void (async () => {
          try {
            const response = await fetch('/device-fleet/config', { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const snapshot = await response.json();
            setConfigForm(snapshot.config ?? {});
            setConfigBaseline(snapshot.config ?? {});
          } catch (loadError) {
            setConfigStatus('读取配置失败：' + String(loadError?.message ?? loadError));
          }
        })();
      }, [tab, configForm]);

      const reloadConfig = async () => {
        try {
          const response = await fetch('/device-fleet/config', { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const snapshot = await response.json();
          setConfigForm(snapshot.config ?? {});
          setConfigBaseline(snapshot.config ?? {});
          setConfigStatus('已重新加载');
        } catch (loadError) {
          setConfigStatus('读取配置失败：' + String(loadError?.message ?? loadError));
        }
      };
      const setConfigField = (path, value) => {
        setConfigForm((previous) => {
          const next = JSON.parse(JSON.stringify(previous ?? {}))
          let cursor = next
          for (const key of path.slice(0, -1)) {
            if (cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = {}
            cursor = cursor[key]
          }
          cursor[path[path.length - 1]] = value
          return next
        })
      };
      const configAt = (path) => path.reduce((value, key) => (value == null ? undefined : value[key]), configForm ?? {})
      const saveConfig = async () => {
        try {
          const patch = {}
          for (const key of Object.keys(configForm ?? {})) {
            if (JSON.stringify(configForm[key]) !== JSON.stringify(configBaseline?.[key])) patch[key] = configForm[key]
          }
          if (Object.keys(patch).length === 0) {
            setConfigStatus('没有修改')
            return
          }
          const response = await fetch('/device-fleet/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error ?? 'HTTP ' + response.status);
          setConfigStatus('已保存并即时生效');
          setConfigBaseline(configForm);
        } catch (saveError) {
          setConfigStatus('保存失败：' + String(saveError?.message ?? saveError));
        }
      };

      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return undefined;
        let source;
        try {
          source = new window.EventSource('/device-fleet/events');
        } catch {
          return undefined;
        }
        const onOverview = (event) => {
          try {
            const data = JSON.parse(event.data);
            setOverview(data);
            setRooms(Array.isArray(data.rooms) ? data.rooms : []);
            setError('');
          } catch {
            /* ignore malformed frame */
          }
        };
        source.addEventListener('overview', onOverview);
        return () => {
          source.removeEventListener('overview', onOverview);
          source.close();
        };
      }, []);

      useEffect(() => {
        let disposed = false;
        const tick = async () => {
          try {
            const response = await fetch('/device-fleet/overview', { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (!disposed) {
              setOverview(data);
              setRooms(Array.isArray(data.rooms) ? data.rooms : []);
              setError('');
            }
          } catch (problem) {
            if (!disposed) setError(String(problem.message ?? problem));
          }
        };
        tick();
        const timer = setInterval(tick, 15000);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, []);

      useEffect(() => {
        if (!selectedRoom) {
          setRoomDetail(null);
          return undefined;
        }
        let disposed = false;
        const load = async () => {
          try {
            const response = await fetch('/device-fleet/room?id=' + encodeURIComponent(selectedRoom), { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            if (!disposed) {
              setRoomDetail(data.room ?? null);
              setRoomError('');
            }
          } catch (problem) {
            if (!disposed) {
              setRoomDetail(null);
              setRoomError(String(problem.message ?? problem));
            }
          }
        };
        load();
        const timer = setInterval(load, 3000);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, [selectedRoom]);

      const decide = async (id, action, scope) => {
        await fetch('/device-fleet/approvals/decide', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, action, ...(scope ? { scope } : {}) }),
        });
        setOverview((current) => (current ? { ...current, approvals: (current.approvals ?? []).filter((item) => item.id !== id) } : current));
      };

      const runAction = async (label, action) => {
        setActionStatus(label + '…');
        try {
          await action();
          setActionStatus(label + '成功');
        } catch (problem) {
          setActionStatus(label + '失败：' + String(problem.message ?? problem));
        }
      };
      const sendRoomMessage = () =>
        runAction('发送消息', async () => {
          if (!selectedRoom) throw new Error('请先选择房间');
          if (sendText.trim() === '') throw new Error('消息不能为空');
          const members = roomDetail?.members ?? [];
          const mentioned = [...sendText.matchAll(/@([^\s@]+)/g)]
            .flatMap((match) => members.filter((member) => [member.name, member.displayName].filter(Boolean).includes(match[1])))
            .map((member) => member.memberId);
          const targets = [...new Set([...(sendTo ?? []), ...mentioned])];
          if (targets.length === 0) targets.push(...members.map((member) => member.memberId));
          await postJson('/device-fleet/room/send', { roomId: selectedRoom, to: targets, text: sendText });
          setSendText('');
        });
      const addRoomTask = () =>
        runAction('添加任务', async () => {
          if (!selectedRoom) throw new Error('请先选择房间');
          if (taskTitle.trim() === '') throw new Error('任务标题不能为空');
          await postJson('/device-fleet/room/task', { roomId: selectedRoom, action: 'add', title: taskTitle, owner: taskOwner });
          setTaskTitle('');
        });
      const updateRoomTask = (id, patch = {}) =>
        runAction('更新任务', async () => {
          await postJson('/device-fleet/room/task', { roomId: selectedRoom, action: 'update', id, ...patch });
        });
      const closeCurrentRoom = () =>
        runAction('关闭房间', async () => {
          await postJson('/device-fleet/room/close', { roomId: selectedRoom });
          setSelectedRoom(null);
        });
      const removeRoomMember = (memberId) =>
        runAction('移除成员', async () => {
          await postJson('/device-fleet/room/member/remove', { roomId: selectedRoom, memberId });
        });
      const revokeMember = (member) => {
        const warning = '吊销 ' + member.name + '？\n\n' +
          '· 立即断开，并从所有 Room 移除它的成员\n' +
          '· 以后所有握手都会被拒绝（不会被 TOFU 重新信任）\n' +
          '· 其他已连接设备会收到提醒，需要各自确认\n\n' +
          '如果它的密钥可能泄露：先在各设备吊销，再让那台设备执行 fleet_reset_identity 生成新的 deviceId。';
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !confirmText(warning)) return;
        return runAction('吊销设备', () => postJson('/device-fleet/fleet/revoke-device', { deviceId: member.deviceId, reason: 'revoked from console' }));
      };
      const dismissRevocation = (member) =>
        runAction('忽略吊销提醒', () => postJson('/device-fleet/fleet/dismiss-revocation', { deviceId: member.deviceId }));
      const resolveFork = (member, action) => {
        const label = action === 'adopt-peer' ? '采用对端分支' : '保留本机分支';
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !confirmText(label + '？这会改变对 ' + member.name + ' 当前公钥的信任，只有在核对过对方设备后才继续。')) return;
        return runAction('处理轮换分叉', () =>
          postJson('/device-fleet/fleet/rotation-fork-resolve', { deviceId: member.deviceId, action }));
      };
      const trustCheckpoint = (member) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !confirmText('信任 ' + member.name + ' 的 checkpoint？\n\n· 对端的链历史已被压缩，本机无法逐条验证\n· 只有在核对过对方设备后才继续')) return;
        return runAction('信任 checkpoint', () =>
          postJson('/device-fleet/fleet/rotation-trust-checkpoint', { deviceId: member.deviceId }));
      };
      const compactRotation = () => {
        const warning = '压缩本机轮换链？\n\n' +
          '· 旧记录会归档到 device-fleet 目录，只保留最近 64 条\n' +
          '· 还停在旧 seq 的离线设备将无法自动补链（握手报 rotation-history-pruned），需要重新配对\n\n' +
          '只有在确认所有设备都已在线并完成轮换后再做。';
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !confirmText(warning)) return;
        return runAction('压缩轮换链', () => postJson('/device-fleet/fleet/rotation-compact', { keep: 64 }));
      };
      const restoreArchivedRoom = (roomId) =>
        runAction('恢复归档房间', async () => {
          await postJson('/device-fleet/room/restore', { roomId });
          setSelectedRoom(roomId);
        });
      const deleteArchivedRoom = (roomId) => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !confirmText('删除归档 Room ' + roomId + ' 的本地副本？事件日志会一并删除。')) return;
        return runAction('删除归档房间', () => postJson('/device-fleet/room/delete', { roomId }));
      };
      useEffect(() => {
        const items = overview?.notifications ?? [];
        const newest = items[0];
        if (!newest || newest.id === lastNotificationId.current) return;
        const first = lastNotificationId.current === null;
        lastNotificationId.current = newest.id;
        if (first || !desktopNotify) return;
        if (typeof window === 'undefined' || typeof window.Notification !== 'function') return;
        if (window.Notification.permission !== 'granted') return;
        try {
          new window.Notification(newest.title, { body: newest.body || '' });
        } catch {
          /* notification delivery is best effort */
        }
      }, [overview, desktopNotify]);

      const rotateDeviceIdentity = () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !confirmText('轮换本机密钥？\n\n· deviceId 不变，旧私钥签名授权新公钥\n· 所有已连接设备必须确认，任一台失败会中止\n· 离线设备会在重连时自动补链')) return;
        return runAction('轮换本机密钥', async () => {
          const data = await postJson('/device-fleet/fleet/rotate-identity');
          setActionStatus('轮换完成：seq ' + String(data.result?.seq ?? '?'));
        });
      };
      const resetDeviceIdentity = () => {
        const warning = '重置本机身份？\n\n' +
          '· 生成全新 deviceId，旧身份不可恢复\n' +
          '· 所有连接会断开，其它设备需要重新接纳\n' +
          '· Room 成员需要重新邀请\n\n' +
          '只有在密钥泄露、且已在其它设备吊销旧身份后才继续。';
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !confirmText(warning)) return;
        if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
          const typed = window.prompt('输入 RESET 以确认重置身份');
          if (typed !== 'RESET') {
            setActionStatus('已取消身份重置（需要输入 RESET）');
            return;
          }
        }
        return runAction('重置身份', async () => {
          const data = await postJson('/device-fleet/fleet/reset-identity', { reason: 'reset from Fleet console' });
          setActionStatus('身份已重置：新 deviceId ' + String(data.result?.deviceId ?? '') + '，请重新入网并邀请 Room 成员');
        });
      };
      const createInviteCode = () =>
        runAction('生成邀请码', async () => {
          const data = await postJson('/device-fleet/pair/invite');
          setInviteCode(data.code ?? '');
          setInviteExpiresAt(data.expiresAt ?? null);
        });
      const markNotificationsRead = () =>
        runAction('标记已读', async () => {
          await postJson('/device-fleet/notifications/read', { all: true });
          setOverview((previous) => (previous
            ? { ...previous, notificationsUnread: 0, notifications: (previous.notifications ?? []).map((item) => ({ ...item, read: true })) }
            : previous));
        });
      const toggleDesktopNotify = async (enabled) => {
        if (!enabled) {
          setDesktopNotify(false);
          return;
        }
        if (typeof window === 'undefined' || typeof window.Notification !== 'function') {
          setActionStatus('当前环境不支持桌面通知');
          return;
        }
        let permission = window.Notification.permission;
        if (permission === 'default' && typeof window.Notification.requestPermission === 'function') {
          permission = await window.Notification.requestPermission();
        }
        if (permission === 'granted') {
          setDesktopNotify(true);
          setActionStatus('桌面通知已开启');
        } else {
          setActionStatus('桌面通知权限被拒绝');
        }
      };
      const connectPeer = () =>
        runAction('连接设备', async () => {
          const port = Number(connectPort) || overview?.direct?.port || 0;
          const data = await postJson('/device-fleet/pair/connect', { host: connectHost, port });
          setActionStatus('已连接 ' + String(data.result?.deviceId ?? ''));
        });
      const joinFleet = () =>
        runAction('加入 Fleet', async () => {
          if (joinCode.trim() === '') throw new Error('请先粘贴邀请码');
          await postJson('/device-fleet/pair/join', { code: joinCode.trim() });
          setJoinCode('');
          setActionStatus('邀请已排队，重载插件后生效');
        });

      const tabs = [
        ['devices', '设备'],
        ['rooms', '房间'],
        ['calls', '调用'],
        ['notifications', '通知'],
        ['approvals', '审批'],
        ['config', '配置'],
      ];
      const header = h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--dsw-alias-border, rgba(128,128,128,.22))' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { width: 10, height: 10, borderRadius: '50%', background: '#3b82f6', boxShadow: '0 0 0 4px rgba(59,130,246,.12)' } }),
          h('strong', { style: { fontSize: 16, letterSpacing: '.01em' } }, '设备联邦'),
          overview ? pill('本机 ' + (overview.name ?? '') + ' · ' + overview.pluginVersion, 'muted') : null,
        ),
        actionStatus ? h('span', { style: { fontSize: 12, opacity: 0.7 } }, actionStatus) : null,
        h('span', { style: { flex: 1 } }),
        h('button', {
          type: 'button',
          onClick: () => setLanguage(language === 'en' ? 'zh' : 'en'),
          title: language === 'en' ? '切换到中文' : 'Switch to English',
          style: { padding: '5px 10px', borderRadius: 999, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.28))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
        }, language === 'en' ? '中文' : 'EN'),
        h('div', { style: { display: 'flex', gap: 3, padding: 3, borderRadius: 999, background: 'rgba(128,128,128,.08)', border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.22))' } },
          ...tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setTab(id),
                style: {
                  padding: '5px 12px',
                  borderRadius: 999,
                  border: 'none',
                  background: tab === id ? 'var(--dsw-alias-accent, #2f6fed)' : 'transparent',
                  color: tab === id ? '#fff' : 'inherit',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: tab === id ? 600 : 400,
                  transition: 'background .15s ease, color .15s ease',
                },
              },
              label +
                (id === 'approvals' && (overview?.approvals?.length ?? 0) > 0 ? ' ' + overview.approvals.length : '') +
                (id === 'notifications' && (overview?.notificationsUnread ?? 0) > 0 ? ' ' + overview.notificationsUnread : ''),
            ),
          ),
        ),
      );

      if (!overview) {
        return h('div', { style: { padding: 16 } }, header, h('div', { style: { opacity: 0.7 } }, error ? '加载失败：' + error : '加载中…'));
      }

      let body = null;
      if (tab === 'devices') {
        const connected = new Set(Array.isArray(overview.connected) ? overview.connected : []);
        body = h(
          'div',
          null,
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 12 } },
            ...[
              ['在线设备', (overview.connected ?? []).length + ' / ' + (overview.roster ?? []).length],
              ['活跃房间', String(rooms.length)],
              ['未读通知', String(overview.notificationsUnread ?? 0)],
            ].map(([label, value]) =>
              h('div', { key: label, style: { ...cardStyle, marginBottom: 0, padding: '10px 14px' } },
                h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-text-weak, #9aa4b2)' } }, label),
                h('div', { style: { fontSize: 20, fontWeight: 650, marginTop: 2, letterSpacing: '-.02em' } }, value),
              ),
            ),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '本机'),
            h('div', { style: { fontSize: 16, fontWeight: 650 } }, overview.name),
            h('div', { style: { opacity: 0.6, fontSize: 12, marginTop: 3, fontFamily: 'ui-monospace, monospace' }, title: overview.deviceId }, '设备 ID ' + String(overview.deviceId).slice(0, 8) + '…'),
            h('div', { style: { opacity: 0.75, fontSize: 12, marginTop: 4 } },
              '直连 ' + (overview.direct ? overview.direct.host + ':' + overview.direct.port : '未监听') +
              ' · relay ' + (overview.relay?.online ? '在线' : '离线') +
              ' · 发现 ' + ((overview.discovery?.peers ?? []).length) + ' 个'),
            overview.overlay
              ? h('div', { style: { opacity: 0.7, fontSize: 12, marginTop: 4 } },
                  'overlay: ' +
                  [overview.overlay.tailscale?.installed ? 'Tailscale ' + ((overview.overlay.tailscale.ips ?? []).join(', ') || '未登录') : null,
                   overview.overlay.zerotier?.installed ? 'ZeroTier ' + ((overview.overlay.zerotier.ips ?? []).join(', ') || '未入网') : null]
                    .filter(Boolean).join(' · ') || '未检测到 Tailscale/ZeroTier')
              : null,
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '设备密钥链'),
            h('div', { style: { fontSize: 12 } },
              'seq ' + (overview.rotation?.seq ?? -1) +
              ' · 本地记录 ' + (overview.rotation?.records ?? 0) +
              ' · 保留自 seq ' + (overview.rotation?.from ?? -1)),
            h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
              smallButton('压缩到最近 64 条', () => void compactRotation(), 'deny'),
              smallButton('轮换本机密钥', () => void rotateDeviceIdentity(), 'normal'),
              smallButton('重置身份', () => void resetDeviceIdentity(), 'deny'),
            ),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '密钥泄露恢复'),
            h('ol', { style: { margin: 0, paddingLeft: 18, fontSize: 12, opacity: 0.8, lineHeight: 1.7 } },
              h('li', null, '先在其它设备上「吊销」旧 deviceId，留下墓碑'),
              h('li', null, '在被泄露设备上「重置身份」，生成新的 deviceId'),
              h('li', null, '新身份重新入网；Room 成员需要重新邀请'),
            ),
          ),
          (overview.relay?.list ?? []).length > 0
            ? h('div', { style: cardStyle },
                h('div', { style: sectionTitle }, 'Relay 候选（' + overview.relay.list.length + '）'),
                ...overview.relay.list.map((candidate, index) =>
                  h('div', { key: index, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0', fontSize: 12, flexWrap: 'wrap' } },
                    h('span', { style: { flex: 1, minWidth: 130, fontFamily: 'ui-monospace, monospace' } }, candidate.host + ':' + candidate.port),
                    candidate.online ? pill('在线', 'ok') : pill('离线', 'muted'),
                    pill(candidate.persistent ? '配置' : '学习', 'muted'),
                    candidate.tls?.hasCa ? pill('TLS', 'ok') : null,
                    candidate.tls?.hasCert ? pill('mTLS', 'ok') : null,
                    Number.isFinite(candidate.latencyMs) ? pill(candidate.latencyMs + 'ms', 'muted') : null,
                    Number(candidate.failures ?? 0) > 0 ? pill('失败 ' + candidate.failures, 'warn') : null,
                    candidate.persistent ? null : h('span', { style: { opacity: 0.55 } }, Math.round(Number(candidate.ageMs ?? 0) / 60000) + ' 分钟前'),
                  ),
                ),
              )
            : null,
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, 'Fleet 成员（' + (overview.roster?.length ?? 0) + ' 台已配对）'),
            (overview.roster ?? []).length === 0
              ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '还没有配对设备；在任一台设备上生成邀请码完成配对。')
              : (overview.roster ?? []).map((member) => {
                  const revoked = member.revoked === true;
                  const pending = member.revocationPending ?? null;
                  const fork = member.rotationFork ?? null;
                  const checkpointOffer = member.rotationCheckpointOffer ?? null;
                  return h('div', { key: member.deviceId, style: { padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border, #333)' } },
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                      h('span', { style: { flex: 1, minWidth: 140, opacity: revoked ? 0.55 : 1 } }, member.name ?? '设备'),
                      revoked ? pill('已吊销', 'deny') : connected.has(member.deviceId) ? pill('在线', 'ok') : pill('离线', 'muted'),
                      typeof member.rotationSeq === 'number' ? pill('密钥 seq ' + member.rotationSeq, 'muted') : null,
                      fork ? pill('轮换分叉', 'deny') : null,
                      checkpointOffer ? pill('checkpoint 待确认', 'warn') : null,
                      pending ? pill('对方声明吊销', 'warn') : null,
                      revoked
                        ? smallButton('删除记录', () => {
                            if (typeof window !== 'undefined' && typeof window.confirm === 'function'
                              && !confirmText('删除 ' + member.name + ' 的吊销记录？删除后对方可凭 Fleet key 重新被信任（TOFU）。')) return;
                            void runAction('移除 Fleet 设备', () => postJson('/device-fleet/fleet/remove-device', { deviceId: member.deviceId }));
                          }, 'deny')
                        : smallButton('吊销', () => void revokeMember(member), 'deny'),
                      !revoked
                        ? smallButton('移除', () => {
                            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !confirmText('从 Fleet 移除 ' + member.name + '？会级联移除其所有 Room 成员。')) return;
                            void runAction('移除 Fleet 设备', () => postJson('/device-fleet/fleet/remove-device', { deviceId: member.deviceId }));
                          }, 'deny')
                        : null,
                    ),
                    revoked && member.revocationReason
                      ? h('div', { style: { opacity: 0.7, fontSize: 12, marginTop: 3 } }, '吊销原因：' + member.revocationReason)
                      : null,
                    pending
                      ? h('div', { style: { fontSize: 12, marginTop: 4 } },
                          h('div', { style: { opacity: 0.75 } },
                            '由 ' + deviceLabel(pending.by) + ' 声明此设备已被吊销' +
                            (pending.reason ? '：' + pending.reason : '') +
                            (pending.seq !== null && pending.seq !== undefined ? '（seq ' + pending.seq + '）' : '')),
                          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                            smallButton('确认吊销', () => void revokeMember(member), 'deny'),
                            smallButton('忽略', () => void dismissRevocation(member), 'normal'),
                          ),
                        )
                      : null,
                    fork
                      ? h('div', { style: { fontSize: 12, marginTop: 4 } },
                          h('div', { style: { opacity: 0.8 } },
                            '轮换链分叉（seq ' + fork.seq + '）：本机 head ' + String(fork.localHead ?? '?').slice(0, 10) +
                            '… / 对端 head ' + String(fork.remoteHead ?? '?').slice(0, 10) + '…。自动更新已暂停。'),
                          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                            smallButton('保留本机', () => void resolveFork(member, 'keep-local'), 'normal'),
                            smallButton('采用对端', () => void resolveFork(member, 'adopt-peer'), 'deny'),
                          ),
                        )
                      : null,
                    checkpointOffer
                      ? h('div', { style: { fontSize: 12, marginTop: 4 } },
                          h('div', { style: { opacity: 0.8 } },
                            '对端链已压缩到 seq ' + checkpointOffer.seq + '，本机 pin 更旧，无法逐条验链。'),
                          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                            smallButton('信任 checkpoint', () => void trustCheckpoint(member), 'deny'),
                          ),
                        )
                      : null,
                  );
                }),
          ),
          (overview.peerHints ?? []).length > 0
            ? h('div', { style: cardStyle },
                h('div', { style: sectionTitle }, '回连地址'),
                ...overview.peerHints.map((hint, index) =>
                  h('div', { key: index, style: { fontSize: 12, fontFamily: 'ui-monospace, monospace', opacity: 0.8 } }, hint.host + ':' + hint.port),
                ),
              )
            : null,
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '配对与连接'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              smallButton('生成邀请码', () => void createInviteCode(), 'allow'),
              inviteCode
                ? h('button', {
                    type: 'button',
                    onClick: () => {
                      try {
                        void navigator.clipboard?.writeText(inviteCode)
                      } catch {
                        /* ignore */
                      }
                    },
                    style: { background: 'transparent', border: 'none', color: 'var(--dsw-alias-accent, #2f6fed)', cursor: 'pointer', fontSize: 12 },
                  }, '复制')
                : null,
            ),
            inviteCode
              ? h('pre', { style: { fontSize: 11, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--dsw-alias-bg-layer-2, #262626)', padding: 8, borderRadius: 6, maxHeight: 140, overflow: 'auto' } }, inviteCode)
              : null,
            inviteCode && inviteExpiresAt
              ? h('div', { style: { fontSize: 12, opacity: 0.7, marginTop: 4 } },
                  '单次使用 · ' + new Date(inviteExpiresAt).toLocaleString() + ' 到期')
              : null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
              h('input', {
                type: 'text',
                value: connectHost,
                onChange: (event) => setConnectHost(event.target.value),
                placeholder: 'host',
                style: { ...controlStyleWidth(180) },
              }),
              h('input', {
                type: 'number',
                value: connectPort || overview?.direct?.port || 0,
                onChange: (event) => setConnectPort(Number(event.target.value || 0)),
                placeholder: 'port',
                style: { ...controlStyleWidth(110) },
              }),
              smallButton('连接', () => void connectPeer(), 'normal'),
            ),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
              h('input', {
                type: 'text',
                value: joinCode,
                onChange: (event) => setJoinCode(event.target.value),
                placeholder: '粘贴 Fleet 邀请码加入',
                style: { ...controlStyleWidth(360) },
              }),
              smallButton('加入 Fleet', () => void joinFleet(), 'allow'),
            ),
          ),
        );
      } else if (tab === 'rooms') {
        body = h(
          'div',
          { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 300px', minWidth: 280, maxWidth: 360 } },
            h('div', { style: sectionTitle }, '房间（' + rooms.length + '）'),
            rooms.length === 0
              ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '还没有房间。让 agent 在当前会话执行 room_create 升级为 Room Host。')
              : rooms.map((room) =>
                  h(
                    'button',
                    {
                      key: room.roomId,
                      type: 'button',
                      onClick: () => setSelectedRoom(room.roomId === selectedRoom ? null : room.roomId),
                      style: {
                        ...cardStyle,
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        cursor: 'pointer',
                        borderColor: selectedRoom === room.roomId ? 'var(--dsw-alias-accent, #2f6fed)' : undefined,
                        marginBottom: 8,
                      },
                    },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                      h('span', { style: { width: 32, height: 32, borderRadius: 10, flex: '0 0 auto', display: 'grid', placeItems: 'center', background: selectedRoom === room.roomId ? 'rgba(59,130,246,.22)' : 'rgba(128,128,128,.14)', fontSize: 13, fontWeight: 700 } },
                        (room.title ?? '房').slice(0, 1)),
                      h('div', { style: { minWidth: 0 } },
                        h('div', { style: { fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, room.title ?? '未命名房间'),
                        h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 2 } },
                          room.members.length + ' 位成员 · ' + room.messageCount + ' 条消息 · ' + room.tasks + ' 个任务'),
                      ),
                    ),
                  ),
                ),
            (overview.archivedRooms ?? []).length > 0
              ? h('div', { style: { marginTop: 14 } },
                  h('div', { style: sectionTitle }, '已归档（' + overview.archivedRooms.length + '）'),
                  ...overview.archivedRooms.map((entry) =>
                    h('div', { key: entry.roomId, style: { ...cardStyle, padding: 8, marginBottom: 6 } },
                      h('div', { style: { fontWeight: 600, fontSize: 13 } }, entry.title ?? '未命名房间'),
                      h('div', { style: { fontSize: 12, opacity: 0.65, marginTop: 2 } },
                        'seq ' + entry.lastSeq + (entry.updatedAt ? ' · ' + fmtTime(entry.updatedAt) : '') + (entry.inMemory ? ' · 仍在内存' : ' · 仅本地副本')),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 5 } },
                        smallButton('恢复', () => void restoreArchivedRoom(entry.roomId), 'normal'),
                        smallButton('删除', () => void deleteArchivedRoom(entry.roomId), 'deny'),
                      ),
                    ),
                  ),
                )
              : null,
          ),
          h('div', { style: { flex: '3 1 720px', minWidth: 320 } }, selectedRoom ? (roomError && !roomDetail ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '房间加载失败：' + roomError) : renderRoomDetail(roomDetail, {
            sendText,
            setSendText,
            sendTo,
            setSendTo,
            sendRoomMessage,
            taskTitle,
            setTaskTitle,
            taskOwner,
            setTaskOwner,
            addRoomTask,
            updateRoomTask,
            closeCurrentRoom,
            removeRoomMember,
          })) : h('div', { style: { opacity: 0.65, fontSize: 12 } }, '选择一个房间查看成员、时间线与看板。')),
        );
      } else if (tab === 'calls') {
        const cell = { padding: '6px 8px', borderTop: '1px solid rgba(128,128,128,.12)', fontSize: 12, verticalAlign: 'top' };
        body = h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
            h('div', { style: sectionTitle }, '跨设备调用详情'),
            h('span', { style: { flex: 1 } }),
            smallButton('刷新', () => void loadCalls(), 'normal'),
          ),
          callsStatus ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, callsStatus) : null,
          calls.length === 0
            ? h('div', { style: { ...cardStyle, opacity: 0.7, fontSize: 12 } }, '暂无调用记录')
            : h('div', { style: { ...cardStyle, overflowX: 'auto' } },
                h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
                  h('thead', null, h('tr', null,
                    ...['时间', '方向', '设备', '能力/工具', '状态', '耗时', '参数/结果'].map((label) =>
                      h('th', { key: label, style: { textAlign: 'left', padding: '6px 8px', fontSize: 11, opacity: 0.6, borderBottom: '1px solid rgba(128,128,128,.2)' } }, label)),
                  )),
                  h('tbody', null, ...calls.map((call) =>
                    h('tr', { key: String(call.reportedBy) + ':' + String(call.id) },
                      h('td', { style: cell }, fmtTime(call.at)),
                      h('td', { style: cell }, call.direction === 'inbound' ? '入站' : '出站'),
                      h('td', { style: cell }, call.reportedByName ?? call.deviceId ?? '—'),
                      h('td', { style: cell }, String(call.capability ?? '') + (call.tool ? ' / ' + String(call.tool) : '')),
                      h('td', { style: { ...cell, color: call.status === 'error' ? '#ef4444' : undefined } }, call.status === 'error' ? '失败' : '成功'),
                      h('td', { style: cell }, Math.round(Number(call.durationMs) || 0) + 'ms'),
                      h('td', { style: { ...cell, maxWidth: 420, wordBreak: 'break-word', opacity: 0.8 } },
                        call.status === 'error' ? (call.error ?? '') : (call.resultSummary || call.argsSummary || ''),
                        call.sessionId
                          ? h('div', { style: { marginTop: 5 } }, smallButton('轨迹', () => void loadTrajectory(call), 'normal'))
                          : null,
                      ),
                    ),
                  )),
                ),
              ),
          callsStatus ? h('div', { style: { fontSize: 12, opacity: 0.7, marginTop: 6 } }, callsStatus) : null,
          trajectoryStatus ? h('div', { style: { fontSize: 12, opacity: 0.7, marginTop: 6 } }, trajectoryStatus) : null,
          trajectory
            ? h('div', { style: { ...cardStyle, marginTop: 12 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } },
                  h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'DSH 会话轨迹 · ' + String(trajectory.call?.reportedByName ?? trajectory.call?.deviceId ?? '') + ' · ' + String(trajectory.sessionId ?? '')),
                  h('span', { style: { flex: 1 } }),
                  smallButton('关闭', () => { setTrajectory(null); setTrajectoryStatus(''); }, 'normal'),
                ),
                (trajectory.events ?? []).length === 0
                  ? h('div', { style: { fontSize: 12, opacity: 0.7 } }, '暂无轨迹事件')
                  : h('div', { style: { maxHeight: 420, overflow: 'auto' } }, ...(trajectory.events ?? []).map((event, index) =>
                      h('div', { key: String(index), style: { borderTop: '1px solid rgba(128,128,128,.12)', padding: '6px 0', fontSize: 12 } },
                        h('div', { style: { display: 'flex', gap: 10, opacity: 0.75 } },
                          h('span', null, fmtTime(event.at)),
                          h('span', { style: { fontWeight: 600 } }, String(event.type ?? 'event')),
                        ),
                        h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.8, marginTop: 3 } },
                          String(JSON.stringify(event.data ?? null)).slice(0, 1200)),
                      ),
                    )),
              )
            : null,
        );
      } else if (tab === 'config') {
        const inputStyle = { width: '100%', boxSizing: 'border-box', height: 30, padding: '4px 9px', borderRadius: 7, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.3))', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', fontSize: 12 };
        const rowStyle = { display: 'grid', gridTemplateColumns: 'minmax(150px,190px) minmax(0,1fr)', gap: 14, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(128,128,128,.1)' };
        const row = (label, control, hint) => h('div', { style: rowStyle },
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #9aa4b2)' } }, label),
          h('div', null, control, hint ? h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 3 } }, hint) : null),
        );
        const textField = (label, path, options = {}) => row(
          label,
          h('input', {
            type: options.type ?? 'text',
            value: configAt(path) ?? '',
            placeholder: options.placeholder ?? '',
            min: options.min,
            onChange: (event) => setConfigField(path, options.type === 'number' ? Number(event.target.value) : event.target.value),
            style: inputStyle,
          }),
          options.hint,
        );
        const selectField = (label, path, choices, hint) => row(
          label,
          h('select', {
            value: configAt(path) ?? choices[0]?.[0] ?? '',
            onChange: (event) => setConfigField(path, event.target.value),
            style: inputStyle,
          }, ...choices.map(([value, text]) => h('option', { key: value, value }, text))),
          hint,
        );
        const checkField = (label, path, hint) => row(
          label,
          h('input', {
            type: 'checkbox',
            checked: configAt(path) === true,
            onChange: (event) => setConfigField(path, event.target.checked),
            style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-accent, #2f6fed)' },
          }),
          hint,
        );
        const tls = configAt(['relay', 'tls']) ?? {};
        body = h('div', null,
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '基础'),
            textField('设备名称', ['deviceName'], { placeholder: 'desktop-ui' }),
            checkField('自动批准远程请求', ['autoApproveAsk'], '仅开发环境建议开启；关闭时按审批收件箱处理。'),
            checkField('注入 Fleet 提示词', ['promptSection']),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '连接与发现'),
            textField('直连地址', ['direct', 'host'], { placeholder: '0.0.0.0' }),
            textField('直连端口', ['direct', 'port'], { type: 'number', min: 0 }),
            checkField('启用局域网发现', ['discovery']),
            textField('Relay 地址', ['relay', 'host'], { placeholder: 'relay.example.com' }),
            textField('Relay 控制端口', ['relay', 'port'], { type: 'number' }),
            textField('Relay 数据端口', ['relay', 'dataPort'], { type: 'number' }),
            textField('TLS CA（PEM 或路径）', ['relay', 'tls', 'ca'], { placeholder: '可留空' }),
            textField('TLS 客户端证书', ['relay', 'tls', 'cert'], { placeholder: 'mTLS 时填写' }),
            textField('TLS 客户端私钥', ['relay', 'tls', 'key'], { placeholder: 'mTLS 时填写' }),
            textField('TLS servername', ['relay', 'tls', 'servername']),
            row('跳过证书校验（仅配置项）', h('input', {
              type: 'checkbox',
              checked: configAt(['relay', 'tls', 'rejectUnauthorized']) === false,
              onChange: (event) => setConfigField(['relay', 'tls', 'rejectUnauthorized'], event.target.checked ? false : true),
              style: { width: 16, height: 16, accentColor: 'var(--dsw-alias-accent, #2f6fed)' },
            })),
            h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 4 } }, 'TLS 当前：' + (tls.ca ? '已配置 CA' : '未配置') + (tls.cert ? ' · 已配置客户端证书' : '')),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '执行'),
            textField('工作目录', ['execution', 'cwd']),
            textField('Agent 预设', ['execution', 'agentPreset']),
            textField('Shell 工具', ['execution', 'shellTool']),
            textField('审批超时（ms）', ['execution', 'approvalTimeoutMs'], { type: 'number', min: 1000 }),
            textField('委派超时（ms）', ['execution', 'delegateTimeoutMs'], { type: 'number', min: 1000 }),
            textField('子代理提供方', ['execution', 'subagentProvider']),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '权限策略'),
            row('允许目录（每行一个）', h('textarea', {
              value: (configAt(['policy', 'allowedRoots']) ?? []).join('\n'),
              rows: 3,
              onChange: (event) => setConfigField(['policy', 'allowedRoots'], event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)),
              style: { ...inputStyle, height: 'auto', resize: 'vertical', fontFamily: 'ui-monospace, monospace' },
            })),
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #9aa4b2)', marginTop: 10, marginBottom: 4 } }, '能力策略'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 8 } },
              ...['read', 'list', 'grep', 'fetch', 'write', 'run', 'tool', 'delegate'].map((capability) =>
                h('label', { key: capability, style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 } },
                  h('span', { style: { opacity: 0.7 } }, capability),
                  h('select', {
                    value: configAt(['policy', 'capabilities', capability]) ?? 'ask',
                    onChange: (event) => setConfigField(['policy', 'capabilities', capability], event.target.value),
                    style: inputStyle,
                  }, ...[['auto', '自动'], ['ask', '询问'], ['deny', '禁止'], ['allow', '允许']].map(([value, text]) => h('option', { key: value, value }, text))),
                ),
              ),
            ),
            row('允许的原始工具', h('input', {
              value: (configAt(['policy', 'allowedTools']) ?? []).join(', '),
              onChange: (event) => setConfigField(['policy', 'allowedTools'], event.target.value.split(',').map((item) => item.trim()).filter(Boolean)),
              placeholder: 'tool-a, tool-b',
              style: inputStyle,
            })),
            textField('授权 TTL（ms）', ['policy', 'approvalTtlMs'], { type: 'number', min: 1000 }),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '邀请与审批'),
            textField('邀请有效期（ms）', ['invite', 'ttlMs'], { type: 'number', min: 60000 }),
            textField('审批 TTL（ms）', ['approvals', 'ttlMs'], { type: 'number', min: 1000 }),
            textField('最大待审批数', ['approvals', 'maxPending'], { type: 'number', min: 1 }),
            checkField('开启审批模拟工具', ['approvals', 'simulation']),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, 'Room 与轮换'),
            selectField('Room rotationSeq 模式', ['room', 'rotationSeqMode'], [['audit', '审计（兼容历史事件）'], ['strict', '严格（必须当前 epoch）']]),
            textField('checkpoint 确认数', ['rotation', 'checkpointQuorum'], { type: 'number', min: 1 }),
            textField('Room 自动压缩阈值', ['replica', 'autoCompactMinEvents'], { type: 'number', min: 100 }),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '通知'),
            textField('Webhook URL', ['notifications', 'webhook'], { placeholder: 'https://…' }),
            textField('Webhook 超时（ms）', ['notifications', 'timeoutMs'], { type: 'number', min: 1000 }),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            smallButton('保存配置', () => void saveConfig(), 'allow'),
            smallButton('重新加载', () => void reloadConfig(), 'normal'),
            configStatus ? h('span', { style: { fontSize: 12, opacity: 0.7 } }, configStatus) : null,
          ),
        );
      } else if (tab === 'notifications') {
        const items = overview.notifications ?? [];
        body = h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '通知（' + items.length + '，未读 ' + (overview.notificationsUnread ?? 0) + '）'),
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' } },
              smallButton('全部已读', () => void markNotificationsRead(), 'allow'),
              h('label', { style: { fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: desktopNotify,
                  onChange: (event) => void toggleDesktopNotify(event.target.checked),
                }),
                '桌面通知（浏览器）'),
            ),
            items.length === 0
              ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '暂无通知')
              : items.map((item) =>
                  h('div', { key: item.id, style: { borderTop: '1px solid var(--dsw-alias-border, #333)', padding: '6px 0', opacity: item.read ? 0.6 : 1 } },
                    h('div', { style: { fontWeight: 600, fontSize: 13 } }, item.title + ' · ' + fmtTime(item.createdAt)),
                    item.body ? h('div', { style: { fontSize: 12, opacity: 0.75, marginTop: 2 } }, item.body) : null,
                  ),
                ),
          ),
        );
      } else {
        const approvals = overview.approvals ?? [];
        const history = overview.approvalHistory ?? [];
        body = h(
          'div',
          null,
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '待审批请求（' + approvals.length + '）'),
            approvals.length === 0
              ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '暂无待审批请求')
              : approvals.map((item) =>
                  h('div', { key: item.id, style: { borderTop: '1px solid var(--dsw-alias-border, #333)', padding: '9px 0' } },
                    h('div', { style: { fontWeight: 600 } }, (item.capability || 'tool') + (item.tool ? ' / ' + item.tool : '')),
                    h('div', { style: { opacity: 0.75, fontSize: 12 } }, '来自 ' + deviceLabel(item.fromDeviceId) + ' · ' + Math.max(0, Math.round(item.expiresInMs / 1000)) + 's 后超时'),
                    item.reason ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, item.reason) : null,
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 5, flexWrap: 'wrap' } },
                      smallButton('允许一次', () => decide(item.id, 'approve'), 'allow'),
                      smallButton('允许 15 分钟', () => decide(item.id, 'approve', 'ttl'), 'allow'),
                      item.roomId ? smallButton('允许本房间', () => decide(item.id, 'approve', 'room'), 'allow') : null,
                      item.taskId ? smallButton('允许本任务', () => decide(item.id, 'approve', 'task'), 'allow') : null,
                      smallButton('拒绝', () => decide(item.id, 'deny'), 'deny'),
                    ),
                  ),
                ),
          ),
          h('div', { style: cardStyle },
            h('div', { style: sectionTitle }, '审批历史（最近 ' + history.length + ' 条）'),
            history.length === 0
              ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '暂无历史')
              : history.slice(0, 20).map((item) =>
                  h('div', { key: item.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12, borderTop: '1px solid var(--dsw-alias-border, #333)' } },
                    pill(item.outcome, item.outcome === 'approved' ? 'ok' : 'muted'),
                    h('span', { style: { flex: 1 } }, (item.capability || 'tool') + (item.tool ? ' / ' + item.tool : '') + ' · ' + deviceLabel(item.fromDeviceId)),
                    h('span', { style: { opacity: 0.55 } }, fmtTime(item.resolvedAt)),
                  ),
                ),
          ),
        );
      }

      return h('div', { className: 'dsh-fleet', style: { padding: '22px 24px', height: '100%', overflow: 'auto', boxSizing: 'border-box', maxWidth: 1500, margin: '0 auto' } },
        h('style', null, FLEET_CSS),
        header,
        body,
      );
    }

    function renderRoomDetail(detail, ctl) {
      if (!detail) return h('div', { style: { opacity: 0.65, fontSize: 12 } }, '加载房间…');
      const memberLabel = (memberId) => detail.members.find((member) => member.memberId === memberId)?.displayName ?? '成员';
      const statusLabel = { pending: '待处理', running: '进行中', done: '已完成', blocked: '受阻' };
      const memberIds = detail.members.map((member) => member.memberId);
      const participantIds = memberIds.filter((id) => !id.startsWith('host:'));
      const defaultRecipients = participantIds.length > 0 ? participantIds : memberIds;
      const recipientIds = Array.isArray(ctl.sendTo) && ctl.sendTo.length > 0 ? ctl.sendTo : defaultRecipients;
      const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(ctl.sendText ?? '');
      const mentionCandidates = mentionMatch
        ? detail.members.filter((member) => String(member.displayName ?? member.name ?? '').toLowerCase().includes(mentionMatch[1].toLowerCase()))
        : [];
      const applyMention = (member) => {
        const text = ctl.sendText ?? '';
        const queryLength = mentionMatch?.[1]?.length ?? 0;
        ctl.setSendText(text.slice(0, text.length - queryLength) + (member.name ?? member.displayName ?? '') + ' ');
      };
      return h(
        'div',
        null,
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 18, fontWeight: 650, letterSpacing: '-.01em' } }, detail.title ?? '未命名房间'),
            h('div', { style: { fontSize: 12, opacity: 0.65, marginTop: 3 } },
              detail.members.length + ' 位成员 · ' + (detail.messages?.length ?? 0) + ' 条消息 · ' + detail.tasks.length + ' 个任务'),
          ),
          smallButton('关闭房间', () => void ctl.closeCurrentRoom(), 'deny'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 12, alignItems: 'start' } },
          h('div', { style: { minWidth: 0 } },
        h('div', { style: cardStyle },
          h('div', { style: sectionTitle }, '成员'),
          ...detail.members.map((member) =>
            h('div', { key: member.memberId, style: { display: 'flex', alignItems: 'center', gap: 9, padding: '5px 0', fontSize: 12 } },
              h('span', { style: { width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', background: member.role === 'host' ? 'rgba(59,130,246,.18)' : 'rgba(128,128,128,.14)', fontSize: 11, fontWeight: 600 } },
                (member.displayName ?? member.name ?? '?').slice(0, 1)),
              h('span', { style: { flex: 1 } }, member.displayName ?? member.name ?? '成员'),
              pill(member.role === 'host' ? '主持人' : (member.kind === 'remote' ? '远程' : '成员'), member.role === 'host' ? 'ok' : 'muted'),
              member.role === 'host' ? null : smallButton('移除', () => void ctl.removeRoomMember(member.memberId), 'deny'),
            ),
          ),
        ),
        h('div', { style: cardStyle },
          h('div', { style: sectionTitle }, '发消息（以用户身份）'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 } },
            ...detail.members.map((member) => {
              const selected = recipientIds.includes(member.memberId)
              return h('button', {
                key: member.memberId,
                type: 'button',
                onClick: () => ctl.setSendTo((current) => {
                  const base = current.length > 0 ? current : defaultRecipients
                  return selected ? base.filter((id) => id !== member.memberId) : [...new Set([...base, member.memberId])]
                }),
                style: {
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 9px', borderRadius: 999,
                  border: '1px solid ' + (selected ? 'var(--dsw-alias-accent, #2f6fed)' : 'var(--dsw-alias-border, rgba(128,128,128,.3))'),
                  background: selected ? 'rgba(59,130,246,.16)' : 'transparent',
                  color: 'inherit', cursor: 'pointer', fontSize: 12,
                },
              },
                h('span', { style: { width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', background: selected ? 'rgba(59,130,246,.28)' : 'rgba(128,128,128,.18)', fontSize: 10, fontWeight: 600 } },
                  (member.displayName ?? member.name ?? '?').slice(0, 1)),
                member.displayName ?? member.name ?? '成员',
                member.role === 'host' ? h('span', { style: { opacity: 0.55, fontSize: 10 } }, '主持人') : null,
              )
            }),
            h('span', { style: { flex: 1 } }),
            smallButton('全选', () => ctl.setSendTo(memberIds), 'normal'),
            smallButton('清空', () => ctl.setSendTo([]), 'normal'),
          ),
          h('textarea', {
            value: ctl.sendText,
            onChange: (event) => ctl.setSendText(event.target.value),
            onKeyDown: (event) => {
              if (mentionCandidates.length === 0) return;
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault();
                applyMention(mentionCandidates[0]);
              }
            },
            rows: 2,
            placeholder: '发送消息给选中的成员，输入 @ 可提及…',
            style: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.3))', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))', color: 'inherit', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' },
          }),
          mentionCandidates.length > 0
            ? h('div', { style: { marginTop: 4, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.3))', borderRadius: 8, overflow: 'hidden', background: 'var(--dsw-alias-surface-raised, transparent)' } },
                ...mentionCandidates.map((member) =>
                  h('button', {
                    key: member.memberId,
                    type: 'button',
                    onClick: () => applyMention(member),
                    style: { display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '5px 9px', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, textAlign: 'left' },
                  },
                    h('span', { style: { width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(128,128,128,.18)', fontSize: 10, fontWeight: 600 } }, (member.displayName ?? member.name ?? '?').slice(0, 1)),
                    member.displayName ?? member.name ?? '成员',
                    h('span', { style: { opacity: 0.5, fontSize: 11 } }, '@' + (member.name ?? '')),
                  ),
                ))
            : null,
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            h('span', { style: { flex: 1 } }),
            smallButton('发送', () => void ctl.sendRoomMessage(), 'allow'),
          ),
        ),
        ),
        h('div', { style: cardStyle },
          h('div', { style: sectionTitle }, '看板（' + detail.tasks.length + '）'),
          detail.tasks.length === 0
            ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '暂无任务')
            : detail.tasks.map((task) =>
                h('div', { key: task.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12, borderTop: '1px solid rgba(128,128,128,.1)' } },
                  pill(statusLabel[task.status] ?? task.status, task.status === 'done' ? 'ok' : task.status === 'blocked' ? 'deny' : 'muted'),
                  h('span', { style: { flex: 1 } }, task.title + ' · ' + memberLabel(task.owner) + (task.dependsOn.length ? ' · 依赖 ' + task.dependsOn.length + ' 项' : '')),
                  h('select', {
                    value: task.owner,
                    title: '负责人',
                    onChange: (event) => void ctl.updateRoomTask(task.id, { owner: event.target.value }),
                    style: { height: 24, borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', fontSize: 11 },
                  },
                    ...detail.members.map((member) => h('option', { key: member.memberId, value: member.memberId }, member.displayName ?? member.name ?? '成员')),
                  ),
                  h('select', {
                    value: task.status,
                    title: '状态',
                    onChange: (event) => void ctl.updateRoomTask(task.id, { status: event.target.value }),
                    style: { height: 24, borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))', background: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'inherit', fontSize: 11 },
                  },
                    ...['pending', 'running', 'done', 'blocked'].map((status) => h('option', { key: status, value: status }, statusLabel[status] ?? status)),
                  ),
                ),
              ),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
            h('input', {
              type: 'text',
              value: ctl.taskTitle,
              onChange: (event) => ctl.setTaskTitle(event.target.value),
              placeholder: '新任务标题',
              style: { ...controlStyleWidth(180), height: 26, fontSize: 12 },
            }),
            h('select', {
              value: ctl.taskOwner,
              onChange: (event) => ctl.setTaskOwner(event.target.value),
              style: { ...controlStyleWidth(180), height: 26, fontSize: 12 },
            },
              h('option', { value: '' }, '选择 owner'),
              ...detail.members.map((member) => h('option', { key: member.memberId, value: member.memberId }, member.displayName ?? member.name ?? '成员')),
            ),
            smallButton('添加任务', () => void ctl.addRoomTask(), 'allow'),
          ),
        ),
      ),
        h('div', { style: cardStyle },
          h('div', { style: sectionTitle }, '时间线'),
          detail.messages.length === 0
            ? h('div', { style: { opacity: 0.7, fontSize: 12 } }, '暂无消息')
            : detail.messages.map((message) =>
                h('div', { key: message.id, style: { padding: '5px 0', borderTop: '1px solid var(--dsw-alias-border, #333)' } },
                  h('div', { style: { fontSize: 11, opacity: 0.6 } }, '[' + fmtTime(message.createdAt) + '] ' + message.fromLabel + ' → ' + (message.to ?? []).map(memberLabel).join('、')),
                  h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 2 } }, message.text),
                ),
              ),
        ),
      );
    }

    // Room is a normal Session with participants. This dock keeps the member
    // strip inside the conversation instead of a separate dashboard.
    function extractDraftText(input, depth = 0) {
      if (input === null || input === undefined || depth > 3) return '';
      if (typeof input === 'string') return input;
      if (typeof input !== 'object') return '';
      for (const key of ['draft', 'text', 'value', 'plainText', 'input', 'message', 'content', 'current']) {
        const value = input[key];
        if (typeof value === 'string' && value !== '') return value;
        if (value && typeof value === 'object') {
          const nested = extractDraftText(value, depth + 1);
          if (nested !== '') return nested;
        }
      }
      return '';
    }

    function insertMentionText(props, name) {
      const actions = props?.inputActions;
      if (actions && typeof actions === 'object') {
        for (const method of ['insertMention', 'insertText', 'appendText', 'replaceText', 'setText', 'setDraft']) {
          const fn = actions[method];
          if (typeof fn === 'function') {
            try {
              fn.call(actions, '@' + name + ' ');
              return true;
            } catch {
              /* try the next action */
            }
          }
        }
      }
      try {
        const element = document.activeElement;
        if (element && (element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')) {
          element.focus();
          document.execCommand('insertText', false, '@' + name + ' ');
          return true;
        }
      } catch {
        /* fall through */
      }
      return false;
    }

    // ---- Experimental Chat replacement (feature-flagged, error-isolated) ----
    const FLEET_UI_VERSION = '1.8.3';

    class RoomDockBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      render() {
        if (this.state.error) {
          return h('div', { style: { fontSize: 11, padding: '2px 2px 0', color: 'var(--dsw-alias-state-warn-primary, #d9a441)' } },
            'RoomDock 渲染失败（' + FLEET_UI_VERSION + '）：' + String(this.state.error?.message ?? this.state.error))
        }
        return this.props.children;
      }
    }

    function findNativeCompletionPanel() {
      try {
        const labels = [...document.querySelectorAll('div, span')].filter(
          (node) => node.childElementCount === 0 && node.textContent?.trim() === '文件与文件夹',
        )
        let best = null
        for (const label of labels) {
          let element = label.parentElement
          for (let depth = 0; element && depth < 10; depth += 1, element = element.parentElement) {
            const rect = element.getBoundingClientRect()
            if (rect.width < 320 || rect.height < 100) continue
            if (rect.width > window.innerWidth - 8) continue
            const style = window.getComputedStyle(element)
            if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') <= 0.1) continue
            const hasSurface = style.backgroundColor && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
            const hasShape = parseFloat(style.borderTopLeftRadius || '0') > 0 || (style.boxShadow && style.boxShadow !== 'none')
            if (!hasSurface && !hasShape) continue
            const candidate = { element, height: rect.height, surface: hasSurface ? 1 : 0 }
            if (!best || candidate.height > best.height || (candidate.height === best.height && candidate.surface > best.surface)) best = candidate
          }
        }
        return best?.element ?? null
      } catch {
        return null
      }
    }

    // The shipped @ popup stays untouched; our member list is attached directly
    // above it (same left/width/background/border/radius) and overlaps its rounded
    // top edge slightly, so the two surfaces read as one continuous list.
    function RoomMentionOverlay(props) {
      const sessionId = props?.sessionId
      const [members, setMembers] = useState([])
      const [native, setNative] = useState(null)
      // Standard hook: must run on every render, even before Room data exists.
      const inputState = (() => {
        try {
          return typeof props?.useInput === 'function' ? props.useInput((state) => state) : null
        } catch {
          return null
        }
      })()

      useEffect(() => {
        if (!sessionId) return undefined
        let disposed = false
        const load = async () => {
          try {
            const response = await fetch('/device-fleet/room?id=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const data = await response.json()
            if (!disposed) setMembers(data.room?.members ?? [])
          } catch {
            /* not a Room session */
          }
        }
        void load()
        const timer = setInterval(load, 4000)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [sessionId])

      useEffect(() => {
        let cachedPanel = null
        const tick = () => {
          const panel = cachedPanel && cachedPanel.isConnected ? cachedPanel : findNativeCompletionPanel()
          if (!panel) {
            setNative(null)
            return
          }
          cachedPanel = panel
          const rect = panel.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return
          let style = null
          try {
            const computed = window.getComputedStyle(panel)
            style = {
              background: computed.backgroundColor,
              color: computed.color,
              border: computed.borderColor,
              radius: computed.borderTopLeftRadius,
              shadow: computed.boxShadow,
            }
          } catch {
            style = null
          }
          setNative((previous) => {
            const next = { left: rect.left, width: rect.width, top: rect.top, style }
            if (previous && Math.abs(previous.left - next.left) < 0.5 && Math.abs(previous.top - next.top) < 0.5 && Math.abs(previous.width - next.width) < 0.5 && JSON.stringify(previous.style) === JSON.stringify(next.style)) return previous
            return next
          })
        }
        tick()
        const timer = setInterval(tick, 200)
        return () => clearInterval(timer)
      }, [])

      useEffect(() => {
        if (!sessionId) return undefined
        let reported = false
        const report = () => {
          if (reported) return
          try {
            const label = [...document.querySelectorAll('div, span')].find(
              (node) => node.childElementCount === 0 && node.textContent?.trim() === '文件与文件夹',
            )
            if (!label) return
            const chain = []
            let element = label
            for (let depth = 0; element && depth < 14; depth += 1, element = element.parentElement) {
              const rect = element.getBoundingClientRect()
              const style = window.getComputedStyle(element)
              chain.push({
                depth,
                tag: element.tagName,
                cls: String(element.className ?? '').slice(0, 140),
                rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
                position: style.position,
                zIndex: style.zIndex,
                background: style.backgroundColor,
                borderRadius: style.borderTopLeftRadius,
              })
            }
            const bodyChildren = [...document.body.children].map((child) => {
              const rect = child.getBoundingClientRect()
              return { tag: child.tagName, cls: String(child.className ?? '').slice(0, 80), rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } }
            })
            reported = true
            void fetch('/device-fleet/room/focus', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ roomId: sessionId, focused: false, debug: { chain, bodyChildren } }),
            }).catch(() => {})
          } catch {
            /* diagnostic only */
          }
        }
        report()
        const timer = setInterval(report, 800)
        return () => clearInterval(timer)
      }, [sessionId])

      const draft = extractDraftText(inputState)
      const mention = /(?:^|\s)@([^\s@]*)$/.exec(draft)
      const query = mention ? mention[1].toLowerCase() : ''
      const candidates = mention && members.length > 0
        ? members.filter((member) => String(member.name ?? '').toLowerCase().includes(query))
        : []
      // Show only while the shipped popup is actually present: this aligns the
      // appearance timing and guarantees the panel disappears with it on View
      // switch instead of hanging at a stale position.
      if (!mention || candidates.length === 0 || !native) return null
      const radius = parseFloat(native?.style?.radius ?? '') || 16
      const gap = 8
      const left = native.left
      const width = native.width
      // Two separate rounded rectangles: ours is complete on all four corners,
      // sits a small gap above the shipped popup, and never overlaps it.
      const bottom = native ? Math.max(4, window.innerHeight - native.top + gap) : 160
      const maxHeight = native ? Math.max(90, native.top - gap - 8) : 260
      const panel = h('div', {
        style: {
          position: 'fixed',
          left,
          width,
          bottom,
          boxSizing: 'border-box',
          zIndex: 2147483000,
          maxHeight,
          overflow: 'auto',
          background: 'var(--dsw-alias-bg-overlay, #1f1f1f)',
          color: 'var(--dsw-alias-label-primary, #e8e8e8)',
          border: '1px solid ' + (native?.style?.border || 'var(--dsw-alias-border-l2, #3a3a3a)'),
          borderRadius: radius,
          boxShadow: native?.style?.shadow || '0 12px 32px rgba(0,0,0,.45)',
          padding: 6,
          font: '12px system-ui, sans-serif',
        },
      },
        h('div', { style: { opacity: 0.6, fontSize: 10, padding: '3px 7px 5px' } }, '发送给 Room 成员（不点名发给所有人）'),
        ...candidates.map((member) =>
          h('button', {
            key: member.memberId,
            type: 'button',
            onMouseDown: (event) => event.preventDefault(),
            onClick: () => insertMentionText(props, member.name),
            style: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12, textAlign: 'left', borderRadius: 6 },
          }, avatarImg('/device-fleet/avatar/' + (member.role === 'host' ? 'host' : 'worker'), member.displayName ?? member.name), (member.displayName ?? member.name ?? '成员') + (member.role === 'host' ? '（主持人）' : '')),
        ),
      )
      try {
        if (typeof document !== 'undefined' && ReactDOM?.createPortal) {
          return ReactDOM.createPortal(panel, document.body)
        }
      } catch {
        /* fall back to the inline panel */
      }
      return panel
    }

    function RoomDock(props) {
      const sessionId = props?.sessionId
      const [room, setRoom] = useState(null)
      const [missing, setMissing] = useState(false)
      const [status, setStatus] = useState('')
      const [loadError, setLoadError] = useState('')

      const load = async () => {
        if (!sessionId) return
        try {
          const response = await fetch('/device-fleet/room?id=' + encodeURIComponent(sessionId), { headers: { accept: 'application/json' } })
          if (response.status === 404) {
            setRoom(null)
            setMissing(true)
            return
          }
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const data = await response.json()
          setRoom(data.room ?? null)
          setMissing(false)
          setLoadError('')
        } catch (problem) {
          setRoom(null)
          setLoadError(String(problem?.message ?? problem))
        }
      }

      useEffect(() => {
        void load()
        const timer = setInterval(load, 4000)
        return () => clearInterval(timer)
      }, [sessionId])

      if (!sessionId) return null

      const upgrade = async () => {
        setStatus('升级中…')
        try {
          await postJson('/device-fleet/room/upgrade', { sessionId })
          setStatus('')
          await load()
        } catch (problem) {
          setStatus('升级失败：' + String(problem.message ?? problem))
        }
      }

      if (missing) {
        return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.75, padding: '2px 2px 0' } },
          h('span', null, '普通会话'),
          status ? h('span', null, status) : null,
          smallButton('升级为 Room', () => void upgrade(), 'normal'),
        )
      }
      if (!room) {
        if (loadError) {
          return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, padding: '2px 2px 0', color: 'var(--dsw-alias-state-warn-primary, #d9a441)' } },
            'Room 数据加载失败：' + loadError,
            smallButton('重试', () => void load(), 'normal'),
          )
        }
        return h('div', { style: { fontSize: 11, opacity: 0.6, padding: '2px 2px 0' } }, 'Room 载入中…')
      }
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, opacity: 0.72, padding: '2px 2px 0' } },
        pill('Room', 'ok'),
        h('span', null, room.members.length + ' 名成员'),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { opacity: 0.6, fontSize: 10 } }, '在上方「房间」Tab 中交流'),
      )
    }

    // Session-native Room view: the Room's transcript, members and board live
    // in their own Conversation View instead of the normal Chat stream.
    function RoomPane({ roomId }) {
      const [detail, setDetail] = useState(null);
      const [missing, setMissing] = useState(false);
      const [error, setError] = useState('');
      const [sendText, setSendText] = useState('');
      const [sendTo, setSendTo] = useState([]);
      const [taskTitle, setTaskTitle] = useState('');
      const [taskOwner, setTaskOwner] = useState('');
      const [status, setStatus] = useState('');

      const load = async () => {
        if (!roomId) return;
        try {
          const response = await fetch('/device-fleet/room?id=' + encodeURIComponent(roomId), { headers: { accept: 'application/json' } });
          if (response.status === 404) {
            setMissing(true);
            setDetail(null);
            return;
          }
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setDetail(data.room ?? null);
          setMissing(false);
          setError('');
        } catch (problem) {
          setError(String(problem.message ?? problem));
        }
      };

      useEffect(() => {
        void load();
        const timer = setInterval(load, 2500);
        return () => clearInterval(timer);
      }, [roomId]);

      // Only route Chat input into the Room while this view is active. Post a
      // heartbeat so a hidden view cannot leave a stale route, and stop on unmount.
      useEffect(() => {
        if (!roomId) return undefined;
        let stopped = false;
        const report = (focused) => {
          if (stopped) return;
          void fetch('/device-fleet/room/focus', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roomId, focused }),
            keepalive: true,
          }).catch(() => {})
        }
        report(true)
        const timer = setInterval(() => report(true), 5000)
        return () => {
          stopped = true
          clearInterval(timer)
          void fetch('/device-fleet/room/focus', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roomId, focused: false }),
            keepalive: true,
          }).catch(() => {})
        }
      }, [roomId]);

      const act = async (label, action) => {
        setStatus(label + '…');
        try {
          await action();
          setStatus(label + '成功');
          await load();
        } catch (problem) {
          setStatus(label + '失败：' + String(problem.message ?? problem));
        }
      };

      if (!roomId) return null;
      if (missing) {
        return h('div', { style: { opacity: 0.75, fontSize: 12 } }, '这个会话还不是 Room。在下方输入框旁点击「升级为 Room」，或让 agent 执行 room_create。');
      }
      if (!detail) return h('div', { style: { opacity: 0.7, fontSize: 12 } }, error ? '房间加载失败：' + error : '加载房间…');

      const ctl = {
        sendText,
        setSendText,
        sendTo,
        setSendTo,
        sendRoomMessage: () =>
          act('发送', async () => {
            if (sendText.trim() === '') throw new Error('消息不能为空');
            await postJson('/device-fleet/room/send', { roomId, to: sendTo, text: sendText });
            setSendText('');
          }),
        taskTitle,
        setTaskTitle,
        taskOwner,
        setTaskOwner,
        addRoomTask: () =>
          act('添加任务', async () => {
            if (taskTitle.trim() === '') throw new Error('任务标题不能为空');
            await postJson('/device-fleet/room/task', { roomId, action: 'add', title: taskTitle, owner: taskOwner });
            setTaskTitle('');
          }),
        updateRoomTask: (id, nextStatus) => act('更新任务', () => postJson('/device-fleet/room/task', { roomId, action: 'update', id, status: nextStatus })),
        closeCurrentRoom: () => act('关闭房间', () => postJson('/device-fleet/room/close', { roomId })),
        removeRoomMember: (memberId) => act('移除成员', () => postJson('/device-fleet/room/member/remove', { roomId, memberId })),
      };

      return h('div', null,
        status ? h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 6 } }, status) : null,
        renderRoomDetail(detail, ctl),
      );
    }

    function avatarKeyForId(id) {
      const text = String(id ?? 'member')
      let hash = 0
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      return ['host', 'worker', 'user'][hash % 3]
    }

    function avatarImg(src, alt) {
      return h('img', {
        src,
        alt,
        draggable: false,
        style: {
          width: 26,
          height: 26,
          borderRadius: '50%',
          flex: '0 0 26px',
          objectFit: 'cover',
          border: '1px solid var(--dsw-alias-border-l1, #333)',
          background: 'var(--dsw-alias-bg-layer-2, #262626)',
        },
      })
    }

    function roomAvatar(name, tone) {
      const kind = tone === 'user' ? 'user' : String(name ?? '') === 'host' ? 'host' : 'worker'
      return avatarImg('/device-fleet/avatar/' + kind, String(name ?? kind))
    }

    // Room conversation rendered as a chat: agents on the left with names and
    // avatars, the user on the right. This is the Room's presentation instead of
    // injecting participant speech into the host's ordinary Chat.
    function RoomChatPane({ roomId }) {
      const [detail, setDetail] = useState(null);
      const [missing, setMissing] = useState(false);
      const [error, setError] = useState('');
      const [sendText, setSendText] = useState('');
      const [sendTo, setSendTo] = useState([]);
      const [status, setStatus] = useState('');
      const [showBoard, setShowBoard] = useState(false);
      const [taskTitle, setTaskTitle] = useState('');
      const [taskOwner, setTaskOwner] = useState('');
      const [inviteOpen, setInviteOpen] = useState(false);
      const [devices, setDevices] = useState([]);

      useEffect(() => {
        let disposed = false;
        const loadDevices = async () => {
          try {
            const response = await fetch('/device-fleet/overview', { headers: { accept: 'application/json' } });
            if (!response.ok) return;
            const data = await response.json();
            const connected = Array.isArray(data.connected) ? data.connected : [];
            const roster = Array.isArray(data.roster) ? data.roster : [];
            if (!disposed) {
              setDevices(roster.filter((entry) => connected.includes(entry.deviceId)).map((entry) => ({ deviceId: entry.deviceId, name: entry.name ?? 'device' })));
            }
          } catch {
            /* keep the current device list */
          }
        };
        void loadDevices();
        const timer = setInterval(loadDevices, 4000);
        return () => { disposed = true; clearInterval(timer) };
      }, []);

      const load = async () => {
        if (!roomId) return;
        try {
          const response = await fetch('/device-fleet/room?id=' + encodeURIComponent(roomId), { headers: { accept: 'application/json' } });
          if (response.status === 404) {
            setMissing(true);
            setDetail(null);
            return;
          }
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const data = await response.json();
          setDetail(data.room ?? null);
          setMissing(false);
          setError('');
        } catch (problem) {
          setError(String(problem.message ?? problem));
        }
      };

      useEffect(() => {
        void load();
        const timer = setInterval(load, 2000);
        return () => clearInterval(timer);
      }, [roomId]);

      const act = async (label, action) => {
        setStatus(label + '…');
        try {
          await action();
          setStatus(label + '成功');
          await load();
        } catch (problem) {
          setStatus(label + '失败：' + String(problem.message ?? problem));
        }
      };

      if (!roomId) return null;
      if (missing) {
        return h('div', { style: { padding: 16, opacity: 0.75, fontSize: 12 } }, '这个会话还不是 Room。点击输入框下方的「升级为 Room」即可创建。');
      }
      if (!detail) return h('div', { style: { padding: 16, opacity: 0.7, fontSize: 12 } }, error ? '房间加载失败：' + error : '加载房间…');

      const nameOf = (memberId) => {
        const member = detail.members.find((entry) => entry.memberId === memberId)
        return member?.displayName ?? member?.name ?? '成员'
      }
      // Avatar belongs to the Room member, not to the viewing device: use the
      // member's persisted avatarKey so A and B render the same face.
      const memberAvatarSrc = (member) => {
        if (!member) return '/device-fleet/avatar/user'
        const key = member.avatarKey ?? avatarKeyForId(member.memberId ?? member.name ?? 'member')
        return '/device-fleet/avatar/' + key
      }
      const participants = detail.members.filter((member) => member.role !== 'host')
      const defaultRecipients = participants.length > 0 ? participants.map((member) => member.memberId) : detail.members.map((member) => member.memberId)
      const recipients = sendTo.length > 0 ? sendTo : defaultRecipients
      const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(sendText)
      const mentionInfo = mentionMatch ? { query: mentionMatch[1], start: sendText.length - mentionMatch[1].length - 1 } : null
      const mentionCandidates = mentionInfo
        ? detail.members.filter((member) => String(member.displayName ?? member.name ?? '').toLowerCase().includes(mentionInfo.query.toLowerCase()))
        : []
      const send = () =>
        act('发送', async () => {
          if (sendText.trim() === '') throw new Error('消息不能为空')
          const mentioned = [...sendText.matchAll(/@([^\s@]+)/g)]
            .flatMap((match) => detail.members.filter((member) => [member.name, member.displayName].filter(Boolean).includes(match[1])))
            .map((member) => member.memberId)
          const targets = [...new Set([...recipients, ...mentioned])]
          await postJson('/device-fleet/room/send', { roomId, to: targets.length > 0 ? targets : defaultRecipients, text: sendText })
          setSendText('')
        })

      const messages = detail.messages.map((message) => {
        const fromUser = message.from?.kind === 'user'
        const senderMember = fromUser ? null : detail.members.find((member) => member.memberId === message.from?.memberId)
        const author = fromUser ? '你' : senderMember?.displayName ?? message.fromLabel ?? '成员'
        const targets = (message.to ?? []).map(nameOf).join('、')
        return h('div', { key: message.id, style: { display: 'flex', justifyContent: fromUser ? 'flex-end' : 'flex-start', gap: 9, margin: '12px 0' } },
          fromUser ? null : avatarImg(memberAvatarSrc(senderMember), author),
          h('div', { style: { maxWidth: '72%' } },
            fromUser ? null : h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 3, display: 'flex', gap: 6, alignItems: 'center' } },
              h('span', { style: { fontWeight: 600, opacity: 0.9 } }, author),
              targets ? h('span', { style: { opacity: 0.55 } }, '→ ' + targets) : null),
            h('div', {
              style: {
                background: fromUser ? 'linear-gradient(180deg, #3b82f6, #2f6fed)' : 'var(--dsw-alias-bg-layer-2, #262626)',
                color: fromUser ? '#fff' : 'var(--dsw-alias-label-primary, #e8e8e8)',
                padding: '9px 13px',
                borderRadius: fromUser ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                border: fromUser ? 'none' : '1px solid rgba(128,128,128,.14)',
                boxShadow: '0 1px 2px rgba(0,0,0,.12)',
                whiteSpace: 'pre-wrap',
                fontSize: 13,
                lineHeight: 1.55,
              },
            }, message.text),
            h('div', { style: { fontSize: 10, opacity: 0.4, marginTop: 3, textAlign: fromUser ? 'right' : 'left' } }, fmtTime(message.createdAt)),
          ),
          fromUser ? avatarImg('/device-fleet/avatar/user', '你') : null,
        )
      })

      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', padding: '12px 16px', boxSizing: 'border-box' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 } },
          h('strong', { style: { fontSize: 16, fontWeight: 650 } }, detail.title ?? '房间'),
          detail.sync
            ? h('span', {
                title: detail.sync.role === 'authority'
                  ? 'Room replica: authority; lastSeq=' + detail.sync.lastSeq
                  : 'Room replica: mirror; lastSeq=' + detail.sync.lastSeq + (detail.sync.pendingEvents?.length
                    ? '\n待同步：' + detail.sync.pendingEvents.map((event) => event.type + ' @ 其他设备').join('、')
                    : ''),
                style: {
                  fontSize: 10,
                  opacity: 0.75,
                  padding: '2px 6px',
                  borderRadius: 999,
                  border: '1px solid var(--dsw-alias-border-l1, #333)',
                  whiteSpace: 'nowrap',
                },
              }, detail.sync.role === 'authority'
                ? '副本 · 主设备'
                : (detail.sync.pending > 0 ? '副本 · 待同步 ' + detail.sync.pending : '副本 · 已同步'))
            : null,
          ...detail.members.map((member) =>
            h('span', { key: member.memberId, style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.8 } },
              avatarImg(memberAvatarSrc(member), member.displayName ?? member.name ?? '成员'),
              (member.displayName ?? member.name ?? '成员') + (member.role === 'host' ? '（主持人）' : member.kind === 'remote' ? '（远程）' : ''),
            ),
          ),
          h('span', { style: { flex: 1 } }),
          status ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, status) : null,
          smallButton('邀请码', () => {
            void act('创建邀请码', async () => {
              const data = await postJson('/device-fleet/room/invite', { roomId })
              const code = data?.result?.code ?? data?.code
              if (!code) throw new Error('invite code missing')
              try { await navigator.clipboard?.writeText(code) } catch {}
              setStatus('邀请码已复制：' + code.slice(0, 24) + '…')
            })
          }, 'normal'),
          smallButton('移除设备', () => {
            const deviceId = typeof window !== 'undefined' && typeof window.prompt === 'function'
              ? window.prompt('要从此 Room 移除的 Fleet device id：')
              : ''
            if (!deviceId) return
            void act('移除设备', () => postJson('/device-fleet/room/remove-device', { roomId, deviceId }))
          }, 'deny'),
          smallButton('移除 Fleet 设备', () => {
            const deviceId = typeof window !== 'undefined' && typeof window.prompt === 'function'
              ? window.prompt('要从 Fleet 移除的 device id（会级联移除所有 Room 成员）：')
              : ''
            if (!deviceId) return
            void act('移除 Fleet 设备', () => postJson('/device-fleet/fleet/remove-device', { deviceId }))
          }, 'deny'),
          devices.some((device) => !detail.members.some((member) => member.deviceId === device.deviceId))
            ? smallButton(inviteOpen ? '收起邀请' : '邀请设备', () => setInviteOpen((value) => !value), 'normal')
            : null,
          smallButton(showBoard ? '收起看板' : '看板', () => setShowBoard((value) => !value), 'normal'),
          smallButton(detail.archived ? '取消归档' : '归档', () => {
            void act('归档 Room', () => postJson('/device-fleet/room/archive', { roomId, archived: !detail.archived }))
          }, 'normal'),
          smallButton('GC', () => {
            void act('GC Room', () => postJson('/device-fleet/room/gc', { roomId, minEvents: 400 }))
          }, 'normal'),
          smallButton('删除 Room', () => {
            if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !confirmText('删除本地 Room 副本？会先关闭 Room。')) return
            void act('删除 Room', async () => {
              await postJson('/device-fleet/room/delete', { roomId })
              setSelectedRoom(null)
            })
          }, 'deny'),
          smallButton('Coordinator', () => {
            const deviceId = typeof window !== 'undefined' && typeof window.prompt === 'function'
              ? window.prompt('Coordinator device id（当前 ' + String(detail.coordinatorDeviceId ?? '未设置') + '）：')
              : ''
            if (!deviceId) return
            void act('设置 Coordinator', () => postJson('/device-fleet/room/coordinator', { roomId, deviceId }))
          }, 'normal'),
          smallButton('Authority', () => {
            const authorityDeviceId = typeof window !== 'undefined' && typeof window.prompt === 'function'
              ? window.prompt('新 authority device id（当前 ' + String(detail.authorityDeviceId ?? '未设置') + '，epoch ' + String(detail.authorityEpoch ?? 0) + '）：')
              : ''
            if (!authorityDeviceId) return
            void act('转移 Authority', () => postJson('/device-fleet/room/authority', { roomId, authorityDeviceId }))
          }, 'normal'),
          smallButton('关闭房间', () => { void act('关闭房间', () => postJson('/device-fleet/room/close', { roomId })) }, 'deny'),
        ),
        detail.sync?.pendingEvents?.length
          ? h('details', { style: { ...cardStyle, marginBottom: 8, fontSize: 12 } },
              h('summary', { style: { cursor: 'pointer', opacity: 0.8 } }, '待同步事件（' + detail.sync.pendingEvents.length + '）'),
              h('div', { style: { marginTop: 6, fontFamily: 'ui-monospace, monospace', opacity: 0.75 } },
                ...detail.sync.pendingEvents.map((event) =>
                  h('div', { key: event.id }, event.type + ' · ' + String(event.origin ?? '').slice(0, 10) + ' · ' + fmtTime(event.createdAt)),
                ),
              ),
            )
          : null,
        inviteOpen
          ? h('div', { style: { ...cardStyle, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 } },
              h('span', { style: { opacity: 0.65 } }, '加入已连接设备：'),
              ...devices
                .filter((device) => !detail.members.some((member) => member.deviceId === device.deviceId))
                .map((device) =>
                  h('button', {
                    key: device.deviceId,
                    type: 'button',
                    onClick: () => void act('邀请设备', () => postJson('/device-fleet/room/add-remote', { roomId, deviceId: device.deviceId, name: device.name })),
                    style: { padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1, #333)', background: 'transparent', color: 'inherit', fontSize: 11, cursor: 'pointer' },
                  }, device.name),
                ),
              devices.length === 0 ? h('span', { style: { opacity: 0.55 } }, '暂无已连接设备') : null,
            )
          : null,
        h('div', { style: { flex: 1, overflow: 'auto', minHeight: 120 } }, messages.length === 0 ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, '还没有消息') : messages),
        showBoard
          ? h('div', { style: { ...cardStyle, marginTop: 8 } },
              h('div', { style: sectionTitle }, '看板'),
              detail.tasks.length === 0 ? h('div', { style: { opacity: 0.65, fontSize: 12 } }, '暂无任务') : detail.tasks.map((task) =>
                h('div', { key: task.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 12 } },
                  h('span', { style: { flex: 1 } }, task.title + ' · ' + nameOf(task.owner)),
                  h('select', {
                    value: task.status,
                    onChange: (event) => void act('更新任务', () => postJson('/device-fleet/room/task', { roomId, action: 'update', id: task.id, status: event.target.value })),
                    style: { height: 24, borderRadius: 5, border: '1px solid var(--dsw-alias-border-l1, #333)', background: 'var(--dsw-alias-bg-layer-2, #262626)', color: 'inherit', fontSize: 11 },
                  }, ...['pending', 'running', 'done', 'blocked'].map((value) => h('option', { key: value, value }, value))),
                ),
              ),
              h('div', { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
                h('input', { type: 'text', value: taskTitle, onChange: (event) => setTaskTitle(event.target.value), placeholder: '新任务', style: { ...controlStyleWidth(160), height: 26, fontSize: 12 } }),
                h('select', { value: taskOwner, onChange: (event) => setTaskOwner(event.target.value), style: { ...controlStyleWidth(150), height: 26, fontSize: 12 } },
                  h('option', { value: '' }, 'owner'),
                  ...detail.members.map((member) => h('option', { key: member.memberId, value: member.memberId }, member.displayName ?? member.name ?? '成员')),
                ),
                smallButton('添加', () => void act('添加任务', () => postJson('/device-fleet/room/task', { roomId, action: 'add', title: taskTitle, owner: taskOwner })), 'allow'),
              ),
            )
          : null,
        h('div', { style: { ...cardStyle, marginTop: 8, fontSize: 12, opacity: 0.75 } },
          '在下方 DSH 输入框发送：用 @成员名 点名（例如 @worker-c），不点名则发给所有人。',
        ),
      )
    }

    function RoomView({ sessionId }) {
      return h('div', { style: { height: '100%' } }, h(RoomChatPane, { roomId: sessionId }));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => startPolling());
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'fleet-approvals', order: 5, label: 'Fleet 审批' }, Trigger),
        );
        // `shell.overlay` and `main` are declared by dsh-client-ui-layout's root
        // registration, not by the shell at page start. Client entries are all
        // created concurrently, so a direct register can run before that
        // declaration exists and throws `slot "…" is not declared`, which fails
        // this whole entry (web boot: "dsh-device-fleet: failed"). Wait for the
        // declaration like every shipped client plugin does.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'fleet-approvals-panel', order: 10 }, withI18n(Panel)),
        );
        // Global Fleet console: sidebar icon + matching main panel.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'fleet', order: 20, label: '设备联邦' }, FleetIcon),
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'fleet' }, withI18n(FleetConsole)),
        );
        // Session-native Room: member strip below the composer, plus a "房间"
        // Conversation View for the Room transcript/board.
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register({ name: 'conversation.input.overlay', id: 'fleet-room-mention', order: 10 }, withI18n(RoomMentionOverlay)),
        );
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'fleet-room', order: 10 }, withI18n((props) =>
            h(RoomDockBoundary, null, h(RoomDock, props)),
          )),
        );
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({ name: 'conversation.view', id: 'room', order: 20, label: '房间' }, withI18n(RoomView)),
        );
      },
    };
  },
});
