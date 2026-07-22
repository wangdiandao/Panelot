# Browser actions and permissions

Panelot can read pages, manage tabs, click, type, select, download, and upload files you provide. The result depends on model tool use, page structure, browser restrictions, site access, and your permission rules.

It can also search local browsing history, bookmarks, and top sites; inspect recently closed pages and tab groups; restore a recent session; and create or update tab groups. Reading browser metadata does not read the corresponding page body. Page access still requires permission for that origin.

## Grant site access

Panelot does not receive permanent access to all website content during installation. When it needs a model endpoint, MCP server, Plugin download, or website, the browser requests optional access for that origin. Check the displayed host and grant access only to a trusted target required by the task.

You can revoke site access from Panelot's extension details. A saved permission rule cannot restore browser access. The browser must still grant the origin before an operation runs.

Protected browser pages such as `chrome://`, `edge://`, and extension stores are normally inaccessible to extensions. Relaxing Panelot rules does not override this browser restriction.

## Permission modes

| Mode | Default behavior | Suitable use |
| --- | --- | --- |
| Ask for everything | Confirm page reads and actions | Unfamiliar sites, higher-risk tasks, or initial connection testing |
| Ask for actions | Read directly and confirm clicks, typing, downloads, and similar actions | Ordinary use and the recommended default |
| Automatic actions | Run ordinary actions automatically | A reviewed target and task where fewer interruptions are useful |

Automatic actions do not bypass other controls. Sensitive origins, suspected credential or personal-data transmission, and explicit ask or deny rules take priority. An MCP server's self-reported read-only annotation does not reduce approval requirements by itself.

Set the global default under Settings > Browser permissions. You can override it for the current conversation from the composer or choose a default in a model preset.

## Approval cards

When confirmation is required, Panelot displays a card in the side panel or full-page chat. Check the complete operation and parameters, the target site or destination, content to be entered or uploaded, whether browser debugging will be enabled, and any suspected sensitive-data warning.

Available decisions are:

- **Allow once (Y)**: approve only this call.
- **This session (S)**: temporarily allow the same tool and site combination for this conversation until the browser session ends.
- **Always on this site (A)**: save a persistent allow rule.
- **Deny (N)**: do not execute. The model receives the denial and can choose another approach.
- **Esc**: deny and stop the current turn.

An approval waits for five minutes before it is treated as denied. Buttons drawn by a web page cannot approve Panelot actions. Only Panelot's side panel or full-page chat can submit a decision.

## Permission rules

Settings > Browser permissions supports allow, ask, and deny rules by tool or operation category and site pattern. Rules are more specific than the current permission mode. When several rules match, the most specific tool and site scopes win. At equal specificity, user rules take priority, and deny is stricter than ask, which is stricter than allow.

A site can be an exact origin or a wildcard pattern. `*.example.com` matches the base domain and its subdomains. Do not permanently allow a broad domain you do not trust. Tool matching supports names shown in the UI, MCP tool prefixes, and operation categories.

First-time initialization includes a default rule that denies JavaScript execution in the page. You can delete it, and refresh or extension restart will not recreate it. Prefer a narrow site rule if only one origin should permit this operation.

## Sensitive origins and content

Writes to built-in sensitive origins are denied and cannot be overridden by ordinary allow rules. You can add your own sensitive-origin patterns but cannot remove the built-in list.

Panelot forces confirmation when write parameters contain suspected credentials or a valid card number. It also confirms an email address being sent to a third-party site that the current task has not previously contacted. Detection can be wrong. Inspect the destination and data instead of choosing permanent allow without understanding the flow.

Complete passwords, verification codes, payments, human verification, and other steps that cannot be delegated safely in the web page yourself. When Panelot asks you to take over, do not paste secrets back into the chat as proof.

## Browser debugging banner

Screenshots, coordinate actions, trusted keyboard input, and deeper page reads may use the browser debugging API. Chrome or Edge displays a debugging banner while attached. This is a normal browser security notice.

The banner does not mean an action always requires confirmation. Permission mode and rules still decide. The attachment may remain briefly after a task and then close when idle. If it persists, stop the task and reload Panelot from the extensions page.

For implementation order and tool coverage, see [Permissions and security](../development/permissions.md) and [Browser tools](../development/browser-tools.md).
