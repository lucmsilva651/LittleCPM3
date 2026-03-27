# LittleCPM3

_Little Code on Proxmark3_

LittleCPM3 is an Electron desktop application focused on storing and retrieving text/code payloads inside **MIFARE Classic 1K** NFC cards using a **Proxmark3** device.

## Project Intent

This project is designed to:

- Store source code snippets, notes, or plain text on NFC cards.
- Read that content back in a structured and reliable way.
- Support content larger than one card by splitting data across multiple cards.
- Provide a practical GUI on top of Proxmark3 operations.

This is useful for offline demos, physical payload transfer, lab experiments, and NFC workflow prototyping.

## How the App Works (High Level)

The app has three layers:

- **Renderer (UI)**: editor, hex preview, card info, chunk controls, logs.
- **Electron main/preload bridge**: safe IPC channel between UI and backend.
- **PM3 backend utility**: runs Proxmark3 CLI commands, parses results, reads/writes blocks.

Operational flow:

1. User triggers Read/Write/Wipe from UI.
2. Renderer calls `window.pm3.*` APIs from preload.
3. Main process invokes backend PM3 operations.
4. Backend executes Proxmark3 commands (`hf mf autopwn`, dump/read/write flows).
5. Parsed results are returned to the UI.
6. UI updates editor, metadata, storage bar, and logs.

## Data Format on Card

LittleCPM3 writes a custom metadata header and payload blocks.

```text
Block 0   : Manufacturer block (read-only, ignored)
Block 1   : PM3C metadata (16 bytes)
                            [0-3]   magic "PM3C"
                            [4-7]   payload size (uint32, big-endian)
                            [8]     chunk index
                            [9]     total chunks
                            [10-11] CRC-16
                            [12-15] reserved
Blocks 2+ : payload bytes (sector trailers are skipped)
```

For MIFARE Classic 1K, usable payload is:

- **45 data blocks** × **16 bytes** = **720 bytes per card**

## Prerequisites

Assuming you already have a functional Proxmark3 setup, you still need:

- **Node.js 21 or newer**
- npm (bundled with Node.js)
- Proxmark3 CLI available in your `PATH` (for example `proxmark3` in `/usr/local/bin`)
- A connected Proxmark3 device with card read/write access

## Setup and Run

```sh
cd LittleCPM3
npm install
npm start
```

Optional development command:

```sh
npm run dev
```

## First Use Checklist (with Proxmark3 Base Already Ready)

1. Connect Proxmark3 and place a single MIFARE Classic card on the antenna.
2. Start the app with `npm start`.
3. Click **Read Card** to load existing payload (or detect blank state).
4. Edit content in the main editor.
5. Click **Write Card** to persist the payload and metadata.
6. Read again to verify round-trip consistency.

## Main Features

- **Read Card**
  - Reads PM3C metadata and payload.
  - Detects blank/non-initialized PM3C cards.
  - Updates UID, port, chunk info, storage usage.

- **Write Card**
  - Writes current editor content to the card.
  - Validates payload size against 720-byte single-card limit.
  - Stores metadata for chunked reconstruction.

- **Wipe Card**
  - Removes PM3C metadata markers used by this app.
  - Resets app-side state and editor for a clean workflow.

- **Split Editor Content**
  - Splits payloads larger than 720 bytes into card-sized chunks.
  - Loads first chunk automatically.
  - Uses chunk index/total metadata to coordinate multi-card storage.

- **Hex View**
  - Displays current editor content as hex + ASCII representation.

- **Line Counter in Editor**
  - Shows dynamic line numbers similar to code editors.
  - Stays synchronized while typing and scrolling.

- **Runtime/Log Feedback**
  - Real-time operation logs.
  - Toast notifications for success/errors.
  - Overlay and button lock while operations are running.

## Authentication and Keys

The app uses an autopwn-first strategy:

- Runs `hf mf autopwn` to discover usable keys.
- Reuses discovered keys for read/write operations when possible.
- Cleans generated artifacts (`.json`, `.bin`) after operations.

This improves compatibility with cards that do not use default keys.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+D` | Read Card |
| `Ctrl+R` | Read Card |
| `Ctrl+S` | Write Card |

## Typical Multi-Card Workflow

If your content is larger than 720 bytes:

1. Paste full text/code into the editor.
2. Click **Split editor content**.
3. Write chunk 1 to card 1.
4. Set next chunk index and write card 2.
5. Repeat until all chunks are written.

When reading, metadata indicates chunk order and total chunk count.

## Troubleshooting Notes

- Keep only one card in the RF field to avoid tag collision.
- If authentication fails, retry with the card stable on antenna so autopwn can finish.
- Ensure your OS user has serial permissions for Proxmark3 (`/dev/ttyACM*` on Linux).
- If no payload is found, card may be blank for PM3C format.

## Scope and Limitations

- Focused on **MIFARE Classic 1K** workflows.
- Designed for text/code payload storage, not for general card cloning use cases.
- Very large payloads require manual multi-card handling.

## License

&copy; 2026 Lucas Gabriel (lucmsilva). Licensed under [BSD-3-Clause](LICENSE).
