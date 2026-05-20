# Changelog

## 0.1.2

### New

- added managed source-page annotation syncing with visible Zotero annotation anchors
- added built-in annotation template modes for Default Markdown and Obsidian callouts
- added custom annotation template support with Eta-backed rendering
- added source-page template helpers for full-note, body, and frontmatter templates
- added configurable default copy formats for text and image annotations

### Enhanced

- expanded annotation copy menus for both text and image annotations
  - text annotations can now be copied as Markdown, Markdown with Zotero jump link, callout, plain text, or the current insert template
  - image annotations can now be copied as image data, image Markdown, Markdown with Zotero jump link, callout, or the current insert template
- improved source sidebar behavior so source metadata renders before slower attachment, related-paper, and reference lookups finish
- improved Settings UI with clearer active tabs, lighter typography, and a more compact section layout
- improved source-page annotation ordering using page, sort index, position, and date information
- improved Zotero annotation links so imported annotations can jump directly back to Zotero/PDF locations when available

### Fixed

- source page annotation refresh is now idempotent across repeated refreshes and Markdown/callout template switches
- existing source page annotations are preserved when Zotero attachment or annotation lookup fails
- source page sync now re-reads the latest file contents before writing, reducing the risk of overwriting edits made during a refresh
- Zotero local API requests now time out instead of hanging indefinitely
- discourse canvas polling timers are cleared when the plugin unloads
- fixed repeated generated annotation text/image imports inside a single annotation item
- fixed template switching from preserving old generated imports as manual notes
- fixed unsafe empty Zotero annotation results from clearing existing source-page annotations
- fixed annotation right-click behavior so sidebar annotation text/comment areas open the Zotsidian copy menu unless text is actively selected

### Internal

- split source note markers, source note sync, annotation templates, source templates, and template rendering into focused modules
- added Zotero local API annotation metadata normalization for tags, page labels, sort index, positions, image paths, and direct open links

## 0.1.1

### Added

- support for storing source pages in the vault root by leaving `Source pages folder` empty

### Improved

- source page path handling so creation, lookup, and bootstrap now follow the same folder-setting logic
- settings text for `Source pages folder` to make the root-folder behavior explicit

## 0.1.0

### Added

- discourse-graphs canvas integration with sidebar references and discourse node panels
- bidirectional highlight and locate between discourse canvas and sidebar targets
- source page annotations panel with filtering, copy, open, and insert actions
- discourse graph panel for Markdown notes, source pages, and discourse canvas pages
- lightweight references support for native Obsidian Base and native Canvas

### Improved

- Markdown `cited:` initialization so sidebar occurrence counts appear more reliably on first open
- discourse canvas jump behavior, including selection, camera centering, and repeated node grouping
- sidebar layout, compactness, filtering, sorting, and cross-page visual consistency
- source page workspace design, including related panels, annotation controls, and attachment presentation
- reference and discourse graph highlight behavior so selected items no longer change layout size

### Internal

- discourse canvas logic refactored into focused modules:
  - `DiscourseCanvasModel.ts`
  - `DiscourseStore.ts`
  - `DiscourseCanvasGeometry.ts`
  - `DiscourseCanvasSelection.ts`
  - `DiscourseCanvasSync.ts`
- architecture notes added for long-term maintenance by both human contributors and AI agents
- sidebar refresh and discourse-store access paths simplified to reduce duplication in `main.ts`

## 0.0.1

- First standalone Zotsidian release
- Zotero 8 local API-first citation resolution
- `@` citation autocomplete with configurable insert formats
- Source pages for `@citekey` notes
- Editor, Base, and sidebar hover cards
- References sidebar with sorting
- Related-paper panels with Semantic Scholar and OpenAlex fallback
