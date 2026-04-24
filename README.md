# DeepShot

A Chrome extension for full-page screenshots that actually handles **nested scrollable containers** — virtualized tables, inner scroll panes, embedded feeds — and exports to **PNG, PDF, or Markdown**.

Most full-page screenshot tools only scroll the main page. DeepShot walks every scrollable element on the page, captures each section, and stitches them into a single image or document. For tables and grids, the Markdown export preserves rows and columns using positional grid detection — even for virtual-scrolled grids that only render what's visible.

## Features

- **Capture (Expand Scrolls)** — detects every nested scrollable area, scrolls through each one, and stitches the full content into one output.
- **Capture (Normal)** — standard full-page capture without expanding inner scrollables.
- **Select Region** — drag a box over the page; the selection auto-scrolls the outer page when you drag near the viewport edge, and inner scrollables intersecting the box are expanded too.
- **Output formats**:
  - **PNG** — single stitched image.
  - **PDF** — multi-page, sized to fit the captured content.
  - **Markdown** — text + tables. Uses bounding-rect positional detection (works with `<table>`, CSS grids, flex layouts), strips sidebars/charts/nav chrome, and handles virtual-scrolling grids by incrementally extracting rows as it scrolls.

## Installation

Load unpacked from source:

1. Clone this repo.
2. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the cloned folder.
5. Pin the DeepShot icon to your toolbar for quick access.

## Usage

1. Click the DeepShot toolbar icon on any page.
2. Pick an output format: PNG, PDF, or Markdown.
3. Pick a capture mode:
   - **Capture (Expand Scrolls)** for full content including nested scrolls.
   - **Capture (Normal)** for a straight full-page shot.
   - **Select Region** to drag over just the part you want.
4. Wait for the capture to complete — the file downloads automatically.

## Permissions

- `activeTab` — access the current tab when you click the icon.
- `scripting` — inject the capture/selection logic into the page.
- `downloads` — save the output file.

No data leaves your browser. No network calls. No analytics.

## How it works

The background service worker orchestrates the capture:

1. Injects a content script that finds all scrollable elements (including nested ones) and records their scroll geometry.
2. For each scrollable, the page is scrolled section-by-section; at each position the visible viewport is captured via `chrome.tabs.captureVisibleTab`.
3. Captures are stitched on an `OffscreenCanvas` with overlap deduplication.
4. For Markdown, the content script walks the live DOM at each scroll position, identifies tables/grids by bounding rectangles, deduplicates rows across scroll steps, and emits clean Markdown.

## License

MIT
