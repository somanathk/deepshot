# Privacy Policy

_Last updated: 2026-04-24_

DeepShot is a Chrome extension that captures full-page screenshots of the active tab when you ask it to.

## Data collection

**DeepShot does not collect, transmit, store, or share any personal data.**

- No analytics.
- No telemetry.
- No remote servers.
- No third-party APIs.
- No account, no sign-in.

## Data handling

All processing happens locally, inside your browser:

1. When you click the DeepShot toolbar icon and press a capture button, the extension runs a script on the current tab to detect scrollable regions, scroll through them, capture viewport frames, and stitch them into a single image or document.
2. The resulting PNG, PDF, or Markdown file is saved to your local Downloads folder using Chrome's built-in `downloads` API.
3. The captured content is never sent anywhere off your device.

## Permissions and why they exist

- **activeTab** — grants DeepShot access to the current tab only when you click the toolbar icon. It cannot read tabs you haven't explicitly activated it on.
- **scripting** — required to inject the capture logic into the current page so it can walk the DOM, find nested scrollables, and extract content.
- **downloads** — required to save the captured screenshot/PDF/Markdown file to your Downloads folder.

DeepShot does **not** request `host_permissions` for any URL and has no background access to your browsing.

## Source code

DeepShot is open source. You can audit every line at:
https://github.com/somanathk/deepshot

## Contact

For questions about this policy, open an issue at https://github.com/somanathk/deepshot/issues.
