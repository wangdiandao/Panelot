# 05 — 浏览器工具

> 文档入口：[文档目录](./README.md) · 关联：[04 Agent 引擎](./04-agent-engine.md) · [06 权限](./06-permissions.md) · [10 提示词](./10-prompts.md)
> 相关调研：Playwright MCP 的快照与 `element + ref` 参数、Chrome DevTools MCP 的版本化 uid，以及 browser-use 和 nanobrowser 的动作恢复案例。

> 当前实现包含 L0/L1 工具、actionability 检查、结构化动作错误、一次高置信 ref 恢复、动作后快照 diff、截图、坐标点击、拖拽、用户附件上传和 trusted 输入。合成输入明确失效时，`type` 可在同一次调用中请求 `type_trusted`，升级仍会经过 Gatekeeper。`read_page_deep` 使用 CDP AXTree 读取跨域 iframe 和 closed shadow 中可访问的控件，并为有界 DOM 样本补充事件监听器目标。

---

## 1. 页面快照（L1）

### 1.1 格式

YAML 缩进树，每行一个可访问节点：`role "可访问名" [属性] [ref=s{documentNonce}_{snapshotId}_{nodeIndex}]`

```yaml
# Page Snapshot (sk4m9z_3)
URL: https://example.com/login
Title: 登录 - Example

- heading "登录" [level=1]
- form "登录表单" [ref=sk4m9z_3_1]
  - textbox "邮箱" [value="user@example.com"] [ref=sk4m9z_3_2]
  - textbox "密码" [type=password] [ref=sk4m9z_3_3]
  - checkbox "记住我" [checked] [ref=sk4m9z_3_4]
  - button "登录" [ref=sk4m9z_3_5]
- link "忘记密码？" [ref=sk4m9z_3_6]
- text: "还没有账号？"
- link "注册" [ref=sk4m9z_3_7]
--- 正文摘录 (截断至 2000 tokens) ---
<Markdown 正文>
```

规则：

- `ref` 格式为 `s{documentNonce}_{snapshotId}_{nodeIndex}`。`documentNonce` 在当前 content-script 文档内保持稳定且不会跨文档复用，`snapshotId` 在当前执行上下文中单调递增。旧协议 ref、不同 `documentNonce`、非当前 generation 或已经替换的 frame 文档都会返回结构化 `stale_ref`。跨文档 ref 不参与恢复。ActionRunner 只会对同一 `documentNonce` 的旧 generation 尝试一次严格恢复，而且要求 role、name、tag、type、label 和 placeholder 唯一匹配；内部 hint 不包含 value。
- 交互后**填值回显**：`[value="..."]`；ARIA 状态方括号表示：`[checked]` `[disabled]` `[expanded]` `[selected]` `[invalid]`。
- 纯文本节点 `- text: "..."`，多行压平空白。
- **ref map**（内存态，不落库）：content script 内 `Map<ref, Element>`（强引用；快照更新即整体替换，元素随页面变更自然失效）；L2 需要时另存 `ref → backendNodeId`（经 `DOM.pushNodesByBackendIdsToFrontend` 翻译），构成 L1↔L2 的统一定位层。
- **same-origin iframe 坐标**：ref 同时记录外到内的 frame/document 链。`get_rect`、ref 元素截图 clip、标注和高亮共用一条顶层视口换算，处理 iframe border、内外滚动、嵌套 frame 与正向轴对齐缩放。iframe padding、旋转、倾斜、3D 或镜像变换无法保守换算时返回 `unsupported_frame` 并要求改用 `read_page_deep`，不得用近似坐标继续写操作。

### 1.2 可交互元素检测（优先 recall）

判定为可交互（获得 ref）的条件，**任一命中即编号**：

1. 语义标签/role：a、button、input、select、textarea、summary、`role∈{button,link,checkbox,menuitem,tab,option,switch,combobox,slider}`；
2. `tabindex >= 0`、`contenteditable`；
3. `cursor: pointer` 的最内层元素（computed style）；
4. L2 可用时：`DOMDebugger.getEventListeners` 命中 click/mousedown/keydown（这是 L2 的独有增强，L1 拿不到监听器）。

去重与折叠：可点父子链（外层容器 + 内层真实控件）折叠为**最内层可命中目标**单一 ref——直接针对 nanobrowser「外层无语义、内层才可点」的漏检教训。宁多编号勿漏（recall 优先），配合截断控制体积。

