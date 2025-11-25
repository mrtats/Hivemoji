import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  MAX_JSON_BYTES,
  validateName,
  readImageFile,
  jsonSizeBytes,
} from "./utils.js";

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
    return { payload, json: JSON.stringify(payload), size, owner };
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

  const payload = {
    op,
    version: PROTOCOL_VERSION,
    name,
    mime: mainImage.mime,
    width: mainImage.width,
    height: mainImage.height,
    data: mainImage.data,
  };
  if (animated !== undefined) payload.animated = animated;
  if (loop !== undefined) payload.loop = loop;
  if (fallbackImage) {
    payload.fallback = { mime: fallbackImage.mime, data: fallbackImage.data };
  }

  const size = jsonSizeBytes(payload);
  if (size > MAX_JSON_BYTES) {
    throw new Error(`Payload is ${size} bytes (> ${MAX_JSON_BYTES})`);
  }

  return { payload, json: JSON.stringify(payload), size, owner };
}

function renderPayloadPreview(payload, size) {
  payloadDisplay.textContent = JSON.stringify(payload, null, 2) + `\n\n${size} bytes`;
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
    const { payload, size } = await buildPayload();
    renderPayloadPreview(payload, size);
    setStatus("Payload ready. You can broadcast via Keychain.");
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

async function handleBroadcast(event) {
  event.preventDefault();
  try {
    setStatus("Building payload...");
    const { payload, json, size, owner } = await buildPayload();
    renderPayloadPreview(payload, size);
    setStatus("Requesting hive-keychain...");
    const title = `Hivemoji ${payload.op}: :${payload.name}:`;
    const res = await broadcastViaKeychain(json, owner, title);
    setStatus(res?.result ? "Broadcast sent. Check hive-keychain for status." : "Request sent.");
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
    chrome.storage.sync.get({ hivemojiHosts: DEFAULT_HOSTS }, (data) => {
      resolve(data.hivemojiHosts || DEFAULT_HOSTS);
    });
  });
}

async function saveHosts(hosts) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ hivemojiHosts: hosts }, () => {
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
