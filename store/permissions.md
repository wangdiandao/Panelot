# Permission rationale

## English

| Permission                          | Purpose                                                                                                                                                                                           | User control                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sidePanel`                         | Hosts the task UI beside the current page.                                                                                                                                                        | Opened by the toolbar button or shortcut.                                                                                     |
| `storage`, `unlimitedStorage`       | Stores local chats, attachments, settings, encrypted credentials, and saved task state.                                                                                                           | Data can be inspected/exported/deleted in Settings.                                                                           |
| `tabs`, `activeTab`, `scripting`    | Finds the active tab and injects the page executor for approved operations.                                                                                                                       | Page access remains subject to host permission and approval policy.                                                           |
| `debugger`                          | Performs advanced browser debugging operations such as browser-level keyboard/mouse input, accessibility/DOM inspection, and full-page capture when standard in-page operations are insufficient. | Advanced browser debugging operations are identified in the approval UI; Chrome displays its debugger banner.                 |
| `downloads`                         | Saves files explicitly requested by the user or agent.                                                                                                                                            | Each write operation is checked by the approval policy.                                                                       |
| `identity`                          | Runs user-initiated Chrome OAuth for configured MCP servers.                                                                                                                                      | OAuth starts only from Settings.                                                                                              |
| `notifications`                     | Reports pending approvals and paused tasks.                                                                                                                                                       | Notifications can be disabled in browser settings.                                                                            |
| `offscreen`                         | Hosts browser-compatible MCP SDK sessions outside the suspendable service worker.                                                                                                                 | Created only when an enabled MCP server connects; it has no visible UI and does not directly read or modify web page content. |
| `clipboardWrite`                    | Copies user-requested output.                                                                                                                                                                     | Used only for explicit copy actions.                                                                                          |
| `alarms`, `contextMenus`, `favicon` | Schedules housekeeping, exposes extension actions, and displays website icons to help identify target tabs.                                                                                       | No remote scheduling or tracking.                                                                                             |
| Optional `<all_urls>`               | Allows access to a provider, MCP server, or web origin selected by the user.                                                                                                                      | Requested separately for each origin after a user action and revocable at any time.                                           |

Panelot declares no permanent host permissions.

## 简体中文

| 权限                                | 用途                                                                                                       | 用户控制                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sidePanel`                         | 在当前页面旁承载任务界面。                                                                                 | 由工具栏按钮或快捷键打开。                                                      |
| `storage`, `unlimitedStorage`       | 在本地存储聊天记录、附件、设置、加密凭据及已保存的任务状态。                                               | 可在“设置”中查看、导出或删除数据。                                              |
| `tabs`, `activeTab`, `scripting`    | 查找当前活动标签页，并为已获批准的操作注入页面执行器。                                                     | 页面访问仍受主机权限和审批策略约束。                                            |
| `debugger`                          | 当页面内标准操作不足时，执行高级浏览器调试操作，例如浏览器级键盘/鼠标输入、无障碍功能/DOM 检查和整页截图。 | 审批界面会标明高级浏览器调试操作；Chrome 会显示调试器横幅。                     |
| `downloads`                         | 保存用户或 Agent 明确要求下载的文件。                                                                      | 每次写操作均由审批策略检查。                                                    |
| `identity`                          | 为已配置的 MCP 服务器执行由用户发起的 Chrome OAuth 授权流程。                                              | OAuth 只能从“设置”中启动。                                                      |
| `notifications`                     | 提醒用户有待处理的审批事项和已暂停的任务。                                                                 | 可在浏览器设置中禁用通知。                                                      |
| `offscreen`                         | 在可挂起的 Service Worker 之外承载与浏览器兼容的 MCP SDK 会话。                                            | 仅在已启用的 MCP 服务器连接时创建；它没有可见界面，也不直接读取或修改网页内容。 |
| `clipboardWrite`                    | 复制用户要求的输出内容。                                                                                   | 仅用于明确的复制操作。                                                          |
| `alarms`, `contextMenus`, `favicon` | 安排内部维护任务、提供扩展操作入口，并显示网站图标以帮助识别目标标签页。                                   | 不用于远程调度或跟踪。                                                          |
| 可选的 `<all_urls>`                 | 允许访问用户选择的模型提供商、MCP 服务器或网页源站（origin）。                                             | 由用户操作触发，按源站分别请求，并可随时撤销。                                  |

Panelot 未声明任何永久性主机权限。
