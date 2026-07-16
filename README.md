<div align="center">
  <img src="public/icon/128.png" width="96" alt="Panelot icon" />

# Panelot

An AI agent extension for Chrome and Edge. Connect a model provider you already use, give the
agent page context, and review browser actions as they happen.

[简体中文](./README.zh-CN.md) · [Documentation](./docs/README.md) ·
[Development guide](./docs/development.md) · [Changelog](./CHANGELOG.md)

</div>

## What Panelot does

Panelot runs in the browser rather than on a Panelot server. Conversations, settings, approvals,
Skills, Plugins, memories, and attachments are stored in the extension profile.

- It connects to OpenAI-compatible and Anthropic APIs with your own keys. Connections support
  endpoint verification, custom headers, multiple-key failover, and request diagnostics.
- It can work across open tabs, read accessibility snapshots, click and type in pages, download
  files, take screenshots, and use CDP when an in-page action is not enough.
- It can load `SKILL.md` instructions, install validated data-only Plugins, and connect to remote
  MCP tools, prompts, and resources over Streamable HTTP.
- Runs, queues, and approvals are persisted. After a service-worker restart, read-only or
  retry-safe work can resume; writes with an unknown outcome wait for the user.

Browser actions pass through the permission policy and saved rules. Sensitive origins remain
blocked for writes, and advanced CDP actions are identified before execution. Chrome also shows
its debugger banner while CDP is attached.

## Install and set up

1. Download the Chrome or Edge ZIP from
   [GitHub Releases](https://github.com/wangdiandao/Panelot/releases).
2. Extract it to a directory you plan to keep.
3. Open `chrome://extensions` or `edge://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select the extracted directory.
4. In **Settings → Models**, add an OpenAI-compatible or Anthropic connection, run **Verify**, and
   choose a default model.

Use `+` to add the current page or a file, `@` to reference an open tab or MCP resource, and `/` to
run a Skill or MCP prompt. The task model used for titles can be selected separately under
**Settings → Presets**.

## Data and network access

Panelot has no account service, application backend, cloud sync, advertising, or telemetry.
Selected conversation context is sent directly to the model provider you configure. MCP arguments
and results are exchanged with the MCP server you enable. Website access is requested per origin
when it is needed and can be revoked in the browser.

Credentials are encrypted in extension-local storage. This protects them from casual inspection
and accidental export; it is not a security boundary against an attacker who can read the browser
profile or run code as the user. See the [privacy policy](./docs/privacy-policy.md) and
[permission rationale](./store/permissions.md) for the complete data flow.

## Current limits

- The build targets Chrome and Edge MV3 on Chrome 116 or newer. Firefox and Safari are not build
  targets.
- MCP uses remote Streamable HTTP. Local stdio servers are not supported.
- Plugins contain validated, read-only data assets. They cannot run remote code.
- Skills are imported as one `SKILL.md` file; companion `scripts/` and `references/` directories
  are not imported.
- A provider label does not guarantee compatibility. Use **Verify**, then test the selected model
  with a real request.

## Documentation

Start with the [documentation index](./docs/README.md). It separates current runtime contracts,
developer operations, historical design research, and unverified experience targets. Source code
and tests remain authoritative when a document and the implementation disagree.

## Development

Requirements: Node.js `^20.19.0 || >=22.12.0`, pnpm 9.12.3, and Chrome 116 or newer.

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

Engine changes require reloading Panelot from `chrome://extensions`; refreshing a web page does not
restart the MV3 service worker. Production archives use `pnpm zip` and `pnpm zip:edge`. The
[development guide](./docs/development.md) covers repository layout, verification, and releases.

## License

[MIT](./LICENSE)