### 1.3 体积控制

- 视口内元素全量 + 视口外交互元素保留（截断其文本）；单快照目标 ≤ 3000 tokens，超限从「视口外非交互文本」开始丢弃并在快照尾部注明 `[已截断: N 个节点]`（不静默截断）；
- 交互工具执行后生成新的、最多约 1500 tokens 的快照，并向模型返回结构化行级 diff 加当前全部交互 ref；generation 链的正确性仍以完整内存快照为准。

### 1.4 感知降级链

```
L1 DOM 遍历建树
  └─ 失败/空树 → L2 CDP Accessibility.getFullAXTree 兜底
       └─ 仍失败（纯 Canvas 等）→ screenshot + vision 坐标模式（需模型有 vision）
```

任何一级失败都返回明确错误给模型（触发下一级），**绝不静默返回空树**（nanobrowser 空树死循环教训）。

## 2. L1 / L2 职责矩阵与升级

| 能力                             | 当前实现                                                                                                                                                                                                               | 目标/限制                                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DOM 快照/正文抽取                | L1 DOM 遍历；空树时 CDP `Accessibility.getFullAXTree` 返回粗粒度文本                                                                                                                                                   | AXTree fallback 不生成可交互 ref                                                                                                           |
| click / 填表 / select            | L1 actionability + 合成事件 + 结果验证；合成 type 明确失效时可自动请求 `type_trusted`；`click_trusted` 也可显式调用                                                                                                    | 自动升级重新经过 Gatekeeper，最多一次；click 尚无足够确定的“合成点击未生效”判据，不自动升级                                                |
| 跨域 iframe / closed shadow root | L1 标注不可见；L2 `read_page_deep` 从完整 AXTree 生成含 manager/tab/generation nonce 的 deep ref，并以 backend node 执行 trusted click/type；Chrome 125+ 的 flat child session 路由已由生产扩展三层跨站 OOPIF E2E 验证 | 仅覆盖进入 AXTree 或有界事件监听器扫描且具有 backend node 的控件；非可访问 DOM/Canvas 仍需 screenshot；旧版 Chrome 只获得 root target 能力 |
| 按键                             | `press_key` 明确为 L2，通过 CDP `Input.dispatchKeyEvent` 发送 trusted 输入                                                                                                                                             | 测试/无 CDP 降级才使用合成事件并明确提示                                                                                                   |
| 坐标点击 / 拖拽                  | L2 `Input.dispatchMouseEvent`；deep ref 通过 `DOM.getBoxModel` 解析中心点                                                                                                                                              | Canvas 仍使用 vision 坐标模式                                                                                                              |
| 截图                             | L2 viewport/fullpage/ref 元素区域截图；`annotate:true` 叠加与当前 ref 对齐的标签                                                                                                                                       | fullpage 临时覆盖 metrics，标注与 metrics 都在 finally 清除                                                                                |
| 文件上传                         | `upload_file` 标为 L2，但通过 content script + `DataTransfer` 设置用户附件                                                                                                                                             | 尚未使用 `DOM.setFileInputFiles`                                                                                                           |
| 事件监听器探测                   | `read_page_deep` 对 pierced DOM 中最多 120 个非 AX 控件候选调用 `DOMDebugger.getEventListeners`                                                                                                                        | 有界扫描防止复杂/恶意页面造成无上限 CDP 工作；未扫描节点仍可能遗漏                                                                         |
| 网络静默判定                     | L1 用 MutationObserver 静默窗口近似；trusted click/type 在动作前启用 CDP Network 追踪，500ms idle / 5s cap                                                                                                             | 常驻连接不会无限阻塞；超时以 `networkSettled:false` 进入 details                                                                           |

Panelot 会在三种情况下自动使用 CDP：L1 `read_page` 得到空树、`press_key` 需要 trusted 输入，以及合成 type 明确失败后请求 `type_trusted`。模型也可以显式调用 `read_page_deep`、`screenshot`、`click_xy`、`drag`、`click_trusted` 或 `type_trusted`。升级仍会经过 Gatekeeper；拒绝后不会执行，也不会原样重试。

