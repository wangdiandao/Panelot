# Reference projects

> This design research was recorded in July 2026. "Adopted" means an idea influenced Panelot, not that the current version implements every upstream feature. Recheck primary sources before publishing a current comparison.

## 1. Adoption notes

### Open WebUI

Panelot uses a parent-linked message tree and one `leafId`, avoiding a parallel flat array that can drift from the tree. Provider connections are protocol-first, support enabled state without deletion, and add custom headers, multiple keys, and concurrent short-timeout model discovery. Model presets and a title task model are implemented. Conversation folders and follow-up suggestions remain targets.

Streaming code blocks wait until their fence closes before syntax or diagram rendering. The composer uses a common trigger framework for tabs, slash commands, and variables. Undefined provider parameters are omitted, and UI-only fields are removed.

Panelot does not adopt Open WebUI's multi-user administration or random key load balancing.

### OpenAI Codex CLI

Influences include Op and AgentEvent request and event separation, Thread, Turn, and Item primitives, initialization snapshots, extensible events, three permission policies with mandatory rules, steering, queueing, interrupt, engine-originated approval RPC, append-only replay, and bounded queues.

Panelot rejects an on-failure approval mode because browser writes are not generally reversible. Its engine-to-UI protocol is custom because streaming, approvals, persistence, and server-originated requests do not map cleanly to MCP.

### Pi Agent

Panelot follows a loop that ends when the model stops requesting Tools, uses one AgentTool shape with separate model `content` and UI `details`, returns Tool errors for model correction, stores branches in one tree, and abstracts production Port and direct test transports.

Pi assumes a more trusted local-terminal environment. Panelot adds browser target validation, untrusted-content boundaries, and Gatekeeper.

### Playwright MCP and Chrome DevTools MCP

Panelot uses accessibility snapshots with opaque refs, rejects stale generations, exposes a human-readable element beside the exact ref, supports text-based waits and typed input options, and falls back to vision coordinates for Canvas. CDP adds AXTree, pierced DOM, and event-listener capabilities. File upload still uses the content script.

### nanobrowser and browser-use

The implementation favors recall when detecting interactive targets, collapses clickable parent chains, fails over instead of looping on an empty tree, uses bounded waits, stops a batch after significant page change, and detaches debugger sessions after idle time. It does not adopt multiple planner, navigator, and validator agents because of context cost.

## 2. Implementation cautions

1. Validate tree writes and bound ancestry walks to avoid renderer loops.
2. Define permission semantics once in the protocol and do not silently reinterpret `untrusted` or `never`.
3. Return an explicit perception failure and use a fallback instead of repeating an empty DOM read.
4. Reject stale refs before a changed control receives an old action.
5. Discover models concurrently with independent four-second timeouts.
6. Isolate OpenAI-compatible endpoint differences in connection quirks.
7. Serialize `chrome.debugger` target attachment in the gateway.

## 3. Sources

- Open WebUI: [documentation](https://docs.openwebui.com), chat and model source, and issues #15189, #788, and #20658
- OpenAI Codex: [github.com/openai/codex](https://github.com/openai/codex) and [developers.openai.com/codex](https://developers.openai.com/codex)
- Pi Agent: [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono) and the [2025-11-30 article](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- Playwright MCP: [github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
- Chrome DevTools MCP: [github.com/ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- nanobrowser: [github.com/nanobrowser/nanobrowser](https://github.com/nanobrowser/nanobrowser), issues #126 and #166, and discussion #85
- browser-use: [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use), issues #705, #3292, and #922

Codex event enums and Pi session formats are versioned and continue to evolve. Verify current upstream source before implementing another corresponding module.
