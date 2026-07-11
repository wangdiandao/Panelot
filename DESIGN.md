# Panelot — Chrome Agent 插件设计文档（总览）

> Panelot 是一个 Chrome/Edge 扩展：在侧边栏和全屏页提供 Agent 对话，可配置 OpenAI-compatible / Anthropic 端点，支持 Skills、数据型 Plugin 与远端 MCP；Agent 可在审批闸门下操作浏览器。
>
> 本文是总览；实现粒度的规范在 [docs/](./docs) 分章文档中，索引见下。设计文档既记录当前约束，也保留目标规格；“已实现/部分接入/设计目标”的边界见下方状态表与[开发指南](./docs/development.md)，不能仅凭设计描述推断功能已经出现在 UI 中。

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
| 提示词 | [docs/10-prompts.md](./docs/10-prompts.md) | 内核 system prompt 结构摘要、工具文案；全文事实源是 `src/prompts/kernel.ts` |
| 参考项目 | [docs/11-references.md](./docs/11-references.md) | 七个开源项目的借鉴决策表与踩坑清单 |
| 体验目标 | [docs/12-experience-targets.md](./docs/12-experience-targets.md) | 各维度对标基线、量化指标（CH/OP/PV/AP/EC/RL/OB） |

### 当前实现边界

| 范围 | 状态 | 事实来源 |
|---|---|---|
| 会话树、流式 Agent loop、Provider、审批、L0/L1/L2 浏览器工具 | 已接入主流程 | `entrypoints/background.ts`、`src/engine/`、`src/agent/`、`src/tools/` |
| SKILL.md 新建/编辑/导入、索引和 `load_skill` | 已接入主流程 | `src/skills/`、`src/ui/settings/SkillsPage.tsx` |
| 远端 MCP Tools、OAuth | 已接入主流程；SDK 会话运行在 offscreen document，Bearer/refresh token 本机加密，access token 仅存 session | `src/mcp/`、`entrypoints/mcp-worker/` |
| MCP Prompts / Resources | 已接入 `/server:prompt` 与 `@` 引用，结果按不可信内容定界 | `src/mcp/manager.ts`、`entrypoints/background.ts` |
| Plugin ZIP/GitHub 安装、启停、卸载与只读资产 | 已实现；内置精选索引为空，不包含市场、评分或自动更新 | `src/plugins/`、`src/ui/settings/PluginsPage.tsx` |
| docs/12 体验指标 | 目标基线，不是当前跑分 | `docs/12-experience-targets.md` §8—9 |

## 1. 产品定位与设计原则

定位：浏览器内的 Agent。模型自带（BYOK），以 Skills、数据型 Plugin 和远端 MCP 扩展能力；操作对象就是浏览器本身。

当前产品边界：

- Provider：用户配置 OpenAI-compatible 或 Anthropic 端点；具体第三方兼容性以 Verify 和实际调用为准；
- 浏览器能力：标签页 API、content script 与按需 CDP 分级执行；
- 扩展能力：SKILL.md、远端 MCP tools/prompts/resources 与数据型 Plugin 已接入；不执行远程代码；
- 数据路径：会话、配置和 Key 保存在扩展本地；调用模型或 MCP 时，选入的上下文会发送到用户配置的对应端点。

外部项目只作为分维度设计参考，历史调研见 [docs/11](./docs/11-references.md)，量化目标见 [docs/12](./docs/12-experience-targets.md)；两者都不是实时产品比较结论。

设计原则：

1. 安装即用：零后端、零本地程序，填 Key 即用。
2. 干扰最小化：默认无感知 DOM 通道，必要时才使用 CDP。升级告知是目标原则；当前 L2 read/auto policy 和 `press_key` 存在不弹独立升级确认的路径（见 05/06）。
3. 用户在环：副作用操作默认审批。安全立场：假设模型可被欺骗，保证被欺骗的模型也做不了坏事。
4. 数据本地优先：会话、配置、Key 保存在扩展本地，无遥测；模型/MCP 请求按功能需要向所配置端点发送上下文。
5. 生态兼容：SKILL.md、标准 MCP、两大 API 协议，不造私有轮子。
6. 极简内核（借 Pi Agent）：loop 与工具面保持最小，不加没有用例的旋钮；复杂度放在权限、UI 与扩展层。

## 2. 技术栈

WXT (MV3) + React 19 + TypeScript · shadcn/ui + Tailwind v4 · Zustand · Dexie(IndexedDB) · 自研 Provider 适配层（fetch + SSE）· `@modelcontextprotocol/sdk` Streamable HTTP Client（offscreen document）· react-markdown + Shiki core + KaTeX + Mermaid · Zod · Vitest + Playwright e2e。

