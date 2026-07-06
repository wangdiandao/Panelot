# 08 — Skills 与 Plugin 体系

> 上级文档：[DESIGN.md](../DESIGN.md) · 关联：[04 Agent 引擎](./04-agent-engine.md) · [09 界面](./09-ui.md) · [10 提示词](./10-prompts.md)
> 格式决策：兼容 Claude Code 的 SKILL.md（社区生态可直接导入）；斜杠命令的变量表单借鉴 OpenWebUI

---

## 1. SKILL.md 解析规范

```markdown
---
name: xhs-publisher                # 必填，kebab-case，唯一
description: 将当前文章改写为小红书风格并发布。当用户要求发小红书时使用。   # 必填，进入常驻索引
panelot:                           # 可选扩展命名空间（Claude Code 忽略，不破坏兼容）
  sites: ["*.xiaohongshu.com", "creator.xiaohongshu.com"]   # 站点作用域
  auto_suggest: true               # 进入匹配站点时侧边栏提示
  command: /xhs                    # 显式注册斜杠命令
  variables:                       # 命令的结构化变量表单（OpenWebUI 模式）
    - { key: tone, label: 语气, type: select, options: [活泼, 专业], default: 活泼 }
---
# 指令正文（Markdown，自由格式）
…
```

frontmatter 用 zod 校验：

```ts
const SkillFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).max(64),
  description: z.string().min(1).max(500),
  panelot: z.object({
    sites: z.array(z.string()).optional(),        // 匹配用 URLPattern
    auto_suggest: z.boolean().optional(),
    command: z.string().regex(/^\/[a-z0-9:-]+$/).optional(),
    variables: z.array(VariableDef).optional(),
  }).optional(),
}).passthrough();   // 未知字段保留（兼容 Claude Code 的 allowed-tools 等，V1 忽略但不报错）
```

存储（Dexie `skills` 表）：

```ts
interface SkillRecord {
  id: string; name: string;
  raw: string;                    // 原文（导出/编辑用）
  frontmatter: SkillFrontmatter; body: string;
  enabled: boolean;
  source: 'builtin' | 'user' | 'imported' | 'plugin';
  sourceRef?: string;             // 导入 URL / plugin id
  createdAt: number; updatedAt: number;
}
```

## 2. 渐进披露（与 Claude Code 行为一致）

1. **索引常驻**：所有 enabled Skill 的 `name + description` 拼入 system prompt 的 Skills 区块（10 §6）；有 `sites` 作用域的 Skill 仅在当前操作目标 tab 匹配时进入索引（省 prompt 空间）；
2. **按需加载**：模型判断相关时调用内置工具 `load_skill{name}` → 返回完整 body 作为 tool_result 进入上下文；
3. `load_skill` effects:'read'、默认 allow；同一 Skill 每 Thread 只完整加载一次（重复调用返回「已加载」提示）；
4. `auto_suggest`：content script 报告 URL 变化 → 匹配 sites → 侧边栏顶部出现建议胶囊（点击 = 预填 `/command` 或直接以该 Skill 开启对话）。

## 3. 管理与导入

- **编辑器**：设置页内置 SKILL.md 编辑器（CodeMirror，frontmatter 实时校验 + 模板起步）；
- **导入**：`.md` 文件 / URL（GitHub raw 或 repo 目录下 SKILL.md）/ 粘贴文本。导入时展示解析结果（name/description/作用域）确认后入库；同名冲突提示覆盖或改名；
- **导出**：单个 `.md` 下载 / 复制。多文件 Skill（scripts、references 目录）V1 不支持——导入时若检测到引用附属文件，警告"该 Skill 依赖附属资源，可能不完整"。

## 4. 斜杠命令体系

命令来源三类，统一注册到命令面板（09 §5）：

| 来源 | 形态 | 示例 |
|---|---|---|
| 内置 | 固定实现 | `/clear` `/export` `/model` `/cost` `/permissions` |
| Skill | `panelot.command` 声明 | `/xhs` → 弹变量表单 → 组装为 user 消息（Skill body 经 load_skill 注入） |
| MCP Prompt | 自动注册 | `/github:review-pr` → 参数表单 → `prompts/get` 结果注入 |

变量表单：`VariableDef { key, label, type: 'text'|'select'|'date'|'url', options?, default?, required? }`，提交时替换命令模板中的 `{{key}}`。

## 5. Plugin 包格式

Plugin = 分发单元（zip 或 Git 仓库），结构参考 Claude Code：

```
my-plugin/
├── plugin.json          # { name, version, description, author, homepage,
│                        #   minPanelotVersion? }
├── skills/              # 每子目录一个 SKILL.md
│   └── xhs-publisher/SKILL.md
├── mcp.json             # 可选：mcpServers 配置片段（导入时走 07 §2 流程）
├── rules.json           # 可选：建议的权限规则（source:'plugin_default'，见 06 §3）
└── site-prompts/        # 可选：站点级指令 { "github.com": "…" }
```

安装流程：本地 zip / GitHub URL（拉 default branch 的 tarball via codeload）→ **安装清单确认页**：列出将添加的 Skills、MCP 服务器（含其权限含义）、权限规则、站点指令 → 用户确认 → 逐项入库并标记 `source:'plugin'` + plugin id → 可整体启停/卸载（级联移除其 Skills/规则；MCP 服务器保留但提示）。

**信任边界**：Plugin 是数据不是代码——不含可执行 JS（MV3 CSP 也不允许远程代码）。其风险面 = 提示词注入 + 引入的 MCP 服务器，故 rules.json 中的 `allow` 规则安装时默认降级为 `ask`，用户在权限页手动提升。

精选列表：官方维护 `panelot-plugins/index.json`（GitHub 托管），设置页内浏览安装；社区市场 V2 再议。

## 6. 站点级指令

独立于 Skill 的轻量机制（类似 per-domain CLAUDE.md）：设置页维护 `{ pattern: string, prompt: string }[]`，匹配当前操作目标 tab 时拼入 system prompt 站点层（10 §6）。Plugin 的 site-prompts 归并于此。

## 7. 开放问题

- [ ] Claude Code frontmatter 的 `allowed-tools` 是否映射到 Panelot 权限（V1 忽略；V2 可映射为 Thread 级工具白名单）。
- [ ] Skill 版本与更新检查（imported 记录 sourceRef，V1.5 做手动"检查更新"）。
