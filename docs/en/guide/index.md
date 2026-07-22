# User guide

Panelot is a local-first AI agent extension for Chrome and Edge. You can connect your own model service, chat in the side panel or full-page interface, reference pages and files, and let the model operate the browser within the permissions you grant.

Panelot does not provide an account, cloud sync, or its own model service. Before using it, you need an OpenAI-compatible or Anthropic endpoint. The selected service controls pricing, data processing, and available models.

## Start here

1. [Install and configure](./getting-started.md): install the extension, add a model connection, verify the endpoint, and choose a permission mode.
2. [Chats and context](./chats-and-context.md): use the side panel, reference pages, upload files, run commands, and manage branches.
3. [Browser actions and permissions](./browser-and-permissions.md): understand site access, confirmations, permission rules, and sensitive-origin restrictions.
4. [Providers and models](./providers-and-models.md): manage connections, models, compatibility options, and presets.
5. [Skills, Plugins, and MCP](./skills-plugins-mcp.md): extend Panelot with instructions, presets, and remote tools.
6. [Data and privacy](./data-and-privacy.md): understand local storage, third-party data flows, backups, imports, and deletion.
7. [Troubleshooting](./troubleshooting.md): diagnose connection failures, inaccessible pages, blocked imports, and related problems.

## Before you begin

- Panelot targets Chrome 116 or newer and Edge on the same extension platform. Firefox and Safari builds are not available.
- Opening the side panel does not send the current page to the model. You must attach the page or ask Panelot to read it during a task.
- Websites, model services, MCP servers, Skills, and Plugins may contain untrusted content. Review approval targets, parameters, and outbound data before proceeding.
- Panelot reduces accidental actions but cannot make payment, account, privacy, or data-sharing decisions for you. Take over credentials, verification codes, payments, and human-verification steps.
- "OpenAI-compatible" describes a request format, not verified support for every endpoint. Verify a new connection and send a real request before relying on it.

See the [development documentation](../development/) for implementation details. The [privacy policy](../privacy/) describes the complete data flow.
