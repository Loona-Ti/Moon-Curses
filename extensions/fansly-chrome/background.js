// Moon Curses -> Fansly : background service worker.
// Keeps a websocket open to Moon Curses (ws://127.0.0.1:<port>/pubsub) and forwards every
// message on the topic "fansly.chat" to the Fansly tab, where content.js types it into the chat.

const DEFAULTS = { port: 3030, enabled: true, maxLen: 200, delayMs: 1500, autoSend: true };
const TAB_PATTERNS = ["https://fansly.com/creator/streaming*", "https://fansly.com/live/runalewdie*"];

let ws = null;
let status = "disconnected";
let keepAlive = null;
let lastText = "";
let connecting = false;
let lastDelivered = { text: "", at: 0 };

async function getConfig() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

function setStatus(s) {
  status = s;
  chrome.action.setBadgeText({ text: s === "connected" ? "" : "!" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#F23F42" }).catch(() => {});
}

async function connect() {
  // lock: several startup events call connect() at once, which used to open 2 sockets (= every message twice)
  if (connecting || (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))) return;
  connecting = true;
  const cfg = await getConfig();
  setStatus("connecting");
  try {
    ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/pubsub?id=fansly-ext-${Date.now()}`);
  } catch (e) {
    connecting = false;
    setStatus("disconnected");
    return;
  }
  connecting = false;
  const mySocket = ws;
  ws.onopen = () => {
    setStatus("connected");
    clearInterval(keepAlive);
    // traffic every 20s keeps the service worker alive
    keepAlive = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ topic: "fansly.ping", data: {} }));
    }, 20000);
  };
  ws.onmessage = (ev) => handleMessage(ev.data);
  ws.onclose = () => {
    if (ws !== mySocket) return; // an old socket closing must not touch the new one
    clearInterval(keepAlive);
    setStatus("disconnected");
    ws = null;
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {
    try { ws && ws.close(); } catch (e) {}
  };
}

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || msg.topic !== "fansly.chat" || !msg.data || typeof msg.data.value !== "string") return;
  if (msg.data.type !== 0) return; // 0 = final result; anything else (interim) is ignored
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  deliver(msg.data.value, cfg);
}

async function deliver(text, cfg) {
  // never post the exact same text twice within 3 seconds
  const now = Date.now();
  if (text === lastDelivered.text && now - lastDelivered.at < 3000) return;
  lastDelivered = { text, at: now };
  lastText = text;
  const tabs = await chrome.tabs.query({ url: TAB_PATTERNS });
  if (!tabs.length) return;
  // only one tab gets the message, so it is never posted twice
  const tab = tabs.find((t) => t.active && t.highlighted) || tabs.find((t) => t.active) || tabs[0];
  chrome.tabs.sendMessage(tab.id, { type: "say", text, cfg }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "status") {
    sendResponse({ status, lastText });
  } else if (msg?.type === "reconnect") {
    const old = ws; ws = null;
    try { old && old.close(); } catch (e) {}
    connect();
    sendResponse({ ok: true });
  } else if (msg?.type === "test") {
    getConfig().then((cfg) => deliver(msg.text || "Test message from Moon Curses", cfg));
    sendResponse({ ok: true });
  }
  return true;
});

chrome.alarms.create("reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "reconnect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.port) { const old = ws; ws = null; try { old && old.close(); } catch (e) {} connect(); }
});
connect();
