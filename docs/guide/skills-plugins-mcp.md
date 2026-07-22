# Skills、Plugins 与 MCP

Panelot 提供三类扩展方式，各自负责不同的内容：

| 类型   | 用途                                          | 是否执行代码                               |
| ------ | --------------------------------------------- | ------------------------------------------ |
| Skill  | 向模型提供一组可按需加载或通过 `/` 运行的指令 | 不直接执行 Skill 文件中的代码              |
| Plugin | 打包分发只读 Skill、模型预设和站点指令        | 不执行远程代码                             |
| MCP    | 连接远端服务器提供的 Tool、Prompt 和 Resource | 工具在远端服务器执行，参数和结果会与其交换 |

三者都可能影响模型行为。安装或启用前先核对来源和内容；未知指令不能视为可信授权。

## Skills

在“设置 → Skills”可以新建、编辑、启停、删除和导出 Skill，也可以从本地 Markdown 文件或 URL 导入。

一个可导入 Skill 是带 YAML 头部的单个 `SKILL.md` 文件，至少包含名称和描述。启用后，Panelot 会先让模型看到名称和描述；模型判断相关时再加载正文。也可以在输入框中键入 `/`，直接选择对应命令。

URL 导入仅接受 **HTTPS 且响应正文直接是 `SKILL.md`** 的地址，例如 raw 文件地址。普通 GitHub 仓库页或目录 URL 不会自动查找其中的 Skill。URL 文件上限为 1 MB。

单文件导入有以下限制：

- 不会同时下载 `scripts/`、`references/`、`assets/` 或其它相对链接；
- 界面检测到这些依赖时会警告，但不会自动补齐；
- Claude Code 的未知头部字段会保留，但 `allowed-tools` 等声明不会改变 Panelot 的浏览器权限。

同名 Skill 导入时可以覆盖或自动改名。Panelot 不自动检查 Skill 更新，重新导入前应自行比较来源内容。

## Plugins

在“设置 → Plugins”可以选择本地 ZIP，或分析 GitHub 仓库、仓库归档、tree/archive/release ZIP 地址。安装前会显示来源、摘要、资产列表和提示词相关警告。

Plugin 只能包含清单声明的数据资产：

- Skills；
- 模型预设；
- 站点指令；
- 其它经过校验的只读数据资产。

它不能安装可执行文件、运行远程代码，也不导入 MCP 连接或权限规则。压缩包上限为 10 MB，解压内容上限为 50 MB、最多 1000 个文件；路径穿越、符号链接、可执行权限和常见可执行扩展名会被拒绝。

安装或升级后 Plugin 保持停用，需在审查后手动启用。Plugin 资产为只读；要修改其中的 Skill、预设或站点指令，请先“复制并编辑”。停用或卸载 Plugin 会使其提供的资产不再进入新任务。

精选索引目前没有内置条目，也不提供市场评分、自动更新或远程代码市场。

## 站点指令

“设置 → 站点”可为精确主机名或 `*.example.com` 这类子域模式添加可信指令。本次发送时捕获的默认网页或明确引用的标签页匹配后，指令才会加入模型上下文；不支持按 URL 路径匹配。

站点指令会影响模型行为，但不会授予网站访问或操作权限。Plugin 提供的站点指令是只读的，可以复制为用户指令后修改。

## 远端 MCP

Panelot 当前只支持通过 **Streamable HTTP** 连接远端 MCP Server，不支持本地 `stdio` Server，也不支持旧式独立 SSE 传输。

在“设置 → MCP 服务器”选择“粘贴 JSON 导入”，可以粘贴 Claude Code `mcpServers` 或 Cursor 风格片段。配置必须包含远端 `url`；`headers.Authorization` 中的 Bearer Token 会被识别。本地 `command` 配置不会被导入。

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

导入时浏览器会请求服务器域名的站点权限。添加后可以：

- 启停服务器；
- 执行连接测试或重新连接；
- 查看工具、Prompt 和 Resource 数量；
- 单独停用某个远端工具；
- 在支持的服务器上完成 OAuth 授权；
- 删除服务器配置。

OAuth 流程可能分阶段请求资源服务器、授权服务器和 Token 端点的站点权限。每次都应核对显示的域名。授权元数据变化或计划过期时，Panelot 会要求重新确认，而不是沿用旧授权目标。

## 在对话中使用 MCP

- 远端 Tool 会由模型按任务调用，并按写操作进入当前权限策略。Panelot 不依据服务器自报的“只读”标记降低确认要求。
- MCP Prompt 出现在 `/` 菜单中；带参数的 Prompt 会先显示表单。
- MCP Resource 出现在 `@` 菜单中；选中后才读取并附加到当前消息。

Tool 参数和相关结果会直接与 MCP 服务器交换。远端调用失败不会被显示为本地成功；被中断的远端写操作也不会在结果不明时盲目重试。

如果 OAuth Token 失效且需要交互式重新授权，请打开设置页手动授权。后台任务无法自行完成登录页面。

实现与协议限制详见[Skills 与 Plugins 开发说明](../development/skills-plugins.md)和[MCP 开发说明](../development/mcp.md)。
