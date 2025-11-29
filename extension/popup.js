import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  MAX_JSON_BYTES,
  validateName,
  readImageFile,
  jsonSizeBytes,
} from "./utils.js";

const MAX_CHUNK_DATA_BYTES = 4 * 1024; // raw bytes per chunk before base64
const MAX_TOTAL_BYTES = 100 * 1024;
const MAX_CHUNKS = 50;
const arrayBufferToBase64 = (bytes) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const form = document.getElementById("emojiForm");
const fileFields = document.getElementById("fileFields");
const payloadDisplay = document.getElementById("payloadDisplay");
const statusEl = document.getElementById("status");

const ownerInput = document.getElementById("owner");
const nameInput = document.getElementById("name");
const opSelect = document.getElementById("operation");
const fileInput = document.getElementById("file");
const fallbackInput = document.getElementById("fallback");
const animatedInput = document.getElementById("animated");
const loopInput = document.getElementById("loop");
const buildBtn = document.getElementById("buildBtn");
const hostInput = document.getElementById("hostInput");
const addHostBtn = document.getElementById("addHostBtn");
const hostList = document.getElementById("hostList");

const DEFAULT_HOSTS = ["hive.blog", "peakd.com", "ecency.com"];

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(tabs || []);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(response);
    });
  });
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function toggleFileFields() {
  const op = opSelect.value;
  if (op === "delete") {
    fileFields.classList.add("hidden");
  } else {
    fileFields.classList.remove("hidden");
  }
}

async function buildPayload({ opOverride } = {}) {
  const owner = ownerInput.value.trim();
  const name = nameInput.value.trim();
  const op = opOverride || opSelect.value;

  if (!owner) throw new Error("Owner is required");
  validateName(name);

  if (op === "delete") {
    const payload = { op: "delete", version: PROTOCOL_VERSION, name };
    const size = jsonSizeBytes(payload);
    if (size > MAX_JSON_BYTES) {
      throw new Error(`Payload is ${size} bytes (> ${MAX_JSON_BYTES})`);
    }
    return { payloads: [payload], json: [JSON.stringify(payload)], size, owner };
  }

  const file = fileInput.files?.[0];
  if (!file) throw new Error("Select an emoji file");
  const mainImage = await readImageFile(file);
  const fallbackFile = fallbackInput.files?.[0];
  const fallbackImage = fallbackFile ? await readImageFile(fallbackFile) : undefined;

  const animated =
    animatedInput.checked || mainImage.animatedHint || mainImage.loopHint
      ? true
      : undefined;
  const loop = loopInput.checked ? true : undefined;

  const basePayload = {
    op,
    version: PROTOCOL_VERSION,
    name,
    mime: mainImage.mime,
    width: mainImage.width,
    height: mainImage.height,
    data: mainImage.data,
  };
  if (animated !== undefined) basePayload.animated = animated;
  if (loop !== undefined) basePayload.loop = loop;
  if (fallbackImage) {
    basePayload.fallback = { mime: fallbackImage.mime, data: fallbackImage.data };
  }

  const singleSize = jsonSizeBytes(basePayload);
  if (singleSize <= MAX_JSON_BYTES) {
    return { payloads: [basePayload], json: [JSON.stringify(basePayload)], size: singleSize, owner };
  }

  // Chunked v2
  const uploadId = `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const chunkImage = async (img, kind = "main") => {
    const total = Math.ceil(img.buffer.length / MAX_CHUNK_DATA_BYTES);
    if (total > MAX_CHUNKS) {
      throw new Error(`Image too large: requires ${total} chunks (> ${MAX_CHUNKS}).`);
    }
    if (img.buffer.length > MAX_TOTAL_BYTES) {
      throw new Error(`Image too large: ${img.buffer.length} bytes (> ${MAX_TOTAL_BYTES}).`);
    }

    let checksumHex;
    try {
      const digest = await crypto.subtle.digest("SHA-256", img.buffer);
      const hashArray = Array.from(new Uint8Array(digest));
      checksumHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      checksumHex = undefined;
    }

    const chunks = [];
    for (let i = 0; i < total; i++) {
      const slice = img.buffer.subarray(i * MAX_CHUNK_DATA_BYTES, (i + 1) * MAX_CHUNK_DATA_BYTES);
      const dataB64 = arrayBufferToBase64(slice);
      const payload = {
        version: 2,
        op: "chunk",
        id: uploadId,
        name,
        mime: img.mime,
        width: img.width,
        height: img.height,
        animated,
        loop,
        seq: i + 1,
        total,
        data: dataB64,
        kind: kind === "fallback" ? "fallback" : "main",
      };
      if (checksumHex) payload.checksum = checksumHex;
      chunks.push(payload);
    }
    return chunks;
  };

  const mainChunks = await chunkImage(mainImage, "main");
  let fbChunks = [];
  if (fallbackImage) {
    fbChunks = await chunkImage(fallbackImage, "fallback");
  }

  // Small manifest so indexers that rely on a register-like op can detect this emoji.
  const manifest = {
    version: 2,
    op: "register",
    name,
    mime: mainImage.mime,
    width: mainImage.width,
    height: mainImage.height,
    animated,
    loop,
    chunked: true,
    id: uploadId,
    main_total: mainChunks.length,
    fallback_total: fbChunks.length || undefined,
  };

  const allPayloads = [...mainChunks, ...fbChunks, manifest];
  const json = allPayloads.map((p) => JSON.stringify(p));
  const totalSize = allPayloads.reduce((sum, p) => sum + jsonSizeBytes(p), 0);

  return { payloads: allPayloads, json, size: totalSize, owner };
}

function renderPayloadPreview(payloads, size) {
  payloadDisplay.textContent =
    (payloads.length === 1
      ? JSON.stringify(payloads[0], null, 2)
      : payloads
          .map((p, i) => `#${i + 1}/${payloads.length}\n${JSON.stringify(p, null, 2)}`)
          .join("\n\n")) + `\n\nTotal size: ${size} bytes`;
}

