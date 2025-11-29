(function () {
  const API_BASE_URL = "https://hivemoji.hivelytics.io";

  function openUploaderTab() {
    const url = chrome.runtime.getURL("popup.html");
    const createTab = chrome.tabs?.create || chrome.browser?.tabs?.create;
    if (createTab) createTab({ url });
  }

  try {
    const manifest = chrome.runtime.getManifest?.();
    const hasPopup =
      !!(manifest?.action && manifest.action.default_popup) ||
      !!(manifest?.browser_action && manifest.browser_action.default_popup);
    const actionApi = chrome.action || chrome.browserAction;
    if (!hasPopup && actionApi?.onClicked?.addListener) {
      actionApi.onClicked.addListener(() => openUploaderTab());
    }
  } catch {
    // ignore
  }

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
