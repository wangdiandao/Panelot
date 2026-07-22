# 开发指南

> 文档入口：[用户指南](../guide/index.md) · 架构：[架构与消息协议](./architecture.md)
>
> 本文只写当前仓库中可由代码、配置或测试核对的开发流程。目标和测量边界见 [体验目标](./experience-targets.md)。

## 1. 环境要求

| 项目                | 要求                      | 依据                                                                               |
| ------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| Node.js             | `^20.19.0 \|\| >=22.12.0` | `package.json#engines`；GitHub Actions 固定使用 `22.12.0`                          |
| pnpm                | `9.12.3`                  | `package.json#packageManager` 与 lockfile v9                                       |
| 浏览器              | Chrome 116+               | `wxt.config.ts` 的 `minimum_chrome_version`；Edge 作为构建目标但未声明单独最低版本 |
| Playwright Chromium | 仅 e2e 需要               | `playwright.config.ts` 只配置 Chromium 项目                                        |

项目没有必需的 `.env` 文件，也没有从 `process.env` / `import.meta.env` 读取运行配置。模型端点、API Key、权限、Skills 和 MCP 服务器均在扩展设置页配置。

## 2. 安装与开发运行

```bash
pnpm install
pnpm dev
```

`pnpm install` 的 `postinstall` 会执行 `wxt prepare`，生成 `.wxt/` 中的类型和构建辅助文件。`pnpm dev` 会：

1. 启动 WXT/Vite 开发服务器；
2. 构建 `dist/chrome-mv3-dev`；
3. 尝试启动加载了该目录的开发 Chrome。

如果当前环境不允许自动启动浏览器，构建目录仍可使用：打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，加载 `dist/chrome-mv3-dev`。

页面热更新不等于 Service Worker 更新。修改 `entrypoints/background.ts`、`src/engine/`、`src/agent/`、`src/gatekeeper/` 或后台工具注册后，需要在 `chrome://extensions` 重新加载扩展。

文档站使用 VitePress，并与扩展共用根 `package.json` 和 lockfile：

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

`docs:build` 会执行完整渲染和内部链接校验；CI、Release 与 GitHub Pages 工作流都会运行它。

### 文档写作约定

- 先写可核对的事实，再写限制和操作结果；不要用宣传语代替能力说明。
- 一句话只承载一个主要信息。步骤、并列条件和风险项确实需要扫描时再使用列表。
- 用户文档使用界面中的名称，不暴露 Gatekeeper、L1/L2 等内部术语。开发文档保留准确的协议名、类型名和源码路径。
- 不用“此外”“值得注意的是”一类填充短语，也不强凑三项结构或正反对照。删掉这些词后句意不变，就直接删掉。
- 交叉引用使用有含义的链接文字，例如“[权限](./permissions.md) §5”，不要只写“见 06”。

## 3. 目录导航

| 路径                                    | 职责                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| `entrypoints/background.ts`             | 组合数据库、引擎、Provider、Gatekeeper、浏览器工具、Skills、MCP，并接入 Chrome 事件 |
| `entrypoints/page-executor.unlisted.ts` | 按需注入页面的 L1 工具执行器、操作指示器与人工接管监听                              |
| `entrypoints/mcp-worker/`               | offscreen document 中运行浏览器安全的 MCP SDK Client 与数据导入 canonical validator |
| `entrypoints/sidepanel/`                | 侧边栏入口                                                                          |
| `entrypoints/chat/`                     | 全屏对话页入口                                                                      |
| `entrypoints/options/`                  | 独立设置页入口；复用 `SettingsPanel`                                                |
| `src/engine/`                           | Op 调度、Thread/Turn 生命周期、队列、审批挂起和 Provider 解析                       |
| `src/agent/`                            | Agent loop、工具注册表和参数校验                                                    |
| `src/messaging/`                        | UI ↔ Service Worker 的共享协议与 Port/Direct transport                              |
| `src/db/`                               | Dexie schema、会话树操作和模型上下文派生                                            |
| `src/providers/`                        | OpenAI/Anthropic 线协议、SSE、重试、Key failover、模型列表与 Verify                 |
| `src/tools/`                            | L0 标签页、L1 content script、L2 CDP 与后台内置工具                                 |
| `src/gatekeeper/`                       | 审批策略、敏感站点/数据检测和持久规则                                               |
| `src/skills/`                           | SKILL.md 解析、存储、索引与 `load_skill`                                            |
| `src/mcp/`                              | 远端 MCP JSON-RPC/Streamable HTTP、Bearer/OAuth 和工具桥接                          |
| `src/plugins/`                          | 数据型 Plugin 的 ZIP/GitHub 安装、校验、资产所有权、启停与卸载                      |
| `src/prompts/`                          | 内核提示词、分层拼装和不可信内容定界                                                |
| `src/ui/`                               | EngineClient、共享对话组件、设置页、主题与 i18n                                     |
| `tests/`                                | Vitest 单测和无浏览器集成测试                                                       |
| `e2e/`                                  | Playwright 真实 Chromium 测试；当前覆盖快照引擎和表单值回显                         |
| `preview/`                              | 表现层 UI 的独立预览入口，不参与扩展生产构建                                        |
| `docs/guide/`                           | 面向扩展用户的安装、配置、权限、数据与故障排查指南                                  |
| `docs/development/`                     | 当前工程契约、开发流程、调研和待验证目标                                            |
| `docs/.vitepress/`                      | 文档站配置、导航、主题和构建输出边界                                                |
| `scripts/`                              | 可保留的仓库脚本；临时验证脚本放 `scratch/`                                         |