deep ref 格式为 `c{managerNonce}_{tabEpoch}_{generation}_{nodeIndex}`，并记录 tab、session、frame、loader 和根文档 backend identity。Service Worker 或 manager 重建、frame 导航或分离、target/debugger 分离、tab 移除或替换、页面进入 loading，以及 identity 复验不一致，都会在 DOM/Input 写入前返回结构化 `stale_ref`。

debugger 一次只 attach 一个 tab。多标签任务按需切换，连接空闲 30 秒后自动 detach；当前不会在 turn 完成时立即 detach。

## 3. 工具清单与 Schema

交互工具同时接收 `element`（审批中显示的人类可读描述）和 `ref`（精确定位）。完整参数以 zod schema 为准，下表只列常用字段：

所有读取、交互、导航和截图工具都接受可选 `tabId`。`tabs_list` 每次都列出所有浏览器窗口中的标签页，跨标签任务应始终传入它返回的 id。省略 `tabId` 时使用用户提交消息时捕获的网页标签作为 turn 内默认值，提交后切换前台不会改变它。引用标签只提供上下文与显式 id，不会替换该默认值。工具结果以 `[tabId=N]` 标明来源。

### L0 —— 标签页（无注入）

| 工具                       | 参数                                                                   | effects |
| -------------------------- | ---------------------------------------------------------------------- | ------- |
| `tabs_list`                | `{}` — 所有窗口的全部 tab，标注「用户正在看」                         | read    |
| `tab_open`                 | `{ url }` — 后台打开/复用，不抢用户前台                                | write   |
| `tab_focus`                | `{ tabId }` — 仅当用户明确要求查看页面时切到前台                       | write   |
| `tab_close`                | `{ tabId }` — 任意 tab（经审批）；结果显式说明用户视图是否变化         | write   |
| `navigate`                 | `{ tabId?, url }` — 指定 tab 时在后台导航                              | write   |
| `go_back` / `go_forward`   | `{ tabId? }`                                                           | write   |
| `history_search`           | `{ query?, startTime?, endTime?, maxResults? }` — 检索浏览历史         | read    |
| `bookmarks_search`         | `{ query, maxResults? }` — 检索已保存书签                              | read    |
| `top_sites`                | `{ maxResults? }` — 读取浏览器提供的常用站点                           | read    |
| `sessions_recently_closed` | `{ maxResults? }` — 列出最近关闭的标签页/窗口及 session id             | read    |
| `session_restore`          | `{ sessionId }` — 恢复最近关闭项，会改变浏览器会话                     | write   |
| `tab_groups_list`          | `{}` — 列出所有窗口中的标签组                                          | read    |
| `tabs_group`               | `{ tabIds, groupId? }` — 将标签页归入新组或已有组                      | write   |
| `tab_group_update`         | `{ groupId, title?, color?, collapsed? }` — 更新标签组外观与折叠状态   | write   |

整个浏览器都可以成为 Agent 的工作区。没有传 `tabId` 时，工具使用用户提交消息时捕获的默认网页标签；它不一定是执行时用户正在看的 tab。页面工具会在结果中回显 `[tabId=N]`。后台操作不会切换用户可见页面，只有 `tab_focus` 会主动切换前台。

普通点击、提交型输入、按键和 trusted/坐标点击如果从默认目标页打开子标签，结果会包含 `tab_created`，并把新标签作为本轮默认路由的后续目标。只有用户当时停留在 Panelot 全页对话中，UI 才会把这个子标签切到前台。`batch_actions` 遇到会打开新浏览上下文的链接或表单时会停止剩余动作，避免把旧页面 ref 继续用在原标签页。

### L1 —— 感知与交互

