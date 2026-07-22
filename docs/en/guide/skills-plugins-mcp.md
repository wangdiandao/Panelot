# Skills, Plugins, and MCP

Panelot has three extension mechanisms with different responsibilities:

| Type | Purpose | Code execution |
| --- | --- | --- |
| Skill | Provide instructions that the model can load when relevant or run through `/` | Does not execute code from the Skill file directly |
| Plugin | Package read-only Skills, model presets, and site instructions | Does not execute remote code |
| MCP | Connect remote Tools, Prompts, and Resources | Tools execute on the remote server, which exchanges arguments and results with Panelot |

Each mechanism can influence model behavior. Review the source and content before installation or activation. Untrusted instructions are not authorization.

## Skills

Settings > Skills can create, edit, enable, disable, delete, export, or import a Skill from a local Markdown file or URL.

An importable Skill is one `SKILL.md` file with YAML frontmatter containing at least a name and description. An enabled Skill first exposes its name and description to the model. The model loads the body when relevant, or you can select its command after typing `/`.

URL import accepts only HTTPS addresses whose response body is the `SKILL.md` file, such as a raw file URL. A GitHub repository or directory page is not searched for a Skill. The URL file limit is 1 MB.

Single-file import has these limits:

- It does not download `scripts/`, `references/`, `assets/`, or other relative dependencies.
- The UI warns about detected dependencies but cannot fill them in.
- Unknown Claude Code frontmatter fields are preserved, but declarations such as `allowed-tools` do not alter Panelot browser permissions.

When a Skill name already exists, you can replace it or assign a new name. Panelot does not check for Skill updates automatically. Compare source content before importing a newer copy.

## Plugins

Settings > Plugins accepts a local ZIP or analyzes a GitHub repository, archive, tree, or release ZIP URL. Before installation it displays the source, summary, assets, and prompt-related warnings.

A Plugin can contain only manifest-declared data assets, including Skills, model presets, site instructions, and other validated read-only data. It cannot install executables, run remote code, import MCP connections, or add permission rules.

Archives are limited to 10 MB compressed, 50 MB extracted, and 1,000 files. Panelot rejects path traversal, symbolic links, executable permissions, and common executable extensions.

A Plugin remains disabled after installation or upgrade until you review and enable it. Its assets are read-only. Copy a Skill, preset, or site instruction before editing it. Disabling or removing a Plugin excludes its assets from new tasks.

The curated index currently has no built-in entries. Panelot does not provide marketplace ratings, automatic updates, or a remote-code marketplace.

## Site instructions

Settings > Sites stores trusted instructions for an exact host or a subdomain pattern such as `*.example.com`. Instructions enter the model context only when the default page captured for the message or an explicitly referenced tab matches. URL path matching is not supported.

Site instructions affect model behavior but do not grant website access or action permission. Plugin site instructions are read-only and can be copied into a user-owned instruction.

## Remote MCP

Panelot supports remote MCP servers over **Streamable HTTP**. It does not support local `stdio` servers or the older standalone SSE transport.

Use Paste JSON under Settings > MCP servers to import a Claude Code `mcpServers` or Cursor-style fragment. The configuration must contain a remote `url`. A bearer token in `headers.Authorization` is recognized. Local `command` entries are not imported.

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

The browser requests access to the server origin during import. After adding the server, you can enable or disable it, test or reconnect, review Tool, Prompt, and Resource counts, disable one remote Tool, complete OAuth where supported, or remove the configuration.

OAuth can request access to the resource server, authorization server, and token endpoint in separate stages. Check each displayed origin. When authorization metadata changes or a plan expires, Panelot asks for confirmation instead of reusing an old target.

## Use MCP in a chat

- The model calls remote Tools as needed. Writes pass through the current permission policy. A server's read-only annotation does not lower the requirement by itself.
- MCP Prompts appear in the `/` menu. A Prompt with parameters opens a form first.
- MCP Resources appear in the `@` menu and are read only after selection.

Tool arguments and relevant results are exchanged directly with the MCP server. A remote failure is not shown as local success, and an interrupted remote write is not repeated while its outcome remains unknown.

If an OAuth token expires and requires interactive authorization, open settings and authorize manually. A background task cannot complete a login page.

See [Skills and Plugins](../development/skills-plugins.md) and [Remote MCP](../development/mcp.md) for implementation details.