不用 Vercel AI SDK / LangChain：MV3 SW 兼容成本高于收益，agent loop 保持自研并由无浏览器集成测试覆盖（[04](./docs/04-agent-engine.md)）。目录结构见 [01 §1](./docs/01-architecture.md)。

## 3. 架构摘要 → [docs/01](./docs/01-architecture.md)

- 引擎在 Background SW，UI 是薄视图：侧边栏/全屏页通过 Port 订阅同一引擎；UI 关闭后任务可在 SW 存活期间继续，重连以 snapshot 恢复已持久化路径。
- 协议：Op（客户端→引擎，带 submissionId）/ AgentEvent（引擎→客户端）可扩展联合；Thread/Turn/Item 三层原语，Item 统一 start/delta/complete 三段式；`initialize` 握手。（借鉴 Codex SQ/EQ 与 app-server）
- SW 生命周期：Run、队列、审批、命令回执及相关节点持久化；节点/Run/统计在关键边界同事务提交。重启后恢复队列和审批，只读或 retry-safe 工具可重放，状态不明的写操作进入 `paused_uncertain`。
- 数据（[docs/02](./docs/02-data-model.md)）：会话是消息树（节点 {id, parentId} + leafId 游标，只存树不存平行数组），编辑重发/重新生成 = 追加兄弟分支；append-only + 墓碑删除。

## 4. Provider 体系摘要 → [docs/03](./docs/03-providers.md)

- Connection（baseUrl + kind + 多 key + 自定义头 + quirks 兼容开关）；当前提供 10 个模板（含 Custom），本地 Ollama/LM Studio 可直连；
- ModelPreset 管理页与 resolver 已消费 base model、system prompt、参数、工具级别、审批策略、能力域、Skills、prompt version 与 task model；Plugin preset 为只读资产，可复制为用户 preset；
- Task model 当前用于标题生成；follow-up 建议任务仍未实现；
- Verify 连接测试 + 并发短超时拉取模型；错误归一化 + key failover；Anthropic 侧启用 prompt caching。

## 5. Agent 引擎摘要 → [docs/04](./docs/04-agent-engine.md)

- 极简 loop：循环到模型不再调用工具；步数护栏两级（25 步软提醒、60 步暂停可续跑），token 预算超限同样暂停可续；
- AgentTool 统一接口，content（给 LLM）/ details（给 UI）双通道；工具错误 throw → 模型自纠；
- 运行中交互三通路：steer 插话 / enqueue 排队 / interrupt 打断；标题生成是并行 task-model 请求，不作为 Engine turn 暴露。

## 6. 浏览器操作摘要 → [docs/05](./docs/05-browser-tools.md)

- 分级：L0 标签页 / L1 content script / CDP（AXTree fallback、trusted key、截图、坐标点击/拖拽；空闲 30s detach）。跨 iframe ref piercing 尚未实现；
- 感知用可访问性快照（YAML 树 + `ref=sN_M` 版本化引用，过期即拒），截图 vision 仅兜底；感知降级链：L1 → CDP AXTree → 截图；
- 工具面：element+ref 双参数、batch_actions「变化即中断」、分层等待（0.25s/0.5s idle/5s cap）；
- 操作可视化：元素高亮 + 页面浮动指示器；用户手动操作页面即自动暂停；敏感站点黑名单硬拒绝。

## 7. 权限与安全摘要 → [docs/06](./docs/06-permissions.md)

- 两轴模型：approvalPolicy（always / untrusted / on-request / never / granular / auto，never=拒绝而非自动批准）× capabilityScope（read-only / full，硬闸；same-origin-write / cross-origin 为遗留值等同 full）。全局默认已接入；turn override 当前只接入 approvalPolicy，capabilityScope 字段尚未传给 Gatekeeper；
- Gatekeeper 唯一拦截点：内置直放例外/读策略 → 黑名单 → 能力域 → 敏感 payload 第三方出域告警 → 规则表 → session grant → 默认档；普通跨 origin 不再强制审批；
- 审批 = 引擎发起的双向 RPC，完整参数强制展示，决策含 accept / acceptForSession / acceptForSite / decline；审批 UI 只在扩展页面出现（防网页仿冒）；
- Prompt injection 防线：工具结果随机定界（但 @ ContextBlock 尚未统一定界）→ 能力域/黑名单 → 高危规则 ask → 敏感出域告警 → 人眼审批。
- API Key：storage.local + AES-GCM 混淆（诚实告知边界）；导出默认剔除。session-only Key 模式只有代码注释中的设计意图，当前无设置/存储实现。

