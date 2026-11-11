// Injected into pages on demand by background.js via tabs.executeScript.
// Runs in the extension's content-script sandbox, which persists across
// executeScript calls on the same page — so the ref map survives between
// read_page and follow_link, and resets naturally when the page navigates.

if (!window.__claudeFirefox) {
  const refs = new Map(); // "r12" -> WeakRef<Element>
  let counter = 0;

  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], ' +
    '[contenteditable="true"], [onclick]';

  const clean = (s, max = 200) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };

  const isVisible = (el) => {
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // Reuse an element's existing ref so repeated read_page calls stay stable.
  const refFor = (el) => {
    for (const [ref, weak] of refs) if (weak.deref() === el) return ref;
    const ref = `r${++counter}`;
    refs.set(ref, new WeakRef(el));
    return ref;
  };

  const labelOf = (el) =>
    clean(
      el.getAttribute("aria-label") ||
        el.innerText ||
        el.value ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("alt") ||
        el.querySelector?.("img[alt]")?.getAttribute("alt") ||
        "",
    );

  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const out = { ref: refFor(el), tag, text: labelOf(el) };
    const role = el.getAttribute("role");
    if (role) out.role = role;
    if (tag === "a" && el.href) out.href = el.href;
    if (tag === "input") out.type = el.type;
    if (el.name) out.name = el.name;
    return out;
  };

  const getPageText = ({ maxChars = 50000 } = {}) => {
    // Prefer the main content region when it holds a meaningful share of the page.
    const body = document.body;
    const main = document.querySelector("main, article, [role='main']");
    let root = body;
    if (main && body && main.innerText.length > body.innerText.length * 0.3) root = main;
    let text = (root?.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    return { title: document.title, url: location.href, truncated, text };
  };

  const readPage = ({ filter = "interactive", query, limit = 200 } = {}) => {
    const selector = filter === "links" ? "a[href]" : INTERACTIVE;
    const q = query?.toLowerCase();
    const elements = [];
    let matched = 0;
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const info = describe(el);
      if (q && !`${info.text} ${info.href || ""} ${info.name || ""}`.toLowerCase().includes(q)) continue;
      matched++;
      if (elements.length < limit) elements.push(info);
    }
    return { title: document.title, url: location.href, total: matched, elements };
  };

  const findTarget = ({ ref, text }) => {
    if (ref) {
      const el = refs.get(ref)?.deref();
      if (!el || !el.isConnected) {
        throw new Error(`Ref ${ref} is stale or unknown — call read_page again.`);
      }
      return el;
    }
    if (text) {
      const want = text.toLowerCase().trim();
      let partial = null;
      for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (!isVisible(el)) continue;
        const label = labelOf(el).toLowerCase();
        if (label === want) return el;
        if (!partial && label.includes(want)) partial = el;
      }
      if (partial) return partial;
      throw new Error(`No visible link or button with text matching "${text}".`);
    }
    throw new Error("Provide either ref or text.");
  };

  // Returns {href} for plain links so the background script can navigate the
  // tab directly (sidesteps target=_blank and popup blockers). Otherwise
  // clicks the element in-page.
  const activate = (args) => {
    const el = findTarget(args);
    const info = describe(el);
    const link = el.closest("a[href]");
    if (link && /^https?:|^file:/.test(link.href)) {
      return { action: "navigate", href: link.href, target: info };
    }
    el.scrollIntoView({ block: "center" });
    el.click();
    return { action: "click", target: info };
  };

  window.__claudeFirefox = { getPageText, readPage, activate };
}
