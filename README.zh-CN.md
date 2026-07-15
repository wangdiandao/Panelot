<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

浏览器原生 AI Agent 扩展：模型自带（BYOK），以浏览器为「手」，用 Skills / 数据型 Plugin / 远端 MCP 扩展能力。

[English](./README.md) · [架构文档](./docs/01-architecture.md) · [开发指南](./docs/development.md)

</div>

---

## 是什么

Panelot 是一款在浏览器内运行 Agent 的 Chrome/Edge（MV3）扩展：

- **模型自带**。实现 OpenAI-compatible 与 Anthropic 协议，并提供官方、若干第三方及本地端点模板；具体端点是否兼容，需要以 **Verify** 和实际请求为准。每个连接支持多 Key failover、自定义请求头和端点 quirks。
- **浏览器就是 Agent 的手**。标签页管理、可访问性快照感知、DOM 交互、CDP 高级操作（截图、trusted 按键）。所有写操作都过审批闸门。
- **能力可扩展**。兼容 Claude Code 的 `SKILL.md`、经严格校验的数据型 Plugin，以及通过浏览器安全 SDK Streamable HTTP Client 接入的远端 MCP tools/prompts/resources；端点 host permission 在运行时申请。
- **数据本地**。会话、配置、Key 全部留在本机，Key 只发往你配置的端点。无遥测。

## 架构

引擎运行在后台 Service Worker；侧边栏与全屏页都是同一引擎之上的薄视图。Run、队列、审批、命令回执和解析后的运行环境均持久化；SW 重启后可恢复安全读操作、队列与审批，结果不明的写操作会暂停并要求用户明确处理。

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

读代码前值得了解的设计决策（完整论证见 [docs/](./docs)）：

| 决策 | 理由 |
|---|---|
| 会话 = 消息树（`{id, parentId}` + leaf 游标，append-only + 墓碑删除） | 编辑重发 / 重新生成天然是兄弟分支；恢复 = 回放。 |
| 自定义 Op / AgentEvent 协议（Thread/Turn/Item 三层原语） | 流式 + 审批 + 断线重连需要专用的引擎↔UI 通道，MCP 不适合这个位置。 |
| 极简 Agent loop：循环到模型不再调工具 | 复杂度放在 loop 外层（Gatekeeper、UI）；当前第 25 次工具调用提醒，达到 60 次时暂停，token 预算耗尽也会暂停。 |
| 感知用可访问性快照（`role "name" [ref=<snapshot-ref>]`，ref 是不透明、版本化标识，过期即拒） | 带语义、几百 tokens、不依赖视觉；调用方原样复制最新 ref，过期引用在协议层拒绝。 |
| 浏览器级控制权：Agent 可指向任意标签页；安全闸由 Gatekeeper 与敏感域名黑名单执行 | 是否弹出审批取决于所选策略和规则；标签页归属只是审计痕迹，不是权限边界。 |
| 工具结果不说谎 | 无法触发原生行为的合成按键会自我声明；导航 ≠ 失败；跨域 iframe 报告为不可见而非不存在。 |

## 项目特征

- Panelot 自身不依赖应用后端：扩展直接访问用户配置的 Provider 与远端 MCP 端点。
- 会话、设置、Skills、记忆和附件保存在扩展本地存储中；调用模型或 MCP 时，选入的上下文仍会发送到对应的远端端点。
- 浏览器操作按需使用扩展 API、content script 与 CDP；已注册工具执行前统一经过 Gatekeeper 规则与敏感域名黑名单。

[docs/11-references.md](./docs/11-references.md) 记录了各项设计受哪些外部项目启发，但它不是实时功能或隐私对比表。若要用于产品对比，应先重新核对上游项目的当前版本。

## 使用

从 Release 安装：

