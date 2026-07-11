# 11 — 参考项目调研与借鉴决策

> 上级文档：[DESIGN.md](../DESIGN.md)。本文沉淀 2026-07 的设计调研记录。表中的“采纳”表示进入过设计决策，不等于当前版本全部实现；实现状态以 01–10 分章和源码为准。外部项目持续演进，本轮文档校准没有逐项重跑其历史 issue/能力结论，因此这些对标事实在用于公开比较前均**待确认**。

---

## 1. 借鉴决策总表

### OpenWebUI（对话体验 / Provider 管理）

| 采纳 | 理由 | 落点 |
|---|---|---|
| 消息树 `{nodes, leafId}` + parentId 建模分叉/编辑重发 | 分支对话最成熟的建模；`<n/m>` 切换器免费获得 | [02 §2-3](./02-data-model.md) |
| **只存树、不存平行扁平数组**（反面教训） | 其双份存储导致孤儿节点与渲染死锁（issue #15189） | 02 §1 |
| Connection 抽象「协议优先」+ enable/disable 不删除 | 兼容一切 OpenAI 兼容端点 | [03 §1.1](./03-providers.md) |
| 补齐其短板：customHeaders、多 key、并发短超时拉模型 | 其无自定义头 UI、串行拉取等满超时是公认痛点 | 03 §1.1/§6 |
| ModelPreset（base model + prompt + 工具 = 命名 Agent） | 类型已定义；当前 resolver 只消费 base + params，管理 UI 待实现 | 03 §1.3 |
| Task model（副任务路由廉价模型） | 当前只用于标题；独立选择器与建议任务待实现 | 03 §1.5 |
| 流式未闭合代码块暂缓高亮渲染 | 防闪烁与渲染报错 | [09 §4.1](./09-ui.md) |
| 触发符统一框架（@ / 斜杠 / 变量表单）、动态变量 | 浏览器场景天然映射（{{PAGE_URL}} 等） | 09 §5、[08 §4](./08-skills-plugins.md) |
| 文件夹归组会话 | 目标能力；当前侧栏是有界会话列表，尚无文件夹 UI | 02 §2.1 |
| 参数「未设不发」+ UI 控制字段发送前剥离 | 多 Provider 兼容的关键工程细节 | 03 §1.4 |

未采纳：多用户/admin 三层参数体系（Panelot 单用户，两层够）；其随机负载均衡（改为粘性 key + failover）。

### OpenAI Codex CLI（Agent 引擎协议与安全）

| 采纳 | 理由 | 落点 |
|---|---|---|
| SQ/EQ 双队列 → Op/AgentEvent，submissionId 关联 | 与 Port 消息模型天然同构 | [01 §3](./01-architecture.md) |
| Thread/Turn/Item 三层原语 + Item 三段式 start/delta/complete | 协议、存储、UI 的共同语言 | 01 §2-3 |
| initialize 握手 + snapshot 恢复 | SW 重启重连的关键机制 | 01 §3.4 |
| 事件联合可扩展 + 未知 type 忽略 | 引擎先行迭代不打挂旧 UI | 01 §3.1 |
| 两轴安全模型（approvalPolicy × capabilityScope） | 「何时问」与「能做什么」正交，硬闸兜底注入 | [06 §1](./06-permissions.md) |
| **弃用 on-failure 档**（官方已废弃） | 「先跑失败再问」在浏览器副作用不可回滚 | 06 §1 |
| never = 拒绝而非自动批准（语义写死在协议层） | Codex 桌面端语义歧义的教训 | 06 §1 |
| steering / queueing / interrupt 三通路 + turnKind 不可插话标记 | 运行中交互的完整语义 | [04 §3](./04-agent-engine.md) |
| 审批 = 引擎发起的双向 RPC + per-turn 覆盖 | 服务端发起请求是审批流的正确形态 | 06 §4、01 §3.2 |
| rollout：SessionMeta 头 + 事件流、恢复 = 重放、delta 不落盘 | append-only + checkpoint 与 MV3 完美匹配 | [02 §1/§2.2](./02-data-model.md)、01 §4 |
| 有界队列 + overloaded 退避 | SW 内存受限的必要背压 | 01 §3.5 |
| 「MCP 不适合做引擎-UI 协议」结论 | 流式+审批+持久化+服务端发起需要定制协议 | 01 §3 |

### Pi Agent（badlogic/pi-mono，极简内核）

