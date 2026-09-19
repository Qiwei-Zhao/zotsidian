# Zotsidian 0.2.0

Zotsidian 0.2.0 is a major workflow release. It consolidates the unpublished
0.1.4 and 0.1.5 candidates and advances directly from the public 0.1.2 release.
The plugin now supports a progressive path from everyday Zotero writing to
structured research synthesis and Markdown-native project review.

The refreshed 0.2.0 candidate also hardens exact annotation navigation and
preserves concurrent note edits during annotation refresh, insertion, and
managed-section migration. Release preparation checks runtime bytes and the
public distribution file allowlist.

## Choose the workflow you need

- **Light** keeps the complete Zotero-to-Obsidian workflow: Search, citation
  insertion, hover cards, References, source pages, annotations, Paper
  Inspector, related papers, metadata tools, and the Papers catalogue.
- **Plus** adds Discourse Graph nodes, Node Inspector, Composer, Explorer,
  Canvas coverage, placement, and synchronization.
- **Beta** adds the experimental Project Manager, Project Review, project-aware
  writing context, Trace, human feedback, and reviewed Agent handoff.

Modes are cumulative interface profiles, not license tiers. Switching modes
preserves settings and research data. Fresh installations start in Light.

## Highlights

- Rebuilt Search around open Zotero items, recent items, full-library/group
  scopes, indexed text, saved searches, and project-scoped browsing.
- Added Paper Inspector for paper coverage, owning-attachment annotations,
  precise PDF/annotation routing, inline comment/tag editing, and additive-only
  annotation reconciliation.
- Added Explorer workspaces for current-page context, papers, nodes, and
  Canvases, including project scope, shared filters, coverage fields, and
  Used/Not yet used writing lenses.
- Added standalone and annotation-derived research-node creation with explicit
  provenance, Node Inspector, Canvas placement, and image materialization into
  the Vault.
- Added current-project writing suggestions: `n:` nodes, `r:` Results, `q:`
  Questions, `f:` figures/files, `p:` projects, and project-prioritized `@`
  citations. Both `:` and `：` are supported.
- Added Project Manager and Project Review over Markdown-native project
  capsules, including decisions, deliverables, inventory, files, project
  context, evidence-backed Trace, human feedback, and safe handoff prompts.
- Added a persistent References ribbon action and command so the sidebar can
  always be reopened after closing.
- Refined Project Review hierarchy and Trace routing; connections retain
  readable theme-aware contrast at 50% zoom.
- Corrected Project Review Trace titles so structured Question and Hypothesis
  statements take precedence over abbreviated `PROJECT.md` summary references.

## Zotero safety and compatibility

- Zotero 10 is the primary tested path; Zotero 8 remains a read-compatible
  fallback.
- Better BibTeX is strongly recommended for stable citation keys.
- Zotero reads remain local-first.
- Zotero 10 writes are opt-in and require explicit local authorization, server
  identity, and version preconditions.
- Annotation reconciliation never removes Zotero tags automatically.
- Source-note refresh preserves manual content outside managed blocks and keeps
  existing generated annotations when Zotero is unavailable or returns a
  non-authoritative empty response.
- `discourse-graphs` is optional; native Canvas and Base integration remains a
  lightweight compatibility layer.

## Architecture and quality

- Extracted shared contracts, settings defaults, and the Settings UI from the
  plugin coordinator.
- Removed the unused legacy Project Review implementation and dead
  compatibility helpers.
- Replaced global Markdown-context polling with lifecycle-safe editor updates.
- Removed 251 exact duplicate CSS rules and added stylesheet structure and
  deduplication checks.
- The release gate passes lint, CSS validation, TypeScript production build,
  generated JavaScript syntax, 182/182 tests, whitespace validation, package
  version agreement, exact archive contents, and byte equality.
- A clean dependency installation reports zero known vulnerabilities.

## Install

1. Download `zotsidian-0.2.0.zip` from this release.
2. Extract `main.js`, `manifest.json`, and `styles.css` directly into
   `<vault>/.obsidian/plugins/zotsidian/`.
3. Reload Obsidian and enable **Zotsidian** under Community plugins.
4. Start Zotero Desktop and enable
   `Allow other applications on this computer to communicate with Zotero`.

The ZIP contains exactly the three runtime files and no nested folder.

For a guided introduction, see the
[illustrated Chinese tutorial](docs/ZOTSIDIAN_TUTORIAL.zh-CN.md).
