# 参考项目

> 文档入口：[用户指南](../guide/index.md)。这是 2026 年 7 月的设计调研记录。“采纳”表示某个做法影响过 Panelot 的设计，不表示当前版本已经完整实现。上游项目会继续变化；公开引用这些比较前，应重新核对一手资料。

---

## 1. 采用情况

### OpenWebUI（对话体验 / Provider 管理）

| 采纳                                                  | 理由                                                       | 落点                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| 消息树 `{nodes, leafId}` + parentId 建模分叉/编辑重发 | 同一结构可以表达分支、编辑和切换                           | [数据模型 §2-3](./data-model.md)                     |
| **只存树、不存平行扁平数组**（反面教训）              | 其双份存储导致孤儿节点与渲染死锁（issue #15189）           | [数据模型 §1](./data-model.md)                       |
| Connection 抽象「协议优先」+ enable/disable 不删除    | 在同一协议下容纳不同 OpenAI 兼容端点                       | [Provider §1.1](./providers.md)                      |
| customHeaders、多 Key、并发短超时拉模型               | 为不同 OpenAI 兼容端点提供显式配置和独立失败处理           | [Provider §1.1、§6](./providers.md)                  |
| ModelPreset（base model + prompt + 工具）             | 数据类型、解析逻辑和管理 UI 已实现                         | [Provider §1.3](./providers.md)                      |
| Task model                                            | 当前用于标题；设置页已有独立选择器，follow-up 建议尚未实现 | [Provider §1.5](./providers.md)                      |
| 流式未闭合代码块暂缓高亮渲染                          | 防闪烁与渲染报错                                           | [界面 §4.1](./ui.md)                                 |
| 触发符统一框架（@ / 斜杠 / 变量表单）、动态变量       | 可直接提供 <code v-pre>{{PAGE_URL}}</code> 等浏览器上下文  | [界面 §5](./ui.md)、[Skills §4](./skills-plugins.md) |
| 文件夹归组会话                                        | 目标能力；当前侧栏是有界会话列表，尚无文件夹 UI            | [数据模型 §2.1](./data-model.md)                     |
| 参数「未设不发」+ UI 控制字段发送前剥离               | 避免把端点不支持的参数或 UI 字段发给 Provider              | [Provider §1.4](./providers.md)                      |

未采纳：多用户/admin 三层参数体系（Panelot 单用户，两层够）；其随机负载均衡（改为粘性 key + failover）。

### OpenAI Codex CLI（Agent 引擎协议与安全）

| 采纳                                                           | 理由                                                     | 落点                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| SQ/EQ 双队列 → Op/AgentEvent，submissionId 关联                | 对应 Port 中的请求、响应和广播事件                       | [架构 §3](./architecture.md)                                       |
| Thread/Turn/Item 三层原语 + Item 三段式 start/delta/complete   | 协议、存储、UI 的共同语言                                | [架构 §2-3](./architecture.md)                                     |
| initialize 握手 + snapshot 恢复                                | SW 重启后重新建立协议版本和 Thread 状态                  | [架构 §3.4](./architecture.md)                                     |
| 事件联合可扩展 + 未知 type 忽略                                | 引擎先行迭代不打挂旧 UI                                  | [架构 §3.1](./architecture.md)                                     |
| 三档权限策略 + 强制规则层                                      | 基本策略保持简单，敏感站点与规则表提供不可绕过的安全底线 | [权限 §1](./permissions.md)                                        |
| **弃用 on-failure 档**（官方已废弃）                           | 「先跑失败再问」在浏览器副作用不可回滚                   | [权限 §1](./permissions.md)                                        |
| never = 拒绝而非自动批准（语义写死在协议层）                   | Codex 桌面端语义歧义的教训                               | [权限 §1](./permissions.md)                                        |
| steering / queueing / interrupt 三通路 + turnKind 不可插话标记 | 运行中交互的完整语义                                     | [Agent 引擎 §3](./agent-engine.md)                                 |
| 审批 = 引擎发起的双向 RPC + per-turn 覆盖                      | 服务端发起请求是审批流的正确形态                         | [权限 §4](./permissions.md)、[架构 §3.2](./architecture.md)        |
| rollout：SessionMeta 头 + 事件流、恢复 = 重放、delta 不落盘    | append-only 与 checkpoint 适合可挂起的 MV3 Worker        | [数据模型 §1、§2.2](./data-model.md)、[架构 §4](./architecture.md) |
| 有界队列 + overloaded 退避                                     | SW 内存受限的必要背压                                    | [架构 §3.5](./architecture.md)                                     |
| 「MCP 不适合做引擎-UI 协议」结论                               | 流式+审批+持久化+服务端发起需要定制协议                  | [架构 §3](./architecture.md)                                       |

### Pi Agent（badlogic/pi-mono）

| 采纳                                                 | 理由                                         | 落点                                                            |
| ---------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| loop = 循环到无工具调用                              | 不按工具调用次数停止；token 预算仍可暂停任务 | [Agent 引擎 §1-2](./agent-engine.md)、[提示词 §7](./prompts.md) |
| AgentTool 签名 + **content(LLM)/details(UI) 双通道** | 浏览器工具的富 UI 信息不污染上下文           | [Agent 引擎 §4](./agent-engine.md)                              |
| 错误 throw → isError 回填 → 模型自纠                 | 元素找不到→重新快照的自纠路径基础            | [Agent 引擎 §2](./agent-engine.md)                              |
| 会话树单存储内多子节点分叉                           | 不复制整份会话也能表达分支                   | [数据模型 §1](./data-model.md)                                  |
| transport 抽象（Port 生产 / 直连测试）               | 引擎可无浏览器回归测试                       | [Agent 引擎 §7](./agent-engine.md)                              |
| 「turn 结束 = 所有订阅者处理完」                     | 防 SW 在落库前挂起                           | [Agent 引擎 §2](./agent-engine.md)                              |
| 内核提示词 + 工具约 1500 tokens 的体积目标           | 控制常驻上下文体积；当前还没有构建时计数门禁 | [提示词 §1](./prompts.md)                                       |