## 4. 调用链

```text
Side Panel / Chat UI
  → EngineClient
  → chrome.runtime Port（Op）
  → EngineHost（握手、队列、事件合帧、订阅广播）
  → RealEngineCore（会话、轮次、审批 RPC、队列）
  → runTurn
      → buildSessionContext（从会话树派生线性历史）
      → SettingsProviderResolver → OpenAI/Anthropic adapter
      → ToolRegistry → GatekeeperService
          ├─ L0 标签页 API
          ├─ L1 Content Script
          ├─ L2 chrome.debugger
          ├─ 后台内置工具
          └─ 已连接的远端 MCP tools
  → ThreadTree / PanelotDB checkpoint
  → AgentEvent 广播回所有订阅该 Thread 的 UI
```

UI 不单独保存会话状态。会话路径和已完成工具结果来自 IndexedDB snapshot，流式 delta 只作为实时叠加层；轮次结束后，UI 重新订阅并以持久化 snapshot 为准。

## 5. 配置与本地数据

### chrome.storage.local

主要键由 `src/settings/store.ts`、`src/gatekeeper/service.ts` 和 `src/mcp/manager.ts` 管理：

- `connections`：Provider 连接；API Key 与敏感 Header 以 `secret:v1:` 前缀的 AES-GCM 密文保存，仍可读取旧 `enc:` 格式；
- `model_presets`：ModelPreset 数据与独立管理页；
- `global_settings`：默认模型、任务模型、主题、语言、全局指令等；
- `last_model`、`thread_params:<threadId>`：模型选择和会话参数覆盖；
- `site_prompts`、`thread_seen`：站点指令和 UI 已读状态；
- `permission_rules`、`sensitive_origins`：审批规则和敏感站点列表；
- `mcp_servers`：远端 MCP 非秘密配置；Bearer 与 OAuth refresh token 分离加密，OAuth access token 仅存 `storage.session`；
- `panelot_local_secret_key`：本机 AES-GCM 封装 key material；`panelot_kek_v1` 仅用于兼容读取旧密文。

API Key 加密用于避免明文浏览和意外泄漏，不构成对“可读取扩展存储和本机文件的攻击者”的强安全边界。导出数据默认剔除 Key，只有用户显式选择时才包含。

### IndexedDB

Dexie 数据库名为 `panelot_v1`，表定义在 `src/db/schema.ts`。0.1.0 数据不迁移：

- `threads`：会话索引和当前分支叶子；
- `nodes`：append-only 会话树节点；
- `attachments`：截图、页面正文和用户附件；
- `skills`：SKILL.md 原文、frontmatter 和状态；
- `memories`：Agent memory 工具数据；
- `runs`、`commandReceipts`、`approvals`：可恢复运行时、命令去重回执与审批；
- `plugins`、`pluginAssets`：Plugin 元数据与只读资产。

设置页“数据”支持 JSON 导出和覆盖导入。导出包括会话、节点、用户 Skills、memories 和部分设置，但不包含 `attachments` 表中的 blob；不能把这份 JSON 当作完整附件备份。

导入分两次确认。Options 页面先校验文件和加密口令，后台再通过已认证的内部 Port 交给 offscreen worker 做 canonical 校验。后台会核对输入与设置 digest，并列出运行中、待审批和已暂停的任务。第二次确认后，恢复日志、设置和 IndexedDB 数据才会提交。

解密后的便携秘密在密封进本机存储前会校验完整结构、字段类型和重复 ID。启动恢复只接受覆盖全部受管设置键及合法 `thread_params:*` 键的 journal preimage；缺键、畸形条目或任意键会以 `IMPORT_JOURNAL_CORRUPT` 失败关闭，不执行部分回滚。

导入不会覆盖现有附件 blob。仍被导入节点引用的附件会重建引用，未引用附件标记为 orphan，Plugin 和 builtin Skills 会保留。提交后必须重载扩展；重载前新的 Agent 命令会被拒绝。

