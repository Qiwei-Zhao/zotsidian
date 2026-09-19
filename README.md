# Zotsidian

[English](./README.md) | [简体中文](./README.zh-CN.md)

Zotsidian is an Obsidian desktop extension for Zotero-native writing, source pages, annotations, and discourse graph workflows. Zotero 10 is the primary tested path; Zotero 8 remains a read-compatible fallback.

It started from a simple citation workflow idea inspired by [zotero-roam](https://github.com/alixlahuec/zotero-roam) and [obsidian-deepsit](https://github.com/bassio/obsidian-deepsit), and has grown into a more integrated Zotero-to-Obsidian workflow layer with support for [discourse-graphs](https://github.com/DiscourseGraphs/discourse-graph), built with AI-assisted development. The core release path is regression-tested; Beta project features remain experimental, so issue reports and suggestions are welcome.

## Zotsidian 0.2.0

Version 0.2.0 is the first public release of the complete Light → Plus → Beta
workflow. It combines the Zotero/source-page foundation with Paper Inspector,
research nodes, Explorer, Canvas synthesis, project-aware writing, Project
Manager, Project Review, Trace, and reviewed Agent handoff. This republished
build includes the corrected structured Question/Hypothesis Trace titles.

- [Illustrated Chinese tutorial](docs/ZOTSIDIAN_TUTORIAL.zh-CN.md)
- [Changelog](CHANGELOG.md)
- [Release notes](RELEASE_NOTES_0.2.0.md)

## 0.2.0 interface tour

### Light — Zotero-native reading and writing

Search open or recent Zotero papers, insert citations, create source pages, and
open the paper or PDF without leaving the writing workflow.

![Zotsidian Search with current paper actions](docs/tutorial/assets/S03-light-search-results-actions.png)

Paper Inspector brings metadata, source-page coverage, annotations, and
paper-level actions into one focused workspace.

![Paper Inspector overview](docs/tutorial/assets/S05-light-paper-inspector-overview.png)

### Plus — research nodes and synthesis

Explorer adds a filterable research-node catalogue and connects notes,
citations, provenance, Inspector, Composer, and Canvas placement.

![Explorer research-node catalogue](docs/tutorial/assets/S09-plus-explorer-nodes.png)

### Beta — project review and evidence trace

Project Review turns Markdown project capsules into a review surface. Overview
keeps the current agenda visible, while Trace connects questions, hypotheses,
runs, results, and their Markdown evidence.

| Project Review | Evidence-backed Trace |
| --- | --- |
| ![Project Review overview](docs/tutorial/assets/S15-beta-project-review-overview.png) | ![Project Review Trace and evidence preview](docs/tutorial/assets/S17-beta-trace-evidence-preview.png) |

See the [illustrated tutorial](docs/ZOTSIDIAN_TUTORIAL.zh-CN.md) for every
workflow, including References, annotations, Composer, Canvas, human feedback,
and Agent handoff.

## Experience modes

Experience modes focus the interface and background work; they are not license
tiers. Switching modes preserves all detailed settings and research data.

- **Light** keeps the complete Zotero-to-Obsidian workflow: citation search and
  insertion, hover cards, References, source pages, annotations, Paper Inspector,
  related papers, metadata sync, and the full Papers catalogue. It hides
  Discourse Graph and Project-only columns/actions and pauses their services.
- **Plus** adds Discourse Graph nodes, Node Inspector,
  Composer, Explorer, Canvas coverage, placement, and synchronization.
- **Beta** (stored internally as `pro`) is an experimental personal-project
  workflow. It adds the Markdown-native Project Review, `project_ids` membership,
  project-scoped Papers/Nodes, local external-workspace links, and safe Agent
  handoff preview/copy/open actions.

Fresh installs begin in Light. Existing installations keep their explicit mode;
legacy settings without a mode migrate to the Plus compatibility profile.

Choose a mode at the top of Zotsidian Settings or from the command palette. The
Project Review is a focused project workspace and does not contain a mode
switch; a restored Review outside Beta remains recoverable and points back to
Settings.

### Project capsules and Agent handoff

Beta lazily scans the configured vault-relative project root (default `project/`)
for `PROJECT.md` capsules. It reads project identity, status, next human/AI
actions, pending decisions, Runs, Results, PAPER, and TRACE without replacing
native Markdown editing.

Paper source pages and node notes can belong to more than one project:

```yaml
project_ids:
  - P20260000_example_project
```

External execution-workspace paths stay in local plugin data and are never
written into portable project notes. Agent handoff creates a reviewable prompt
with read order, decisions, and allowed write scope. It does not launch or claim
to launch an Agent.

The Project Review is action-first: the default command, ribbon button, and
`Shift+Cmd+P` shortcut open a floating review; Focus rows open the next
human/AI work, decision rows open the authoritative capsule, Runs and Results
open their files, and Project objects can be assigned or removed through a
searchable vault-wide picker. Explicit deep actions open native Markdown in a
popout while the floating review stays open. Settings and a page-only command
remain available for full-page work.
Experience mode remains a Settings concern rather than a dashboard action.

Project Manager is the portfolio entry point for Beta. It provides shared List,
Board, and Roadmap views over the same project model; Project Review remains the
detail/control room. Roadmap orders recorded changes only and does not invent
deadlines or dependency precision. Project-aware Search exposes a visible
Project/Broader library switch and recognizes capsule files, `NOTES.md`,
declared scratchpads, and explicit project membership. A Question can start an
idempotent embedded project without moving the original note.

The Search panel also exposes My Library/group scope selection, Zotero indexed
text, and saved searches. Paper annotations are inspected and edited in Paper
Inspector rather than a separate annotation-search modal. `Zotsidian: Export
active manuscript BibTeX` produces stable sorted output and reports unresolved
citekeys; transitive inclusion is explicit.

<details>
<summary>Previous v0.1.2 interface</summary>

<img width="1381" height="550" alt="Zotsidian v0.1.2 interface" src="https://github.com/user-attachments/assets/e18002bf-59e1-4778-a839-1a3e73242031" />

</details>

## Highlights

Zotsidian is built around five practical capabilities:


1. Citation workflow
   - insert citations with inline `@` autocomplete
   - search Zotero from the **Zotsidian Search** panel
   - inspect citekeys with hover cards
2. References sidebar
   - inspect the references used in the active note without leaving the page
   - sort and focus citations while writing
   - reopen it at any time from the book ribbon icon or
     `Zotsidian: Open References sidebar`
3. Source page workspace
   - treat `@citekey` notes as paper dashboards
   - view metadata, attachments, related items, discourse nodes, and references together
4. Zotero annotations
   - load highlights and images from all owning attachments
   - filter, copy, open, insert, and edit Zotero comments/tags from Paper Inspector
   - reconcile processed nodes through additive-only semantic tags
5. Discourse graph canvas support
   - integrate with `discourse-graphs` canvas
   - detect source nodes, citation text, and discourse nodes
   - highlight sidebar items from canvas selections
   - jump back from sidebar targets into canvas

## Core Features

### 1. Citation Insert and Hover Cards

Zotsidian supports two citation entry modes:

- inline `@` autocomplete inside the editor
- a dedicated Zotero search panel

Hover cards let you inspect a citekey without leaving your current context. They work especially well for lightweight writing when you want citation lookup without opening a source page.

Inserted citations can be configured as:

- `[@citekey]`
- `@citekey`
- `[[@citekey]]`

All three formats are treated as formal citations by the plugin.

In Beta, editor suggestions also recognize the active project:

- `n:` inserts a current-project node
- `r:` inserts a current-project Result
- `q:` inserts a current-project Question
- `f:` inserts a current-project figure or file
- `@` ranks current-project papers before the broader Zotero scope

Both ASCII `:` and full-width `：` trigger these project suggestions.

No separate writing area or registry is required. Zotsidian derives the
project from the active file's folder or explicit project membership.

![Citation search and paper actions](docs/tutorial/assets/S03-light-search-results-actions.png)

### 2. References Sidebar

For normal notes, the right sidebar shows the references used in the active page.

This supports a writing-first workflow: keep drafting in the main editor while inspecting references, sorting them, and jumping to cited occurrences in parallel.

When the active page belongs to a project, the sidebar also shows a compact
**Current project context** section with the project title, a node preview, and
an Explorer action. Opening Zotsidian Explorer from an ordinary project note
automatically applies the same project scope.

In Explorer, the project scope shows a compact writing summary for `Nodes`,
`Results`, `Questions`, `Papers`, `Canvases`, and `Not yet used`. Project nodes
can be filtered with `Used` and `Not yet used` alongside the other Explorer
filters. Here, `Used` means that another project-context file links to or
references the node; the node's own file establishes membership but does not
count as use. `Not yet used` is a writing cue, not an automatic judgment about
whether a Question has been answered.

The References sidebar supports:

- Normal obsidian notes
- obsidian base
- discourse-graphs canvas
- native Obsidian canvas

If the view has been closed, use the book icon in the left ribbon or run
`Zotsidian: Open References sidebar` from the command palette. In the Current
project section, a normal node-row click opens the note; Option/Alt-click opens
Node Inspector.

Sorting modes:
- insertion order
- year, newest first
- author + year

Highlight the current input line's citation in the sidebar. Clicking the number buttion in the sidebar, jump back to the citaiton line. Discouse graph nodes supported as well.

![References sidebar](docs/tutorial/assets/S04-light-references-sidebar.png)

### 3. Source Page Workspace

A source page is a note named `@citekey`.

When the active note is a source page, the sidebar becomes a paper workspace and can show:

- Zotero metadata
- attachment links
- external links such as Zotero, Semantic Scholar, Google Scholar, and Connected Papers
- filtered Zotero annotations
- insert / copy / open actions for annotations with one click
- references of the current paper
- citations of the current paper
- related library items already present in your Obsidian / Zotero workflow
- discourse graph nodes detected in the note body

![Source page workspace](docs/tutorial/assets/S06-light-source-sidebar.png)

### 4. Discourse Graph Canvas Support

Zotsidian has dedicated support for the [discourse-graphs](https://github.com/DiscourseGraphs/discourse-graph) Obsidian plugin.

On discourse canvas pages, the sidebar can detect:

- source nodes such as `@citekey`
- discourse nodes such as claim / evidence / question / source
- citation text shapes

It supports:

- sidebar highlighting from canvas selection
- reverse jump from sidebar occurrence buttons back into canvas
- discourse node type filtering inside the sidebar

This is currently the strongest graph workflow in the plugin and one of the main differentiators of Zotsidian.

![Discourse graph canvas support](docs/tutorial/assets/S12-plus-discourse-canvas.png)

## Lightweight Native Base and Canvas Support

Zotsidian also provides lightweight support for native Obsidian Base and native Canvas.

That means:

- reference extraction can work from those pages
- citation hover cards can still be useful in lightweight workflows

This support is intentionally simpler than the discourse-graphs integration. The full bidirectional graph workflow is designed for discourse-graphs canvas, not native Canvas.

## Related Papers and External Providers

For source pages with a DOI or a usable title, Zotsidian can fetch:

- references
- citations
- related library items already present in your Zotero-backed note system

Provider modes:

- `Auto (Recommended)`
- `Semantic Scholar only`
- `OpenAlex only`

Recommended mode tries Semantic Scholar first and falls back to OpenAlex when Semantic Scholar is rate-limited or incomplete.

## Do You Need Better BibTeX?

### Better BibTeX plugin

In practice, usually yes.

Zotsidian needs usable citation keys to support:

- `@` citation insertion
- source pages named `@citekey`
- citation hover cards
- reference and source resolution

Recent Zotero versions provide a native `Citation Key` field, but Zotero does not reliably generate or maintain citation keys for you on its own. For most users, the practical solution is to install **Better BibTeX** and let it generate and manage citation keys in Zotero.

If you already maintain valid citation keys by some other method, Zotsidian can use them. But for most real workflows, Better BibTeX should be treated as a practical requirement.

## Defaults on a Fresh Install

Zotsidian defaults are intentionally conservative:

- Citation insert format: `[@citekey]`
- Create source page on citation select: off
- Load attachment links in source panel: on
- Source pages folder: `source`
- Source page template path: empty
- Related papers provider: `Auto (Recommended)`
- Search panel hotkey: `Cmd+Shift+U` / `Ctrl+Shift+U`

These defaults favor direct writing first, and source-page creation only when the user explicitly wants it.

## Requirements

### Required

- Obsidian `>= 1.10.6`
- Obsidian desktop on macOS, Windows, or Linux
- Zotero Desktop 10 recommended, or Zotero Desktop 8 for read-compatible workflows, installed on the same computer
- usable citation keys on the Zotero items you want to cite

### Required for the full local workflow

Zotsidian is designed around live local resolution against Zotero Desktop. For citation lookup, hover cards, PDF opening, Zotero item opening, source-page enrichment, annotation workflows, and authorized metadata editing to work reliably:

- Zotero Desktop should be running while you use Obsidian
- your cited items should exist in the local Zotero library you want to query
- Zotero local API access should be available on the local machine
- in Zotero, open `Settings / Preferences -> Advanced` and enable `Allow other applications on this computer to communicate with Zotero`

Zotero 10 write actions are opt-in. They require explicit local authorization,
server identity, and version preconditions. Zotsidian preserves existing tags
and never removes Zotero tags automatically during annotation reconciliation.

For most users, this also means:

- Better BibTeX should be installed so citation keys are generated and maintained consistently

If Zotero Desktop is closed, some local-library features will degrade or stop working, especially:

- live citation resolution
- opening local PDFs
- opening Zotero items
- attachment discovery in the source sidebar
- annotation refresh and insert workflows

### Optional but recommended

- PDF attachments stored in Zotero, if you want `Open PDF` actions to work
- DOI or at least a usable title on a source item, if you want related references / citations to resolve well
- internet access for:
  - Semantic Scholar / OpenAlex related-paper lookup
  - Connected Papers
  - Google Scholar

### Optional integration

- the `discourse-graphs` Obsidian plugin, if you want discourse canvas support

### Optional advanced fallback

- a Better BibTeX JSON export file, only if you want a fallback index source when live Zotero lookup is incomplete

You usually do need citation keys, and Better BibTeX is the normal way to get them reliably.

You do not need a Better BibTeX JSON export for the primary local Zotero workflow.

## Installation

### Install from GitHub Release

This is the recommended installation method before Zotsidian is available in the Obsidian community plugin browser.

1. Open the latest GitHub Release for Zotsidian
2. Download `zotsidian-0.2.0.zip`, or download these three assets separately:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Create a folder in your vault and extract/copy the three files into it:
   - `.obsidian/plugins/zotsidian`
4. Confirm that the plugin folder directly contains `main.js`,
   `manifest.json`, and `styles.css`—not another nested folder.
5. Reload Obsidian, then enable **Zotsidian** in Community plugins.

Important:

- In Zotero, go to `Settings / Preferences -> Advanced` and make sure `Allow other applications on this computer to communicate with Zotero` is enabled.
- If this option is off, Zotsidian may fail to load citation indexes, attachments, hover data, and annotation content.

### Manual installation from source

Use this if you want to modify the plugin or test the source code directly.

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Build the plugin:

```bash
npm run build
```

4. Create a vault plugin folder:
   - `.obsidian/plugins/zotsidian`
5. Copy these files from the repository root into that folder:
   - `main.js`
   - `manifest.json`
   - `styles.css`
6. Enable **Zotsidian** in Obsidian community plugins

## Development

If you want to develop or debug the plugin locally:

```bash
npm install
npm run dev
```

This will watch the source and rebuild `main.js` automatically.

You still need to copy the built files into your vault plugin folder, or symlink the project into `.obsidian/plugins/zotsidian` if you prefer a development setup.

## Quick Start

1. Start Zotero Desktop
2. In Zotero, go to `Settings / Preferences -> Advanced` and enable `Allow other applications on this computer to communicate with Zotero`
3. Enable Zotsidian in Obsidian
4. Make sure the Zotero items you want to cite already have usable citation keys
   - for most users, this means Better BibTeX is installed and generating citation keys
5. Check these settings:
   - `Default Zotero scope`
   - `Citation insert format`
   - `Create source page on citation select`
   - `Source pages folder`
6. Type `@` in a note and insert a citation
7. Hover the citation to inspect metadata or open the PDF / Zotero item
8. Use the References sidebar to inspect cited papers
9. If needed, open or create an `@citekey` source page for deeper inspection
10. If you use discourse-graphs, open a discourse canvas and let the sidebar track source nodes and discourse nodes

## License

MIT. See [LICENSE](./LICENSE).
