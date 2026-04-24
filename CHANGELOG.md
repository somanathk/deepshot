# Changelog

All notable changes to DeepShot are documented here. Versioning follows [Semantic Versioning](https://semver.org/).

## [1.1] - 2026-04-24

Initial public release.

### Added
- Full-page screenshot capture with support for nested scrollable containers (virtualized tables, inner scroll panes, embedded feeds).
- Horizontal and vertical inner-scroll handling — scrolls each scrollable section-by-section and stitches the captures.
- Three output formats: PNG, PDF, and Markdown.
- Markdown export with bounding-rect positional grid detection that works across `<table>`, CSS grid, and flex layouts.
- Incremental scroll-and-extract for virtual-scrolling grids with row deduplication.
- Automatic suppression of sidebars, charts, axis labels, and UI chrome (nav, aside, footer, header, toolbar, tablist) in Markdown output.
- Auto-detection of column headers above scroll containers.
- **Capture (Expand Scrolls)** mode — walks every nested scrollable on the page.
- **Capture (Normal)** mode — standard full-page capture.
- **Select Region** mode — drag-to-select on the page with auto-scroll at viewport edges; inner scrollables intersecting the selection are expanded.
