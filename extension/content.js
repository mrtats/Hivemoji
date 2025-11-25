(function () {
  const pending = new Map();

  const DEFAULT_HOSTS = ["hive.blog", "peakd.com", "ecency.com"];
  const EMOJI_REGEX = /:([a-z0-9_]{1,32}):/g;
  const CONTENT_SELECTORS = [
    "article",
    ".markdown-body",
    ".post-content",
    ".entry-content",
    ".Story__body",
    ".Story__content",
    ".Post__content",
	".body-preview",
    ".PostFull__body",
    ".MarkdownViewer",
    ".MarkdownViewer__html",
	".MarkdownViewer.Markdown",
    ".markdown",
    ".markdown-view",
    ".md-view",
    ".richtext",
    ".RichTextViewer",
    ".rich-text",
    ".article-body",
    ".post-body",
	".snap-body",
    ".post-view",
	".entry-body",
    "[data-post-body]",
  ];
  const registryCache = new Map(); // owner -> Promise<{registry, ts}>
  let pendingElements = new Set();
  let scheduled = false;
  let stylesInjected = false;

  function base64TooLarge(base64, maxBytes = 6000) {
    if (!base64) return false;
    const approxBytes = Math.floor((base64.length * 3) / 4);
    return approxBytes > maxBytes;
  }

  function injectInpage() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inpage.js");
    script.type = "text/javascript";
    script.onload = () => script.remove();
    (document.documentElement || document.head || document.body).appendChild(script);
  }

  injectInpage();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== "HIVEMOJI_RESPONSE" || !data.requestId) return;
    const entry = pending.get(data.requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    pending.delete(data.requestId);
    entry.sendResponse(data.result || { error: data.error || "Unknown response" });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (message.type !== "HIVEMOJI_BROADCAST" && message.type !== "HIVEMOJI_CHECK")) return;
    const requestId =
      (crypto && crypto.randomUUID && crypto.randomUUID()) ||
      `hve-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const timeout = setTimeout(() => {
      pending.delete(requestId);
      sendResponse({ error: "Timed out waiting for hive-keychain response" });
    }, 20000);

    pending.set(requestId, { sendResponse, timeout });

    const payload =
      message.type === "HIVEMOJI_CHECK"
        ? { type: "HIVEMOJI_CHECK_REQUEST", requestId }
        : {
            type: "HIVEMOJI_REQUEST",
            requestId,
            owner: message.owner,
            json: message.json,
            protocolId: message.protocolId,
            title: message.title,
          };

    window.postMessage(payload, "*");

    return true; // keep sendResponse alive
  });

  function buildDataUrl(mime, base64) {
    return `data:${mime};base64,${base64}`;
  }

  function processTargets(root) {
    return CONTENT_SELECTORS.flatMap((sel) => Array.from(root.querySelectorAll(sel)));
  }

  function base64ToBytes(base64) {
    const bin = atob(base64);
    const len = bin.length;
    const arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  function selectImage(def, allowAnimation = true) {
    if (allowAnimation && def.animated !== false) return { mime: def.mime, data: def.data, width: def.width, height: def.height };
    if (def.fallback) return { mime: def.fallback.mime, data: def.fallback.data, width: def.width, height: def.height };
    return { mime: def.mime, data: def.data, width: def.width, height: def.height };
  }

  function setImportant(el, prop, value) {
    el.style.setProperty(prop, value, "important");
  }

  function createEmojiElement(name, def) {
    const { mime, data, width, height } = selectImage(def, true);
    const size = "clamp(16px, 1em, 32px)";
    const maxDim = 256;
    const safeWidth = Math.min(width || 32, maxDim);
    const safeHeight = Math.min(height || 32, maxDim);
    const img = document.createElement("img");
    img.className = "hivemoji";
    img.alt = `:${name}:`;
    img.width = safeWidth;
    img.height = safeHeight;
    img.loading = "lazy";
    img.src = buildDataUrl(mime, data);
    setImportant(img, "display", "inline-block");
    setImportant(img, "width", size);
    setImportant(img, "height", size);
    setImportant(img, "vertical-align", "-0.1em");
    setImportant(img, "image-rendering", "auto");
    setImportant(img, "object-fit", "contain");
    setImportant(img, "max-width", size);
    setImportant(img, "max-height", size);
    setImportant(img, "min-width", size);
    setImportant(img, "min-height", size);
    setImportant(img, "filter", "none");
    setImportant(img, "opacity", "1");
    setImportant(img, "visibility", "visible");
    return img;
  }

  async function fetchRegistry(owner) {
    const now = Date.now();
    const cached = registryCache.get(owner);
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.registry;

    const body = {
      jsonrpc: "2.0",
      method: "condenser_api.get_account_history",
      params: [owner, -1, 1000],
      id: 1,
    };
    const res = await fetch("https://api.hive.blog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const history = json.result || [];
    const registry = new Map();
    for (const [, opObj] of history) {
      const op = opObj.op || opObj[1];
      if (!Array.isArray(op)) continue;
      const [opName, data] = op;
      if (opName !== "custom_json") continue;
      if (data.id !== "hivemoji") continue;
      let payload;
      try {
        payload = typeof data.json === "string" ? JSON.parse(data.json) : data.json;
      } catch {
        continue;
      }
      if (!payload || payload.version !== 1) continue;
      if (payload.op === "delete") {
        registry.set(payload.name, { deleted: true });
        continue;
      }
      if (payload.op === "register" || payload.op === "update") {
        const width = Number(payload.width);
        const height = Number(payload.height);
        if (!payload.data || !payload.mime) continue;
        if (base64TooLarge(payload.data)) continue;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
        const mime = String(payload.mime).toLowerCase();
        const allowedMime = mime.startsWith("image/png") || mime.startsWith("image/webp") || mime.startsWith("image/gif") || mime.startsWith("image/jpeg");
        if (!allowedMime) continue;
        if (payload.fallback && payload.fallback.mime) {
          const fbMime = String(payload.fallback.mime).toLowerCase();
          const fbAllowed =
            fbMime.startsWith("image/png") ||
            fbMime.startsWith("image/webp") ||
            fbMime.startsWith("image/gif") ||
            fbMime.startsWith("image/jpeg");
          if (!fbAllowed) continue;
          if (base64TooLarge(payload.fallback.data)) continue;
        }
        registry.set(payload.name, {
          owner,
          name: payload.name,
          mime,
          width,
          height,
          animated: payload.animated,
          loop: payload.loop,
          data: payload.data,
          fallback: payload.fallback,
          deleted: false,
        });
      }
    }
    registryCache.set(owner, { registry, ts: now });
    return registry;
  }

  function inferOwner(node) {
    const extractAuthor = (str) => {
      if (!str) return null;
      const m =
        str.match(/\/@([a-z0-9\.-]+)/i) ||
        str.match(/@([a-z0-9\.-]+)/i);
      return m ? m[1] : null;
    };

    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const attrNames = ["data-author", "data-author-name", "data-owner", "data-hive-author", "data-user"];
    while (el) {
      for (const attr of attrNames) {
        if (el.hasAttribute && el.hasAttribute(attr)) {
          return (el.getAttribute(attr) || "").replace(/^@/, "").trim();
        }
      }
      el = el.parentElement;
    }

    const pathAuthor = extractAuthor(location.pathname);
    if (pathAuthor) return pathAuthor;

    const metaAuthor =
      document.querySelector('meta[name="author"]') ||
      document.querySelector('meta[property="article:author"]') ||
      document.querySelector('meta[name="article:author"]');
    const metaAuthorVal = extractAuthor(metaAuthor?.content);
    if (metaAuthorVal) return metaAuthorVal;

    const doc = document;
    const authorLink =
      doc.querySelector('.Author a[href*="/@"]') ||
      doc.querySelector('a[rel="author"]') ||
      doc.querySelector('a[itemprop="author"]') ||
      doc.querySelector('a[href^="/@"]');
    const linkAuthor = extractAuthor(authorLink?.href);
    if (linkAuthor) return linkAuthor;
    return null;
  }

  function replaceTextNode(node, registry) {
    const text = node.textContent;
    if (!text || !text.includes(":")) return;
    let changed = false;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(EMOJI_REGEX)) {
      const [full, name] = match;
      const def = registry.get(name);
      if (!def || def.deleted) continue;
      const before = text.slice(lastIndex, match.index);
      if (before) frag.appendChild(document.createTextNode(before));
      const span = document.createElement("span");
      span.className = "hivemoji-wrap";
      setImportant(span, "display", "inline-flex");
      setImportant(span, "align-items", "center");
      setImportant(span, "line-height", "inherit");
      setImportant(span, "vertical-align", "-0.1em");
      setImportant(span, "font-size", "inherit");
      const img = createEmojiElement(name, def);
      span.appendChild(img);
      frag.appendChild(span);
      lastIndex = match.index + full.length;
      changed = true;
    }
    if (!changed) return;
    const tail = text.slice(lastIndex);
    if (tail) frag.appendChild(document.createTextNode(tail));
    node.replaceWith(frag);
  }

  async function processElement(el) {
    const owner = inferOwner(el);
    if (!owner) return;
    if (!el || !el.textContent || !el.textContent.includes(":")) return;
    let registry;
    try {
      registry = await fetchRegistry(owner);
    } catch (err) {
      // ignore fetch errors
      return;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes(":")) return NodeFilter.FILTER_SKIP;
        const parent = node.parentElement;
        if (!parent || /^(script|style|textarea|code|pre|input)$/i.test(parent.tagName)) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => replaceTextNode(n, registry));
  }

  function scheduleProcess(el) {
    if (!el) return;
    pendingElements.add(el);
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      const toProcess = Array.from(pendingElements);
      pendingElements = new Set();
      scheduled = false;
      toProcess.forEach((el) => processElement(el));
    });
  }

  function injectStyles() {
    if (stylesInjected) return;
    const size = "clamp(16px, 1em, 32px)";
    const style = document.createElement("style");
    style.textContent = `