| 采纳 | 理由 | 落点 |
|---|---|---|
| loop = 循环到无工具调用 | 保持内核简单；当前实现第 25 次工具调用软提醒、达到 60 次暂停 | 04 §1-2、[10 §7](./10-prompts.md) |
| AgentTool 签名 + **content(LLM)/details(UI) 双通道** | 浏览器工具的富 UI 信息不污染上下文 | 04 §4 |
| 错误 throw → isError 回填 → 模型自纠 | 元素找不到→重新快照的自纠路径基础 | 04 §2 |
| 会话树单存储内多子节点分叉（优于 Codex 复制文件式 fork） | 存储省、天然支持分支 | 02 §1 |
| transport 抽象（Port 生产 / 直连测试） | 引擎可无浏览器回归测试 | 04 §7 |
| 「turn 结束 = 所有订阅者处理完」 | 防 SW 在落库前挂起 | 04 §2 |
| 内核提示词 + 工具 <1500 tokens 的极简纪律 | token 成本与可靠性双赢 | 10 §1 |

修正：Pi 面向可信本地终端、审批弱；Panelot 面对不可信网页，叠加 Codex 安全外壳（见上）。

### Playwright MCP / Chrome DevTools MCP（页面感知）

| 采纳 | 理由 | 落点 |
|---|---|---|
| a11y 快照 YAML 缩进树 `role "name" [attr] [ref]`（而非裸 DOM 列表） | 带语义、~200-400 tokens、不依赖 vision | [05 §1.1](./05-browser-tools.md) |
| ref 版本化 `s{snapshotId}_{index}`（CDP MCP 的 uid 模式）+ 过期即拒 | 从协议层杜绝 state divergence | 05 §1.1 |
| element + ref 双参数 | element 供审批展示与模型自核 | 05 §3 |
| wait_for 三态（text/textGone/time）、type 的 submit/slowly | 经过验证的参数面 | 05 §3 |
| snapshot 为主、vision 坐标为兜底的双模式 | 覆盖 Canvas 应用 | 05 §1.4 |
| CDP 独有能力清单（getEventListeners、pierce、setFileInputFiles） | 设计 L2 能力边界的参考；当前 piercing/event listener 探测未接入，文件上传走 content script | 05 §2 |

### nanobrowser / browser-use（浏览器 Agent 实战教训）

| 采纳/警示 | 理由 | 落点 |
|---|---|---|
| ⚠ 可交互检测勿只判外层容器；优先 recall；父子链折叠 | nanobrowser 漏检=元素对 Agent 不可见（单点故障） | 05 §1.2 |
| ⚠ 建树失败必须降级不能死循环（三级降级链） | nanobrowser 空树死循环（issue #126） | 05 §1.4 |
| 分层等待参数（0.25s min / 0.5s idle / 5s cap / 动作间隔） | browser-use 久经验证的默认值 | 05 §4 |
| batch_actions ≤4 + 「变化即中断」 | 减少 LLM 往返且防过期引用误操作 | 05 §3 |
| ⚠ 每步喂全量 DOM 的 token 成本（其 roadmap 头号痛点） | 当前先用体积上限；变化子树 diff 保留为目标 | 05 §1.3 |
| debugger 按需 attach、空闲 30 秒 detach | 当前混合分级的实现；尚未做到每个 turn 结束立即 detach | 05 §2、[01 §5](./01-architecture.md) |
| 多 Agent（Planner/Navigator/Validator）不采纳 | token 放大明显；单 loop + 好快照 | 04 §8 |

## 2. 踩坑警示清单（实现期对照）

1. OpenWebUI #15189：树数据完整性无校验 → 渲染死锁。对策：写入校验 + 回溯步数上限（02 §3.4）。
2. Codex `never` 语义歧义、`untrusted` 被静默降级。对策：档位语义唯一定义于协议层（06 §1）。
3. nanobrowser 空 DOM 树 → Navigator 死循环。对策：降级链 + 显式错误（05 §1.4）。
4. browser-use 过期 index 误操作（Cancel→Delete）。对策：ref 版本化过期即拒（05 §1.1）。
5. OpenWebUI 模型拉取串行超时叠加。对策：并发 + 独立 4s 超时（03 §6）。
6. OpenAI 兼容端点 quirks（usage 选项、think 标签、max_tokens 字段名）。对策：QuirkFlags 表（03 §5）。
7. chrome.debugger 单 target 限制。对策：Gateway 串行化 attach 切换（05 §2）。

## 3. 来源

- Open WebUI: [docs.openwebui.com](https://docs.openwebui.com)、DeepWiki（chat history / markdown / message input / model config）、issues #15189/#788/#20658
- Codex CLI: [github.com/openai/codex](https://github.com/openai/codex)（codex-rs/protocol、app-server README、protocol_v1.md）、[developers.openai.com/codex](https://developers.openai.com/codex)（approvals、app-server、config）
- Pi Agent: [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)、[mariozechner.at 2025-11-30 博文](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- Playwright MCP: [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)、playwright.dev/mcp
- Chrome DevTools MCP: [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)（tool-reference.md）
- nanobrowser: [github.com/nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser)、issues #126/#166、discussion #85
- browser-use: [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use)、issues #705/#3292/#922

> 注：Codex 协议枚举为 `#[non_exhaustive]` 持续演进，Pi 会话格式有版本化；实现对应模块前按当时版本复核一手源码。
