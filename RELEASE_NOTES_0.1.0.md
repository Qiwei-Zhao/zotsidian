# Zotsidian 0.1.0

Zotsidian has grown from a Zotero-first citation helper into a broader Zotero-to-Obsidian workflow layer.

This release focuses on three major themes:

- discourse graph canvas workflows
- source page annotations and paper workspaces
- a more stable and maintainable sidebar architecture

## Highlights

### Discourse-graphs canvas integration

Zotsidian now has dedicated support for the `discourse-graphs` Obsidian plugin.

The sidebar can detect:

- source nodes such as `@citekey`
- discourse nodes such as claim / evidence / question / source
- citation text on the canvas

It also supports:

- sidebar highlighting from canvas selection
- reverse jump from sidebar occurrence buttons back into canvas
- grouped node occurrences when the same discourse node appears multiple times
- discourse node type filtering in the sidebar

### Source page workspace and annotations

Source pages named `@citekey` now behave more like compact paper workspaces.

They can show:

- Zotero metadata
- attachments
- external links
- filtered Zotero annotations
- related references, citations, and related library items
- discourse graph nodes mentioned in the note

Annotations now support:

- filtering by type and color
- copy
- open
- insert into the current note
- image annotation insertion

### Better references sidebar behavior

The references sidebar has been improved across Markdown notes, source pages, and discourse canvas pages.

Improvements include:

- more reliable `cited:` counts on first open
- more compact and consistent item styling
- better cross-highlighting between page content and sidebar items
- more stable discourse canvas locate behavior

## Additional improvements

- lightweight references support for native Obsidian Base and native Canvas
- redesigned source page layout and controls
- updated README with new screenshots and current feature scope
- internal refactor of discourse canvas logic into focused modules for long-term maintenance

## Notes

- The strongest graph workflow is designed for `discourse-graphs` canvas, not native Canvas.
- Native Base and native Canvas support remain intentionally lightweight.
- Zotero 8 local API access is still the recommended primary workflow.