1. 在 [Releases](https://github.com/wangdiandao/Panelot/releases) 下载最新压缩包：Chrome 用 `panelot-<版本>-chrome.zip`，Edge 用 `panelot-<版本>-edge.zip`。
2. 解压到一个不会随手删掉的目录。
3. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），开启**开发者模式**，点**加载已解压的扩展程序**，选择解压出的目录。
4. 点工具栏图标或按 `Alt+P` 开关侧边栏（可在 `chrome://extensions/shortcuts` 改绑）。侧边栏内按 `Ctrl/Cmd+E` 展开为全屏对话页。

首次配置：

1. 设置 → **模型** → 添加连接：选接口风格（OpenAI 兼容 / Anthropic），填 Base URL 和 Key，点 **Verify**，会得到结构化检测结果：可达 / Key 有效 / 流式 / 工具调用。
2. 选默认模型。任务模型接口当前用于标题生成，但设置页尚未提供独立任务模型选择器。
3. 开聊：用 `+` 附着当前页面，`@` 选择打开的标签页，`{{SELECTION}}` 插入当前选区，`/` 触发 Skill 命令。

让 Agent 操作浏览器：

- 让它调研、填表、跨标签页比价。它通过可访问性快照感知页面；点击、输入等写操作是否弹出确认，由当前审批策略和规则决定。
- 审批卡片完整展示参数；决策可单次、本会话、或本站点生效。
- 银行、支付、政务站点由内置黑名单硬拒绝，黑名单可自行扩充。
- 人工接管：在 Agent 正在操作的页面上手动输入，任务自动暂停。

## 当前范围

- 仅构建 Chrome/Edge MV3 扩展；manifest 要求 Chrome 116 或更高版本，不以 Firefox、Safari 为构建目标。
- Skills 已支持新建、编辑、启停以及从文件或 URL 导入；暂不支持带 scripts/references 等附属目录的多文件 Skill。
- 远端 MCP tools、`/server:prompt`、`@` resource、OAuth、本机加密 Bearer/refresh token、懒连接、逐工具启停和 `list_changed` 已接入；不支持本地 stdio MCP。
- Plugin 设置页支持本地 ZIP 或 GitHub 仓库安装、只读资产原子校验、整体启停与卸载；不做市场、评分、自动更新或远程可执行代码。
- 当前构建没有注册 `web_search`、独立的 `ask_user` 和 `press_keys_raw` 工具。
- Playwright 会在 persistent Chromium context 中加载生产 unpacked extension，并验证快照 ref/表单更新；本地 mock Provider/MCP fixture 矩阵和真实端点兼容矩阵仍是发布工作。

## 开发

环境要求：

- Node.js **20.19 或更高版本**（当前 WXT 依赖的最低要求）。
- pnpm 9.12.3（已由 `packageManager` 固定）。
- 加载扩展需要 Chrome 116 或更高版本；只有执行 `pnpm e2e` 时才需要 Playwright Chromium。

```bash
pnpm install        # postinstall 自动执行 wxt prepare
pnpm dev            # 开发模式；构建 dist/chrome-mv3-dev 并启动开发浏览器
pnpm compile        # tsc --noEmit
pnpm lint           # ESLint 9 + React Hooks
pnpm format:check   # Prettier 门禁
pnpm test           # Vitest 单测（引擎全链路无头运行，不开浏览器）
pnpm e2e            # Playwright e2e（首次需 pnpm exec playwright install chromium）
pnpm build          # 生产构建 → dist/chrome-mv3
pnpm build:edge     # → dist/edge-mv3
pnpm budget         # 生产/首屏共享/background JS 预算
```

项目不要求 `.env`：模型端点、Key、权限、Skills 与 MCP 服务器都在扩展设置页配置并存储于本地。如果开发浏览器没有自动启动，可在扩展管理页手动加载 `dist/chrome-mv3-dev`。刷新网页**不会**更新后台 Service Worker；改了引擎代码后，需到 `chrome://extensions` 重载扩展。

目录结构、运行时数据流、存储键、故障排查及验证/发布流程见[开发指南](./docs/development.md)。

## Release 打包

```bash
pnpm zip            # → dist/panelot-<版本>-chrome.zip
pnpm zip:edge       # → dist/panelot-<版本>-edge.zip
```

`v*` tag 会把两个 ZIP、SHA-256、release notes 与 CycloneDX SBOM 自动发布到 GitHub Release；商店上传仍为人工操作。开发者模式用户解压后选择**加载已解压的扩展程序**，不分发未签名 `.crx`。
