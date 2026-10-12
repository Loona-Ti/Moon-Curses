const DEFAULTS = { port: 3030, enabled: true, maxLen: 200, delayMs: 1500, autoSend: true };
const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("enabled").checked = cfg.enabled;
  $("autoSend").checked = cfg.autoSend;
  $("port").value = cfg.port;
  $("maxLen").value = cfg.maxLen;
  $("delayMs").value = cfg.delayMs;
  refreshStatus();
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "status" }, (res) => {
    const ok = res && res.status === "connected";
    $("status").textContent = ok ? "connected" : "not connected";
    $("status").className = ok ? "ok" : "bad";
  });
}

for (const id of ["enabled", "autoSend"]) $(id).onchange = () => chrome.storage.local.set({ [id]: $(id).checked });
for (const id of ["port", "maxLen", "delayMs"]) $(id).onchange = () => chrome.storage.local.set({ [id]: Number($(id).value) });

$("pick").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: "pick" }).then(() => window.close()).catch(() => alert("Open your Fansly page first, then try again."));
};
$("reset").onclick = () => chrome.storage.local.remove("chatSelector");
$("test").onclick = () => chrome.runtime.sendMessage({ type: "test", text: "Test message from Moon Curses" });

load();
setInterval(refreshStatus, 2000);