## 6. 开发命令

| 命令                          | 用途                                          | 产物/范围                                          |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `pnpm dev`                    | Chrome 开发模式与热更新                       | `dist/chrome-mv3-dev`                              |
| `pnpm dev:edge`               | Edge 开发目标                                 | `dist/edge-mv3-dev`                                |
| `pnpm compile`                | 协议 manifest 与 TypeScript 严格检查          | Engine/content 协议、主源码及独立配置              |
| `pnpm protocol:check`         | 校验语义 manifest 与 schema hash              | Engine 与 content-script 跨上下文契约              |
| `pnpm protocol:write`         | 写入审核后的语义 manifest hash                | `src/messaging/protocol.ts`                        |
| `pnpm lint`                   | ESLint 9 与 React Hooks 门禁                  | 全仓库源码与测试                                   |
| `pnpm format:check`           | Prettier 格式门禁                             | TypeScript/JavaScript/JSON（含 preview）           |
| `pnpm test`                   | Vitest 单测与无浏览器集成测试                 | `tests/**/*.test.ts`                               |
| `pnpm test:coverage`          | Vitest V8 覆盖率与阈值门禁                    | 终端 text；`coverage/`（JSON summary、LCOV、HTML） |
| `pnpm test:watch`             | Vitest 监听模式                               | 本地开发使用                                       |
| `pnpm e2e`                    | Playwright Chromium 测试                      | `e2e/**/*.spec.ts`                                 |
| `pnpm build`                  | Chrome MV3 生产构建                           | `dist/chrome-mv3`                                  |
| `pnpm build:edge`             | Edge MV3 生产构建                             | `dist/edge-mv3`                                    |
| `pnpm zip`                    | Chrome 发布压缩包                             | `dist/panelot-<version>-chrome.zip`                |
| `pnpm zip:edge`               | Edge 发布压缩包                               | `dist/panelot-<version>-edge.zip`                  |
| `pnpm budget`                 | 生产 JS、共享首屏与 background 静态依赖图预算 | `dist/chrome-mv3`                                  |
| `pnpm zip:smoke -- <zips...>` | ZIP manifest、权限与 source map smoke         | Chrome/Edge ZIP                                    |
| `pnpm icons`                  | 从 `public/icon/icon.svg` 重新渲染 PNG 图标   | `public/icon/{16,32,48,128}.png`                   |

CI 的 `verify` job 依次运行 format、lint、compile、生产扩展 e2e、Chrome/Edge 构建、包体预算和 ZIP smoke。独立的 `coverage` job 运行单元测试与覆盖率门禁，不再重复执行普通 `pnpm test`。

`pnpm compile` 首先校验 Engine 与 content-script 的语义 protocol manifest。若共享类型、运行时 validator、transport/gateway 或页面执行边界发生了经过审核的契约变化，运行 `pnpm protocol:write` 更新 `protocol.ts` 中的两个 schema hash，再重新执行 compile；注释或格式化不应触发 hash 变化。

Release job 只接受位于 `origin/main` 历史中、且已有成功 main CI workflow run 的 tag commit。它绑定 `release` environment；仓库管理员需要配置 required reviewers 和 `v*` deployment tag rule，并将 `verify` 与 `coverage` 保持为 `main` 的 required checks。行为变更应补对应测试。

首次执行 e2e 前安装浏览器：

```bash
pnpm exec playwright install chromium
```

## 7. 测试边界

- 测试必须保护长期稳定的行为、协议、安全、恢复或可访问性契约。仅证明某次修复已完成、匹配内部 className/源码文本、依赖个人配置或检查已删除文件不再出现的用例应在修复稳定后移除；同一契约已有更高层覆盖时，不保留重复的单点探针。
- 测试按生产领域组织，而不是按缺陷编号或修复轮次组织。异步、超时和重试使用可控截止时间、fake timer 或显式 gate，不等待真实生产超时；测试运行不得依赖用户 profile、被忽略的本地文件或真实网络。
- Vitest 使用 Node 环境；需要 DOM 的用例按文件引入 happy-dom/fake-indexeddb。
- `pnpm test:coverage` 使用 V8 统计 `src/**/*.{ts,tsx}`，排除声明文件。扩展 `entrypoints/` 由独立 TypeScript 配置和仓库契约检查保护；只有能够稳定导入测试的入口组合层才进入执行覆盖率，避免用不可导入的 MV3 启动副作用稀释指标。整体基线为 lines 58%、branches 50%；核心文件另有分支阈值：`runState.ts` 72%、`gatekeeper.ts` 93%、`rules.ts` 87%、`service.ts` 78%、`secretStore.ts` 80%、`exportImport.ts` 52%。报告写入 `coverage/`。CI 要求 `coverage-report` artifact 存在并保留 30 天。
- `tests/engine/integration.test.ts` 通过 DirectTransport、mock Provider 和真实 Dexie 逻辑验证引擎链路，不启动 Chrome。
- Playwright 使用 persistent Chromium context 加载生产 unpacked extension，验证 MV3 Service Worker、options 页面、manifest、快照/ref 与表单回显。三层跨站 OOPIF 会通过生产扩展入口执行 `read_page_deep → type_trusted → click_trusted`，并检查 UI 审批、最新 generation deep ref 和 `event.isTrusted`。closed shadow root 目前由 Playwright 原生 CDP fixture 验证浏览器能力。
- Provider Verify 需要用户配置的真实端点，不能由默认离线测试证明所有第三方兼容性。

