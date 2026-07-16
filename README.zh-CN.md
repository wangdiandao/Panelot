<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot 图标" />

# Panelot

一款运行在 Chrome 和 Edge 中的 AI Agent 扩展。连接你正在使用的模型服务，把网页或文件交给
Agent，并在浏览器操作发生时查看和审批。

[English](./README.md) · [文档目录](./docs/README.md) ·
[开发指南](./docs/development.md) · [更新记录](./CHANGELOG.md)

</div>

## Panelot 能做什么

Panelot 直接在浏览器中运行，不依赖 Panelot 自己的服务器。会话、设置、审批、Skills、Plugins、
记忆和附件都保存在扩展的本地存储中。

- 连接 OpenAI 兼容或 Anthropic 接口，使用你自己的 Key。连接支持端点验证、自定义请求头、多 Key
  故障切换和请求诊断。
- 读取并操作多个标签页，包括可访问性快照、点击、输入、下载和截图。页面内操作不够用时，可以按需
  使用 CDP。
- 加载 `SKILL.md` 指令，安装经过校验的数据型 Plugin，并通过 Streamable HTTP 接入远端 MCP 的
  Tool、Prompt 和 Resource。
- 持久化 Run、队列和审批。Service Worker 重启后，只读或可安全重试的步骤可以恢复；结果不明的
  写操作会停下来等待用户判断。

浏览器操作会经过当前权限模式和已保存规则。敏感站点的写操作仍会被拦截；CDP 操作在执行前会明确
标出，连接期间 Chrome 也会显示调试器横幅。

## 安装与首次配置

1. 从 [GitHub Releases](https://github.com/wangdiandao/Panelot/releases) 下载 Chrome 或 Edge
   压缩包。
2. 解压到一个长期保留的目录。
3. 打开 `chrome://extensions` 或 `edge://extensions`，开启**开发者模式**，选择
   **加载已解压的扩展程序**，然后选中解压目录。
4. 打开 **设置 → 模型**，添加 OpenAI 兼容或 Anthropic 连接，运行 **Verify**，再选择默认模型。

输入框中的 `+` 用来添加当前页面或文件，`@` 用来引用打开的标签页或 MCP Resource，`/` 用来运行
Skill 或 MCP Prompt。标题等后台任务使用的模型可以在 **设置 → 预设** 中单独选择。

## 数据会发到哪里

Panelot 不提供账户、应用后端、云同步、广告或遥测。你选入对话的上下文会直接发往自己配置的模型
服务；MCP 参数和结果会与已启用的 MCP 服务器交换。网站权限按 origin 在需要时申请，也可以随时在
浏览器中撤销。

凭据会加密保存在扩展本地。这样可以避免直接浏览和意外导出，但无法抵御能读取浏览器配置文件或以
当前用户身份执行代码的攻击者。完整数据流见 [隐私政策](./docs/privacy-policy.md) 和
[权限说明](./store/permissions.md)。

## 当前限制

- 构建目标是 Chrome 116 或更高版本上的 Chrome/Edge MV3；不构建 Firefox 或 Safari 版本。
- MCP 只支持远端 Streamable HTTP，不支持本地 stdio Server。
- Plugin 只能包含经过校验的只读数据资产，不能运行远程代码。
- Skill 以单个 `SKILL.md` 文件导入，不会一并导入 `scripts/`、`references/` 等附属目录。
- Provider 名称不能证明端点兼容。请先运行 **Verify**，再用所选模型发起一次真实请求。

## 文档

[文档目录](./docs/README.md) 区分了当前运行时契约、开发流程、历史设计调研和尚未验证的体验目标。
如果文档与实现不一致，以源码和测试为准。

## 开发

需要 Node.js **20.19 或更高版本**、pnpm 9.12.3，以及 Chrome 116 或更高版本。

```bash
pnpm install
pnpm dev
pnpm compile
pnpm lint
pnpm format:check
pnpm test
pnpm e2e
pnpm build
pnpm build:edge
pnpm budget
```

修改引擎代码后，需要到 `chrome://extensions` 重载 Panelot；刷新网页不会重启 MV3 Service Worker。
发布压缩包使用 `pnpm zip` 和 `pnpm zip:edge`。目录结构、验证与发布流程见
[开发指南](./docs/development.md)。

## 许可证

[MIT](./LICENSE)
