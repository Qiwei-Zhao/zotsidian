# Changelog

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
