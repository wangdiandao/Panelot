---
title: Panelot
description: Use your own model provider for chats and browser tasks in Chrome and Edge
outline: [2, 3]
---

# Panelot

Panelot is an AI agent extension for Chrome and Edge. You can connect an OpenAI-compatible or Anthropic service, chat in the side panel or full-page interface, and add web pages, text, or files to a task. Browser actions pass through permission policies and approval rules.

Panelot does not provide accounts, cloud sync, or a model proxy. Conversations, settings, approvals, Skills, Plugins, memories, and attachments stay in the current browser profile. Model requests go directly to the provider you configure. When MCP is enabled, tool arguments and relevant results are exchanged with the selected remote server.

## Choose a section

| Section | Audience | Contents |
| --- | --- | --- |
| [User guide](./guide/) | People installing and using Panelot | Installation, model connections, chat context, browser permissions, Skills, Plugins, MCP, data management, and troubleshooting |
| [Development documentation](./development/) | Contributors and implementation reviewers | Architecture, protocols, storage, providers, the agent engine, tools, security, tests, and releases |
| [Privacy policy](./privacy/) | All users | Local storage, third-party data flows, retention, and user controls |

The [Chinese documentation](../) is authoritative. Both locales use matching page paths, and the documentation build rejects missing translations.

## Install

1. Download the Chrome or Edge ZIP from [GitHub Releases](https://github.com/wangdiandao/Panelot/releases).
2. Extract it to a directory you plan to keep.
3. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose Load unpacked.
4. Add a connection under Settings > Models, verify it, and select a default model.

See [Install and configure](./guide/getting-started.md) for upgrade precautions and the complete procedure.

## Current capabilities

- Connect to OpenAI-compatible and Anthropic streaming APIs with custom headers, multiple-key failover, and connection verification.
- Reference open pages and MCP resources, manage conversation branches, and use attachment metadata for browser upload tasks.
- Read and manage tabs, click, type, download, or capture screenshots, and use CDP when the permission policy allows it.
- Load a single-file `SKILL.md`, install validated data-only Plugins, and connect to remote Streamable HTTP MCP servers.
- Persist runs, queues, and approvals. After a service worker restart, read-only or retry-safe steps can resume. Writes with an unknown outcome wait for the user.

The [user guide](./guide/) explains the interface. The [development documentation](./development/) records implementation boundaries and source locations.

## Data and permissions

Panelot requests website access per origin when needed, and you can revoke it in the browser. Permission mode, user rules, sensitive origins, and the data being sent determine whether an action can run automatically. Users should take over passwords, verification codes, payments, and human-verification steps.

Credentials are encrypted in extension-local storage to reduce plaintext inspection and accidental export. This does not protect against an attacker who can read the browser profile or run code as the current user. See [Data and privacy](./guide/data-and-privacy.md) and the [privacy policy](./privacy/) for data flows and deletion controls.

## Current limits

- Builds target Chrome and Edge MV3 on Chrome 116 or newer. Firefox and Safari are not build targets.
- MCP supports remote Streamable HTTP only. Local stdio servers are not supported.
- Plugins contain validated, read-only data assets and cannot execute remote code.
- Skills are imported as one `SKILL.md` file. Panelot does not fetch `scripts/`, `references/`, or other dependency directories.
- A provider label does not prove endpoint compatibility. Verify the connection and send a real request with the selected model.

## Development

Development requires Node.js `^20.19.0 || >=22.12.0`, pnpm 9.12.3, and Chrome 116 or newer.

```bash
pnpm install
pnpm dev
pnpm compile
pnpm lint
pnpm test
pnpm docs:build
pnpm build
```

See the [development guide](./development/) for the repository map, verification matrix, and release requirements. If documentation and executable behavior disagree, source code and tests are authoritative.

## License

Panelot is available under the [MIT License](https://github.com/wangdiandao/Panelot/blob/main/LICENSE).
