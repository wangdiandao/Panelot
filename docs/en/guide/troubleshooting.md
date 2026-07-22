# Troubleshooting

## Model connection verification fails

Follow the failure category shown in the UI:

1. **Network or unreachable**: check the base URL, proxy, DNS, HTTPS certificate, and browser access to the endpoint origin.
2. **Invalid or unauthorized key**: confirm the key has not expired and can access the selected API and model.
3. **Protocol error**: make sure OpenAI-compatible and Anthropic types are not reversed. Check `/v1`, custom headers, and compatibility options against service documentation.
4. **Tool-call failure**: some OpenAI-compatible endpoints support text but not structured tool calls. They may work for chat and still be unsuitable for browser-agent tasks.
5. **Empty model list**: enter exact model IDs manually, one per line, and choose a default model.

If verification succeeds but a real request fails, a model, parameter, context-size, or streaming detail differs. Test a short message with no attachments and default parameters, then restore settings one at a time.

## The endpoint returned an incompatible response

The stream may have ended incorrectly, tool arguments may be invalid, or the server may have returned an unsupported finish reason. Check the API type, compatibility options, and upstream logs. Panelot does not treat an interrupted response as complete or replay the request automatically.

## A page cannot be referenced, read, or operated

- Confirm the target is an ordinary `http://` or `https://` page. Browser pages, extension stores, and other protected pages cannot be accessed by normal extension scripts.
- Refresh the page after updating or reloading Panelot. An old page may still contain an outdated content script.
- Check Panelot's extension details and confirm that access to the target origin has not been revoked.
- A page with Canvas, cross-origin frames, closed components, or dynamic loading may yield little readable text. Ask Panelot to read again or use a screenshot. Complete critical steps manually if the result remains unreliable.
- If the target changes during a task, Panelot rejects the stale target. Read the page again before acting.

Seeing a page title in the side panel does not attach its content. Select Attach to chat or choose it from the `@` menu.

## A click or input may have happened before an error

The page channel can disconnect after dispatch and before the result returns. Panelot marks that outcome as uncertain instead of repeating the action. Inspect the page and choose completed, retry, or failed on the recovery card to avoid duplicate forms or orders.

## Browser debugging banner

Some screenshots, coordinate actions, trusted inputs, or deep reads use the browser debugging API. The Chrome or Edge banner is expected. The connection normally detaches after becoming idle. Stop the task and reload Panelot if the banner persists.

## Context is too long or a response is cut off

- Create a conversation with less history.
- Remove unnecessary page, file, and MCP Resource chips.
- Split a large task into several turns and extract required information first.
- Check the model's actual context window and maximum output setting.

Lightweight page references limit body length. Ask Panelot to read a narrower range later instead of attaching several complete pages at once.

## File upload fails

- Send the first message before uploading to a new conversation.
- Keep each file at or below 8 MB.
- The upload tool can use only attachments you provided to the current conversation.

## Skill import fails or runs incompletely

- The file needs YAML frontmatter enclosed by `---` with valid `name` and `description` values.
- A URL must use HTTPS and return `SKILL.md` directly. Repository and directory pages are not resolved automatically.
- URL files must not exceed 1 MB.
- Single-file import does not fetch `scripts/`, `references/`, or `assets/`. Rewrite the Skill so it can run independently if it depends on them.
- Choose replace or automatic rename when the Skill name already exists.

## Plugin installation fails

Confirm the ZIP or repository contains a valid `.codex-plugin/plugin.json` and declares every asset in the manifest. Panelot rejects oversized archives, path traversal, symbolic links, and executable content. Repository analysis requires access to GitHub or the archive origin.

Plugins are disabled after installation. Review and enable one under Settings > Plugins before expecting its assets in a task.

## MCP cannot connect

- Panelot supports remote Streamable HTTP only, not local `stdio` or standalone SSE servers.
- Pasted configuration must contain `url`. Local `command` entries are ignored, and an import with no remote URL fails.
- Check server-origin permission, bearer token, CORS, and authentication configuration.
- Complete interactive OAuth from settings. A background task cannot sign in for you.
- If authorization metadata changes, review the resource server, issuer, and endpoints before accepting the new plan.
- Expand the Tool list after connecting and confirm the required Tool is enabled.

## Data import is blocked

End running tasks, resolve approvals and input requests, and run the preflight again. Queued, paused, or interrupted states require explicit permission to discard. Reload the extension after a successful import. Chat commands are blocked until reload.

Import does not restore attachment binaries. Reloading cannot recover an attachment marked unavailable after JSON import.

## The UI keeps reconnecting or reports a protocol mismatch

1. Open `chrome://extensions` or `edge://extensions`.
2. Find Panelot and select Reload.
3. Refresh pages you want to operate, then reopen the side panel.

Refreshing a web page alone does not restart the extension background. After a manual package upgrade, confirm the browser loaded one complete directory and did not mix versions.

## Report a remaining problem

Record the Panelot version, browser version, API type, redacted error, and reproducible steps. Do not include API keys, tokens, complete private conversations, browser profiles, or sensitive screenshots.

Use [GitHub Issues](https://github.com/wangdiandao/Panelot/issues) for ordinary bugs. Report security issues privately through the [Security Policy](https://github.com/wangdiandao/Panelot/security/policy).
