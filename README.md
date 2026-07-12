<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

Browser-native AI agent for Chrome and Edge. Bring your own model, operate the web with
auditable tools, and extend the agent with Skills, data-only Plugins, and remote MCP.

[中文文档](./README.zh-CN.md) · [Documentation](./docs/01-architecture.md) ·
[Development guide](./docs/development.md) · [Changelog](./CHANGELOG.md)

</div>

## Highlights

- **BYOK providers:** OpenAI-compatible and Anthropic APIs, streaming tool calls, endpoint
  verification, custom headers, multiple-key failover, request diagnostics, and bounded retry.
- **Browser operation:** multi-tab workflows, accessibility snapshots, DOM actions, downloads,
  screenshots, and on-demand CDP fallbacks with structured action evidence.
- **Safety boundaries:** approval policies, capability scopes, sensitive-origin blocking,
  untrusted-content fencing, stale-reference rejection, and explicit recovery for uncertain writes.
- **Extensibility:** editable `SKILL.md` instructions, validated data-only Plugin archives, and
  remote MCP tools, prompts, resources, OAuth, and encrypted bearer-token storage.
- **Local-first state:** conversations, queues, approvals, settings, Skills, memories, and
  attachments live in extension storage. Selected context is sent only to endpoints the user
  configures; Panelot has no application backend or telemetry.

## How it works

Panelot runs its engine in the MV3 background service worker. The side panel and full-page chat
are views over the same typed protocol and durable conversation tree. The agent loops until the
model stops requesting tools; every registered action passes through the Gatekeeper before the
browser tool gateway executes it.

```text
Side panel / Full-page chat
            │ typed Op / AgentEvent protocol
            ▼
Background Service Worker
  ├─ durable run, queue, approval, and recovery state
  ├─ OpenAI-compatible / Anthropic provider adapters
  ├─ Skills and remote MCP
  └─ Gatekeeper → tabs / content scripts / on-demand CDP
            │
            ▼
      Extension-local storage
```

Architecture, provider, browser-tool, permission, MCP, Skill, UI, and prompt contracts are under
[`docs/`](./docs). Those documents describe both implemented constraints and explicit targets;
source and tests remain the authority for current behavior.

## Install a release

1. Download `panelot-<version>-chrome.zip` or `panelot-<version>-edge.zip` from
   [GitHub Releases](https://github.com/wangdiandao/Panelot/releases).
2. Extract the archive to a permanent directory.
3. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select the extracted directory.
4. Open Panelot, add an OpenAI-compatible or Anthropic connection under **Settings → Models**,
   run **Verify**, and select a default model.

Use `+` to attach the current page, `@` to reference an open tab or MCP resource, and `/` to invoke
a Skill. Browser writes follow the configured approval policy and site rules.

## Current boundaries

- Chrome/Edge MV3, Chrome 116 or newer; Firefox and Safari are not build targets.
- Remote Streamable HTTP MCP is supported; local stdio MCP is not.
- Plugins contain validated read-only data assets, not remote executable code.
- Endpoint compatibility is established by **Verify** and a real request, not by the provider
  label alone.
- Engine changes require reloading the extension at `chrome://extensions`; reloading a web page
  does not restart the service worker.

## Development

Requirements: Node.js 20.12+, pnpm 9.12.3, and Chrome 116+.

```bash
pnpm install
pnpm dev
pnpm compile
pnpm lint
pnpm format:check
pnpm test
pnpm e2e
pnpm build
pnpm build:edge
pnpm budget
```

Production archives are generated with `pnpm zip` and `pnpm zip:edge`. A `v*` tag triggers the
GitHub release workflow for browser archives, checksums, release notes, and an SBOM. See the
[development guide](./docs/development.md) for repository structure and release verification.

## License

See [LICENSE](./LICENSE).
