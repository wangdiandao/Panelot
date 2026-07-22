# Permissions and security

> Related: [Architecture](./architecture.md), [Agent engine](./agent-engine.md), [Browser tools](./browser-tools.md), and [Prompts](./prompts.md).

## 1. Permission policies

Runtime uses one `permissionPolicy`:

| Value | Default decision |
| --- | --- |
| `always` | Ask for browser and MCP reads and writes, except local `memory_read` and `load_skill` |
| `untrusted` | Allow reads and ask for writes unless a rule or session grant decides otherwise. This is the default |
| `auto` | Allow ordinary writes while sensitive origins, sensitive payloads, and deny or ask rules remain active |

Panelot does not use a site allowlist. Outside `always`, a sensitive-origin entry does not block reads. It still blocks writes. The old `cross_scope` approval is retired; reached origins are used only for third-party sensitive-data detection and audit.

`acceptForSession` stores a versioned Thread-level grant in `chrome.storage.session`. It survives a service worker restart but ends with the browser session.

Remote MCP annotations are informational. Without a trusted-server configuration, every MCP Tool registers as a write with `never-retry` and follows write approval rules.

Every submitted or queued message carries the permission policy selected in the composer at submission time. When a queued message starts its Turn, the engine synchronizes that policy to Gatekeeper again. Gatekeeper reads the current Thread configuration before every tool dispatch and performs the final authorization check there.

## 2. Gatekeeper order

Every browser, MCP, and applicable built-in tool calls `gatekeeper.check()`:

1. Allow `memory_read` and `load_skill`. Allow other reads unless the policy is `always`.
2. For writes, deny a target in the sensitive-origin list. No rule can override this.
3. Apply matching deny or ask rules. A forced ask cannot be silenced by a session grant.
4. Force an ask when credentials, a valid card number, or a third-party email transfer is detected.
5. Apply a matching session grant or allow rule.
6. Use the current policy default.

URL writes such as `navigate`, `tab_open`, and `download` are judged by destination origin. `javascript:`, `data:`, and `vbscript:` destinations are denied. Host normalization removes a trailing DNS dot.

A denial does not open a dialog. The model receives a failed tool result, and the UI records the rule that matched.

## 3. Rules

A `PermissionRule` contains an ID, tool or wildcard, origin or wildcard, `allow`, `ask`, or `deny` verdict, source, and creation time. Priority is deny before ask before allow; specific before wildcard; and user settings before persisted approvals before Plugin defaults.

Write categories are `navigate`, `organize`, `click`, `fill`, `eval`, `download`, `upload`, `interact`, `memory`, and `mcp`. A rule such as `category:fill` applies to all form-writing tools.

First initialization creates `run_javascript × * × deny` and records a separate initialization marker. Users can delete the rule. Later worker starts read the marker and do not recreate a missing rule.

Built-in and user sensitive patterns are merged. HTTP origins match scheme, host, and effective port. Only `*.example.com` matches subdomains. Explicit scheme patterns cover protected schemes. Users cannot remove built-in sensitive origins.

## 4. Approval RPC

`approval.request` contains the tool label, complete parameters, target origin, flags, and optional element or screenshot preview. Decisions are allow once, allow for this browser session and Thread, persist allow for the site and tool, decline with an optional note, or cancel and interrupt.

Approvals time out after five minutes as a decline. The tool call, prepared target, Approval record, and waiting Run state are written in one transaction. After worker restart, the same request appears again.

Acceptance does not skip final validation. Before dispatch, the engine checks the prepared tab and origin, deny rules, host access, and whether manual activity changed the controlled target. A stale approval closes without dispatch.

Only authenticated extension Ports can send a decision. A web page cannot imitate an approval control. When no UI is open, a browser notification can link to the waiting Thread without including tool parameters or page content.

## 5. Debugger and L2 notices

`escalation_l2` is a display flag, not a separate mandatory decision. If policy already asks about an L2 write, the card explains the browser debugging banner. L2 reads are allowed outside `always`, and `auto` can allow an L2 write when no stronger condition matches.

`press_key` uses trusted CDP input. Test or fallback environments without CDP use synthetic input and report that limitation.

## 6. Prompt-injection boundary

Model-visible page, file, Skill, Plugin, and MCP content is untrusted. Prompt assembly wraps it in a random, escaped boundary and states that data is not instruction. Gatekeeper then applies sensitive-origin denial, forced-ask rules, sensitive-data warnings, and complete approval previews independently of model interpretation.

The model can be misled by page text without weakening the final target and permission checks.

## 7. Settings matrix

The settings page lists tool, site, verdict, and source; supports exact names, prefixes, categories, and deletion; selects the default policy; and manages user sensitive-origin patterns. It does not currently provide a separate temporary-grant list, reset-default command, rule export, or link from a persisted approval to its original conversation.

## 8. Current constraints

Session grants fail closed on storage corruption or access failure. Removing host permission clears temporary grants, and dispatch checks host access again. Sensitive-data detection intentionally favors an extra question over silent transmission. Thresholds live in `rules.ts` for later calibration with real usage data.
