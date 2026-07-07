# Panelot — Chrome Agent 插件设计文档（总览）

> Panelot 是一个 Chrome 扩展：在侧边栏和全屏页提供 Agent 对话（对标 Codex / Claude Code Desktop 的桌面体验），模型接任意 OpenAI / Anthropic 兼容端点，支持 Skills / Plugin / 远端 MCP，并能在审批闸门下操作浏览器。
>
> 本文是总览；实现粒度的规范在 [docs/](./docs) 分章文档中，索引见下。

---

## 文档索引

| 章 | 详细文档 | 内容 |
|---|---|---|
| 架构与协议 | [docs/01-architecture.md](./docs/01-architecture.md) | 上下文拓扑、Op/AgentEvent 协议、Thread/Turn/Item、握手与 SW 生命周期 |
| 数据模型 | [docs/02-data-model.md](./docs/02-data-model.md) | Dexie schema、会话树、buildSessionContext |
| Provider | [docs/03-providers.md](./docs/03-providers.md) | Connection/ModelPreset、适配器与 SSE、quirks、Verify、task model |
| Agent 引擎 | [docs/04-agent-engine.md](./docs/04-agent-engine.md) | loop、AgentTool、steering、恢复时序 |
| 浏览器工具 | [docs/05-browser-tools.md](./docs/05-browser-tools.md) | 快照格式、L1/L2 分级、工具 schema 全表、等待策略 |
| 权限与安全 | [docs/06-permissions.md](./docs/06-permissions.md) | 两轴模型、Gatekeeper、审批 RPC、注入防线 |
| MCP | [docs/07-mcp.md](./docs/07-mcp.md) | 远端 MCP、OAuth 2.1、能力映射 |
| Skills/Plugin | [docs/08-skills-plugins.md](./docs/08-skills-plugins.md) | SKILL.md 规范、渐进披露、斜杠命令、Plugin 包 |
| 界面 | [docs/09-ui.md](./docs/09-ui.md) | 设计 token、线框、组件树、交互状态机、快捷键 |
| 提示词 | [docs/10-prompts.md](./docs/10-prompts.md) | 内核 system prompt 全文、工具文案 |
| 参考项目 | [docs/11-references.md](./docs/11-references.md) | 七个开源项目的借鉴决策表与踩坑清单 |
| 体验目标 | [docs/12-experience-targets.md](./docs/12-experience-targets.md) | 各维度对标基线、量化指标（CH/OP/PV/AP/EC/RL/OB） |

## 1. 产品定位与设计原则

定位：浏览器内的 Agent。模型自带（BYOK），能力用 Skills / Plugin / MCP 扩展，操作对象就是浏览器本身。

| 维度 | ChatGPT / Claude 官网 | 常见浏览器 AI 插件 | **Panelot** |
|---|---|---|---|
| 模型来源 | 锁定官方 | 自家中转/订阅 | 任意 OpenAI / Anthropic 兼容端口 |
| 浏览器操作 | 无 | 弱（摘要/翻译） | 完整 Agent 级（DOM + CDP 分级） |
| 扩展能力 | 官方商店 | 无 | Skills（兼容 Claude Code）+ Plugin + 远端 MCP |
| 数据归属 | 云端 | 部分云端 | 默认全本地 |

设计原则：

1. **安装即用**：零后端、零本地程序，填 Key 即用。
2. **干扰最小化**：默认无感知 DOM 通道，必要时才升级 CDP（升级前告知）。
3. **用户在环**：副作用操作默认审批；**假设模型可被欺骗，保证被欺骗的模型也做不了坏事**。
4. **数据本地优先**：会话、配置、Key 全本地，无遥测。
5. **生态兼容**：SKILL.md、标准 MCP、两大 API 协议，不造私有轮子。
6. **极简内核**（借 Pi Agent）：loop 与工具面保持最小，不加没有用例的旋钮；复杂度放在权限、UI 与扩展层。

## 2. 技术栈

