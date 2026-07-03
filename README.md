# Panelot

浏览器原生 AI Agent 扩展 — 模型自带（BYOK）、能力可扩展（Skills / MCP / Plugin）、Agent 的「手」就是浏览器本身。设计文档见 [DESIGN.md](./DESIGN.md) 与 [docs/](./docs)。

## 开发

```bash
pnpm install        # 安装依赖（postinstall 会跑 wxt prepare）
pnpm dev            # 开发模式（自动重载）
pnpm build          # 产出 dist/chrome-mv3
pnpm build:edge     # 产出 dist/edge-mv3
pnpm zip            # 打包 Chrome/Edge 分发 zip（不含提审）
pnpm test           # Vitest 单测（218 项，引擎全链路不开浏览器）
pnpm e2e            # Playwright e2e（首次需 pnpm exec playwright install chromium）
pnpm compile        # tsc --noEmit
```

## 手动加载扩展

1. `pnpm build`
2. Chrome → `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/chrome-mv3`
3. 点击工具栏图标打开侧边栏

## M1 冒烟清单（对话核心）

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 加载扩展，打开侧边栏 | 显示新会话界面，输入框提示「先在设置中添加模型」 |
| 2 | 设置 → Providers → 添加连接 → 选模板填 Key → Verify | 结构化结果：可达 ✓ / Key ✓ / 流式 ✓ / 工具 ✓；错误时给出人话归因 |
| 3 | 侧边栏输入问题发送 | 流式回复，Markdown 渲染（代码块/表格/公式），流式中无闪烁 |
| 4 | 回复过程中按 Esc | ≤200ms 停止，显示已中断 |
| 5 | 回复过程中继续打字并 Enter | 插话提示出现，下一次模型调用带上插话内容 |
| 6 | 点「📎 当前页 ＋附着」再提问 | 回答基于当前页面内容 |
| 7 | 侧边栏 ⛶ 展开全屏 | 三栏布局，同一会话无缝续接 |
| 8 | 全屏页新建多个会话 | 左栏时间分组显示，标题自动生成 |
| 9 | 关闭并重开侧边栏 | 会话完整恢复（snapshot 一次到位） |
| 10 | chrome://serviceworker-internals 手杀 SW 后继续对话 | 自动重连，历史无损 |

## 架构速览

- **引擎在 Background SW**（`src/engine/`），UI 是薄视图（`src/ui/`），通过 Port + Op/AgentEvent 协议通信（`src/messaging/protocol.ts` 是唯一类型来源）
- **会话是消息树**（`src/db/`）：`{id, parentId}` + leafId 游标，append-only + 墓碑删除，恢复 = 回放
- **Provider 适配层**（`src/providers/`）：OpenAI / Anthropic 双协议、手写 SSE、quirks 兼容开关、多 key failover
- **Agent loop**（`src/agent/`）：循环到模型不再调工具；步数软提醒、token 预算硬闸；auto-compaction 防复合丢失
