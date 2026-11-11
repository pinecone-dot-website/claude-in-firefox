// Claude for Firefox — background script.
// Connects to the local MCP bridge over WebSocket and executes the commands it
// sends: {id, method, params} in, {id, result} or {id, error} out.

const BRIDGE_URL = "ws://127.0.0.1:18765";
const VERSION = browser.runtime.getManifest().version;
const LOAD_TIMEOUT_MS = 30_000;
// Claude rejects images over 8000px on a side and shrinks tall ones until
// they're unreadable, so full-page captures stop here.
const MAX_SCREENSHOT_HEIGHT = 4000;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let socket = null;
let retryDelay = 1000;

function setStatus(connected) {
  browser.browserAction.setBadgeText({ text: connected ? "ON" : "" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#d97757" });
  browser.browserAction.setTitle({
    title: `Claude for Firefox: ${connected ? "connected" : "disconnected"}`,
  });
}

function connect() {
  socket = new WebSocket(BRIDGE_URL);

  socket.onopen = () => {
    retryDelay = 1000;
    setStatus(true);
    socket.send(JSON.stringify({ type: "hello", version: VERSION }));
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    const reply = (payload) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id, ...payload }));
    };
    const handler = handlers[method];
    if (!handler) return reply({ error: `Unknown method: ${method}` });
    try {
      reply({ result: await handler(params || {}) });
    } catch (err) {
      reply({ error: err?.message || String(err) });
    }
  };

  socket.onclose = () => {
    setStatus(false);
    socket = null;
    // Back off to 10s so an idle browser isn't hammering a closed port.
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The tab Claude last worked in. When no tabId is given, keep working there
// rather than in whatever tab the user happens to have focused.
let lastTabId = null;

async function resolveTab(tabId) {
  let tab = null;
  if (tabId != null) tab = await browser.tabs.get(tabId);
  else if (lastTabId != null) tab = await browser.tabs.get(lastTabId).catch(() => null);
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("No tab to act on. Use tabs_create or pass a tabId.");
  lastTabId = tab.id;
  return tab;
}

const tabSummary = (t) => ({
  tabId: t.id,
  windowId: t.windowId,
  title: t.title,
  url: t.url,
  active: t.active,
  status: t.status,
});

function normalizeUrl(url) {
  url = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

// Refs are numbered per page ("r1", "r2"...) by content.js, so two tabs can
// both have an "r1". Outside the page we namespace them by tab ("t16-r1"),
// which lets follow_link find the right tab from the ref alone and refuse a
// ref that's paired with the wrong tabId.
const withGlobalRef = (tabId, el) => ({ ...el, ref: `t${tabId}-${el.ref}` });

function parseRef(ref, tabId) {
  const m = /^t(\d+)-(r\d+)$/.exec(ref.trim());
  if (!m) {
    throw new Error(
      `Ref "${ref}" isn't a full ref. Use the ref exactly as read_page returned it, e.g. "t12-r4".`,
    );
  }
  const owner = Number(m[1]);
  if (tabId != null && tabId !== owner) {
    throw new Error(`Ref ${ref} belongs to tab ${owner}, but tabId ${tabId} was given.`);
  }
  return { tabId: owner, localRef: m[2] };
}

// Firefox refuses to let extensions open privileged URLs (about:config,
// file:, javascript:, data:...) and says only "Illegal URL". Spell it out.
const explainIllegalUrl = (url) => (err) => {
  if (/Illegal URL/i.test(err?.message || "")) {
    throw new Error(`Firefox does not let extensions open "${url}" (privileged or local URL).`);
  }
  throw err;
};

// Resolves once the tab finishes loading. Attach BEFORE triggering navigation
// so a fast load can't slip past us. If expectStart is set and no load begins
// within that window, resolves early (the click didn't navigate).
function waitForLoad(tabId, { expectStart } = {}) {
  return new Promise((resolve) => {
    let started = !expectStart;
    const done = () => {
      clearTimeout(timeout);
      clearTimeout(startTimer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, change, tab) => {
      if (id !== tabId) return;
      if (change.status === "loading" || change.url) started = true;
      // Same-document navigations (#hash, pushState) change the URL while the
      // tab stays "complete" — treat that as done too.
      if (started && (change.status === "complete" || (change.url && tab.status === "complete"))) done();
    };
    browser.tabs.onUpdated.addListener(listener);
    const timeout = setTimeout(done, LOAD_TIMEOUT_MS);
    const startTimer = expectStart ? setTimeout(() => !started && done(), expectStart) : null;
  });
}

async function runInPage(tabId, fn, args) {
  try {
    await browser.tabs.executeScript(tabId, { file: "/content.js", runAt: "document_idle" });
    const [result] = await browser.tabs.executeScript(tabId, {
      code: `window.__claudeFirefox.${fn}(${JSON.stringify(args)})`,
    });
    return result;
  } catch (err) {
    const msg = err?.message || String(err);
    if (/Missing host permission|cannot be scripted|about:|privileged/i.test(msg)) {
      const tab = await browser.tabs.get(tabId);
      // An ordinary web URL that still can't be scripted is being shown by
      // one of Firefox's built-in viewers (JSON, PDF, raw text...).
      const why = /^https?:/.test(tab.url)
        ? "it is displayed by a built-in Firefox viewer (JSON, PDF, etc.), which extensions can't script. " +
          "screenshot still works on it"
        : "it is a privileged browser page";
      throw new Error(`Firefox does not allow extensions to read ${tab.url}: ${why}.`);
    }
    throw err;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function regexFrom(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "i");
  } catch (err) {
    throw new Error(`Invalid pattern: ${err.message}`);
  }
}

// Keep at most `max` entries, dropping the oldest.
function pushCapped(map, tabId, entry, max) {
  let list = map.get(tabId);
  if (!list) map.set(tabId, (list = []));
  list.push(entry);
  if (list.length > max) list.splice(0, list.length - max);
}

// ---------------------------------------------------------------------------
// Network log: every tab, from the webRequest API (no page hooks), in memory
// only, capped per tab, dropped when the tab closes.
// ---------------------------------------------------------------------------

const MAX_REQUESTS_PER_TAB = 500;
const networkLogs = new Map(); // tabId -> [entry]
const inFlight = new Map(); // requestId -> entry (latest hop of a redirect chain)
const ALL_URLS = { urls: ["<all_urls>"] };

browser.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  const entry = { method: d.method, url: d.url, type: d.type, start: d.timeStamp };
  inFlight.set(d.requestId, entry); // a redirect fires this again with the same id
  pushCapped(networkLogs, d.tabId, entry, MAX_REQUESTS_PER_TAB);
}, ALL_URLS);

browser.webRequest.onBeforeRedirect.addListener((d) => {
  const entry = inFlight.get(d.requestId);
  if (!entry) return;
  entry.status = d.statusCode;
  entry.redirectTo = d.redirectUrl;
  entry.ms = Math.round(d.timeStamp - entry.start);
}, ALL_URLS);

browser.webRequest.onCompleted.addListener((d) => {
  const entry = inFlight.get(d.requestId);
  if (!entry) return;
  inFlight.delete(d.requestId);
  entry.status = d.statusCode;
  if (d.fromCache) entry.fromCache = true;
  entry.ms = Math.round(d.timeStamp - entry.start);
}, ALL_URLS);

browser.webRequest.onErrorOccurred.addListener((d) => {
  const entry = inFlight.get(d.requestId);
  if (!entry) return;
  inFlight.delete(d.requestId);
  entry.error = d.error;
  entry.ms = Math.round(d.timeStamp - entry.start);
}, ALL_URLS);

// ---------------------------------------------------------------------------
// Console log: opt-in per tab. Hooking the console makes DevTools attribute
// messages to the extension instead of the page, so only tabs Claude asked to
// watch get hooked. See console-hook.js for how the opt-in persists.
// ---------------------------------------------------------------------------

const MAX_CONSOLE_PER_TAB = 1000;
const consoleLogs = new Map(); // tabId -> [entry]
const consoleWatched = new Set();
const LEVELS = ["debug", "log", "info", "warn", "error"];

// Runs before any page script on every page load, and hooks only tabs that
// opted in. This is what catches a page's earliest console output.
browser.contentScripts
  .register({ matches: ["<all_urls>"], js: [{ file: "/console-hook.js" }], runAt: "document_start" })
  .catch((err) => console.error("console hook registration failed:", err));

// Opt a tab in now (sets its flag and hooks the current page).
async function injectConsoleHook(tabId) {
  await browser.tabs.executeScript(tabId, { file: "/console-hook.js", runAt: "document_start" });
  await browser.tabs.executeScript(tabId, { code: "window.__claudeFirefoxConsole.start()", runAt: "document_start" });
}

// The opt-in flag is per site, so after the tab moves to a new site the
// registered script won't hook it. Hook it here instead: slightly later, so
// the new site's first page may miss its earliest messages, but the flag is
// set again and later loads on that site are caught from the start.
browser.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0 && consoleWatched.has(tabId)) injectConsoleHook(tabId).catch(() => {});
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "console" || !sender.tab) return;
  // A tab can still be flagged after the extension reloads; keep watching it.
  consoleWatched.add(sender.tab.id);
  for (const entry of msg.entries) pushCapped(consoleLogs, sender.tab.id, entry, MAX_CONSOLE_PER_TAB);
});

