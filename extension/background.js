(function () {
  const API_BASE_URL = "https://hivemoji.hivelytics.io";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "HIVEMOJI_FETCH_JSON") return;
    const url = String(message.url || "");
    if (!url.startsWith(API_BASE_URL)) {
      sendResponse({ error: "Blocked fetch to unknown host" });
      return;
    }

    (async () => {
      try {
        const res = await fetch(url, { credentials: "omit", cache: "no-store" });
        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        sendResponse({ ok: res.ok, status: res.status, json, text });
      } catch (err) {
        sendResponse({ error: err?.message || String(err) });
      }
    })();

    return true; // keep the message channel open for async response
  });
})();
