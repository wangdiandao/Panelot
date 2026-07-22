---
title: Panelot 隐私政策
description: Panelot 浏览器扩展的隐私政策
outline: [2, 3]
---

# Panelot 隐私政策

生效日期：2026-07-10

Panelot 是本地优先的浏览器扩展，不运营 Panelot 账户服务、云同步服务、广告系统或遥测管道。

## 处理的数据

Panelot 在浏览器配置文件中保存会话、设置、Skills、Plugins、审批和附件。Provider API Key、MCP Bearer Token、OAuth Refresh Token 及敏感自定义 Header 使用本机加密；OAuth Access Token 仅保留在浏览器会话中。

当你要求 Panelot 调用模型时，提示词、相关会话历史、你选择的网页或文本上下文、用户上传文件的描述信息以及工具结果会直接发送到你配置的 Provider。用户上传文件的字节不会作为普通模型附件发送。启用 MCP Server 后，工具参数和相关结果会直接与该 Server 交换。第三方服务按其自身政策处理这些数据。

Panelot 仅在任务需要且浏览器授予访问权时读取或修改网站。网站 Host 权限为可选权限，并在运行时请求。如果你批准把本地文件上传到网站，文件字节会发送到该网站。网页内容和文件不会上传到 Panelot 运营的服务器。

## 共享与保留

Panelot 不出售个人数据，也不发送分析数据。本地记录会一直保留，直到你删除记录、清除扩展数据或卸载扩展。仅在你主动操作时创建导出文件。默认导出不包含秘密；含秘密备份使用 PBKDF2-SHA-256 与 AES-GCM 进行口令保护。

## 你的选择

你可以在浏览器扩展设置中撤销站点访问，停用或删除 Provider 与 MCP Server，删除会话和附件，导出不含秘密的数据，或卸载 Panelot。撤销第三方 Token 可能还需要前往对应服务的账户设置。

安全问题请按 Panelot 仓库中的 [`SECURITY.md`](https://github.com/wangdiandao/Panelot/blob/main/SECURITY.md) 私密报告。
