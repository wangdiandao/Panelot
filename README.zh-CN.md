<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot 图标" />

# Panelot

在 Chrome 和 Edge 中连接自己的模型服务，并让 Agent 在审批和权限规则内完成浏览器任务。

[English](./README.md) · [文档站](https://wangdiandao.github.io/Panelot/) ·
[用户指南](https://wangdiandao.github.io/Panelot/guide/) ·
[开发文档](https://wangdiandao.github.io/Panelot/development/) ·
[隐私政策](https://wangdiandao.github.io/Panelot/privacy/)

</div>

## 项目说明

Panelot 是本地优先的 Chrome/Edge MV3 扩展。你可以在侧边栏或全页界面中对话，明确引用网页、文本和文件，并让模型读取或操作浏览器。操作是否自动执行取决于权限模式、用户规则、敏感站点和待发送的数据。

Panelot 不提供账户、云同步或模型代理。会话、设置、审批、Skills、Plugins、记忆和附件保存在浏览器配置文件中。模型请求直接发送到你配置的 Provider；启用 MCP 后，工具参数和相关结果会与对应服务器交换。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [用户指南](https://wangdiandao.github.io/Panelot/guide/) | 安装、模型配置、对话上下文、浏览器权限、Skills、Plugins、MCP、备份和故障排查 |
| [开发文档](https://wangdiandao.github.io/Panelot/development/) | 架构、消息协议、存储、Provider、Agent 引擎、工具、安全、测试和发布流程 |
| [隐私政策](https://wangdiandao.github.io/Panelot/privacy/) | 本地存储、第三方数据流、数据保留和用户控制 |

中文文档是内容基准。英文站点使用同一页面结构，构建时会检查两种语言是否缺页。源码和测试与文档不一致时，以可执行实现为准。

## 安装

1. 从 [GitHub Releases](https://github.com/wangdiandao/Panelot/releases) 下载 Chrome 或 Edge ZIP。
2. 解压到长期保留的目录。
3. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择“加载已解压的扩展程序”。
4. 在“设置 → 模型”添加 OpenAI 兼容或 Anthropic 连接，运行连接验证，再选择默认模型。

升级、站点权限和首次测试步骤见[安装与首次配置](https://wangdiandao.github.io/Panelot/guide/getting-started)。

## 主要能力

- 连接 OpenAI 兼容和 Anthropic 流式接口，支持自定义 Header、多 Key 故障切换和端点验证。
- 引用打开的网页和 MCP Resource，上传文件，并管理可分支的对话历史。
- 读取和管理标签页，在页面中点击、输入、下载或截图；必要时按权限策略使用 CDP。
- 导入单文件 `SKILL.md`，安装经过校验的数据型 Plugin，并连接远端 Streamable HTTP MCP Server。
- 持久化 Run、队列和审批，在 Service Worker 重启后恢复可安全继续的工作。

浏览器工具、权限顺序和恢复边界见[开发文档](https://wangdiandao.github.io/Panelot/development/)。

## 数据边界

网站权限按 origin 在需要时申请，可以在浏览器中撤销。凭据加密保存在扩展本地，以降低明文浏览和意外导出的风险；这不能抵御能够读取浏览器配置文件或以当前用户身份执行代码的攻击者。

Panelot 不运营遥测或广告系统。你选择的上下文会发送到自己的模型 Provider，远端 MCP 调用会与相应服务器交换数据。完整说明见[数据与隐私](https://wangdiandao.github.io/Panelot/guide/data-and-privacy)和[隐私政策](https://wangdiandao.github.io/Panelot/privacy/)。

## 当前限制

- 构建目标为 Chrome 116 或更高版本上的 Chrome/Edge MV3，不提供 Firefox 或 Safari 构建。
- MCP 只支持远端 Streamable HTTP，不支持本地 stdio Server。
- Plugin 只能包含经过校验的只读数据资产，不能运行远程代码。
- Skill 按单个 `SKILL.md` 导入，不会自动取得依赖目录。
- Provider 名称不能证明端点兼容。请先验证连接，再用所选模型发送真实请求。

## 开发

需要 Node.js `^20.19.0 || >=22.12.0`、pnpm 9.12.3 和 Chrome 116 或更高版本。

```bash
pnpm install
pnpm dev
pnpm compile
pnpm lint
pnpm test
pnpm docs:build
pnpm build
```

完整命令、测试边界和发布要求见[开发指南](https://wangdiandao.github.io/Panelot/development/)。

## 许可证

[MIT](./LICENSE)
