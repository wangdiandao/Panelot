# Browser tools

> Related: [Agent engine](./agent-engine.md), [Permissions](./permissions.md), and [Prompts](./prompts.md).

All browser, built-in, interaction, and MCP tools enter the engine through one `ToolRegistry` boundary. A tool declares its schema, level, effects, recovery class, result trust and provenance, and execution binding once. Provider schemas, approvals, and recovery snapshots derive from that descriptor.

## 1. L1 page snapshot

### 1.1 Format

The snapshot is an indented accessibility tree. A node can include role, accessible name, state, and a ref such as `s{documentNonce}_{snapshotId}_{nodeIndex}`.

```yaml
# Page Snapshot (sk4m9z_3)
URL: https://example.com/login
Title: Sign in - Example

- heading "Sign in" [level=1]
- form "Sign-in form" [ref=sk4m9z_3_1]
  - textbox "Email" [value="user@example.com"] [ref=sk4m9z_3_2]
  - textbox "Password" [type=password] [ref=sk4m9z_3_3]
  - button "Sign in" [ref=sk4m9z_3_4]
```

The document nonce is stable only for the current content-script document. The snapshot ID increases within that document. A ref from another document, old protocol, replaced frame, or invalid generation returns `stale_ref`.

ActionRunner attempts one strict recovery only for an older generation with the same document nonce and a unique match on role, name, tag, type, label, and placeholder. It does not match current value. The in-memory ref map is replaced by every snapshot and is never persisted.

Same-origin iframe refs retain the frame and document chain. Geometry conversion accounts for borders, scrolling, nesting, and axis-aligned scaling. Rotation, skew, 3D, mirroring, or ambiguous padding returns `unsupported_frame` rather than using approximate coordinates for a write.

### 1.2 Interactive detection

A node receives a ref when it has an interactive element or role, non-negative `tabindex`, `contenteditable`, an innermost `cursor:pointer` target, or an L2-discovered click, mouse, or key listener. Parent and child click chains collapse to the innermost actionable target. Detection favors recall, while snapshot limits control size.

### 1.3 Size

Snapshots retain all visible nodes and offscreen interactive nodes, with a target of 3,000 tokens. Truncation starts with offscreen non-interactive text and reports the omitted count. After an action, Panelot returns a new snapshot of about 1,500 tokens, a line diff, and current interactive refs.

### 1.4 Perception fallback

```text
L1 DOM traversal
  -> empty or failed: CDP Accessibility.getFullAXTree
  -> still unavailable: screenshot and vision coordinates
```

Every failure is explicit. An empty tree is not reported as success.

## 2. L1 and L2 responsibilities

L1 handles DOM snapshots, readable text, actionability checks, synthetic click and type, selection, scrolling, and content extraction. A clearly failed synthetic type can request one `type_trusted` call. Automatic escalation creates another stable tool call that passes Gatekeeper and target validation again.

L2 handles CDP accessibility reads, cross-origin frames, accessible closed-shadow controls, trusted keys and pointer input, coordinates, drag, and screenshots. `read_page_deep` also samples a bounded set of non-accessibility candidates for event listeners.

Deep refs use `c{managerNonce}_{tabEpoch}_{generation}_{nodeIndex}` and bind tab, session, frame, loader, and root-document identity. Navigation, frame detach, debugger detach, manager restart, tab replacement, or failed identity checks returns `stale_ref` before a DOM or input write.

The debugger attaches to one tab at a time and detaches after 30 seconds of inactivity. It does not detach immediately at Turn completion.

## 3. Tool catalog

Every page, navigation, and screenshot tool accepts optional `tabId`. Without it, the tool uses the web tab captured when the user submitted the message. Changing the foreground tab later does not change this default. Results identify their source as `[tabId=N]`.

### L0 tab and browser data tools