WXT (MV3) + React 19 + TypeScript · shadcn/ui + Tailwind v4 · Zustand · Dexie(IndexedDB) · 自研 Provider 适配层（fetch + 手写 SSE）· @modelcontextprotocol/sdk · react-markdown + Shiki + KaTeX + Mermaid · Zod · Vitest + Playwright e2e。

不用 Vercel AI SDK / LangChain：MV3 SW 兼容成本高于收益，agent loop 自研 300 行内可控（[04](./docs/04-agent-engine.md)）。目录结构见 [01 §1](./docs/01-architecture.md)。

## 3. 架构摘要 → [docs/01](./docs/01-architecture.md)

- **引擎在 Background SW，UI 是薄视图**：侧边栏/全屏页通过 Port 订阅同一引擎；UI 关闭任务照跑，重连以 snapshot 恢复。
- **协议**：Op（客户端→引擎，带 submissionId）/ AgentEvent（引擎→客户端）可扩展联合；Thread/Turn/Item 三层原语，Item 统一 start/delta/complete 三段式；`initialize` 握手。（借鉴 Codex SQ/EQ 与 app-server）
- **SW 生命周期**：活跃 fetch + Port 心跳续命；每个 Item complete 同步落库（checkpoint）；被杀后恢复 = 回放重建。
- **数据**（[docs/02](./docs/02-data-model.md)）：会话是**消息树**（节点 {id, parentId} + leafId 游标，只存树不存平行数组），编辑重发/重新生成 = 追加兄弟分支；append-only + 墓碑删除。

## 4. Provider 体系摘要 → [docs/03](./docs/03-providers.md)

- Connection（baseUrl + kind + **多 key** + **自定义头** + quirks 兼容开关）；预置十余家模板，本地 Ollama/LM Studio 直连；
- **ModelPreset = 命名 Agent**（base model + system prompt + 工具级别 + 参数覆盖），新会话选 preset；
- **Task model**：标题/建议路由到廉价模型；
- Verify 连接测试 + 并发短超时拉取模型；错误归一化 + key failover；Anthropic 侧启用 prompt caching。

## 5. Agent 引擎摘要 → [docs/04](./docs/04-agent-engine.md)

- 极简 loop：循环到模型不再调用工具；**步数护栏为软提醒（25 步注入自省提示），token 预算是唯一硬闸**；
- AgentTool 统一接口，**content（给 LLM）/ details（给 UI）双通道**；工具错误 throw → 模型自纠；
- 运行中交互三通路：**steer 插话 / enqueue 排队 / interrupt 打断**；标题生成等内部轮不可插话。

## 6. 浏览器操作摘要 → [docs/05](./docs/05-browser-tools.md)

- 分级：L0 标签页 / L1 content script（无感知，覆盖 90% 操作）/ L2 chrome.debugger（截图、trusted 事件、跨 iframe；按需 attach、用完即 detach）；
- **感知用可访问性快照**（YAML 树 + `ref=sN_M` 版本化引用，过期即拒），截图 vision 仅兜底；感知降级链：L1 → CDP AXTree → 截图；
- 工具面：element+ref 双参数、batch_actions「变化即中断」、分层等待（0.25s/0.5s idle/5s cap）；
- 操作可视化：元素高亮 + 页面浮动指示器；**用户手动操作页面即自动暂停**；敏感站点黑名单硬拒绝。

## 7. 权限与安全摘要 → [docs/06](./docs/06-permissions.md)

- **两轴模型**：approvalPolicy（untrusted / on-request / never / granular，never=拒绝而非自动批准）× capabilityScope（read-only / same-origin-write / cross-origin / full，硬闸）；会话级配置、单轮可覆盖；
- **Gatekeeper 唯一拦截点**：黑名单 → 能力域 → 跨域检测（越出任务作用域强制审批）→ 敏感 payload 出域告警 → 规则表 → 默认档；
- 审批 = 引擎发起的双向 RPC，完整参数强制展示，决策含 accept / acceptForSession / acceptForSite / decline；审批 UI 只在扩展页面出现（防网页仿冒）；
- Prompt injection 五层防线：定界声明（软）→ 能力域 → 跨域审批 → 出域告警 → 人眼审批（硬）。
- API Key：storage.local + AES-GCM 混淆（诚实告知边界），可选 session 级模式；导出默认剔除。

