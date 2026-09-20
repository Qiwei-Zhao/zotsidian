# Changelog

## 0.2.0

### Release stabilization

- Concurrent References open requests share one sidebar creation; stale
  Source renders stop after close, reopen, or a newer refresh.
- Plugin reload waits for Obsidian to restore existing sidebar leaves before
  creating a missing References view.
- Annotation navigation includes the owning PDF and annotation key, preserves
  existing absolute page links, and prefers authoritative PDF position data.
- Source annotation refresh, single-annotation insertion, managed-section
  migration, and Result node-link updates use atomic note transformations to
  preserve edits made while asynchronous work is pending.
- Release preparation validates exact runtime artifact bytes and a strict
  public distribution file allowlist before publication.

This release consolidates the unpublished 0.1.4 and 0.1.5 candidates into the
first public release of Zotsidian's complete Zotero-to-research-project
workflow. It is a substantial product expansion from 0.1.2, so the version
advances directly to 0.2.0.

The republished 0.2.0 build also fixes Project Review Trace titles for
Questions and Hypotheses stored in `PROJECT.md` frontmatter. Structured
`question` and `statement` values take precedence over abbreviated summary
references, while Markdown-only projects retain their existing fallback.

### Architecture and maintenance

- added reproducible lint, stylesheet, build, generated-syntax, test,
  whitespace, and exact-package quality gates
- pinned the Obsidian development API used by clean installs and removed the
  unused Citation.js dependency; upgraded esbuild and reduced the clean
  dependency tree with zero known audit vulnerabilities
- moved shared contracts, settings defaults, and the Settings UI out of the
  plugin coordinator; feature modules now use `main.ts` only as a type boundary
- removed the unused legacy Project Review surface and seven dead compatibility
  helpers
- replaced the global 360 ms Markdown-context polling loop with a lifecycle-safe
  CodeMirror update listener and coalesced refresh
- removed 251 exact duplicate CSS rules, repaired an unmatched brace, and added
  a stylesheet structure/deduplication gate
- added architecture regression coverage while preserving the accepted 0.1.4
  Zotero, source-page, Search, Explorer, Inspector, Project, Trace, and Canvas
  behavior

### Product and workflow expansion

### New

- added current-project writing suggestions: `n:` nodes, `r:` results, `q:`
  questions, and `f:` figures/files
- added automatic `Current project context` for ordinary project notes in the
  References sidebar, with a same-scope Explorer entry
- added a compact current-project node preview to the References sidebar
- added an Explorer project-scope writing summary for `Nodes`, `Results`,
  `Questions`, `Papers`, `Canvases`, and `Not yet used`
- added Canvas catalog search and sorting by modified time, name, node count,
  or reference count

### Enhanced

- made inline `@` autocomplete rank papers referenced by the active project
  before the broader configured Zotero scope, with stable deduplication
- made Zotsidian Explorer automatically adopt the active page's project scope
- made Search default to the broader Zotero library, with open Zotero items
  before recently added papers and an explicit complete project-paper mode
- made Explorer project scope clearable and restorable through one shared
  Project Context Index for nodes, papers, and canvases
- added `Used` / `Not yet used` project-node filters; `Used` counts only a link
  or reference from another project-context file, not the node's own file
- kept `n:`, `r:`, `q:`, `f:`, and `@` as the project-aware editor entry points;
  `Not yet used` does not claim that a Question is unanswered
- made Research portfolio open as a floating modal by default while retaining
  an explicit workspace action
- made the References sidebar Current project section use flat navigation rows;
  normal clicks retain the project Explorer route and Option/Alt-click opens a
  floating project-scoped Explorer
- added a persistent ribbon action and `Zotsidian: Open References sidebar`
  command so a closed References view can always be recreated
- made Current project node rows open their note normally and use
  Option/Alt-click for the floating Node Inspector
- refined Project Review with segmented navigation, compact status/summary
  cards, quieter object rows, and a denser responsive visual hierarchy
- rerouted reverse Trace relations between their columns instead of stacking
  one full-width rail per relation below the graph; dense edges are subdued
  until focused or hovered while retaining readable contrast at 50% zoom
- made Explorer project usage state icon-only: Used and Not yet used retain
  accessible labels/tooltips without gray pills or duplicate visible text
- made newly extracted image-annotation nodes copy their image into the Vault
  and use a Vault-native embed; legacy external image links remain readable
- kept project writing context portable: project Markdown remains authoritative
  and the research-project skill works without Zotsidian

### Consolidated research-workflow scope

#### New

