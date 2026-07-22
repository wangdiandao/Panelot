<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

Connect your own model provider in Chrome or Edge and let an agent perform browser tasks within explicit permission and approval rules.

[简体中文](./README.zh-CN.md) · [Documentation](https://wangdiandao.github.io/Panelot/en/) ·
[User guide](https://wangdiandao.github.io/Panelot/en/guide/) ·
[Development](https://wangdiandao.github.io/Panelot/en/development/) ·
[Privacy](https://wangdiandao.github.io/Panelot/en/privacy/)

</div>

## About Panelot

Panelot is a local-first Chrome and Edge MV3 extension. You can chat in the side panel or full-page interface, add web pages, text, and files as explicit context, and let a model read or operate the browser. Permission mode, user rules, sensitive origins, and the data being sent determine whether an action can run automatically.

Panelot does not provide accounts, cloud sync, or a model proxy. Conversations, settings, approvals, Skills, Plugins, memories, and attachments stay in the browser profile. Model requests go directly to the provider you configure. When MCP is enabled, tool arguments and relevant results are exchanged with the selected server.

## Documentation

| Section | Contents |
| --- | --- |
| [User guide](https://wangdiandao.github.io/Panelot/en/guide/) | Installation, model setup, chat context, browser permissions, Skills, Plugins, MCP, backups, and troubleshooting |
| [Development documentation](https://wangdiandao.github.io/Panelot/en/development/) | Architecture, messaging, storage, providers, the agent engine, tools, security, tests, and releases |
| [Privacy policy](https://wangdiandao.github.io/Panelot/en/privacy/) | Local storage, third-party data flows, retention, and user controls |

The Chinese documentation is authoritative. The English site follows the same page structure, and the build checks for missing locale counterparts. If documentation and executable behavior disagree, source code and tests are authoritative.

## Install

1. Download the Chrome or Edge ZIP from [GitHub Releases](https://github.com/wangdiandao/Panelot/releases).
2. Extract it to a directory you plan to keep.
3. Open `chrome://extensions` or `edge://extensions`, enable Developer mode, and choose Load unpacked.
4. Add an OpenAI-compatible or Anthropic connection under Settings > Models, verify it, and select a default model.

See [Install and configure](https://wangdiandao.github.io/Panelot/en/guide/getting-started) for upgrades, site access, and the first test.

## Main capabilities

- Connect to OpenAI-compatible and Anthropic streaming APIs with custom headers, multiple-key failover, and endpoint verification.
- Reference open pages and MCP resources, upload files, and manage branching conversation history.
- Read and manage tabs, click, type, download, or capture screenshots, and use CDP when the permission policy allows it.
- Import a single-file `SKILL.md`, install validated data-only Plugins, and connect to remote Streamable HTTP MCP servers.
- Persist runs, queues, and approvals, then resume work that is safe to continue after a service worker restart.

See the [development documentation](https://wangdiandao.github.io/Panelot/en/development/) for browser tools, permission order, and recovery boundaries.

## Data boundaries

Panelot requests website access per origin when needed, and you can revoke it in the browser. Credentials are encrypted in extension-local storage to reduce plaintext inspection and accidental export. This does not protect against an attacker who can read the browser profile or run code as the current user.

Panelot does not operate telemetry or advertising systems. Selected context is sent to your model provider, and remote MCP calls exchange data with the corresponding server. See [Data and privacy](https://wangdiandao.github.io/Panelot/en/guide/data-and-privacy) and the [privacy policy](https://wangdiandao.github.io/Panelot/en/privacy/) for details.

## Current limits

- Builds target Chrome and Edge MV3 on Chrome 116 or newer. Firefox and Safari are not build targets.
- MCP supports remote Streamable HTTP only. Local stdio servers are not supported.
- Plugins contain validated, read-only data assets and cannot execute remote code.
- Skills are imported as one `SKILL.md` file. Dependency directories are not fetched automatically.
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

See the [development guide](https://wangdiandao.github.io/Panelot/en/development/) for the full command list, test boundaries, and release requirements.

## License

[MIT](./LICENSE)
