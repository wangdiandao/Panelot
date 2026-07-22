# Chats and context

## Side panel and full-page chat

Click the Panelot toolbar icon or press `Alt+P` to open the side panel. It is suited to quick questions about the current page. Select the expand button or press `Ctrl/Cmd+E` to open the same conversation in full-page chat.

Full-page chat includes the conversation list, search, pin, rename, and delete controls. Deleted conversations cannot be recovered. A new-conversation draft is not written to history until its first message is submitted successfully.

The side panel remembers the last valid conversation. After the browser or panel is reopened, it restores that conversation when possible and otherwise falls back to the most recent valid one.

## Send, steer, and queue

- `Enter`: send. `Shift+Enter`: insert a line break.
- Press `Enter` while a task is running: steer before the next model call. If the current step cannot accept steering, the message is queued.
- `Shift+Alt+Enter`: add the message to the queue for the end of the current turn.
- `Esc`: stop the current turn.
- `Up Arrow` in an empty composer: restore the previous input.

Stopping a task or closing the interface may not undo an operation already sent to a website or remote service. Panelot does not repeat a write whose result is unknown. It asks you to inspect and resolve the outcome.

## Reference pages and other context

Panelot does not add every open page to the model context. Select content explicitly:

- Type `@` to choose an open ordinary web page or a Resource from a connected MCP server.
- Select `+` to upload a file, reference an open tab, or choose an enabled Skill.
- On the current-page prompt in the side panel, select Attach to chat to create a page-context chip.
- Type <code v-pre>{{</code> to insert a variable evaluated at send time, including the current URL, title, selection, clipboard, or date.

For a page reference, Panelot extracts a size-limited form of the main readable text. Long content is truncated. Navigation, scripts, footers, and some embedded content may be omitted. Ask Panelot to read the page when the task needs more structure.

Browser actions in the current turn default to the captured active web tab, but this does not send the page text to the model. Referencing another tab also does not activate that tab in the browser.

## Files, pasted text, and screenshots

One uploaded file can be at most **8 MB**. A new chat must receive its first message before it can persist files.

After upload, the model sees the file name, type, size, and attachment ID. A browser upload tool can select that file. Panelot does not parse the file body or send its bytes as a normal model attachment. Paste the relevant text into the context if the model needs to analyze it.

Pasting more than 2,000 characters into the composer creates a separate context chip. Hold `Shift` while pasting to keep it as ordinary message text.

Page screenshots and extracts may also be stored as attachments. Review or delete them under Settings > Attachments. Deleting an attachment leaves its historical message in place but marks the file unavailable. Data JSON exports do not include attachment bytes. See [Data and privacy](./data-and-privacy.md).

## Skills and slash commands

Type `/` to choose an enabled Skill command, a Prompt from a connected MCP server, or a built-in command provided by the current interface.

A command with parameters opens a form first. Skill and MCP Prompt output is attached to the current message. It does not bypass browser permissions or authorize an external action.

## Edit, regenerate, and branch

Editing a sent user message or regenerating an assistant response creates a branch instead of overwriting the original. Use the branch control beside a message to switch results. Branch operations are disabled while a task is running.

The original path remains stored. Future model context follows the currently selected branch.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+P` | Open or close the side panel |
| `Ctrl/Cmd+K` | Open the command palette |
| `Ctrl/Cmd+N` | Create a conversation |
| `Ctrl/Cmd+,` | Open settings from full-page chat |
| `Ctrl/Cmd+E` | Switch between side panel and full-page chat |
| `Ctrl/Cmd+Shift+S` | Collapse or expand the full-page conversation list |
| `?` | Open shortcut help |
| `Ctrl/Cmd+Shift+C` | Copy the last response |

Approval cards use `Y / S / A / N`. See [Browser actions and permissions](./browser-and-permissions.md).