| 工具             | 参数                                                                                         | effects |
| ---------------- | -------------------------------------------------------------------------------------------- | ------- |
| `read_page`      | `{ mode?: 'snapshot'\|'article'\|'full', maxTokens? }`；当前 `full` 与 `snapshot` 走同一路径 | read    |
| `find_in_page`   | `{ query }` → 命中节点带 ref 的片段列表                                                      | read    |
| `get_selection`  | —                                                                                            | read    |
| `click`          | `{ element, ref, button?: 'left'\|'right', doubleClick? }`                                   | write   |
| `type`           | `{ element, ref, text, mode?: 'replace'\|'append', submit?, slowly? }`                       | write   |
| `select_option`  | `{ element, ref, values: string[] }`                                                         | write   |
| `press_key`      | `{ key, ref? }`（可先聚焦 ref；'Enter'、'Control+a' 等）                                     | write   |
| `scroll`         | `{ target?: ref, direction, amount?: 'page'\|'end'\|px }`                                    | read    |
| `hover`          | `{ element, ref }`                                                                           | write   |
| `wait_for`       | `{ text? , textGone?, timeMs? }` 三态其一                                                    | read    |
| `extract`        | `{ scope?: ref, fromChar? }` → 干净 Markdown（保留链接），超长落盘为附件                     | read    |
| `batch_actions`  | `{ actions: (click\|type\|select_option)[] (≤4) }`                                           | write   |
| `run_javascript` | `{ code, world: 'MAIN' }` — 默认 deny，设置页显式开启                                        | write   |

`batch_actions` 按序执行；动作间用 ref 数量变化近似判断 DOM 是否显著变化，超过阈值就中断剩余动作。返回已执行清单 + 新的截断快照，审批时整批一次展示。

网页 `alert/confirm/prompt` 只在可能写页面的单次 content tool 调用期间于 MAIN world 拦截并记录；`confirm` 安全默认取消并返回 `false`，`prompt` 返回 `null`，`alert` 关闭。只读 content 工具不安装该 patch，避免读取期间改变页面自身的对话框行为。写操作只有在 patch 安装成功后才会派发；安装失败返回 `precheck` 安全错误。调用结束会恢复页面原函数，首次恢复失败会重试，持续失败返回 `recover` 安全错误并要求重载页面；嵌套调用用 depth 计数，不能静默永久改写网站行为。

`extract` 在 content script 中把页面或指定子树转换为 Markdown。它保留链接和标题层级，去掉 script、nav、footer 等区域，不会额外调用模型。

- content script 返回完整 Markdown，硬上限为 200k 字符；
- 引擎每次向模型提供 8000 字符，模型可用 `fromChar` 继续翻页；
- 正文超过一屏且数据库可用时，完整内容会保存为 `page_text` 附件。附件只供 UI 使用，不会把全文再次送进模型上下文。

`scope` 可以把读取范围限制在某个 ref 子树。该工具是读操作，输出仍会经过不可信内容定界。

### L2 —— 高级

工具的 `level:'L2'` 会在审批卡片已经出现时附带 `escalation_l2` 提示，但当前 Gatekeeper 不把“使用 debugger”本身作为强制审批条件：默认策略下 L2 read（如 screenshot）直接放行，`auto` 下未命中其它规则的 L2 write 也可放行。准确裁决语义见 06 §5。

| 工具                | 参数                                                       | effects |
| ------------------- | ---------------------------------------------------------- | ------- |
| `screenshot`        | `{ target?: 'viewport'\|'fullpage'\|ref, format? }`        | read    |
| `click_xy` / `drag` | `{ x, y }` / `{ from:{x,y}, to:{x,y} }`（vision 坐标模式） | write   |
| `upload_file`       | `{ element, ref, attachmentId }`（仅限用户提供的附件）     | write   |

### 内置（引擎内执行）

当前注册：`fetch_url`（后台抓取→正文文本化）、`memory_read`、`memory_write`、`load_skill`（08）、`download`、`artifact`，以及统一交互工具 `ask_user`、`request_user_action`、`watch_page`、`schedule_resume`。本次能力扩展不改动既有记忆工具。`artifact` 生成 UTF-8 文件并保存到当前 Thread 的 attachments 后触发下载。

交互工具不会执行占位 `execute`：loop 将 Run 切到 `waiting_interaction`，持久化请求并等待 UI、alarm 或页面条件给出结果。`watch_page` 仍按目标 tab/origin 经过 Host Permission 与 Gatekeeper；提问和定时恢复不读取页面。需要凭据、验证码、支付或真人验证时使用 `request_user_action`，返回结果只表示用户声明已完成，不包含秘密。

## 4. 等待与稳定性

每个 write 工具执行后内置稳定化再返回（分层参数，全局可调）：

