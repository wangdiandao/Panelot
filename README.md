<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

**Browser-native AI agent — bring your own model, operate the web, extend with Skills & MCP.**

浏览器原生 AI Agent —— 模型自带（BYOK）、以浏览器为「手」、可用 Skills / MCP 扩展。

[English](#english) · [中文](#中文) · [Design docs / 设计文档](./DESIGN.md)

</div>

---

## English

### What is Panelot

Panelot is a Chrome (MV3) extension that brings a Claude Code / Codex-grade agent experience into the browser itself:

- **Bring your own key** — any OpenAI- or Anthropic-compatible endpoint (official APIs, proxies, Ollama / LM Studio, etc.). Multiple keys with failover, per-connection quirks handling, custom headers.
- **The browser is the agent's hands** — tab management, accessibility-snapshot perception, DOM interaction, and CDP-powered advanced operations (screenshots, trusted key events), all behind a write-approval gate.
- **Extensible** — Claude-Code-compatible `SKILL.md` skills with progressive disclosure, remote MCP servers (Streamable HTTP, OAuth 2.1), and plugin bundles.
- **Local-first** — conversations, settings, and keys never leave your machine; keys are only sent to the endpoints you configure. No telemetry.

### Architecture

The engine lives in the background service worker; every UI surface is a thin view over the same engine via a typed Port protocol. Closing the UI does not stop a running task — reconnect restores state from a snapshot.

```
┌────────────┐  ┌────────────┐        ┌───────────────────────────────┐
│ Side panel │  │ Full-page  │  Port  │  Background Service Worker    │
│  (React)   │◄─┤  chat UI   ├───────►│                               │
└────────────┘  └────────────┘ Op /   │  EngineCore                   │
                               Event  │   ├─ Agent loop (minimal:     │
                                      │   │   run until no tool call) │
                                      │   ├─ Gatekeeper (approvals,   │
                                      │   │   sensitive-origin deny)  │
                                      │   ├─ Provider adapters        │
                                      │   │   (OpenAI / Anthropic SSE)│
                                      │   └─ Tool gateway ────────────┼──► content scripts (L1)
                                      │        L0 tabs / L2 CDP       │    a11y snapshots, clicks
                                      │  Dexie (IndexedDB)            │
                                      │   conversation tree, skills   │
                                      └───────────────────────────────┘
```

Key design decisions (full rationale in [docs/](./docs)):

| Decision | Why |
|---|---|
| **Conversation = message tree** (`{id, parentId}` + leaf cursor, append-only + tombstones) | Edit-and-resend / regenerate are sibling branches for free; recovery = replay. |
| **Op / AgentEvent protocol** with `submissionId`, Thread/Turn/Item three-tier primitives | Streaming, approvals, and reconnection need a custom protocol — MCP doesn't fit engine↔UI. |
| **Minimal agent loop** — iterate until the model stops calling tools; token budget is the only hard gate | Complexity lives outside the loop (Gatekeeper, UI); soft reminders instead of step limits. |
| **Perception via accessibility snapshots** (`role "name" [ref=sN_M]`, versioned refs that expire) | Semantic, ~200–400 tokens, no vision required; stale refs are rejected at the protocol level. |
| **Browser-level control** — the agent may target any tab; safety = write approvals + sensitive-origin blacklist | Tab membership is an audit trail, not a permission boundary. Tool results explicitly state whether the *user-visible* page changed. |
| **Tool results never lie** | Synthetic keys that can't trigger native behavior say so; navigation ≠ failure; cross-origin frames report as invisible rather than absent. |

### How it compares

| | Panelot | Sidebar AI extensions (Sider / Monica …) | nanobrowser | browser-use | ChatGPT / Claude web |
|---|---|---|---|---|---|
| Model source | Any OpenAI/Anthropic-compatible endpoint | Vendor subscription / relay | BYOK | BYOK (Python lib) | Locked to vendor |
| Browser operation | Full agent: tabs + DOM + CDP, leveled | Read-only summarize/translate | DOM automation | DOM automation (external browser) | None |
| Runs where | Pure extension, zero backend | Extension + vendor cloud | Extension | Python process + CDP | Cloud |
| Extensibility | Skills (Claude-Code compatible) + MCP + plugins | None | None | Python API | Vendor store |
| Permission model | Write approvals, sensitive-origin hard deny, per-site rules | — | Basic | Trust-the-script | — |
| Data | All local | Partially cloud | Local | Local | Cloud |

### Getting started

**Install from a release**

1. Grab the latest `panelot-<version>-chrome.zip` (or `.crx`) from Releases.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Drag the zip onto the page, or unzip it and use **Load unpacked**.
   (`.crx` files install directly only on Linux or via enterprise policy — on Windows/macOS Chrome requires Web-Store-signed CRX, so use the zip.)
4. Click the toolbar icon (or press `Alt+P`) to open the side panel.

**First run**

1. Open Settings → **Providers** → add a connection: pick the API style (OpenAI-compatible / Anthropic), enter the base URL and key, then **Verify** — you get a structured check (reachable / key valid / streaming / tool use).
2. Pick a default model. Optionally set a cheap **task model** for titles and suggestions.
3. Chat. Attach the current page with 📎, reference tabs/selections with `@`, trigger skills with `/`.

**Letting the agent operate the browser**

- Ask it to research, fill forms, compare pages across tabs — it perceives pages through accessibility snapshots and interacts through clicks/typing with per-write approvals.
- Approval prompts show the full parameters; decisions can be one-shot, per-session, or per-site.
- Banks, payment providers, and government sites are hard-denied by a built-in blacklist you can extend.
- Manual takeover: touch the page the agent is driving and the task auto-pauses.

### Development

```bash
pnpm install        # postinstall runs `wxt prepare`
pnpm dev            # dev mode with hot reload
pnpm compile        # tsc --noEmit
pnpm test           # Vitest unit tests (engine runs headless, no browser)
pnpm e2e            # Playwright e2e (first: pnpm exec playwright install chromium)
pnpm build          # production build → dist/chrome-mv3
pnpm build:edge     # → dist/edge-mv3
```

> Note: reloading a page does **not** update the background service worker — after changing engine code, reload the extension at `chrome://extensions`.

### Release packaging

```bash
pnpm zip            # → .output/*.zip for Chrome (and pnpm zip:edge for Edge)
```

To produce a `.crx` for self-hosted distribution: `chrome://extensions` → **Pack extension** → point at `dist/chrome-mv3` (keep the generated `.pem` private and reuse it so the extension ID stays stable). Attach both the zip and the crx to the GitHub release.

---

## 中文

### Panelot 是什么

Panelot 是一款 Chrome（MV3）扩展，把 Claude Code / Codex 级别的 Agent 体验搬进浏览器本体：

- **模型自带（BYOK）**——任意 OpenAI / Anthropic 兼容端点（官方 API、中转、Ollama / LM Studio 等）；多 Key failover、端点 quirks 兼容、自定义请求头。
- **浏览器就是 Agent 的手**——标签页管理、可访问性快照感知、DOM 交互、CDP 高级操作（截图、trusted 按键），全部经写操作审批闸门。
- **能力可扩展**——兼容 Claude Code 的 `SKILL.md`（渐进披露）、远端 MCP（Streamable HTTP、OAuth 2.1）、Plugin 包。
- **数据本地优先**——会话、配置、Key 全部留在本机，Key 只发往你配置的端点；无遥测。

### 设计架构

引擎运行在后台 Service Worker；侧边栏与全屏页都是同一引擎之上的薄视图，通过带类型的 Port 协议通信。关掉 UI 任务照跑，重连用 snapshot 恢复。

```
┌────────────┐  ┌────────────┐        ┌───────────────────────────────┐
│  侧边栏     │  │  全屏对话页 │  Port  │  后台 Service Worker           │
│  (React)   │◄─┤            ├───────►│                               │
└────────────┘  └────────────┘ Op /   │  EngineCore                   │
                               Event  │   ├─ Agent loop（极简：        │
                                      │   │   循环到模型不再调工具）    │
                                      │   ├─ Gatekeeper（审批 +        │
                                      │   │   敏感域名硬拒绝）          │
                                      │   ├─ Provider 适配层           │
                                      │   │  （OpenAI / Anthropic SSE）│
                                      │   └─ 工具网关 ─────────────────┼──► content script（L1）
                                      │      L0 标签页 / L2 CDP        │    快照、点击、输入
                                      │  Dexie（IndexedDB）            │
                                      │   会话树、Skills、附件          │
                                      └───────────────────────────────┘
```

核心设计决策（完整论证见 [docs/](./docs)）：

| 决策 | 理由 |
|---|---|
| **会话 = 消息树**（`{id, parentId}` + leaf 游标，append-only + 墓碑删除） | 编辑重发 / 重新生成天然是兄弟分支；恢复 = 回放。 |
| **Op / AgentEvent 协议**（submissionId 关联，Thread/Turn/Item 三层原语） | 流式 + 审批 + 断线重连需要定制协议，MCP 不适合做引擎↔UI 通道。 |
| **极简 Agent loop**——循环到模型不再调工具；token 预算是唯一硬闸 | 复杂度放在 loop 外层（Gatekeeper、UI）；步数用软提醒而非硬中断。 |
| **感知用可访问性快照**（`role "name" [ref=sN_M]`，ref 版本化、过期即拒） | 带语义、约 200–400 tokens、不依赖视觉；过期引用在协议层拒绝。 |
| **浏览器级控制权**——Agent 可指向任意标签页；安全闸 = 写审批 + 敏感域名黑名单 | 标签页归属只是审计痕迹，不是权限边界。工具结果显式声明**用户可见页面**是否变化。 |
| **工具结果不说谎** | 无法触发原生行为的合成按键会自我声明；导航 ≠ 失败；跨域 iframe 报告为不可见而非不存在。 |

### 竞品对比

| | Panelot | 侧边栏类 AI 扩展（Sider / Monica 等） | nanobrowser | browser-use | ChatGPT / Claude 官网 |
|---|---|---|---|---|---|
| 模型来源 | 任意 OpenAI / Anthropic 兼容端点 | 厂商订阅 / 中转 | BYOK | BYOK（Python 库） | 锁定官方 |
| 浏览器操作 | 完整 Agent：标签页 + DOM + CDP 分级 | 只读（摘要/翻译） | DOM 自动化 | DOM 自动化（外部浏览器） | 无 |
| 运行形态 | 纯扩展，零后端 | 扩展 + 厂商云 | 扩展 | Python 进程 + CDP | 云端 |
| 扩展能力 | Skills（兼容 Claude Code）+ MCP + Plugin | 无 | 无 | Python API | 官方商店 |
| 权限模型 | 写操作审批、敏感站点硬拒、站点级规则 | — | 基础 | 信任脚本 | — |
| 数据归属 | 全本地 | 部分云端 | 本地 | 本地 | 云端 |

### 使用指南

**从 Release 安装**

1. 在 Releases 下载最新的 `panelot-<版本>-chrome.zip`（或 `.crx`）。
2. 打开 `chrome://extensions`，开启右上角**开发者模式**。
3. 把 zip 直接拖进页面，或解压后用**加载已解压的扩展程序**。
   （`.crx` 直接双击安装仅限 Linux 或企业策略环境——Windows/macOS 的 Chrome 只接受商店签名的 CRX，请用 zip。）
4. 点工具栏图标（或按 `Alt+P`）打开侧边栏。

**首次配置**

1. 设置 → **Providers** → 添加连接：选接口风格（OpenAI 兼容 / Anthropic），填 Base URL 和 Key，点 **Verify**——会给出结构化检测结果（可达 / Key 有效 / 流式 / 工具调用）。
2. 选默认模型；可另配一个廉价**任务模型**跑标题生成等副任务。
3. 开聊：📎 附着当前页面，`@` 引用标签页/选区，`/` 触发 Skill 命令。

**让 Agent 操作浏览器**

- 让它调研、填表、跨标签页比价——它通过可访问性快照感知页面，点击/输入等写操作逐一审批。
- 审批卡片完整展示参数；决策可单次、本会话、或本站点生效。
- 银行、支付、政务站点由内置黑名单硬拒绝（可自行扩充）。
- 人工接管：在 Agent 正在操作的页面上手动输入，任务自动暂停。

### 开发

```bash
pnpm install        # postinstall 自动执行 wxt prepare
pnpm dev            # 开发模式（热重载）
pnpm compile        # tsc --noEmit
pnpm test           # Vitest 单测（引擎全链路无头运行，不开浏览器）
pnpm e2e            # Playwright e2e（首次需 pnpm exec playwright install chromium）
pnpm build          # 生产构建 → dist/chrome-mv3
pnpm build:edge     # → dist/edge-mv3
```

> 注意：刷新网页**不会**更新后台 Service Worker——改了引擎代码后，需到 `chrome://extensions` 重载扩展。

### Release 打包

```bash
pnpm zip            # → .output/*.zip（Edge 用 pnpm zip:edge）
```

需要自分发 `.crx` 时：`chrome://extensions` → **打包扩展程序** → 指向 `dist/chrome-mv3`（生成的 `.pem` 私钥务必保密并复用，保证扩展 ID 稳定）。GitHub Release 同时附上 zip 与 crx。

---

<div align="center">

MIT-style local-first project · 设计文档 [DESIGN.md](./DESIGN.md) · 分章规范 [docs/](./docs)

</div>