.hivemoji { width: ${size} !important; height: ${size} !important; min-width: ${size} !important; min-height: ${size} !important; vertical-align: -0.1em !important; image-rendering: auto !important; object-fit: contain !important; display: inline-block !important; opacity: 1 !important; visibility: visible !important; filter: none !important; max-width: ${size} !important; max-height: ${size} !important; }
.hivemoji-wrap { display: inline-flex !important; align-items: center !important; line-height: inherit !important; vertical-align: -0.1em !important; font-size: inherit !important; }
/* peakd snap view hides all imgs inside snap-body; force show ours */
.snap-body.post-body[data-v-dea2ba5a] img.hivemoji,
.snap-body.post-body[data-v-dea2ba5a] .hivemoji,
.snap-body.post-body img.hivemoji,
.snap-body.post-body .hivemoji,
.snap-body img.hivemoji,
.snap-body .hivemoji,
.snap-embed img.hivemoji,
.snap-embed .hivemoji,
.panel-snap img.hivemoji,
.panel-snap .hivemoji { display: inline-block !important; visibility: visible !important; opacity: 1 !important; }
.snap-body .hivemoji-wrap,
.snap-embed .hivemoji-wrap,
.panel-snap .hivemoji-wrap { display: inline-flex !important; visibility: visible !important; opacity: 1 !important; }
/* hive.blog/ecency generic overrides */
.markdown-body img.hivemoji,
.markdown-view img.hivemoji,
.entry-body img.hivemoji,
.RichTextViewer img.hivemoji,
.md-view img.hivemoji,
.article-body img.hivemoji,
.post-body img.hivemoji,
.content-group img.hivemoji { display: inline-block !important; visibility: visible !important; opacity: 1 !important; }
.entry-body .hivemoji-wrap,
.markdown-view .hivemoji-wrap { display: inline-flex !important; visibility: visible !important; opacity: 1 !important; }
`;
    (document.head || document.documentElement).appendChild(style);
    stylesInjected = true;
  }

  async function runRendererIfAllowed() {
    const host = location.hostname;
    chrome.storage.sync.get({ hivemojiHosts: DEFAULT_HOSTS }, (data) => {
      const allowed = data.hivemojiHosts || DEFAULT_HOSTS;
      const allowedMatch = allowed.some((h) => host === h || host.endsWith(`.${h}`));
      if (!allowedMatch) return;
      injectStyles();
      const targets = processTargets(document);
      targets.forEach((el) => scheduleProcess(el));

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (node.matches && CONTENT_SELECTORS.some((sel) => node.matches(sel))) {
                scheduleProcess(node);
              }
              processTargets(node).forEach((child) => scheduleProcess(child));
              if (node.shadowRoot) {
                processTargets(node.shadowRoot).forEach((child) => scheduleProcess(child));
              }
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  runRendererIfAllowed();
})();
