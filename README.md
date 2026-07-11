<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

Browser-native AI agent extension: bring your own model, let it operate the web, extend it with Skills, data-only Plugins, and remote MCP.

[中文文档](./README.zh-CN.md) · [Design docs](./DESIGN.md) · [Development guide](./docs/development.md)

</div>

---

## What it is

Panelot is a Chrome/Edge (MV3) extension that runs an agent inside the browser:

- **Bring your own key.** Implements OpenAI-compatible and Anthropic protocols, with templates for official APIs and several third-party/local endpoints. Compatibility with a specific endpoint must be checked with **Verify** and an actual request. Connections support multiple keys with failover, custom headers, and per-endpoint quirks.
- **The browser is the agent's hands.** Tab management, page perception via accessibility snapshots, DOM interaction, and CDP-powered operations (screenshots, trusted key events). Every write goes through an approval gate.
- **Extensible.** Claude-Code-compatible `SKILL.md`, validated data-only Plugins, and remote MCP tools/prompts/resources over the browser-safe SDK Streamable HTTP client. Endpoint host access is requested at runtime.
- **Local-first.** Conversations, settings and keys stay on your machine; keys are only sent to the endpoints you configure. No telemetry.

## Architecture

The engine lives in the background service worker. Every UI surface is a thin view over the same engine, connected through a typed Port protocol. Runs, queues, approvals, command receipts, and resolved environments are durable. After a worker restart, safe reads can replay, pending approvals and queues recover, and uncertain writes pause for an explicit user decision.

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
| Minimal agent loop: iterate until the model stops calling tools | Complexity lives outside the loop (Gatekeeper, UI). The current guards remind at 25 tool calls and pause at 60; token-budget exhaustion also pauses the turn. |
| Perception via accessibility snapshots (`role "name" [ref=sN_M]`, versioned refs that expire) | Semantic, a few hundred tokens, no vision required; stale refs are rejected at the protocol level. |
| Browser-level control: the agent may target any tab; safety is enforced by the Gatekeeper and the sensitive-origin blacklist | Approval frequency depends on the configured policy and rules. Tab membership is an audit trail, not a permission boundary. |
| Tool results never lie | Synthetic keys that can't trigger native behavior say so; navigation ≠ failure; cross-origin frames report as invisible rather than absent. |

## Project characteristics

- Panelot itself has no application backend: the extension talks directly to the provider and remote MCP endpoints you configure.
- Conversation state, settings, Skills, memories, and attachments are stored in extension-local storage. Model requests and MCP calls still send the selected context to their configured remote endpoints.
- Browser actions use extension APIs, content scripts, and on-demand CDP access. Gatekeeper rules and the sensitive-origin blacklist run before registered tools execute.

The design notes in [docs/11-references.md](./docs/11-references.md) explain which external projects influenced individual decisions. They are not a live feature or privacy comparison; re-check the upstream projects before using those notes for product comparison.

## Getting started

Install from a release:

1. Grab the latest zip from [Releases](https://github.com/wangdiandao/Panelot/releases): `panelot-<version>-chrome.zip` for Chrome, `panelot-<version>-edge.zip` for Edge.
2. Unzip it to a folder you'll keep around.
3. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
4. Click the toolbar icon or press `Alt+P` to toggle the side panel (rebind at `chrome://extensions/shortcuts`). From the side panel, `Ctrl/Cmd+E` expands the conversation into the full-page view.

First run:

1. Open Settings → **Models** (`模型`) → add a connection: pick the API style (OpenAI-compatible / Anthropic), enter the base URL and key, then **Verify**. You get a structured check: reachable / key valid / streaming / tool use.
2. Pick a default model. A task-model interface is used for title generation, but the current settings UI does not expose a separate task-model selector.
3. Chat. Use `+` to attach the current page, `@` to choose an open tab, `{{SELECTION}}` to insert the current selection, and `/` to trigger Skills.

Letting the agent operate the browser:

- Ask it to research, fill forms, or compare pages across tabs. It perceives pages through accessibility snapshots and interacts through clicks and typing; the configured approval policy and rules determine which writes require confirmation.
- Approval prompts show the full parameters. Decisions can be one-shot, per-session, or per-site.
- Banks, payment providers and government sites are hard-denied by a built-in blacklist you can extend.
- Manual takeover: touch the page the agent is driving and the task pauses.

## Current scope

- Chrome/Edge MV3 only. The manifest requires Chrome 116 or newer; Firefox and Safari are not build targets.
- Skills can be created, edited, enabled, and imported from a file or URL. Multi-file Skill bundles are not supported.
- Remote MCP tools, `/server:prompt`, `@` resources, OAuth, encrypted Bearer/refresh tokens, lazy connections, disabled tools, and `list_changed` are wired into the agent. Local stdio MCP servers are not supported.
- The Plugin settings page installs local ZIPs or GitHub repositories, validates declared read-only assets atomically, and supports enable/disable/uninstall. There is no marketplace, rating system, auto-update, or remote executable code.
- `web_search`, a dedicated `ask_user` tool, and `press_keys_raw` are not registered tools in the current build.
- Playwright loads the production unpacked extension in a persistent Chromium context and also validates snapshot refs/form updates. The local mock Provider/MCP fixture matrix and real endpoint compatibility matrix remain release work.

## Development

Requirements:

- Node.js **20.12 or newer** (required by the installed WXT version).
- pnpm 9.12.3 (pinned in `packageManager`).
- Chrome 116 or newer for loading the extension. Playwright's Chromium binary is only needed for `pnpm e2e`.

```bash
pnpm install        # postinstall runs `wxt prepare`
pnpm dev            # dev mode; builds dist/chrome-mv3-dev and launches a development browser
pnpm compile        # tsc --noEmit
pnpm lint           # ESLint 9 + React Hooks
pnpm format:check   # Prettier gate
pnpm test           # Vitest unit tests (engine runs headless, no browser)
pnpm e2e            # Playwright e2e (first: pnpm exec playwright install chromium)
pnpm build          # production build → dist/chrome-mv3
pnpm build:edge     # → dist/edge-mv3
pnpm budget         # production/shared/background JS budgets
```

There is no required `.env` file: model endpoints, keys, permissions, Skills, and MCP servers are configured in the extension UI and stored locally. If the development browser does not launch, load `dist/chrome-mv3-dev` as an unpacked extension. Reloading a page does **not** update the background service worker; after changing engine code, reload the extension at `chrome://extensions`.

See the [development guide](./docs/development.md) for the repository map, runtime data flow, storage keys, troubleshooting, and the verification/release workflow.

## Release packaging

```bash
pnpm zip            # → dist/panelot-<version>-chrome.zip
pnpm zip:edge       # → dist/panelot-<version>-edge.zip
```

`v*` tags publish both ZIPs, SHA-256 checksums, release notes, and a CycloneDX SBOM to GitHub Releases. Store uploads remain manual. Developer-mode users install by unzipping and choosing **Load unpacked**; no unsigned `.crx` is distributed.
