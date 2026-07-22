# Data and privacy

Panelot is local-first, but that does not mean all data stays on the device. Conversations call the model service you configure. When MCP is enabled, tool arguments and relevant results can also be sent to the selected MCP server.

## Local data

Panelot stores the following in the current browser profile:

- Conversations, message branches, tool calls, approvals, and waiting states.
- Global settings, model connections, presets, permission rules, and site instructions.
- Skills, Plugins, and memories.
- User uploads, page extracts, screenshots, and other attachments.
- MCP server configurations and related credentials.

This data does not sync automatically to another browser profile or device. Removing the browser profile, clearing extension data, or uninstalling Panelot can permanently remove it.

Provider API keys, MCP bearer tokens, OAuth refresh tokens, and sensitive custom headers are encrypted locally. OAuth access tokens remain only in the browser session. Local encryption reduces plaintext inspection and accidental export but does not protect against an attacker who can read the browser profile or run code as the current system user.

## Where data goes

For a model request, Panelot sends the prompt, relevant conversation history, selected page or pasted text, uploaded-file metadata, and tool results directly to the chosen provider.

Panelot does not parse user-file bodies automatically or send file bytes as ordinary model attachments. File bytes go to a website only after you approve a browser upload action.

MCP Tool arguments and results, Prompt requests, and Resource reads are exchanged directly with the corresponding server. Model providers and MCP servers process data under their own privacy policies. Panelot cannot retract data already sent to them.

Panelot does not operate an account backend, cloud sync, advertising, or telemetry pipeline. It does not sell personal data or upload pages to a Panelot-operated server.

## Limit outbound data

- A current-page prompt only offers the page. Attach it, choose it from `@`, or ask Panelot to read it before its content enters the task.
- Review context chips before sending and remove pages, files, or Resources the task does not need.
- Review the destination and complete parameters for a write, especially when Panelot warns about sensitive data.
- Do not give API keys, passwords, verification codes, card details, or private files to an untrusted provider, MCP server, Skill, or Plugin.
- Revoke unnecessary site access in extension details and revoke exposed or unused tokens in the third-party account.

## Export a backup

Settings > Data exports JSON. The default export includes the conversation tree, Skills, memories, and portable settings, but removes API keys, custom headers, and MCP tokens. Restore imports only user-created or separately imported Skills. Installed Plugins and their read-only assets are not portable and must be installed again in the target browser profile.

Selecting Include API keys and MCP tokens requires a backup password. A password-derived key encrypts the secrets before they are written to JSON. Store the password separately. A forgotten password cannot be recovered.

::: warning Attachments and Plugins are not in the JSON backup
The export does not contain Blob data for uploads, screenshots, or page extracts, and cannot restore installed Plugins in another browser profile. Replace import does not reconstruct them. The JSON export is not a complete archive and should not be your only backup.
:::

A backup contains conversation text and settings that may be private even without secrets. Do not upload it to a public issue, repository, or untrusted service.

## Import and replace

Data import accepts Panelot JSON only and validates size, structure, and references before writing. Import uses **replace mode**. It replaces existing conversations and settings instead of merging them. Export a backup first.

The import flow:

1. Select the JSON file.
2. Enter the original backup password if it contains encrypted secrets.
3. Review active conversations, running tasks, queued or paused states, approvals, and pending input.
4. Confirm discarding interruptible task state when required.
5. Commit the replacement and reload the extension.

A running task that cannot be interrupted safely blocks import. After commit, the extension must reload. Chat commands are rejected before reload so old and new data cannot mix.

## Delete and retain

- **Conversation**: delete it from the conversation menu. The action is permanent and removes its local nodes and attachments.
- **Attachment**: delete it under Settings > Attachments. Referencing messages remain but mark the attachment unavailable.
- **Model or MCP connection**: disable or remove the configuration. Revoke credentials from the third-party account when necessary.
- **All data**: clear extension data through the browser or uninstall Panelot after confirming that required backups exist.

Attachments have a separate management budget of about 200 MB. Over the budget, Panelot removes older attachments that do not belong to the active conversation first. Settings > Data warns when overall browser storage approaches its quota.

See the [privacy policy](../privacy/) for the complete legal and data-processing statement.
