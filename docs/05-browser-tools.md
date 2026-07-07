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
--- 正文摘录 (截断至 2000 tokens) ---
<Markdown 正文>
```

规则：

- **ref = `s{snapshotId}_{nodeIndex}`**：snapshotId 为 tab 内单调递增的快照版本号。**执行层校验 ref 前缀必须等于该 tab 当前最新快照 id，过期直接拒绝**并返回「快照已过期，请重新 read_page」——从协议层杜绝 state divergence（nanobrowser/browser-use 的顽疾）。
- 交互后**填值回显**：`[value="..."]`；ARIA 状态方括号表示：`[checked]` `[disabled]` `[expanded]` `[selected]` `[invalid]`。
- 纯文本节点 `- text: "..."`，多行压平空白。
- **ref map**（内存态，不落库）：content script 内 `Map<ref, Element>`（强引用；快照更新即整体替换，元素随页面变更自然失效）；L2 需要时另存 `ref → backendNodeId`（经 `DOM.pushNodesByBackendIdsToFrontend` 翻译），构成 L1↔L2 的统一定位层。

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

**自动升级触发器**（触发升级审批，见 06 §5）：模型请求 L2-only 工具；L1 click 后 DOM 无预期变化（连续 2 次）；目标 ref 位于跨域 iframe / closed shadow root；type 目标框架吞合成事件（值未变化）。attach 按 tab 粒度，turn 结束或空闲 30s 自动 detach。**debugger 单 target 约束**：一次只 attach 一个 tab，多 tab 任务按需切换 attach（由 Gateway 排队串行化）。

## 3. 工具清单与 Schema

交互工具统一 **`element`（人类可读描述，供审批展示与模型自核）+ `ref`（精确定位）双参数**。zod 定义即真相，下表为摘要：

### L0 —— 标签页（无注入）

| 工具 | 参数 | effects |
|---|---|---|
| `tabs_list` | `{ all? }` — 当前窗口全部 tab（`all:true` 跨窗口），标注「用户正在看」与「当前操作目标」 | read |
| `tab_open` | `{ url }` — 后台打开/复用，不抢用户前台 | write |
| `tab_activate` | `{ tabId, focus? }` — 默认仅后台换操作目标；`focus:true` 才切用户前台 | write |
| `tab_close` | `{ tabId }` — 任意 tab（经审批）；结果显式说明用户视图是否变化 | write |
| `navigate` | `{ url }`（当前操作目标 tab） | write |
| `go_back` / `go_forward` | — | write |

**视图状态诚实契约**：Agent 的「操作目标 tab」与用户的「可见 tab」是两回事。tab 工具默认后台工作，每个结果显式说明用户看到的页面有没有变——模型不得在结果声明「用户视图未变」后再提议"切换回原页面"。

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
| `extract` | `{ scope?: ref, fromChar? }` → 干净 Markdown（保留链接），超长落盘为附件 | read |
| `batch_actions` | `{ actions: (click\|type\|select_option)[] (≤4) }` | write |
| `run_javascript` | `{ code, world: 'MAIN' }` — 默认 deny，设置页显式开启 | write |

`batch_actions` 语义（抄 browser-use）：按序执行，**任一动作导致 DOM 显著变化立即中断剩余动作**，返回已执行清单 + 新增量快照。审批时整批一次展示。

`extract` 语义（借鉴 browser-use 的 `extract` 动作 + browsercluster 的 GNE 正文抽取 + chrome-agent-skill 的输出体量控制）：在内容脚本内**确定性**地把页面/子树转干净 Markdown（保留 `[text](url)` 链接与标题层级、剥离 script/nav/footer 等），不额外调 LLM——结构化交给循环里的主模型。职责分层：内容脚本返回**完整** Markdown（至硬上限 200k 字符）；引擎侧工具负责**开窗**（每次给模型 8000 字符，`fromChar` 翻页）与**落盘**——正文超一屏且有 db 时，把**完整正文**存为 `page_text` 附件（`mime: text/markdown`，附件纯 UI 侧、不回喂 LLM，全文不进上下文），模型靠 `fromChar` 翻阅其余部分。`scope` 限定某 ref 子树。读操作，输出经 fence 包裹。

### L2 —— 高级（均触发升级确认）

| 工具 | 参数 | effects |
|---|---|---|
| `screenshot` | `{ target?: ref\|'viewport'\|'fullpage', format? }` | read |
| `click_xy` / `drag` | `{ x, y }` / `{ from:{x,y}, to:{x,y} }`（vision 坐标模式） | write |
| `upload_file` | `{ element, ref, attachmentId }`（仅限用户提供的附件） | write |
| `press_keys_raw` | `{ sequence }` trusted 键序 | write |

### 内置（引擎内执行）

`fetch_url`（后台抓取→正文文本化）、`web_search`、`memory_read/write`、`ask_user`、`load_skill`（08）、`todo_write`（任务面板）、`download`。

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

## 6. 多标签管理（浏览器级控制权，2026-07-06）

Agent 的控制权是**整个浏览器**，不是某个标签页子集——安全闸是写操作审批 + 敏感域名黑名单（06），不是 tab 成员资格。Thread 级维护两个概念：

- **操作目标（target）**：页面工具当下作用的 tab。Agent 显式选择的目标（`tab_open`/`tab_activate`）**钉住**、跨 turn 持续；未显式选择时自动取用户当前所在的网页 tab，且 turn 内锁定（用户中途切 tab 不会把点击重定向到错误页面）、turn 结束释放（下一轮重新跟随用户）。
- **触达痕迹（touched）**：Agent 操作过的 tab 集合——纯审计展示（任务面板"Agent 操作过的标签页"），**不是权限边界**。

其他行为：tab 被关闭（用户或 Agent）→ 从目标与痕迹中移除；用户在 Agent **正在操作的目标 tab** 上手动输入 → 自动暂停该 thread（在别的曾操作过的 tab 上操作不算冲突）。

## 7. tool_result 体积规范

- 快照/正文类结果 ≤ 3000 tokens（§1.3）；`extract` 结果 ≤ 4000 tokens 超限分页。

## 8. 已定事项

- `find_in_page` 不做语义检索（embedding）：纯文本/正则已覆盖「定位后交互」的用途；语义理解交给循环里的主模型（read_page/extract 全文喂给它）。
- click_xy 坐标系约定：一律 **CSS 像素**（`Input.dispatchMouseEvent` 的语义）。fullpage 截图强制 `deviceScaleFactor: 1`，图像像素 = CSS 像素；viewport 截图在高分屏上图像分辨率为 CSS×DPR，vision 模型给出的图像坐标需按比例换算——这是已知盲区，优先走 ref 路径，click_xy 仅 canvas 类兜底。
- 增量快照「显著变化」判定维持现定义（任何 ref 集合变化或 aria 状态变化）：确定性、宁多不漏；调阈值需要真实任务数据，判定函数单点可换。
