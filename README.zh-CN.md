<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

浏览器原生 AI Agent 扩展：模型自带（BYOK），以浏览器为「手」，用 Skills / MCP 扩展能力。

[English](./README.md) · [设计文档](./DESIGN.md)

</div>

---

## 是什么

Panelot 是一款在浏览器内运行 Agent 的 Chrome（MV3）扩展：

- **模型自带**。接任意 OpenAI / Anthropic 兼容端点：官方 API、中转、OpenRouter、Ollama / LM Studio 等。每个连接支持多 Key failover、自定义请求头、端点 quirks 兼容。
- **浏览器就是 Agent 的手**。标签页管理、可访问性快照感知、DOM 交互、CDP 高级操作（截图、trusted 按键）。所有写操作都过审批闸门。
- **能力可扩展**。兼容 Claude Code 的 `SKILL.md`（渐进披露）、远端 MCP（Streamable HTTP、OAuth 2.1）、Plugin 包。
- **数据本地**。会话、配置、Key 全部留在本机，Key 只发往你配置的端点。无遥测。

## 架构

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

读代码前值得了解的设计决策（完整论证见 [docs/](./docs)）：

| 决策 | 理由 |
|---|---|
| 会话 = 消息树（`{id, parentId}` + leaf 游标，append-only + 墓碑删除） | 编辑重发 / 重新生成天然是兄弟分支；恢复 = 回放。 |
| 自定义 Op / AgentEvent 协议（Thread/Turn/Item 三层原语） | 流式 + 审批 + 断线重连需要专用的引擎↔UI 通道，MCP 不适合这个位置。 |
| 极简 Agent loop：循环到模型不再调工具，token 预算是唯一硬闸 | 复杂度放在 loop 外层（Gatekeeper、UI）；步数只做软提醒，不做硬中断。 |
| 感知用可访问性快照（`role "name" [ref=sN_M]`，ref 版本化、过期即拒） | 带语义、几百 tokens、不依赖视觉；过期引用在协议层拒绝。 |
| 浏览器级控制权：Agent 可指向任意标签页；安全闸 = 写审批 + 敏感域名黑名单 | 标签页归属只是审计痕迹，不是权限边界。工具结果显式声明用户可见页面是否变化。 |
| 工具结果不说谎 | 无法触发原生行为的合成按键会自我声明；导航 ≠ 失败；跨域 iframe 报告为不可见而非不存在。 |

## 与同类的差异

| | Panelot | 侧边栏类 AI 扩展（Sider / Monica 等） | nanobrowser | browser-use | ChatGPT / Claude 官网 |
|---|---|---|---|---|---|
| 模型来源 | 任意 OpenAI / Anthropic 兼容端点 | 厂商订阅 / 中转 | BYOK | BYOK（Python 库） | 锁定官方 |
| 浏览器操作 | 完整 Agent：标签页 + DOM + CDP 分级 | 只读（摘要/翻译） | DOM 自动化 | DOM 自动化（外部浏览器） | 无 |
| 运行形态 | 纯扩展，零后端 | 扩展 + 厂商云 | 扩展 | Python 进程 + CDP | 云端 |
| 扩展能力 | Skills（兼容 Claude Code）+ MCP + Plugin | 无 | 无 | Python API | 官方商店 |
| 权限模型 | 写操作审批、敏感站点硬拒、站点级规则 | — | 基础 | 信任脚本 | — |
| 数据归属 | 全本地 | 部分云端 | 本地 | 本地 | 云端 |

## 使用

从 Release 安装：

1. 在 Releases 下载最新的 `panelot-<版本>-chrome.zip`（或 `.crx`）。
2. 打开 `chrome://extensions`，开启右上角**开发者模式**。
3. 把 zip 直接拖进页面，或解压后用**加载已解压的扩展程序**。
   （`.crx` 双击安装仅限 Linux 或企业策略环境——Windows/macOS 的 Chrome 只接受商店签名的 CRX，请用 zip。）
4. 点工具栏图标或按 `Alt+P` 开关侧边栏（可在 `chrome://extensions/shortcuts` 改绑）。侧边栏内按 `Ctrl/Cmd+E` 展开为全屏对话页。

首次配置：

1. 设置 → **Providers** → 添加连接：选接口风格（OpenAI 兼容 / Anthropic），填 Base URL 和 Key，点 **Verify**，会得到结构化检测结果：可达 / Key 有效 / 流式 / 工具调用。
2. 选默认模型；可另配一个廉价任务模型跑标题生成等副任务。
3. 开聊：📎 附着当前页面，`@` 引用标签页/选区，`/` 触发 Skill 命令。

让 Agent 操作浏览器：

- 让它调研、填表、跨标签页比价。它通过可访问性快照感知页面，点击/输入等写操作逐一审批。
- 审批卡片完整展示参数；决策可单次、本会话、或本站点生效。
- 银行、支付、政务站点由内置黑名单硬拒绝，黑名单可自行扩充。
- 人工接管：在 Agent 正在操作的页面上手动输入，任务自动暂停。

## 开发

```bash
pnpm install        # postinstall 自动执行 wxt prepare
pnpm dev            # 开发模式（热重载）
pnpm compile        # tsc --noEmit
pnpm test           # Vitest 单测（引擎全链路无头运行，不开浏览器）
pnpm e2e            # Playwright e2e（首次需 pnpm exec playwright install chromium）
pnpm build          # 生产构建 → dist/chrome-mv3
pnpm build:edge     # → dist/edge-mv3
```

注意：刷新网页**不会**更新后台 Service Worker。改了引擎代码后，需到 `chrome://extensions` 重载扩展。

## Release 打包

```bash
pnpm zip            # → .output/*.zip（Edge 用 pnpm zip:edge）
```

需要自分发 `.crx` 时：`chrome://extensions` → **打包扩展程序** → 指向 `dist/chrome-mv3`。生成的 `.pem` 私钥务必保密并复用，保证扩展 ID 稳定。GitHub Release 同时附上 zip 与 crx。