## 8. 常见问题

### 修改后台代码后行为没有变化

网页刷新不会替换 MV3 Service Worker。到 `chrome://extensions` 重新加载 Panelot，再刷新被操作页面。

### `pnpm dev` 已构建但浏览器没有启动

确认终端可以启动 Chrome。受限容器或沙箱可能报 `spawn EPERM`；这不影响已经生成的 `dist/chrome-mv3-dev`，可手动加载该目录。

### Vitest/Playwright 在启动阶段报 `spawn EPERM`

Vite、esbuild 和 Playwright 需要创建子进程。若错误发生在测试收集前，应先在允许子进程的终端重跑，不要直接判定为测试用例失败。

### Playwright 报浏览器不存在

执行 `pnpm exec playwright install chromium`。当前配置不会安装或运行 Firefox/WebKit。

### Provider Verify 提示 host permission

添加或验证端点时允许浏览器授予该 origin 的访问权限。项目不在 manifest 中静态声明 `<all_urls>` host permission，而是按需申请。

### 生产构建提示 chunk 超过 500 kB

Shiki 使用 core 单例与按需语言，Mermaid、KaTeX、CodeMirror 和设置页按需加载；独立 Options 页先加载轻量入口，再异步加载完整设置应用，避免把设置依赖计入所有可见页共享首屏。Vite 仍会提示个别 chunk 超过 500 kB；CI 以可执行预算为准：生产 JS ≤ 4 MB、可见页共享 eager JS ≤ 500 KiB、`background.js` 入口 ≤ 230 KiB、入口及其递归静态 import 图 ≤ 406 KiB。后台预算包含跨上下文消息与 MCP worker 响应的有界资源校验，不得通过移除校验或动态导入规避。

后台使用两层预算，因为 MV3 扩展 Service Worker 不支持动态 `import()`。入口预算限制 `background.js` 本身，静态图预算限制 Worker 唤醒时实际加载的本地模块总量。

不要用动态导入绕过静态图统计。如果以后把引擎迁到 offscreen document 或独立 Worker，需要同时评估生命周期、跨上下文 RPC、恢复语义和总内存，不能只比较 `background.js` 的文件大小。平台限制见 [Chrome Extension service worker basics](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics#import-scripts)。

## 9. 文档和代码约定

- 修改行为前阅读对应文档分章，同时核对源码与测试；目标规格不得写成已上线状态。
- 跨上下文协议只在 `src/messaging/protocol.ts` 定义；UI、后台和测试直接引用同一类型。
- UI 设计 token 的事实来源是 `src/ui/styles/global.css`；快捷键事实来源是 `src/ui/shortcuts.ts`。
- 内核 prompt 的事实来源是 `src/prompts/kernel.ts`，文档只保留结构摘要。
- 用户指南、开发文档和隐私政策由 `docs/.vitepress/config.mts` 统一组织；新增或移动页面时必须同步导航并通过 `pnpm docs:build` 的死链接检查。
- 不写版本迭代或修复轮次注释，不保留注释掉的旧代码；临时脚本放 `scratch/`，任务结束清理临时报告和调试输出。

仓库采用 MIT License，并维护 `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、第三方归属与双语隐私政策。

## 10. 发布打包

```bash
pnpm compile
pnpm test
pnpm e2e
pnpm build
pnpm build:edge
pnpm zip
pnpm zip:edge
pnpm budget
pnpm zip:smoke -- dist/panelot-<version>-chrome.zip dist/panelot-<version>-edge.zip
```

CI 对 push/PR 执行完整门禁。`v*` tag 在版本匹配、main 来源和成功 CI 校验后，分别为 Chrome/Edge ZIP 生成 CycloneDX SBOM，记录每个 ZIP 与 SBOM 的 SHA-256，再创建 GitHub Release；Chrome Web Store 与 Edge Add-ons 仍人工上传。用户指南、开发文档和隐私政策由 GitHub Pages 工作流发布。
