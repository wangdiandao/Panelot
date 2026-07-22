# UI

> Related: [Architecture](./architecture.md) for event-driven rendering and [Permissions](./permissions.md) for approval semantics.

Panelot has a side panel, full-page chat, shared message stream and composer, and eleven settings sections. Queue editing, recovery cards, attachments, site instructions, model presets, Plugins, MCP Prompts and Resources, and interaction cards are connected. Skill automatic-suggestion chips and a complete performance-diagnostics UI are not.

## 1. Design tokens

`src/ui/styles/global.css` is authoritative. Indigo is the brand color. Amber denotes warnings and approvals, cyan denotes tool activity and L2 information, and green or red denote success or destructive states. Neutral colors have a slight indigo hue.

Light-theme status text uses darker shades for WCAG contrast, while dark-theme text uses lighter shades. `--ring` follows `--primary`. UI and monospaced fonts, card and input radii, the 4 px spacing unit, and text scales are defined as CSS variables.

Themes support system, light, and dark modes through the same semantic variables. Animation is limited to streaming cursor, short status transitions, and approval-card entry. Decorative animation is avoided.

## 2. Shared component tree

`ThreadView` is shared by side-panel and full-page chat. It contains a virtualized `MessageStream`, user and assistant messages, ordered reasoning and Tool groups, final Markdown, citations, branch controls, approval and interaction cards, notices, and `PromptInput`.

`ToolResult.content` renders model-facing text. `details` renders snapshot, screenshot, diff, and other rich viewers. The final answer stays outside the collapsible activity timeline.

## 3. Layouts

### 3.1 Full-page chat

At 1024 px or wider, full-page chat uses a resizable conversation sidebar and a centered content column capped at 768 px. At narrower widths, the conversation list moves into a left Sheet. Header layout keeps the conversation title centered while model and navigation controls remain accessible.

The list groups by update time and shows pin, unread, running, and approval states. Search first checks 200 recent titles, then scans message bodies for up to 50 recent title misses. It is not a Dexie full-text index. Row actions support rename, pin, and delete. Folders, move, archive, and per-conversation export are not connected.

### 3.2 Side panel

The 360 to 500 px side panel uses dynamic viewport height, a fixed header, scrollable message area, and persistent composer. Horizontal overflow is locked. Model and permission controls may scroll within their toolbar, while send or stop remains visible.

The composer grows with wrapped text until a `42dvh / 16rem` side-panel cap or `45dvh / 20rem` full-page cap, then scrolls internally. Long unbroken strings can wrap anywhere.

Panelot stores the last selected valid Thread. On reopen it verifies that the Thread still exists, is not archived, and is not deleting. It otherwise selects the most recently updated valid Thread or a non-persisted draft. A protocol mismatch stops reconnect loops, disables input, and asks the user to reload the extension.

`Ctrl/Cmd+E` moves the current conversation between side panel and full-page chat. It avoids leaving both forms open in one window after a successful switch.

### 3.3 Onboarding

Onboarding selects a connection template and API key, runs inline verification, selects a default permission mode, and presents a page-summary task. It can be skipped. Without a usable model connection, an empty chat keeps showing onboarding. Existing history remains readable, but an Add model action replaces the composer.

### 3.4 Settings

Navigation contains Attachments, Sites, Presets, General, Models, Browser permissions, Skills, Plugins, MCP servers, Data, and About.

Model settings manage connections, verification results, compatibility options, manual models, and one valid default. Permission settings manage the three policies, rule table, and user sensitive origins. MCP settings show connection and Tool state, OAuth controls, JSON import, and removal. Data import performs a background preflight, requires explicit confirmation for active or paused state, commits on a second action, and requires extension reload.

About shows the manifest version and can check the latest GitHub Release. When an update is available, it links to the ZIP for the current browser. Developer-mode installations still require replacing the existing files and reloading the extension from the browser's extension page.

## 4. Interaction states

### 4.1 Streaming

An unclosed code fence renders as plain preformatted text until complete. Mermaid and KaTeX render only after a complete block and fall back to code on failure. Automatic scrolling stops after the user scrolls up and shows a return-to-bottom control. Completion replaces the draft with the final message; an error retains partial content with retry when appropriate.

### 4.2 Tool cards

Cards move from pending to running and then success or failure. Three or more consecutive tools collapse into a group summary. The active card remains visible. Expanded content shows monospaced parameters, model-facing result text, and rich details.

Reasoning, tools, intermediate text, and the final response remain in one assistant message in arrival order. Only genuinely consecutive tools form a group.

### 4.3 Approval cards

An approval action bar replaces the composer and takes focus. It keeps the target, risk summary, and primary decisions compact, while full parameters expand on demand. `Y`, `S`, `A`, and `N` mean allow once, browser session, always on site, and deny. `Esc` denies and stops. Several approvals show a queue position. A five-minute timeout closes as denied.

### 4.4 User questions

`ask_user` temporarily replaces the composer with one structured question at a time, numbered single-column options, recommendation marker, progress, navigation, and free-form input. Other interaction types remain above the normal composer.

### 4.5 Run and stop

Send becomes Stop during a task. `Enter` steers and falls back to queueing with a notice when steering is unavailable. `Shift+Alt+Enter` queues explicitly. The queue chip supports update and removal.

## 5. Triggers and variables

`@` references scriptable tabs and MCP Resources. `/` selects enabled Skills and MCP Prompts, with a form when parameters exist. <code v-pre>{{</code> completes `PAGE_URL`, `PAGE_TITLE`, `SELECTION`, `CLIPBOARD`, and `CURRENT_DATE` at submission.

The `+` menu attaches the current page, another tab, or a user file. A draft must become a persisted Thread through its first message before file upload. Upload tools accept only user-provenance attachments from the current Thread.

## 6. Keyboard shortcuts

`src/ui/shortcuts.ts` is authoritative. Main shortcuts are `Alt+P` for side panel, `Ctrl/Cmd+K` for commands, `Ctrl/Cmd+N` for a new conversation, `Ctrl/Cmd+,` for settings, `Ctrl/Cmd+E` for panel or page switching, `Ctrl/Cmd+Shift+S` for the conversation list, `?` for help, `Ctrl/Cmd+Shift+C` to copy the last response, and `Shift+Esc` to focus the composer.

Composer controls use Enter, Shift+Enter, Shift+Alt+Enter, Esc, and Up Arrow. Approval keys are reserved and cannot be rebound.

## 7. Empty, error, and loading states

An empty conversation shows up to four page-aware suggestions that prefill but do not send. A missing provider links directly to model settings. Provider errors use normalized categories and show retry only when safe. Conversation loading uses message-shaped skeletons, and engine handshake shows a reconnecting state.

## 8. i18n and accessibility

Extension strings use `src/ui/i18n.ts` with Chinese and English keys. The extension's default language is Chinese unless `global_settings.language` says otherwise; it does not infer browser language. This setting is separate from the VitePress documentation locale.

Approval and Tool cards have accessible names and keyboard navigation. Status includes icons and text, not color alone. Contrast targets WCAG AA.

## 9. Current constraints

Mermaid selects its light or dark built-in theme at render time. Long messages use react-virtuoso and `followOutput`. Tool cards use one responsive layout because their labels truncate safely at the minimum side-panel width.
