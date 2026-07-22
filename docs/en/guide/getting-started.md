# Install and configure

## Requirements

- Chrome 116 or newer, or the corresponding Microsoft Edge version.
- An OpenAI-compatible or Anthropic endpoint that the browser can reach.
- Any API key required by that service. An endpoint that explicitly permits anonymous access, which is common for local model services, can leave the key blank.

Panelot currently provides developer-mode packages through GitHub Releases. There is no confirmed browser-store installation channel.

## Install the extension

1. Open [GitHub Releases](https://github.com/wangdiandao/Panelot/releases). Download `panelot-chrome.zip` for Chrome or `panelot-edge.zip` for Edge.
2. Extract the ZIP to a directory you will keep. Do not move or delete it after loading the extension.
3. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
4. Enable Developer mode, choose Load unpacked, and select the extracted directory.
5. Pin Panelot to the browser toolbar. Click its icon or press `Alt+P` to open the side panel.

Before upgrading a manually installed build, export a backup from Settings > Data. Keep the same extension directory, disable the extension or close related browser windows, replace all old files with the new package, and click Reload on the extensions page.

Settings > About > Check for updates compares the installed version with the latest GitHub Release. When a newer version is available, it links to the ZIP for the current browser. You still need to replace the existing files and reload the extension as described above.

Do not mix files from different versions or switch to another directory. The browser can treat an unpacked extension at a new path as a separate installation, so its existing local data may not appear.

## Add the first model connection

Panelot shows onboarding when it opens without a configured model. You can also use Settings > Models at any time.

1. Select the API type:
   - **OpenAI-compatible**: the endpoint must provide a compatible streaming `/chat/completions` interface.
   - **Anthropic**: the endpoint must provide a compatible streaming `/v1/messages` interface.
2. Enter the base URL and API key. Remote endpoints must use HTTPS. HTTP is allowed only for `localhost`, `127.0.0.1`, or `[::1]`.
3. Select Verify connection. The browser may first ask whether Panelot can access the endpoint origin. This site access is required to send the verification requests.
4. Review the reachability, key, streaming, and tool-call results. Do not assume the connection works if verification fails.
5. Save the connection and select a default model. If the endpoint does not expose a model-list API, enter model IDs manually, one per line.

Verification sends a small set of requests to check networking, authentication, streaming, and tool-call structure. A successful result does not prove that every model, parameter, or long conversation is compatible. Send a real chat request after saving.

See [Providers and models](./providers-and-models.md) for the other connection options.

## Choose a default permission mode

The second onboarding step offers three browser-action modes:

- **Ask for everything**: confirm page reads and actions.
- **Ask for actions**: allow reads and confirm clicks, typing, downloads, and similar actions. This is the default.
- **Automatic actions**: allow ordinary actions without interruption while sensitive origins, suspected sensitive data, and permission rules still apply.

Keep Ask for actions for your first tasks. You can change the mode from the composer for one conversation or set a different global default. See [Browser actions and permissions](./browser-and-permissions.md).

## Run a first test

1. Open an ordinary `https://` page.
2. Open the Panelot side panel and select Attach to chat on the current-page prompt, or type `@` and choose the page.
3. Send "Summarize the main points on this page."
4. If the browser requests site access, verify the origin before granting it.

The page title shown in the side panel does not mean its content is attached. The selected page content is sent only when a page-context chip appears for that message.

## Next steps

- Learn `@`, `/`, <code v-pre>{{</code>, file uploads, and multi-tab references in [Chats and context](./chats-and-context.md).
- Add custom instructions and model presets in [Providers and models](./providers-and-models.md).
- Connect remote tools and import a Skill in [Skills, Plugins, and MCP](./skills-plugins-mcp.md).