async function broadcastViaKeychain(json, owner, title) {
  const tabs = await queryActiveTab();
  const [tab] = tabs;
  if (!tab?.id) {
    throw new Error("No active tab available to reach hive-keychain");
  }
  const response = await sendMessageToTab(tab.id, {
    type: "HIVEMOJI_BROADCAST",
    owner,
    json,
    protocolId: PROTOCOL_ID,
    title,
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

async function handleBuild() {
  try {
    setStatus("");
    const { payloads, size } = await buildPayload();
    renderPayloadPreview(payloads, size);
    setStatus("Payload ready. You can broadcast via Keychain.");
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

async function handleBroadcast(event) {
  event.preventDefault();
  try {
    setStatus("Building payload...");
    const { payloads, json, size, owner } = await buildPayload();
    renderPayloadPreview(payloads, size);
    setStatus("Requesting hive-keychain...");
    for (let i = 0; i < json.length; i++) {
      const payload = payloads[i];
      const title = `Hivemoji ${payload.op}: :${payload.name}: (${i + 1}/${json.length})`;
      await broadcastViaKeychain(json[i], owner, title);
      setStatus(`Broadcasted ${i + 1}/${json.length}...`);
    }
    setStatus("All broadcasts sent. Check hive-keychain for status.");
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function normalizeHost(input) {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname;
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0];
  }
}

async function loadHosts() {
  return new Promise((resolve) => {
    const storage = (chrome.storage && chrome.storage.sync) || chrome.storage.local;
    storage.get({ hivemojiHosts: DEFAULT_HOSTS }, (data = {}) => {
      resolve((data && data.hivemojiHosts) || DEFAULT_HOSTS);
    });
  });
}

async function saveHosts(hosts) {
  return new Promise((resolve, reject) => {
    const storage = (chrome.storage && chrome.storage.sync) || chrome.storage.local;
    storage.set({ hivemojiHosts: hosts }, () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve();
    });
  });
}

async function renderHosts() {
  const hosts = await loadHosts();
  hostList.innerHTML = "";
  hosts.forEach((host) => {
    const chip = document.createElement("div");
    chip.className = "host-chip";
    chip.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "x";
    btn.addEventListener("click", async () => {
      const next = hosts.filter((h) => h !== host);
      await saveHosts(next);
      renderHosts();
    });
    chip.appendChild(btn);
    hostList.appendChild(chip);
  });
}

async function handleAddHost() {
  const host = normalizeHost(hostInput.value);
  if (!host) return;
  const hosts = await loadHosts();
  if (!hosts.includes(host)) {
    hosts.push(host);
    await saveHosts(hosts);
  }
  hostInput.value = "";
  renderHosts();
}

opSelect.addEventListener("change", toggleFileFields);
buildBtn.addEventListener("click", () => handleBuild());
form.addEventListener("submit", handleBroadcast);
addHostBtn.addEventListener("click", handleAddHost);
hostInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleAddHost();
  }
});

toggleFileFields();
renderHosts();
