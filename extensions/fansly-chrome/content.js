// Moon Curses -> Fansly : content script. Types received text into the Fansly chat box.
(() => {
  if (window.__moonFanslyLoaded) return; // never register twice
  window.__moonFanslyLoaded = true;
  const allowedPage = () =>
    location.pathname.startsWith("/creator/streaming") || location.pathname.startsWith("/live/runalewdie");

  const queue = [];
  let busy = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 20 && r.height > 10 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled && !el.readOnly;
  };

  async function findInput() {
    const { chatSelector } = await chrome.storage.local.get("chatSelector");
    if (chatSelector) {
      try {
        const el = document.querySelector(chatSelector);
        if (el) return el;
      } catch (e) {}
    }
    const nodes = [...document.querySelectorAll("textarea, input[type=text], input:not([type]), [contenteditable=''], [contenteditable='true'], [role=textbox]")].filter(visible);
    let best = null, bestScore = -1;
    for (const el of nodes) {
      const hint = [el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-placeholder"), el.name, el.id, el.className].join(" ").toLowerCase();
      let score = 0;
      if (/chat/.test(hint)) score += 5;
      if (/message|say something|send/.test(hint)) score += 3;
      if (/search|comment|tip|price|amount|title|description|name/.test(hint)) score -= 6;
      if (el.closest("[class*=chat i], [id*=chat i]")) score += 3;
      const r = el.getBoundingClientRect();
      if (r.top > innerHeight * 0.5) score += 1;   // chat boxes sit at the bottom
      if (r.left > innerWidth * 0.5) score += 1;   // and usually on the right
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return bestScore >= 2 ? best : null;
  }

  function setText(el, text) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
      if ((el.textContent || "").trim() !== text.trim()) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  const isEmpty = (el) => (el.isContentEditable ? (el.textContent || "") : el.value || "").trim() === "";

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  function findSendButton(el) {
    let node = el;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const btns = [...node.querySelectorAll("button, [role=button]")];
      const b = btns.find((x) => /send|post|submit/i.test((x.getAttribute("aria-label") || "") + " " + (x.title || "") + " " + (x.textContent || "")));
      if (b) return b;
    }
    return null;
  }

  async function post(text, cfg) {
    const el = await findInput();
    if (!el) { console.warn("[Moon Curses] chat box not found - use 'Pick chat box' in the extension popup"); return; }
    setText(el, text);
    if (cfg.autoSend === false) return;
    await sleep(120);
    pressEnter(el);
    await sleep(350);
    if (!isEmpty(el)) {
      const btn = findSendButton(el);
      if (btn) btn.click();
    }
  }

  function chunk(text, max) {
    const out = [];
    let rest = text.trim();
    while (rest.length > max) {
      let cut = rest.lastIndexOf(" ", max);
      if (cut < max * 0.5) cut = max;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  async function run() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const { text, cfg } = queue.shift();
      await post(text, cfg);
      await sleep(Math.max(500, Number(cfg.delayMs) || 1500));
    }
    busy = false;
  }

  // ---- "pick the chat box" helper ----
  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const ph = el.getAttribute("placeholder");
    if (ph) return `${el.tagName.toLowerCase()}[placeholder="${ph.replace(/"/g, '\\"')}"]`;
    const al = el.getAttribute("aria-label");
    if (al) return `${el.tagName.toLowerCase()}[aria-label="${al.replace(/"/g, '\\"')}"]`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 6) {
      const i = [...n.parentElement.children].indexOf(n) + 1;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i})`);
      n = n.parentElement;
    }
    return "body > " + parts.join(" > ");
  }

  function startPick() {
    const bar = document.createElement("div");
    bar.textContent = "Moon Curses: click the Fansly chat box (Esc to cancel)";
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#F5A9CF;color:#2B1420;font:600 14px sans-serif;padding:10px;text-align:center";
    document.documentElement.appendChild(bar);
    const done = () => { bar.remove(); document.removeEventListener("click", onClick, true); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") done(); };
    const onClick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      let t = e.target;
      const editable = t.closest("textarea, input, [contenteditable='true'], [contenteditable=''], [role=textbox]");
      if (editable) t = editable;
      await chrome.storage.local.set({ chatSelector: selectorFor(t) });
      bar.textContent = "Chat box saved!";
      bar.style.background = "#23A55A";
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => bar.remove(), 1200);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "say") {
      if (!allowedPage()) { sendResponse({ ok: false }); return; }
      for (const part of chunk(msg.text, Math.max(20, Number(msg.cfg?.maxLen) || 200))) queue.push({ text: part, cfg: msg.cfg || {} });
      run();
      sendResponse({ ok: true });
    } else if (msg?.type === "pick") {
      startPick();
      sendResponse({ ok: true });
    }
  });
})();