修正：Pi 面向可信本地终端、审批弱；Panelot 面对不可信网页，叠加 Codex 安全外壳（见上）。

### Playwright MCP / Chrome DevTools MCP（页面感知）

| 采纳                                                                | 理由                                                                                     | 落点                                  |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------- |
| a11y 快照 YAML 缩进树 `role "name" [attr] [ref]`（而非裸 DOM 列表） | 带语义、~200-400 tokens、不依赖 vision                                                   | [浏览器工具 §1.1](./browser-tools.md) |
| ref 版本化 `s{snapshotId}_{index}`（CDP MCP 的 uid 模式）+ 过期即拒 | 从协议层杜绝 state divergence                                                            | [浏览器工具 §1.1](./browser-tools.md) |
| element + ref 双参数                                                | element 供审批展示与模型自核                                                             | [浏览器工具 §3](./browser-tools.md)   |
| wait_for 三态（text/textGone/time）、type 的 submit/slowly          | 经过验证的参数面                                                                         | [浏览器工具 §3](./browser-tools.md)   |
| snapshot 为主、vision 坐标为兜底的双模式                            | 覆盖 Canvas 应用                                                                         | [浏览器工具 §1.4](./browser-tools.md) |
| CDP 独有能力清单（getEventListeners、pierce、setFileInputFiles）    | `read_page_deep` 已使用 AXTree、pierce 和有界事件监听器探测；文件上传仍走 content script | [浏览器工具 §2](./browser-tools.md)   |

### nanobrowser / browser-use（浏览器 Agent 实战教训）

| 采纳/警示                                                 | 理由                                                  | 落点                                                              |
| --------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| ⚠ 可交互检测勿只判外层容器；优先 recall；父子链折叠       | nanobrowser 漏检=元素对 Agent 不可见（单点故障）      | [浏览器工具 §1.2](./browser-tools.md)                             |
| ⚠ 建树失败必须降级不能死循环（三级降级链）                | nanobrowser 空树死循环（issue #126）                  | [浏览器工具 §1.4](./browser-tools.md)                             |
| 分层等待参数（0.25s min / 0.5s idle / 5s cap / 动作间隔） | browser-use 久经验证的默认值                          | [浏览器工具 §4](./browser-tools.md)                               |
| batch_actions ≤4 + 「变化即中断」                         | 减少 LLM 往返且防过期引用误操作                       | [浏览器工具 §3](./browser-tools.md)                               |
| ⚠ 每步发送全量 DOM 会增加 token 成本                      | 当前先用体积上限；变化子树 diff 保留为目标            | [浏览器工具 §1.3](./browser-tools.md)                             |
| debugger 按需 attach、空闲 30 秒 detach                   | 当前混合分级的实现；尚未做到每个 turn 结束立即 detach | [浏览器工具 §2](./browser-tools.md)、[架构 §5](./architecture.md) |
| 多 Agent（Planner/Navigator/Validator）不采纳             | token 放大明显；单 loop + 好快照                      | [Agent 引擎 §8](./agent-engine.md)                                |

## 2. 实现注意事项

1. OpenWebUI #15189：树数据完整性无校验 → 渲染死锁。对策：写入校验 + 回溯步数上限（[数据模型 §3.4](./data-model.md)）。
2. Codex `never` 语义歧义、`untrusted` 被静默降级。对策：档位语义唯一定义于协议层（[权限 §1](./permissions.md)）。
3. nanobrowser 空 DOM 树 → Navigator 死循环。对策：降级链 + 显式错误（[浏览器工具 §1.4](./browser-tools.md)）。
4. browser-use 过期 index 误操作（Cancel→Delete）。对策：ref 版本化过期即拒（[浏览器工具 §1.1](./browser-tools.md)）。
5. OpenWebUI 模型拉取串行超时叠加。对策：并发 + 独立 4s 超时（[Provider §6](./providers.md)）。
6. OpenAI 兼容端点 quirks（usage 选项、think 标签、max_tokens 字段名）。对策：QuirkFlags 表（[Provider §5](./providers.md)）。
7. chrome.debugger 单 target 限制。对策：Gateway 串行化 attach 切换（[浏览器工具 §2](./browser-tools.md)）。

## 3. 来源

- Open WebUI: [docs.openwebui.com](https://docs.openwebui.com)、DeepWiki（chat history / markdown / message input / model config）、issues #15189/#788/#20658
- Codex CLI: [github.com/openai/codex](https://github.com/openai/codex)（codex-rs/protocol、app-server README、protocol_v1.md）、[developers.openai.com/codex](https://developers.openai.com/codex)（approvals、app-server、config）
- Pi Agent: [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)、[mariozechner.at 2025-11-30 博文](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- Playwright MCP: [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)、playwright.dev/mcp
- Chrome DevTools MCP: [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)（tool-reference.md）
- nanobrowser: [github.com/nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser)、issues #126/#166、discussion #85
- browser-use: [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use)、issues #705/#3292/#922

> 注：Codex 协议枚举为 `#[non_exhaustive]` 持续演进，Pi 会话格式有版本化；实现对应模块前按当时版本复核一手源码。
