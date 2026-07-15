# 08 — Skills 与 Plugin 体系

> 文档索引：[README.md](../README.md) · 关联：[04 Agent 引擎](./04-agent-engine.md) · [09 界面](./09-ui.md) · [10 提示词](./10-prompts.md)
> 格式决策：兼容 Claude Code 的 SKILL.md（社区生态可直接导入）；斜杠命令的变量表单借鉴 OpenWebUI

> **实现状态**：单文件 SKILL.md 的解析、编辑、文件/URL 导入、冲突处理、导出、渐进披露和 Skill 斜杠命令已接入。数据型 Plugin 支持本地 ZIP/普通 GitHub 仓库或 archive URL 安装、整体启停与卸载；精选索引随构建内置但当前为空。

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
}).passthrough();   // 未知字段保留（兼容 Claude Code 的 allowed-tools 等，忽略但不报错）
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

1. **索引常驻**：所有 enabled Skill 的 `name + description` 拼入 system prompt 的 Skills 区块（10 §6）；有 `sites` 作用域的 Skill 仅在当前默认网页 tab 匹配时进入索引（省 prompt 空间）；显式 `tabId` 工具调用仍由工具与权限层按实际目标裁决；
2. **按需加载**：模型判断相关时调用内置工具 `load_skill{name}` → 返回完整 body 作为 tool_result 进入上下文；
3. `load_skill` effects:'read'、默认 allow；同一 Skill 每 Thread 只完整加载一次（重复调用返回「已加载」提示）；
4. `auto_suggest`：`SkillManager.suggestionsFor(url)` 已实现并有单测，但 content script URL 变化 → 侧边栏建议胶囊的 UI 链路尚未接入。

## 3. 管理与导入

- **编辑器**：设置页内置 SKILL.md 编辑器（CodeMirror，frontmatter 实时校验 + 模板起步）；
- **导入**：设置页可选择 `.md` 文件、填写直接返回 SKILL.md 的 URL，或在编辑器中粘贴。使用完整 YAML parser；若正文引用 scripts/references 等伴随文件，会在单文件导入前提示依赖不会随同导入；同名 Skill 必须选择覆盖或自动改名；
- **导出**：每个 Skill 可下载为单文件 `<name>.SKILL.md`。多文件 Skill 仍不打包，导入提示只负责暴露限制。

## 4. 斜杠命令体系

命令来自 Skill 与 MCP Prompt，统一注册到命令面板（09 §5）：

| 来源 | 形态 | 示例 |
|---|---|---|
| Skill | `panelot.command` 声明，未声明时默认 `/{name}` | `/xhs` → 可弹变量表单 → 发送时由后台把 Skill body 作为 attached ContextBlock 直接附到 user message；这条显式命令路径不调用 `load_skill` |
| MCP Prompt | `/server:prompt` | manager 发现 prompt 后注册 TriggerMenu；有参数时复用变量表单，提交后调用 `prompts/get` 并附加不可信 ContextBlock |

变量表单：`VariableDef { key, label, type: 'text'|'select'|'date'|'url', options?, default?, required? }`，提交时替换命令模板中的 `{{key}}`。

## 5. Plugin 包格式

Plugin 是只读数据分发单元（zip 或 GitHub 仓库归档）：

```
my-plugin/
├── .codex-plugin/plugin.json  # { id, name, version, description?, assets[] }
├── skills/example/SKILL.md
├── presets/research.json
└── sites/example.json
```

安装器接受本地 ZIP、普通 GitHub 仓库 URL、tree/archive/release ZIP URL；普通仓库先读取 default branch，再从 codeload 下载。GitHub archive 的单一顶层目录会安全剥离。所有文件必须在 manifest 中声明，完整解析/冲突检查后才在单个 Dexie 事务中写入；设置页显示已安装资产清单并支持整体启停/卸载。

**信任边界**：Plugin 是数据不是代码。压缩包限制 10 MB，实际解压输出按流逐块累计并限制 50 MB，文件数限制 1000；超限立即中止分析，不信任 ZIP 声明的未压缩大小。拒绝路径穿越、symlink、Unix executable bit 和常见可执行扩展名；资产只读，编辑前复制为用户资产。当前格式不导入 MCP 配置或权限规则。

精选索引接口随构建内置，当前返回空列表；不做自动更新、市场评分或远程可执行内容。

## 6. 站点级指令

独立于 Skill 的轻量机制（类似 per-domain CLAUDE.md）：设置页维护 `{ pattern, prompt }[]`，支持 exact host 与 `*.domain`，后台按目标 tab 匹配并拼入 system prompt。启用 Plugin 的 site-instruction 只读资产参与合并，可复制为用户指令后编辑。

## 7. 已定事项

- Claude Code frontmatter 的 `allowed-tools` 不映射到 Panelot 权限：解析时 passthrough 保留、不生效也不报错。权限只认 Gatekeeper 一个闸口——Skill 自带的工具声明是能力提示而非安全边界，让它影响裁决反而制造第二套权限来源。
- 不做 Skill 更新检查：imported 记录存有 `sourceRef` 供手动溯源，无自动更新通道（Skill 是用户资产，静默变更反而危险）。
