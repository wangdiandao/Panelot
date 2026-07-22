---
title: Panelot
description: 在 Chrome 和 Edge 中使用自己的模型服务完成对话与浏览器任务
outline: [2, 3]
---

# Panelot

Panelot 是运行在 Chrome 和 Edge 中的 AI Agent 扩展。你可以连接自己的 OpenAI 兼容或 Anthropic 服务，在侧边栏或全页界面中对话，并把网页、文本和文件作为任务上下文。浏览器操作会经过权限策略和审批规则。

Panelot 不提供账户、云同步或自有模型代理。会话、设置、审批、Skills、Plugins、记忆和附件保存在当前浏览器配置文件中。模型请求直接发送到你配置的 Provider；启用 MCP 后，工具参数和相关结果会与对应的远端服务器交换。

## 选择文档

| 入口 | 适合谁 | 内容 |
| --- | --- | --- |
| [用户指南](./guide/) | 安装和使用 Panelot 的用户 | 安装、模型连接、对话上下文、浏览器权限、Skills、Plugins、MCP、数据管理和故障排查 |
| [开发文档](./development/) | 贡献者和审查实现的开发者 | 架构、协议、存储、Provider、Agent 引擎、工具、安全、测试和发布流程 |
| [隐私政策](./privacy/) | 所有用户 | 本地存储、第三方数据流、保留期限和用户控制 |

## 安装

1. 从 [GitHub Releases](https://github.com/wangdiandao/Panelot/releases) 下载 Chrome 或 Edge ZIP。
2. 解压到长期保留的目录。
3. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择“加载已解压的扩展程序”。
4. 在“设置 → 模型”添加连接，运行连接验证，再选择默认模型。

完整步骤和升级注意事项见[安装与首次配置](./guide/getting-started.md)。

## 当前能力

- 连接 OpenAI 兼容和 Anthropic 流式接口，支持自定义请求头、多 Key 故障切换和连接验证。
- 引用打开的网页和 MCP Resource，管理对话分支，并使用附件描述信息完成浏览器上传任务。
- 读取和操作标签页，在网页中点击、输入、下载或截图；必要时按权限策略使用 CDP。
- 加载单文件 `SKILL.md`，安装经过校验的数据型 Plugin，并连接远端 Streamable HTTP MCP Server。
- 持久化 Run、队列和审批。Service Worker 重启后，只读或可安全重试的步骤可以恢复；结果不明的写操作等待用户判断。

具体操作方式见[用户指南](./guide/)。实现边界和事实来源见[开发文档](./development/)。

## 数据和权限

网站访问按 origin 在需要时申请，可以在浏览器中撤销。普通操作是否自动执行取决于当前权限模式、用户规则、敏感站点和待发送内容。密码、验证码、付款和真人验证应由用户接管。

凭据会加密保存在扩展本地，以降低明文浏览和意外导出的风险。这不能抵御能够读取浏览器配置文件或以当前用户身份执行代码的攻击者。数据发送范围和删除方式见[数据与隐私](./guide/data-and-privacy.md)及[隐私政策](./privacy/)。

## 当前限制

- 构建目标为 Chrome 116 或更高版本上的 Chrome/Edge MV3，不提供 Firefox 或 Safari 构建。
- MCP 只支持远端 Streamable HTTP，不支持本地 stdio Server。
- Plugin 只能包含经过校验的只读数据资产，不能运行远程代码。
- Skill 按单个 `SKILL.md` 导入，不会自动取得 `scripts/`、`references/` 或其它依赖目录。
- Provider 名称不能证明端点兼容。保存连接前应运行验证，并用所选模型发送一次真实请求。

## 开发

开发需要 Node.js `^20.19.0 || >=22.12.0`、pnpm 9.12.3 和 Chrome 116 或更高版本。

```bash
pnpm install
pnpm dev
pnpm compile
pnpm lint
pnpm test
pnpm docs:build
pnpm build
```

仓库结构、完整验证矩阵和发布要求见[开发指南](./development/)。源码和测试与文档不一致时，以可执行实现为准。

## 许可证

Panelot 使用 [MIT License](https://github.com/wangdiandao/Panelot/blob/main/LICENSE)。
