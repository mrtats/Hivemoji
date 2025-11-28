(function () {
  const pending = new Map();

  const PROTOCOL_ID = "hivemoji";
  const DEFAULT_HOSTS = ["hive.blog", "peakd.com", "ecency.com"];
  const EMOJI_REGEX = /:([a-z0-9._-]+\/)?([a-z0-9_]{1,32}):/g; // supports :name: and :owner/name:
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
  const registryCache = new Map(); // owner -> {registry, ts} | {promise}
  let pendingElements = new Set();
  let scheduled = false;
  let stylesInjected = false;
  const ALLOWED_MIMES = ["image/png", "image/webp", "image/gif", "image/jpeg"];
  const API_BASE_URL = "https://hivemoji.hivelytics.io";
  const MAX_EMOJI_BYTES = 100 * 1024;
  const MEMORY_TTL_MS = 60 * 60 * 1000; // 1h
  const PERSIST_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  const storageKeyForOwner = (owner) => `hivemoji_registry_${owner}`;

  function readPersistedRegistry(owner) {
    return new Promise((resolve) => {
      const key = storageKeyForOwner(owner);
      chrome.storage.local.get(key, (data) => {
        if (chrome.runtime.lastError) return resolve(null);
        const entry = data[key];
        if (!entry || !Array.isArray(entry.entries)) return resolve(null);
        resolve({ registry: new Map(entry.entries), ts: Number(entry.ts) || 0 });
      });
    });
  }

  function persistRegistry(owner, registry, ts) {
    return new Promise((resolve) => {
      const key = storageKeyForOwner(owner);
      const payload = { ts, entries: Array.from(registry.entries()) };
      chrome.storage.local.set({ [key]: payload }, () => resolve());
    });
  }

  function base64Size(base64) {
    const len = base64.length;
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((len * 3) / 4) - padding;
  }

  function base64TooLarge(base64, maxBytes = 6000) {
    if (!base64) return false;
    return base64Size(base64) > maxBytes;
  }

  function isAllowedMime(mime) {
    if (!mime) return false;
    const lower = String(mime).toLowerCase();
    return ALLOWED_MIMES.some((m) => lower.startsWith(m));
  }

  function clampPositiveNumber(n, fallback = 32) {
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return num;
  }

  function collectEmojiNeeds(text, inferredOwner) {
    const needs = new Map();
    if (!text || !text.includes(":")) return needs;
    EMOJI_REGEX.lastIndex = 0;
    for (const match of text.matchAll(EMOJI_REGEX)) {
      const rawOwner = match[1] ? match[1].slice(0, -1) : null; // drop trailing slash
      const owner = rawOwner || inferredOwner;
      const name = match[2];
      if (!owner || !name) continue;
      const set = needs.get(owner) || new Set();
      set.add(name);
      needs.set(owner, set);
    }
    return needs;
  }

  function hasAllNames(registry, names) {
    if (!names || !names.size) return true;
    for (const name of names) {
      if (!registry.has(name)) return false;
    }
    return true;
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

  function fetchViaBackground(url) {
    return new Promise((resolve) => {
      if (!chrome?.runtime?.id || !chrome.runtime?.sendMessage) return resolve(null);
      try {
        chrome.runtime.sendMessage({ type: "HIVEMOJI_FETCH_JSON", url }, (response) => {
          if (chrome.runtime.lastError) {
            return resolve({ error: chrome.runtime.lastError.message });
          }
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function fetchJson(url) {
    const bg = await fetchViaBackground(url);
    if (bg) {
      if (bg.error) throw new Error(bg.error);
      if (!bg.ok) throw new Error(`API responded with ${bg.status || "error"}`);
      if (bg.json !== undefined) return bg.json;
      if (bg.text) {
        try {
          return JSON.parse(bg.text);
        } catch (err) {
          throw new Error("Failed to parse API response");
        }
      }
      throw new Error("Empty API response");
    }
    const res = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(`API responded with ${res.status}`);
    return res.json();
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

  async function fetchRegistry(owner, neededNames = null) {
    const now = Date.now();
    const cached = registryCache.get(owner);
    if (cached?.registry && now - cached.ts < MEMORY_TTL_MS && hasAllNames(cached.registry, neededNames)) {
      return cached.registry;
    }
    if (cached?.promise) {
      const reg = await cached.promise;
      if (hasAllNames(reg, neededNames)) return reg;
    }

    const promise = (async () => {
      const persisted = await readPersistedRegistry(owner);
      const persistedNow = Date.now();
      let seedRegistry = new Map();
      if (persisted && persistedNow - persisted.ts < PERSIST_TTL_MS) {
        if (hasAllNames(persisted.registry, neededNames)) {
          registryCache.set(owner, { registry: persisted.registry, ts: persisted.ts });
          return persisted.registry;
        }
        seedRegistry = persisted.registry;
      } else if (cached?.registry) {
        seedRegistry = cached.registry;
      }

      let emojis = [];
      try {
        const json = await fetchJson(`${API_BASE_URL}/api/authors/${encodeURIComponent(owner)}/emojis?with_data=1`);
        if (Array.isArray(json)) {
          emojis = json;
        }
      } catch {
        if (seedRegistry.size && hasAllNames(seedRegistry, neededNames)) {
          registryCache.set(owner, { registry: seedRegistry, ts: persisted?.ts || now });
          return seedRegistry;
        }
        throw new Error("Failed to fetch hivemoji registry");
      }

      const registry = new Map(seedRegistry);
      const normalizeFallback = (emoji) => {
        const fallbackData = emoji.fallback_data || emoji.fallbackData;
        const fallbackMime = emoji.fallback_mime || emoji.fallbackMime;
        if (!fallbackData) return null;
        if (fallbackMime && !isAllowedMime(fallbackMime)) return null;
        if (base64TooLarge(fallbackData, MAX_EMOJI_BYTES)) return null;
        return { mime: fallbackMime || emoji.mime, data: fallbackData };
      };

      emojis.forEach((emoji) => {
        if (!emoji?.name || !emoji?.mime || !emoji?.data) return;
        if (!isAllowedMime(emoji.mime)) return;
        if (base64TooLarge(emoji.data, MAX_EMOJI_BYTES)) return;
        const width = clampPositiveNumber(emoji.width, 32);
        const height = clampPositiveNumber(emoji.height, 32);
        const entry = {
          owner: emoji.author || owner,
          name: emoji.name,
          mime: emoji.mime,
          width,
          height,
          animated: emoji.animated,
          loop: emoji.loop,
          data: emoji.data,
          fallback: normalizeFallback(emoji) || undefined,
          deleted: false,
        };
        registry.set(emoji.name, entry);
      });

      const ts = Date.now();
      registryCache.set(owner, { registry, ts });
      await persistRegistry(owner, registry, ts);
      return registry;
    })().catch((err) => {
      registryCache.delete(owner);
      throw err;
    });

    registryCache.set(owner, { promise });
    return promise;
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

  function replaceTextNode(node, registries, defaultOwner) {
    const text = node.textContent;
    if (!text || !text.includes(":")) return;
    let changed = false;
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    EMOJI_REGEX.lastIndex = 0;
    for (const match of text.matchAll(EMOJI_REGEX)) {
      const [full, ownerPart, name] = match;
      const owner = ownerPart ? ownerPart.slice(0, -1) : defaultOwner;
      if (!owner) continue;
      const registry = registries.get(owner);
      const def = registry?.get(name);
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
    if (!owner && !el?.textContent?.includes(":")) return;
    const needs = collectEmojiNeeds(el?.textContent || "", owner);
    if (!needs.size) return;
    const registries = new Map();
    try {
      await Promise.all(
        Array.from(needs.entries()).map(async ([own, names]) => {
          const reg = await fetchRegistry(own, names);
          registries.set(own, reg);
        })
      );
    } catch (err) {
      return;
    }
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = node.nodeValue;
        if (!value || !value.includes(":")) return NodeFilter.FILTER_SKIP;
        EMOJI_REGEX.lastIndex = 0;
        if (!EMOJI_REGEX.test(value)) return NodeFilter.FILTER_SKIP;
        const parent = node.parentElement;
        if (!parent || /^(script|style|textarea|code|pre|input)$/i.test(parent.tagName)) {
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => replaceTextNode(n, registries, owner));
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
    const storage = (chrome.storage && chrome.storage.sync) || chrome.storage.local;
    storage.get({ hivemojiHosts: DEFAULT_HOSTS }, (data = {}) => {
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