- added Light, Plus, and Beta experience modes with non-destructive settings migration (stored IDs remain `light`, `normal`, `pro`)
- added a centralized capability registry and mode-aware commands, settings, views, editor gestures, and background services
- added a Light Papers workspace that keeps the complete Zotero/source-page workflow without Discourse Graph UI or polling
- added the experimental Beta Project Review that lazily discovers Markdown `PROJECT.md` capsules and displays health, next actions, decisions, runs, results, and explicit project objects
- added multi-project `project_ids` assignment for source pages and Discourse nodes
- added project-scoped Papers and node filters
- added safe Agent handoff preview/copy/open actions without direct process launch
- added local-only external workspace links that are not written into vault project files
- added a floating Project Review as the default surface with `Shift+Cmd+P`
- added a shared review/page renderer, deep-page handoff actions, and a Settings-controlled page preference
- added a Project Manager portfolio surface with shared List, Board, and Roadmap views
- added bounded project-aware Search, scratchpad membership conventions, and idempotent Question-to-Project creation
- added My Library/group scope discovery and deterministic manuscript BibTeX export with unresolved-key reporting; the standalone annotation search was removed in favor of Paper Inspector
- added a versioned `nature_compact` delivery profile and portable Markdown/PDF review fixture
- added shared Project inventory Table/List/Card views with actor, round, time, reference, attention, and local Issue filters
- added a Zotero 10 connection diagnostic, library/scope-aware caches, indexed full-text search, saved-search discovery, and explicit metadata write previews
- added authoritative multi-attachment annotation loading, direct PDF/annotation routing, and native comment/tag editing in Paper Inspector
- added shared Zotero-library tag completion for annotations and Explorer paper metadata, backed by a persisted stale-while-revalidate cache
- added annotation-to-node reconciliation with processed/unprocessed/needs-sync filters and additive-only semantic-tag repair boundaries
- added project-aware `p:` completion for inserting readable links to matching `PROJECT.md` capsules

#### Enhanced

- redesigned Search, Explorer, Paper Inspector, Project Manager, and Project Review around compact low-chrome controls and shared interaction patterns
- made Paper Inspector load annotations from the owning Zotero attachments rather than relying on one bounded parent-item result
- made tag candidates available immediately from the persisted cache, with startup warming and explicit refresh instead of blocking each editor
- made annotation comment/tag editing inline, preserving all existing Zotero tags and keeping highlighted source text read-only
- made extracted node statements default to annotation text while placing Zotero comments in the node note/evidence field
- made Project Review open a project-scoped Explorer for the current project's nodes and papers
- made Table, List, and Cards genuinely distinct presentations over one normalized project inventory model
- improved Zotero-unavailable behavior so stale local data remains visible and source-note refresh does not destructively replace managed annotations

#### Fixed

- fixed Zotero 10 annotation discovery returning only the first fallback annotation for papers with many native annotations
- fixed PDF actions resolving the parent item instead of the owning attachment/annotation target
- fixed multiple Zotero annotation tags being collapsed or omitted from Paper Inspector filters
- fixed annotation editor icon rendering and removed the nested edit modal
- fixed duplicate processed-state actions and excessive unprocessed-row height
- fixed indistinct indexed-text state and mismatched gray button chrome across Search and Project surfaces
- fixed Project Review List/Card rendering sharing the same unstructured row layout
- fixed source-note annotation cache behavior so empty or non-authoritative Zotero responses cannot erase existing imported content

#### Safety and compatibility

- existing installs preserve an explicit stored mode; only legacy settings
  without a mode migrate to the Plus compatibility profile. Detailed settings,
  pinned/recent nodes, citation caches, Zotero metadata queues, project
  mappings, and unknown transition fields are preserved
- mode switching never removes or rewrites Markdown, Canvas, Zotero, or project data
- restored Project Review leaves show a paused explanation outside Beta instead of failing layout restoration
- direct Agent launch remains unavailable until a verified adapter can report real launch state
- Zotero reads remain local-first; Zotero 10 writes require explicit local authorization, server identity, and version preconditions
- annotation synchronization never removes Zotero tags automatically; reconciliation repair is additive-only
- the legacy implicit Project page default migrates to floating review; an explicit page preference remains available

#### Internal

- added 175 focused tests spanning modes, project state, Zotero 10 Local API
  behavior, attachment routing, annotation round-trip, tag suggestions,
  inventory, protocol compatibility, project-aware writing context, Canvas
  catalog behavior, and portable Zotero-to-Obsidian research
- split mode, settings schema, project discovery, membership, Dashboard, assignment, handoff, Zotero Local API, annotation sync, tag suggestion, inventory, and protocol logic into focused modules
- added an automated release audit that verifies version agreement, the exact
  three-file ZIP boundary, and byte equality between repository and package

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
