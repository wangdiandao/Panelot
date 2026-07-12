# 06 — 权限与安全模型

> 文档索引：[README.md](../README.md) · 关联：[01 架构](./01-architecture.md) · [04 Agent 引擎](./04-agent-engine.md) · [05 浏览器工具](./05-browser-tools.md) · [10 提示词](./10-prompts.md)
> 借鉴来源：Codex 两轴安全模型（approval policy × sandbox）；弃用其已废弃的 on-failure 档；记取其「档位语义必须在协议层唯一定义」的教训

---

## 1. 两轴模型

安全 = **何时问用户（approvalPolicy）** × **技术上允许做什么（capabilityScope）**，两轴正交、独立配置：

### 轴一：ApprovalPolicy —— 何时停下来问

```ts
type ApprovalPolicy =
  | 'always'       // 浏览器/MCP 工具调用都问，读也问；todo_write/memory_read/load_skill 例外直放
  | 'untrusted'    // 读自动放行；写一律弹审批。默认档
  | 'on-request'   // 当前运行时默认裁决与 untrusted 相同；选择 acceptForSession 后同 Thread 放行
  | 'never'        // 从不弹窗。语义 = 「需要审批的动作直接拒绝并告知模型」，
                   //   绝不是「自动批准」（Codex 桌面端语义歧义的教训，在此写死）
  | 'granular'     // 完全按规则表裁决，规则未覆盖的按 'untrusted' 兜底
  | 'auto';        // 写自动放行；安全底线（黑名单、敏感 payload 强制 ask、
                   //   规则表 deny/ask）依然生效——auto 不是绕过
```

### 轴二：CapabilityScope —— 能力边界（硬闸，审批也不能越过）

> **只做黑名单，不做白名单；读操作永不拦截。**
> Agent 有权读取任何页面（含黑名单站点、含 L2 截图）；一切拦截只作用于写操作。
> 不设域名白名单机制；`cross_scope` 强制审批已经废弃。`scopeOrigins` 仅辅助判断敏感 payload 是否正在发往此前未触达的第三方 origin，并保留审计痕迹。

```ts
type CapabilityScope =
  | 'read-only'          // 只能读：一切 write 工具直接拒绝（唯一保留的能力硬闸）
  | 'same-origin-write'  // 遗留值（白名单时代）：行为等同 full
  | 'cross-origin'       // 遗留值（白名单时代）：行为等同 full
  | 'full';              // 写操作按审批策略执行（仍受敏感站点黑名单与 deny 规则约束）
```

默认组合 `untrusted × full`。会话可改，单轮可用 `TurnOverrides` 覆盖（对齐 Codex 的 per-turn 覆盖）。

当前 `on-request` 没有“普通 accept 后自动记忆到本 turn”的独立缓存；只有用户显式选择 `acceptForSession` 才写入 Thread 级内存授权。设置页现有说明仍写“本轮同站同工具后续放行”，属于待统一的 UI 文案，不应据此推断运行时行为。

`RealEngineCore.startTurn()` 在 Provider/Preset/单轮 override 全部解析后，把实际 approvalPolicy 与 capabilityScope 同步给 Gatekeeper，并固化进 `ResolvedRunEnvironment`；read-only 是执行硬闸，不只是审计字段。

**语义唯一性**：两轴枚举及其裁决语义定义在 `src/messaging/protocol.ts` + 本文档，UI 文案只能翻译、不能重新解释。

## 2. Gatekeeper —— 唯一拦截点

所有工具调用（浏览器 L0-L2、MCP、内置）必经 `gatekeeper.check()`，任何工具内部不得自带审批逻辑：

```
check(call, thread):
  0. todo_write / memory_read / load_skill → ALLOW；其余读操作（effects:'read'，任何级别）
     → ALLOW（唯一例外：approvalPolicy = 'always' 时读也 ask）
  —— 以下仅写操作 ——
  1. 黑名单：目标 origin ∈ 敏感站点黑名单 → DENY（不可被任何规则覆盖）
  2. 能力域：read-only → DENY（same-origin-write / cross-origin 为遗留值，等同 full）
  3. 出域告警：参数命中凭据/卡号/邮箱模式 且 目标为第三方域 → 强制 ASK（高亮告警）
  4. 规则表 deny/ask：查 (tool, origin) 精确 → (tool, *) → (*, origin)；
     deny → DENY；ask → 强制 ASK（会话授权不能消音；never 策略下降级为 DENY）
  5. 会话授权（acceptForSession）→ ALLOW；规则表 allow → ALLOW
  6. 无命中 → 按 approvalPolicy 默认档裁决（§1）
  返回 'allow' | 'ask' | 'deny'
```

**目的地归因**（借鉴 agent-browser 的威胁模型）：带 URL 参数的写操作（`navigate` / `tab_open` / `download`）按**目的地 origin** 裁决，而非当前标签页 origin——从黑名单页面导航*离开*是合法的，导航*前往*黑名单站点才拒绝；规则与会话授权也挂在目的地上，批准一次导航不会静默授权从同一页面导航到任何别处。脚本执行协议目的地（`javascript:` / `data:` / `vbscript:`）硬拒——它们等同于在页面执行脚本，与 `run_javascript` 的默认拒绝姿态一致。域名匹配会归一化 FQDN 尾点（`chase.com.` ≡ `chase.com`），防止绕过黑名单。

`cross_scope` 审批 flag 已废弃（协议保留枚举值以兼容旧数据，引擎不再发出）。

