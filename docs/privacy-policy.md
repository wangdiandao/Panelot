# Panelot Privacy Policy / Panelot 隐私政策

Effective date / 生效日期: 2026-07-10

## English

Panelot is a local-first browser extension. It does not operate a Panelot account service, cloud sync service, advertising system, or telemetry pipeline.

### Data processed

Panelot stores conversations, settings, Skills, Plugins, approvals, and attachments in the browser profile. Provider API keys, MCP bearer tokens, OAuth refresh tokens, and sensitive custom headers are encrypted locally. OAuth access tokens are session-only.

When you ask Panelot to use a model, the prompt, relevant conversation history, selected page or file context, and tool results are sent directly to the provider connection you configured. When you enable an MCP server, tool arguments and relevant results are exchanged directly with that server. Those third parties process data under their own policies.

Panelot reads or changes a website only when a task requires it and the browser grants access. Website host access is optional and requested at runtime. Page content is not uploaded to Panelot-operated servers.

### Sharing and retention

Panelot does not sell personal data and does not send analytics. Local records remain until you delete them, clear extension data, or uninstall the extension. Export files are created only at your request. Default exports omit secrets; password-protected secret backups use PBKDF2-SHA-256 and AES-GCM.

### Your choices

You can revoke site access in browser extension settings, disable or remove providers and MCP servers, delete conversations and attachments, export non-secret data, or uninstall Panelot. Revoking a third-party token may also require using that provider's account controls.

Security reports should follow `SECURITY.md` in the Panelot repository.

## 中文

Panelot 是本地优先的浏览器扩展，不运营 Panelot 账户服务、云同步服务、广告系统或遥测管道。

### 处理的数据

Panelot 在浏览器配置文件中保存会话、设置、Skills、Plugins、审批和附件。Provider API Key、MCP Bearer Token、OAuth Refresh Token 及敏感自定义 Header 使用本机加密；OAuth Access Token 仅保留在浏览器会话中。

当你要求 Panelot 调用模型时，提示词、相关会话历史、你选择的网页或文件上下文以及工具结果会直接发送到你配置的 Provider。启用 MCP Server 后，工具参数和相关结果会直接与该 Server 交换。第三方服务按其自身政策处理这些数据。

Panelot 仅在任务需要且浏览器授予访问权时读取或修改网站。网站 Host 权限为可选权限，并在运行时请求。网页内容不会上传到 Panelot 运营的服务器。

### 共享与保留

Panelot 不出售个人数据，也不发送分析数据。本地记录会一直保留，直到你删除记录、清除扩展数据或卸载扩展。仅在你主动操作时创建导出文件。默认导出不包含秘密；含秘密备份使用 PBKDF2-SHA-256 与 AES-GCM 进行口令保护。

### 你的选择

你可以在浏览器扩展设置中撤销站点访问，停用或删除 Provider 与 MCP Server，删除会话和附件，导出不含秘密的数据，或卸载 Panelot。撤销第三方 Token 可能还需要前往对应服务的账户设置。

安全问题请按 Panelot 仓库中的 `SECURITY.md` 私密报告。