## 8. MCP / Skills / Plugin 摘要 → [docs/07](./docs/07-mcp.md) · [docs/08](./docs/08-skills-plugins.md)

- 远端 MCP（Streamable HTTP + SSE 回退）：Bearer / OAuth 2.1（launchWebAuthFlow + PKCE + 动态注册）；tools→工具注册表（annotations 定默认审批档）、prompts→斜杠命令、resources→@ 引用；兼容粘贴 Claude Code/Cursor JSON 导入；
- Skills 兼容 SKILL.md：name+description 常驻索引 → `load_skill` 渐进披露；`panelot.sites` 站点作用域扩展字段；内置编辑器 + 文件/URL 导入；
- Plugin = zip/Git 分发单元（plugin.json + skills + mcp.json + 权限规则 + 站点指令），安装清单确认，plugin 建议的 allow 规则默认降级为 ask。

## 9. 界面摘要 → [docs/09](./docs/09-ui.md)

- 双形态：侧边栏（伴随浏览）+ 全屏对话页（三栏：会话列表 / 消息流 / 任务面板），共享同一会话可互切；
- 消息流：Markdown 全家桶、工具卡片三态 + 折叠组、审批卡片（Y/A/N 快捷键）、分支切换器 ‹n/m›；
- 输入区：@ 引用（页面/选区/截图/tab/MCP 资源）、/ 命令（内置+Skill+MCP Prompt，变量表单）、`{{动态变量}}`；
- 设计语言：紧凑桌面 Agent 质感，靛青品牌色 + 琥珀警示色（docs/09 §1），明暗双主题，全键盘路径，中英 i18n。

## 10. 提示词摘要 → [docs/10](./docs/10-prompts.md)

内核 system prompt + 工具定义 ≤1500 tokens（全文见文档）；分层拼装（内核→用户全局→站点→Skills 索引→环境）配合 cache 断点；不可信内容随机后缀定界；回归集（含注入攻击样本）见 docs/10 §8。

## 11. 权限清单与商店上架

```jsonc
{
  "permissions": ["sidePanel","storage","unlimitedStorage","tabs","scripting",
                  "activeTab","alarms","contextMenus","debugger","downloads",
                  "identity","clipboardWrite"],
  "optional_host_permissions": ["<all_urls>"],
  "host_permissions": []          // 全部动态申请
}
```

- host 权限动态申请（操作站点 / 添加 API 端点 / 添加 MCP 时按需弹原生授权），降低审核风险与安装恐吓感；重度用户可一键全授；
- `debugger` 权限触发人工审核：商店描述充分披露用途；准备去 L2 的降级构建作 Plan B；
- 隐私政策静态托管（数据全本地、Key 仅发往用户配置端点）；WXT 双目标产出 Chrome / Edge 包。

## 12. 数据与同步

会话/节点/附件在 IndexedDB（[02](./docs/02-data-model.md)）；配置/规则在 chrome.storage。全量 JSON 导出导入（默认剔除 Key）、单会话导出 Markdown。V1 无云同步（无后端原则）；V2 可选用户自有 WebDAV/Gist。附件配额 LRU 清理。

## 13. 风险登记

| 风险 | 缓解 |
|---|---|
| debugger 权限审核受阻 | 描述披露 + 去 L2 降级构建 Plan B |
| MV3 SW 休眠打断长任务 | checkpoint + 回放恢复（01 §4），上线前专项压测 |
| 「OpenAI 兼容」端点差异 | QuirkFlags 表 + Verify 探测（03 §5-6） |
| 快照撑爆上下文 | 增量快照 + 体积上限（05 §1.3） |
| Prompt injection 实战对抗 | 五层防线，硬闸兜底；发布前红队回归集（06 §6、10 §8） |
| 人机争抢 tab | 手动操作即暂停；V2 后台窗口模式 |

V2 议题：后台小窗执行模式；云同步方案；子代理并行 UI；「录制操作 → 生成 Skill」反向能力（差异化强，V2 候选中优先级最高）。
