# 05 — 浏览器工具集

> 上级文档：[DESIGN.md](../DESIGN.md) · 关联：[04 Agent 引擎](./04-agent-engine.md) · [06 权限](./06-permissions.md) · [10 提示词](./10-prompts.md)
> 借鉴来源：Playwright MCP 的快照格式与 element+ref 双参数；Chrome DevTools MCP 的版本化 uid；browser-use 的分层等待与"变化即中断"；nanobrowser 的漏检/死循环反面教训

---

## 1. 页面快照规范（L1 产出，Agent 感知的核心）

### 1.1 格式

YAML 缩进树，每行一个可访问节点：`role "可访问名" [属性] [ref=sN_M]`

```yaml
# Page Snapshot (s3)
URL: https://example.com/login
Title: 登录 - Example

- heading "登录" [level=1]
- form "登录表单" [ref=s3_1]
  - textbox "邮箱" [value="user@example.com"] [ref=s3_2]
  - textbox "密码" [type=password] [ref=s3_3]
  - checkbox "记住我" [checked] [ref=s3_4]
  - button "登录" [ref=s3_5]
- link "忘记密码？" [ref=s3_6]
- text: "还没有账号？"
- link "注册" [ref=s3_7]
--- 正文摘录 (Readability, 截断至 2000 tokens) ---
<Markdown 正文>
```

规则：

- **ref = `s{snapshotId}_{nodeIndex}`**：snapshotId 为 tab 内单调递增的快照版本号。**执行层校验 ref 前缀必须等于该 tab 当前最新快照 id，过期直接拒绝**并返回「快照已过期，请重新 read_page」——从协议层杜绝 state divergence（nanobrowser/browser-use 的顽疾）。
- 交互后**填值回显**：`[value="..."]`；ARIA 状态方括号表示：`[checked]` `[disabled]` `[expanded]` `[selected]` `[invalid]`。
- 纯文本节点 `- text: "..."`，多行压平空白。
- **selector_map**（内存态，不落库）：content script 内 `Map<ref, WeakRef<Element>>`；L2 需要时另存 `ref → backendNodeId`（经 `DOM.pushNodesByBackendIdsToFrontend` 翻译），构成 L1↔L2 的统一定位层。

### 1.2 可交互元素检测（优先 recall）

判定为可交互（获得 ref）的条件，**任一命中即编号**：

1. 语义标签/role：a、button、input、select、textarea、summary、`role∈{button,link,checkbox,menuitem,tab,option,switch,combobox,slider}`；
2. `tabindex >= 0`、`contenteditable`；
3. `cursor: pointer` 的最内层元素（computed style）；
4. L2 可用时：`DOMDebugger.getEventListeners` 命中 click/mousedown/keydown（这是 L2 的独有增强，L1 拿不到监听器）。

去重与折叠：可点父子链（外层容器 + 内层真实控件）折叠为**最内层可命中目标**单一 ref——直接针对 nanobrowser「外层无语义、内层才可点」的漏检教训。宁多编号勿漏（recall 优先），配合截断控制体积。

### 1.3 体积控制

- 视口内元素全量 + 视口外交互元素保留（截断其文本）；单快照目标 ≤ 3000 tokens，超限从「视口外非交互文本」开始丢弃并在快照尾部注明 `[已截断: N 个节点]`（不静默截断）；
- 交互工具执行后返回**增量快照**：只含发生变化的子树 + 新 snapshotId（完整快照可随时用 read_page 重取）。

### 1.4 感知降级链

```
L1 DOM 遍历建树
  └─ 失败/空树 → L2 CDP Accessibility.getFullAXTree 兜底
       └─ 仍失败（纯 Canvas 等）→ screenshot + vision 坐标模式（需模型有 vision）
```

任何一级失败都返回明确错误给模型（触发下一级），**绝不静默返回空树**（nanobrowser 空树死循环教训）。

## 2. L1 / L2 职责矩阵与升级

| 能力 | L1 (content script) | L2 (chrome.debugger) |
|---|---|---|
| DOM 快照/正文抽取 | ✅ 默认 | AXTree 兜底 |
| click / 填表 / select | ✅ `element.click()` + 派发 input/change 事件 | trusted 原生事件（`Input.dispatch*`） |
| 跨域 iframe / closed shadow root | ❌ | ✅ `DOM.getDocument{pierce}` |
| 真实键鼠序列 / 拖拽 | ❌（合成事件可能被框架忽略） | ✅ |
| 截图 | ❌ | ✅ `Page.captureScreenshot` |
| 文件上传 | ❌ | ✅ `DOM.setFileInputFiles` |
| 事件监听器探测 | ❌ | ✅ `DOMDebugger.getEventListeners` |
| 网络静默判定 | 定时轮询近似 | ✅ `Network.*` 精确 |

**自动升级触发器**（触发 `escalation.request`，见 06 §5）：模型请求 L2-only 工具；L1 click 后 DOM 无预期变化（连续 2 次）；目标 ref 位于跨域 iframe / closed shadow root；type 目标框架吞合成事件（值未变化）。attach 按 tab 粒度，turn 结束或空闲 30s 自动 detach。**debugger 单 target 约束**：一次只 attach 一个 tab，多 tab 任务按需切换 attach（由 Gateway 排队串行化）。

