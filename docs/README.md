# Panelot 文档

这里记录 Panelot 当前的运行方式、开发流程和设计约束。文档会解释实现，但不会替代源码：协议以
`src/messaging/protocol.ts` 为准，存储以 `src/db/` 为准，界面文案以 `src/ui/i18n.ts` 为准，行为变更
还应由测试覆盖。

## 从哪里开始

| 你想了解 | 建议先读 |
| --- | --- |
| 本地开发、测试与发布 | [开发指南](./development.md) |
| Service Worker、UI 与消息协议 | [01 架构与消息协议](./01-architecture.md) |
| Agent 如何调用模型和工具 | [04 Agent 引擎](./04-agent-engine.md) |
| 浏览器操作与可用边界 | [05 浏览器工具](./05-browser-tools.md) |
| 审批、规则与敏感站点 | [06 权限与安全](./06-permissions.md) |
| 用户界面与快捷键 | [09 界面](./09-ui.md) |

## 运行时契约

1. [架构与消息协议](./01-architecture.md)：扩展上下文、Thread/Turn/Item 与 Port 协议。
2. [数据模型与存储](./02-data-model.md)：Dexie 表、会话树、附件和清理边界。
3. [Provider](./03-providers.md)：连接、模型、参数、流式协议、Verify 与错误分类。
4. [Agent 引擎](./04-agent-engine.md)：Agent loop、队列、插话、审批挂起和恢复。
5. [浏览器工具](./05-browser-tools.md)：页面快照、L0/L1/L2 工具、tab 路由和动作证据。
6. [权限与安全](./06-permissions.md)：三种权限模式、规则表、Gatekeeper 与不可信内容边界。
7. [远端 MCP](./07-mcp.md)：Streamable HTTP、OAuth、Tool/Prompt/Resource 和不支持项。
8. [Skills 与 Plugins](./08-skills-plugins.md)：单文件 Skill、斜杠命令和数据型 Plugin。
9. [界面](./09-ui.md)：侧边栏、全页对话、设置页、状态机、快捷键和 i18n。
10. [提示词](./10-prompts.md)：系统提示词的拼装顺序、工具说明和内容定界。

## 调研与目标

- [参考项目](./11-references.md)是 2026 年 7 月的设计调研记录。上游项目会变化，引用其中的比较前要
  重新核对。
- [体验目标与验证边界](./12-experience-targets.md)列出尚需测量的目标。表中的百分比和延迟不是已经
  达成的承诺。

## 面向用户的说明

- [隐私政策](./privacy-policy.md)
- [商店权限说明](../store/permissions.md)
- [商店数据披露](../store/data-disclosure.md)
- [更新记录](../CHANGELOG.md)

发现文档与代码不一致时，先核对当前源码和测试，再一起修正文档。不要把目标设计写成已经上线的行为。