## 8. MCP / Skills / Plugin 摘要 → [docs/07](./docs/07-mcp.md) · [docs/08](./docs/08-skills-plugins.md)

- 远端 MCP（Streamable HTTP，响应可用 SSE）：Bearer / OAuth 2.1（launchWebAuthFlow + PKCE + 动态注册）；tools 已接入工具注册表（annotations 定默认审批档）；prompts/resources 已完成客户端发现/读取但尚未接入斜杠命令与 @ 引用；兼容粘贴 Claude Code/Cursor JSON 导入；
- Skills 兼容 SKILL.md：name+description 常驻索引 → `load_skill` 渐进披露；`panelot.sites` 站点作用域扩展字段；内置编辑器 + 文件/URL 导入；
- Plugin 是 zip/GitHub 分发的数据单元，manifest 位于 `.codex-plugin/plugin.json`。安装器限制 10 MB 压缩、50 MB 解压和 1000 文件，拒绝 traversal、symlink 与可执行文件；当前资产类型为 Skill、Preset、站点指令和其它只读数据，不导入远程可执行代码。

## 9. 界面摘要 → [docs/09](./docs/09-ui.md)

- 双形态：侧边栏（伴随浏览）+ 全屏对话页（三栏：会话列表 / 消息流 / 任务面板），共享同一会话可互切；
- 消息流：Markdown 渲染管线（代码高亮/表格/KaTeX/Mermaid）、工具卡片三态 + 折叠组、审批卡片（Y/S/A/N 快捷键）、分支切换器 ‹n/m›；
- 输入区：当前 `+`/`@` 可附着页面或 tab，粘贴长文本可作为 file ContextBlock；`/plan` + Skill 命令和 `{{动态变量}}` 已实现；截图入口、MCP Resource/Prompt 尚未接入；
- 设计语言：紧凑桌面 Agent 质感，靛青品牌色 + 琥珀警示色（docs/09 §1），明暗双主题，全键盘路径，中英 i18n。

## 10. 提示词摘要 → [docs/10](./docs/10-prompts.md)

内核 prompt 全文以 `src/prompts/kernel.ts` 为准；系统层按内核→用户全局→站点→Skills 索引→环境拼成单字符串，Anthropic 在整个 system block/末个 tool 上设 cache_control。~1500 tokens 与 20×3 回归集是目标；工具结果会随机定界，但 @ ContextBlock 尚未统一 fence。

## 11. 权限清单与商店上架

```jsonc
{
  "permissions": ["sidePanel","storage","unlimitedStorage","tabs","scripting",
                  "activeTab","alarms","contextMenus","debugger","downloads",
                  "favicon","identity","clipboardWrite","notifications"],
  "optional_host_permissions": ["<all_urls>"],
  "host_permissions": []          // 全部动态申请
}
```

- host 权限按需申请：页面操作与 Provider Verify 已接线；MCP 目前只有 OAuth 授权按钮显式申请 origin，普通/Bearer JSON 导入尚未申请；没有“一键全授”入口；
- `debugger` 权限触发人工审核：商店描述充分披露用途；准备去 L2 的降级构建作 Plan B；
- WXT 双目标产出 Chrome / Edge 包。仓库当前没有隐私政策文件或静态托管配置，上架前需要补齐并单独核验。

## 12. 数据与同步

会话/节点/附件在 IndexedDB（[02](./docs/02-data-model.md)）；配置/规则在 chrome.storage。设置页的 JSON 导出包含会话、节点、Skills、memories 和部分设置，默认剔除 Key，**不包含附件**；覆盖导入也不清理或恢复附件。单会话 Markdown 导出函数存在但暂无 UI 入口。无云同步。附件超过 200MB 时按创建时间删除旧项并跳过一个活跃 Thread。

## 13. 风险登记

| 风险 | 缓解 |
|---|---|
| debugger 权限审核受阻 | 描述披露 + 去 L2 降级构建 Plan B |
| MV3 SW 休眠打断长任务 | checkpoint + 回放恢复（01 §4），上线前专项压测 |
| 「OpenAI 兼容」端点差异 | QuirkFlags 表 + Verify 探测（03 §5-6） |
| 快照撑爆上下文 | 当前以 token 截断控制体积；变化子树 diff 仍是目标（05 §1.3） |
| Prompt injection 实战对抗 | 五层防线，硬闸兜底；发布前红队回归集（06 §6、10 §8） |
| 人机争抢 tab | 手动操作即暂停 |