DENY 不弹窗：拒绝原因作为 tool_result 回给模型（模型可改变策略或告知用户），同时 UI 记一条工具卡片（状态 ✗，注明被何规则拒绝）。

## 3. 规则存储格式

```ts
// chrome.storage.local: 'permission_rules'
interface PermissionRule {
  id: string;
  tool: string | '*';            // 'click' / 'mcp__github__*'（前缀通配）/ 'category:eval'（动作类别）
  origin: string | '*';          // 'https://github.com' / '*.example.com'
  verdict: 'allow' | 'ask' | 'deny';  // ask = 强制确认（agent-browser 的 confirm 裁决）
  source: 'user_setting' | 'approval_persist' | 'plugin_default';
  createdAt: number;
}
// 优先级：deny > ask > allow；具体 > 通配；user_setting > approval_persist > plugin_default
```

**动作类别**（借鉴 agent-browser 的 action categories，只覆盖写工具——读永不进规则表）：

| 类别 | 工具 |
|---|---|
| `navigate` | navigate, tab_open, tab_focus, tab_close, go_back, go_forward, session_restore |
| `organize` | tabs_group, tab_group_update |
| `click` | click, click_xy |
| `fill` | type, select_option, press_key, batch_actions |
| `eval` | run_javascript |
| `download` | download |
| `upload` | upload_file |
| `interact` | hover, drag |
| `memory` | memory_write |
| `mcp` | 所有 mcp__* 工具 |

规则 `tool` 字段写 `category:eval` 即匹配整个类别，例如 `{ tool: 'category:fill', origin: '*', verdict: 'ask' }` = 所有表单填写动作强制确认。

敏感站点由代码中的 `DEFAULT_SENSITIVE_PATTERNS` 与 storage 的 `sensitive_origins` 合并。设置页可查看内置数量并添加/删除用户模式，不能删除内置项。

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

- 挂起的审批有超时（默认 5 分钟）→ 超时解析为带说明的 decline，随后作为工具拒绝结果回给模型；当前不会另写一条 `system_notice`；
- 审批期间 loop 挂起，tool_call 已落库；待审批请求本身只存在 SW 内存。SW 存活时重连 UI 会从 snapshot 取回 pending approval；若 SW 在审批期间被杀，只能按“轮次被中断”恢复，原审批请求不会重建；
- **审批 UI 只出现在扩展自有页面**（侧边栏/全屏页），绝不在网页内渲染——网页仿冒的审批框对引擎无效（引擎只认 Port 上的 `approval.response`）；
- ask 请求写入 `approvals` 表并随 ThreadSnapshot 恢复；无 UI 时不会丢失。后台会为待审批和暂停任务创建浏览器通知，点击通知会打开对应 Thread；通知只带状态摘要，不带工具参数或网页内容。

## 5. debugger / L2 提示语义

当前 `escalation_l2` 是**审批展示 flag**，不是独立强制审批规则：当某个 L2 write 因 approvalPolicy 或规则表进入审批时，卡片会说明浏览器将显示 debugger 横幅；L2 read 在非 `always` 策略下直接放行，`auto` 策略下未命中安全底线的 L2 write 也不会仅因 L2 而弹窗。CDP 连接按 tab 单 target 串行化并在空闲 30s 后 detach；尚无 turn 结束立即 detach，也没有“批准一次后按 tab 记录升级许可”的单独状态。

`press_key` 明确标为 L2，并使用 CDP trusted key；无 CDP 的测试/降级环境才使用合成事件并在结果中明确提示可能未触发原生行为。

## 6. Prompt Injection 防线小结

分层防御（提示词层措辞见 [10 §4](./10-prompts.md)）：

| 层 | 机制 | 兜底性质 |
|---|---|---|
| 1 提示词 | 网页内容定界块（每次调用随机 nonce，内容中仿冒的 fence 标记被去牙化）+ "数据非指令"声明 | 软防御 + 结构防伪（nonce 借鉴 agent-browser content boundaries） |
| 2 能力域 | capabilityScope 硬闸 + 敏感站点黑名单（含目的地归因：诱导导航去银行/支付站直接 DENY） | 注入无法扩权、无法把用户带去高危站点 |
| 3 规则 ask | `ask` 裁决规则（含 category:）——用户圈定的高危面（eval/download/…）必过人眼，会话授权不能消音 | 注入诱导的高危动作必过人眼 |
| 4 出域告警 | 敏感 payload 模式匹配 → 强制 ask | 高亮告警 |
| 5 审批展示 | 完整参数强制展示 | 用户是最后闸门 |

安全立场一句话：**假设模型可被欺骗，保证被欺骗的模型也做不了坏事。**

## 7. 设置页权限矩阵（UI 规格见 09 §6）

- 视图：规则表（工具 × 站点 × 裁决 allow/ask/deny 三态 × 来源），支持手动添加（工具名 / 前缀通配 / `category:` 类别）与删除；
- 支持默认 approvalPolicy/capabilityScope 选择，以及用户自定义敏感站点模式；
- 当前只展示规则 source 字段，没有从 `approval_persist` 规则跳回原会话、重置默认或单独导出规则的入口。

## 8. 已定事项

- `acceptForSession` 授权是引擎内存态、Thread 级——所有订阅该 Thread 的 UI 看到同样的裁决结果，天然跨 UI 一致；不单独做「当前生效临时许可清单」视图，审批卡片与任务面板的痕迹已足够回溯。
- 敏感 payload 检测（卡号 Luhn 校验、凭据模式）从严设置：宁可多问一次，不做静默放行。误报率调参需要真实使用数据，规则阈值留在 `rules.ts` 单点可调。