| 参数               | 默认 | 说明                                                                                      |
| ------------------ | ---- | ----------------------------------------------------------------------------------------- |
| `minWaitMs`        | 250  | 动作后最小等待                                                                            |
| `networkIdleMs`    | 500  | 当前 content-script 写操作用 MutationObserver 静默窗口近似；尚无 CDP `Network.*` 精确判定 |
| `maxWaitMs`        | 5000 | 稳定化封顶，超时带 `[页面可能未完全加载]` 标注返回                                        |
| `betweenActionsMs` | 300  | batch_actions 动作间隔                                                                    |
| 单工具超时         | 15s  | 超时 throw → 模型自纠                                                                     |

失败自纠标准路径（写入工具描述，见 10 §3）：ref 过期/找不到 → 重新 `read_page` → 用新 ref 重试；仍失败 → 换用当前可用的 L2 工具，或通过 `ask_user` 向用户说明并提问。

## 5. 操作可视化

- content script 在被操作元素绘制高亮描边 + 光标移动动画（Shadow DOM 隔离，700ms 淡出）；
- 页面右下角浮动指示器（Shadow DOM）：`Panelot 正在操作 · ⏸ ⏹`；**用户在页面上有任何手动输入（真实 isTrusted 事件）→ 自动暂停当前 turn** 并通知 UI（system_notice），避免人机争抢；
- 当前 `details` 通道用于 screenshot attachment id 和超长 extract attachment id；元素高亮发生在页面内，尚未把 boundingBox 送到工具卡片做回放。

## 6. 多标签路由

页面工具可以作用于任意浏览器标签页。权限仍由写操作审批、规则和敏感站点列表决定，不由 tab 是否曾经被 Agent 操作决定。

| 路由规则 | 当前行为 |
| --- | --- |
| 显式 `tabId` | `read_page`、`click`、`type`、`navigate`、`screenshot` 等工具直接作用于指定标签页，不要求先调用切换工具。 |
| 省略 `tabId` | 当前 turn 使用提交消息时捕获的默认网页 tab。下一轮会重新捕获；恢复已准备的工具时使用 Run 中持久化的 `target.tabId`。 |
| 新标签页 | 如果点击从默认标签页打开子标签，后续默认路由会接续到浏览器确认的子标签，原标签保持不变。 |
| `@` 与附件引用 | 引用保留各自 `tabId`，供模型显式传参，但不会改变默认操作目标。 |
| 执行前复验 | Gatekeeper 裁决后、派发前再次解析 tab、origin、frame 和 MCP server 身份。目标发生变化时，本次调用失败，旧批准不会迁移。 |
| touched 记录 | 保存 Agent 操作过的 tab，用于路由恢复和审计，不参与权限裁决。记录位于 `chrome.storage.session`，不会写入 `storage.local`。 |

其他行为：tab 被关闭（用户或 Agent）→ 从目标与痕迹中移除，并为已提交目标保留失效标记，禁止改投其他前台页；Chrome 以 `tabs.onReplaced` 替换实时 tab 时迁移当前内存/会话路由与审计痕迹。Worker 重启后重放已准备动作仍复验 Run 中的原始 tab 与页面 origin，目标已不存在或页面 origin 漂移就失败关闭。用户在 Agent **正在操作的目标 tab** 上手动输入 → 自动暂停该 thread（在别的曾操作过的 tab 上操作不算冲突）；用于过滤 Agent 自身 CDP 输入的短暂时间窗只在当前 Worker 内存中存在。

## 7. tool_result 体积规范

- 快照/正文类结果 ≤ 3000 tokens（§1.3）；`extract` 结果 ≤ 4000 tokens 超限分页。

## 8. 当前约束

- `find_in_page` 不做语义检索（embedding）：纯文本/正则已覆盖「定位后交互」的用途；语义理解交给循环里的主模型（read_page/extract 全文喂给它）。
- `click_xy` 使用 CSS 像素，与 `Input.dispatchMouseEvent` 一致。fullpage 截图固定 `deviceScaleFactor: 1`，图像像素等于 CSS 像素；高分屏 viewport 截图仍是 CSS×DPR，视觉模型返回的图像坐标需要按比例换算。优先使用 ref，`click_xy` 只用于 Canvas 等无法取得 ref 的页面。
- `batch_actions` 的当前“显著变化”判定只比较 ref 数量差：`> max(3, 原数量×20%)` 即中断。它不比较完整 ref 集合或 aria 状态，属于可替换的近似实现。
