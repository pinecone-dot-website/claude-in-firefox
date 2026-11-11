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
};

setStatus(false);
connect();