## 3. 工具清单与 Schema

交互工具统一 **`element`（人类可读描述，供审批展示与模型自核）+ `ref`（精确定位）双参数**。zod 定义即真相，下表为摘要：

### L0 —— 标签页（无注入）

| 工具 | 参数 | effects |
|---|---|---|
| `tabs_list` | — | read |
| `tab_open` | `{ url }` | write |
| `tab_activate` | `{ tabId }` | write |
| `tab_close` | `{ tabId }` | write |
| `navigate` | `{ url }`（当前受控 tab） | write |
| `go_back` / `go_forward` | — | write |

### L1 —— 感知与交互

| 工具 | 参数 | effects |
|---|---|---|
| `read_page` | `{ mode?: 'snapshot'\|'article'\|'full', maxTokens? }` | read |
| `find_in_page` | `{ query }` → 命中节点带 ref 的片段列表 | read |
| `get_selection` | — | read |
| `click` | `{ element, ref, button?: 'left'\|'right', doubleClick? }` | write |
| `type` | `{ element, ref, text, mode?: 'replace'\|'append', submit?, slowly? }` | write |
| `select_option` | `{ element, ref, values: string[] }` | write |
| `press_key` | `{ key }`（'Enter'、'Control+a' 等） | write |
| `scroll` | `{ target?: ref, direction, amount?: 'page'\|'end'\|px }` | read |
| `hover` | `{ element, ref }` | write |
| `wait_for` | `{ text? , textGone?, timeMs? }` 三态其一 | read |
| `extract` | `{ schema: JsonSchema, scope?: ref }` → 结构化 JSON | read |
| `batch_actions` | `{ actions: (click\|type\|select_option)[] (≤4) }` | write |
| `run_javascript` | `{ code, world: 'MAIN' }` — 默认 deny，设置页显式开启 | write |

`batch_actions` 语义（抄 browser-use）：按序执行，**任一动作导致 DOM 显著变化立即中断剩余动作**，返回已执行清单 + 新增量快照。审批时整批一次展示。

### L2 —— 高级（均触发升级确认）

| 工具 | 参数 | effects |
|---|---|---|
| `screenshot` | `{ target?: ref\|'viewport'\|'fullpage', format? }` | read |
| `click_xy` / `drag` | `{ x, y }` / `{ from:{x,y}, to:{x,y} }`（vision 坐标模式） | write |
| `upload_file` | `{ element, ref, attachmentId }`（仅限用户提供的附件） | write |
| `press_keys_raw` | `{ sequence }` trusted 键序 | write |

### 内置（引擎内执行）

`fetch_url`（后台抓取→Readability→Markdown）、`web_search`、`memory_read/write`、`ask_user`、`load_skill`（08）、`todo_write`（任务面板）、`download`。

## 4. 等待与稳定性

每个 write 工具执行后内置稳定化再返回（分层参数，全局可调）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `minWaitMs` | 250 | 动作后最小等待 |
| `networkIdleMs` | 500 | 网络静默窗口（L2 用 Network 事件精确判定；L1 用 MutationObserver 静默近似） |
| `maxWaitMs` | 5000 | 稳定化封顶，超时带 `[页面可能未完全加载]` 标注返回 |
| `betweenActionsMs` | 300 | batch_actions 动作间隔 |
| 单工具超时 | 15s | 超时 throw → 模型自纠 |

失败自纠标准路径（写入工具描述，见 10 §3）：ref 过期/找不到 → 重新 `read_page` → 用新 ref 重试；仍失败 → 升级 L2 或 `ask_user`。

## 5. 操作可视化

- content script 在被操作元素绘制高亮描边 + 光标移动动画（Shadow DOM 隔离，700ms 淡出）；
- 页面右下角浮动指示器（Shadow DOM）：`Panelot 正在操作 · ⏸ ⏹`；**用户在页面上有任何手动输入（真实 isTrusted 事件）→ 自动暂停当前 turn** 并通知 UI（system_notice），避免人机争抢；
- 工具的 `details` 通道携带高亮元素的 boundingBox + 截图 id，供 UI 工具卡片回放展示。

## 6. 多标签管理

- Thread 绑定一个「受控 tab 集合」（Agent 打开的 + 用户显式附着的），`tabs_list` 默认只列受控集合 + 活跃 tab（全量需参数 `all:true`——最小化窥探面）；
- 受控 tab 被用户手动关闭 → tool_result 告知模型；tab 导航到敏感站点 → 该 tab 自动移出受控集合。

## 7. tool_result 体积规范

- 快照/正文类结果 ≤ 3000 tokens（§1.3）；`extract` 结果 ≤ 4000 tokens 超限分页；
- 压缩时（04 §5）tool_result 优先被摘要——原始大结果在 nodes 中仍可查看（UI 展开），LLM 历史中被替换为一行摘要。

## 8. 开放问题

- [ ] `find_in_page` 是否要支持语义检索（embedding）——V1 纯文本/正则。
- [ ] click_xy 的坐标系（devicePixelRatio 处理）需在 M2 用真实高分屏验证。
- [ ] 增量快照的「显著变化」判定阈值（当前定义：任何 ref 集合变化或 aria 状态变化）待实测调整。
