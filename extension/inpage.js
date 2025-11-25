(function () {
  function respond(requestId, result, error) {
    window.postMessage(
      {
        type: "HIVEMOJI_RESPONSE",
        requestId,
        result,
        error,
      },
      "*"
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data) return;

    if (data.type === "HIVEMOJI_CHECK_REQUEST") {
      const available =
        !!window.hive_keychain && typeof window.hive_keychain.requestCustomJson === "function";
      respond(data.requestId, { available }, available ? undefined : "hive_keychain not found");
      return;
    }

    if (data.type !== "HIVEMOJI_REQUEST") return;
    const { requestId, owner, json, protocolId, title } = data;
    if (!requestId) return;

    if (!window.hive_keychain || typeof window.hive_keychain.requestCustomJson !== "function") {
      respond(requestId, null, "hive_keychain is not available on this page");
      return;
    }

    window.hive_keychain.requestCustomJson(
      owner,
      protocolId || "hivemoji",
      "Posting",
      json,
      title || "Hivemoji upload",
      (res) => {
        respond(requestId, res, res?.error || res?.message);
      }
    );
  });
})();