| Tool | Effects | Purpose |
| --- | --- | --- |
| `tabs_list` | read | List tabs across all windows and identify the visible one |
| `tab_open`, `navigate`, `go_back`, `go_forward` | write | Open or navigate an explicit or default tab |
| `tab_focus`, `tab_close` | write | Change the visible tab or close an explicit tab |
| `history_search`, `bookmarks_search`, `top_sites` | read | Read browser metadata, not page bodies |
| `sessions_recently_closed`, `session_restore` | read or write | Inspect or restore closed tabs and windows |
| `tab_groups_list`, `tabs_group`, `tab_group_update` | read or write | Inspect and manage tab groups |

Background operations do not activate a tab. Only `tab_focus` changes the visible page. If an action opens a child tab, the result reports `tab_created` and updates the Turn's default route. `batch_actions` stops before reusing old refs after a new browsing context opens.

### L1 perception and interaction

| Tool | Effects | Main inputs |
| --- | --- | --- |
| `read_page`, `find_in_page`, `get_selection` | read | Mode, query, or no arguments |
| `click`, `hover` | write | Human-readable element and exact ref |
| `type`, `select_option`, `press_key` | write | Ref plus text, values, or key |
| `scroll`, `wait_for`, `extract` | read | Target, condition, range, or scope |
| `batch_actions` | write | Up to four click, type, or selection actions |
| `run_javascript` | write | Main-world code; denied by the initial default rule |

A write patches page dialogs only for that call. `confirm` cancels, `prompt` returns `null`, and `alert` closes. Dispatch occurs only after patch installation succeeds. Cleanup restores the original functions and reports a recovery error if restoration continues to fail.

`extract` converts the page or one ref subtree to Markdown without another model call. Content script output is capped at 200,000 characters. The engine gives the model 8,000 characters at a time and supports `fromChar`. Longer content can be saved as a `page_text` attachment for UI access.

### L2 advanced tools

| Tool | Effects | Purpose |
| --- | --- | --- |
| `read_page_deep` | read | Read cross-frame and closed-shadow accessibility structure |
| `screenshot` | read | Capture viewport, full page, or ref region |
| `click_trusted`, `type_trusted`, `press_key` | write | Dispatch trusted CDP input |
| `click_xy`, `drag` | write | Use model-provided coordinates |
| `upload_file` | write | Assign a user-provided attachment to a file input |

An `escalation_l2` flag appears only when another policy condition already asks about an L2 write. L2 itself is not an unconditional approval requirement.

### Built-in and interaction tools

Built-ins include `fetch_url`, memory read and write, `load_skill`, download, artifact creation, and the interaction tools `ask_user`, `request_user_action`, `watch_page`, and `schedule_resume`.

Interaction tools move the Run to `waiting_interaction` and persist the request. Page watching still requires target access and Gatekeeper approval. Credential, payment, verification-code, and human-verification steps use `request_user_action` and never return the secret itself.

## 4. Waiting and stability

Write tools wait for a minimum delay, DOM quiet period, and bounded network idle when CDP tracking is available. Long-lived connections do not block forever. Details report whether the network settled. `wait_for` supports text appearing, text disappearing, or a bounded timer.

Actions check visibility, attachment, viewport, enabled state, and event obstruction before dispatch. They return structured `precheck`, `dispatch`, `verify`, `stale_ref`, or recovery failures.

## 5. Action visualization

The page executor shows a short-lived highlight and label for a dispatched action. UI-only coordinates and screenshot data travel through `ToolResult.details`, not model context.

## 6. Multi-tab routing

Explicit `tabId` is the stable routing contract. A target that closes or changes identity is not replaced with the active tab. Gatekeeper resolves and records target identity before approval and verifies tab, frame, origin, rules, and host access again before dispatch.

## 7. Tool-result limits

Tool output is bounded before entering the protocol or model context. Large extracts page through text ranges or store UI attachments. MCP and page content remain untrusted and are wrapped with provenance-aware boundaries.

## 8. Current constraints

Canvas and inaccessible DOM still require screenshots and a vision-capable model. Automatic trusted escalation is limited to a clearly failed synthetic type. Upload uses the content script and `DataTransfer`, not `DOM.setFileInputFiles`.
