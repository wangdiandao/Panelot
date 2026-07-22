# Data disclosure for store review

## English

- Account data: not collected by Panelot's operator.
- Analytics/telemetry: not collected.
- Advertising data: not collected.
- Location: not collected.
- Browsing activity and website content: processed locally when the user attaches a page or the agent runs a browser read tool. Selected content and browser-tool results enter the conversation and are sent to the selected model endpoint. **Ask for everything** (`always`) asks before reads; **Ask before acting** (`untrusted`) and **Act automatically** (`auto`) allow reads without a separate prompt.
- Browser writes and remote MCP tools: **Ask before acting** normally asks before a write or remote MCP call unless a matching session grant or saved allow rule applies. **Act automatically** can run them without a per-call prompt unless a rule or safety check forces ASK or DENY. **Ask for everything** asks for every browser and MCP tool call. Saved rules apply in all three modes.
- MCP data: tool parameters are sent to the configured MCP server and tool results return to the conversation, where they can be sent to the selected model. Server-supplied annotations such as `readOnlyHint` are treated only as untrusted descriptive metadata and do not by themselves bypass approval.
- Credentials: Provider keys and custom authorization headers are sent to the configured Provider endpoint, and MCP bearer/access tokens are sent to the configured MCP server. Credential-bearing Provider and MCP requests are sent directly to request URLs derived from the validated configuration; automatic HTTP redirects are refused. OAuth codes and refresh tokens are sent only to validated HTTPS authorization/token endpoints. OAuth authorization, code exchange, and refresh requests bind the canonical MCP server resource identifier. Credentials are protected in local extension storage as described in the privacy policy.
- Attachments: stored locally. For a user-uploaded file, the selected model receives its name, MIME type, size, and attachment identifier so it can reference the file through browser tools; the file bytes are not sent as a normal model attachment. Uploading those bytes to a website is a browser write and follows the active approval policy and rules.
- Data sale/sharing: Panelot's operator does not sell data or disclose it to unrelated third parties. User-requested transmissions to configured Provider/MCP endpoints are necessary to perform the request and are described above.
- Retention: local records remain until the user deletes them, clears extension data, or uninstalls Panelot. Exported copies are managed by the user. Remote endpoints apply their own retention policies.

Privacy URL: `https://wangdiandao.github.io/Panelot/en/privacy/`

## 简体中文

- 账户数据：Panelot 运营方不收集账户数据。
- 分析/遥测数据：不收集。
- 广告数据：不收集。
- 位置信息：不收集。
- 浏览活动和网站内容：当用户附加页面或 Agent 运行浏览器读取工具时在本地处理。所选内容和浏览器工具结果会进入对话，并发送到用户选择的模型端点。“全程询问”（`always`）会在读取前询问；“操作询问”（`untrusted`）和“自动操作”（`auto`）下，读取不会另行弹出审批。
- 浏览器写操作和远程 MCP 工具：“操作询问”通常会在写操作或远程 MCP 调用前询问，但已生效的会话授权或持久 allow 规则可以放行。“自动操作”可在没有逐次审批的情况下执行，除非规则或安全检查强制 ASK 或 DENY。“全程询问”会询问每次浏览器和 MCP 工具调用。三种模式都必须遵守已保存规则。
- MCP 数据：工具参数会发送到已配置的 MCP 服务器；工具结果返回对话，并可能继续发送到所选模型。服务器提供的 `readOnlyHint` 等 annotation 仅作为不可信描述信息，不能单独绕过审批。
- 凭据：Provider 密钥和自定义授权 Header 发送到已配置的 Provider 端点，MCP Bearer/access token 发送到已配置的 MCP 服务器。携带凭据的 Provider 和 MCP 请求会直接发送到根据已校验配置生成的请求 URL；自动 HTTP 重定向会被拒绝。OAuth code 和 refresh token 只发送到经过校验的 HTTPS 授权/token 端点。OAuth 授权、code 交换和 refresh 请求会绑定规范化的 MCP 服务器资源标识符。凭据按隐私政策所述方式保护在本地扩展存储中。
- 附件：存储在本地。对于用户上传的文件，所选模型只会收到文件名、MIME 类型、大小和附件标识，以便通过浏览器工具引用该文件；文件字节不会作为普通模型附件发送。把这些字节上传到网站属于浏览器写操作，遵循当前审批档位和规则。
- 数据出售/共享：Panelot 运营方不出售数据，也不向无关第三方披露数据。为完成用户请求而发送到已配置 Provider/MCP 端点的数据传输属于必要处理，具体如上所述。
- 数据保留：本地记录会保留到用户将其删除、清除扩展数据或卸载 Panelot。导出的副本由用户自行管理；远程端点适用其各自的数据保留政策。

隐私政策网址：`https://wangdiandao.github.io/Panelot/privacy/`
