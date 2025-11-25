# Hivemoji v0.1

On-chain custom emoji protocol tools for Hive. Ships a Chrome extension uploader (Hive Keychain powered) plus a Node library/CLI, indexer, and renderer helper that stay fully on-chain (no external image hosting).

## Features

- Validates PNG/WebP/GIF/APNG images and base64-encodes them for Hive `custom_json`.
- Chrome extension can also render `:emoji:` inline on allowed sites (defaults: hive.blog, peakd.com, ecency.com) by fetching on-chain definitions.
- Indexer to consume `custom_json` ops with `id="hivemoji"` and build an `(owner,name)` registry.
- Renderer that replaces `:name:` tokens in post bodies with `<img src="data:...">` using on-chain bytes only.

## Chrome Extension (Hive Keychain)

1) Install the official Hive Keychain browser extension and ensure you are logged in.
2) In Chrome/Brave: `chrome://extensions` -> toggle Developer Mode -> "Load unpacked" -> select the `extension` folder in this repo.
3) Pin "Hivemoji Uploader". Open it while you're on any normal web page (Keychain injects per page).
4) Fill in owner, emoji name, choose `register/update/delete`, attach a 32x32 PNG/WebP/GIF, optionally set animated/loop and fallback.
5) Click "Broadcast via Keychain". The payload is validated for size/format; Keychain prompts you to sign a `custom_json` with `id=hivemoji`.

Notes:
- The popup needs an active tab that Keychain can inject into (not `chrome://` pages). If Keychain isn't detected, you'll see an error.
- JSON is capped at ~8 KB and raw image at 5 KB to stay under Hive's limits.
- Renderer: the popup lets you add/remove hostnames. On allowed hosts, the content script fetches emoji definitions for each post author (via Hive RPC) and replaces `:name:` tokens in article bodies with `<img>` tags. Works best on hive.blog, peakd.com, and ecency.com; other sites may need a refresh or specific attributes for author detection.



## Protocol (v1)

- `custom_json.id`: `hivemoji`
- Shared fields: `op` (`register` | `update` | `delete`), `version` (`1`), `name` (`[a-z0-9_]{1,32}`)
- Register/update fields: `mime`, `width` (`32`), `height` (`32`), `data` (base64 image bytes), optional `animated`, `loop`, `fallback { mime, data }`.
- Delete fields: `op: "delete"`, `name`.
- Payload size: defensive cap of `<= 8 KB` JSON string; raw image size recommended `<= 5 KB` before base64.

## Notes

- Image validation is header-based (PNG/WebP/GIF/APNG)
- Animated hints are derived from headers when possible; renderer still falls back safely when `allowAnimation` is false.
- No external storage is used - rendering builds `data:` URLs directly from on-chain bytes.
