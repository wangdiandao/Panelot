<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

Browser-native AI agent extension: bring your own model, let it operate the web, extend it with Skills and MCP.

[中文文档](./README.zh-CN.md) · [Design docs](./DESIGN.md)

</div>

---

## What it is

Panelot is a Chrome (MV3) extension that runs an agent inside the browser:

- **Bring your own key.** Works with any OpenAI- or Anthropic-compatible endpoint: official APIs, proxies, OpenRouter, Ollama / LM Studio, and so on. Multiple keys per connection with failover, custom headers, per-endpoint quirks handling.
- **The browser is the agent's hands.** Tab management, page perception via accessibility snapshots, DOM interaction, and CDP-powered operations (screenshots, trusted key events). Every write goes through an approval gate.
- **Extensible.** Claude-Code-compatible `SKILL.md` skills with progressive disclosure, remote MCP servers (Streamable HTTP, OAuth 2.1), plugin bundles.
- **Local-first.** Conversations, settings and keys stay on your machine; keys are only sent to the endpoints you configure. No telemetry.

## Architecture

The engine lives in the background service worker. Every UI surface is a thin view over the same engine, connected through a typed Port protocol. Closing the UI does not stop a running task; reconnecting restores state from a snapshot.

```
┌────────────┐  ┌────────────┐        ┌───────────────────────────────┐
│ Side panel │  │ Full-page  │  Port  │  Background Service Worker    │
│  (React)   │◄─┤  chat UI   ├───────►│                               │
└────────────┘  └────────────┘ Op /   │  EngineCore                   │
                               Event  │   ├─ Agent loop (minimal:     │
                                      │   │   run until no tool call) │
                                      │   ├─ Gatekeeper (approvals,   │
                                      │   │   sensitive-origin deny)  │
                                      │   ├─ Provider adapters        │
                                      │   │   (OpenAI / Anthropic SSE)│
                                      │   └─ Tool gateway ────────────┼──► content scripts (L1)
                                      │        L0 tabs / L2 CDP       │    a11y snapshots, clicks
                                      │  Dexie (IndexedDB)            │
                                      │   conversation tree, skills   │
                                      └───────────────────────────────┘
```

Design decisions worth knowing before reading the code (full rationale in [docs/](./docs)):

| Decision | Why |
|---|---|
| Conversation = message tree (`{id, parentId}` + leaf cursor, append-only + tombstones) | Edit-and-resend / regenerate are sibling branches for free; recovery = replay. |
| Custom Op / AgentEvent protocol with Thread/Turn/Item primitives | Streaming, approvals and reconnection need a purpose-built engine↔UI channel; MCP doesn't fit that role. |
| Minimal agent loop: iterate until the model stops calling tools; token budget is the only hard gate | Complexity lives outside the loop (Gatekeeper, UI). Step counts are soft reminders, not limits. |
| Perception via accessibility snapshots (`role "name" [ref=sN_M]`, versioned refs that expire) | Semantic, a few hundred tokens, no vision required; stale refs are rejected at the protocol level. |
| Browser-level control: the agent may target any tab; safety = write approvals + sensitive-origin blacklist | Tab membership is an audit trail, not a permission boundary. Tool results state whether the user-visible page changed. |
| Tool results never lie | Synthetic keys that can't trigger native behavior say so; navigation ≠ failure; cross-origin frames report as invisible rather than absent. |

## How it compares

| | Panelot | Sidebar AI extensions (Sider / Monica …) | nanobrowser | browser-use | ChatGPT / Claude web |
|---|---|---|---|---|---|
| Model source | Any OpenAI/Anthropic-compatible endpoint | Vendor subscription / relay | BYOK | BYOK (Python lib) | Locked to vendor |
| Browser operation | Full agent: tabs + DOM + CDP, leveled | Read-only summarize/translate | DOM automation | DOM automation (external browser) | None |
| Runs where | Pure extension, zero backend | Extension + vendor cloud | Extension | Python process + CDP | Cloud |
| Extensibility | Skills (Claude-Code compatible) + MCP + plugins | None | None | Python API | Vendor store |
| Permission model | Write approvals, sensitive-origin hard deny, per-site rules | — | Basic | Trust-the-script | — |
| Data | All local | Partially cloud | Local | Local | Cloud |

## Getting started

Install from a release:

1. Grab the latest `panelot-<version>-chrome.zip` (or `.crx`) from Releases.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Drag the zip onto the page, or unzip it and use **Load unpacked**.
   (`.crx` files install directly only on Linux or via enterprise policy — on Windows/macOS Chrome requires Web-Store-signed CRX, so use the zip.)
4. Click the toolbar icon or press `Alt+P` to toggle the side panel (rebind at `chrome://extensions/shortcuts`). From the side panel, `Ctrl/Cmd+E` expands the conversation into the full-page view.

First run:

1. Open Settings → **Providers** → add a connection: pick the API style (OpenAI-compatible / Anthropic), enter the base URL and key, then **Verify**. You get a structured check: reachable / key valid / streaming / tool use.
2. Pick a default model. Optionally set a cheap task model for titles and suggestions.
3. Chat. Attach the current page with 📎, reference tabs and selections with `@`, trigger skills with `/`.

Letting the agent operate the browser:

- Ask it to research, fill forms, or compare pages across tabs. It perceives pages through accessibility snapshots and interacts through clicks and typing, with per-write approvals.
- Approval prompts show the full parameters. Decisions can be one-shot, per-session, or per-site.
- Banks, payment providers and government sites are hard-denied by a built-in blacklist you can extend.
- Manual takeover: touch the page the agent is driving and the task pauses.

## Development

```bash
pnpm install        # postinstall runs `wxt prepare`
pnpm dev            # dev mode with hot reload
pnpm compile        # tsc --noEmit
pnpm test           # Vitest unit tests (engine runs headless, no browser)
pnpm e2e            # Playwright e2e (first: pnpm exec playwright install chromium)
pnpm build          # production build → dist/chrome-mv3
pnpm build:edge     # → dist/edge-mv3
```

Note: reloading a page does **not** update the background service worker. After changing engine code, reload the extension at `chrome://extensions`.

## Release packaging

```bash
pnpm zip            # → .output/*.zip for Chrome (and pnpm zip:edge for Edge)
```

For self-hosted `.crx` distribution: `chrome://extensions` → **Pack extension** → point at `dist/chrome-mv3`. Keep the generated `.pem` private and reuse it so the extension ID stays stable. Attach both the zip and the crx to the GitHub release.
