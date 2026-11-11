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
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [onclick]';

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

  const BUTTON_INPUTS = new Set(["button", "submit", "reset", "image"]);

  // Text fields: anything you can type into. Their value is data, not a label.
  const isTextField = (el) =>
    el.isContentEditable ||
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" && !BUTTON_INPUTS.has(el.type) && !["checkbox", "radio", "file", "range", "color"].includes(el.type));

  const labelOf = (el) => {
    const isField = isTextField(el) || el.tagName === "SELECT" || ["checkbox", "radio"].includes(el.type);
    return clean(
      el.getAttribute("aria-label") ||
        (isField ? el.labels?.[0]?.innerText : el.innerText) ||
        (isField ? "" : el.value) ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("alt") ||
        el.querySelector?.("img[alt]")?.getAttribute("alt") ||
        "",
    );
  };

  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const out = { ref: refFor(el), tag, text: labelOf(el) };
    const role = el.getAttribute("role");
    if (role) out.role = role;
    if (tag === "a" && el.href) out.href = el.href;
    if (tag === "input") out.type = el.type;
    if (el.name) out.name = el.name;
    if (el.isContentEditable) out.editable = true;
    // Current state, so Claude can see what's filled in. Never echo passwords.
    if (el.type === "checkbox" || el.type === "radio") out.checked = el.checked;
    else if (el.type === "password") out.value = el.value ? "(filled)" : "";
    else if (tag === "select") {
      out.value = el.value;
      out.options = [...el.options].slice(0, 30).map((o) => clean(o.text, 80) || o.value);
    } else if (isTextField(el)) out.value = clean(el.isContentEditable ? el.innerText : el.value, 300);
    if (el.disabled) out.disabled = true;
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

  const findTarget = ({ ref, refLabel, text }) => {
    if (ref) {
      const el = refs.get(ref)?.deref();
      if (!el || !el.isConnected) {
        throw new Error(`Ref ${refLabel || ref} is stale or unknown — call read_page again.`);
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

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  // Replace a text field's contents. execCommand("insertText") goes through
  // the browser's editing pipeline, so it fires beforeinput/input the way real
  // typing does and frameworks (React, rich editors) pick the change up. If
  // the page blocks it, fall back to setting the value and firing events.
  const setText = (el, text) => {
    el.focus();
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.select?.();
    }
    const ok = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    const now = el.isContentEditable ? el.innerText.replace(/\n$/, "") : el.value;
    if (ok && now === text) {
      // Real typing fires "change" when the field loses focus; some forms only
      // validate on it. Contenteditable never fires change, so skip it there.
      if (!el.isContentEditable) fire(el, "change");
      return "typed";
    }
    if (el.isContentEditable) el.textContent = text;
    else el.value = text; // through Xray: the native setter, which React's tracker notices
    fire(el, "input");
    fire(el, "change");
    return "set";
  };

  const setSelect = (el, value) => {
    const want = String(value).toLowerCase().trim();
    const opts = [...el.options];
    const opt =
      opts.find((o) => o.value === String(value)) ||
      opts.find((o) => o.text.toLowerCase().trim() === want) ||
      opts.find((o) => o.text.toLowerCase().includes(want));
    if (!opt) {
      throw new Error(`No option matching "${value}". Options: ${opts.map((o) => clean(o.text, 40)).join(" | ")}`);
    }
    el.focus();
    el.value = opt.value;
    fire(el, "input");
    fire(el, "change");
    return `selected "${clean(opt.text, 80)}"`;
  };

  const setChecked = (el, value) => {
    const want = value === true || /^(true|on|yes|1|checked)$/i.test(String(value));
    if (el.type === "radio" && !want) throw new Error("A radio button can't be unchecked; check a different one.");
    if (el.checked !== want) el.click(); // click so the page's own handlers run
    return el.checked ? "checked" : "unchecked";
  };

  const submitFrom = (el) => {
    const form = el.form || el.closest("form");
    if (form) {
      form.requestSubmit(); // runs validation and submit handlers, like pressing Enter
      return "form submitted";
    }
    // No form: many search boxes listen for Enter instead.
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
    return "pressed Enter (no form)";
  };

  const fillInput = ({ ref, refLabel, value, submit }) => {
    if (!ref) throw new Error("form_input needs a ref from read_page.");
    const el = findTarget({ ref, refLabel });
    if (el.disabled || el.readOnly) throw new Error(`${refLabel || ref} is disabled or read-only.`);
    let action;
    if (el.tagName === "SELECT") action = setSelect(el, value);
    else if (el.type === "checkbox" || el.type === "radio") action = setChecked(el, value);
    else if (isTextField(el)) action = setText(el, String(value));
    else throw new Error(`${refLabel || ref} is a <${el.tagName.toLowerCase()}>, not a form field. Use follow_link to click it.`);
    const result = { action, target: describe(el) };
    if (submit) result.submitted = submitFrom(el);
    return result;
  };

  const pageSize = () => ({
    width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  window.__claudeFirefox = { getPageText, readPage, activate, fillInput, pageSize };
}
