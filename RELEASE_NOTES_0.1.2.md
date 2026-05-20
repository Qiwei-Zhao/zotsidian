# Zotsidian 0.1.2

This release focuses on source page annotation stability, annotation copy workflows, and release-readiness polish.

## New features

- managed source-page annotation syncing with visible Zotero annotation anchors
- built-in annotation templates for Default Markdown and Obsidian callout styles
- custom annotation template support powered by Eta templates
- source-page template helpers for full-note, body, and frontmatter templates
- configurable default copy formats for text and image annotations

## Enhancements

- expanded text annotation copy options: Markdown, Markdown with Zotero link, callout, plain text, and current insert template
- expanded image annotation copy options: image data, image Markdown, Markdown with Zotero link, callout, and current insert template
- source sidebar now renders basic source metadata before slower attachment, related-paper, and reference lookups finish
- settings UI now has clearer active tabs, lighter typography, and a more compact section layout
- Zotero annotation imports are ordered by PDF page, sort index, position, and date where possible
- annotation imports include direct Zotero/PDF jump links when available

## Fixes

- fixed repeated generated annotation text/image imports inside a single source-page annotation item
- fixed annotation refresh idempotency across repeated refreshes
- fixed template switching from preserving old generated imports as manual notes
- preserved existing source-page annotations when Zotero lookup fails or returns an unsafe empty result
- reduced overwrite risk by re-reading source notes before writing managed annotation blocks
- added local Zotero API request timeout handling
- cleared discourse canvas polling timers on plugin unload
- fixed annotation right-click behavior so annotation text/comment areas open the Zotsidian copy menu unless text is actively selected

## Internal changes

- split source note markers, source note sync, annotation templates, source templates, and template rendering into focused modules
- normalized Zotero local API annotation metadata for tags, page labels, sort index, positions, image paths, and direct open links

## Testing focus

- refresh an existing source page with annotations several times
- switch annotation style between Default Markdown and Obsidian callout
- confirm ordinary notes under annotation items are retained once
- temporarily close Zotero and confirm existing source page annotations are not replaced with `_No annotations found._`
- right-click text and image annotation copy buttons and confirm all copy formats work
