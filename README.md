# Claude for Firefox

Let Claude Code drive Firefox: open tabs, navigate, read pages, follow links, fill in forms, take
screenshots, and read the console and network log. It works like Claude in Chrome, minus the
polish and plus the fox.

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

- **Your normal Firefox, temporarily:** open `about:debugging#/runtime/this-firefox` → _Load
  Temporary Add-on…_ → choose `extension/manifest.json`. It disappears when Firefox restarts.
- **Your normal Firefox, permanently:** sign it (see [Signing](#signing)) and install the `.xpi`.
- **A throwaway Firefox profile:** `npm run firefox` (uses `web-ext run`; nothing touches your real profile).

Finally, start Claude Code **in this directory**. `.mcp.json` registers the server as `firefox`
(approve it when prompted). To use it from any project instead:

```sh
claude mcp add --scope user firefox -- node /absolute/path/to/claude-firefox/server/index.js
```

## Tools

**Tabs**

| Tool            | What it does                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| `tabs_context`  | List open tabs (id, title, url, active).                                              |
| `tabs_create`   | Open a tab, optionally at a URL; waits for load.                                      |
| `tabs_activate` | Bring a tab to the front and focus its window.                                        |
| `tabs_close`    | Close a tab. Always needs an explicit `tabId`.                                        |
| `navigate`      | Go to a URL (bare domains get `https://`), or `"back"` / `"forward"`; waits for load. |

**Reading**

| Tool            | What it does                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_page_text` | Readable page text (prefers `<main>`/`<article>`), with title and URL. `maxChars` truncates.                                                           |
| `read_page`     | Visible links and interactive elements with refs like `t16-r12` (tab 16, element 12), plus field labels, values and checked state.                     |
| `find`          | Ranked word search over everything visible (headings, paragraphs, labels, alt text, links). Hits inside a link or button return the clickable element. |
| `screenshot`    | Capture a tab, even a background one. Viewport by default; `fullPage: true` for the whole page (up to 4000px tall). JPEG by default, or `png`.         |

**Acting**

| Tool          | What it does                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `follow_link` | Follow or click by `ref` or by visible `text`, then wait for navigation. `target=_blank` links open in the same tab.                                 |
| `form_input`  | Fill a field by ref: text inputs, textareas, rich editors, `<select>` (by value or label), checkboxes/radios. `submit: true` submits and waits.      |
| `scroll`      | `down`/`up`/`top`/`bottom`, a pixel `amount`, or to an element by `ref`. Scrolls inner panels when the page itself doesn't scroll. Reports position. |
| `hover`       | Move the synthetic mouse over an element to open JavaScript hover menus and tooltips.                                                                |

**Debugging**

| Tool                    | What it does                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `read_console_messages` | Console output and uncaught errors, filtered by `level` or regex `pattern`. Opt-in per tab (see below).          |
| `read_network_requests` | Method, URL, type, status, timing and errors for a tab's requests. Filter by `pattern`, `type`, or `failedOnly`. |

Refs carry their tab, so tools that take a ref need no `tabId`, and they refuse a ref paired with the
wrong `tabId` instead of acting on the wrong page. Other tools take an optional `tabId`; without one
they act on the tab these tools last used, so Claude stays in its own tab while you click around
elsewhere. If there isn't one, they fall back to the active tab of the focused window.

## Notes and limits

- **Security:** the server binds to 127.0.0.1 and only accepts WebSocket connections whose Origin is
  `moz-extension://`, so web pages can't connect to it. Any local process that can reach the port can
  still drive the extension. That's the same trust boundary as a local MCP server, but it means the
  extension can read **every** page you have open, including logged-in ones.
- **Port:** defaults to `18765`. Override the server with `CLAUDE_FIREFOX_PORT`, but the extension's
  `BRIDGE_URL` in `extension/background.js` is hardcoded and must match.
- **One session at a time:** only one server can own the port. A second Claude Code session will
  report "port already in use" from its tools.
- **Off-limits pages:** Firefox won't let extensions script `about:` pages, `addons.mozilla.org`,
  or pages shown by its built-in viewers (JSON, PDF). The tools say so; `screenshot` still works on
  viewer pages.
- **Refs** stop working once the page navigates. Call `read_page` or `find` again.
- **Input is simulated.** Firefox gives extensions no way to send real OS input, so `form_input`
  uses the browser's editing commands (with synthetic events as a fallback) and `hover` fires
  synthetic mouse events. That covers ordinary forms, React-style apps, most rich editors and
  JavaScript hover menus. Pure CSS `:hover` menus won't open, and sites that only accept trusted
  input (some games, a few anti-bot login forms) may ignore it.
- **Background tabs are throttled.** Firefox slows timers and skips the intersection observers that
  most infinite-scroll pages use in background tabs, so lazy loading may stall. `scroll` notes when
  the tab is in the background; `tabs_activate` it first.
- **Console capture is opt-in per tab.** Reading the console means wrapping the page's `console`,
  which makes DevTools attribute those messages to the extension instead of the page's own code
  line. So only tabs you've called `read_console_messages` on are hooked. The first call starts
  capture; reload the page to capture its load-time output from the very first line. (The opt-in is
  stored per site in the tab's `sessionStorage`, so the first page after the tab moves to a new
  site can miss its earliest messages; reloads after that are complete.) Messages are kept in the
  background (last 1000 per tab) and survive navigations.
- **Network requests** are recorded for every tab from Firefox's `webRequest` API, with no page
  hooks. They stay in memory only (last 500 per tab) and are dropped when the tab closes.
- `read_page` and `find` report password fields as `(filled)` or empty and never return their contents.

## Signing

Release Firefox only installs signed add-ons permanently. Signing **unlisted** has Mozilla sign the
add-on without publishing it anywhere.

1. Sign in at [addons.mozilla.org](https://addons.mozilla.org), then go to **Developer Hub → Manage
   API Keys** and generate a key pair.
2. Put the keys in your environment (not in this repo), then sign:

   ```sh
   export WEB_EXT_API_KEY=user:12345:67      # "JWT issuer"
   export WEB_EXT_API_SECRET=...             # "JWT secret"
   npm run sign
   ```

3. The signed `.xpi` lands in `web-ext-artifacts/` (gitignored). Drag it into Firefox to install,
   and remove the temporary copy from `about:debugging` if it's loaded.

Mozilla won't sign the same version twice, so bump `version` in `extension/manifest.json` before
signing an update.

## Development

```sh
npm run lint     # web-ext lint
npm run build    # unsigned zip into web-ext-artifacts/
```

Logs: server logs go to stderr (shown in Claude Code's MCP logs). Extension logs are in
`about:debugging` → _Inspect_ on the extension.
