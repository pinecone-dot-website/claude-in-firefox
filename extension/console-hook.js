// Console capture for tabs Claude is watching.
//
// Wraps the page's console (via exportFunction, so page code calls our
// wrapper) and listens for uncaught errors. Entries go to the background
// script, which keeps them across navigations.
//
// background.js registers this file to run at document_start in every page,
// which Firefox guarantees is before any page script. That's the only way to
// catch what a page logs while loading. It does nothing unless this tab opted
// in: the flag lives in sessionStorage, which is per tab and per site,
// readable synchronously, survives reloads, and vanishes with the tab. Tabs
// that never opted in keep an untouched console (hooking makes DevTools show
// the extension as the source of every message).

(() => {
  if (window.__claudeFirefoxConsole) return;

  const FLAG = "__claudeFirefoxConsole";
  let hooked = false;

  const start = () => {
    try {
      sessionStorage.setItem(FLAG, "1");
    } catch {} // storage can be blocked (sandboxed or opaque origins); hook anyway
    if (hooked) return;
    hooked = true;

    // Batch with a microtask, not setTimeout: background tabs throttle timers
    // to 1s+, which delayed messages past the point Claude reads them.
    let queue = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const entries = queue;
      queue = [];
      browser.runtime.sendMessage({ type: "console", entries }).catch(() => {});
    };
    const push = (level, text) => {
      queue.push({ level, text: text.slice(0, 2000), time: Date.now(), url: location.href });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    };
    const fmt = (arg) => {
      try {
        if (typeof arg === "string") return arg;
        if (arg && typeof arg === "object" && "message" in arg && "stack" in arg) return `${arg.name}: ${arg.message}`;
        if (arg && typeof arg === "object") return JSON.stringify(arg)?.slice(0, 500) ?? String(arg);
        return String(arg);
      } catch {
        return Object.prototype.toString.call(arg);
      }
    };

    const pageConsole = window.wrappedJSObject.console;
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const original = pageConsole[level];
      exportFunction(
        function (...args) {
          try {
            push(level, args.map(fmt).join(" "));
          } catch {}
          // Spread, don't .apply(): apply would hand the page our (content
          // script) array, and the page reading its .length throws
          // "Permission denied", breaking the page's own script.
          return original.call(pageConsole, ...args);
        },
        pageConsole,
        { defineAs: level },
      );
    }

    window.addEventListener(
      "error",
      (e) => {
        if (e instanceof ErrorEvent) push("error", `Uncaught ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
        else if (e.target && e.target !== window) {
          push("error", `Failed to load <${e.target.tagName?.toLowerCase()}> ${e.target.src || e.target.href || ""}`);
        }
      },
      true, // capture phase also sees resource load failures, which don't bubble
    );
    window.addEventListener("unhandledrejection", (e) => {
      push("error", `Unhandled promise rejection: ${fmt(e.reason)}`);
    });
  };

  window.__claudeFirefoxConsole = { start };

  let optedIn = false;
  try {
    optedIn = sessionStorage.getItem(FLAG) === "1";
  } catch {}
  if (optedIn) start();
})();