browser.tabs.onRemoved.addListener((tabId) => {
  networkLogs.delete(tabId);
  consoleLogs.delete(tabId);
  consoleWatched.delete(tabId);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const handlers = {
  async tabs_context() {
    const tabs = await browser.tabs.query({});
    return { tabs: tabs.map(tabSummary) };
  },

  async tabs_create({ url }) {
    const tab = await browser.tabs
      .create({ url: url ? normalizeUrl(url) : undefined, active: true })
      .catch(explainIllegalUrl(url));
    lastTabId = tab.id;
    // active:true on create doesn't always stick (seen with an unfocused
    // window), so select it explicitly.
    await browser.tabs.update(tab.id, { active: true });
    if (url) await waitForLoad(tab.id);
    return tabSummary(await browser.tabs.get(tab.id));
  },

  async navigate({ url, tabId }) {
    const tab = await resolveTab(tabId);
    const loaded = waitForLoad(tab.id, { expectStart: 3000 });
    if (url === "back") await browser.tabs.goBack(tab.id);
    else if (url === "forward") await browser.tabs.goForward(tab.id);
    else await browser.tabs.update(tab.id, { url: normalizeUrl(url) }).catch(explainIllegalUrl(url));
    await loaded;
    return tabSummary(await browser.tabs.get(tab.id));
  },

  async get_page_text({ tabId, maxChars }) {
    const tab = await resolveTab(tabId);
    return { tabId: tab.id, ...(await runInPage(tab.id, "getPageText", { maxChars })) };
  },

  async read_page({ tabId, filter, query, limit }) {
    const tab = await resolveTab(tabId);
    const page = await runInPage(tab.id, "readPage", { filter, query, limit });
    page.elements = page.elements.map((el) => withGlobalRef(tab.id, el));
    return { tabId: tab.id, ...page };
  },

  async follow_link({ tabId, ref, text }) {
    let localRef;
    if (ref) ({ tabId, localRef } = parseRef(ref, tabId));
    const tab = await resolveTab(tabId);
    // Start listening before the click: a same-origin click can begin
    // navigating before executeScript even returns.
    const loaded = waitForLoad(tab.id, { expectStart: 2000 });
    const outcome = await runInPage(tab.id, "activate", { ref: localRef, refLabel: ref, text });
    if (outcome.action === "navigate") await browser.tabs.update(tab.id, { url: outcome.href });
    await loaded;
    const after = await browser.tabs.get(tab.id);
    return {
      clicked: withGlobalRef(tab.id, outcome.target),
      navigated: after.url !== tab.url,
      ...tabSummary(after),
    };
  },

  async form_input({ tabId, ref, value, submit }) {
    if (!ref) throw new Error("form_input needs a ref from read_page.");
    const parsed = parseRef(ref, tabId);
    const tab = await resolveTab(parsed.tabId);
    const loaded = submit ? waitForLoad(tab.id, { expectStart: 2000 }) : null;
    const outcome = await runInPage(tab.id, "fillInput", { ref: parsed.localRef, refLabel: ref, value, submit });
    await loaded;
    const after = await browser.tabs.get(tab.id);
    return {
      ...outcome,
      target: withGlobalRef(tab.id, outcome.target),
      ...(submit ? { navigated: after.url !== tab.url } : {}),
      ...tabSummary(after),
    };
  },

  async screenshot({ tabId, fullPage, format = "jpeg" }) {
    const tab = await resolveTab(tabId);
    const options = { format, scale: 1 }; // 1 CSS px per image px, even on Retina
    if (format === "jpeg") options.quality = 85;
    let truncated = false;
    // Viewport captures need nothing from the page, so they also work on
    // pages extensions can't script (JSON/PDF viewers). Only fullPage has to
    // ask the page how tall it is.
    let size = { viewportWidth: tab.width, viewportHeight: tab.height };
    let note = null;
    if (fullPage) {
      try {
        size = await runInPage(tab.id, "pageSize", {});
        truncated = size.height > MAX_SCREENSHOT_HEIGHT;
        options.rect = { x: 0, y: 0, width: size.width, height: Math.min(size.height, MAX_SCREENSHOT_HEIGHT) };
      } catch {
        fullPage = false;
        note = "fullPage isn't possible on this page (Firefox won't let extensions measure it); captured the viewport instead";
      }
    }
    const dataUrl = await browser.tabs.captureTab(tab.id, options);
    const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    return {
      image: { mimeType, data },
      meta: {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        captured: fullPage ? options.rect : { width: size.viewportWidth, height: size.viewportHeight },
        ...(note ? { note } : {}),
        ...(truncated ? { truncated: `page is ${size.height}px tall; captured the top ${MAX_SCREENSHOT_HEIGHT}px` } : {}),
      },
    };
  },

  async tabs_activate({ tabId }) {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    lastTabId = tab.id;
    return tabSummary(await browser.tabs.get(tab.id));
  },

  async tabs_close({ tabId }) {
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.remove(tabId);
    if (lastTabId === tabId) lastTabId = null;
    return { closed: tabSummary(tab) };
  },

  async scroll({ tabId, ref, direction, amount }) {
    let localRef;
    if (ref) ({ tabId, localRef } = parseRef(ref, tabId));
    const tab = await resolveTab(tabId);
    const result = await runInPage(tab.id, "scrollPage", { ref: localRef, refLabel: ref, direction, amount });
    await sleep(500); // let lazy-loaded content arrive
    const position = await runInPage(tab.id, "scrollPosition", {});
    if (result.scrolledTo) result.scrolledTo = withGlobalRef(tab.id, result.scrolledTo);
    // Firefox throttles background tabs, and the IntersectionObserver most
    // infinite-scroll pages rely on barely runs there.
    const current = await browser.tabs.get(tab.id);
    const note = current.active
      ? undefined
      : "This tab is in the background, where Firefox throttles lazy loading. If more content was expected, tabs_activate it and scroll again.";
    return { tabId: tab.id, ...result, ...position, ...(note ? { note } : {}) };
  },

  async hover({ tabId, ref }) {
    if (!ref) throw new Error("hover needs a ref from read_page or find.");
    const { tabId: owner, localRef } = parseRef(ref, tabId);
    const tab = await resolveTab(owner);
    const result = await runInPage(tab.id, "hover", { ref: localRef, refLabel: ref });
    await sleep(300); // give hover menus time to open
    return {
      tabId: tab.id,
      hovered: withGlobalRef(tab.id, result.hovered),
      next: "Call read_page or find to see anything the hover revealed.",
    };
  },

  async find({ tabId, query, limit }) {
    const tab = await resolveTab(tabId);
    const found = await runInPage(tab.id, "find", { query, limit });
    found.results = found.results.map((el) => withGlobalRef(tab.id, el));
    return { tabId: tab.id, ...found };
  },

  async read_console_messages({ tabId, pattern, level, limit = 100, clear }) {
    const tab = await resolveTab(tabId);
    if (!consoleWatched.has(tab.id)) {
      await injectConsoleHook(tab.id).catch(async () => {
        await runInPage(tab.id, "pageSize", {}); // throws the friendly "can't script this page" error
      });
      consoleWatched.add(tab.id);
      return {
        tabId: tab.id,
        capturing: "started",
        messages: [],
        note:
          "Console capture just started for this tab, so nothing has been recorded yet. To capture what " +
          "the page logs while loading, reload it (navigate to its own URL), then call this again.",
      };
    }
    const re = regexFrom(pattern);
    await sleep(150); // the page sends messages asynchronously; let in-flight ones land
    const minLevel = level ? LEVELS.indexOf(level) : 0;
    const all = consoleLogs.get(tab.id) || [];
    const matching = all.filter((m) => LEVELS.indexOf(m.level) >= minLevel && (!re || re.test(m.text)));
    if (clear) consoleLogs.delete(tab.id);
    return {
      tabId: tab.id,
      total: matching.length,
      messages: matching.slice(-limit).map((m) => ({ ...m, time: new Date(m.time).toISOString() })),
    };
  },

  async read_network_requests({ tabId, pattern, failedOnly, type, limit = 100, clear }) {
    const tab = await resolveTab(tabId);
    const re = regexFrom(pattern);
    const all = networkLogs.get(tab.id) || [];
    const matching = all.filter(
      (r) =>
        (!re || re.test(r.url)) &&
        (!type || r.type === type) &&
        (!failedOnly || r.error || r.status >= 400),
    );
    if (clear) networkLogs.delete(tab.id);
    return {
      tabId: tab.id,
      total: matching.length,
      requests: matching.slice(-limit).map(({ start, ...r }) => ({
        ...r,
        url: r.url.length > 300 ? r.url.slice(0, 299) + "…" : r.url,
        time: new Date(start).toISOString(),
        ...(r.status === undefined && !r.error ? { pending: true } : {}),
      })),
    };
  },
};

setStatus(false);
connect();
