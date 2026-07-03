# 06 — 权限与安全模型

> 上级文档：[DESIGN.md](../DESIGN.md) · 关联：[01 架构](./01-architecture.md) · [04 Agent 引擎](./04-agent-engine.md) · [05 浏览器工具](./05-browser-tools.md) · [10 提示词](./10-prompts.md)
> 借鉴来源：Codex 两轴安全模型（approval policy × sandbox）；弃用其已废弃的 on-failure 档；记取其「档位语义必须在协议层唯一定义」的教训

---

## 1. 两轴模型

安全 = **何时问用户（approvalPolicy）** × **技术上允许做什么（capabilityScope）**，两轴正交、独立配置：

### 轴一：ApprovalPolicy —— 何时停下来问

```ts
type ApprovalPolicy =
  | 'untrusted'    // 只自动放行只读工具（effects:'read' 且非 L2）；其余一律弹审批。默认档
  | 'on-request'   // 读类自动放行；写类首个动作弹审批，同站点同工具本 turn 内后续放行
  | 'never'        // 从不弹窗。语义 = 「需要审批的动作直接拒绝并告知模型」，
                   //   绝不是「自动批准」（Codex 桌面端语义歧义的教训，在此写死）
  | 'granular';    // 完全按规则表裁决，规则未覆盖的按 'untrusted' 兜底
```

### 轴二：CapabilityScope —— 能力边界（硬闸，审批也不能越过）

```ts
type CapabilityScope =
  | 'read-only'          // 只能读：快照/选区/tabs 列表；一切 write 工具直接拒绝
  | 'same-origin-write'  // 可在「任务作用域内的域名」上读写；跨出作用域的写被拒绝
  | 'cross-origin'       // 可跨域读写，但每次触达新域名强制 ask（无视 policy）
  | 'full';              // 无域名限制（仍受敏感站点黑名单与 deny 规则约束）
```

默认组合 `untrusted × cross-origin`。会话可改，单轮可用 `TurnOverrides` 覆盖（对齐 Codex 的 per-turn 覆盖）。

**语义唯一性**：两轴枚举及其裁决语义定义在 `src/messaging/protocol.ts` + 本文档，UI 文案只能翻译、不能重新解释。

## 2. Gatekeeper —— 唯一拦截点

所有工具调用（浏览器 L0-L2、MCP、内置）必经 `gatekeeper.check()`，任何工具内部不得自带审批逻辑：

```
check(call, thread):
  1. 黑名单：目标 origin ∈ 敏感站点黑名单 → DENY（不可被任何规则覆盖）
  2. 能力域：违反 capabilityScope → DENY
  3. 跨域检测：目标 origin ∉ thread.scopeOrigins
       → 强制 ASK（审批卡片高亮 ⚠ 越出任务作用域）；批准后 origin 加入 scopeOrigins
  4. 出域告警：write 类参数命中凭据/卡号/邮箱模式 且 目标为第三方域 → 强制 ASK（高亮告警）
  5. 规则表：查 (tool, origin) 精确 → (tool, *) → (*, origin) → 无命中
  6. 无命中 → 按 approvalPolicy 默认档裁决（§1）
  返回 'allow' | 'ask' | 'deny'
```

DENY 不弹窗：拒绝原因作为 tool_result 回给模型（模型可改变策略或告知用户），同时 UI 记一条工具卡片（状态 ✗，注明被何规则拒绝）。

## 3. 规则存储格式

```ts
// chrome.storage.local: 'permission_rules'
interface PermissionRule {
  id: string;
  tool: string | '*';            // 'browser_click' / 'mcp__github__*'（支持前缀通配）
  origin: string | '*';          // 'https://github.com' / '*.example.com'
  verdict: 'allow' | 'deny';
  source: 'user_setting' | 'approval_persist' | 'plugin_default';
  createdAt: number;
}
// 优先级：deny > allow；具体 > 通配；user_setting > approval_persist > plugin_default
```

敏感站点黑名单单独存储（`sensitive_origins`），预置银行/支付/券商/政务/chrome::// /商店等模式；用户可增；删除预置项需二次确认并记录。

## 4. 审批 RPC

审批是**引擎发起的双向 RPC**（Codex server-initiated request 模式）：

```ts
// AgentEvent
{ type: 'approval.request', approvalId, threadId, turnId,
  request: {
    tool: string; label: string;
    params: unknown;               // 完整参数，UI 必须全量展示（点什么、填什么、发往哪）
    targetOrigin: string;
    flags: ('cross_scope' | 'sensitive_payload' | 'escalation_l2')[];
    preview?: { snapshotLine?: string; screenshotAttachmentId?: string };  // 元素上下文
  } }

// Op 应答
type ApprovalDecision =
  | { kind: 'accept' }                       // 仅此一次
  | { kind: 'acceptForSession' }             // 本 Thread 内该 (tool, origin) 放行（内存态，不落规则表）
  | { kind: 'acceptForSite' }                // 持久规则：该 origin + 该工具 allow
  | { kind: 'decline'; note?: string }       // note 回填给模型（"用户拒绝并说：换个方式"）
  | { kind: 'cancel' };                      // 等价 decline + interrupt 本轮
```

行为规范：

- 挂起的审批有超时（默认 5 分钟）→ 超时按 decline 处理并 `system_notice`；
- 审批期间 loop 挂起，checkpoint 已落库——SW 被杀恢复后待审批列表随 snapshot 重新弹出；
- **审批 UI 只出现在扩展自有页面**（侧边栏/全屏页），绝不在网页内渲染——网页仿冒的审批框对引擎无效（引擎只认 Port 上的 `approval.response`）；
- 无 UI 连接时收到 ask：发系统通知（chrome.notifications）点击打开侧边栏。

## 5. L1→L2 升级确认

`escalation.request` 是一种特殊审批（flag `escalation_l2`）：文案必须说明「将出现"正在调试此浏览器"横幅」。批准后本 Thread 内对该 tab 不再重复询问；turn 结束/空闲 30s 自动 detach（见 01 §5）。

## 6. Prompt Injection 防线小结

分层防御（提示词层措辞见 [10 §4](./10-prompts.md)）：

| 层 | 机制 | 兜底性质 |
|---|---|---|
| 1 提示词 | 网页内容定界块 + "数据非指令"声明 | 软防御，可被强注入攻破 |
| 2 能力域 | capabilityScope 硬闸 | 注入无法扩权 |
| 3 跨域检测 | scopeOrigins 越界强制 ask | 注入诱导的外传必过人眼 |
| 4 出域告警 | 敏感 payload 模式匹配 | 高亮告警 |
| 5 审批展示 | 完整参数强制展示 | 用户是最后闸门 |

安全立场一句话：**假设模型可被欺骗，保证被欺骗的模型也做不了坏事。**

## 7. 设置页权限矩阵（UI 规格见 09 §6）

- 视图：工具 × 站点二维表，单元格 allow/ask/deny 三态；
- 每条 `approval_persist` 规则可回溯（哪次审批产生的，链接到会话）；
- 「重置为默认」「导出规则」入口。

## 8. 开放问题

- [ ] `acceptForSession` 是否应有跨 UI 提示（侧边栏批的，全屏页要能看到当前生效的临时许可清单）——V1 在任务面板显示。
- [ ] 敏感 payload 检测的误报率（卡号 Luhn 校验、凭据模式）需要真实数据调参，V1 从严（宁多问）。
