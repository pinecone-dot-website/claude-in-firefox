#!/usr/bin/env node
// Claude for Firefox — MCP bridge.
//
// Claude Code launches this over stdio as an MCP server. It also listens on a
// localhost WebSocket that the Firefox extension connects to. Each MCP tool
// call is forwarded to the extension as {id, method, params} and resolved when
// the extension replies with {id, result} or {id, error}.
//
// stdout belongs to the MCP protocol: log to stderr only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const PORT = Number(process.env.CLAUDE_FIREFOX_PORT || 18765);
const REQUEST_TIMEOUT_MS = 45_000;

const log = (...args) => console.error("[claude-firefox]", ...args);

// ---------------------------------------------------------------------------
// Extension bridge
// ---------------------------------------------------------------------------

let extension = null; // the currently connected extension socket
let bridgeError = null; // set if we could not bind the port
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}

const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  // Only accept connections from a Firefox extension. Web pages cannot forge
  // the Origin header, so this stops a random tab from posing as the extension.
  verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("moz-extension://"),
});

wss.on("listening", () => log(`waiting for Firefox extension on ws://127.0.0.1:${PORT}`));

wss.on("error", (err) => {
  bridgeError =
    err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use (another Claude session running this server?). ` +
        `Close it or set CLAUDE_FIREFOX_PORT.`
      : `Bridge failed: ${err.message}`;
  log(bridgeError);
});

wss.on("connection", (socket) => {
  if (extension && extension !== socket) {
    log("new extension connection replaces the old one");
    extension.close(4000, "replaced");
  }
  extension = socket;
  log("extension connected");

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return log("ignoring non-JSON message");
    }
    if (msg.type === "hello") return log(`extension says hello (v${msg.version})`);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  });

  socket.on("close", () => {
    if (extension !== socket) return;
    extension = null;
    log("extension disconnected");
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Firefox extension disconnected mid-request"));
      pending.delete(id);
    }
  });
});

function callExtension(method, params = {}) {
  if (bridgeError) return Promise.reject(new Error(bridgeError));
  if (!extension || extension.readyState !== extension.OPEN) {
    return Promise.reject(
      new Error(
        "Firefox extension is not connected. Make sure Firefox is running with the " +
          "Claude for Firefox extension loaded (about:debugging → Load Temporary Add-on).",
      ),
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s waiting for Firefox (${method})`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    extension.send(JSON.stringify({ id, method, params }));
  });
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "claude-firefox", version: "0.1.0" });

const asText = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

// Wrap a handler so bridge errors come back as tool errors rather than
// protocol errors — Claude can read them and react.
const tool = (name, description, inputSchema, method) =>
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return asText(await callExtension(method, args));
    } catch (err) {
      return { ...asText(`Error: ${err.message}`), isError: true };
    }
  });

const tabId = z
  .number()
  .int()
  .optional()
  .describe("Tab to act on. Defaults to the tab last used by these tools, else the active tab.");

tool(
  "tabs_context",
  "List open Firefox tabs (id, title, url, active) across all windows. Call this first to get tab ids.",
  {},
  "tabs_context",
);

tool(
  "tabs_create",
  "Open a new Firefox tab, optionally at a URL. Waits for the page to load and returns the new tab's id.",
  { url: z.string().optional().describe("URL to open. Omit for a blank tab.") },
  "tabs_create",
);

tool(
  "navigate",
  'Navigate a tab to a URL and wait for it to load. Pass "back" or "forward" to move through history. ' +
    "A bare domain like example.com gets https:// added.",
  { url: z.string().describe('URL, or "back" / "forward"'), tabId },
  "navigate",
);

tool(
  "get_page_text",
  "Get the readable text of a page (prefers the <main>/<article> content when there is one), plus its title and URL.",
  {
    tabId,
    maxChars: z.number().int().positive().optional().describe("Truncate the text to this many characters (default 50000)."),
  },
  "get_page_text",
);

tool(
  "read_page",
  "List links and interactive elements (buttons, inputs, etc.) on a page. Each gets a ref like \"r12\" " +
    "that follow_link accepts. Refs are only valid until the page navigates.",
  {
    tabId,
    filter: z
      .enum(["links", "interactive"])
      .optional()
      .describe('"links" = only <a href> elements; "interactive" = links plus buttons, inputs, etc. (default).'),
    query: z.string().optional().describe("Only return elements whose text, label, or href contains this (case-insensitive)."),
    limit: z.number().int().positive().optional().describe("Max elements to return (default 200)."),
  },
  "read_page",
);

tool(
  "follow_link",
  "Follow a link or click an element, then wait for any resulting navigation. Identify the target by a ref " +
    "from read_page, or by its visible text (first case-insensitive match; exact matches win). Links " +
    "that would open a new tab open in the current tab instead.",
  {
    tabId,
    ref: z.string().optional().describe('Element ref from read_page, e.g. "r12".'),
    text: z.string().optional().describe("Visible link text to match, used when no ref is given."),
  },
  "follow_link",
);

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");
