# Claude for Firefox

Let Claude Code drive Firefox: open tabs, navigate, read pages, follow links. It works like
Claude in Chrome, minus the polish and plus the fox.

```text
Claude Code ──stdio/MCP──▶ server/index.js ──ws://127.0.0.1:18765──▶ Firefox extension ──▶ your tabs
```

- **`server/`**: a Node MCP server. Claude Code launches it over stdio, and it also listens on a
  localhost WebSocket for the extension.
- **`extension/`**: a Firefox WebExtension (Manifest V2, persistent background page). It connects
  to the server, runs the commands, and reports back. The toolbar badge shows **ON** while it's connected.

## Setup

```sh
npm run setup            # installs server deps
```

Then load the extension. Pick one:

- **Your normal Firefox:** open `about:debugging#/runtime/this-firefox` → _Load Temporary
  Add-on…_ → choose `extension/manifest.json`. Temporary add-ons disappear when Firefox restarts.
- **A throwaway Firefox profile:** `npm run firefox` (uses `web-ext run`; nothing touches your real profile).

Finally, start Claude Code **in this directory**. `.mcp.json` registers the server as `firefox`
(approve it when prompted). To use it from any project instead:

```sh
claude mcp add --scope user firefox -- node /absolute/path/to/claude-firefox/server/index.js
```

## Tools

| Tool            | What it does                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs_context`  | List open tabs (id, title, url, active).                                                                                               |
| `tabs_create`   | Open a tab, optionally at a URL; waits for load.                                                                                       |
| `tabs_activate` | Bring a tab to the front and focus its window (only needed when _you_ should see it).                                                  |
| `tabs_close`    | Close a tab. Always needs an explicit `tabId`.                                                                                         |
| `navigate`      | Go to a URL (bare domains get `https://`), or `"back"` / `"forward"`; waits for load.                                                  |
| `get_page_text` | Readable page text (prefers `<main>`/`<article>`), with title and URL. `maxChars` truncates.                                           |
| `read_page`     | Visible links and interactive elements, each with a ref like `t16-r12` (tab 16, element 12). Filter with `filter: "links"` or `query`. |
| `follow_link`   | Follow or click by `ref` or by visible `text`, then wait for navigation. `target=_blank` links open in the same tab.                   |

Refs carry their tab, so `follow_link` with a ref needs no `tabId`, and it refuses a ref paired with
the wrong `tabId` instead of clicking something on the wrong page.

The other tools take an optional `tabId`. Without one it acts on the tab these tools last used (so
Claude stays in its own tab while you click around elsewhere). If there isn't one, it falls back to
the active tab of the focused window.

## Notes and limits

- **Port:** defaults to `18765`. Override the server with `CLAUDE_FIREFOX_PORT`, but the extension's
  `BRIDGE_URL` in `extension/background.js` is hardcoded and must match.
- **One session at a time:** only one server can own the port. A second Claude Code session will
  report "port already in use" from its tools.
- **Security:** the server binds to 127.0.0.1 and only accepts WebSocket connections whose Origin is
  `moz-extension://`, so web pages can't connect to it. Any local process that can reach the port can
  still drive the extension. That's the same trust boundary as a local MCP server, but it means the
  extension can read **every** page you have open, including logged-in ones.
- **Off-limits pages:** Firefox won't let extensions script `about:` pages, `addons.mozilla.org`, or
  other privileged pages. The tools return a clear error instead.
- Refs from `read_page` stop working once the page navigates. Call `read_page` again.

## Development

```sh
npm run lint     # web-ext lint
npm run build    # zip into web-ext-artifacts/
```

Logs: server logs go to stderr (shown in Claude Code's MCP logs). Extension logs are in
`about:debugging` → _Inspect_ on the extension.
